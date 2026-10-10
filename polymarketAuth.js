'use strict';
/**
 * Polymarket authentication — L1 (wallet signature) + L2 (HMAC request signing).
 *
 * L1: EIP-712 `ClobAuth` typed data, signed by the wallet private key, is used
 *     once to create or derive the CLOB API credentials.
 * L2: every private REST request is signed with HMAC-SHA256 over
 *     `${timestamp}${METHOD}${path}${body}` using the base64-decoded API secret,
 *     emitted as URL-safe base64 WITH padding, and injected as POLY_* headers.
 *
 * Reference: docs.polymarket.com/getting-started/api#authentication
 */
const crypto = require('crypto');
const { Wallet } = require('ethers');
const { EXCHANGES, TOKENS } = require('./contracts');
const { readCollateralBalances, readTradingApprovals } = require('./onchain');

const CLOB_AUTH_MESSAGE = 'This message attests that I control the given wallet';
const AUTH_DOMAIN_NAME = 'ClobAuthDomain';
const AUTH_DOMAIN_VERSION = '1';

/**
 * Decode a `GET /balance-allowance` body.
 *
 * CLOB V2 reports allowances *per spender* — `allowances: { "<exchange>":
 * "<base units>" }` — not a single `allowance` field. Reading only the singular
 * field (what this bot did before) always yields 0, which reads as "you never
 * approved anything" and blocks every live order even when the wallet is fully
 * approved. The singular field is still honoured so a pre-migration response,
 * or a cached one, keeps producing a usable number.
 *
 * @param {object} body
 * @returns {{ok:true, balance:number, allowance:number, allowances:Object,
 *            allowanceMap:Object, legacyAllowance:number|null,
 *            missingApprovals:string[], raw:object}}
 */
function parseBalanceAllowance(body = {}) {
  const raw = (body && typeof body === 'object') ? body : {};
  const toUsd = (v) => {
    const n = parseFloat(v ?? '0');
    return Number.isFinite(n) ? n / 1e6 : 0;
  };
  const balance = toUsd(raw.balance);

  const map = (raw.allowances && typeof raw.allowances === 'object') ? raw.allowances : null;
  const allowanceMap = {};
  if (map) {
    for (const [k, v] of Object.entries(map)) allowanceMap[String(k).toLowerCase()] = toUsd(v);
  }
  const legacyAllowance = (raw.allowance !== undefined && raw.allowance !== null)
    ? toUsd(raw.allowance)
    : null;

  // Per-exchange view, keyed by the checksummed V2 exchange address.
  const allowances = {};
  let known = 0;
  let effective = Infinity;
  for (const ex of [EXCHANGES.standard, EXCHANGES.negRisk]) {
    const v = allowanceMap[ex.toLowerCase()];
    allowances[ex] = (v === undefined) ? null : v;
    if (v !== undefined) { known++; effective = Math.min(effective, v); }
  }

  let allowance;
  if (known > 0) allowance = effective;
  else if (Object.keys(allowanceMap).length) allowance = Math.min(...Object.values(allowanceMap));
  else allowance = legacyAllowance === null ? 0 : legacyAllowance;

  // Only an exchange explicitly reported as 0 counts as missing; an exchange the
  // response never mentions is unknown, not absent.
  const missingApprovals = [EXCHANGES.standard, EXCHANGES.negRisk]
    .filter(ex => allowances[ex] !== null && !(allowances[ex] > 0));

  return {
    ok: true,
    balance,
    allowance,
    allowances,
    allowanceMap,
    legacyAllowance,
    missingApprovals,
    raw,
  };
}

