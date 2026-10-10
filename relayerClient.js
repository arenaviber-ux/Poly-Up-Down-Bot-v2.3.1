'use strict';
/**
 * Polymarket gasless relayer client.
 *
 * Why this file exists: the CLOB has **no** redemption endpoint. Winning shares
 * pay $1.00 but they are ERC-1155 conditional tokens sitting inside the account
 * wallet (Deposit Wallet / Proxy / Safe), and until they are redeemed they are
 * invisible to `GET /balance-allowance?asset_type=COLLATERAL` — i.e. invisible
 * to the order path. A bot that never redeems converts its whole float into
 * unredeemable tokens and then idles forever with a green P&L.
 *
 * Redemption is an on-chain call that must be executed *by the account wallet*,
 * not by the signer EOA (the EOA holds no tokens, so a direct
 * `redeemPositions()` reverts). Polymarket's relayer submits that call for you
 * and pays the gas; you authorise it with a signature.
 *
 * Three account-wallet shapes, three signature schemes. This module implements
 * all three with ethers v6 only — no `viem`, no `@polymarket/*` dependency, no
 * conflicting ethers v5 in the tree:
 *
 *   signatureType 3  DEPOSIT_WALLET  EIP-712 `Batch` on the wallet itself
 *   signatureType 2  GNOSIS_SAFE     EIP-712 `SafeTx`, r||s||v packed for the Safe
 *   signatureType 1  POLY_PROXY      keccak256("rlx:" || fields), personal_sign
 *   signatureType 0  EOA             no relayer: the EOA calls the CTF directly
 *
 * Reference: docs.polymarket.com/trading/gasless,
 *            docs.polymarket.com/trading/positions/manage,
 *            @polymarket/builder-relayer-client 0.0.10 (schemas mirrored here).
 */
const {
  AbiCoder, Interface, Wallet, JsonRpcProvider, Contract,
  keccak256, solidityPacked, getCreate2Address,
  getBytes, toBeHex, TypedDataEncoder,
} = require('ethers');
const {
  ADAPTERS, CTF, EXCHANGES, TOKENS, WALLETS,
  MAX_UINT256, tradingApprovals,
} = require('./contracts');
const { readTradingApprovals } = require('./onchain');
const onchain = require('./onchain');

// ------------------------------------------------------------------ contracts
/**
 * Contract set used by this client. Kept as one object for the existing call
 * sites and tests; the addresses themselves live in contracts.js so they cannot
 * drift from the rest of the repo.
 */
const RELAYER_CONTRACTS = {
  137: {
    // Conditional Tokens Framework — holds positions, burns them on redeem.
    ctf: CTF,
    // V2 adapters: redeem straight into pUSD (the collateral the bot trades).
    ctfCollateralAdapter: ADAPTERS.ctfCollateralAdapter,
    negRiskCtfCollateralAdapter: ADAPTERS.negRiskCtfCollateralAdapter,
    // Neg-risk adapter (CLOB v1, deprecated) — legacy USDC.e output path.
    negRiskAdapter: ADAPTERS.negRiskAdapter,
    // Deposit Wallet batch entry point (`to` of a WALLET submission).
    depositWalletFactory: WALLETS.depositWalletFactory,
    // Legacy smart-wallet infrastructure.
    safeFactory: WALLETS.safeFactory,
    safeMultisend: WALLETS.safeMultisend,
    proxyFactory: WALLETS.proxyFactory,
    relayHub: WALLETS.relayHub,
    // The two CLOB V2 exchanges that must be approved before any order settles.
    exchange: EXCHANGES.standard,
    negRiskExchange: EXCHANGES.negRisk,
  },
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x' + '0'.repeat(64);
// Binary markets: indexSet 1 = outcome 0 (Up), indexSet 2 = outcome 1 (Down).
// Passing both is safe — the contract only pays out the winning side.
const BINARY_INDEX_SETS = [1, 2];

const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b';
const SAFE_INIT_CODE_HASH = '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf';

const DEFAULT_RELAYER_URL = 'https://relayer-v2.polymarket.com';
const DEFAULT_PROXY_GAS_LIMIT = 10_000_000n;

// Relayer transaction lifecycle. STATE_MINED / STATE_CONFIRMED are success;
// STATE_FAILED / STATE_INVALID are terminal failures.
const RELAYER_STATES = {
  NEW: 'STATE_NEW',
  EXECUTED: 'STATE_EXECUTED',
  MINED: 'STATE_MINED',
  CONFIRMED: 'STATE_CONFIRMED',
  INVALID: 'STATE_INVALID',
  FAILED: 'STATE_FAILED',
};
const RELAYER_SUCCESS = [RELAYER_STATES.MINED, RELAYER_STATES.CONFIRMED];
const RELAYER_FAILURE = [RELAYER_STATES.FAILED, RELAYER_STATES.INVALID];

const TX_TYPES = { 1: 'PROXY', 2: 'SAFE', 3: 'WALLET' };

// ------------------------------------------------------------------- encoding
const ctfInterface = new Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);
const negRiskAdapterInterface = new Interface([
  'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
]);
const ctfReadInterface = new Interface([
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
]);
// Legacy proxy wallet (signature type 1) batch entry point.
const proxyFactoryInterface = new Interface([
  'function proxy(tuple(uint8 typeCode,address to,uint256 value,bytes data)[] calls) payable returns (bytes[] returnValues)',
]);

