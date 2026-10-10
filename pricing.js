'use strict';
/**
 * Fair-value pricing for TWAP-settled crypto Up/Down markets.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These markets do not settle on the spot price. They settle on the *60-second
 * Chainlink TWAP* evaluated at two instants: the opening and the closing of the
 * window. A market resolves "Up" when
 *
 *        W_close  >=  W_open
 *
 * where W(x) is the 60-second trailing TWAP at instant x. The old bot compared
 * Coinbase/Kraken spot prices and used an "entry price" anchor, which is the
 * wrong series entirely (the market's own cryptoMarketConfig confirms
 * `{twapEnabled: true, twapLookbackSeconds: 60}`).
 *
 * THE MODEL
 * ---------
 * Let r = seconds remaining in the window, P_now the current reference price,
 * W_now the current trailing 60s TWAP and A = W_open ("price to beat").
 *
 * The closing TWAP averages the 60 one-second prints in [T-59, T]. Prints that
 * already happened inside that interval can be approximated from W_now; the
 * rest are unknown and are modelled as a random walk starting at P_now:
 *
 *   n_known   = max(0, 60 - r)
 *   n_unknown = 60 - n_known          ( = min(60, r) )
 *   E[W_close] = (n_known * W_now + n_unknown * P_now) / 60
 *   sd[W_close] = sigma_per_sec * sqrt(n_unknown / 3)     (variance of a
 *                 Brownian path average is sigma^2 * n / 3)
 *
 *   pUp = Phi( (E[W_close] - A) / sd[W_close] )
 *
 * Fee model (published per market via `feeSchedule`, currently
 * {rate: 0.07, exponent: 1, takerOnly: true} for crypto):
 *
 *   feePerShare = rate * p * (1 - p)
 *
 * i.e. the fee peaks at 50c and vanishes at the extremes. Every edge in this
 * bot is NET of fees.
 */

// ---------------------------------------------------------------- statistics
function normalCdf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ---------------------------------------------------------------------- fees
/**
 * @param {number} price trade price (0..1)
 * @param {{rate:number, exponent?:number}} feeSchedule
 * @returns {number} fee in USD per share
 */
function feePerShare(price, feeSchedule) {
  const rate = feeSchedule && Number.isFinite(feeSchedule.rate) ? feeSchedule.rate : 0;
  const exponent = feeSchedule && feeSchedule.exponent ? feeSchedule.exponent : 1;
  if (!(rate > 0)) return 0;
  const p = clamp(price, 0.0001, 0.9999);
  return rate * Math.pow(p, exponent) * Math.pow(1 - p, exponent);
}

/** Total fee in USD for `shares` at `price`. */
function feeTotal(shares, price, feeSchedule) {
  return shares * feePerShare(price, feeSchedule);
}

// ------------------------------------------------------------ fair value
/**
 * @param {object} p
 * @param {number} p.twapOpen        price to beat (60s TWAP at window open)
 * @param {number} p.twapNow         current trailing 60s TWAP
 * @param {number} p.priceNow        current reference (spot) price
 * @param {number} p.secondsLeft     seconds until window close
 * @param {number} p.sigmaPerSec     per-second volatility of the reference price (USD/sqrt(s))
 * @param {number} [p.twapWindow]    averaging window in seconds (default 60)
 * @param {number} [p.minSigmaPerSec]
 */
function fairProbUp({
  twapOpen, twapNow, priceNow, secondsLeft, sigmaPerSec,
  twapWindow = 60, minSigmaPerSec = 0.02,
}) {
  if (![twapOpen, twapNow, priceNow].every(Number.isFinite)) {
    return { pUp: null, reason: 'missing reference prices' };
  }
  const r = Math.max(0, secondsLeft);
  const nKnown = clamp(twapWindow - r, 0, twapWindow);
  const nUnknown = twapWindow - nKnown;

  const expectedClose = (nKnown * twapNow + nUnknown * priceNow) / twapWindow;
  const sigma = Math.max(sigmaPerSec || 0, minSigmaPerSec) * Math.sqrt(Math.max(nUnknown, 0) / 3);
  const drift = expectedClose - twapOpen;

  let pUp;
  if (r <= 0) {
    pUp = drift >= 0 ? 1 : 0;                       // window is over: it's decided
  } else if (!(sigma > 0)) {
    pUp = drift >= 0 ? 1 : 0;
  } else {
    pUp = normalCdf(drift / sigma);
  }
  return {
    pUp: clamp(pUp, 0, 1),
    pDown: clamp(1 - pUp, 0, 1),
    expectedCloseTwap: expectedClose,
    sigmaWindow: sigma,
    drift,
    secondsLeft: r,
    nUnknown,
  };
}