class PolymarketAuth {
  constructor(config) {
    this.cfg = config;
    this.endpoints = config.endpoints;
    this.chainId = config.chainId;

    this.privateKey = null;
    this.wallet = null;
    this.signerAddress = null;   // EOA derived from the private key
    this.funderAddress = null;   // Polymarket account wallet (maker)
    this.signatureType = Number(config.wallet.signatureType); // 0..3
    this.email = null;

    this.apiKey = config.wallet.apiKey || null;
    this.apiSecret = config.wallet.apiSecret || null;
    this.apiPassphrase = config.wallet.apiPassphrase || null;
    this.credentialsSource = this.apiKey ? 'provided' : 'none';

    this.authMode = 'paper';
    this.liveBalanceUsd = 0;
    this.allowanceUsd = 0;
    // Exchanges the CLOB explicitly reported as unapproved (see
    // parseBalanceAllowance). Null until the first balance/allowance read.
    this.missingApprovals = null;
    // Last on-chain approval read (checkOnChainAllowances).
    this.onChainApprovals = null;
    this.lastAuthError = null;
    this.geoblock = null; // {blocked, country, region, checkedAt}

    if (config.wallet.privateKey) {
      try {
        this.setPrivateKey(config.wallet.privateKey);
      } catch (e) {
        this.lastAuthError = `Invalid POLY_PRIVATE_KEY: ${e.message}`;
      }
    }
    if (config.wallet.funderAddress) {
      this.funderAddress = config.wallet.funderAddress;
    }
  }

  // ------------------------------------------------------------------ setup
  setPrivateKey(pk) {
    const key = pk.startsWith('0x') ? pk : `0x${pk}`;
    const wallet = new Wallet(key);
    this.privateKey = key;
    this.wallet = wallet;
    this.signerAddress = wallet.address;
    // EOA accounts are their own maker; for 1/2/3 the funder must be supplied.
    if (this.signatureType === 0 && !this.funderAddress) this.funderAddress = wallet.address;
    return this.signerAddress;
  }

  configureAccount({ email, privateKey, funderAddress, signatureType, apiKey, apiSecret, apiPassphrase } = {}) {
    if (email) this.email = email;
    if (signatureType !== undefined && signatureType !== null) this.signatureType = Number(signatureType);
    if (privateKey) this.setPrivateKey(privateKey);
    if (funderAddress) this.funderAddress = funderAddress;
    if (apiKey && apiSecret && apiPassphrase) {
      this.apiKey = apiKey; this.apiSecret = apiSecret; this.apiPassphrase = apiPassphrase;
      this.credentialsSource = 'provided';
    }
    if (this.signatureType === 0 && this.wallet) this.funderAddress = this.funderAddress || this.wallet.address;
    return this.getStatus();
  }

  setPaperMode(enabled) { this.authMode = enabled ? 'paper' : 'live'; }

  get isAuthenticated() {
    return !!(this.privateKey || (this.apiKey && this.apiSecret && this.apiPassphrase));
  }

  hasL2Credentials() {
    return !!(this.apiKey && this.apiSecret && this.apiPassphrase);
  }

