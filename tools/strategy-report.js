#!/usr/bin/env node
'use strict';
/**
 * Read-only strategy scorecard for a bot state file.
 *
 *   npm run report                          # ./bot_state.json
 *   npm run report -- path/to/bot_state.json
 *   npm run report -- --strategy passive    # detail for module 9 only
 *   npm run report -- --all                 # detail for every strategy
 *   npm run report -- --json                # machine-readable
 *   cat bot_state.json | npm run report -- -
 *
 * WHY THIS EXISTS
 * ---------------
 * `realizedPnl` on the dashboard answers "did the account make money", not
 * "did this module work". Those are different questions, and after a short run
 * they have different answers: a strategy with a genuine 1.5c edge still
 * finishes a 30-trade run at or below breakeven about 43% of the time, because
 * a binary contract's per-trade outcome is ~$8-11 in size regardless of the
 * ~$0.25 the edge is worth. This tool prints the confidence interval, the
 * sample size needed to resolve it, and two faster diagnostics — realised win
 * rate versus breakeven, and win rate by dislocation — so a breakeven result
 * is read as "not yet" rather than "does not work".
 *
 * It never writes, never trades, and never needs a key or a network connection.
 */
const fs = require('fs');
const path = require('path');

const {
  summarizeTrades,
  dislocationBuckets,
} = require('../strategyStats');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------------ terminal
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: s => useColor ? `\x1b[2m${s}\x1b[0m` : s,
  bold: s => useColor ? `\x1b[1m${s}\x1b[0m` : s,
  green: s => useColor ? `\x1b[32m${s}\x1b[0m` : s,
  red: s => useColor ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => useColor ? `\x1b[33m${s}\x1b[0m` : s,
  cyan: s => useColor ? `\x1b[36m${s}\x1b[0m` : s,
};

const HELP = `Usage: node tools/strategy-report.js [state-file] [options]

  state-file            Path to bot_state.json (or any /api/state JSON, or a
                        bare array of trades). "-" reads stdin.
  --strategy <name>     Show details for one strategy; any alias works
                        (e.g. passive, makerReversion, mr).
  --all                 Show details for every strategy.
  --json                Print the summary as JSON.
  -h, --help            This text.

Exit code 0 even when the verdict is "inconclusive": an inconclusive sample is
a valid measurement, not an error.`;

