'use strict';
/**
 * CLOB market-data WebSocket client.
 *
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market      (no auth)
 *
 * Protocol notes (verified against the live socket):
 *  - subscribe with {"assets_ids":[tokenId,...],"type":"market","custom_feature_enabled":true}
 *  - application-level heartbeat: send the text frame `PING` every 10s; the
 *    server answers `PONG`
 *  - messages are ARRAYS of events keyed by `event_type` and use snake_case
 *    fields on the raw wire (event_type, asset_id, price_changes, best_bid,
 *    best_ask, fee_rate_bps) — not the camelCase shown in some doc samples
 *  - events: book, price_change, last_trade_price, tick_size_change,
 *    best_bid_ask, new_market, market_resolved
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { normaliseBook } = require('./clobClient');

const HEARTBEAT_MS = 10000;
const STALE_MS = 30000;

function pick(obj, ...keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

class MarketStream extends EventEmitter {
  constructor(config, { log = () => {} } = {}) {
    super();
    this.cfg = config;
    this.url = config.endpoints.marketWs;
    this.log = log;
    this.ws = null;
    this.assets = new Set();
    this.books = new Map();     // tokenId -> normalised book
    this.meta = new Map();      // tokenId -> {conditionId, tickSize, minOrderSize, negRisk}
    this.lastMessageAt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    this.lastError = null;
  }

  setAssets(tokenIds) {
    const next = new Set(tokenIds.map(String));
    const changed = next.size !== this.assets.size || [...next].some(a => !this.assets.has(a));
    this.assets = next;
    if (changed && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribe([...this.assets]);
    }
  }

  addAssets(tokenIds) {
    const before = this.assets.size;
    for (const t of tokenIds) this.assets.add(String(t));
    if (this.assets.size !== before && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribe([...this.assets]);
    }
  }

  connect() {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.log('INFO', `[ws:market] connecting ${this.url}`);
    this.ws = new WebSocket(this.url, { handshakeTimeout: 15000 });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.log('INFO', '[ws:market] connected');
      this.emit('open');
      if (this.assets.size) this.subscribe([...this.assets]);
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('pong', () => { this.lastMessageAt = Date.now(); });
    this.ws.on('error', (err) => {
      this.lastError = err.message;
      this.log('WARN', `[ws:market] error: ${err.message}`);
      this.emit('error', err);
    });
    this.ws.on('close', (code, reason) => {
      this.stopHeartbeat();
      this.log('WARN', `[ws:market] closed code=${code} reason=${reason ? reason.toString() : ''}`);
      this.emit('close', { code, reason: reason ? reason.toString() : '' });
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  disconnect() {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempts, 6)) + Math.random() * 250;
    this.log('INFO', `[ws:market] reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  subscribe(assetIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const frame = {
      assets_ids: assetIds.map(String),
      type: 'market',
      custom_feature_enabled: true,
    };
    this.ws.send(JSON.stringify(frame));
    this.log('INFO', `[ws:market] subscribed to ${assetIds.length} asset(s)`);
  }

  unsubscribe(assetIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ assets_ids: assetIds.map(String), operation: 'unsubscribe' }));
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send('PING'); } catch (_) {}
      }
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  isFresh(maxAgeMs = STALE_MS) {
    return this.lastMessageAt > 0 && (Date.now() - this.lastMessageAt) < maxAgeMs;
  }

  handleMessage(raw) {
    const text = raw.toString();
    this.lastMessageAt = Date.now();
    if (text === 'PONG') { this.emit('pong'); return; }

    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return; }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of events) this.handleEvent(ev);
  }

  handleEvent(ev) {
    const type = pick(ev, 'event_type', 'type');
    switch (type) {
      case 'book': return this.onBook(ev);
      case 'price_change': return this.onPriceChange(ev);
      case 'best_bid_ask': return this.onBestBidAsk(ev);
      case 'last_trade_price': return this.onLastTrade(ev);
      case 'tick_size_change': return this.onTickSizeChange(ev);
      case 'market_resolved': return this.onMarketResolved(ev);
      case 'new_market': return this.emit('new_market', ev);
      case 'subscribe':
      case 'unsubscribe': return;
      default:
        if (type) this.emit('unknown', ev);
    }
  }

  emptyBook(tokenId) {
    return {
      tokenId: String(tokenId), conditionId: null, bids: [], asks: [],
      bestBid: null, bestAsk: null, spread: null,
      bidDepthUsd: 0, askDepthUsd: 0, bidDepthShares: 0, askDepthShares: 0,
      minOrderSize: null, tickSize: null, negRisk: null, lastTradePrice: null,
      timestamp: Date.now(), hash: null, receivedAt: Date.now(),
    };
  }

  onBook(ev) {
    const tokenId = String(pick(ev, 'asset_id', 'assetId', 'tokenId'));
    const prev = this.books.get(tokenId) || this.emptyBook(tokenId);
    const book = normaliseBook({
      asset_id: tokenId,
      market: pick(ev, 'market'),
      bids: ev.bids || [],
      asks: ev.asks || [],
      min_order_size: pick(ev, 'min_order_size', 'minOrderSize') ?? prev.minOrderSize,
      tick_size: pick(ev, 'tick_size', 'tickSize') ?? prev.tickSize,
      neg_risk: pick(ev, 'neg_risk', 'negRisk') ?? prev.negRisk,
      last_trade_price: pick(ev, 'last_trade_price', 'lastTradePrice') ?? prev.lastTradePrice,
      timestamp: pick(ev, 'timestamp') || Date.now(),
      hash: pick(ev, 'hash'),
    });
    this.books.set(tokenId, book);
    this.meta.set(tokenId, {
      conditionId: book.conditionId,
      tickSize: book.tickSize,
      minOrderSize: book.minOrderSize,
      negRisk: book.negRisk,
    });
    this.emit('book', book);
  }

  onPriceChange(ev) {
    const changes = pick(ev, 'price_changes', 'priceChanges') || [];
    const conditionId = pick(ev, 'market') || null;
    const tickSize = pick(ev, 'tick_size', 'tickSize');
    const minOrderSize = pick(ev, 'min_order_size', 'minOrderSize');
    const negRisk = pick(ev, 'neg_risk', 'negRisk');
    const touched = [];
    for (const ch of changes) {
      const tokenId = String(pick(ch, 'asset_id', 'assetId', 'tokenId'));
      if (!tokenId || tokenId === 'undefined') continue;
      const book = this.books.get(tokenId) || this.emptyBook(tokenId);
      const price = parseFloat(pick(ch, 'price'));
      const size = parseFloat(pick(ch, 'size'));
      const side = String(pick(ch, 'side') || '').toUpperCase();
      if (!Number.isFinite(price) || !Number.isFinite(size)) continue;

      const levels = side === 'BUY' ? book.bids : book.asks;
      const idx = levels.findIndex(l => Math.abs(l.price - price) < 1e-9);
      if (size === 0) {
        if (idx >= 0) levels.splice(idx, 1);
      } else if (idx >= 0) {
        levels[idx].size = size;
      } else {
        levels.push({ price, size });
      }
      // The CLOB also publishes the resulting top of book with each change.
      const bb = pick(ch, 'best_bid', 'bestBid');
      const ba = pick(ch, 'best_ask', 'bestAsk');
      book.bids.sort((a, b) => b.price - a.price);
      book.asks.sort((a, b) => a.price - b.price);
      book.bestBid = bb !== undefined ? parseFloat(bb) : (book.bids[0] ? book.bids[0].price : null);
      book.bestAsk = ba !== undefined ? parseFloat(ba) : (book.asks[0] ? book.asks[0].price : null);
      book.spread = (book.bestBid !== null && book.bestAsk !== null) ? +(book.bestAsk - book.bestBid).toFixed(4) : null;
      book.bidDepthUsd = book.bids.reduce((a, b) => a + b.price * b.size, 0);
      book.askDepthUsd = book.asks.reduce((a, b) => a + b.price * b.size, 0);
      book.bidDepthShares = book.bids.reduce((a, b) => a + b.size, 0);
      book.askDepthShares = book.asks.reduce((a, b) => a + b.size, 0);
      if (conditionId) book.conditionId = conditionId;
      if (tickSize !== undefined) book.tickSize = parseFloat(tickSize);
      if (minOrderSize !== undefined) book.minOrderSize = parseFloat(minOrderSize);
      if (negRisk !== undefined) book.negRisk = !!negRisk;
      book.hash = pick(ch, 'hash') || book.hash;
      book.timestamp = pick(ev, 'timestamp') || Date.now();
      book.receivedAt = Date.now();
      this.books.set(tokenId, book);
      this.meta.set(tokenId, {
        conditionId: book.conditionId, tickSize: book.tickSize,
        minOrderSize: book.minOrderSize, negRisk: book.negRisk,
      });
      touched.push(book);
    }
    if (touched.length) this.emit('price_change', { books: touched, conditionId });
  }

  onBestBidAsk(ev) {
    const tokenId = String(pick(ev, 'asset_id', 'assetId', 'tokenId'));
    const book = this.books.get(tokenId) || this.emptyBook(tokenId);
    const bb = parseFloat(pick(ev, 'best_bid', 'bestBid'));
    const ba = parseFloat(pick(ev, 'best_ask', 'bestAsk'));
    if (Number.isFinite(bb)) book.bestBid = bb;
    if (Number.isFinite(ba)) book.bestAsk = ba;
    const spread = parseFloat(pick(ev, 'spread'));
    book.spread = Number.isFinite(spread)
      ? spread
      : ((book.bestBid !== null && book.bestAsk !== null) ? +(book.bestAsk - book.bestBid).toFixed(4) : null);
    book.receivedAt = Date.now();
    this.books.set(tokenId, book);
    this.emit('best_bid_ask', book);
  }

  onLastTrade(ev) {
    const tokenId = String(pick(ev, 'asset_id', 'assetId', 'tokenId'));
    const book = this.books.get(tokenId) || this.emptyBook(tokenId);
    const price = parseFloat(pick(ev, 'price'));
    if (Number.isFinite(price)) book.lastTradePrice = price;
    book.receivedAt = Date.now();
    this.books.set(tokenId, book);
    this.emit('last_trade_price', {
      tokenId,
      conditionId: pick(ev, 'market'),
      price,
      size: parseFloat(pick(ev, 'size')),
      side: pick(ev, 'side'),
      feeRateBps: parseFloat(pick(ev, 'fee_rate_bps', 'feeRateBps')),
      transactionHash: pick(ev, 'transaction_hash', 'transactionHash'),
      timestamp: pick(ev, 'timestamp'),
    });
  }

  onTickSizeChange(ev) {
    const tokenId = String(pick(ev, 'asset_id', 'assetId', 'tokenId'));
    const book = this.books.get(tokenId);
    const newTick = parseFloat(pick(ev, 'new_tick_size', 'newTickSize'));
    if (book && Number.isFinite(newTick)) book.tickSize = newTick;
    const meta = this.meta.get(tokenId);
    if (meta && Number.isFinite(newTick)) meta.tickSize = newTick;
    this.emit('tick_size_change', { tokenId, oldTickSize: parseFloat(pick(ev, 'old_tick_size', 'oldTickSize')), newTickSize: newTick });
  }

  onMarketResolved(ev) {
    const payload = {
      conditionId: pick(ev, 'market', 'condition_id', 'conditionId'),
      id: pick(ev, 'id'),
      tokenIds: pick(ev, 'token_ids', 'tokenIds') || pick(ev, 'clob_token_ids', 'clobTokenIds'),
      winningTokenId: pick(ev, 'winning_token_id', 'winningTokenId'),
      winningOutcome: pick(ev, 'winning_outcome', 'winningOutcome'),
      slug: ev.event_message ? pick(ev.event_message, 'slug') : pick(ev, 'slug'),
      timestamp: pick(ev, 'timestamp'),
    };
    this.emit('market_resolved', payload);
  }

  /** Snapshot from memory, with REST fallback handled by the caller. */
  getBook(tokenId) {
    return this.books.get(String(tokenId)) || null;
  }

  getMeta(tokenId) {
    return this.meta.get(String(tokenId)) || null;
  }
}

module.exports = { MarketStream };