/**
 * Encode the redeemPositions calldata for one condition.
 *
 * @param {object} p
 * @param {string} p.conditionId        market condition id
 * @param {boolean} [p.negativeRisk]    neg-risk markets redeem differently
 * @param {'pUSD'|'usdce'} [p.outputToken] pUSD routes through the V2 adapter
 * @param {bigint[]} [p.amounts]        per-outcome token balances (neg-risk)
 * @returns {{to:string, data:string, adapter:string, mode:string}}
 */
function encodeRedeem({ conditionId, negativeRisk = false, outputToken = 'pUSD', amounts = null }) {
  if (!conditionId || !/^0x[0-9a-fA-F]{64}$/.test(String(conditionId))) {
    throw new Error(`invalid conditionId: ${conditionId}`);
  }
  const cid = String(conditionId).toLowerCase();
  const usePusd = String(outputToken).toLowerCase() === 'pusd';

  if (negativeRisk) {
    // Neg-risk: the adapter ignores every argument except conditionId and
    // computes payouts from on-chain balances, but the calldata must still be
    // ABI-compatible. Legacy USDC.e output calls the neg-risk adapter's own
    // two-argument signature with explicit per-outcome amounts.
    if (usePusd) {
      return {
        to: RELAYER_CONTRACTS[137].negRiskCtfCollateralAdapter,
        data: ctfInterface.encodeFunctionData('redeemPositions', [
          TOKENS.pUSD, ZERO_BYTES32, cid, BINARY_INDEX_SETS,
        ]),
        adapter: 'NegRiskCtfCollateralAdapter',
        mode: 'negRisk/pUSD',
      };
    }
    const amts = Array.isArray(amounts) && amounts.length === 2
      ? amounts.map(a => BigInt(a))
      : [0n, 0n];
    return {
      to: RELAYER_CONTRACTS[137].negRiskAdapter,
      data: negRiskAdapterInterface.encodeFunctionData('redeemPositions', [cid, amts]),
      adapter: 'NegRiskAdapter',
      mode: 'negRisk/usdce',
    };
  }

  // Standard binary market. pUSD output goes through the V2 collateral
  // adapter; USDC.e output calls the CTF directly.
  const target = usePusd ? RELAYER_CONTRACTS[137].ctfCollateralAdapter : RELAYER_CONTRACTS[137].ctf;
  const collateral = usePusd ? TOKENS.pUSD : TOKENS.usdce;
  return {
    to: target,
    data: ctfInterface.encodeFunctionData('redeemPositions', [
      collateral, ZERO_BYTES32, cid, BINARY_INDEX_SETS,
    ]),
    adapter: usePusd ? 'CtfCollateralAdapter' : 'ConditionalTokens',
    mode: usePusd ? 'standard/pUSD' : 'standard/usdce',
  };
}

/**
 * Encode an ERC-20 approval as a `{to, data}` call (used to let an exchange or
 * adapter move the wallet's pUSD). The calldata itself comes from onchain.js so
 * the relayer batch, a direct EOA transaction and the doctor all encode the
 * identical bytes.
 */
function encodeApprove(spender, token = TOKENS.pUSD, amount = MAX_UINT256) {
  return { to: token, data: onchain.encodeApprove(spender, token, amount) };
}

/** Encode an ERC-1155 `setApprovalForAll` (the CTF operator approval) as a call. */
function encodeApprovalForAll(operator, token = CTF, approved = true) {
  return { to: token, data: onchain.encodeSetApprovalForAll(operator, token, approved) };
}

