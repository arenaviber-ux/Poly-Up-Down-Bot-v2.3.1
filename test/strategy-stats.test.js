'use strict';
/**
 * Tests for strategyStats.js — the strategy-level scorecard.
 *
 * Run with `npm run test:stats`.
 *
 * The load-bearing claims these tests pin down:
 *   - unresolved rows (open, pending, rejected, cancelled, `pnl: null`) are
 *     NOT results, and must not be counted as breakeven trades;
 *   - the confidence interval uses Student's t, not a normal z, because the
 *     whole point is small samples;
 *   - a genuinely positive strategy with a 1.5c edge still lands at
 *     "inconclusive" after 30 trades — the tool must not turn that into a
 *     verdict in either direction;
 *   - win rate versus breakeven win rate is computed from the price actually
 *     paid, not from the model's opinion;
 *   - dislocation buckets answer the adverse-selection question with the
 *     module's own 2c/3c/4c boundaries.
 */
process.on('unhandledRejection', (e) => {
  console.error('\nUNHANDLED REJECTION — the suite cannot vouch for this run:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('\nUNCAUGHT EXCEPTION — the suite cannot vouch for this run:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

const assert = require('assert');
const {
  isResolved,
  normaliseTrade,
  summarizeStrategy,
  summarizeTrades,
  dislocationBuckets,
  mean,
  sampleSd,
  tCrit95,
  wilsonInterval,
  requiredTrades,
  normalCdf,
} = require('../strategyStats');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

/** A settled maker trade with sensible defaults; override anything. */
function trade(over = {}) {
  const q = over.avgPrice ?? 0.60;
  const shares = over.filledShares ?? 10 / q;
  return {
    id: 'p', strategy: 'makerReversion', strategyName: 'Passive Reversion (maker)',
    marketSlug: 'btc-updown-5m-1', side: 'UP', status: 'SETTLED',
    filledUsd: 10, filledShares: shares, avgPrice: q, feeUsd: 0,
    modelProb: q + 0.015, quotePrice: q, quoteBestBid: q - 0.02,
    maker: true, executionStyle: 'maker', exitShares: 0, exitProceedsUsd: 0, exitFeeUsd: 0,
    entryTime: '2026-10-16T04:00:00.000Z', settledAt: '2026-10-16T04:05:00.000Z',
    ...over,
  };
}

/** A resolved trade with an explicit P&L and matching outcome. */
function settled(pnl, over = {}) {
  return trade({ pnl, winningSide: pnl > 0 ? 'UP' : 'DOWN', ...over });
}

// ------------------------------------------------------------------ helpers
console.log('strategyStats — helpers');

test('isResolved rejects every form of "not a result"', () => {
  assert.strictEqual(isResolved(null), false);
  assert.strictEqual(isResolved({}), false);
  assert.strictEqual(isResolved({ pnl: null }), false, 'null must not read as 0');
  assert.strictEqual(isResolved({ pnl: undefined }), false);
  assert.strictEqual(isResolved({ pnl: '' }), false, 'empty string must not read as 0');
  assert.strictEqual(isResolved({ pnl: NaN }), false);
  assert.strictEqual(isResolved({ pnl: 0 }), true, 'a real breakeven trade is a result');
  assert.strictEqual(isResolved({ pnl: -10 }), true);
});

test('mean and sample standard deviation', () => {
  assert.strictEqual(mean([]), null);
  assert.strictEqual(mean([1, 2, 3, 4, 5]), 3);
  assert.strictEqual(sampleSd([5]), null);
  assert.ok(Math.abs(sampleSd([1, 2, 3, 4, 5]) - Math.sqrt(2.5)) < 1e-12);
  assert.strictEqual(sampleSd([2, 2, 2]), 0);
});

test('normalCdf matches known values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
});

test('tCrit95 uses the t table for small samples and converges to z', () => {
  assert.strictEqual(tCrit95(9), 2.262);
  assert.strictEqual(tCrit95(30), 2.042);
  assert.ok(Math.abs(tCrit95(1) - 12.706) < 1e-9);
  assert.ok(tCrit95(5000) > 1.959 && tCrit95(5000) < 1.962, 'asymptote is 1.96');
  assert.strictEqual(tCrit95(0), null);
});

test('wilsonInterval is sane at the edges and at 50%', () => {
  const mid = wilsonInterval(15, 30);
  assert.ok(Math.abs(mid[0] - 0.3315) < 0.005, `lower ${mid[0]}`);
  assert.ok(Math.abs(mid[1] - 0.6685) < 0.005, `upper ${mid[1]}`);
  const zero = wilsonInterval(0, 30);
  assert.strictEqual(zero[0], 0);
  assert.ok(zero[1] > 0 && zero[1] < 0.2, '0/30 does not give a zero-width interval');
  const all = wilsonInterval(30, 30);
  assert.strictEqual(all[1], 1);
  assert.ok(all[0] > 0.8 && all[0] < 1);
  assert.deepStrictEqual(wilsonInterval(0, 0), [0, 1]);
});

test('requiredTrades matches the inverse-square law', () => {
  assert.strictEqual(requiredTrades(10, 0.3), 4269);
  assert.strictEqual(requiredTrades(10, 1), 385);
  assert.strictEqual(requiredTrades(10, 0), null);
  assert.strictEqual(requiredTrades(0, 0.3), null);
});

// ------------------------------------------------------------------ trades
console.log('strategyStats — trade normalisation');

test('normaliseTrade derives edge and dislocation from the bid actually quoted behind', () => {
  const t = normaliseTrade(settled(6.67, { avgPrice: 0.6, modelProb: 0.63, quoteBestBid: 0.60 }));
  assert.strictEqual(t.won, true);
  assert.ok(Math.abs(t.costPerShare - 0.6) < 1e-12);
  assert.ok(Math.abs(t.edgeAtEntry - 0.03) < 1e-12);
  assert.ok(Math.abs(t.dislocation - 0.03) < 1e-12);
  assert.strictEqual(t.maker, true);
});

test('normaliseTrade prefers winningSide over the sign of P&L', () => {
  // A winner sold pre-expiry at a loss is still a winner; the outcome is what
  // calibration is measured against, not the cash result.
  const t = normaliseTrade(settled(-2, { winningSide: 'UP', side: 'UP', exitShares: 5, exitProceedsUsd: 8 }));
  assert.strictEqual(t.won, true);
  assert.strictEqual(t.pnl, -2);
});

test('exit impact compares the sale with holding to resolution', () => {
  const t = normaliseTrade(settled(6.99, {
    filledShares: 20, avgPrice: 0.5, exitShares: 20, exitProceedsUsd: 17, exitFeeUsd: 0.01,
  }));
  assert.ok(Math.abs(t.holdPnl - 10) < 1e-9, `hold ${t.holdPnl}`);
  assert.ok(Math.abs(t.exitImpact + 3.01) < 1e-9, `impact ${t.exitImpact}`);
});

// ------------------------------------------------------------------ summaries
console.log('strategyStats — summaries');

test('unresolved rows do not enter the summary', () => {
  const rows = [
    settled(5),
    trade({ status: 'PENDING' }),                       // no pnl
    trade({ status: 'REJECTED', pnl: null }),
    trade({ status: 'CANCELLED' }),                     // no pnl
    settled(-10),
  ];
  const s = summarizeStrategy('makerReversion', rows);
  assert.strictEqual(s.trades, 2);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.netPnl, -5);
});

test('mean, sample sd and t-interval on P&L', () => {
  const rows = [1, 2, 3, 4, 5].map(x => settled(x));
  const s = summarizeStrategy('makerReversion', rows);
  assert.strictEqual(s.trades, 5);
  assert.strictEqual(s.avgPnl, 3);
  assert.ok(Math.abs(s.sdPnl - Math.sqrt(2.5)) < 1e-12);
  const half = 2.776 * Math.sqrt(2.5) / Math.sqrt(5);
  assert.ok(Math.abs(s.ci95[0] - (3 - half)) < 1e-9, `lo ${s.ci95[0]}`);
  assert.ok(Math.abs(s.ci95[1] - (3 + half)) < 1e-9, `hi ${s.ci95[1]}`);
});

test('breakeven win rate is the price actually paid, not the model probability', () => {
  const rows = [
    settled(6.67, { avgPrice: 0.6, modelProb: 0.75 }),  // model is optimistic
    settled(-10, { avgPrice: 0.6, modelProb: 0.75 }),
    settled(-10, { avgPrice: 0.6, modelProb: 0.75 }),
    settled(6.67, { avgPrice: 0.6, modelProb: 0.75 }),
  ];
  const s = summarizeStrategy('makerReversion', rows);
  assert.ok(Math.abs(s.avgCostPerShare - 0.6) < 1e-12);
  assert.ok(Math.abs(s.breakevenWinRate - 0.6) < 1e-12);
  assert.strictEqual(s.winRate, 0.5);
  assert.ok(Math.abs(s.realizedEdge + 0.1) < 1e-12);
  assert.strictEqual(s.avgModelProb, 0.75);
  assert.ok(Math.abs(s.avgEdgeAtEntry - 0.15) < 1e-12);
});

test('a real 1.5c edge is INCONCLUSIVE after 30 trades, not "positive"', () => {
  // 15 winners at +6.67 and 15 losers at -10 at a 60c entry: exactly the
  // dispersion a calibrated 61.5% strategy produces. The mean is negative
  // here, but even a positive sample of this size cannot clear zero.
  const rows = [];
  for (let i = 0; i < 15; i++) rows.push(settled(6.67, { avgPrice: 0.6 }));
  for (let i = 0; i < 15; i++) rows.push(settled(-10, { avgPrice: 0.6 }));
  const s = summarizeStrategy('makerReversion', rows);
  assert.strictEqual(s.trades, 30);
  assert.strictEqual(s.verdict, 'inconclusive');
  assert.strictEqual(s.significant, false);
  // If the edge were real, ~43% of runs this long would still finish <= 0.
  assert.ok(s.pBreakevenIfEdgeReal > 0.40 && s.pBreakevenIfEdgeReal < 0.47,
    `p=${s.pBreakevenIfEdgeReal}`);
  // And resolving it takes thousands of trades, not dozens.
  assert.ok(s.requiredTradesForDesignedEdge > 3000 && s.requiredTradesForDesignedEdge < 5000,
    `n=${s.requiredTradesForDesignedEdge}`);
});

test('too-early overrides a significant CI below 30 trades', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(settled(1));
  const s = summarizeStrategy('makerReversion', rows);
  assert.strictEqual(s.significant, true, 'the CI really does exclude zero');
  assert.strictEqual(s.verdict, 'too-early', 'and it is still not a result');
});

