'use strict';
/**
 * Integration tests for the capital-recycling subsystem (v2.3).
 *
 * These drive the real `BotCore` — the tick loop, the settlement path, the
 * persistence file and the settings API — with stubbed market data, so they
 * cover the wiring rather than the decision maths (that is `test/exit.test.js`).
 *
 * The behaviours that matter, and that a unit test cannot see:
 *   - a SELL fill must never be booked as extra BUY exposure
 *   - a fully-exited position must stop counting against MAX_OPEN_POSITIONS,
 *     or recycling the capital would still leave the bot unable to use it
 *   - settling twice must not book the P&L twice
 *   - a win the bot could not sell must be queued for redemption, not just logged
 *   - exits must run even when the risk breaker has tripped or no entry
 *     candidate exists — otherwise a stopping bot strands a sellable position
 *
 * Run with `npm run test:exit`.
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
const { normaliseBook } = require('../clobClient');

const STATE = path.join(__dirname, '..', 'itest_exit_state.json');
process.env.STATE_FILE = STATE;

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const NOW_SEC = () => Math.floor(Date.now() / 1000);
const CID = '0x' + 'ab'.repeat(32);

function config(overrides = {}) {
  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.runtime.stateFile = path.basename(STATE);
  cfg.runtime.paperMode = true;
  cfg.market.timeframes = ['5m'];
  return Object.assign(cfg, overrides);
}

function botFor(cfg, { authOverrides = {}, relayer = null } = {}) {
  const auth = new PolymarketAuth(Object.assign(cfg, {}));
  Object.assign(auth, {
    liveBalanceUsd: 0,
    allowanceUsd: 0,
    syncBalanceAllowance: async () => null,
    checkBalanceAllowance: async () => ({ ok: true, balance: 50, allowance: 1000 }),
    ...authOverrides,
  });
  const bot = new BotCore({ config: cfg, auth, log: () => {} });
  if (relayer) bot.redeemer.relayer = relayer;
  return bot;
}

/** A filled position 20s from expiry, bought at 60c. */
function heldPosition(overrides = {}) {
  return {
    id: 'pos_exit_1',
    marketSlug: 'btc-updown-5m-1000000000',
    conditionId: CID,
    question: 'Bitcoin Up or Down?',
    timeframe: '5m',
    side: 'UP',
    strategy: 'fairValueEv',
    strategyName: 'Fair-Value EV',
    modelProb: 0.99,
    limitPrice: 0.6,
    requestedShares: 20,
    requestedUsd: 12,
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
    feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true },
    tokenId: '111',
    entryTime: new Date().toISOString(),
    expiresAtEpoch: NOW_SEC() + 20,
    filledShares: 20,
    filledUsd: 12,
    avgPrice: 0.6,
    feeUsd: 0.336,
    orderIds: [],
    status: 'FILLED',
    isPaper: true,
    ...overrides,
  };
}

/** Discovery entry matching `heldPosition`, with a live 20s countdown. */
function market(secondsLeft = 20) {
  return {
    slug: 'btc-updown-5m-1000000000',
    conditionId: CID,
    question: 'Bitcoin Up or Down?',
    timeframe: '5m',
    epoch: NOW_SEC() - (NOW_SEC() % 300),
    endsAtEpoch: NOW_SEC() + secondsLeft,
    remainingSec: secondsLeft,
    upTokenId: '111',
    downTokenId: '222',
    tokenMappingOk: true,
    tradeable: true,
    started: true,
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
    feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true },
  };
}

/** Decided-side book: bid-only at 99c, deep. No offers — the real endgame shape. */
function decidedBook(tokenId = '111', { price = 0.99, size = 5000 } = {}) {
  return normaliseBook({
    asset_id: tokenId,
    bids: [{ price: String(price), size: String(size) }],
    asks: [],
    tick_size: '0.01',
    min_order_size: '5',
  });
}

/**
 * Stub the reference-price feed so `manageExits` runs the REAL fair-value model
 * rather than a canned probability. A $200 lead with 20s left yields pUp 0.9999;
 * a $50 lead yields 0.8335 — enough to test both sides of the conviction gate.
 */
function stubModel(bot, { leadUsd = 200, open = 100000 } = {}) {
  bot.ref = {
    getTwap: () => ({ value: open + leadUsd, source: 'stub', authoritative: true }),
    getSpot: () => ({ value: open + leadUsd, source: 'stub' }),
    getWindowOpen: () => ({ twap: open, source: 'stub', authoritative: true }),
    getVolatilityPerSec: () => 20,
    health: () => ({}),
    // tick() reaches checkRiskLimits() once exits have run, and a tripped
    // breaker calls bot.stop() -> ref.stop(). Keep the rest of the stub silent.
    stop: () => {}, start: () => {}, ensurePolybolt: () => {},
    tracker: {}, spots: {}, spotTs: 0,
  };
}

function wireBook(bot, book) {
  bot.marketStream.getBook = (tokenId) => (String(tokenId) === String(book.tokenId) ? book : null);
}

