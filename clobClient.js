'use strict';
/**
 * Async API client: public market data + L2-authenticated trading calls, plus
 * a market resolver that exposes everything needed to size and sign an order
 * (tick size, minimum order size, neg-risk, fee schedule).
 */
const { PolymarketAuth } = require('./polymarketAuth');

/**
 * What the CLOB returns when the order was signed against the wrong exchange
 * version. The official client re-reads `GET /version` on exactly this string
 * and retries once.
 */
const ORDER_VERSION_MISMATCH = /order_version_mismatch/i;

/** The order version this bot signs for: the CLOB V2 CTF exchanges. */
const SIGNED_ORDER_VERSION = 2;

async function getJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'poly-updown-bot/2.0', ...headers }, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

/** Normalise a CLOB book payload into a usable structure. */
function normaliseBook(raw) {
  if (!raw) return null;
  const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
  const bids = (raw.bids || []).map(b => ({ price: num(b.price), size: num(b.size) }))
    .filter(b => b.price !== null).sort((a, b) => b.price - a.price);
  const asks = (raw.asks || []).map(a => ({ price: num(a.price), size: num(a.size) }))
    .filter(a => a.price !== null).sort((a, b) => a.price - b.price);
  const bestBid = bids.length ? bids[0].price : null;
  const bestAsk = asks.length ? asks[0].price : null;
  return {
    tokenId: raw.asset_id || raw.tokenId || null,
    conditionId: raw.market || null,
    bids, asks, bestBid, bestAsk,
    spread: (bestBid !== null && bestAsk !== null) ? +(bestAsk - bestBid).toFixed(4) : null,
    bidDepthUsd: bids.reduce((a, b) => a + b.price * b.size, 0),
    askDepthUsd: asks.reduce((a, b) => a + b.price * b.size, 0),
    bidDepthShares: bids.reduce((a, b) => a + b.size, 0),
    askDepthShares: asks.reduce((a, b) => a + b.size, 0),
    minOrderSize: raw.min_order_size !== undefined ? num(raw.min_order_size) : null,
    tickSize: raw.tick_size !== undefined ? num(raw.tick_size) : null,
    negRisk: raw.neg_risk !== undefined ? !!raw.neg_risk : null,
    lastTradePrice: raw.last_trade_price !== undefined ? num(raw.last_trade_price) : null,
    timestamp: raw.timestamp ? Number(raw.timestamp) : null,
    hash: raw.hash || null,
    receivedAt: Date.now(),
  };
}

/**
 * Walk the ask ladder to estimate the average fill price for a BUY of `shares`
 * and the USD cost. Returns null when liquidity is insufficient.
 */
function estimateBuyFill(book, shares) {
  if (!book || !book.asks.length || !(shares > 0)) return null;
  let remaining = shares, cost = 0, filled = 0, worst = null;
  for (const level of book.asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    filled += take;
    remaining -= take;
    worst = level.price;
  }
  if (filled <= 0) return null;
  return {
    shares: filled,
    cost,
    vwap: cost / filled,
    worstPrice: worst,
    complete: remaining <= 1e-9,
    unfilled: Math.max(0, remaining),
  };
}

/** Walk the bid ladder to estimate proceeds for a SELL of `shares`. */
function estimateSellFill(book, shares) {
  if (!book || !book.bids.length || !(shares > 0)) return null;
  let remaining = shares, proceeds = 0, filled = 0;
  for (const level of book.bids) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    proceeds += take * level.price;
    filled += take;
    remaining -= take;
  }
  if (filled <= 0) return null;
  return { shares: filled, proceeds, vwap: proceeds / filled, complete: remaining <= 1e-9, unfilled: Math.max(0, remaining) };
}

class ClobClient {
  constructor(config, auth) {
    this.cfg = config;
    this.endpoints = config.endpoints;
    this.auth = auth || null;
    this._bookCache = new Map(); // tokenId -> {book, at}
  }

  // ------------------------------------------------------------- public
  async getBook(tokenId, { maxAgeMs = 1000 } = {}) {
    const cached = this._bookCache.get(String(tokenId));
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.book;
    const raw = await getJson(`${this.endpoints.clob}/book?token_id=${encodeURIComponent(tokenId)}`);
    const book = normaliseBook(raw);
    this._bookCache.set(String(tokenId), { book, at: Date.now() });
    return book;
  }

  /** Server time is useful for detecting clock skew before signing orders. */
  async getServerTime() {
    try {
      const r = await getJson(`${this.endpoints.clob}/time`);
      return r;
    } catch (_) { return null; }
  }

  async getMidpoint(tokenId) {
    try {
      const r = await getJson(`${this.endpoints.clob}/midpoint?token_id=${encodeURIComponent(tokenId)}`);
      return r && r.mid !== undefined ? parseFloat(r.mid) : null;
    } catch (_) { return null; }
  }