/**
 * The complete set of calls that grant the CLOB V2 exchanges access to an
 * account wallet's pUSD and conditional tokens — the approvals in
 * docs.polymarket.com/trading/wallets-auth, as `{to, value, data, label}`.
 *
 * @param {object} [o]
 * @param {boolean} [o.negRiskOnly]
 * @param {boolean} [o.standardOnly]
 */
function tradingApprovalCalls({ include, negRiskOnly = false, standardOnly = false } = {}) {
  return tradingApprovals({ include: include || undefined, negRiskOnly, standardOnly }).map(a => ({
    ...onchain.approvalCall(a),
    label: a.label,
    kind: a.kind,
    spender: a.spender,
    purpose: a.purpose,
  }));
}

/**
 * Encode a proxy-wallet (signature type 1) batch: `ProxyFactory.proxy(calls)`.
 * call = { typeCode: uint8, to: address, value: uint256, data: bytes }
 */
function encodeProxyTransactionData(calls) {
  // 4-byte selector, taken from the ABI fragment rather than hand-hashed.
  return proxyFactoryInterface.encodeFunctionData('proxy', [
    calls.map(c => ({
      typeCode: c.typeCode !== undefined ? c.typeCode : 1,
      to: c.to,
      value: BigInt(c.value || 0),
      data: c.data,
    })),
  ]);
}

// ------------------------------------------------------- wallet derivation
/**
 * CREATE2 address of a legacy Magic-Link proxy wallet (signature type 1).
 * ethers v6 takes (from, salt, initCodeHash) positionally — the v5/viem
 * options-object form silently produces an invalid-address error.
 */
function deriveProxyWallet(ownerAddress, proxyFactory = RELAYER_CONTRACTS[137].proxyFactory) {
  return getCreate2Address(
    proxyFactory,
    keccak256(solidityPacked(['address'], [ownerAddress])),
    PROXY_INIT_CODE_HASH,
  );
}

/** CREATE2 address of a legacy Safe (signature type 2). */
function deriveSafeAddress(ownerAddress, safeFactory = RELAYER_CONTRACTS[137].safeFactory) {
  return getCreate2Address(
    safeFactory,
    keccak256(AbiCoder.defaultAbiCoder().encode(['address'], [ownerAddress])),
    SAFE_INIT_CODE_HASH,
  );
}

// ---------------------------------------------------------------- signatures
/**
 * Deposit Wallet (type 3): EIP-712 `Batch`, verified by the wallet itself.
 * NOTE the domain's verifyingContract is the *deposit wallet*, not the factory,
 * and the `to` of the submitted request is the factory. Getting those the wrong
 * way round is the single most common failure here.
 */
const DEPOSIT_WALLET_TYPES = {
  Call: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
  Batch: [
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'calls', type: 'Call[]' },
  ],
};

function depositWalletTypedData({ chainId, walletAddress, nonce, deadline, calls }) {
  return {
    domain: {
      name: 'DepositWallet',
      version: '1',
      chainId,
      verifyingContract: walletAddress,
    },
    types: DEPOSIT_WALLET_TYPES,
    primaryType: 'Batch',
    message: {
      wallet: walletAddress,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      calls: calls.map(c => ({ target: c.target, value: BigInt(c.value || 0), data: c.data })),
    },
  };
}

async function signDepositWalletBatch(wallet, args) {
  const td = depositWalletTypedData(args);
  const signature = await wallet.signTypedData(td.domain, td.types, td.message);
  return {
    type: 'WALLET',
    from: args.from,
    to: RELAYER_CONTRACTS[args.chainId]?.depositWalletFactory
      || RELAYER_CONTRACTS[137].depositWalletFactory,
    nonce: String(args.nonce),
    signature,
    depositWalletParams: {
      depositWallet: args.walletAddress,
      deadline: String(args.deadline),
      calls: args.calls.map(c => ({ target: c.target, value: String(c.value || 0), data: c.data })),
    },
  };
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function safeTypedData({ chainId, safeAddress, to, value, data, operation, nonce }) {
  return {
    // The Safe domain has only chainId + verifyingContract (no name/version).
    domain: { chainId, verifyingContract: safeAddress },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      to,
      value: BigInt(value || 0),
      data,
      operation: Number(operation || 0),
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: BigInt(nonce),
    },
  };
}

/**
 * Pack an EOA signature for Gnosis Safe `execTransaction`: r || s || v, with
 * v shifted into the EOA range (27/28 -> 31/32). Without the shift the Safe
 * reads it as a contract signature and the tx reverts.
 */
