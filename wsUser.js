'use strict';
/**
 * CLOB private (user) WebSocket client.
 *
 *   wss://ws-subscriptions-clob.polymarket.com/ws/user
 *
 *  - the subscription frame carries the L2 credentials inline:
 *      {"auth":{"apiKey":…,"secret":…,"passphrase":…},"type":"user"}
 *  - subsequent dynamic subscriptions use condition IDs (not asset IDs):
 *      {"operation":"subscribe","markets":["0x<conditionId>"]}
 *  - unauthenticated connections are closed with 1008 "authentication failed"
 *  - emits `order` and `trade` events used to reconcile fills
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');

const HEARTBEAT_MS = 10000;

function pick(obj, ...keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/**
 * Condition ids are stringified before they reach the socket, so a missing id
 * becomes the literal string "undefined" or "null" rather than something
 * falsy. Filtering after String() therefore cannot drop them — the old guard
 * `m && m !== 'undefined'` let "null" straight through to the subscribe frame.
 * Drop the empty values first, then stringify.
 */
function normaliseConditionIds(ids) {
  return (ids || [])
    .filter((m) => m !== null && m !== undefined && m !== '' && m !== 'undefined' && m !== 'null')
    .map(String)
    .filter(Boolean);
}

class UserStream extends EventEmitter {
  constructor(config, auth, { log = () => {} } = {}) {
    super();
    this.cfg = config;
    this.url = config.endpoints.userWs;
    this.auth = auth;
    this.log = log;
    this.ws = null;
    this.markets = new Set();
    this.orders = new Map();  // orderId -> normalised order
    this.trades = [];
    this.authenticated = false;
    this.lastMessageAt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    this.lastError = null;
  }

  setMarkets(conditionIds) {
    const next = new Set(normaliseConditionIds(conditionIds));
    const changed = next.size !== this.markets.size || [...next].some(m => !this.markets.has(m));
    this.markets = next;
    if (changed && this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
      // `this.markets` is a Set — spread before filtering. Calling .filter() on
      // the Set itself throws "this.markets.filter is not a function", which
      // surfaced as a `discovery:` error because setMarkets() is called from
      // refreshMarkets().
      this.subscribe([...this.markets]);
    }
  }

  connect() {
    if (!this.auth || !this.auth.hasL2Credentials()) {
      this.lastError = 'no L2 credentials — user stream disabled';
      return false;
    }
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return true;
    this.log('INFO', `[ws:user] connecting ${this.url}`);
    this.ws = new WebSocket(this.url, { handshakeTimeout: 15000 });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      const creds = this.auth.getCredentials();
      this.ws.send(JSON.stringify({
        auth: { apiKey: creds.apiKey, secret: creds.apiSecret, passphrase: creds.apiPassphrase },
        type: 'user',
      }));
      this.authenticated = true;
      this.startHeartbeat();
      this.log('INFO', '[ws:user] auth frame sent');
      this.emit('open');
      const ids = [...this.markets];
      if (ids.length) this.subscribe(ids);
    });

    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('error', (err) => {
      this.lastError = err.message;
      this.log('WARN', `[ws:user] error: ${err.message}`);
      this.emit('error', err);
    });
    this.ws.on('close', (code, reason) => {
      this.stopHeartbeat();
      this.authenticated = false;
      const r = reason ? reason.toString() : '';
      this.log('WARN', `[ws:user] closed code=${code} ${r}`);
      if (code === 1008) this.lastError = `authentication failed: ${r || 'check L2 credentials'}`;
      this.emit('close', { code, reason: r });
      if (!this.closedByUser) this.scheduleReconnect();
    });
    return true;
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
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  subscribe(conditionIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const markets = conditionIds.map(String).filter(Boolean);
    if (!markets.length) return;
    this.ws.send(JSON.stringify({ operation: 'subscribe', markets }));
    this.log('INFO', `[ws:user] subscribed to ${markets.length} market(s)`);
  }

  unsubscribe(conditionIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ operation: 'unsubscribe', markets: conditionIds.map(String) }));
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

  handleMessage(raw) {
    const text = raw.toString();
    this.lastMessageAt = Date.now();
    if (text === 'PONG' || text === 'pong') { this.emit('pong'); return; }
    if (text === '{}') { // server ping — answer with an empty frame
      try { this.ws.send('{}'); } catch (_) {}
      return;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && !parsed.event_type && Object.keys(parsed).length === 0) {
      try { this.ws.send('{}'); } catch (_) {}
      return;
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of events) this.handleEvent(ev);
  }

  handleEvent(ev) {
    const type = pick(ev, 'event_type', 'type');
    if (type === 'order') {
      const order = {
        id: pick(ev, 'id'),
        conditionId: pick(ev, 'market'),
        tokenId: String(pick(ev, 'asset_id', 'assetId') || ''),
        side: pick(ev, 'side'),
        price: parseFloat(pick(ev, 'price')),
        originalSize: parseFloat(pick(ev, 'original_size', 'originalSize')),
        sizeMatched: parseFloat(pick(ev, 'size_matched', 'sizeMatched')),
        outcome: pick(ev, 'outcome'),
        status: pick(ev, 'status'),
        orderType: pick(ev, 'order_type', 'orderType'),
        eventType: pick(ev, 'type'),
        createdAt: pick(ev, 'created_at', 'createdAt'),
        makerAddress: pick(ev, 'maker_address', 'makerAddress'),
        associateTrades: pick(ev, 'associate_trades', 'associateTrades'),
      };
      if (order.id) this.orders.set(order.id, order);
      this.emit('order', order);
      return;
    }
    if (type === 'trade') {
      const trade = {
        id: pick(ev, 'id'),
        takerOrderId: pick(ev, 'taker_order_id', 'takerOrderId'),
        conditionId: pick(ev, 'market'),
        tokenId: String(pick(ev, 'asset_id', 'assetId') || ''),
        side: pick(ev, 'side'),
        size: parseFloat(pick(ev, 'size')),
        price: parseFloat(pick(ev, 'price')),
        status: pick(ev, 'status'),
        feeRateBps: parseFloat(pick(ev, 'fee_rate_bps', 'feeRateBps')),
        outcome: pick(ev, 'outcome'),
        traderSide: pick(ev, 'trader_side', 'traderSide'),
        transactionHash: pick(ev, 'transaction_hash', 'transactionHash'),
        matchTime: pick(ev, 'match_time', 'matchTime'),
        makerOrders: pick(ev, 'maker_orders', 'makerOrders') || [],
        timestamp: pick(ev, 'timestamp'),
      };
      this.trades.unshift(trade);
      if (this.trades.length > 500) this.trades.pop();
      this.emit('trade', trade);
      return;
    }
    this.emit('unknown', ev);
  }

  isFresh(maxAgeMs = 60000) {
    return this.lastMessageAt > 0 && (Date.now() - this.lastMessageAt) < maxAgeMs;
  }

  getStatus() {
    return {
      running: !!this.ws,
      authenticated: this.authenticated,
      markets: [...this.markets],
      openOrders: [...this.orders.values()],
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt || null,
    };
  }
}

module.exports = { UserStream };
