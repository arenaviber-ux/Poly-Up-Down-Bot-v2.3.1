'use strict';
/**
 * Determine — deterministically, offline — whether Stale-Quote Snipe fires.
 *
 * Deterministic replay through the REAL BotCore.tick() pipeline.
 *
 * Proves whether Stale-Quote Snipe (strategy 8) can fire, and whether a fire
 * reaches the order path, by driving the production code with synthetic feeds
 * and books. Nothing is stubbed inside the bot: only the I/O edges (market
 * discovery, book feeds, reference prices) are fed, exactly as the live run
 * would have fed them.
 */
const os = require('os');
const path = require('path');
const BOT = '/home/user/bot/poly-updown-bot-enhanced-V5';

const { CONFIG } = require(BOT + '/config');
const { PolymarketAuth } = require(BOT + '/polymarketAuth');
const { BotCore } = require(BOT + '/botCore');
const { normaliseBook } = require(BOT + '/clobClient');
const { fairProbUp, VolatilityTracker } = require(BOT + '/pricing');

function buildBot() {
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.runtime.paperMode = true;
  cfg.runtime.stateFile = path.join(os.tmpdir(), `replay-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  cfg.risk.stopLossUsd = 1e9;
  cfg.risk.maxDailyLossUsd = 1e9;
  const auth = new PolymarketAuth(cfg);
  const bot = new BotCore({ config: cfg, auth, log: () => {} });
  return { bot, cfg };
}

/** Synthetic window state: chosen so the REAL fairProbUp model returns the target p. */
function makeWorld({ left, targetP, askPrice, bidPrice, sigmaPerSec = 7, twapOpen = 84500, fillShares = 500 }) {
  const market = {
    slug: `btc-updown-5m-${Math.floor(Date.now() / 1000 / 300) * 300}`,
    conditionId: '0xcond', question: 'BTC up or down?', timeframe: '5m',
    epoch: Math.floor(Date.now() / 1000 / 300) * 300,
    endsAtEpoch: Math.floor(Date.now() / 1000) + left,
    endTime: new Date(Date.now() + left * 1000).toISOString(),
    remainingSec: left,
    tradeable: true, tokenMappingOk: true,
    upTokenId: 'UPTOKEN', downTokenId: 'DOWNTOKEN',
    feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true },
    tickSize: 0.01, minOrderSize: 5, negRisk: false,
  };

  // Solve for the spot/twap pair that makes the real model return `targetP`.
  // E[W_close] = ((60-r)*W_now + r*P_now)/60 ; d = E[W_close]-W_open ; p = Phi(d/sigma)
  const z = inverseNormalCdf(targetP);
  const nUnknown = Math.min(60, Math.max(0, left));
  const sigma = Math.max(sigmaPerSec, 0.02) * Math.sqrt(nUnknown / 3);
  const drift = z * sigma;
  const eClose = twapOpen + drift;
  // Keep W_now slightly below E[W_close] so P_now > W_now (an upward, confirming move).
  const wNow = eClose - (nUnknown > 0 ? ((drift * 0.5) / 1) * 0 : 0); // placeholder, set below
  const W_now = eClose - (drift * 0.35);
  const P_now = nUnknown > 0 ? (eClose * 60 - (60 - nUnknown) * W_now) / nUnknown : eClose;
  void wNow;

  const upBook = normaliseBook({
    asset_id: 'UPTOKEN', market: '0xcond',
    bids: [{ price: String(bidPrice), size: String(fillShares) }],
    asks: [{ price: String(askPrice), size: String(fillShares) }],
    min_order_size: '5', tick_size: '0.01', neg_risk: false,
  });
  const downBook = normaliseBook({
    asset_id: 'DOWNTOKEN', market: '0xcond',
    bids: [{ price: (1 - askPrice).toFixed(2), size: String(fillShares) }],
    asks: [{ price: (1 - bidPrice).toFixed(2), size: String(fillShares) }],
    min_order_size: '5', tick_size: '0.01', neg_risk: false,
  });

  return { market, W_now, P_now, upBook, downBook, twapOpen, sigmaPerSec };
}

/** Acklam's inverse normal CDF (enough for test scenarios). */
function inverseNormalCdf(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function wire(bot, cfg, world) {
  const { market, W_now, P_now, upBook, downBook, twapOpen, sigmaPerSec } = world;

  bot.isRunning = true;
  bot.markets = [market];
  bot.marketStream.getBook = (tokenId) => (String(tokenId) === 'UPTOKEN' ? upBook : downBook);
  bot.ref.getTwap = () => ({ value: W_now, source: 'polybolt-twap60', authoritative: true, ageMs: 0 });
  bot.ref.getSpot = () => ({ value: P_now, venues: { coinbase: P_now, kraken: P_now }, ts: { coinbase: Date.now(), kraken: Date.now() } });
  bot.ref.getWindowOpen = () => ({ twap: twapOpen, source: 'polybolt-twap60', authoritative: true });
  bot.ref.getVolatilityPerSec = () => sigmaPerSec;
  bot.ref.health = () => ({ twap: W_now, twapSource: 'polybolt-twap60', twapAuthoritative: true, volPerSec: sigmaPerSec });
  bot.ref.tracker = new VolatilityTracker({ minVolPerSec: 0.02 });
  bot.ref.spots = { coinbase: P_now, kraken: P_now };
  bot.ref.spotTs = { coinbase: Date.now(), kraken: Date.now() };
}

async function run({ label, left, targetP, askPrice, bidPrice, logFired }) {
  const { bot, cfg } = buildBot();
  const world = makeWorld({ left, targetP, askPrice, bidPrice });
  wire(bot, cfg, world);

  const model = fairProbUp({
    twapOpen: world.twapOpen, twapNow: world.W_now, priceNow: world.P_now,
    secondsLeft: left, sigmaPerSec: world.sigmaPerSec, twapWindow: 60, minSigmaPerSec: 0.02,
  });

  const events = [];
  const origExecute = bot.executeSignal.bind(bot);
  bot.executeSignal = async (ctx, decision) => {
    const pos = await origExecute(ctx, decision);
    events.push({ kind: 'executeSignal', strategy: decision.strategy, prob: decision.prob, price: decision.price, placed: !!pos, limitPrice: pos && pos.limitPrice, skip: pos ? null : bot.lastSkipReason });
    return pos;
  };

  await bot.tick();

  const st = bot.strategies.stats.staleQuoteSnipe;
  const decision = events.length ? events[0] : null;
  const engineFired = st.fired > 0;
  const traded = events.some(e => e.placed);
  const line = [
    `scenario: ${label}`,
    `  settings: left=${left}s  ask=${askPrice}  bid=${bidPrice}  targetP=${targetP}`,
    `  real model: pUp=${model.pUp === null ? 'null' : model.pUp.toFixed(4)}  drift=${model.drift.toFixed(2)}  sigmaWindow=${model.sigmaWindow.toFixed(3)}`,
    `  SQS engine: evaluated=${st.evaluated}  fired=${st.fired}  lastReason=${JSON.stringify(st.lastReason)}`,
    `  engine decision: ${engineFired ? 'FIRED Stale-Quote Snipe' + (logFired ? '' : '') : 'no signal from SQS'}`,
    `  order path: ${traded ? `PAPER ORDER PLACED @ ${events.find(e => e.placed).limitPrice}` : `no order (${events.length ? events[0].skip || 'signal dropped' : 'blocked before evaluate: ' + JSON.stringify(bot.lastSkipReason)})`}`,
    `  dashboard counter (fired) vs trade placed: ${engineFired} -> ${traded}`,
    '',
  ].join('\n');
  process.stdout.write(line);
  return { engineFired, traded, st, events, bot };
}

(async function main() {
  process.stdout.write('\n=== Deterministic replay through the real BotCore.tick() ===\n\n');
  const results = {};

  // 1. Model 96.7% on UP, market offering 93c in the final 20s (a stale quote).
  results.borderline = await run({ label: 'borderline stale quote: P=96.7%, ask=93c, 20s left', left: 20, targetP: 0.967, askPrice: 0.93, bidPrice: 0.90 });

  // 2. Same but with a decisively stale quote (model 98%).
  results.decisive = await run({ label: 'decisive stale quote: P=98%, ask=93c, 20s left', left: 20, targetP: 0.98, askPrice: 0.93, bidPrice: 0.90 });

  // 3. Everything satisfied but 40s left (outside the final-25s gate).
  results.tooEarly = await run({ label: 'same quote, 40s left (outside the final-25s window)', left: 40, targetP: 0.98, askPrice: 0.93, bidPrice: 0.90 });

  // 4. Model confident, but the market prices it correctly (ask 97c).
  results.fairAsk = await run({ label: 'no stale quote: P=98%, ask=97c, 20s left', left: 20, targetP: 0.98, askPrice: 0.97, bidPrice: 0.95 });

  process.stdout.write('\nSUMMARY\n');
  for (const [k, v] of Object.entries(results)) {
    process.stdout.write(`  ${k.padEnd(12)} engineFired=${String(v.engineFired).padEnd(5)} orderPlaced=${v.traded}\n`);
  }
})().catch(e => { console.error(e); process.exit(1); });