  // ---------------------------------------------------------------- L2
  requireAuth() {
    if (!this.auth || !this.auth.hasL2Credentials()) {
      throw new Error('CLOB L2 credentials are not configured (run the auth/derive step first)');
    }
  }

  /**
   * Place an order. `signedOrder` is the object produced by orderSigner.signOrder
   * and `orderType` is one of GTC | GTD | FAK | FOK.
   */
  async postOrder(signedOrder, { orderType = 'FAK', owner = null, postOnly = false, deferExec = false } = {}) {
    this.requireAuth();
    const body = {
      deferExec,
      order: signedOrder,
      owner: owner || this.auth.apiKey,
      orderType,
    };
    if (postOnly) body.postOnly = true;
    const r = await this.auth.signedRequest('POST', '/order', body);
    // The server moves the book between exchange versions at will. When it has,
    // the signature is for the wrong contract and the rejection says so with
    // `order_version_mismatch` — drop the cached version so the next attempt
    // re-reads it, and say plainly what happened rather than passing a bare 400
    // through as if the order itself were malformed.
    if (ORDER_VERSION_MISMATCH.test(JSON.stringify(r.body || r.error || ''))) {
      this._orderVersion = undefined;
      return {
        ...r,
        orderVersionMismatch: true,
        error: 'the CLOB now expects a different order version — the order was signed for the CLOB V2 CTF '
          + 'exchange but the server has moved this market to another exchange version',
        request: body,
      };
    }
    return { ...r, request: body };
  }

  async cancelOrder(orderId) {
    this.requireAuth();
    return this.auth.signedRequest('DELETE', '/order', { orderID: orderId });
  }

  async cancelOrders(orderIds) {
    this.requireAuth();
    return this.auth.signedRequest('DELETE', '/orders', orderIds.map(id => ({ orderID: id })));
  }

  async getOrder(orderId) {
    this.requireAuth();
    return this.auth.signedRequest('GET', `/data/order/${encodeURIComponent(orderId)}`);
  }

  async getOpenOrders({ market, tokenId, id } = {}) {
    this.requireAuth();
    const qs = new URLSearchParams();
    if (market) qs.set('market', market);
    if (tokenId) qs.set('asset_id', tokenId);
    if (id) qs.set('id', id);
    const q = qs.toString();
    return this.auth.signedRequest('GET', `/data/orders${q ? `?${q}` : ''}`);
  }

  async getTrades({ market, tokenId, id, maker_address, limit = 100 } = {}) {
    this.requireAuth();
    const qs = new URLSearchParams();
    if (market) qs.set('market', market);
    if (tokenId) qs.set('asset_id', tokenId);
    if (id) qs.set('id', id);
    if (maker_address) qs.set('maker_address', maker_address);
    if (limit) qs.set('limit', String(limit));
    return this.auth.signedRequest('GET', `/data/trades?${qs.toString()}`);
  }

  async getBalanceAllowance(signatureType) {
    this.requireAuth();
    const st = signatureType !== undefined ? signatureType : this.auth.signatureType;
    return this.auth.signedRequest('GET', `/balance-allowance?asset_type=COLLATERAL&signature_type=${st}`);
  }

  /** Minimal server-side sanity check used by the diagnostics endpoint. */
  async pingPrivate() {
    if (!this.auth || !this.auth.hasL2Credentials()) return { ok: false, error: 'no credentials' };
    const r = await this.auth.signedRequest('GET', '/data/orders');
    if (r.status === 401 || r.status === 403) {
      return { ok: false, status: r.status, error: (r.body && (r.body.error || r.body.message)) || 'unauthorised' };
    }
    return { ok: r.ok, status: r.status };
  }

  /**
   * The order version the CLOB is currently accepting.
   *
   * The exchange contract an order is signed against is chosen by this number:
   * 1 = the legacy CTF Exchange, 2 = the CLOB V2 CTF exchanges (what this bot
   * signs), 3 = ExchangeV3 / Protocol V2 positions. Polymarket's own client
   * reads it from `GET /version` before building every order and re-reads it
   * when the server answers `order_version_mismatch`, because the server can
   * move the whole book to a different exchange version at any time.
   *
   * @param {boolean} [force] ignore the cached value
   * @returns {Promise<{ok:boolean, version:number|null, error?:string}>}
   */
  async getOrderVersion(force = false) {
    if (!force && this._orderVersion !== undefined) return { ok: true, version: this._orderVersion };
    try {
      const r = await getJson(`${this.endpoints.clob}/version`);
      // A missing field means "2" — the same default the official client uses.
      const version = r && Number.isFinite(Number(r.version)) ? Number(r.version) : 2;
      this._orderVersion = version;
      return { ok: true, version };
    } catch (e) {
      return { ok: false, version: null, error: e.message };
    }
  }
}

module.exports = {
  ClobClient,
  estimateBuyFill,
  estimateSellFill,
  getJson,
  normaliseBook,
  ORDER_VERSION_MISMATCH,
  SIGNED_ORDER_VERSION,
};
