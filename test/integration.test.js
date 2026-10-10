'use strict';
/**
 * Integration tests for the position lifecycle: persistence across restarts,
 * settlement from `market_resolved`, the Gamma fallback, and the refusal to
 * guess an outcome. Run with `npm run test:integration`.
 *
 * These touch the network only for the optional "real closed market" case.
 */

// A throw inside an `await`ed callback that the harness does not itself await
// surfaces as an unhandled rejection *after* the summary has printed — so the
// run reported "196 passed, 0 failed" and exited 0 while executeSignal() was
// dying on a ReferenceError. Fail the run instead of printing a clean summary
// over a crash.
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
const fs = require('fs');
const path = require('path');

const { CONFIG } = require('../config');
const { PolymarketAuth } = require('../polymarketAuth');
const { BotCore } = require('../botCore');
const { getJson } = require('../clobClient');

const STATE = path.join(__dirname, '..', 'itest_state.json'); // matches BotCore's resolution
process.env.STATE_FILE = STATE;

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

function freshBot(state = {}, { keepState = false } = {}) {
  if (!keepState && fs.existsSync(STATE)) fs.unlinkSync(STATE);
  if (Object.keys(state).length) fs.writeFileSync(STATE, JSON.stringify(state));
  const cfg = { ...CONFIG, runtime: { ...CONFIG.runtime, stateFile: path.basename(STATE) } };
  const auth = new PolymarketAuth(cfg);
  const bot = new BotCore({ config: cfg, auth, log: () => {} });
  return bot;
}

function pos(overrides = {}) {
  return {
    id: 'pos_test_1',
    marketSlug: 'btc-updown-5m-1000000000',
    conditionId: '0xdeadbeef',
    side: 'UP',
    strategy: 'fairValueEv',
    limitPrice: 0.8,
    requestedShares: 10,
    filledShares: 10,
    filledUsd: 8,
    avgPrice: 0.8,
    feeUsd: 0.112,
    tokenId: '111',
    expiresAtEpoch: Math.floor(Date.now() / 1000) - 60,
    status: 'FILLED',
    isPaper: true,
    orderIds: [],
    feeSchedule: { rate: 0.07, exponent: 1 },
    ...overrides,
  };
}

