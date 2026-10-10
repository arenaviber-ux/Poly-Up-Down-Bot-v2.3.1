'use strict';
/**
 * Strategy engine — 8 modules, all rebuilt around the settlement series.
 *
 * Every module now shares the same corrected foundations:
 *   1. probabilities come from the 60-second TWAP model (pricing.fairProbUp),
 *      never from "spot at entry"
 *   2. edges are computed against the ASK you would actually pay, and are NET
 *      of the market's published taker fee (crypto fee rate 0.07, peak 1.75c
 *      per share at 50c)
 *   3. every module has an explicit time window inside the 5/15-minute market
 *      and refuses to trade when the book is too thin or the spread too wide
 *   4. when the TWAP feed is unavailable and the bot is running on the
 *      spot-proxy average, thresholds are automatically widened and the signal
 *      is flagged `degraded`
 *
 * The dashboard, config.js and this engine use slightly different names for
 * some modules; `resolveStrategyKey()` reconciles them so a toggle is never
 * dropped for a spelling mismatch.
 */
const { netEdgePerShare, breakEvenProb, entryEdgeTest } = require('./pricing');

/**
 * Key aliases.
 *
 * The dashboard, config.js and this engine historically used three different
 * names for some modules, and a mismatch meant a toggle was silently dropped
 * (`if (this.strategies[key])` simply skipped it). Every incoming key is now
 * resolved through this table, so any of the accepted spellings works.
 */
const STRATEGY_ALIASES = {
  latencyExploitation: ['latencyExploitation', 'latencyExploit', 'latency', 'twapMomentum', 'twap_momentum', 'momentum'],
  lateWindowConvergence: ['lateWindowConvergence', 'lateWindow', 'lwc'],
  microstructure: ['microstructure', 'microstructureEdges', 'microstructure_edges', 'bookMicrostructure'],
  rsiReversion: ['rsiReversion', 'rsi', 'rsiTrendReversion'],
  fairValueEv: ['fairValueEv', 'fairValue', 'fair_value_ev', 'fv'],
  crossExchange: ['crossExchange', 'crossExchangeDivergence', 'crossVenue', 'cross_venue', 'xex'],
  volatilityBreakout: ['volatilityBreakout', 'volBreakout', 'vb'],
  staleQuoteSnipe: ['staleQuoteSnipe', 'staleSnipe', 'sqs'],
};