function parseArgs(argv) {
  const opts = { file: null, strategy: null, all: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--strategy') opts.strategy = argv[++i];
    else if (a.startsWith('--strategy=')) opts.strategy = a.slice('--strategy='.length);
    else if (!a.startsWith('-') || a === '-') {
      if (opts.file !== null) throw new Error(`unexpected argument: ${a}`);
      opts.file = a;
    } else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

function readInput(file) {
  if (file === '-') return { text: fs.readFileSync(0, 'utf8'), resolved: null };
  const resolved = path.resolve(file || path.join(ROOT, 'bot_state.json'));
  return { text: fs.readFileSync(resolved, 'utf8'), resolved };
}

function extractTrades(data) {
  if (Array.isArray(data)) return { trades: data, meta: {} };
  if (data && Array.isArray(data.tradeHistory)) return { trades: data.tradeHistory, meta: data };
  throw new Error('no tradeHistory array in this file (expected bot_state.json or GET /api/state)');
}

// ------------------------------------------------------------------ printing
const money = (x, digits = 2) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${x < 0 ? '-$' : '+$'}${Math.abs(x).toFixed(digits)}`;
};
const moneyAbs = (x, digits = 2) => (Number.isFinite(x) ? `$${Math.abs(x).toFixed(digits)}` : '—');
const pct = (x, digits = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—');
const cents = (x, digits = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}c` : '—');
const pp = (x, digits = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}pp` : '—');
const pad = (s, n) => String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length);
const padL = (s, n) => String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s);
const trunc = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s);

function verdictText(s) {
  switch (s.verdict) {
    case 'positive': return c.green('positive (95% CI excludes 0)');
    case 'negative': return c.red('negative (95% CI excludes 0)');
    case 'inconclusive': return c.yellow('inconclusive (95% CI includes 0)');
    case 'too-early': return c.yellow(`too early (n=${s.trades} < 30)`);
    default: return c.dim('no resolved trades');
  }
}

function daysBetween(a, b) {
  const t0 = Date.parse(a), t1 = Date.parse(b);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
  return (t1 - t0) / 86400000;
}

function printTable(summaries) {
  const nameW = Math.max(8, Math.min(34, Math.max(...summaries.map(s => String(s.name).length))) + 1);
  console.log(c.bold('STRATEGY SCORECARD') + c.dim('  (resolved trades only)'));
  console.log(c.dim(
    pad('Strategy', nameW) + padL('Trades', 7) + padL('Win%', 7)
    + padL('Net P&L', 11) + padL('Avg/trade', 11) + '  95% CI on avg'
  ));
  console.log(c.dim('─'.repeat(nameW + 7 + 7 + 11 + 11 + 30)));
  for (const s of summaries) {
    console.log(
      pad(trunc(s.name, nameW - 1), nameW)
      + padL(String(s.trades), 7)
      + padL(pct(s.winRate), 7)
      + padL(money(s.netPnl), 11)
      + padL(money(s.avgPnl, 3), 11)
      + '  ' + (s.ci95 ? `${money(s.ci95[0], 2)} … ${money(s.ci95[1], 2)}` : '—')
      + '  ' + verdictText(s)
    );
  }
}

function printDetails(s) {
  const n = s.trades;
  console.log('');
  console.log(c.bold(c.cyan(`${s.name.toUpperCase()}  —  ${n} resolved trade${n === 1 ? '' : 's'}`)));
  if (!n) return;

  console.log(c.dim('  Outcome versus cost per share'));
  console.log(`    avg cost per share ..... ${cents(s.avgCostPerShare)}  ${c.dim('(this is the breakeven win rate)')}`);
  console.log(`    realised win rate ...... ${pct(s.winRate)}   ${c.dim(`Wilson 95% ${pct(s.winRateCi95[0])} – ${pct(s.winRateCi95[1])}`)}`);
  console.log(`    gap to breakeven ....... ${pp(s.realizedEdge)}  ${c.dim('(realised win rate − breakeven win rate)')}`);
  if (s.avgModelProb !== null) {
    console.log(`    avg model probability .. ${pct(s.avgModelProb)}   ${c.dim(`edge at entry ${cents(s.avgEdgeAtEntry)}/share`)}`);
  }
  console.log(`    avg stake .............. ${moneyAbs(s.avgStake)}`);

  console.log(c.dim('\n  P&L and how much of it is signal'));
  console.log(`    net .................... ${money(s.netPnl)}`);
  console.log(`    mean per trade ......... ${money(s.avgPnl, 3)}   ${c.dim(`sd ${moneyAbs(s.sdPnl)}`)}`);
  console.log(`    95% CI on the mean ..... ${s.ci95 ? `${money(s.ci95[0], 2)} to ${money(s.ci95[1], 2)}` : '—'}`);
  if (s.pBreakevenIfEdgeReal !== null) {
    console.log(`    if the designed edge (${cents(s.avgEdgeAtEntry)}/share) were real,`);
    console.log(`    a run this long would finish at or below zero ${c.bold(pct(s.pBreakevenIfEdgeReal, 0))} of the time.`);
  }
  if (s.requiredTradesForDesignedEdge !== null) {
    const span = daysBetween(s.firstAt, s.lastAt);
    const pace = span && span > 0 ? n / span : null;
    console.log(`    trades needed for a 95% answer on that edge: ${c.bold(`~${s.requiredTradesForDesignedEdge.toLocaleString()}`)}`
      + (pace ? c.dim(`  (≈ ${Math.round(s.requiredTradesForDesignedEdge / pace)} days at ${pace.toFixed(1)}/day)`) : ''));
  }

  console.log(c.dim('\n  Execution'));
  console.log(`    ${s.makerTrades} maker · ${s.takerTrades} taker · fees paid ${moneyAbs(s.feesUsd)}`
    + ` · sold pre-expiry ${s.exitedTrades}${s.exitImpactUsd !== null ? ` (${money(s.exitImpactUsd)} vs holding)` : ''}`);

  if (s.makerTrades > 0) {
    const buckets = dislocationBucketsForPrinted(s);
    if (buckets && buckets.some(b => b.n > 0)) {
      console.log(c.dim('\n  Win rate by dislocation at entry (model − best bid)'));
      for (const b of buckets) {
        if (!b.n) continue;
        console.log(`    ${pad(b.label, 8)} ${padL(String(b.n), 4)} trades   ${padL(pct(b.winRate), 7)} win   ${padL(money(b.netPnl), 9)}`
          + c.dim('   n is too small to trust a single row'));
      }
      console.log(c.dim('    If win rate FALLS as dislocation rises, the fills are informed and the'));
      console.log(c.dim('    "noisy book" premise is not holding. If it RISES, the edge is real.'));
    }
  }

  console.log('');
  console.log(`  ${c.bold('Verdict:')} ${verdictText(s)}`);
  if (s.verdict === 'too-early' || s.verdict === 'inconclusive') {
    console.log(c.dim('  Change nothing on the strength of this sample. ' +
      (s.requiredTradesForDesignedEdge ? `The designed edge needs ~${s.requiredTradesForDesignedEdge.toLocaleString()} trades to resolve at 95%.` : '')));
  }
}

// The summaries carry the dislocation buckets only on demand: they depend on
// the raw trades, which summarizeStrategy deliberately does not retain.
let _rawTrades = [];
function dislocationBucketsForPrinted(s) {
  const rows = _rawTrades.filter(t => (t.strategy || 'unknown') === s.strategy);
  return dislocationBuckets(rows);
}

function printReadThis(meta, summaries) {
  const total = summaries.reduce((a, s) => a + s.trades, 0);
  if (!total) return;
  console.log('');
  console.log(c.dim('─'.repeat(78)));
  console.log(c.bold('READ THIS BEFORE CHANGING ANY SETTING'));
  console.log(c.dim(
    '  These markets are binary: a position bought at q pays $1.00 or $0.00 per\n'
    + '  share, so one trade\'s P&L is roughly ±(1−q)/q × stake — about $8–11 on a\n'
    + '  $10 stake — while the edge being harvested is 1–3c/share (≈$0.20–0.50).\n'
    + '  The noise is 20–40× the signal per trade, which is why dozens of trades\n'
    + '  say almost nothing and why the verdict above, not the P&L, is the signal.'
  ));
  if (meta && meta.tradeHistory && meta.tradeHistory.length >= 100) {
    console.log(c.yellow(
      '  Note: bot_state.json keeps the last 100 closed trades. A longer record\n'
      + '  needs the in-memory history or regular exports via GET /api/state.'
    ));
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(HELP);
    process.exit(2);
  }
  if (opts.help) { console.log(HELP); return; }

  let loaded;
  try {
    loaded = readInput(opts.file);
  } catch (e) {
    console.error(`Cannot read ${opts.file || 'bot_state.json'}: ${e.message}`);
    console.error('Run the bot once (or pass a state file / GET /api/state JSON) and try again.');
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(loaded.text);
  } catch (e) {
    console.error(`Not valid JSON: ${e.message}`);
    process.exit(2);
  }

  let trades, meta;
  try {
    ({ trades, meta } = extractTrades(parsed));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  _rawTrades = trades;
  const summaries = summarizeTrades(trades);
  const resolved = summaries.reduce((a, s) => a + s.trades, 0);

  if (opts.json) {
    console.log(JSON.stringify({
      stateFile: loaded.resolved || null,
      paperMode: meta.paperMode ?? null,
      resolvedTrades: resolved,
      strategies: summaries,
      dislocation: Object.fromEntries(summaries.map(s => [
        s.strategy,
        dislocationBuckets(trades.filter(t => (t.strategy || 'unknown') === s.strategy)),
      ])),
    }, null, 2));
    return;
  }

  const source = loaded.resolved ? path.relative(process.cwd(), loaded.resolved) || loaded.resolved : '<stdin>';
  console.log(c.bold('Poly Up/Down Bot — strategy report'));
  console.log(c.dim(`${source} · ${meta.paperMode === true ? 'PAPER' : meta.paperMode === false ? 'LIVE' : 'mode unknown'}`
    + ` · ${resolved} resolved trade${resolved === 1 ? '' : 's'}`
    + (summaries.length ? ` · ${summaries.length} strateg${summaries.length === 1 ? 'y' : 'ies'}` : '')));
  console.log('');

  if (!summaries.length) {
    console.log(c.yellow('No resolved trades in this file yet. Open, pending, cancelled and rejected'));
    console.log(c.yellow('rows are not results — wait for a few windows to settle.'));
    return;
  }

  printTable(summaries);

  if (opts.all) {
    for (const s of summaries) printDetails(s);
  } else if (opts.strategy) {
    // Deliberately dependency-free matching: this tool must run on a fresh
    // checkout before `npm install`, and loading strategyEngine would pull in
    // the signing stack (and ethers) just to translate an alias.
    const needle = String(opts.strategy).toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = summaries.find(s => s.strategy.toLowerCase().replace(/[^a-z0-9]/g, '') === needle)
      || summaries.find(s => String(s.name).toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle));
    if (!match) {
      console.log('');
      console.log(c.yellow(`No resolved trades for "${opts.strategy}". Available: ${summaries.map(s => s.strategy).join(', ')}`));
    } else {
      printDetails(match);
    }
  } else {
    // Default: the strategy with the most resolved trades. That is almost
    // always the one the operator is asking about.
    printDetails(summaries[0]);
  }

  printReadThis(meta, summaries);
}

main();
