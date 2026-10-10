'use strict';
/**
 * Reference prices — the settlement-relevant series.
 *
 * PRIORITY 1 (authoritative): PolyBolt `price.crypto.twap`
 *   wss://ws-live-v2.polymarket.com/ws
 *   auth:    {"op":"auth","auth":{"apiKey","secret","passphrase"}}   (CLOB creds)
 *   sub:     {"op":"subscribe","subscriptions":[{"channel":"price.crypto.twap",
 *                                                 "filter":{"symbol":"btcusd","window_seconds":60}}]}
 *   frames:  {"v":1,"channel","seq","ts","snapshot"?,"dropped"?,"payload"}
 *   payload: {symbol, value, full_accuracy_value, timestamp, window_seconds}
 *   This is the 60-second Chainlink TWAP stream the Up/Down markets settle on.
 *   The server pings every 25s (reply `{"op":"ping"}`); close codes are
 *   4001 auth, 4002 slow consumer, 4003 draining (reconnect), 4008 policy.
 *
 * PRIORITY 2 (fallback): Coinbase + Kraken spot, from which a *time-weighted*
 *   60-second average is synthesised. This is a proxy, not the settlement
 *   series — it is labelled as such everywhere it surfaces, and strategies run
 *   with a wider safety margin while it is in use.
 *
 * Both are always collected: PolyBolt supplies the settlement series, the spot
 * venues supply cross-venue divergence and short-horizon volatility.
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { VolatilityTracker, trailingTwap } = require('./pricing');

class ReferencePrice extends EventEmitter {
  constructor(config, auth, { log = () => {} } = {}) {
    super();
    this.cfg = config;
    this.ref = config.reference;
    this.auth = auth;
    this.log = log;

    this.mode = config.runtime.referenceSource; // auto | polybolt | spot
    this.twap = { value: null, ts: 0, source: null, windowSeconds: 60, snapshot: false };
    this.spots = { coinbase: null, kraken: null };
    this.spotTs = { coinbase: 0, kraken: 0 };
    this.samples = { coinbase: [], kraken: [], blended: [] };
    this.tracker = new VolatilityTracker({
      lookbackSeconds: this.ref.volatilityLookbackSeconds,
      minVolPerSec: this.ref.minVolPerSec,
    });
    this.windowOpens = new Map(); // epochSeconds -> {twap, source, at, ...}
    this.twapHistory = [];       // [{t, value}] — bounded, for window-open backfill
    this.polybolt = { ws: null, authed: false, connected: false, lastError: null, seq: null, dropped: 0 };
    this.sockets = { coinbase: null, kraken: null };
    this.closedByUser = false;
  }

  start() {
    this.closedByUser = false;
    this.connectSpot('coinbase');
    this.connectSpot('kraken');
    if (this.mode !== 'spot') this.connectPolybolt();
  }

  stop() {
    this.closedByUser = true;
    for (const k of Object.keys(this.sockets)) {
      if (this.sockets[k]) this.sockets[k].close();
    }
    if (this.polybolt.ws) this.polybolt.ws.close();
  }

  // ------------------------------------------------------------- PolyBolt
  /**
   * (Re)attempt PolyBolt if it is down but now could be up.
   *
   * `connectPolybolt()` is only reached from `start()` and the socket close
   * handler, so a bot that was started before CLOB credentials existed never
   * tried again — it sat in SPOT PROXY (degraded) indefinitely even after
   * credentials were derived, until someone restarted the process. This is
   * called periodically so the authoritative feed picks itself up.
   *
   * @returns {boolean} true if a connection attempt was started.
   */
  ensurePolybolt() {
    if (this.closedByUser || this.mode === 'spot') return false;
    if (!this.auth || !this.auth.hasL2Credentials()) return false;
    // Already open or opening — nothing to do.
    const ws = this.polybolt.ws;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return false;
    // A 4001 means the credentials themselves were rejected; retrying on a
    // timer would just hammer the endpoint. Requires a credential change.
    if (this.polybolt.lastError && /4001|rejected/.test(this.polybolt.lastError)) return false;
    this.connectPolybolt();
    return true;
  }

  connectPolybolt() {
    if (!this.auth || !this.auth.hasL2Credentials()) {
      this.polybolt.lastError = 'CLOB credentials unavailable — TWAP stream requires auth';
      if (this.mode === 'polybolt') this.log('WARN', '[ref:polybolt] no CLOB credentials; TWAP unavailable');
      return;
    }
    const url = this.cfg.endpoints.polyboltWs;
    this.log('INFO', `[ref:polybolt] connecting ${url}`);
    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    this.polybolt.ws = ws;

    ws.on('open', () => {
      this.polybolt.connected = true;
      const c = this.auth.getCredentials();
      ws.send(JSON.stringify({ op: 'auth', auth: { apiKey: c.apiKey, secret: c.apiSecret, passphrase: c.passphrase } }));
      ws.send(JSON.stringify({
        op: 'subscribe',
        subscriptions: [
          { channel: 'price.crypto.twap', filter: { symbol: this.cfg.market.symbol, window_seconds: this.ref.twapWindowSeconds } },
          { channel: 'price.crypto', filter: { symbol: this.cfg.market.symbol } },
        ],
      }));
      this.log('INFO', '[ref:polybolt] auth + subscribe sent (TWAP + spot)');
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (msg.op === 'auth' || msg.op === 'subscribed' || msg.op === 'ok') {
        this.polybolt.authed = msg.op !== 'auth' ? this.polybolt.authed : true;
        this.polybolt.lastError = null;
        this.emit('polybolt_ready');
        return;
      }
      if (msg.op === 'ping') { try { ws.send(JSON.stringify({ op: 'ping' })); } catch (_) {} return; }
      if (msg.op === 'error') {
        this.polybolt.lastError = `${msg.code || 'error'}: ${msg.message || ''}`;
        this.log('WARN', `[ref:polybolt] ${this.polybolt.lastError}`);
        return;
      }
      this.handlePolyboltFrame(msg);
    });

    ws.on('close', (code, reason) => {
      this.polybolt.connected = false;
      this.polybolt.authed = false;
      this.log('WARN', `[ref:polybolt] closed code=${code} ${reason ? reason.toString() : ''}`);
      if (this.closedByUser) return;
      if (code === 4001) {
        this.polybolt.lastError = 'auth rejected (4001) — check CLOB credentials';
        this.log('WARN', '[ref:polybolt] not reconnecting: credentials rejected');
        return; // don't hammer the endpoint with bad credentials
      }
      if (code === 4008) {
        this.polybolt.lastError = 'policy breach (4008) — check subscription counts/frame sizes';
      }
      const delay = code === 4003 ? 1500 + Math.random() * 3000 : 2000 + Math.random() * 3000;
      setTimeout(() => { if (!this.closedByUser) this.connectPolybolt(); }, delay);
    });

    ws.on('error', (err) => {
      this.polybolt.lastError = err.message;
      this.log('WARN', `[ref:polybolt] error: ${err.message}`);
    });
  }

  handlePolyboltFrame(msg) {
    const channel = msg.channel;
    const payload = msg.payload || {};
    if (msg.seq !== undefined && this.polybolt.seq !== null && msg.seq < this.polybolt.seq) {
      this.log('WARN', `[ref:polybolt] sequence regression ${msg.seq} < ${this.polybolt.seq}`);
    }
    if (msg.seq !== undefined) this.polybolt.seq = msg.seq;
    if (msg.dropped) this.polybolt.dropped += Number(msg.dropped) || 0;

    if (channel === 'price.crypto.twap') {
      const data = Array.isArray(payload.data) ? payload.data : null;
      if (data && data.length) {
        // Snapshot: seed with the freshest historical point.
        const last = data[data.length - 1];
        this.setTwap(parseFloat(last.value !== undefined ? last.value : last.full_accuracy_value), Number(last.timestamp), true);
      }
      const raw = payload.full_accuracy_value !== undefined ? payload.full_accuracy_value : payload.value;
      const v = parseFloat(raw);
      if (Number.isFinite(v)) this.setTwap(v, Number(payload.timestamp) || Date.now(), !!msg.snapshot);
      return;
    }
    if (channel === 'price.crypto') {
      const data = Array.isArray(payload.data) ? payload.data : null;
      if (data && data.length) {
        const last = data[data.length - 1];
        const v = parseFloat(last.value !== undefined ? last.value : last.full_accuracy_value);
        if (Number.isFinite(v)) this.setSpot('polybolt', v);
      }
      const raw = payload.full_accuracy_value !== undefined ? payload.full_accuracy_value : payload.value;
      const v = parseFloat(raw);
      if (Number.isFinite(v)) this.setSpot('polybolt', v);
    }
  }

  setTwap(value, timestampMs, snapshot = false) {
    if (!Number.isFinite(value)) return;
    const ts = timestampMs || Date.now();
    this.twap = { value, ts, source: 'polybolt-twap60', windowSeconds: this.ref.twapWindowSeconds, snapshot };
    const h = this.twapHistory;
    h.push({ t: ts, value });
    const cutoff = ts - 5 * 60 * 1000;
    while (h.length && h[0].t < cutoff) h.shift();
    this.twapHistory = h;
    this.emit('twap', this.twap);
  }

  // ------------------------------------------------------------ spot feeds
  connectSpot(venue) {
    const isCoinbase = venue === 'coinbase';
    const url = isCoinbase ? this.ref.coinbaseWs : this.ref.krakenWs;
    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    this.sockets[venue] = ws;

    ws.on('open', () => {
      if (isCoinbase) {
        ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: [this.ref.coinbaseProduct],
          channels: ['matches'],
        }));
      } else {
        ws.send(JSON.stringify({
          event: 'subscribe',
          pair: [this.ref.krakenPair],
          subscription: { name: 'trade' },
        }));
      }
      this.log('INFO', `[ref:${venue}] connected`);
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (isCoinbase) {
        if (msg.type === 'match' || msg.type === 'last_match') {
          this.setSpot('coinbase', parseFloat(msg.price), Date.parse(msg.time) || Date.now());
        }
      } else {
        if (Array.isArray(msg) && msg[1] && Array.isArray(msg[1]) && msg[2] === 'trade') {
          const trade = msg[1][0];
          if (trade && trade[0] !== undefined) this.setSpot('kraken', parseFloat(trade[0]));
        }
      }
    });

    ws.on('close', () => {
      this.log('WARN', `[ref:${venue}] closed`);
      if (this.closedByUser) return;
      setTimeout(() => { if (!this.closedByUser) this.connectSpot(venue); }, 2000 + Math.random() * 2000);
    });
    ws.on('error', (err) => this.log('WARN', `[ref:${venue}] error: ${err.message}`));
  }

  setSpot(venue, price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    this.spots[venue] = price;
    this.spotTs[venue] = ts;
    const arr = this.samples[venue] || (this.samples[venue] = []);
    arr.push({ t: ts, p: price });
    const cutoff = ts - this.ref.volatilityLookbackSeconds * 1000;
    while (arr.length && arr[0].t < cutoff) arr.shift();

    // Blended series drives volatility indicators when the TWAP feed is down.
    const blended = this.blendedSpot(ts);
    if (blended !== null) {
      const b = this.samples.blended;
      b.push({ t: ts, p: blended });
      while (b.length && b[0].t < cutoff) b.shift();
      this.tracker.add(blended, ts);
    }
    this.emit('spot', { venue, price, ts });
  }

  blendedSpot(ts = Date.now()) {
    const fresh = [];
    if (this.spots.coinbase !== null && ts - this.spotTs.coinbase < 5000) fresh.push(this.spots.coinbase);
    if (this.spots.kraken !== null && ts - this.spotTs.kraken < 5000) fresh.push(this.spots.kraken);
    if (!fresh.length) return null;
    return fresh.reduce((a, b) => a + b, 0) / fresh.length;
  }

  // --------------------------------------------------------------- accessors
  /** Traffic-light: is the authoritative settlement series live? */
  twapIsAuthoritative(maxAgeMs = 15000) {
    return this.twap.source === 'polybolt-twap60' && (Date.now() - this.twap.ts) < maxAgeMs;
  }

  /**
   * The 60s TWAP used by the pricing model.
   * Returns {value, source, authoritative, ageMs}.
   */
  getTwap() {
    if (this.twapIsAuthoritative()) {
      return { value: this.twap.value, source: 'polybolt-twap60', authoritative: true, ageMs: Date.now() - this.twap.ts };
    }
    const now = Date.now();
    const synth = trailingTwap(this.samples.blended, this.ref.twapWindowSeconds, now);
    if (synth === null) return { value: null, source: null, authoritative: false, ageMs: null };
    const oldest = this.samples.blended.length ? this.samples.blended[0].t : now;
    const coverage = Math.min(1, (now - oldest) / (this.ref.twapWindowSeconds * 1000));
    return { value: synth, source: 'spot-proxy-twap60', authoritative: false, ageMs: 0, coverage };
  }

  getSpot() {
    return { value: this.blendedSpot(), venues: { ...this.spots }, ts: { ...this.spotTs } };
  }

  getVolatilityPerSec() {
    return this.tracker.perSecond();
  }

  /**
   * The 60s TWAP at a window's open instant ("price to beat").
   * Recorded live when a window opens; for windows that began before startup we
   * backfill from available history when coverage allows.
   */
  observeWindow(epochSeconds, windowSeconds) {
    const key = String(epochSeconds);
    const cached = this.windowOpens.get(key);
    // A settled answer (a value, or a recorded reason why there is none) is
    // final. A null value is *not* cached, so a feed that was not up yet by the
    // time the window opened gets another chance on the next discovery pass.
    if (cached && (cached.twap !== null && cached.twap !== undefined)) return cached;
    if (cached && cached.reason) return cached;

    const now = Date.now();
    const openMs = epochSeconds * 1000;
    const graceMs = Math.max(0, Number(this.ref.windowOpenGraceSeconds ?? 30)) * 1000;
    const entry = { epoch: epochSeconds, at: now, twap: null };

    if (now >= openMs && now - openMs < graceMs) {
      // Window is opening / just opened: stamp the live TWAP as the price to
      // beat. The error grows with how late we are, which is why the grace is
      // small (WINDOW_OPEN_GRACE_SECONDS, default 30).
      const t = this.getTwap();
      if (t.value === null || t.value === undefined) return entry; // no feed yet: retry next cycle
      entry.twap = t.value;
      entry.source = t.source;
      entry.authoritative = !!t.authoritative;
      entry.lateSnapshotSeconds = +((now - openMs) / 1000).toFixed(1);
      this.windowOpens.set(key, entry);
      this.emit('window_open', entry);
      return entry;
    }

    if (now >= openMs) {
      // The window opened before this pass. Reconstruct the price to beat from
      // the best history available, in order of quality:
      //   1. the authoritative TWAP series, if we stamped it around the open
      //      (e.g. discovery was late but the feed was already running);
      //   2. a time-weighted 60s average of the spot samples, if they cover the
      //      open (the proxy series);
      //   3. otherwise the window is not tradeable — record why, once.
      const hist = this.twapHistory;
      let twap = null;
      let source = null;
      let authoritative = false;
      if (hist.length) {
        let lastBefore = null;
        for (const h of hist) { if (h.t <= openMs) lastBefore = h; else break; }
        if (lastBefore && (openMs - lastBefore.t) <= 2000) {
          twap = lastBefore.value;
          source = 'polybolt-twap60@backfill';
          authoritative = true;
        }
      }
      if (twap === null) {
        const synth = trailingTwap(this.samples.blended, this.ref.twapWindowSeconds, openMs);
        const oldest = this.samples.blended.length ? this.samples.blended[0].t : null;
        if (synth !== null && oldest !== null && oldest < openMs) {
          twap = synth;
          source = 'spot-proxy-twap60@backfill';
          authoritative = false;
        }
      }
      if (twap !== null) {
        entry.twap = twap;
        entry.source = source;
        entry.authoritative = authoritative;
        entry.backfilled = true;
        this.windowOpens.set(key, entry);
        this.emit('window_open', entry);
        return entry;
      }
      entry.twap = null;
      entry.source = null;
      entry.authoritative = false;
      entry.reason = `the price to beat was not recorded: the window opened ${Math.round((now - openMs) / 1000)}s `
        + `before the bot could observe it (grace ${graceMs / 1000}s) — this window cannot be traded`;
      this.windowOpens.set(key, entry);
      this.emit('window_open', entry);
      return entry;
    }
    return entry; // future window: nothing recorded yet
  }

  getWindowOpen(epochSeconds) {
    return this.windowOpens.get(String(epochSeconds)) || null;
  }

  health() {
    const t = this.getTwap();
    const now = Date.now();
    return {
      twapSource: t.source,
      twapAuthoritative: !!t.authoritative,
      twapAgeMs: t.ageMs,
      twapCoverage: t.coverage,
      twap: t.value,
      spot: this.blendedSpot(),
      coinbase: { price: this.spots.coinbase, ageMs: now - this.spotTs.coinbase, samples: this.samples.coinbase.length },
      kraken: { price: this.spots.kraken, ageMs: now - this.spotTs.kraken, samples: this.samples.kraken.length },
      polybolt: { connected: this.polybolt.connected, authed: this.polybolt.authed, lastError: this.polybolt.lastError, dropped: this.polybolt.dropped },
      volPerSec: this.getVolatilityPerSec(),
      momentum1mUsd: this.tracker.momentumUsd(60),
      rsi14: this.tracker.rsi(14, 5000),
      mode: this.mode,
    };
  }
}

module.exports = { ReferencePrice };