// ---------------------------------------------------------------- edge & EV
/**
 * Net edge per share for taking a side at `price`.
 * Positive means the model believes the contract is underpriced after fees.
 */
function netEdgePerShare(prob, price, feeSchedule) {
  return prob - price - feePerShare(price, feeSchedule);
}

/** Expected value in USD for buying `shares` at `price`. */
function expectedValue({ prob, price, shares, feeSchedule }) {
  const fee = feeTotal(shares, price, feeSchedule);
  const cost = shares * price + fee;
  const payout = shares * prob; // 1 USD per winning share
  return { ev: payout - cost, cost, fee };
}

/** Break-even model probability for a BUY at `price` including fees. */
function breakEvenProb(price, feeSchedule) {
  return clamp(price + feePerShare(price, feeSchedule), 0, 1);
}

// ------------------------------------------------------------ maker pricing
/**
 * Net edge per share for a MAKER (post-only) buy.
 *
 * Polymarket's crypto fee schedule is `{rate: 0.07, exponent: 1, takerOnly:
 * true}` — taker-only. "Makers are never charged fees. Only takers pay fees."
 * (docs.polymarket.com/trading/fees), and 20% of the taker fees collected in a
 * market are redistributed daily to the makers in that market (Maker Rebates
 * Program). So a resting bid pays NO fee at the moment of entry, which makes
 *
 *   edge_maker(p, q) = p - q          vs      edge_taker(p, a) = p - a - 0.07·a·(1-a)
 *
 * a difference worth up to 1.75c/share at 50c — i.e. the maker route converts
 * the single largest cost in this bot into zero, and adds a rebate on top.
 *
 * The condition is that the order really is a maker order: it must rest below
 * the best ask, and it is submitted with `postOnly` so the CLOB rejects it
 * rather than letting it cross and take.
 */
function netEdgePerShareMaker(prob, price) {
  return prob - price;
}

/**
 * The maker counterpart to `entryEdgeTest()`.
 *
 * Same shape, two deliberate differences:
 *
 *   1. no fee term — a post-only fill is not charged the taker fee;
 *   2. no slippage allowance — the quote IS the price, chosen by us. There is
 *      no "ask + slippage" to walk, because we are not taking anything.
 *
 * `netEdgeIfCrossed` is reported alongside: if the book moved between
 * evaluation and submission and the order did take after all, that is the edge
 * that would apply. It is never used to pass the gate — it exists so the log
 * line can be honest about the worst case.
 *
 * @param {object} p
 * @param {number} p.prob               model probability for the side being quoted
 * @param {number} p.quotePrice         the bid we would rest
 * @param {number} p.tickSize
 * @param {number} p.maxBuyPrice
 * @param {object} p.feeSchedule        only used for the worst-case figure
 * @param {number} p.moduleMinNetEdge
 * @param {number} p.globalMinNetEdge   MIN_NET_EDGE, still an account-wide floor
 * @param {boolean} [p.degraded]
 */
function makerEdgeTest({
  prob, quotePrice, tickSize, maxBuyPrice, feeSchedule,
  moduleMinNetEdge, globalMinNetEdge, degraded = false,
}) {
  const { roundPriceToTick } = require('./orderSigner');
  const cap = Number.isFinite(maxBuyPrice) ? maxBuyPrice : 1;
  const raw = Math.min(cap, Number(quotePrice));
  // A BID rounds DOWN to the tick: rounding up could lift the quote onto the
  // ask, which is the one thing a maker order must never do.
  const executablePrice = Number.isFinite(tickSize) && tickSize > 0
    ? roundPriceToTick(raw, tickSize, 'down')
    : raw;

  const moduleRequired = degraded ? moduleMinNetEdge * 1.5 : moduleMinNetEdge;
  const effectiveMinNetEdge = Math.max(moduleRequired, globalMinNetEdge);

  const netEdge = netEdgePerShareMaker(prob, executablePrice);
  return {
    executablePrice,
    limitPrice: executablePrice,
    quotePrice: executablePrice,
    netEdge,
    netEdgeIfCrossed: netEdgePerShare(prob, executablePrice, feeSchedule),
    effectiveMinNetEdge,
    moduleRequired,
    ok: netEdge >= effectiveMinNetEdge && executablePrice >= (tickSize > 0 ? tickSize : 0),
    limitedBy: moduleRequired >= globalMinNetEdge ? 'module' : 'global',
  };
}