function normaliseKey(k) {
  return String(k === undefined || k === null ? '' : k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ALIAS_INDEX = (() => {
  const idx = new Map();
  for (const [canonical, aliases] of Object.entries(STRATEGY_ALIASES)) {
    idx.set(normaliseKey(canonical), canonical);
    for (const a of aliases) idx.set(normaliseKey(a), canonical);
  }
  return idx;
})();

/** Resolve any accepted spelling of a strategy key to its canonical name. */
function resolveStrategyKey(key) {
  return ALIAS_INDEX.get(normaliseKey(key)) || null;
}

class StrategyEngine {
  constructor(config, { log = () => {} } = {}) {
    this.cfg = config;
    this.log = log;
    this.strategies = {
      latencyExploitation: { enabled: true, name: 'TWAP Momentum (was: Latency Exploitation)' },
      lateWindowConvergence: { enabled: true, name: 'Late Window Convergence' },
      microstructure: { enabled: true, name: 'Book Microstructure' },
      rsiReversion: { enabled: true, name: 'RSI Reversion' },
      fairValueEv: { enabled: true, name: 'Fair-Value EV' },
      crossExchange: { enabled: true, name: 'Cross-Venue Divergence' },
      volatilityBreakout: { enabled: true, name: 'Volatility Breakout' },
      staleQuoteSnipe: { enabled: true, name: 'Stale-Quote Snipe' },
    };
    // Config may use the canonical name or any alias, so TWAP_MOMENTUM_* /
    // `twapMomentum.enabled` correctly drives `latencyExploitation`.
    for (const key of Object.keys(this.strategies)) {
      const names = STRATEGY_ALIASES[key] || [key];
      let c = null;
      for (const n of names) {
        const candidate = config.strategies && config.strategies[n];
        if (candidate && candidate.enabled !== undefined) { c = candidate; break; }
      }
      if (c) this.strategies[key].enabled = !!c.enabled;
    }
    this.stats = {};
    for (const key of Object.keys(this.strategies)) {
      this.stats[key] = { evaluated: 0, fired: 0, lastReason: null, lastFireAt: null };
    }
    // The time-to-expiry floor that actually applies to each module:
    // max(module setting, risk.minSecondsToExpiry). Surfaced through
    // getState() so the dashboard shows the clamp instead of the raw setting.
    this.effectiveFloors = {};
    for (const key of Object.keys(this.strategies)) {
      const c = this.configFor(key);
      const configured = c && Number.isFinite(c.minEntrySecondsLeft) ? c.minEntrySecondsLeft : null;
      this.effectiveFloors[key] = {
        configuredMinSecondsLeft: configured,
        effectiveMinSecondsLeft: configured === null
          ? this.cfg.risk.minSecondsToExpiry
          : Math.max(configured, this.cfg.risk.minSecondsToExpiry),
        minSecondsClamped: configured !== null && configured < this.cfg.risk.minSecondsToExpiry,
      };
    }
    this.lastSignals = [];
  }

  /**
   * Apply a settings patch. Each entry may be either a boolean or an object:
   *
   *   { fairValueEv: false }                  boolean form
   *   { fairValueEv: { enabled: false } }     object form (what the dashboard sends)
   *
   * The previous implementation did `enabled = !!val`, and since `!!{...}` is
   * `true` for ANY object, the object form always wrote `true` — so a module
   * could never be turned off. Both shapes are now handled explicitly, and
   * unrecognised keys are reported instead of being silently ignored.
   *
   * @returns {{applied: Array<{key:string,name:string,enabled:boolean}>, unknown: string[]}}
   */
  updateConfig(patch = {}) {
    const applied = [];
    const unknown = [];
    for (const [rawKey, val] of Object.entries(patch || {})) {
      const key = resolveStrategyKey(rawKey);
      if (!key) { unknown.push(String(rawKey)); continue; }

      let enabled;
      if (val && typeof val === 'object' && !Array.isArray(val)) enabled = val.enabled;
      else enabled = val;

      if (enabled === undefined || enabled === null) { unknown.push(String(rawKey)); continue; }

      this.strategies[key].enabled = !!enabled;
      applied.push({ key, name: this.strategies[key].name, enabled: !!enabled });
    }
    return { applied, unknown };
  }

  /** Turn a single module on/off. Returns false if the key is unknown. */
  setEnabled(key, enabled) {
    const k = resolveStrategyKey(key);
    if (!k) return false;
    this.strategies[k].enabled = !!enabled;
    return true;
  }

  /** Canonical key -> enabled, for persistence. */
  enabledMap() {
    const out = {};
    for (const [k, v] of Object.entries(this.strategies)) out[k] = !!v.enabled;
    return out;
  }

  /** Restore persisted enabled flags (tolerates old/aliased state files). */
  setEnabledMap(map = {}) {
    for (const [k, v] of Object.entries(map || {})) {
      const key = resolveStrategyKey(k);
      if (!key) continue;
      const enabled = (v && typeof v === 'object' && !Array.isArray(v)) ? v.enabled : v;
      if (enabled === undefined || enabled === null) continue;
      this.strategies[key].enabled = !!enabled;
    }
  }

  getState() {
    const out = {};
    for (const [key, s] of Object.entries(this.strategies)) {
      out[key] = { ...s, ...this.stats[key], ...(this.effectiveFloors[key] || {}) };
    }
    return out;
  }

  // ------------------------------------------------------------- utilities
  /**
   * Config block for a canonical module key (alias-tolerant), used for the
   * effective-floor bookkeeping below.
   */
  configFor(key) {
    const names = STRATEGY_ALIASES[key] || [key];
    for (const name of names) {
      const c = this.cfg.strategies && this.cfg.strategies[name];
      if (c) return c;
    }
    return null;
  }

  /**
   * Common preflight: enough liquidity, sane spread, a live reference series
   * and a sane amount of time left in the window. Book-level checks pass when
   * at least one side of the market is tradeable; `candidate()` then enforces
   * the per-side price, depth and edge rules.
   */
  preflight(ctx, { minSecondsLeft = 10, maxSecondsLeft = Infinity } = {}) {
    const { market, model } = ctx;
    if (!market || !market.tradeable) return { ok: false, reason: 'market not tradeable' };
    const left = market.remainingSec;
    const floor = Math.max(minSecondsLeft, this.cfg.risk.minSecondsToExpiry);
    if (left < floor) {
      // No module may trade closer to expiry than the account-wide
      // MIN_SECONDS_TO_EXPIRY, whatever its own setting says. Name both numbers
      // so a clamp (SQS_MIN_LEFT=8 under MIN_SECONDS_TO_EXPIRY=10) is visible
      // instead of looking like the module's own gate.
      const clamp = minSecondsLeft < this.cfg.risk.minSecondsToExpiry
        ? `; module floor ${minSecondsLeft}s is clamped by MIN_SECONDS_TO_EXPIRY=${this.cfg.risk.minSecondsToExpiry}s`
        : '';
      return { ok: false, reason: `only ${left.toFixed(0)}s left (need ≥${floor}s${clamp})` };
    }
    if (left > maxSecondsLeft) return { ok: false, reason: `${left.toFixed(0)}s left > max ${maxSecondsLeft}s` };

    const books = [ctx.books && ctx.books.up, ctx.books && ctx.books.down].filter(Boolean);
    if (!books.length) return { ok: false, reason: 'no book data' };

    const askCap = this.cfg.order.maxBuyPrice;
    const reasons = [];
    const tradeable = books.some((book) => {
      if (book.bestAsk === null || book.bestAsk === undefined) { reasons.push('no ask liquidity'); return false; }
      if (book.spread !== null && book.spread * 100 > this.cfg.risk.maxSpreadCents) {
        reasons.push(`spread ${(book.spread * 100).toFixed(1)}c > ${this.cfg.risk.maxSpreadCents}c`);
        return false;
      }
      if (book.askDepthUsd < this.cfg.risk.minBookDepthUsd) {
        reasons.push(`ask depth $${book.askDepthUsd.toFixed(0)} < $${this.cfg.risk.minBookDepthUsd}`);
        return false;
      }
      if (book.bestAsk > askCap) { reasons.push(`ask ${book.bestAsk} > cap ${askCap}`); return false; }
      return true;
    });
    if (!tradeable) return { ok: false, reason: reasons[0] || 'no tradeable side' };
    if (!model || !Number.isFinite(model.pUp)) return { ok: false, reason: 'no fair-value model' };
    return { ok: true };
  }

  /**
   * Build a candidate order for one side, net of fees.
   *
   * Returns a signal object (with `.signal`) when the side is tradeable, or an
   * object carrying a `reason` when it is not — the reason is what the
   * dashboard shows, so it is never thrown away.
   *
   * The spread, depth and price-cap checks live here, per side, rather than
   * only in `preflight()`: preflight passes as soon as *one* side of the market
   * is tradeable, so a module could previously buy a side with a 10c spread and
   * a few dollars of depth simply because the other side looked healthy.
   */
  candidate(ctx, side, { minNetEdge, reason, degraded = false }) {
    const book = side === 'UP' ? ctx.books.up : ctx.books.down;
    const prob = side === 'UP' ? ctx.model.pUp : ctx.model.pDown;
    if (!book) return { reason: `no ${side} book` };
    if (book.bestAsk === null || book.bestAsk === undefined) return { reason: `no ask offered on ${side}` };
    const price = book.bestAsk;
    if (price > this.cfg.order.maxBuyPrice) {
      return { reason: `${side} ask ${(price * 100).toFixed(1)}c above MAX_BUY_PRICE ${(this.cfg.order.maxBuyPrice * 100).toFixed(0)}c` };
    }
    if (book.spread !== null && book.spread !== undefined && book.spread * 100 > this.cfg.risk.maxSpreadCents) {
      return { reason: `${side} spread ${(book.spread * 100).toFixed(1)}c > ${this.cfg.risk.maxSpreadCents}c` };
    }
    if (Number.isFinite(book.askDepthUsd) && book.askDepthUsd < this.cfg.risk.minBookDepthUsd) {
      return { reason: `${side} ask depth $${book.askDepthUsd.toFixed(0)} < $${this.cfg.risk.minBookDepthUsd}` };
    }
    if (!Number.isFinite(prob)) return { reason: `no model probability for ${side}` };

    // One edge test, at the price we would actually pay. This used to run at the
    // ask against the module's own threshold, and then botCore re-ran it at
    // ask + slippage against the GLOBAL MIN_NET_EDGE — two gates, two prices, two
    // thresholds, so a module could fire and place nothing. `entryEdgeTest` is
    // shared with the execution path so the two cannot disagree.
    const t = entryEdgeTest({
      prob,
      bestAsk: price,
      tickSize: (ctx.constraints && ctx.constraints.tickSize) || this.cfg.order.tickSize,
      maxSlippageCents: this.cfg.order.maxSlippageCents,
      maxBuyPrice: this.cfg.order.maxBuyPrice,
      feeSchedule: ctx.feeSchedule,
      moduleMinNetEdge: minNetEdge,
      globalMinNetEdge: this.cfg.fees.minNetEdge,
      degraded,
    });
    if (!t.ok) {
      // Name the binding threshold. Under the shipped values SQS's own 1c gate
      // is always shadowed by MIN_NET_EDGE=1.5c, and saying "net edge < 1.50c"
      // without saying whose 1.50c it is reads like the module's own gate.
      const who = t.limitedBy === 'global'
        ? `MIN_NET_EDGE floor ${(t.effectiveMinNetEdge * 100).toFixed(2)}c`
        : `module gate ${(t.effectiveMinNetEdge * 100).toFixed(2)}c${degraded ? ' (degraded: 1.5x)' : ''}`;
      return {
        reason: `${side} net edge ${(t.netEdge * 100).toFixed(2)}c at the executable price `
          + `(${(price * 100).toFixed(1)}c ask + ${this.cfg.order.maxSlippageCents}c = ${(t.executablePrice * 100).toFixed(1)}c) `
          + `below the ${who}`,
      };
    }
    return {
      signal: side === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      side,
      prob,
      price,
      // `edge` is now the edge at the executable price — the number that decided
      // the signal, and the one that ranks alternatives against each other.
      // `edgeAtAsk` is kept for reporting, since that is what the dashboard's
      // per-module counters have always shown.
      edge: t.netEdge,
      edgeAtAsk: t.netEdgeAtAsk,
      executionPrice: t.executablePrice,
      effectiveMinNetEdge: t.effectiveMinNetEdge,
      edgeLimitedBy: t.limitedBy,
      breakEven: breakEvenProb(price, ctx.feeSchedule),
      reason,
      degraded,
    };
  }

  /**
   * Pick whichever side offers the larger net edge, above the threshold.
   * Returns a signal object, or `{ reason }` naming why neither side qualified.
   */
  bestSide(ctx, { minNetEdge, reason, degraded = false, requireAbove = null }) {
    const up = this.candidate(ctx, 'UP', { minNetEdge, reason, degraded });
    const down = this.candidate(ctx, 'DOWN', { minNetEdge, reason, degraded });
    const pool = [up, down].filter(c => c && c.signal)
      .filter(c => (requireAbove === null ? true : c.prob >= requireAbove));
    if (!pool.length) {
      const rejects = [up, down].filter(c => c && c.reason).map(c => c.reason);
      return { reason: rejects.length ? rejects.join(' | ') : 'no side priced' };
    }
    pool.sort((a, b) => b.edge - a.edge);
    return pool[0];
  }

  // ------------------------------------------------------------ strategies
  /**
   * 1) TWAP Momentum (previously "Latency Exploitation").
   * Trades when the settlement series has moved decisively away from the price
   * to beat — measured in units of the remaining-window standard deviation —
   * and the market has not repriced yet. Spot prints alone are ignored.
   */
  latencyExploitation(ctx) {
    const c = this.cfg.strategies.twapMomentum;
    const pre = this.preflight(ctx, { minSecondsLeft: c.minEntrySecondsLeft, maxSecondsLeft: c.maxEntrySecondsLeft });
    if (!pre.ok) return { reason: pre.reason };
    if (!ctx.windowOpen || !Number.isFinite(ctx.windowOpen.twap)) return { reason: 'no price-to-beat recorded for this window' };
    const lead = ctx.model.drift; // E[W_close] - W_open
    const scale = ctx.model.sigmaWindow || 0;
    const multiple = scale > 0 ? Math.abs(lead) / scale : (Math.abs(lead) > 0 ? Infinity : 0);
    if (multiple < c.minLeadMultiple) return { reason: `lead ${multiple.toFixed(2)}σ < ${c.minLeadMultiple}σ` };
    const side = lead >= 0 ? 'UP' : 'DOWN';
    const cand = this.candidate(ctx, side, {
      minNetEdge: c.minNetEdge,
      reason: `${multiple.toFixed(2)}σ TWAP lead (${lead >= 0 ? '+' : ''}${lead.toFixed(2)} vs price to beat), market lagging`,
      degraded: ctx.degraded,
    });
    return cand.signal ? cand : { reason: cand.reason || `model edge below ${c.minNetEdge} after fees` };
  }

  /**
   * 2) Late Window Convergence.
   * In the final stretch the residual uncertainty is small, so a model
   * probability above `minProb` with a still-cheap ask is a clean convergence
   * trade. Requires the ask to remain below `maxPrice` so the fee stays small.
   */
  lateWindowConvergence(ctx) {
    const c = this.cfg.strategies.lateWindowConvergence;
    if (ctx.market.remainingSec > c.windowSeconds) return { reason: `not in final ${c.windowSeconds}s` };
    const pre = this.preflight(ctx, { minSecondsLeft: this.cfg.risk.minSecondsToExpiry });
    if (!pre.ok) return { reason: pre.reason };
    const side = ctx.model.pUp >= ctx.model.pDown ? 'UP' : 'DOWN';
    const prob = side === 'UP' ? ctx.model.pUp : ctx.model.pDown;
    if (prob < c.minProb) return { reason: `P=${(prob * 100).toFixed(1)}% < ${(c.minProb * 100).toFixed(0)}%` };
    const book = side === 'UP' ? ctx.books.up : ctx.books.down;
    if (!book) return { reason: `no ${side} book` };
    if (book.bestAsk === null || book.bestAsk === undefined) return { reason: `no ask offered on ${side}` };
    if (book.bestAsk > c.maxPrice) {
      return { reason: `${side} ask ${(book.bestAsk * 100).toFixed(1)}c above the ${(c.maxPrice * 100).toFixed(0)}c cap` };
    }
    const cand = this.candidate(ctx, side, {
      minNetEdge: c.minNetEdge,
      reason: `convergence: P=${(prob * 100).toFixed(1)}% with ${ctx.market.remainingSec.toFixed(0)}s left`,
      degraded: ctx.degraded,
    });
    return cand.signal ? cand : { reason: cand.reason || 'edge below threshold after fees' };
  }

  /**
   * 3) Book Microstructure.
   * Depth imbalance on the live book, but only in the direction the TWAP model
   * agrees with — in these markets order-flow alone is a timing signal, not a
   * thesis.
   */
  microstructure(ctx) {
    const c = this.cfg.strategies.microstructure;
    const pre = this.preflight(ctx, { minSecondsLeft: c.minEntrySecondsLeft });
    if (!pre.ok) return { reason: pre.reason };
    const b = ctx.books.up;
    if (!b || !b.bids.length || !b.asks.length) return { reason: 'empty book' };
    const bid = b.bidDepthUsd, ask = b.askDepthUsd;
    if (Math.min(bid, ask) < c.minDepthUsd) return { reason: `depth $${Math.min(bid, ask).toFixed(0)} < $${c.minDepthUsd}` };
    const ratio = bid / Math.max(ask, 1e-9);
    const side = ratio >= 1 ? 'UP' : 'DOWN';
    const imbalance = ratio >= 1 ? ratio : 1 / ratio;
    if (imbalance < c.minImbalance) return { reason: `imbalance ${imbalance.toFixed(2)} < ${c.minImbalance}` };
    const prob = side === 'UP' ? ctx.model.pUp : ctx.model.pDown;
    if (prob < 0.5) return { reason: `model disagrees with ${side} imbalance` };
    const cand = this.candidate(ctx, side, {
      minNetEdge: c.minNetEdge,
      reason: `${imbalance.toFixed(2)}x bid/ask depth imbalance with model agreement`,
      degraded: ctx.degraded,
    });
    return cand.signal ? cand : { reason: cand.reason || 'edge below threshold after fees' };
  }

  /**
   * 4) RSI Reversion.
   * RSI on the 5-second reference series. RSI extremes are only tradeable when
   * the TWAP model already leans the same way (a fast reversal cannot affect an
   * already-accrued 60s average much).
   */
  rsiReversion(ctx) {
    const c = this.cfg.strategies.rsiReversion;
    const pre = this.preflight(ctx, { minSecondsLeft: c.minEntrySecondsLeft });
    if (!pre.ok) return { reason: pre.reason };
    const rsi = ctx.ref.tracker.rsi(c.period, 5000);
    if (rsi === null) return { reason: 'insufficient reference history for RSI' };
    let side = null;
    if (rsi <= c.oversold) side = 'UP';
    else if (rsi >= c.overbought) side = 'DOWN';
    if (!side) return { reason: `RSI ${rsi.toFixed(0)} not extreme` };
    const prob = side === 'UP' ? ctx.model.pUp : ctx.model.pDown;
    if (prob < c.minModelProb) return { reason: `RSI ${rsi.toFixed(0)} but model P=${(prob * 100).toFixed(0)}% < ${(c.minModelProb * 100).toFixed(0)}%` };
    const cand = this.candidate(ctx, side, {
      minNetEdge: c.minNetEdge,
      reason: `RSI(14)=${rsi.toFixed(0)} reversion with TWAP model confirmation`,
      degraded: ctx.degraded,
    });
    return cand.signal ? cand : { reason: cand.reason || 'edge below threshold after fees' };
  }

  /**
   * 5) Fair-Value EV.
   * The workhorse: buy either side when the TWAP model prices it at least
   * `minNetEdge` above the ask after fees, provided the model probability is
   * beyond `minProb`.
   */
  fairValueEv(ctx) {
    const c = this.cfg.strategies.fairValueEv;
    const pre = this.preflight(ctx, { minSecondsLeft: c.minEntrySecondsLeft, maxSecondsLeft: c.maxEntrySecondsLeft });
    if (!pre.ok) return { reason: pre.reason };
    const cand = this.bestSide(ctx, {
      minNetEdge: c.minNetEdge,
      requireAbove: c.minProb,
      reason: 'fair value exceeds ask after fees',
      degraded: ctx.degraded,
    });
    // Report the threshold actually applied — in degraded mode that is 1.5x
    // the configured edge, and quoting the base number understates the bar.
    const required = ctx.degraded ? c.minNetEdge * 1.5 : c.minNetEdge;
    if (cand.signal) return cand;
    return { reason: `${cand.reason || 'no side priced'} — required ≥${(required * 100).toFixed(1)}c net edge${ctx.degraded ? ' (degraded: 1.5x)' : ''}` };
  }

  /**
   * 6) Cross-Venue Divergence.
   * Coinbase vs Kraken lead-lag: the staler venue (and the book) tends to catch
   * up to the fresher one. The direction is taken from the fresher venue, but
   * the trade only fires if the TWAP model agrees — otherwise a stale quote on
   * a venue that does not settle the market is a trap.
   */
  crossExchange(ctx) {
    const c = this.cfg.strategies.crossExchange;
    const pre = this.preflight(ctx, { minSecondsLeft: c.minEntrySecondsLeft });
    if (!pre.ok) return { reason: pre.reason };
    const cb = ctx.ref.spots.coinbase, kr = ctx.ref.spots.kraken;
    const cbTs = ctx.ref.spotTs.coinbase, krTs = ctx.ref.spotTs.kraken;
    if (!Number.isFinite(cb) || !Number.isFinite(kr)) return { reason: 'need both venues' };
    const now = Date.now();
    if (now - Math.min(cbTs, krTs) > c.maxStalenessMs) return { reason: 'a venue feed is stale' };
    const gap = cb - kr;
    if (Math.abs(gap) < c.minDivergenceUsd) return { reason: `divergence $${Math.abs(gap).toFixed(2)} < $${c.minDivergenceUsd}` };
    const fresherIsCoinbase = cbTs >= krTs;
    const side = (fresherIsCoinbase ? gap : -gap) >= 0 ? 'UP' : 'DOWN';
    const prob = side === 'UP' ? ctx.model.pUp : ctx.model.pDown;
    if (prob < c.minModelProb) return { reason: `$${Math.abs(gap).toFixed(0)} divergence but model P=${(prob * 100).toFixed(0)}%` };
    const cand = this.candidate(ctx, side, {
      minNetEdge: c.minNetEdge,
      reason: `${fresherIsCoinbase ? 'Coinbase' : 'Kraken'} leading by $${Math.abs(gap).toFixed(2)} with model agreement`,
      degraded: ctx.degraded,
    });
    return cand.signal ? cand : { reason: cand.reason || 'edge below threshold after fees' };
  }

  /**
   * 7) Volatility Breakout.
   * Bollinger burst on the reference series (90s lookback, kσ) confirmed by a
   * short thrust. Requires enough time left for the move to influence the
   * closing TWAP — a breakout with 20s left cannot move a 60s average much.
   */
  volatilityBreakout(ctx) {
    const c = this.cfg.strategies.volatilityBreakout;
    const pre = this.preflight(ctx, { minSecondsLeft: c.minEntrySecondsLeft, maxSecondsLeft: c.maxEntrySecondsLeft });
    if (!pre.ok) return { reason: pre.reason };
    const sd = ctx.ref.tracker.stdDevUsd(c.lookbackSeconds);
    if (sd === null) return { reason: 'insufficient history for bands' };
    const thrust = ctx.ref.tracker.momentumUsd(c.thrustSeconds);
    if (thrust === null) return { reason: 'insufficient thrust history' };
    const mean = ctx.ref.tracker.resampled(5000).slice(-1)[0];
    const price = ctx.ref.spot.value;
    if (!Number.isFinite(mean) || !Number.isFinite(price)) return { reason: 'no reference mean' };
    const upper = mean + c.sigmaMultiple * sd;
    const lower = mean - c.sigmaMultiple * sd;
    let side = null;
    if (price > upper && thrust > 0) side = 'UP';
    else if (price < lower && thrust < 0) side = 'DOWN';
    if (!side) return { reason: `price inside ${c.sigmaMultiple}σ bands` };
    const cand = this.candidate(ctx, side, {
      minNetEdge: c.minNetEdge,
      reason: `breakout beyond ${c.sigmaMultiple}σ with $${Math.abs(thrust).toFixed(2)}/{${c.thrustSeconds}s} thrust`,
      degraded: ctx.degraded,
    });
    return cand.signal ? cand : { reason: cand.reason || 'edge below threshold after fees' };
  }

  /**
   * 8) Stale-Quote Snipe.
   * Final seconds: buy near-certain outcomes that are still offered below
   * `maxPrice`. This is the only place where a 1-cent edge is meaningful,
   * because the fee at 93c is under half a cent per share.
   *
   * Note the target side must be *offered* at or below `maxPrice`: in the last
   * seconds of these windows the near-certain side is usually bid-but-not-
   * offered, and that is reported as such rather than as "ask above 0.93".
   */
  staleQuoteSnipe(ctx) {
    const c = this.cfg.strategies.staleQuoteSnipe;
    if (ctx.market.remainingSec > c.onlyLastSeconds) return { reason: `not final ${c.onlyLastSeconds}s` };
    const pre = this.preflight(ctx, { minSecondsLeft: c.minEntrySecondsLeft });
    if (!pre.ok) return { reason: pre.reason };
    const side = ctx.model.pUp >= ctx.model.pDown ? 'UP' : 'DOWN';
    const prob = side === 'UP' ? ctx.model.pUp : ctx.model.pDown;
    if (prob < c.minProb) return { reason: `P=${(prob * 100).toFixed(2)}% < ${(c.minProb * 100).toFixed(1)}%` };
    const book = side === 'UP' ? ctx.books.up : ctx.books.down;
    if (!book) return { reason: `no ${side} book` };
    if (book.bestAsk === null || book.bestAsk === undefined) return { reason: `no ask offered on ${side}` };
    if (book.bestAsk > c.maxPrice) {
      return { reason: `${side} ask ${(book.bestAsk * 100).toFixed(1)}c above the ${(c.maxPrice * 100).toFixed(0)}c cap` };
    }
    const cand = this.candidate(ctx, side, {
      minNetEdge: c.minNetEdge,
      reason: `snipe: P=${(prob * 100).toFixed(2)}% offered at ${(book.bestAsk * 100).toFixed(0)}c`,
      degraded: ctx.degraded,
    });
    return cand.signal ? cand : { reason: cand.reason || 'edge below threshold after fees' };
  }

  /**
   * Evaluate every enabled module against the current context. Returns the
   * highest-edge signal (all module outcomes are recorded for the dashboard).
   */
  evaluate(ctx) {
    const order = [
      'staleQuoteSnipe',
      'lateWindowConvergence',
      'latencyExploitation',
      'fairValueEv',
      'volatilityBreakout',
      'microstructure',
      'crossExchange',
      'rsiReversion',
    ];
    const results = [];
    for (const key of order) {
      const meta = this.strategies[key];
      if (!meta || !meta.enabled) continue;
      this.stats[key].evaluated++;
      let out = null;
      try {
        out = this[key](ctx);
      } catch (e) {
        out = { reason: `error: ${e.message}` };
      }
      const isSignal = out && out.signal;
      if (isSignal) {
        this.stats[key].fired++;
        this.stats[key].lastFireAt = new Date().toISOString();
        out.strategy = key;
        out.strategyName = meta.name;
      }
      this.stats[key].lastReason = out ? (out.reason || 'signal') : 'no result';
      results.push({ key, name: meta.name, signal: isSignal ? out : null, reason: out ? out.reason : null });
    }
    this.lastSignals = results;

    const signals = results.filter(r => r.signal).map(r => r.signal);
    if (!signals.length) return { signal: null, evaluations: results };
    signals.sort((a, b) => b.edge - a.edge);
    const best = signals[0];
    return { ...best, evaluations: results, alternatives: signals.slice(1) };
  }
}

module.exports = { StrategyEngine, STRATEGY_ALIASES, resolveStrategyKey };