function packSafeSignature(signatureHex) {
  const hex = String(signatureHex || '');
  if (!/^0x[0-9a-fA-F]{130}$/.test(hex)) {
    throw new Error(`invalid signature length: expected 65 bytes, got ${(hex.length - 2) / 2}`);
  }
  const r = '0x' + hex.slice(2, 66);
  const sv = '0x' + hex.slice(66, 130);
  let v = parseInt(hex.slice(130, 132), 16);
  // Read v from the hex directly: Signature.from() rejects anything outside
  // 0/1/27/28 with a TypeError, which would mask the real diagnostic.
  if (v === 0 || v === 1) v += 31;         // compact form  -> 31 / 32
  else if (v === 27 || v === 28) v += 4;   // canonical form -> 31 / 32
  else throw new Error(`invalid signature v: ${v} (expected 0, 1, 27 or 28)`);
  return solidityPacked(['uint256', 'uint256', 'uint8'], [r, sv, v]);
}

async function signSafeTransaction(wallet, args) {
  const td = safeTypedData(args);
  const structHash = TypedDataEncoder.hash(td.domain, td.types, td.message);
  // The Safe verifies an EIP-191 personal signature over the struct hash, not a
  // raw typed-data signature.
  const sig = await wallet.signMessage(getBytes(structHash));
  const transaction = {
    to: args.to,
    value: String(args.value || 0),
    data: args.data,
    operation: Number(args.operation || 0),
  };
  return {
    type: 'SAFE',
    from: args.from,
    to: transaction.to,
    proxyWallet: args.safeAddress,
    data: transaction.data,
    nonce: String(args.nonce),
    signature: packSafeSignature(sig),
    signatureParams: {
      gasPrice: '0',
      operation: String(transaction.operation),
      safeTxnGas: '0',
      baseGas: '0',
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
    },
    metadata: args.metadata || '',
  };
}

/**
 * Legacy proxy wallet (type 1): keccak256 over "rlx:" || packed fields, signed
 * as a personal message. The `relay` address and `nonce` come from the
 * relayer's `/relay-payload` endpoint, not from local state.
 */
function proxyStructHash({ from, to, data, txFee, gasPrice, gasLimit, nonce, relayHubAddress, relayAddress }) {
  return keccak256(Buffer.concat([
    Buffer.from('726c783a', 'hex'),                          // "rlx:"
    Buffer.from(getBytes(from)),
    Buffer.from(getBytes(to)),
    Buffer.from(getBytes(data)),
    Buffer.from(getBytes(toBeHex(BigInt(txFee), 32))),
    Buffer.from(getBytes(toBeHex(BigInt(gasPrice), 32))),
    Buffer.from(getBytes(toBeHex(BigInt(gasLimit), 32))),
    Buffer.from(getBytes(toBeHex(BigInt(nonce), 32))),
    Buffer.from(getBytes(relayHubAddress)),
    Buffer.from(getBytes(relayAddress)),
  ]));
}

async function signProxyTransaction(wallet, args) {
  const structHash = proxyStructHash(args);
  const signature = await wallet.signMessage(getBytes(structHash));
  return {
    type: 'PROXY',
    from: args.from,
    to: args.to,
    proxyWallet: args.proxyWallet,
    data: args.data,
    nonce: String(args.nonce),
    signature,
    signatureParams: {
      gasPrice: String(args.gasPrice),
      gasLimit: String(args.gasLimit),
      relayerFee: String(args.txFee),
      relayHub: args.relayHubAddress,
      relay: args.relayAddress,
    },
    metadata: args.metadata || '',
  };
}

// ------------------------------------------------------------------- client
class RelayerClient {
  /**
   * @param {object} config   CONFIG from config.js
   * @param {PolymarketAuth} auth
   */
  constructor(config, auth, { log = () => {} } = {}) {
    this.cfg = config;
    this.auth = auth;
    this.log = log;
    this.chainId = Number(config.chainId || 137);
    this.url = String(config.relayer.url || DEFAULT_RELAYER_URL).replace(/\/+$/, '');
    this.contracts = RELAYER_CONTRACTS[this.chainId] || RELAYER_CONTRACTS[137];
    this.provider = null;
    this.lastError = null;
  }

  get contractsForChain() { return this.contracts; }