  /**
   * Common, expensive-to-debug misconfiguration: using the signer EOA as the
   * maker address on a smart-wallet account. Orders then fail with
   * "not enough balance / allowance" because the funds live in the account
   * wallet, not the EOA.
   */
  validateWalletSetup() {
    const st = this.signatureType;
    if (st === 0) return { ok: true };
    if (!this.funderAddress) {
      return { ok: false, error: `signature type ${st} requires POLY_FUNDER_ADDRESS (your Polymarket account wallet address)` };
    }
    if (this.signerAddress && this.funderAddress.toLowerCase() === this.signerAddress.toLowerCase()) {
      return {
        ok: false,
        error: 'POLY_FUNDER_ADDRESS equals the signer EOA. For signature type 1/2/3 the funder must be the '
          + 'Polymarket account wallet (Deposit Wallet / Proxy / Safe), which holds the funds.',
      };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------- L1 signing
  buildL1TypedData(timestamp, nonce = 0) {
    if (!this.signerAddress) throw new Error('No signer configured (missing private key)');
    return {
      domain: { name: AUTH_DOMAIN_NAME, version: AUTH_DOMAIN_VERSION, chainId: this.chainId },
      types: {
        ClobAuth: [
          { name: 'address', type: 'address' },
          { name: 'timestamp', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'message', type: 'string' },
        ],
      },
      primaryType: 'ClobAuth',
      message: {
        address: this.signerAddress,
        timestamp: String(timestamp),
        nonce,
        message: CLOB_AUTH_MESSAGE,
      },
    };
  }

  async createL1Headers(nonce = 0) {
    if (!this.wallet) throw new Error('No private key configured — cannot create L1 signature');
    const timestamp = Math.floor(Date.now() / 1000);
    const typedData = this.buildL1TypedData(timestamp, nonce);
    const signature = await this.wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
    return {
      POLY_ADDRESS: this.signerAddress,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: String(timestamp),
      POLY_NONCE: String(nonce),
      typedData,
    };
  }

  // ------------------------------------------------------- credentials (L2)
  /** Derive existing credentials, falling back to creating them. */
  async deriveApiCredentials({ nonce = 0 } = {}) {
    if (!this.wallet) throw new Error('Cannot derive CLOB credentials without a private key');
    const l1 = await this.createL1Headers(nonce);
    const headers = {
      POLY_ADDRESS: l1.POLY_ADDRESS,
      POLY_SIGNATURE: l1.POLY_SIGNATURE,
      POLY_TIMESTAMP: l1.POLY_TIMESTAMP,
      POLY_NONCE: l1.POLY_NONCE,
    };

    let res = await fetch(`${this.endpoints.clob}/auth/derive-api-key`, { headers });
    let body = await res.json().catch(() => ({}));
    if (!res.ok || !body.apiKey) {
      // No credentials exist yet for this address/nonce — create them.
      res = await fetch(`${this.endpoints.clob}/auth/api-key`, { method: 'POST', headers });
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok || !body.apiKey) {
      this.lastAuthError = body.error || body.message || `credential derivation failed (HTTP ${res.status})`;
      throw new Error(this.lastAuthError);
    }
    this.apiKey = body.apiKey;
    this.apiSecret = body.secret;
    this.apiPassphrase = body.passphrase;
    this.credentialsSource = 'derived';
    this.lastAuthError = null;
    return { apiKey: this.apiKey, apiSecret: this.apiSecret, apiPassphrase: this.apiPassphrase };
  }

  async ensureCredentials() {
    if (this.hasL2Credentials()) return this.getCredentials();
    return this.deriveApiCredentials();
  }

  getCredentials() {
    return { apiKey: this.apiKey, apiSecret: this.apiSecret, apiPassphrase: this.apiPassphrase };
  }

  // ------------------------------------------------------------ L2 signing
  /**
   * message = timestamp + METHOD + path + body
   * signature = urlsafeBase64WithPadding(HMAC-SHA256(base64Decode(secret), message))
   */
  static buildL2Signature(secret, timestamp, method, path, body = '') {
    const key = Buffer.from(secret, 'base64');
    const message = `${timestamp}${String(method).toUpperCase()}${path}${body || ''}`;
    const digest = crypto.createHmac('sha256', key).update(message).digest('base64');
    // URL-safe base64, padding preserved.
    return digest.replace(/\+/g, '-').replace(/\//g, '_');
  }

  createL2Headers(method, path, bodyString = '') {
    if (!this.hasL2Credentials()) throw new Error('Missing CLOB L2 credentials (apiKey/secret/passphrase)');
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = PolymarketAuth.buildL2Signature(this.apiSecret, timestamp, method, path, bodyString);
    return {
      POLY_ADDRESS: this.signerAddress || this.funderAddress,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: String(timestamp),
      POLY_API_KEY: this.apiKey,
      POLY_PASSPHRASE: this.apiPassphrase,
    };
  }

  /**
   * Authenticated request. The body is serialised exactly once and that exact
   * string is both signed and transmitted (the CLOB validates the signed body).
   */
  async signedFetch(method, path, bodyObj = null, { timeoutMs = 15000 } = {}) {
    const bodyString = bodyObj === null || bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const l2 = this.createL2Headers(method, path, bodyString);
    const base = this.endpoints.clob;
    // Sign the bare pathname; query parameters are not part of the HMAC message.
    const url = new URL(base + path);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { ...l2, 'Content-Type': 'application/json' },
        body: bodyString || undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
      return { ok: res.ok, status: res.status, body: json };
    } finally {
      clearTimeout(t);
    }
  }

  /** Signed request against the *exact* signed path (query params included). */
  async signedRequest(method, pathWithQuery, bodyObj = null) {
    const bodyString = bodyObj === null || bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    // The CLOB verifies the HMAC over the endpoint path WITHOUT the query string
    // (same as @polymarket/clob-client and clob-client-v2). Query params still go
    // on the URL, they are just not part of the signed message.
    const signedPath = pathWithQuery.split('?')[0];
    const l2 = this.createL2Headers(method, signedPath, bodyString);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${this.endpoints.clob}${pathWithQuery}`, {
        method,
        headers: { ...l2, 'Content-Type': 'application/json' },
        body: bodyString || undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
      return { ok: res.ok, status: res.status, body: json };
    } finally {
      clearTimeout(t);
    }
  }

  // ------------------------------------------------------------- balances
  /**
   * Polymarket keeps a server-side cache of balance/allowance. After a deposit,
   * an allowance change or the first order of the day you MUST hit
   * GET /balance-allowance/update or the read below keeps returning stale
   * values (commonly 0.00 for a freshly funded Deposit Wallet).
   *
   * @param {object}  [o]
   * @param {boolean} [o.force]        ignore the throttle
   * @param {string}  [o.tokenId]      set for CONDITIONAL (an outcome token's
   *                                   balance/allowance) instead of COLLATERAL
   */
  async syncBalanceAllowance({ force = false, minIntervalMs = 60000, tokenId = null } = {}) {
    if (!this.hasL2Credentials()) return null;
    const now = Date.now();
    const key = tokenId ? `CONDITIONAL:${tokenId}` : 'COLLATERAL';
    this._lastBaSync = this._lastBaSync || {};
    if (!force && this._lastBaSync[key] && now - this._lastBaSync[key] < minIntervalMs) return null;
    const qs = tokenId
      ? `?asset_type=CONDITIONAL&token_id=${encodeURIComponent(tokenId)}&signature_type=${this.signatureType}`
      : `?asset_type=COLLATERAL&signature_type=${this.signatureType}`;
    const r = await this.signedRequest('GET', `/balance-allowance/update${qs}`);
    this._lastBaSync[key] = now;
    return r;
  }

  /**
   * CLOB-side collateral balance + allowance for the active signature type.
   *
   * The returned `allowance` is the *minimum* allowance across the two V2
   * exchanges (one zero is enough for the CLOB to reject an order); the
   * per-exchange breakdown is in `allowances`, and `missingApprovals` lists the
   * exchanges the response explicitly reports as unapproved.
   */
  async checkBalanceAllowance({ refresh = true, tokenId = null } = {}) {
    if (!this.hasL2Credentials() || !this.signerAddress) return null;
    if (refresh) await this.syncBalanceAllowance({ tokenId }).catch(() => null);
    const qs = tokenId
      ? `?asset_type=CONDITIONAL&token_id=${encodeURIComponent(tokenId)}&signature_type=${this.signatureType}`
      : `?asset_type=COLLATERAL&signature_type=${this.signatureType}`;
    const r = await this.signedRequest('GET', `/balance-allowance${qs}`);
    if (!r.ok) return { ok: false, status: r.status, error: r.body && (r.body.error || r.body.message) };
    const parsed = parseBalanceAllowance(r.body);
    this.liveBalanceUsd = parsed.balance;
    this.allowanceUsd = parsed.allowance;
    this.missingApprovals = parsed.missingApprovals;
    return parsed;
  }

  /**
   * On-chain approval state of the account wallet — the ground truth behind the
   * CLOB's cached numbers, and the only way to tell "the cache is stale" apart
   * from "the approvals were never granted".
   *
   * @returns {Promise<{ok:boolean, checks:Array, missing:Array, error?:string}>}
   */
  async checkOnChainAllowances({ owner = this.funderAddress } = {}) {
    if (!owner) return { ok: false, checks: [], missing: [], error: 'No account wallet configured' };
    const state = await readTradingApprovals({
      rpcUrl: this.endpoints.polygonRpc,
      chainId: this.chainId,
      owner,
    });
    this.onChainApprovals = state;
    return state;
  }

  /** On-chain collateral balance of the account wallet (pUSD, plus USDC.e). */
  async checkOnChainBalance({ owner = this.funderAddress } = {}) {
    if (!owner) return { ok: false, error: 'No account wallet configured' };
    const out = await readCollateralBalances({
      rpcUrl: this.endpoints.polygonRpc,
      chainId: this.chainId,
      owner,
    });
    if (out.ok) this.liveBalanceUsd = out.total;
    return out;
  }

  /** Prefer the CLOB balance (what the exchange will actually debit). */
  async checkBalance() {
    if (this.authMode === 'paper') return { ok: true, balance: Infinity, mode: 'paper' };
    if (this.hasL2Credentials()) {
      const r = await this.checkBalanceAllowance();
      if (r && r.ok) return { ok: true, balance: r.balance, allowance: r.allowance, mode: 'live', source: 'clob' };
    }
    const chain = await this.checkOnChainBalance();
    return { ...chain, mode: 'live', source: 'chain' };
  }

  // ------------------------------------------------------------- geoblock
  /** Orders from restricted regions are rejected; check before trading. */
  async checkGeoblock() {
    try {
      const res = await fetch(this.endpoints.geoblock, { headers: { 'User-Agent': 'poly-updown-bot/2.0' } });
      const body = await res.json();
      this.geoblock = { ...body, checkedAt: new Date().toISOString() };
      return this.geoblock;
    } catch (e) {
      this.geoblock = { blocked: null, error: e.message, checkedAt: new Date().toISOString() };
      return this.geoblock;
    }
  }

  // --------------------------------------------------------------- status
  getStatus() {
    const w = this.wallet;
    const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : null);
    const names = { 0: 'EOA', 1: 'POLY_PROXY', 2: 'GNOSIS_SAFE', 3: 'DEPOSIT_WALLET' };
    return {
      isAuthenticated: this.isAuthenticated,
      hasCredentials: this.hasL2Credentials(),
      credentialsSource: this.credentialsSource,
      signatureType: this.signatureType,
      signatureTypeName: names[this.signatureType] || `UNKNOWN(${this.signatureType})`,
      signerAddress: short(w ? w.address : null),
      signerAddressFull: this.signerAddress,
      accountWallet: short(this.funderAddress),
      accountWalletFull: this.funderAddress,
      authMode: this.authMode,
      liveBalanceUsd: Number.isFinite(this.liveBalanceUsd) ? this.liveBalanceUsd : null,
      allowanceUsd: this.allowanceUsd,
      missingApprovals: this.missingApprovals,
      onChainApprovals: this.onChainApprovals
        ? {
            ok: this.onChainApprovals.ok,
            missing: (this.onChainApprovals.missing || []).map(m => m.label),
            checks: (this.onChainApprovals.checks || []).map(c => ({
              label: c.label, granted: c.granted,
              allowance: c.allowance, approved: c.approved,
            })),
            error: this.onChainApprovals.error || null,
          }
        : null,
      geoblock: this.geoblock,
      lastAuthError: this.lastAuthError,
      walletSetup: this.validateWalletSetup(),
    };
  }
}

module.exports = { PolymarketAuth, TOKENS, EXCHANGES, parseBalanceAllowance };