/** A relayer double that records submissions and reports success. */
function fakeRelayer({ resolved = true, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    txType: () => 'WALLET',
    getStatus: () => ({ configured: true, authMode: 'relayer-api-key' }),
    async execute(c) { calls.push(c); return { ok: true, transactionID: 'tx' + calls.length, state: 'STATE_NEW' }; },
    async waitForTransaction() {
      return fail
        ? { ok: false, state: 'STATE_FAILED', error: 'reverted' }
        : { ok: true, state: 'STATE_MINED', transactionHash: '0x' + 'cd'.repeat(32) };
    },
    async readCondition() { return { resolved, winningIndexSets: resolved ? [1] : [] }; },
    async holdsAnyToken() { return true; },
  };
}

function authedCfg(cfg) {
  cfg.relayer.apiKey = 'test-relayer-key';
  cfg.relayer.apiKeyAddress = '0x' + '11'.repeat(20);
  cfg.redeem.verifyOnChain = false;   // no RPC in tests
  cfg.wallet.privateKey = TEST_PK;
  cfg.wallet.funderAddress = '0x' + '11'.repeat(20);
  cfg.wallet.signatureType = 3;
  return cfg;
}

const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

/**
 * A bot whose Redeemer is genuinely ready: a real signer key, a Deposit Wallet
 * funder, relayer credentials and a stubbed relayer transport. The mode stays
 * paper so nothing reaches the network — runRedeemSweep falls through to the
 * real sweeper whenever it reports itself ready.
 */
function sweepBot(cfg, relayer) {
  const bot = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
  bot.redeemer.relayer = relayer;
  bot.redeemer.fetchRedeemablePositions = async () => ({ ok: true, positions: [], count: 0 });
  bot.autoRedeem = true;
  bot.redeemer.enabled = true;
  assert.strictEqual(bot.redeemer.readiness().ready, true,
    'test precondition: the sweeper must be ready, got ' + bot.redeemer.readiness().reason);
  return bot;
}

