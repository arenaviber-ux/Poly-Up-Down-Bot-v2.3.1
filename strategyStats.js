'use strict';
/**
 * Strategy-level performance statistics for RESOLVED trades.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The account-level numbers (`realizedPnl`, `winRate`) cannot answer the one
 * question an operator actually asks after a run: "did this strategy work?"
 * They mix nine modules, two execution styles (taker and maker) and a stake
 * that moves with the settings. Worse, they invite the wrong inference: a
 * breakeven P&L after a few dozen trades looks like a verdict, and it is not.
 *
 * The arithmetic of why it is not:
 *
 *   At the shipped `MR_MIN_EDGE` (1.5c/share), a $10 maker trade entered
 *   around 60c expects to earn about $0.25. The standard deviation of that
 *   trade's outcome is about $8.11, because it either pays +$6.67 or loses
 *   $10 — a binary contract has no small outcomes. Over 30 trades the standard
 *   error is ~$1.48, so the 95% confidence interval on the mean is
 *   -$2.65..+$3.15. Zero sits comfortably inside it. In fact, a strategy with a
 *   genuine 1.5c edge shows a P&L at or below zero after 30 trades roughly 43%
 *   of the time.
 *
 * So the honest output is not "profitable" or "unprofitable"; it is a sample
 * size, a confidence interval, and the number of trades that would be needed
 * to tell the two apart. That is what this module computes.
 *
 * It also reports two cheaper diagnostics that resolve faster than P&L:
 *
 *   - **Realised win rate vs. breakeven win rate.** A binary contract bought
 *     at q wins $1.00 per share and costs q, so it breaks even at a q win
 *     rate. If the model says 64c and fills average 61c, the position needs to
 *     win 61% of the time. Whether it does is a direct test of calibration,
 *     and it uses only outcomes, not stake size.
 *   - **Win rate by dislocation.** The module's premise is that a book far
 *     below fair is noise that mean-reverts. If larger dislocations do *worse*
 *     than smaller ones, that premise is wrong and the fills are informed
 *     (adverse selection), not noise. If they do better, the edge is real.
 *
 * NOTHING HERE TRADES. It is a pure read-only summary: no I/O, no clock reads,
 * no mutation of the trades it is given. `BotCore.getState()` and
 * `tools/strategy-report.js` call the same functions, so the dashboard and the
 * CLI cannot disagree about what the record says.
 */

/** Positions whose P&L is final. Open, pending, cancelled and rejected rows are not results. */
function isResolved(trade) {
  if (!trade) return false;
  // `Number(null)` and `Number('')` are 0, which would silently count an
  // unbooked position as a breakeven trade. Require a real value first.
  if (trade.pnl === null || trade.pnl === undefined || trade.pnl === '') return false;
  return Number.isFinite(Number(trade.pnl));
}

/** Number(v) for real values, null for absent ones (`Number(null)` is 0). */
function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/** Sample standard deviation (n-1). Null below two observations. */
function sampleSd(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const ss = xs.reduce((a, x) => a + (x - m) * (x - m), 0);
  return Math.sqrt(ss / (n - 1));
}

/**
 * Two-sided 95% critical value of Student's t for `df` degrees of freedom.
 *
 * A normal z=1.96 is only right asymptotically. At n=10 the correct value is
 * 2.262, and using 1.96 there would report a confidence interval that is ~13%
 * too narrow — exactly the direction that turns noise into a "result".
 * For df>30 the Cornish-Fisher expansion is accurate to ~0.001.
 */