test('a large, consistent sample is called positive or negative', () => {
  const pos = [];
  const neg = [];
  for (let i = 0; i < 60; i++) {
    pos.push(settled(i % 2 ? 2.0 : -1.0));   // mean +0.5, sd 1.5
    neg.push(settled(i % 2 ? 1.0 : -2.0));   // mean -0.5
  }
  assert.strictEqual(summarizeStrategy('x', pos).verdict, 'positive');
  assert.strictEqual(summarizeStrategy('x', neg).verdict, 'negative');
});

test('summarizeTrades groups, sorts by sample size, and ignores unresolved rows', () => {
  const rows = [
    settled(5, { strategy: 'makerReversion' }),
    settled(-10, { strategy: 'makerReversion' }),
    settled(2, { strategy: 'makerReversion' }),
    settled(1, { strategy: 'fairValueEv' }),
    trade({ strategy: 'fairValueEv', status: 'LIVE' }),
  ];
  const out = summarizeTrades(rows);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].strategy, 'makerReversion');
  assert.strictEqual(out[0].trades, 3);
  assert.strictEqual(out[1].strategy, 'fairValueEv');
  assert.strictEqual(out[1].trades, 1);
});

test('an unknown outcome falls back to the sign of P&L, and says so only then', () => {
  const s = summarizeStrategy('x', [
    trade({ pnl: 4, winningSide: undefined }),
    trade({ pnl: -3, winningSide: undefined }),
  ]);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 1);
});