/**
 * The ONE entry edge test.
 *
 * Before v2.3.1 the edge was tested twice, at two different prices against two
 * different thresholds:
 *
 *   engine  : netEdgePerShare(prob, bestAsk)      >= module.minNetEdge
 *   botCore : prob - limit - fee(limit)           >= fees.minNetEdge
 *             where limit = roundToTick(min(maxBuyPrice, bestAsk + slippage))
 *
 * So a signal could clear its module's gate and then be dropped at execution —
 * the "fired but did not trade" case. Worse, the two tests used *different*
 * thresholds: every module sets its own `minNetEdge`, but the execution gate
 * re-tested the global `MIN_NET_EDGE`. With the shipped values that made
 * `SQS_MIN_EDGE=0.01` unreachable, because `MIN_NET_EDGE=0.015` is higher — the
 * one module deliberately written to trade a 1-cent edge in the final seconds
 * could never fire, and nothing said so.
 *
 * Both callers now use this function, so they cannot disagree. The test runs at
 * the price you would actually pay, against
 * `max(module threshold (x1.5 when the feed is degraded), global floor)`.
 *
 * @param {object} p
 * @param {number} p.prob               model probability for the side being bought
 * @param {number} p.bestAsk            best offer on that side
 * @param {number} p.tickSize           market tick size
 * @param {number} p.maxSlippageCents   cents of slippage added to the ask
 * @param {number} p.maxBuyPrice        hard cap on the limit price
 * @param {object} p.feeSchedule        the market's published fee schedule
 * @param {number} p.moduleMinNetEdge   the firing module's own threshold
 * @param {number} p.globalMinNetEdge   MIN_NET_EDGE, the account-wide floor
 * @param {boolean} [p.degraded]        feed is a spot proxy, not the real TWAP
 */
function entryEdgeTest({
  prob, bestAsk, tickSize, maxSlippageCents, maxBuyPrice, feeSchedule,
  moduleMinNetEdge, globalMinNetEdge, degraded = false,
}) {
  // Lazy require keeps pricing.js free of a hard edge to orderSigner.js, which
  // is the module that owns tick rounding.
  const { roundPriceToTick } = require('./orderSigner');
  const slip = Number.isFinite(maxSlippageCents) ? maxSlippageCents / 100 : 0;
  const cap = Number.isFinite(maxBuyPrice) ? maxBuyPrice : 1;
  const raw = Math.min(cap, bestAsk + slip);
  const executablePrice = Number.isFinite(tickSize) && tickSize > 0
    ? roundPriceToTick(raw, tickSize)
    : raw;

  // A degraded feed (spot proxy instead of the real PolyBolt TWAP) is less
  // trustworthy, so the module's own threshold is scaled up. The global floor is
  // a floor rather than a module setting, so it is not scaled — it already
  // applies at full strength.
  const moduleRequired = degraded ? moduleMinNetEdge * 1.5 : moduleMinNetEdge;
  const effectiveMinNetEdge = Math.max(moduleRequired, globalMinNetEdge);

  const netEdge = netEdgePerShare(prob, executablePrice, feeSchedule);
  const askEdge = netEdgePerShare(prob, bestAsk, feeSchedule);
  return {
    executablePrice,
    limitPrice: executablePrice,   // same number; both names are used downstream
    netEdge,
    netEdgeAtAsk: askEdge,
    askEdge,
    effectiveMinNetEdge,
    moduleRequired,
    ok: netEdge >= effectiveMinNetEdge,
    limitedBy: moduleRequired >= globalMinNetEdge ? 'module' : 'global',
  };
}

// ------------------------------------------------------------------- sizing
/**
 * Fractional Kelly on a binary contract, fee-aware.
 * Edge: cost = p + fee, payout = 1 on a win, so net odds b = (1 - cost)/cost.
 */
function kellyStake({ prob, price, feeSchedule, balanceUsd, fraction = 0.25, minUsd, maxUsd }) {
  const cost = price + feePerShare(price, feeSchedule);
  if (!(cost > 0 && cost < 1)) return { stake: minUsd, reason: 'cost out of range' };
  const b = (1 - cost) / cost;
  const f = (prob * (b + 1) - 1) / b;
  if (!(f > 0)) return { stake: minUsd, kelly: f, reason: 'no positive Kelly fraction' };
  let stake = balanceUsd * f * fraction;
  stake = clamp(stake, minUsd, Math.min(maxUsd, balanceUsd));
  return { stake, kelly: f, odds: b };
}