  /** Relayer authorisation headers. Relayer API key, else Builder API key. */
  authHeaders() {
    const r = this.cfg.relayer || {};
    if (r.apiKey && r.apiKeyAddress) {
      return { RELAYER_API_KEY: r.apiKey, RELAYER_API_KEY_ADDRESS: r.apiKeyAddress };
    }
    if (r.builderApiKey && r.builderSecret && r.builderPassphrase) {
      // Builder auth is an HMAC over the same message shape as CLOB L2, with
      // its own header names. Reuse the audited implementation.
      const { PolymarketAuth } = require('./polymarketAuth');
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = PolymarketAuth.buildL2Signature(
        r.builderSecret, timestamp, 'POST', '/submit', '',
      );
      return {
        POLY_BUILDER_API_KEY: r.builderApiKey,
        POLY_BUILDER_TIMESTAMP: String(timestamp),
        POLY_BUILDER_PASSPHRASE: r.builderPassphrase,
        POLY_BUILDER_SIGNATURE: signature,
      };
    }
    return null;
  }

  isConfigured() {
    return !!this.authHeaders();
  }

  /** Which relayer transaction type this account needs. */
  txType() {
    return TX_TYPES[Number(this.auth.signatureType)] || null;
  }

  async fetchJson(method, path, { params = null, body = null, authed = false, timeoutMs = 20000 } = {}) {
    const qs = params ? '?' + new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
    ).toString() : '';
    const url = `${this.url}${path}${qs}`;
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'poly-updown-bot/2.3', ...(authed ? this.authHeaders() : {}) };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
      return { ok: res.ok, status: res.status, body: json };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    } finally {
      clearTimeout(t);
    }
  }

  /** Current relayer-tracked nonce for this signer + tx type. */
  async getNonce(signerAddress, type) {
    const r = await this.fetchJson('GET', '/nonce', { params: { address: signerAddress, type } });
    if (!r.ok || !r.body) throw new Error(`relayer /nonce failed (${r.status || r.error})`);
    return r.body.nonce !== undefined ? String(r.body.nonce) : null;
  }

  /** Relay address + nonce for legacy proxy-wallet submissions. */
  async getRelayPayload(signerAddress) {
    const r = await this.fetchJson('GET', '/relay-payload', { params: { address: signerAddress, type: 'PROXY' } });
    if (!r.ok || !r.body) throw new Error(`relayer /relay-payload failed (${r.status || r.error})`);
    return { address: r.body.address, nonce: String(r.body.nonce) };
  }

  async getTransaction(transactionId) {
    const r = await this.fetchJson('GET', '/transaction', { params: { id: transactionId }, authed: true });
    if (!r.ok) return [];
    return Array.isArray(r.body) ? r.body : (r.body ? [r.body] : []);
  }

  async isDeployed(address) {
    const r = await this.fetchJson('GET', '/deployed', { params: { address } });
    return !!(r.ok && r.body && r.body.deployed);
  }

  getProvider() {
    if (!this.provider) {
      this.provider = new JsonRpcProvider(this.cfg.endpoints.polygonRpc, this.chainId);
    }
    return this.provider;
  }

  /**
   * Execute a batch of {to, data, value} calls from the account wallet,
   * gaslessly, using the signature scheme for this account's wallet type.
   *
   * @returns {{ok:boolean, transactionID?:string, state?:string, error?:string, request?:object}}
   */
  async execute(calls, metadata = '') {
    if (!calls || !calls.length) return { ok: false, error: 'no calls to execute' };
    if (!this.auth || !this.auth.wallet) return { ok: false, error: 'no signer configured (POLY_PRIVATE_KEY)' };
    const headers = this.authHeaders();
    if (!headers) {
      return {
        ok: false,
        error: 'relayer not configured — set RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS '
          + '(polymarket.com -> Settings -> API Keys -> Relayer API Keys)',
      };
    }
    const signatureType = Number(this.auth.signatureType);
    const from = this.auth.signerAddress;
    const normalised = calls.map(c => ({ target: c.to, value: c.value || '0', data: c.data }));

    try {
      let request;
      if (signatureType === 3) {
        const walletAddress = this.auth.funderAddress;
        if (!walletAddress) return { ok: false, error: 'signature type 3 needs POLY_FUNDER_ADDRESS (the Deposit Wallet)' };
        const nonce = await this.getNonce(from, 'WALLET');
        const deadline = Math.floor(Date.now() / 1000) + Number(this.cfg.relayer.deadlineSeconds || 300);
        request = await signDepositWalletBatch(this.auth.wallet, {
          chainId: this.chainId, from, walletAddress, nonce, deadline, calls: normalised,
        });
      } else if (signatureType === 2) {
        // The Safe executes one call per transaction; multisend batching is not
        // worth the extra failure surface for a redemption sweep.
        if (normalised.length > 1) {
          return { ok: false, error: 'SAFE accounts execute one call per submission — batch size must be 1' };
        }
        const safeAddress = this.auth.funderAddress || deriveSafeAddress(from);
        const nonce = await this.getNonce(from, 'SAFE');
        request = await signSafeTransaction(this.auth.wallet, {
          chainId: this.chainId, from, safeAddress, nonce, metadata,
          to: normalised[0].target, value: normalised[0].value, data: normalised[0].data, operation: 0,
        });
      } else if (signatureType === 1) {
        const proxyWallet = this.auth.funderAddress || deriveProxyWallet(from);
        const rp = await this.getRelayPayload(from);
        const gasLimit = BigInt(this.cfg.relayer.proxyGasLimit || DEFAULT_PROXY_GAS_LIMIT);
        request = await signProxyTransaction(this.auth.wallet, {
          from,
          to: this.contracts.proxyFactory,
          proxyWallet,
          data: encodeProxyTransactionData(normalised.map(c => ({ typeCode: 1, to: c.target, value: c.value, data: c.data }))),
          txFee: '0',
          gasPrice: '0',
          gasLimit,
          nonce: rp.nonce,
          relayHubAddress: this.contracts.relayHub,
          relayAddress: rp.address,
          metadata,
        });
      } else {
        return {
          ok: false,
          error: `signature type ${signatureType} (EOA) does not use the relayer — `
            + 'redeem by calling the CTF directly from the EOA (see redeemDirect)',
        };
      }

      const payload = JSON.stringify(request);
      const res = await this.fetchJson('POST', '/submit', { body: payload, authed: true });
      if (!res.ok) {
        const msg = (res.body && (res.body.error || res.body.message)) || `HTTP ${res.status}`;
        this.lastError = msg;
        return { ok: false, status: res.status, error: msg, request };
      }
      const body = res.body || {};
      // POST /submit returns immediately with { transactionID, state: "STATE_NEW" }.
      return {
        ok: true,
        transactionID: body.transactionID || body.transactionId || body.id || null,
        state: body.state || RELAYER_STATES.NEW,
        transactionHash: body.transactionHash || null,
        request,
      };
    } catch (e) {
      this.lastError = e.message;
      return { ok: false, error: e.message };
    }
  }

  /**
   * Poll a submitted transaction until it reaches a terminal state.
   * @returns {{ok:boolean, state?:string, transactionHash?:string, error?:string}}
   */
  async waitForTransaction(transactionID, { maxPolls = 20, pollMs = 2000 } = {}) {
    if (!transactionID) return { ok: false, error: 'no transactionID to poll' };
    for (let i = 0; i < maxPolls; i++) {
      const rows = await this.getTransaction(transactionID);
      const txn = rows[0];
      if (txn) {
        if (RELAYER_SUCCESS.includes(txn.state)) {
          return { ok: true, state: txn.state, transactionHash: txn.transactionHash || null };
        }
        if (RELAYER_FAILURE.includes(txn.state)) {
          return {
            ok: false,
            state: txn.state,
            transactionHash: txn.transactionHash || null,
            error: txn.error || txn.errorMessage || `relayer state ${txn.state}`,
          };
        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    return { ok: false, state: 'TIMEOUT', error: `no terminal state after ${maxPolls} polls` };
  }

  // --------------------------------------------------------- approvals
  /**
   * On-chain approval state of the account wallet: which of the required
   * approvals are actually in place. This is the ground truth; the CLOB's
   * `/balance-allowance` numbers are a cache that lags behind it.
   */
  async readTradingApprovals() {
    const owner = this.accountWalletAddress();
    if (!owner) return { ok: false, checks: [], missing: [], error: 'no account wallet configured' };
    const state = await readTradingApprovals({
      rpcUrl: this.cfg.endpoints.polygonRpc,
      chainId: this.chainId,
      owner,
    });
    this.lastApprovalState = state;
    return state;
  }

  /** The address whose allowances matter: the account wallet, or the EOA. */
  accountWalletAddress() {
    if (Number(this.auth && this.auth.signatureType) === 0) {
      return (this.auth && this.auth.funderAddress) || (this.auth && this.auth.signerAddress) || null;
    }
    return (this.auth && this.auth.funderAddress) || null;
  }

  /**
   * Grant the trading approvals the CLOB requires, from the account wallet.
   *
   * An EOA `approve()` transaction does NOT do this for a Deposit Wallet, Safe
   * or proxy account: the spender must be approved *by the wallet that holds the
   * funds*, which on Polymarket means a relayer batch. This is the missing step
   * behind every "allowance is 0" / "not enough balance / allowance" rejection.
   *
   * Only the approvals that are actually missing are submitted, and the CLOB
   * cache is refreshed afterwards so the next balance read agrees with chain.
   *
   * @param {object} [o]
   * @param {boolean} [o.force]    re-approve even if already granted
   * @param {boolean} [o.dryRun]   report what would be submitted, submit nothing
   * @param {boolean} [o.syncClob] refresh the CLOB balance/allowance cache after
   * @returns {Promise<{ok:boolean, submitted?:Array, approved?:Array,
   *                    alreadyApproved?:boolean, transactionID?:string,
   *                    transactionHash?:string, checks?:Array, error?:string}>}
   */
  async setupTradingApprovals({ force = false, dryRun = false, syncClob = true, maxPolls = 30, pollMs = 2000 } = {}) {
    const signatureType = Number(this.auth && this.auth.signatureType);
    const owner = this.accountWalletAddress();
    if (!owner) {
      return { ok: false, error: 'POLY_FUNDER_ADDRESS is required to grant approvals (the account wallet holds the funds)' };
    }

    const state = await this.readTradingApprovals();
    const all = tradingApprovalCalls();
    const targets = force
      ? all
      : (state.ok ? state.missing.map(m => tradingApprovalCalls().find(c => c.spender === m.spender && c.kind === m.kind)).filter(Boolean) : all);

    if (!state.ok && !force) {
      // Could not read the chain (bad RPC). Approving blind is harmless but
      // pointless, and hiding the RPC failure behind a successful no-op is worse.
      return { ok: false, error: `could not read on-chain approvals: ${state.error}` };
    }
    if (!targets.length) {
      return {
        ok: true,
        alreadyApproved: true,
        checks: state.checks,
        message: 'every required trading approval is already in place',
      };
    }

    if (dryRun) {
      return {
        ok: true, dryRun: true, owner,
        submitted: targets.map(t => ({ label: t.label, to: t.to, kind: t.kind })),
        checks: state.checks,
      };
    }

    const calls = targets.map(t => ({ to: t.to, data: t.data, value: '0' }));
    const metadata = 'Approve Polymarket V2 exchanges (pUSD + conditional tokens)';

    let result;
    if (signatureType === 0) {
      result = await this.approveDirect(calls);
    } else if (signatureType === 2) {
      // The Safe executes one call per submission, so approvals are sequential.
      result = { ok: true, transactions: [] };
      for (const call of calls) {
        const sub = await this.execute([call], metadata);
        if (!sub.ok) { result = sub; break; }
        const done = await this.waitForTransaction(sub.transactionID, { maxPolls, pollMs });
        result.transactions.push({ ...sub, ...done });
        if (!done.ok) { result = { ...sub, ...done }; break; }
      }
    } else {
      const sub = await this.execute(calls, metadata);
      if (!sub.ok) return { ...sub, attempted: targets.map(t => t.label), checks: state.checks };
      const done = await this.waitForTransaction(sub.transactionID, { maxPolls, pollMs });
      result = { ...sub, ...done };
    }

    if (!result.ok) return { ...result, submitted: targets.map(t => t.label), checks: state.checks };

    // Re-read so the report reflects chain, then let the CLOB catch up.
    const after = await this.readTradingApprovals();
    if (syncClob && this.auth && typeof this.auth.syncBalanceAllowance === 'function') {
      await this.auth.syncBalanceAllowance({ force: true }).catch(() => null);
    }

    return {
      ok: after.ok && after.missing.length === 0,
      submitted: targets.map(t => t.label),
      checks: after.checks,
      stillMissing: after.missing.map(m => m.label),
      transactionID: result.transactionID || null,
      transactionHash: result.transactionHash || (result.transactions ? result.transactions.map(t => t.transactionHash).filter(Boolean) : null),
      error: (after.ok && after.missing.length === 0)
        ? undefined
        : 'the approval transaction was accepted but not every allowance is set — re-run `npm run approve`',
    };
  }

  /**
   * EOA (signature type 0) approvals: the signer *is* the account wallet, so it
   * approves directly. Unlike the relayer path this costs real POL gas.
   */
  async approveDirect(calls) {
    try {
      const provider = this.getProvider();
      const wallet = this.auth.wallet.connect(provider);
      const pol = await provider.getBalance(wallet.address);
      if (pol === 0n) {
        return { ok: false, error: 'the signer EOA has no POL for gas — fund it, or use a Deposit Wallet account (signature type 3)' };
      }
      const hashes = [];
      for (const call of calls) {
        const tx = await wallet.sendTransaction({
          to: call.to, data: call.data, value: BigInt(call.value || 0), gasLimit: 200000n,
        });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          return { ok: false, transactionHash: receipt && receipt.hash, error: `approval reverted on ${call.to}` };
        }
        hashes.push(receipt.hash);
      }
      return { ok: true, transactionHash: hashes[0], transactionHashes: hashes, state: RELAYER_STATES.MINED, mode: 'direct' };
    } catch (e) {
      return { ok: false, error: e.message, mode: 'direct' };
    }
  }

  /**
   * EOA (signature type 0) fallback: the signer *is* the account wallet, so it
   * can call the CTF directly. This one costs real POL gas.
   */
  async redeemDirect({ conditionId, negativeRisk = false, outputToken = 'pUSD', gasLimit = 500000 }) {
    if (Number(this.auth.signatureType) !== 0) {
      return { ok: false, error: 'redeemDirect is for EOA accounts (signature type 0) only' };
    }
    try {
      const provider = this.getProvider();
      const wallet = this.auth.wallet.connect(provider);
      const pol = await provider.getBalance(wallet.address);
      if (pol === 0n) {
        return { ok: false, error: 'EOA has no POL for gas — fund the signer or switch to a relayer account type' };
      }
      const enc = encodeRedeem({ conditionId, negativeRisk, outputToken });
      const tx = await wallet.sendTransaction({ to: enc.to, data: enc.data, value: 0n, gasLimit: BigInt(gasLimit) });
      const receipt = await tx.wait();
      return {
        ok: receipt.status === 1,
        transactionHash: receipt.hash,
        state: receipt.status === 1 ? RELAYER_STATES.MINED : RELAYER_STATES.FAILED,
        mode: 'direct',
      };
    } catch (e) {
      return { ok: false, error: e.message, mode: 'direct' };
    }
  }

  /** Read-only CTF helpers: is a condition resolved, and who won? */
  async readCondition(conditionId) {
    const provider = this.getProvider();
    const ctf = new Contract(this.contracts.ctf, ctfReadInterface, provider);
    const cid = String(conditionId).toLowerCase();
    const denominator = await ctf.payoutDenominator(cid);
    const resolved = denominator > 0n;
    let winningIndexSets = [];
    if (resolved) {
      const slots = await ctf.getOutcomeSlotCount(cid);
      for (let i = 0; i < Number(slots); i++) {
        const n = await ctf.payoutNumerators(cid, i);
        if (n > 0n) winningIndexSets.push(i + 1);   // indexSets are 1-indexed
      }
    }
    return { resolved, winningIndexSets, payoutDenominator: denominator.toString() };
  }

  /** ERC-1155 balance of one outcome token held by the account wallet. */
  async tokenBalance(tokenId, owner) {
    const provider = this.getProvider();
    const ctf = new Contract(this.contracts.ctf, ctfReadInterface, provider);
    const bal = await ctf.balanceOf(owner || this.auth.funderAddress, BigInt(tokenId));
    return bal / 10n ** 6n;   // shares, 6 decimals — integer part only
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      authMode: this.authHeaders() ? (this.cfg.relayer.apiKey ? 'relayer-api-key' : 'builder-api-key') : 'none',
      txType: this.txType(),
      url: this.url,
      chainId: this.chainId,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  RelayerClient,
  RELAYER_CONTRACTS,
  RELAYER_STATES,
  RELAYER_SUCCESS,
  RELAYER_FAILURE,
  TX_TYPES,
  TOKENS,
  BINARY_INDEX_SETS,
  ZERO_BYTES32,
  encodeRedeem,
  encodeApprove,
  encodeApprovalForAll,
  tradingApprovalCalls,
  encodeProxyTransactionData,
  deriveProxyWallet,
  deriveSafeAddress,
  depositWalletTypedData,
  safeTypedData,
  packSafeSignature,
  proxyStructHash,
  signDepositWalletBatch,
  signSafeTransaction,
  signProxyTransaction,
  DEFAULT_RELAYER_URL,
};