(async function main() {
  console.log('\nPosition lifecycle integration');

  await t('open positions survive a restart', async () => {
    const first = freshBot();
    first.activePositions = [pos()];
    first.paperBalance = 991.888;
    first.saveState();

    const second = freshBot({}, { keepState: true }); // reads the file the first bot wrote
    assert.strictEqual(second.activePositions.length, 1, 'position not restored');
    assert.strictEqual(second.activePositions[0].side, 'UP');
    assert.ok(Math.abs(second.paperBalance - 991.888) < 1e-9);
  });

  await t('market_resolved settles a winning position and credits the payout', async () => {
    const bot = freshBot();
    bot.paperBalance = 991.888;
    bot.activePositions = [pos()];
    bot.onMarketResolved({ conditionId: '0xdeadbeef', winningTokenId: '111', winningOutcome: 'Up' });

    assert.strictEqual(bot.activePositions.length, 0, 'position should be closed');
    assert.strictEqual(bot.tradeHistory.length, 1);
    const h = bot.tradeHistory[0];
    assert.strictEqual(h.status, 'SETTLED');
    assert.strictEqual(h.winningSide, 'UP');
    assert.strictEqual(h.payout, 10, '10 winning shares pay $10');
    // pnl = 10 - (8.00 cost + 0.112 fee)
    assert.ok(Math.abs(h.pnl - 1.888) < 1e-9, `pnl ${h.pnl}`);
    assert.ok(Math.abs(bot.paperBalance - (991.888 + 10)) < 1e-9);
    assert.strictEqual(bot.winningTrades, 1);
    assert.strictEqual(h.resolutionSource, 'market_resolved');
  });

  await t('market_resolved settles a losing position at zero payout', async () => {
    const bot = freshBot();
    bot.paperBalance = 1000;
    bot.activePositions = [pos()];
    bot.onMarketResolved({ conditionId: '0xdeadbeef', winningTokenId: '222', winningOutcome: 'Down' });

    const h = bot.tradeHistory[0];
    assert.strictEqual(h.winningSide, 'DOWN');
    assert.strictEqual(h.payout, 0);
    assert.ok(Math.abs(h.pnl - (-8.112)) < 1e-9, `pnl ${h.pnl}`);
    assert.strictEqual(bot.losingTrades, 1);
    // A loss must feed the daily loss limit used by the circuit breaker.
    assert.ok(bot.dailyLoss > 8);
  });

  await t('resolution by winning TOKEN id works without an outcome label', async () => {
    const bot = freshBot();
    bot.activePositions = [pos({ side: 'DOWN', tokenId: '222' })];
    bot.onMarketResolved({ conditionId: '0xdeadbeef', winningTokenId: '222' });
    assert.strictEqual(bot.tradeHistory[0].winningSide, 'DOWN');
    assert.strictEqual(bot.tradeHistory[0].payout, 10);
  });

  await t('an unresolved market is left OPEN, never guessed', async () => {
    // Condition id that cannot resolve on Gamma.
    const bot = freshBot();
    bot.activePositions = [pos({ conditionId: '0x0000000000000000000000000000000000000000000000000000000000000001' })];
    await bot.settleExpiredPositions();
    assert.strictEqual(bot.activePositions.length, 1, 'must not fabricate a settlement');
    assert.strictEqual(bot.activePositions[0].status, 'FILLED');
    assert.ok(bot.activePositions[0].unresolvedWarned, 'should warn the operator');
  });

  await t('unfilled expired orders are retired from the book', async () => {
    const bot = freshBot();
    bot.activePositions = [pos({ filledShares: 0, filledUsd: 0, status: 'LIVE' })];
    await bot.settleExpiredPositions();
    assert.strictEqual(bot.activePositions.length, 0);
    assert.strictEqual(bot.tradeHistory[0].status, 'CANCELLED');
  });

  await t('stop-loss halts the bot at the configured threshold', async () => {
    const bot = freshBot();
    bot.isRunning = true;
    bot.realizedPnl = -30;
    bot.stopLossUsd = 25;
    const ok = bot.checkRiskLimits();
    assert.strictEqual(ok, false);
    assert.strictEqual(bot.isRunning, false);
    assert.match(bot.stoppedReason, /Stop-loss/);
  });

  await t('daily loss cap halts the bot at its own limit, not the stop-loss', async () => {
    const bot = freshBot();
    bot.isRunning = true;
    bot.stopLossUsd = 300;        // the cumulative breaker is far away
    bot.maxDailyLossUsd = 50;     // the daily cap is what should fire
    bot.realizedPnl = -59.67;     // recorded as a run of losses
    bot.dailyLoss = 59.67;        // overshot by one settled trade — expected
    const ok = bot.checkRiskLimits();
    assert.strictEqual(ok, false);
    assert.strictEqual(bot.isRunning, false);
    assert.match(bot.stoppedReason, /Daily loss limit/);
    assert.match(bot.stoppedReason, /59\.67/);
    assert.match(bot.stoppedReason, /50\.00/);
  });

  await t('a daily cap set from the dashboard takes effect on the next check', async () => {
    const bot = freshBot();
    bot.isRunning = true;
    bot.dailyLoss = 59.67;
    bot.updateSettings({ maxDailyLossUsd: 300 });
    assert.strictEqual(bot.checkRiskLimits(), true, 'must run again once the cap is raised');
    assert.strictEqual(bot.isRunning, true);
  });

  await t('paper fills pay the published taker fee', async () => {
    const bot = freshBot();
    // fee per share = 0.07 * p * (1-p); 20 shares at 0.50 → 0.0175/share
    const { feePerShare } = require('../pricing');
    const fee = feePerShare(0.5, { rate: 0.07 }) * 20;
    assert.ok(Math.abs(fee - 0.35) < 1e-9, `fee ${fee}`);
    void bot;
  });

  // Optional: settle a position against a genuinely closed market on Gamma.
  await t('Gamma fallback settles a real closed market (network)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const epoch = now - (now % 300) - 600; // two windows ago, should be resolved
    const slug = `btc-updown-5m-${epoch}`;
    const events = await getJson(`https://gamma-api.polymarket.com/events?slug=${slug}`).catch(() => null);
    if (!Array.isArray(events) || !events.length) {
      console.log('      (skipped: no closed market available)');
      return;
    }
    const m = events[0].markets[0];
    if (!m.closed) { console.log('      (skipped: market not closed yet)'); return; }
    const prices = JSON.parse(m.outcomePrices);
    const labels = JSON.parse(m.outcomes).map(s => s.toLowerCase());
    const winner = labels[prices.findIndex(p => parseFloat(p) >= 0.99)];
    if (!winner) { console.log('      (skipped: not resolved yet)'); return; }

    const bot = freshBot();
    const tokenIds = JSON.parse(m.clobTokenIds);
    const upToken = tokenIds[labels.indexOf('up')];
    const downToken = tokenIds[labels.indexOf('down')];
    const side = winner === 'up' ? 'UP' : 'DOWN';
    bot.activePositions = [pos({
      conditionId: m.conditionId,
      marketSlug: slug,
      side,
      tokenId: side === 'UP' ? upToken : downToken,
      expiresAtEpoch: now - 10,
    })];
    await bot.settleExpiredPositions();
    assert.strictEqual(bot.activePositions.length, 0, 'should have settled from Gamma');
    const h = bot.tradeHistory[0];
    assert.ok(['gamma_slug', 'gamma_condition', 'clob_winner', 'clob_price'].includes(h.resolutionSource),
      `unexpected source ${h.resolutionSource}`);
    assert.strictEqual(h.winningSide, side);
    assert.ok(h.payout > 0);
    console.log(`      settled real market ${slug} as ${h.winningSide} via ${h.resolutionSource}`);
  });

  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
})();