function tCrit95(df) {
  const table = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  if (!(df >= 1)) return null;
  if (df <= 30) return table[Math.round(df) - 1];
  const z = 1.959964;
  return z + (z * z * z + z) / (4 * df);
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Preferred to `p ± 1.96·sqrt(p(1-p)/n)` because that normal approximation
 * collapses to a zero-width interval at 0/0 and 100%, and is badly behaved for
 * the small samples this report exists to describe.
 */
function wilsonInterval(k, n, z = 1.959964) {
  if (!(n > 0)) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Number of trades needed for a two-sided 95% test to distinguish an effect of
 * `effect` per trade from zero, given per-trade standard deviation `sd`.
 * Returns null when there is nothing to detect.
 */
function requiredTrades(sd, effect, z = 1.959964) {
  if (!(sd > 0) || !(effect > 0)) return null;
  return Math.ceil((z * sd / effect) ** 2);
}

/**
 * Per-trade fields the summary needs, normalised once so every caller agrees
 * on the definition of cost, edge and outcome.
 */
function normaliseTrade(trade) {
  const pnl = Number(trade.pnl);
  const shares = Number(trade.filledShares) || 0;
  const entryUsd = Number(trade.filledUsd) || 0;
  // The entry fee is normally 0 for a maker position, but a position can be
  // filled as a taker when postOnly was off (or when a GTC quote crossed).
  // Including it keeps cost-per-share honest.
  const entryFee = Number(trade.feeUsd) || 0;
  const exitFee = Number(trade.exitFeeUsd) || 0;
  const exitShareCount = Number(trade.exitShares) || 0;
  const avgPrice = Number(trade.avgPrice) || null;
  const costPerShare = shares > 0
    ? (entryUsd + entryFee) / shares
    : (avgPrice || Number(trade.quotePrice) || Number(trade.limitPrice) || null);

  // A settled position carries `winningSide`; a fully-exited position settled
  // after expiry may not (its P&L is already known from the sale). Fall back
  // to the sign of the P&L only when the outcome itself is unknown.
  const won = trade.winningSide
    ? String(trade.winningSide).toUpperCase() === String(trade.side).toUpperCase()
    : pnl > 0;

  const modelProb = finiteOrNull(trade.modelProb);
  const bestBid = finiteOrNull(trade.quoteBestBid);

  // For a hold-to-resolution binary, P&L per share is (outcome − price). The
  // entry edge the strategy believed it had is model probability minus what
  // was actually paid, and the dislocation is model minus the bid it quoted
  // behind. Both are null when the trade predates those fields.
  const edgeAtEntry = modelProb !== null && costPerShare !== null ? modelProb - costPerShare : null;
  const dislocation = modelProb !== null && bestBid !== null ? modelProb - bestBid : null;

  const stake = entryUsd + entryFee;
  const exitProceeds = Number(trade.exitProceedsUsd) || 0;
  const holdPnl = trade.winningSide
    ? (won ? shares : 0) - entryUsd - entryFee
    : null;

  return {
    strategy: trade.strategy || 'unknown',
    name: trade.strategyName || trade.strategy || 'Unknown strategy',
    side: trade.side || null,
    marketSlug: trade.marketSlug || null,
    pnl,
    stake,
    shares,
    entryFee,
    exitFee,
    fees: entryFee + exitFee,
    costPerShare,
    won,
    resolved: true,
    maker: !!trade.maker || trade.executionStyle === 'maker',
    exited: exitShareCount > 0,
    exitedShares: exitShareCount,
    exitProceeds,
    // What the same position would have paid if held to resolution. Only
    // computable when the outcome is known; it tells the operator whether the
    // pre-expiry exit helped or simply clipped a winner.
    holdPnl: holdPnl !== null && exitShareCount > 0 ? holdPnl : null,
    exitImpact: holdPnl !== null && exitShareCount > 0 ? pnl - holdPnl : null,
    modelProb,
    edgeAtEntry,
    dislocation,
    at: trade.settledAt || trade.entryTime || null,
  };
}

function bucketLabel(low, high) {
  const lo = `${(low * 100).toFixed(0)}c`;
  return high === null ? `${lo}+` : `${lo}–${(high * 100).toFixed(0)}c`;
}

/**
 * Group resolved maker trades by how far below fair the bid they quoted behind
 * was. The boundaries are the module's own `MR_MIN_DISLOCATION` (2c) and one
 * and two cents above it, because those are the natural "how violent was this
 * swing" bands.
 *
 * @returns {Array<{label:string, from:number, to:number|null, n:number,
 *                  wins:number, winRate:number|null, netPnl:number, avgPnl:number|null}>}
 */
function dislocationBuckets(trades, edges = [0.02, 0.03, 0.04]) {
  const points = trades
    .map(normaliseTrade)
    .filter(t => t.maker && t.dislocation !== null);
  const out = [];
  for (let i = 0; i < edges.length; i++) {
    const low = edges[i];
    const high = i + 1 < edges.length ? edges[i + 1] : null;
    const rows = points.filter(t => t.dislocation >= low - 1e-12 && (high === null || t.dislocation < high - 1e-12));
    const wins = rows.filter(t => t.won).length;
    out.push({
      label: bucketLabel(low, high),
      from: low,
      to: high,
      n: rows.length,
      wins,
      winRate: rows.length ? wins / rows.length : null,
      netPnl: rows.reduce((a, t) => a + t.pnl, 0),
      avgPnl: rows.length ? rows.reduce((a, t) => a + t.pnl, 0) / rows.length : null,
    });
  }
  return out;
}

/**
 * Summarise one strategy's resolved trades.
 *
 * `verdict` is deliberately conservative:
 *   - `too-early`        fewer than 30 resolved trades. Nothing else matters.
 *   - `inconclusive`     the 95% CI on mean P&L contains zero.
 *   - `positive`/`negative`  the CI excludes zero.
 *
 * `significant` is the raw CI result even when `too-early` overrides the
 * verdict, so a genuinely huge effect in 12 trades is still visible — it just
 * is not called a result.
 */
function summarizeStrategy(key, trades) {
  const rows = (trades || []).filter(isResolved).map(normaliseTrade);
  const n = rows.length;
  if (!n) {
    return {
      strategy: key, name: key, trades: 0, wins: 0, losses: 0,
      netPnl: 0, avgPnl: null, sdPnl: null, ci95: null,
      winRate: null, winRateCi95: null,
      breakevenWinRate: null, realizedEdge: null,
      avgStake: null, avgCostPerShare: null, avgModelProb: null,
      avgEdgeAtEntry: null, avgDislocation: null,
      makerTrades: 0, takerTrades: 0, exitedTrades: 0, exitImpactUsd: null,
      feesUsd: 0, firstAt: null, lastAt: null,
      requiredTrades: null, requiredTradesForDesignedEdge: null,
      pBreakevenIfEdgeReal: null,
      significant: false, verdict: 'no-trades',
    };
  }

  const pnls = rows.map(t => t.pnl);
  const wins = rows.filter(t => t.won).length;
  const losses = n - wins;
  const netPnl = pnls.reduce((a, x) => a + x, 0);
  const avgPnl = netPnl / n;
  const sdPnl = sampleSd(pnls);
  const se = sdPnl !== null ? sdPnl / Math.sqrt(n) : null;
  const tCrit = tCrit95(n - 1);
  const ci95 = se !== null && tCrit !== null
    ? [avgPnl - tCrit * se, avgPnl + tCrit * se]
    : null;

  const winRate = wins / n;
  const winCi = wilsonInterval(wins, n);

  // Cost per share weighted by shares, not a plain average of trade prices.
  const totalShares = rows.reduce((a, t) => a + t.shares, 0);
  const totalCost = rows.reduce((a, t) => a + t.stake, 0);
  const avgCostPerShare = totalShares > 0 ? totalCost / totalShares : mean(rows.map(t => t.costPerShare).filter(x => x !== null));
  const breakevenWinRate = avgCostPerShare !== null ? avgCostPerShare : null;
  const realizedEdge = breakevenWinRate !== null ? winRate - breakevenWinRate : null;

  const modelProbs = rows.map(t => t.modelProb).filter(x => x !== null);
  const edgeAtEntry = rows.map(t => t.edgeAtEntry).filter(x => x !== null);
  const dislocations = rows.map(t => t.dislocation).filter(x => x !== null);
  const exitImpacts = rows.map(t => t.exitImpact).filter(x => x !== null);

  const designedEdge = mean(edgeAtEntry);
  const required = sdPnl !== null && avgPnl > 0 ? requiredTrades(sdPnl, avgPnl) : null;
  // How many trades to prove the edge the module was designed to capture, at
  // the dispersion actually observed. This is the number to quote an operator
  // asking "how long until I know?".
  const requiredForDesigned = sdPnl !== null && designedEdge !== null && designedEdge > 0 && avgCostPerShare > 0
    ? requiredTrades(sdPnl, (designedEdge / avgCostPerShare) * (totalCost / n))
    : null;

  // "If the strategy's edge were exactly the edge it was designed for, how
  // often would a run this long still finish at or below breakeven?" That is
  // the question a single breakeven result begs, and the answer is usually
  // "often enough that the result carries almost no information".
  const designedMeanUsd = designedEdge !== null && avgCostPerShare > 0
    ? (designedEdge / avgCostPerShare) * (totalCost / n)
    : null;
  const pBreakevenIfEdgeReal = designedMeanUsd !== null && designedMeanUsd > 0 && sdPnl !== null && n > 1
    ? normalCdf(-designedMeanUsd * Math.sqrt(n) / sdPnl)
    : null;

  const significant = !!(ci95 && (ci95[0] > 0 || ci95[1] < 0));
  let verdict;
  if (n < 30) verdict = 'too-early';
  else if (!ci95) verdict = 'inconclusive';
  else if (ci95[0] > 0) verdict = 'positive';
  else if (ci95[1] < 0) verdict = 'negative';
  else verdict = 'inconclusive';

  const dates = rows.map(t => t.at).filter(Boolean).sort();

  return {
    strategy: key,
    name: (rows.find(t => t.name) || {}).name || key,
    trades: n,
    wins,
    losses,
    netPnl,
    avgPnl,
    sdPnl,
    stderr: se,
    ci95,
    winRate,
    winRateCi95: winCi,
    breakevenWinRate,
    realizedEdge,
    avgStake: totalCost / n,
    avgCostPerShare,
    avgModelProb: mean(modelProbs),
    avgEdgeAtEntry: designedEdge,
    avgDislocation: mean(dislocations),
    makerTrades: rows.filter(t => t.maker).length,
    takerTrades: rows.filter(t => !t.maker).length,
    exitedTrades: rows.filter(t => t.exited).length,
    exitImpactUsd: exitImpacts.length ? exitImpacts.reduce((a, x) => a + x, 0) : null,
    feesUsd: rows.reduce((a, t) => a + t.fees, 0),
    firstAt: dates.length ? dates[0] : null,
    lastAt: dates.length ? dates[dates.length - 1] : null,
    requiredTrades: required,
    requiredTradesForDesignedEdge: requiredForDesigned,
    pBreakevenIfEdgeReal,
    significant,
    verdict,
  };
}

/**
 * Summarise every strategy present in a trade history.
 *
 * @param {Array<object>} trades  `tradeHistory` from BotCore (resolved and unresolved rows may be mixed)
 * @returns {Array<object>}       one summary per strategy, largest sample first
 */
function summarizeTrades(trades) {
  const byStrategy = new Map();
  for (const trade of trades || []) {
    if (!isResolved(trade)) continue;
    const key = trade.strategy || 'unknown';
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(trade);
  }
  const out = [];
  for (const [key, rows] of byStrategy) out.push(summarizeStrategy(key, rows));
  out.sort((a, b) => b.trades - a.trades || a.name.localeCompare(b.name));
  return out;
}

module.exports = {
  isResolved,
  normaliseTrade,
  summarizeStrategy,
  summarizeTrades,
  dislocationBuckets,
  mean,
  normalCdf,
  sampleSd,
  tCrit95,
  wilsonInterval,
  requiredTrades,
};
