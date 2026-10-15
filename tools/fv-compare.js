#!/usr/bin/env node
'use strict';
/**
 * Compare Fair-Value EV threshold profiles against the trades the bot actually
 * recorded in bot_state.json.
 *
 * Read-only: it never touches the bot, the state file, or any order endpoint.
 *
 * Usage:
 *   node tools/fv-compare.js                      # uses ./bot_state.json, paper trades
 *   node tools/fv-compare.js path/to/state.json
 *   node tools/fv-compare.js --live               # include live (non-paper) trades
 *
 * What it does: for each profile it keeps the SETTLED Fair-Value EV trades that
 * would have passed that profile's gates (model probability, net edge, and
 * seconds-left at entry), then reports count, win rate, total and average P&L.
 *
 * Limits (read these before trusting the output):
 *  - It can only filter trades that were taken. Trades a stricter profile would
 *    have rejected are not in the state file, so a stricter profile can only
 *    ever show a subset of what you already have. It cannot show trades you
 *    never took.
 *  - bot_state.json keeps only the most recent 100 history entries.
 *  - Small samples are noisy. Treat differences under ~30 trades as unproven.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const includeLive = args.includes('--live');
const fileArg = args.find(a => !a.startsWith('--'));
const file = path.resolve(fileArg || 'bot_state.json');

const PROFILES = [
  { name: 'current (your settings)', minProb: 0.68, minEdge: 0.045, minLeft: 60, maxLeft: 180 },
  { name: 'stricter (suggested)',    minProb: 0.75, minEdge: 0.06,  minLeft: 60, maxLeft: 180 },
  { name: 'bot defaults',            minProb: 0.55, minEdge: 0.03,  minLeft: 40, maxLeft: 280 },
];

function isFairValue(p) {
  const s = `${p.strategy || ''} ${p.strategyName || ''}`.toLowerCase();
  return s.includes('fair') || s.includes('fv') || s.includes('fair_value');
}

function secondsLeftAtEntry(p) {
  const entry = Date.parse(p.entryTime);
  const expiry = Date.parse(p.expiryTime);
  if (!Number.isFinite(entry) || !Number.isFinite(expiry)) return null;
  return (expiry - entry) / 1000;
}

function load() {
  if (!fs.existsSync(file)) {
    console.error(`No state file at ${file}. Run the bot in paper mode first, or pass a path.`);
    process.exit(1);
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`Could not parse ${file}: ${e.message}`); process.exit(1); }
  const history = Array.isArray(state.tradeHistory) ? state.tradeHistory : [];
  return history.filter(p =>
    p && p.status === 'SETTLED' && isFairValue(p) &&
    (includeLive || p.isPaper) &&
    Number.isFinite(p.pnl) && Number.isFinite(p.modelProb) && Number.isFinite(p.expectedEdge)
  );
}

function passes(p, prof) {
  const left = secondsLeftAtEntry(p);
  return p.modelProb >= prof.minProb
    && p.expectedEdge >= prof.minEdge
    && left !== null && left >= prof.minLeft && left <= prof.maxLeft;
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.pnl > 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const staked = trades.reduce((s, t) => s + (Number(t.filledUsd) || 0), 0);
  return {
    n,
    winRate: wins / n,
    totalPnl,
    avgPnl: totalPnl / n,
    roi: staked > 0 ? totalPnl / staked : null,
  };
}

const fmtPct = v => (v === null || v === undefined || !Number.isFinite(v)) ? '   n/a' : `${(v * 100).toFixed(1).padStart(5)}%`;
const fmtUsd = v => (v === undefined || !Number.isFinite(v)) ? '   n/a' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;

const trades = load();
const mode = includeLive ? 'paper + live' : 'paper';
console.log(`Fair-Value EV settled trades (${mode}) from ${file}: ${trades.length}\n`);

if (!trades.length) {
  console.log('No settled Fair-Value EV trades found. Nothing to compare yet.');
  process.exit(0);
}

console.log('profile                    trades  win%    total P&L   avg/trade   ROI');
console.log('-------------------------  ------  ------  ----------  ----------  -------');
for (const prof of PROFILES) {
  const s = summarize(trades.filter(t => passes(t, prof)));
  const label = prof.name.padEnd(25);
  if (!s.n) {
    console.log(`${label}  ${'0'.padStart(6)}  (no trades pass this profile)`);
    continue;
  }
  console.log(`${label}  ${String(s.n).padStart(6)}  ${fmtPct(s.winRate)}  ${fmtUsd(s.totalPnl).padStart(10)}  ${fmtUsd(s.avgPnl).padStart(10)}  ${fmtPct(s.roi)}`);
}

console.log('\nProfile definitions:');
for (const prof of PROFILES) {
  console.log(`  ${prof.name}: P>=${prof.minProb}, edge>=${prof.minEdge}, ${prof.minLeft}-${prof.maxLeft}s left at entry`);
}
console.log('\nSample sizes under ~30 trades per profile are not conclusive.');