(async function main() {
  console.log('\nCapital recycling integration (exit + redemption)');

  // ============================================================== exit firing
  await t('a decided position is sold inside the exit band (paper)', async () => {
    const bot = botFor(config());
    stubModel(bot);
    const book = decidedBook('111');
    wireBook(bot, book);
    bot.markets = [market(20)];
    bot.activePositions = [heldPosition()];
    bot.paperBalance = 988;

    await bot.manageExits();

    const p = bot.activePositions[0] || bot.tradeHistory[0];
    assert.strictEqual(p.exitShares, 20, 'the whole position was sold');
    assert.ok(Math.abs(p.exitProceedsUsd - 19.8) < 1e-6, `proceeds ${p.exitProceedsUsd}`);
    assert.strictEqual(p.status, 'EXITED', 'a fully sold position stops counting as open');
    assert.strictEqual(bot.exitStats.filled, 1);
    assert.ok(bot.exitStats.recycledUsd > 19.7, `recycled ${bot.exitStats.recycledUsd}`);
    // In PAPER mode the proceeds are credited once, at settlement, so the
    // balance has not moved yet — recycledUsd is the recycling metric here.
    // In LIVE mode the exchange returns collateral the moment the SELL fills,
    // which is asserted in its own test below.
    assert.ok(Math.abs(bot.paperBalance - 988) < 1e-9,
      `paper balance is untouched until settlement, got ${bot.paperBalance}`);
  });

  await t('in LIVE mode the collateral cache is invalidated the moment the SELL fills', async () => {
    const cfg = authedCfg(config());
    const bot = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    let forced = 0;
    bot.auth.syncBalanceAllowance = async ({ force } = {}) => { if (force) forced++; return null; };
    const p = heldPosition({ isPaper: false, exiting: true });
    bot.activePositions = [p];
    bot.clob.getOrder = async () => ({
      ok: true, body: { status: 'MATCHED', size_matched: '20', original_size: '20', price: '0.99' },
    });

    await bot.reconcileExitOrder(p, 'sell-1');

    assert.strictEqual(p.exitShares, 20);
    assert.ok(Math.abs(p.exitProceedsUsd - 19.8) < 1e-9);
    assert.ok(forced >= 1,
      'the balance cache must be invalidated immediately — otherwise the next entry still reads the pre-sale balance');
  });

  await t('the exit is driven by the real model, not the entry-time probability', async () => {
    // $50 lead with 20s left → pUp 0.8335, below EXIT_MIN_MODEL_PROB 0.97.
    const bot = botFor(config());
    stubModel(bot, { leadUsd: 50 });
    wireBook(bot, decidedBook('111'));
    bot.markets = [market(20)];
    bot.activePositions = [heldPosition({ modelProb: 0.99 })];   // stale entry-time prob

    await bot.manageExits();

    const p = bot.activePositions[0];
    assert.strictEqual(p.exitShares || 0, 0, 'a position the model no longer rates as decided must be held');
    assert.strictEqual(p.status, 'FILLED');
    assert.strictEqual(bot.exitStats.attempted, 0);
    assert.match(bot.exitStats.lastReason || '', /not-decided/, bot.exitStats.lastReason);
  });

  await t('exits do not fire outside the time band', async () => {
    for (const secondsLeft of [200, 5]) {
      const bot = botFor(config());
      stubModel(bot);
      wireBook(bot, decidedBook('111'));
      bot.markets = [market(secondsLeft)];
      bot.activePositions = [heldPosition({ expiresAtEpoch: NOW_SEC() + secondsLeft })];
      await bot.manageExits();
      assert.strictEqual(bot.activePositions[0].exitShares || 0, 0, `at ${secondsLeft}s to expiry`);
    }
  });

  await t('a thin bid ladder only sells what participation allows', async () => {
    const bot = botFor(config());
    stubModel(bot);
    wireBook(bot, decidedBook('111', { size: 40 }));   // 25% of 40 = 10 shares
    bot.markets = [market(20)];
    bot.activePositions = [heldPosition()];

    await bot.manageExits();

    const p = bot.activePositions[0];
    assert.strictEqual(p.exitShares, 10, 'must not be the whole print');
    assert.strictEqual(p.remainingShares, 10, 'the rest is still exposed to resolution');
    assert.strictEqual(p.status, 'FILLED', 'a partial exit leaves the position open');
    assert.strictEqual(bot.exitStats.partial, 1);
  });

  await t('EXIT_ENABLED=false leaves every position to resolution', async () => {
    const bot = botFor(config({ exit: Object.assign(JSON.parse(JSON.stringify(CONFIG.exit)), { enabled: false }) }));
    bot.exitEnabled = false;
    stubModel(bot);
    wireBook(bot, decidedBook('111'));
    bot.markets = [market(20)];
    bot.activePositions = [heldPosition()];
    await bot.manageExits();
    assert.strictEqual(bot.activePositions[0].exitShares || 0, 0);
  });

  // ============================================== settlement after an exit
  await t('a partial exit + a WIN settles as sale proceeds plus $1.00 per held share', async () => {
    const bot = botFor(config());
    const p = heldPosition();
    p.exitShares = 12; p.exitProceedsUsd = 11.88; p.exitFeeUsd = 0.012;
    p.remainingShares = 8; p.status = 'FILLED';
    bot.activePositions = [p];
    bot.paperBalance = 988;

    bot.onMarketResolved({ conditionId: CID, winningTokenId: '111', winningOutcome: 'Up' });

    const h = bot.tradeHistory[0];
    assert.strictEqual(h.status, 'SETTLED');
    assert.strictEqual(h.winningSide, 'UP');
    // payout = 11.88 sold + 8 held winners x $1.00
    assert.ok(Math.abs(h.payout - 19.88) < 1e-9, `payout ${h.payout}`);
    // pnl = 19.88 - (12.00 entry + 0.336 entry fee + 0.012 exit fee)
    assert.ok(Math.abs(h.pnl - (19.88 - 12 - 0.336 - 0.012)) < 1e-9, `pnl ${h.pnl}`);
    assert.strictEqual(h.exitedBeforeResolution, true);
    // Paper mode credits the full exit-adjusted payout once, at settlement
    // (11.88 sold + 8 held winners). Crediting the sale at exit time as well
    // would double-count it.
    assert.ok(Math.abs(bot.paperBalance - (988 + 19.88)) < 1e-9, `paperBalance ${bot.paperBalance}`);
  });

  await t('a partial exit + a LOSS still keeps the sale proceeds', async () => {
    const bot = botFor(config());
    const p = heldPosition();
    p.exitShares = 12; p.exitProceedsUsd = 11.88; p.exitFeeUsd = 0.012;
    p.remainingShares = 8; p.status = 'FILLED';
    bot.activePositions = [p];
    bot.paperBalance = 0;       // start from zero so the credit is unambiguous

    bot.onMarketResolved({ conditionId: CID, winningTokenId: '222', winningOutcome: 'Down' });

    const h = bot.tradeHistory[0];
    assert.strictEqual(h.winningSide, 'DOWN');
    assert.ok(Math.abs(h.payout - 11.88) < 1e-9, 'the 8 held shares are worthless; the 12 sold are banked');
    assert.ok(h.pnl < 0, 'still a loss overall, just a smaller one than holding all 20');
    // Paper mode credits the exit-adjusted payout exactly once, at settlement:
    // the sale proceeds survive the loss, the 8 held shares pay nothing.
    assert.ok(Math.abs(bot.paperBalance - 11.88) < 1e-9,
      `the banked sale proceeds must be credited exactly once, got ${bot.paperBalance}`);
    assert.ok(Math.abs(bot.realizedPnl - h.pnl) < 1e-9, 'and booked once in realised P&L');
  });

  await t('a position never exited settles exactly as it did before v2.3', async () => {
    const bot = botFor(config());
    bot.activePositions = [heldPosition()];
    bot.paperBalance = 988;
    bot.onMarketResolved({ conditionId: CID, winningTokenId: '111', winningOutcome: 'Up' });
    const h = bot.tradeHistory[0];
    assert.strictEqual(h.payout, 20, '20 winning shares pay $20');
    assert.ok(Math.abs(h.pnl - (20 - 12 - 0.336)) < 1e-9, `pnl ${h.pnl}`);
    assert.strictEqual(h.exitedBeforeResolution, false);
    assert.ok(Math.abs(bot.paperBalance - (988 + 20)) < 1e-9);
  });

  await t('settling the same position twice does not book the P&L twice', async () => {
    const bot = botFor(config());
    bot.activePositions = [heldPosition()];
    bot.onMarketResolved({ conditionId: CID, winningTokenId: '111', winningOutcome: 'Up' });
    const pnlAfterFirst = bot.realizedPnl;
    const winsAfterFirst = bot.winningTrades;
    const settled = bot.tradeHistory[0];
    // `market_resolved` and `settleExpiredPositions` can both reach a position.
    bot.settlePosition(settled, { winningSide: 'UP', source: 'duplicate' });
    assert.strictEqual(bot.realizedPnl, pnlAfterFirst, 'realised P&L must not double');
    assert.strictEqual(bot.winningTrades, winsAfterFirst);
    assert.strictEqual(bot.tradeHistory.length, 1, 'and must not appear twice in history');
  });

  await t('a fully exited position is retired without waiting for resolution', async () => {
    const bot = botFor(config());
    const p = heldPosition({ expiresAtEpoch: NOW_SEC() - 60 });
    p.exitShares = 20; p.exitProceedsUsd = 19.8; p.exitFeeUsd = 0.02;
    p.remainingShares = 0; p.status = 'EXITED';
    bot.activePositions = [p];
    bot.discovery.resolveOutcome = async () => ({ winner: null, source: 'unavailable' });

    await bot.settleExpiredPositions();

    assert.strictEqual(bot.activePositions.length, 0, 'retired even though no resolution is available');
    const h = bot.tradeHistory[0];
    assert.strictEqual(h.status, 'SETTLED');
    assert.strictEqual(h.resolutionSource, 'fully_exited');
    assert.ok(Math.abs(h.payout - 19.8) < 1e-9, 'payout is entirely the banked sale proceeds');
    assert.ok(Math.abs(h.pnl - (19.8 - 12 - 0.336 - 0.02)) < 1e-9, `pnl ${h.pnl}`);
  });

  await t('an UNRESOLVED position that was NOT fully exited is still left open, never guessed', async () => {
    const bot = botFor(config());
    bot.activePositions = [heldPosition({
      expiresAtEpoch: NOW_SEC() - 60,
      conditionId: '0x' + '00'.repeat(31) + '01',
    })];
    await bot.settleExpiredPositions();
    assert.strictEqual(bot.activePositions.length, 1, 'must not fabricate a settlement');
    assert.strictEqual(bot.activePositions[0].status, 'FILLED');
    assert.ok(bot.activePositions[0].unresolvedWarned);
  });

  // ================================================= the live SELL path
  await t('a live exit refreshes the CLOB conditional-token cache before selling', async () => {
    // The CLOB validates a SELL against its own cached conditional allowance,
    // refreshed only per token on request. Without this the exit is rejected
    // with the same "not enough balance / allowance" as an unapproved BUY, even
    // though setApprovalForAll is granted on-chain.
    const cfg = authedCfg(config());
    cfg.runtime.paperMode = false;
    const bot = botFor(cfg, {
      authOverrides: {
        signatureType: 3,
        funderAddress: '0x' + '11'.repeat(20),
        hasL2Credentials: () => true,
        geoblock: null,
      },
    });
    const syncs = [];
    bot.auth.syncBalanceAllowance = async (o = {}) => { syncs.push(o); return null; };
    const posted = [];
    bot.clob.postOrder = async (order, opts) => {
      posted.push({ order, opts });
      return { ok: true, status: 200, body: { success: true, orderID: 'exit-1', status: 'matched' } };
    };
    bot.reconcileExitOrder = async () => null;

    const pos = heldPosition({ isPaper: false, status: 'FILLED' });
    const plan = {
      exit: true, code: 'exit', reason: 'test', probSide: 0.99,
      sellShares: 20, limitPrice: 0.95,
      makerAmount: String(20 * 1e6),
      takerAmount: String(Math.round(0.95 * 20 * 1e6)),
    };
    await bot.executeExit(pos, plan, { market: market(20), book: decidedBook('111') });

    assert.strictEqual(posted.length, 1, 'the SELL was submitted');
    // The REST payload keeps the string ("SELL"); the numeric 1 that goes into
    // the EIP-712 message is covered in unit.test.js (`td.message.side`).
    assert.strictEqual(posted[0].order.side, 'SELL');
    assert.strictEqual(posted[0].order.tokenId, pos.tokenId);
    const conditional = syncs.find(s => s.tokenId === pos.tokenId);
    assert.ok(conditional, `no CONDITIONAL refresh for ${pos.tokenId}: ${JSON.stringify(syncs)}`);
    assert.strictEqual(conditional.force, true, 'a throttled sync would keep the stale zero');
    assert.ok(syncs.indexOf(conditional) === 0, 'it must happen before the order is built');
  });

  await t('a paper exit does not touch the CLOB cache', async () => {
    const bot = botFor(config());
    stubModel(bot);
    const syncs = [];
    bot.auth.syncBalanceAllowance = async (o = {}) => { syncs.push(o); return null; };
    const pos = heldPosition();
    const plan = {
      exit: true, code: 'exit', reason: 'test', probSide: 0.99,
      sellShares: 20, limitPrice: 0.95,
      makerAmount: String(20 * 1e6),
      takerAmount: String(Math.round(0.95 * 20 * 1e6)),
    };
    await bot.executeExit(pos, plan, { market: market(20), book: decidedBook('111') });
    assert.deepStrictEqual(syncs.filter(s => s.tokenId), [], 'paper trades must not call the CLOB');
  });

  // ================================================== risk-gate interaction
  await t('a fully exited position does not count against MAX_OPEN_POSITIONS', async () => {
    const bot = botFor(config());
    bot.cfg.risk.maxOpenPositions = 1;
    const exited = heldPosition({ id: 'pos_old', status: 'EXITED', exitShares: 20, remainingShares: 0 });
    bot.activePositions = [exited];
    assert.strictEqual(bot.canOpenNewPosition(market(120)), true,
      `blocked by: ${bot.lastSkipReason} — recycling capital must free the slot`);

    // A position still holding shares IS open exposure and must block.
    bot.activePositions = [heldPosition({ id: 'pos_live', status: 'FILLED' })];
    assert.strictEqual(bot.canOpenNewPosition(market(120)), false);
    assert.match(bot.lastSkipReason, /max 1 open position/);
  });

  await t('a SETTLED, CANCELLED and REJECTED position are all non-blocking', async () => {
    const bot = botFor(config());
    for (const status of ['SETTLED', 'CANCELLED', 'REJECTED']) {
      bot.activePositions = [heldPosition({ status })];
      assert.strictEqual(bot.canOpenNewPosition(market(120)), true, `${status} should not block`);
    }
  });

  await t('exits run before the risk breakers, so a stopping bot does not strand a sellable position', async () => {
    const bot = botFor(config());
    stubModel(bot);
    wireBook(bot, decidedBook('111'));
    bot.markets = [market(20)];
    bot.activePositions = [heldPosition()];
    bot.isRunning = true;
    bot.realizedPnl = -100;      // stop-loss will trip
    bot.stopLossUsd = 25;

    await bot.tick();

    assert.strictEqual(bot.isRunning, false, 'the breaker still stopped the bot');
    assert.match(bot.stoppedReason, /Stop-loss/);
    const p = bot.tradeHistory[0] || bot.activePositions[0];
    assert.strictEqual(p.exitShares, 20, 'but the position was sold for cash first');
  });

  await t('exits run even when the window is not tradeable for entries', async () => {
    const bot = botFor(config());
    stubModel(bot);
    wireBook(bot, decidedBook('111'));
    const p = heldPosition();
    bot.activePositions = [p];
    // tick() filters on `m.tradeable` long before it reaches an entry — exits
    // must sit above that filter, or a position in a window the bot has stopped
    // entering can never be sold.
    bot.markets = [Object.assign(market(20), { tradeable: false })];
    bot.isRunning = true;

    await bot.tick();

    assert.strictEqual(p.exitShares, 20, 'an untradeable window must still allow its position to be sold');
    assert.strictEqual(p.status, 'EXITED');
  });

  await t('exits explain themselves when discovery has lost the market', async () => {
    const bot = botFor(config());
    stubModel(bot);
    wireBook(bot, decidedBook('111'));
    const p = heldPosition();
    bot.activePositions = [p];
    bot.markets = [];           // discovery returned nothing this cycle
    await bot.manageExits();
    assert.strictEqual(p.exitShares || 0, 0, 'it cannot price an exit without the market record');
    assert.ok(bot.logs.some(l => /no longer in discovery/.test(l.message)),
      'and must say so rather than silently holding');
  });

  // ==================================================== SELL fill accounting
  await t('a SELL fill is never booked as extra entry exposure', async () => {
    const bot = botFor(config());
    const p = heldPosition({ status: 'FILLED' });
    p.exitOrderIds = ['sell-order-1'];
    p.exiting = true;
    bot.activePositions = [p];

    // Stub the CLOB so reconcileExitOrder reads authoritative order state.
    let reconciled = null;
    bot.clob.getOrder = async (id) => {
      reconciled = id;
      return { ok: true, body: { status: 'MATCHED', size_matched: '20', original_size: '20', price: '0.99' } };
    };

    // The user websocket delivers our own SELL fill.
    bot.onUserTrade({ takerOrderId: 'sell-order-1', size: 20, price: 0.99, side: 'SELL' });
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(reconciled, 'sell-order-1', 'routed to the exit reconcile');
    assert.strictEqual(p.filledShares, 20, 'entry exposure unchanged — a sell is not a buy');
    assert.ok(Math.abs(p.filledUsd - 12) < 1e-9, `entry cost basis unchanged, got ${p.filledUsd}`);
    assert.strictEqual(p.exitShares, 20, 'booked as an exit');
    assert.ok(Math.abs(p.exitProceedsUsd - 19.8) < 1e-9);
    assert.strictEqual(p.exiting, false, 'in-flight flag cleared');
  });

  await t('reconciling the same exit order twice does not double-count the fill', async () => {
    const bot = botFor(config());
    const p = heldPosition();
    p.exiting = true;
    bot.activePositions = [p];
    bot.clob.getOrder = async () => ({
      ok: true, body: { status: 'MATCHED', size_matched: '20', original_size: '20', price: '0.99' },
    });

    await bot.reconcileExitOrder(p, 'o1');
    const firstProceeds = p.exitProceedsUsd;
    const firstFilled = bot.exitStats.filled;
    const firstRecycled = bot.exitStats.recycledUsd;
    // The immediate reconcile, the 4s reconcile and the WS event can all fire.
    await bot.reconcileExitOrder(p, 'o1');
    await bot.reconcileExitOrder(p, 'o1');

    assert.strictEqual(p.exitShares, 20, 'shares sold must be set, not accumulated');
    assert.ok(Math.abs(p.exitProceedsUsd - firstProceeds) < 1e-9, 'proceeds must not grow');
    assert.strictEqual(bot.exitStats.filled, firstFilled, 'the fill counter must not inflate');
    assert.ok(Math.abs(bot.exitStats.recycledUsd - firstRecycled) < 1e-9,
      `recycledUsd grew from ${firstRecycled} to ${bot.exitStats.recycledUsd}`);
    // recycledUsd is NET of the exit fee, so it is proceeds minus fee.
    assert.ok(Math.abs(firstRecycled - (firstProceeds - p.exitFeeUsd)) < 1e-9,
      `recycled ${firstRecycled} should be proceeds ${firstProceeds} less fee ${p.exitFeeUsd}`);
  });

  await t('a CANCELLED sell order clears the in-flight flag without touching shares', async () => {
    const bot = botFor(config());
    const p = heldPosition();
    p.exiting = true;
    p.exitOrderIds = ['o2'];
    bot.activePositions = [p];
    bot.clob.getOrder = async () => ({ ok: true, body: { status: 'CANCELED', size_matched: '0', original_size: '20', price: '0.99' } });

    bot.onUserOrder({ id: 'o2', status: 'CANCELED' });
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(p.exiting, false, 'must be retryable');
    assert.strictEqual(p.exitShares || 0, 0);
    assert.strictEqual(p.filledShares, 20, 'still holds all 20 shares');
    assert.strictEqual(p.status, 'FILLED', 'a cancelled sell must not mark the POSITION cancelled');
  });

  await t('a resting exit order is cancelled at resolution, not left to print on a dead market', async () => {
    const bot = botFor(config());
    const p = heldPosition({ isPaper: false });
    p.exiting = true;
    p.exitOrderIds = ['o3'];
    bot.activePositions = [p];
    const cancelled = [];
    bot.clob.cancelOrder = async (id) => { cancelled.push(id); return { ok: true }; };

    bot.settlePosition(p, { winningSide: 'UP', source: 'market_resolved' });

    assert.deepStrictEqual(cancelled, ['o3']);
    assert.strictEqual(p.exiting, false);
    assert.strictEqual(p.status, 'SETTLED');
  });

  // ================================================= redemption integration
  await t('a live win the bot could not sell is queued for redemption', async () => {
    const relayer = fakeRelayer();
    const bot = sweepBot(authedCfg(config()), relayer);

    bot.activePositions = [heldPosition({ isPaper: false })];
    bot.onMarketResolved({ conditionId: CID, winningTokenId: '111', winningOutcome: 'Up' });

    assert.strictEqual(bot.redeemer.pending.size, 1, 'the win must be queued, not just logged');
    assert.ok(bot.logs.some(l => /queued .* for automatic redemption/.test(l.message)),
      'and the operator must be told it was queued');
    // The bot schedules the sweep on a 3s timer; drive it directly.
    const res = await bot.runRedeemSweep();
    assert.strictEqual(res.redeemed, 1, res.reason);
    assert.strictEqual(relayer.calls.length, 1);
    assert.strictEqual(bot.redeemer.pending.size, 0, 'cleared once redeemed');
  });

  await t('AUTO_REDEEM off means the win is queued but reported as a manual job', async () => {
    const cfg = authedCfg(config());
    const bot = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    const relayer = fakeRelayer();
    bot.redeemer.relayer = relayer;
    bot.redeemer.fetchRedeemablePositions = async () => ({ ok: true, positions: [], count: 0 });
    bot.autoRedeem = false;
    bot.redeemer.enabled = false;

    bot.activePositions = [heldPosition({ isPaper: false })];
    bot.onMarketResolved({ conditionId: CID, winningTokenId: '111', winningOutcome: 'Up' });

    assert.strictEqual(bot.redeemer.pending.size, 1);
    const warn = bot.logs.find(l => /redeem .* manually/.test(l.message));
    assert.ok(warn, 'the operator must be told the shares do not count toward the balance');
    assert.match(warn.message, /do not count toward your tradeable balance/);
  });

  await t('a live LOSS is not queued for redemption (worthless shares cost submissions)', async () => {
    const cfg = authedCfg(config());
    const bot = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    bot.redeemer.relayer = fakeRelayer();
    bot.activePositions = [heldPosition({ isPaper: false })];
    bot.onMarketResolved({ conditionId: CID, winningTokenId: '222', winningOutcome: 'Down' });
    assert.strictEqual(bot.redeemer.pending.size, 0);
    assert.ok(bot.logs.some(l => /worthless/.test(l.message)));
  });

  await t('a win that was fully sold pre-expiry has nothing left to redeem', async () => {
    const cfg = authedCfg(config());
    const bot = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    bot.redeemer.relayer = fakeRelayer();
    const p = heldPosition({ isPaper: false, status: 'EXITED', exitShares: 20, exitProceedsUsd: 19.8, remainingShares: 0 });
    bot.activePositions = [p];
    bot.onMarketResolved({ conditionId: CID, winningTokenId: '111', winningOutcome: 'Up' });
    assert.strictEqual(bot.redeemer.pending.size, 0, 'the exit already recycled this capital');
    assert.strictEqual(bot.tradeHistory[0].payout, 19.8);
  });

  await t('in paper mode a sweep simulates rather than touching the chain', async () => {
    const bot = botFor(config());
    bot.redeemer.queueCondition(CID, { shares: 10 });
    const res = await bot.runRedeemSweep();
    assert.strictEqual(res.paper, true);
    assert.strictEqual(res.redeemed, 1);
    assert.strictEqual(bot.redeemer.pending.size, 0);
    assert.match(res.reason, /\[paper\]/);
  });

  /**
   * Regression: `redeemer.enabled` used to be `autoRedeem && !paperMode`, so
   * switching the dashboard to paper made readiness() report "AUTO_REDEEM=false"
   * while the setting still said true — a line that reads like the toggle was
   * ignored. Paper handling belongs in runRedeemSweep(), not in the flag.
   */
  await t('switching to paper mode does not report the redemption setting as off', async () => {
    const bot = botFor(config());
    bot.isRunning = false;
    assert.strictEqual(bot.autoRedeem, true);

    bot.updateSettings({ paperMode: true });
    assert.strictEqual(bot.redeemer.enabled, true,
      'the runtime AUTO_REDEEM toggle must not be folded into paper mode');
    assert.strictEqual(bot.redeemer.paperMode, true, 'the sweeper mirrors the bot mode');
    const r = bot.redeemer.readiness();
    assert.strictEqual(r.ready, false);
    // readiness() deliberately stays credential-focused even in paper mode: it
    // answers "could this redeem right now", which is what you need to know
    // before flipping to live. What must NOT happen is it blaming the toggle.
    assert.doesNotMatch(r.reason, /AUTO_REDEEM=false/,
      'the reason must describe the runtime state, not a stale env value');
    assert.match(r.reason, /no signer key|RELAYER_API_KEY|POLY_FUNDER_ADDRESS/,
      `it should name what is actually missing: ${r.reason}`);

    bot.updateSettings({ paperMode: false });
    assert.strictEqual(bot.redeemer.enabled, true, 'still on after leaving paper mode');
    assert.strictEqual(bot.redeemer.paperMode, false);
    // Live and unauthorised: the reason must now point at what is actually missing.
    assert.doesNotMatch(bot.redeemer.readiness().reason, /paper mode/i);
    assert.match(bot.redeemer.readiness().reason, /AUTO_REDEEM=false|relayer credentials|signer key|POLY_FUNDER_ADDRESS/);
  });

  /**
   * Regression: re-enabling auto-redemption logged
   * "Auto-redemption ENABLED (every 300s) — AUTO_REDEEM=false", because the
   * message appended `readiness().reason` unconditionally.
   */
  await t('the enable log describes readiness instead of contradicting itself', async () => {
    const bot = botFor(config());     // paper, no relayer credentials
    bot.isRunning = false;
    bot.updateSettings({ autoRedeem: false });
    bot.logs.length = 0;
    bot.updateSettings({ autoRedeem: true });

    const line = bot.logs.find(l => /Auto-redemption ENABLED/.test(l.message));
    assert.ok(line, 're-enabling must be announced');
    assert.strictEqual(line.level, 'INFO',
      'paper mode simulates the sweep, so this is not a warning');
    assert.doesNotMatch(line.message, /AUTO_REDEEM=false/,
      `the line contradicts itself: ${line.message}`);
    assert.match(line.message, /paper mode/i);

    // In live mode with no credentials the same toggle must escalate to WARN and
    // name what is missing, so the sweeper is never a silent no-op.
    bot.logs.length = 0;
    bot.updateSettings({ paperMode: false });
    bot.updateSettings({ autoRedeem: false });
    bot.logs.length = 0;
    bot.updateSettings({ autoRedeem: true });
    const live = bot.logs.find(l => /Auto-redemption ENABLED/.test(l.message));
    assert.ok(live, 'the live re-enable must also be announced');
    assert.strictEqual(live.level, 'WARN');
    assert.match(live.message, /NOT USABLE/);
  });

  await t('a redemption failure is surfaced and leaves the condition retryable', async () => {
    const cfg = authedCfg(config());
    const bot = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    const relayer = fakeRelayer({ fail: true });
    bot.redeemer.relayer = relayer;
    bot.redeemer.fetchRedeemablePositions = async () => ({ ok: true, positions: [], count: 0 });
    bot.autoRedeem = true;
    bot.redeemer.enabled = true;
    bot.redeemer.queueCondition(CID, { title: 'btc-updown-5m-1', shares: 10 });
    assert.strictEqual(bot.redeemer.readiness().ready, true, bot.redeemer.readiness().reason);

    const res = await bot.runRedeemSweep();
    assert.strictEqual(res.failed, 1);
    assert.strictEqual(bot.redeemer.done.size, 0, 'a failure must be retryable on the next sweep');
    assert.strictEqual(bot.redeemer.pending.size, 1, 'and stays queued');
    assert.ok(bot.logs.some(l => l.level === 'ERROR' && /redeem/.test(l.message)));
  });

  await t('the collateral balance is force-refreshed after a successful redemption', async () => {
    let forced = 0;
    const bot = sweepBot(authedCfg(config()), fakeRelayer());
    bot.auth.syncBalanceAllowance = async ({ force } = {}) => { if (force) forced++; return null; };
    bot.redeemer.queueCondition(CID, { shares: 10 });

    const res = await bot.runRedeemSweep();
    assert.strictEqual(res.redeemed, 1, res.reason);
    assert.ok(forced >= 1, 'the recovered pUSD must be visible to the next order immediately');
  });

  // ================================================ settings + persistence
  await t('the exit and redeem toggles are live-changeable from the dashboard', async () => {
    const bot = botFor(config());
    bot.isRunning = false;
    const state = bot.updateSettings({ autoSell: false, autoRedeem: false });
    assert.strictEqual(bot.exitEnabled, false, 'the autoSell alias must drive exitEnabled');
    assert.strictEqual(bot.autoRedeem, false);
    assert.ok(state.settingsChanges.applied.some(a => a.key === 'exitEnabled'));
    assert.ok(state.settingsChanges.applied.some(a => a.key === 'autoRedeem'));
    // Both off is the dangerous combination — it must say so.
    assert.ok(bot.logs.some(l => l.level === 'WARN' && /drain its tradeable balance/.test(l.message)));

    bot.updateSettings({ exitEnabled: true, autoRedeemEnabled: true });
    assert.strictEqual(bot.exitEnabled, true);
    assert.strictEqual(bot.autoRedeem, true);
  });

  await t('unknown settings keys are still reported, never silently dropped', async () => {
    const bot = botFor(config());
    const state = bot.updateSettings({ exitEnabledd: true });
    assert.ok(state.settingsChanges.unapplied.includes('exitEnabledd'));
  });

  await t('exit stats and toggles survive a restart', async () => {
    const cfg = config();
    const first = botFor(cfg);
    first.exitStats.filled = 3;
    first.exitStats.recycledUsd = 57.5;
    first.exitEnabled = false;
    first.redeemer.queueCondition(CID, { shares: 9 });
    first.saveState();

    const second = botFor(cfg);
    assert.strictEqual(second.exitStats.filled, 3, 'the recycling record must not reset on restart');
    assert.ok(Math.abs(second.exitStats.recycledUsd - 57.5) < 1e-9);
    assert.strictEqual(second.exitEnabled, false, 'the operator\'s toggle must persist');
    assert.strictEqual(second.redeemer.pending.size, 1, 'a queued win must not be dropped by a restart');
  });

  await t('a redeemed condition is not re-submitted after a restart', async () => {
    const cfg = authedCfg(config());
    const first = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    first.redeemer.done.add(CID.toLowerCase());
    first.saveState();

    const second = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    assert.strictEqual(second.redeemer.done.has(CID.toLowerCase()), true);
    assert.strictEqual(second.redeemer.queueCondition(CID), false);
  });

  await t('resetting the paper account also resets the recycling record', async () => {
    const bot = botFor(config());
    bot.exitStats.filled = 7;
    bot.exitStats.recycledUsd = 100;
    bot.redeemer.queueCondition(CID);
    bot.resetPaperAccount();
    assert.strictEqual(bot.exitStats.filled, 0);
    assert.strictEqual(bot.exitStats.recycledUsd, 0);
    assert.strictEqual(bot.redeemer.pending.size, 0);
    assert.strictEqual(bot.paperBalance, 1000);
  });

  // ======================================================= state exposure
  await t('the dashboard state explains whether capital is actually being recycled', async () => {
    const cfg = authedCfg(config());
    const bot = botFor(cfg, { authOverrides: { signatureType: 3, funderAddress: '0x' + '11'.repeat(20) } });
    stubModel(bot);
    wireBook(bot, decidedBook('111'));
    bot.markets = [market(20)];
    bot.activePositions = [heldPosition()];
    await bot.manageExits();

    const s = bot.getState();
    assert.strictEqual(s.exitEnabled, true);
    assert.strictEqual(s.exit.filled, 1);
    assert.ok(s.exit.recycledUsd > 19, `recycledUsd ${s.exit.recycledUsd}`);
    assert.strictEqual(s.exit.config.maxSecondsToExpiry, 45);
    assert.ok(s.collateral, 'the state must expose the tradeable balance');
    assert.strictEqual(s.collateral.mode, 'paper');
    assert.ok(s.redeem && typeof s.redeem.ready === 'boolean', 'redeem readiness must be reported');
    assert.ok(Array.isArray(s.exit.positions));
  });

  await t('the state names why the sweeper is unusable, so it is never a silent no-op', async () => {
    const cfg = config();          // no relayer credentials
    const bot = botFor(cfg);
    const s = bot.getState();
    assert.strictEqual(s.redeem.ready, false);
    assert.match(s.redeem.reason, /no signer key|RELAYER_API_KEY/, s.redeem.reason);
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  if (failed) process.exit(1);
})();