// ------------------------------------------------------------------ buckets
console.log('strategyStats — dislocation buckets');

test('buckets use the module boundaries 2c / 3c / 4c', () => {
  const rows = [
    settled(5, { quoteBestBid: 0.60, modelProb: 0.625 }),  // 2.5c
    settled(5, { quoteBestBid: 0.60, modelProb: 0.635 }),  // 3.5c
    settled(-10, { quoteBestBid: 0.60, modelProb: 0.655 }), // 5.5c
    settled(5, { quoteBestBid: 0.60, modelProb: 0.615 }),  // 1.5c — below the gate
  ];
  const b = dislocationBuckets(rows);
  assert.deepStrictEqual(b.map(x => x.n), [1, 1, 1], 'the 1.5c row is excluded');
  assert.strictEqual(b[0].wins, 1);
  assert.strictEqual(b[2].wins, 0);
  assert.ok(Math.abs(b[2].netPnl + 10) < 1e-9);
});

test('buckets silently ignore non-maker rows', () => {
  const rows = [settled(5, { maker: false, executionStyle: 'taker' })];
  assert.deepStrictEqual(dislocationBuckets(rows).map(x => x.n), [0, 0, 0]);
});

test('a row with no bid snapshot is not assigned to a bucket', () => {
  const rows = [settled(5, { quoteBestBid: null })];
  assert.deepStrictEqual(dislocationBuckets(rows).map(x => x.n), [0, 0, 0]);
});

// ------------------------------------------------------------------ done
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