// -------------------------------------------------------- volatility helpers
/**
 * Rolling per-second volatility from a series of {t (ms), p} reference ticks.
 * Uses log returns scaled to one second, so it is independent of tick spacing.
 */
class VolatilityTracker {
  constructor({ lookbackSeconds = 300, minVolPerSec = 0.02 } = {}) {
    this.lookbackMs = lookbackSeconds * 1000;
    this.minVolPerSec = minVolPerSec;
    this.samples = []; // {t, p}
  }

  add(price, timestampMs = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    this.samples.push({ t: timestampMs, p: price });
    const cutoff = timestampMs - this.lookbackMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  /** Per-second volatility in USD per sqrt(second). */
  perSecond() {
    const s = this.samples;
    if (s.length < 5) return this.minVolPerSec;
    let sumSq = 0, n = 0;
    for (let i = 1; i < s.length; i++) {
      const dtSec = (s[i].t - s[i - 1].t) / 1000;
      if (dtSec <= 0) continue;
      const r = Math.log(s[i].p / s[i - 1].p);
      const rPerSec = r / Math.sqrt(dtSec);
      sumSq += rPerSec * rPerSec;
      n++;
    }
    if (!n) return this.minVolPerSec;
    const sigmaLogPerSec = Math.sqrt(sumSq / n);
    const mid = s[s.length - 1].p;
    return Math.max(sigmaLogPerSec * mid, this.minVolPerSec);
  }

  /** Realised standard deviation of USD returns, used by breakout logic. */
  stdDevUsd(lookbackSeconds) {
    const cutoff = Date.now() - lookbackSeconds * 1000;
    const pts = this.samples.filter(s => s.t >= cutoff);
    if (pts.length < 4) return null;
    const vals = pts.map(p => p.p);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varSum = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1);
    return Math.sqrt(varSum);
  }

  /** RSI over a resampled series of reference prices. */
  rsi(period = 14, bucketMs = 5000) {
    const pts = this.resampled(bucketMs);
    if (pts.length < period + 1) return null;
    const window = pts.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < window.length; i++) {
      const d = window[i] - window[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
  }

  /** Momentum in USD over the trailing `seconds`. */
  momentumUsd(seconds) {
    const cutoff = Date.now() - seconds * 1000;
    const pts = this.samples.filter(s => s.t >= cutoff);
    if (pts.length < 2) return null;
    return pts[pts.length - 1].p - pts[0].p;
  }

  /** Simple resample to a fixed cadence for indicator maths. */
  resampled(bucketMs) {
    const out = [];
    let bucketStart = null, last = null;
    for (const s of this.samples) {
      const b = Math.floor(s.t / bucketMs) * bucketMs;
      if (bucketStart === null) { bucketStart = b; }
      if (b !== bucketStart) { if (last !== null) out.push(last); bucketStart = b; }
      last = s.p;
    }
    if (last !== null) out.push(last);
    return out;
  }
}

/**
 * Time-weighted average of the trailing `windowSeconds` of samples.
 * This is the local stand-in for the Chainlink TWAP when the authenticated
 * PolyBolt TWAP feed is unavailable — it averages time, not ticks.
 */
function trailingTwap(samples, windowSeconds, nowMs = Date.now()) {
  if (!samples || samples.length === 0) return null;
  const start = nowMs - windowSeconds * 1000;
  const pts = samples.filter(s => s.t >= start - 1000);
  const first = samples[0];
  if (!pts.length) return samples[samples.length - 1].p;
  let weighted = 0, totalTime = 0;
  let prevT = Math.max(start, first.t);
  // Seed with the oldest known price so the window is fully covered.
  let curPrice = (first.t > start) ? first.p : pts[0].p;
  for (const s of pts) {
    const t = Math.min(s.t, nowMs);
    if (t > prevT) {
      weighted += curPrice * (t - prevT);
      totalTime += (t - prevT);
      prevT = t;
    }
    curPrice = s.p;
  }
  if (prevT < nowMs) {
    weighted += curPrice * (nowMs - prevT);
    totalTime += (nowMs - prevT);
  }
  if (!(totalTime > 0)) return curPrice;
  return weighted / totalTime;
}

module.exports = {
  VolatilityTracker,
  breakEvenProb,
  entryEdgeTest,
  makerEdgeTest,
  expectedValue,
  fairProbUp,
  feePerShare,
  feeTotal,
  kellyStake,
  netEdgePerShare,
  netEdgePerShareMaker,
  normalCdf,
  trailingTwap,
};
