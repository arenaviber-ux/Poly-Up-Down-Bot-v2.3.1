'use strict';
/**
 * Unit tests for the capital-recycling subsystem added in v2.3:
 *
 *   exitManager.js   the pre-expiry SELL decision (pure, fully deterministic)
 *   redeemer.js      the redemption sweeper's grouping and readiness logic
 *   relayerClient.js calldata encoding and the three wallet signature schemes
 *
 * These cover the failure modes that are invisible until the bot has been
 * running for hours: an exit that fires on a losing position, one that sells
 * into a bid too thin to fill, a SELL fill that gets booked as extra entry
 * exposure, and a redemption that is submitted for tokens already claimed.
 *
 * Runs as part of `npm test`.
 */
const assert = require('assert');
const { Wallet, verifyTypedData, TypedDataEncoder, getAddress } = require('ethers');

const {
  planExit, applyExitFill, markExitPending, clearExitPending, remainingShares,
  exitAdjustedPayout, totalFees, wasExited, floorShares, exitView, TERMINAL_STATUSES,
} = require('../exitManager');
const { normalisePosition, groupByCondition, Redeemer } = require('../redeemer');
const {
  encodeRedeem, encodeApprove, encodeProxyTransactionData, deriveProxyWallet,
  deriveSafeAddress, depositWalletTypedData, safeTypedData, packSafeSignature,
  proxyStructHash, signDepositWalletBatch, signSafeTransaction, signProxyTransaction,
  RELAYER_CONTRACTS, TOKENS, RelayerClient,
} = require('../relayerClient');
const { normaliseBook } = require('../clobClient');
const { feePerShare } = require('../pricing');
const { CONFIG, validateConfig, configWarnings } = require('../config');

const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDR = new Wallet(TEST_PK).address;

// ------------------------------------------------------------------ fixtures
/** The shipped defaults, deep-copied so a test can mutate one without leaking. */
function exitCfg(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(CONFIG.exit)), ...overrides };
}

/** A position bought at 60c, 20 shares filled. */
function position(overrides = {}) {
  return {
    id: 'pos_test_exit',
    marketSlug: 'btc-updown-5m-1000000000',
    conditionId: '0x' + 'ab'.repeat(32),
    side: 'UP',
    tokenId: '111',
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
    filledShares: 20,
    filledUsd: 12,          // 20 @ 60c
    avgPrice: 0.6,
    feeUsd: 0.336,          // 0.07*0.6*0.4*20
    feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true },
    status: 'FILLED',
    expiresAtEpoch: Math.floor(Date.now() / 1000) + 30,
    modelProb: 0.98,
    isPaper: true,
    orderIds: [],
    ...overrides,
  };
}

/** A decided-side book: bid-only at 99c with real depth, no offers. */
function decidedBook({ bidPrice = 0.99, bidSize = 5000, tokenId = '111' } = {}) {
  return normaliseBook({
    asset_id: tokenId,
    bids: [{ price: String(bidPrice), size: String(bidSize) }],
    asks: [],
    tick_size: '0.01',
  });
}

/** A thin book: only 4 shares of bid at 99c. */
function thinBook() {
  return normaliseBook({
    asset_id: '111',
    bids: [{ price: '0.99', size: '4' }],
    asks: [],
    tick_size: '0.01',
  });
}

function plan(pos, book, probUp, secondsLeft, cfg = exitCfg()) {
  return planExit({
    position: pos, book, probUp, secondsLeft,
    feeSchedule: pos.feeSchedule, cfg,
  });
}

// ------------------------------------------------------------------- runner
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

module.exports = async function runExitTests(harness = {}) {
  const { test: t, testAsync: ta, section: sec } = harness && harness.test ? harness : { test, testAsync, section };

  // =========================================================== planExit gates
  sec('v2.3 — pre-expiry exit: the gates that decide');

  t('a decided position inside the band is sold', () => {
    const r = plan(position(), decidedBook(), 0.995, 30);
    assert.strictEqual(r.exit, true, r.reason);
    assert.strictEqual(r.sellShares, 20, 'whole position fits inside the participation cap');
    assert.strictEqual(r.limitPrice, 0.99, 'a SELL limit rounds DOWN to the tick so it crosses the bid');
    assert.ok(r.makerAmount && r.takerAmount, 'must return signed 6-decimal amounts');
  });

  t('a tick change after entry uses the current exit book tick for price and signed amounts', () => {
    const pos = position({ tickSize: 0.01 }); // saved when the entry was signed
    const book = normaliseBook({
      asset_id: '111', bids: [{ price: '0.987', size: '5000' }], asks: [],
      tick_size: '0.001', min_order_size: '5',
    });
    const r = plan(pos, book, 0.995, 30);
    assert.strictEqual(r.exit, true, r.reason);
    assert.strictEqual(r.tickSize, 0.001);
    assert.strictEqual(r.limitPrice, 0.987,
      'the current 0.001 tick preserves 98.7c; the saved 0.01 tick would round it to 98c');
    assert.strictEqual(r.makerAmount, '20000000');
    assert.strictEqual(r.takerAmount, '19740000',
      'the SELL payload that gets signed must be formed with the current book tick rules');
  });

  t('disabled by config means no exit, ever', () => {
    const r = plan(position(), decidedBook(), 0.995, 30, exitCfg({ enabled: false }));
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'disabled');
  });

  t('too early: outside the exit band it does not fire', () => {
    const r = plan(position(), decidedBook(), 0.995, 120);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'too-early');
    assert.match(r.reason, /exits start at 45s/);
  });

  t('too late: below the floor it holds to resolution instead of racing the close', () => {
    const r = plan(position(), decidedBook(), 0.995, 4);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'too-late');
    assert.match(r.reason, /holding to resolution/);
  });

  t('the band edges themselves are inclusive', () => {
    assert.strictEqual(plan(position(), decidedBook(), 0.995, 45).exit, true, 'upper edge fires');
    assert.strictEqual(plan(position(), decidedBook(), 0.995, 10).exit, true, 'lower edge fires');
  });

  t('a position the model does NOT rate as decided is not sold', () => {
    const r = plan(position(), decidedBook(), 0.80, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'not-decided');
    assert.match(r.reason, /80\.0%/, 'the reason must quote the model number');
  });

  t('the conviction gate uses the position\'s own side, not pUp', () => {
    // Model says UP is 2% likely → DOWN is 98% likely. A DOWN position must exit.
    const down = position({ side: 'DOWN', tokenId: '222' });
    assert.strictEqual(plan(down, decidedBook({ tokenId: '222' }), 0.02, 30).exit, true,
      'a DOWN position is decided when pUp is tiny');
    // ...and a UP position must NOT exit on the same model reading.
    assert.strictEqual(plan(position(), decidedBook(), 0.02, 30).exit, false);
  });

  t('no model at all is a stand-down, not a guess', () => {
    const r = plan(position(), decidedBook(), null, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'no-model');
  });

  t('a bid-only book with NO bids cannot be sold into', () => {
    const empty = normaliseBook({ asset_id: '111', bids: [], asks: [{ price: '0.5', size: '100' }] });
    const r = plan(position(), empty, 0.995, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'no-bids');
  });

  t('a bid below the floor means the market disagrees with the model', () => {
    const r = plan(position(), decidedBook({ bidPrice: 0.80 }), 0.995, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'bid-too-low');
    assert.match(r.reason, /80\.0c/);
  });

  t('a bid above the cap is held for the $1.00 redemption instead', () => {
    // Selling at 0.999 gives up nothing to the market but the position is
    // already worth more held: the cap exists so we don't pay a taker fee to
    // convert a certain $1.00 into 99.9c.
    const r = plan(position(), decidedBook({ bidPrice: 0.999 }), 0.999, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'bid-above-cap');
    assert.match(r.reason, /redemption is better/);
  });

  t('participation is capped against measured bid depth', () => {
    // 40 shares of depth, 25% participation → 10 shares, even though we hold 20.
    const r = plan(position(), decidedBook({ bidSize: 40 }), 0.995, 30);
    assert.strictEqual(r.exit, true, r.reason);
    assert.strictEqual(r.sellShares, 10, 'must not be the whole print');
    assert.strictEqual(r.complete, true, 'the ladder can still take all 10');
  });

  t('depth so thin it rounds to zero is refused rather than dumped', () => {
    // 4 shares of depth x 0.1% participation = 0.004 shares, which floors to 0
    // at 2-decimal size precision. Refusing beats submitting a zero-size order.
    const r = plan(position(), thinBook(), 0.995, 30, exitCfg({ maxBidDepthParticipation: 0.001 }));
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'depth-too-thin');
    // A participation cap that leaves at least one size step still trades.
    assert.strictEqual(plan(position(), thinBook(), 0.995, 30,
      exitCfg({ maxBidDepthParticipation: 0.25 })).exit, true);
  });

  t('a partial ladder is sized to what it can actually take', () => {
    // 6 shares of depth, 50% participation → 3 shares of our 20.
    const r = plan(position(), decidedBook({ bidSize: 6 }), 0.995, 30,
      exitCfg({ maxBidDepthParticipation: 0.5 }));
    assert.strictEqual(r.exit, true);
    assert.strictEqual(r.sellShares, 3);
  });

  t('the profit floor refuses an exit that would book a loss', () => {
    // Bought at 95c, bid is now 93c: selling realises a loss. With a floor of
    // $0 the bot should hold and let resolution pay $1.00 if it wins.
    const p = position({ filledShares: 20, filledUsd: 19, avgPrice: 0.95 });
    const r = plan(p, decidedBook({ bidPrice: 0.93 }), 0.975, 30, exitCfg({ minProfitFloorUsd: 0 }));
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'below-profit-floor');
    assert.match(r.reason, /below EXIT_MIN_PROFIT_FLOOR_USD/);
  });

  t('a profit floor of 0 with a genuine profit does exit', () => {
    const r = plan(position(), decidedBook(), 0.995, 30, exitCfg({ minProfitFloorUsd: 0 }));
    assert.strictEqual(r.exit, true);
    assert.ok(r.expectedPnlUsd > 7, `selling 20 shares bought at $12 for ~$19.80 nets ~$7.80, got ${r.expectedPnlUsd}`);
  });

  t('the optional net-edge gate is enforced when configured', () => {
    // probSide 0.975, limit 0.93 → edge ≈ 4.4c. A 5c gate must refuse it.
    const r = plan(position(), decidedBook({ bidPrice: 0.93 }), 0.975, 30,
      exitCfg({ minNetEdge: 0.05, minProfitFloorUsd: -100 }));
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'edge-too-thin');
  });

  t('already-exited shares are never sold twice', () => {
    const p = position({ exitShares: 20, exitProceedsUsd: 19.8 });
    const r = plan(p, decidedBook(), 0.995, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'already-exited');
  });

  t('a partially exited position sells only the remainder', () => {
    const p = position({ exitShares: 12, exitProceedsUsd: 11.88 });
    const r = plan(p, decidedBook(), 0.995, 30);
    assert.strictEqual(r.exit, true, r.reason);
    assert.strictEqual(r.sellShares, 8, 'only the 8 unsold shares');
  });

  t('a position with an exit order already live is not re-fired', () => {
    const r = plan(position({ exiting: true }), decidedBook(), 0.995, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'in-flight');
  });

  t('the retry cooldown stops an unfilled exit being re-sent every tick', () => {
    const now = 1_000_000;
    const p = position({ lastExitAttemptAt: now - 1000, exitAttempts: 1 });
    const r = planExit({
      position: p, book: decidedBook(), probUp: 0.995, secondsLeft: 30,
      feeSchedule: p.feeSchedule, cfg: exitCfg({ retryCooldownSeconds: 3 }), now,
    });
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'retry-cooldown');
    // ...and once the cooldown has elapsed the same position may retry.
    const later = planExit({
      position: p, book: decidedBook(), probUp: 0.995, secondsLeft: 30,
      feeSchedule: p.feeSchedule, cfg: exitCfg({ retryCooldownSeconds: 3 }), now: now + 5000,
    });
    assert.strictEqual(later.exit, true, later.reason);
  });

  t('attempts are exhausted after EXIT_MAX_ATTEMPTS', () => {
    const p = position({ exitAttempts: 3 });
    const r = plan(p, decidedBook(), 0.995, 30, exitCfg({ maxAttemptsPerPosition: 3 }));
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'attempts-exhausted');
  });

  t('terminal positions are never exited', () => {
    for (const status of ['SETTLED', 'EXITED', 'CANCELLED', 'REJECTED']) {
      const r = plan(position({ status }), decidedBook(), 0.995, 30);
      assert.strictEqual(r.exit, false, `${status} must not be exited`);
      assert.strictEqual(r.code, 'terminal');
      assert.ok(TERMINAL_STATUSES.has(status));
    }
  });

  t('an unfilled position has nothing to sell', () => {
    const r = plan(position({ filledShares: 0, filledUsd: 0 }), decidedBook(), 0.995, 30);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'unfilled');
  });

  t('an unknown clock is a stand-down, not an immediate exit', () => {
    const r = plan(position(), decidedBook(), 0.995, NaN);
    assert.strictEqual(r.exit, false);
    assert.strictEqual(r.code, 'no-clock');
  });

  // =============================================== exit maths and accounting
  sec('v2.3 — exit accounting: one path, no double counting');

  t('the taker fee at 99c is essentially nil (this is why selling early is cheap)', () => {
    const f99 = feePerShare(0.99, { rate: 0.07, exponent: 1 });
    const f50 = feePerShare(0.50, { rate: 0.07, exponent: 1 });
    assert.ok(f99 < 0.001, `fee at 99c should be < 0.1c, got ${(f99 * 100).toFixed(4)}c`);
    assert.ok(f50 > f99 * 20, `fee at 50c (${(f50 * 100).toFixed(2)}c) dwarfs the fee at 99c`);
    const r = plan(position(), decidedBook(), 0.995, 30);
    assert.ok(r.expectedFeeUsd < 0.02, `20 shares should cost < 2c in fees, got $${r.expectedFeeUsd}`);
  });

  t('giving up 1c against the $1.00 redemption is the whole cost of recycling', () => {
    const r = plan(position(), decidedBook(), 0.995, 30);
    const holdToResolution = 20 * 1.0;                       // 20 winning shares
    const soldNow = r.expectedNetUsd;
    const cost = holdToResolution - soldNow;
    assert.ok(cost > 0 && cost < 0.5,
      `selling 20 shares at 99c should cost ~20c versus redemption, got $${cost.toFixed(2)}`);
  });

  t('floorShares respects the tick size precision', () => {
    assert.strictEqual(floorShares(20.999, 0.01), 20.99);
    assert.strictEqual(floorShares(20.0001, 0.01), 20);
    assert.strictEqual(floorShares(0.004, 0.01), 0);
    assert.strictEqual(floorShares(5, 0.001), 5);
  });

  t('applyExitFill accumulates across repeated partial exits', () => {
    const p = position();
    applyExitFill(p, { shares: 8, grossUsd: 7.92, feeUsd: 0.008, vwap: 0.99 });
    assert.strictEqual(p.exitShares, 8);
    assert.strictEqual(remainingShares(p), 12);
    applyExitFill(p, { shares: 5, grossUsd: 4.95, feeUsd: 0.005, vwap: 0.99 });
    assert.strictEqual(p.exitShares, 13);
    assert.ok(Math.abs(p.exitProceedsUsd - 12.87) < 1e-9);
    assert.strictEqual(remainingShares(p), 7, 'never double-counts the shares');
    assert.strictEqual(p.exiting, false, 'an applied fill clears the in-flight flag');
  });

  t('applyExitFill can never push remaining shares negative', () => {
    const p = position({ filledShares: 10 });
    applyExitFill(p, { shares: 25, grossUsd: 24.75, feeUsd: 0.02, vwap: 0.99 });
    assert.strictEqual(remainingShares(p), 0);
  });

  t('a fully sold winner pays exactly the banked proceeds', () => {
    const p = position();
    applyExitFill(p, { shares: 20, grossUsd: 19.8, feeUsd: 0.02, vwap: 0.99 });
    assert.strictEqual(wasExited(p), true);
    assert.strictEqual(exitAdjustedPayout(p, true), 19.8, 'won: no extra shares to pay');
    assert.strictEqual(exitAdjustedPayout(p, false), 19.8,
      'lost: the sale already happened, so the cash is ours regardless — this is the point of exiting early');
    const pnl = exitAdjustedPayout(p, true) - (p.filledUsd + totalFees(p));
    assert.ok(Math.abs(pnl - (19.8 - 12 - 0.336 - 0.02)) < 1e-9, `pnl ${pnl}`);
  });

  t('a partially sold winner adds $1.00 for the shares still held', () => {
    const p = position();
    applyExitFill(p, { shares: 12, grossUsd: 11.88, feeUsd: 0.012, vwap: 0.99 });
    assert.strictEqual(remainingShares(p), 8);
    assert.ok(Math.abs(exitAdjustedPayout(p, true) - (11.88 + 8)) < 1e-9, 'won: 8 held shares pay $8');
    assert.ok(Math.abs(exitAdjustedPayout(p, false) - 11.88) < 1e-9, 'lost: only the sale proceeds');
  });

  t('a position that was never exited reduces to the original payout formula', () => {
    const p = position();
    assert.strictEqual(wasExited(p), false);
    assert.strictEqual(exitAdjustedPayout(p, true), 20, 'won → filledShares, exactly as before');
    assert.strictEqual(exitAdjustedPayout(p, false), 0, 'lost → 0, exactly as before');
    assert.strictEqual(totalFees(p), p.feeUsd);
  });

  t('markExitPending blocks re-entry and records the attempt', () => {
    const p = position();
    markExitPending(p, { orderId: 'ox1', attemptReason: 'test' });
    assert.strictEqual(p.exiting, true);
    assert.strictEqual(p.exitAttempts, 1);
    assert.deepStrictEqual(p.exitOrderIds, ['ox1']);
    markExitPending(p, { orderId: 'ox1' });
    assert.strictEqual(p.exitAttempts, 2);
    assert.deepStrictEqual(p.exitOrderIds, ['ox1'], 'the same order id is not duplicated');
    clearExitPending(p);
    assert.strictEqual(p.exiting, false);
  });

  t('the dashboard exit view reports exposure still waiting on resolution', () => {
    const p = position();
    applyExitFill(p, { shares: 12, grossUsd: 11.88, feeUsd: 0.012, vwap: 0.99 });
    const v = exitView(p);
    assert.strictEqual(v.filledShares, 20);
    assert.strictEqual(v.exitShares, 12);
    assert.strictEqual(v.remainingShares, 8);
    assert.ok(Math.abs(v.exitAvgPrice - 0.99) < 1e-9);
    assert.strictEqual(v.status, 'FILLED');
  });

  // ========================================================= redeemer logic
  sec('v2.3 — redemption sweeper: grouping, readiness and idempotence');

  t('a redeemable position row is normalised', () => {
    const p = normalisePosition({
      conditionId: 'dd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917',
      asset: '999', size: 12.5, outcome: 'Up', outcomeIndex: 0,
      negativeRisk: false, title: 'Bitcoin Up or Down', redeemable: true,
      currentValue: 12.5, curPrice: 1,
    });
    assert.ok(p.conditionId.startsWith('0x'), 'a bare hex condition id is prefixed');
    assert.strictEqual(p.size, 12.5);
    assert.strictEqual(p.negativeRisk, false);
    assert.strictEqual(normalisePosition({ conditionId: '0x1', size: 0 }), null, 'zero-size rows are dropped');
    assert.strictEqual(normalisePosition(null), null);
  });

  t('both outcomes of one condition collapse into a single redemption', () => {
    const groups = groupByCondition([
      normalisePosition({ conditionId: '0x' + 'aa'.repeat(32), asset: '1', size: 10, outcome: 'Up', outcomeIndex: 0 }),
      normalisePosition({ conditionId: '0x' + 'aa'.repeat(32), asset: '2', size: 5, outcome: 'Down', outcomeIndex: 1 }),
      normalisePosition({ conditionId: '0x' + 'bb'.repeat(32), asset: '3', size: 7, outcome: 'Up', outcomeIndex: 0 }),
    ]);
    assert.strictEqual(groups.size, 2, 'one call per condition, not per outcome');
    const g = groups.get('0x' + 'aa'.repeat(32));
    assert.strictEqual(g.totalSize, 15);
    assert.strictEqual(g.positions.length, 2);
    assert.deepStrictEqual(g.tokenIds, ['1', '2'], 'token ids are carried through for the balance check');
  });

  t('any row asserting neg-risk makes the whole group neg-risk', () => {
    const groups = groupByCondition([
      normalisePosition({ conditionId: '0x' + 'cc'.repeat(32), asset: '1', size: 1, negativeRisk: false }),
      normalisePosition({ conditionId: '0x' + 'cc'.repeat(32), asset: '2', size: 1, negativeRisk: true }),
    ]);
    assert.strictEqual(groups.get('0x' + 'cc'.repeat(32)).negativeRisk, true,
      'a mixed reading would redeem through the wrong adapter');
  });

  t('the sweeper reports exactly why it is not usable', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = null; cfg.relayer.apiKeyAddress = null;
    cfg.relayer.builderApiKey = null;
    const auth = { signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20) };
    const r = new Redeemer(cfg, auth, { log: () => {} });
    const ready = r.readiness();
    assert.strictEqual(ready.ready, false);
    assert.match(ready.reason, /RELAYER_API_KEY/, 'the reason must name the missing setting');
  });

  t('with relayer credentials a Deposit Wallet account is ready', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'relayer-key'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    const auth = { signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20) };
    const r = new Redeemer(cfg, auth, { log: () => {} });
    const ready = r.readiness();
    assert.strictEqual(ready.ready, true);
    assert.strictEqual(ready.mode, 'WALLET');
    assert.strictEqual(r.relayer.txType(), 'WALLET');
  });

  t('a Safe account uses the SAFE relayer type, a proxy account uses PROXY', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    for (const [st, expected] of [[1, 'PROXY'], [2, 'SAFE'], [3, 'WALLET']]) {
      const r = new Redeemer(cfg, { signatureType: st, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20) }, { log: () => {} });
      assert.strictEqual(r.relayer.txType(), expected, `signature type ${st}`);
    }
  });

  t('an EOA account bypasses the relayer entirely', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = null; cfg.relayer.builderApiKey = null;
    const r = new Redeemer(cfg, { signatureType: 0, wallet: new Wallet(TEST_PK), funderAddress: TEST_ADDR }, { log: () => {} });
    const ready = r.readiness();
    assert.strictEqual(ready.ready, true);
    assert.strictEqual(ready.mode, 'direct');
    assert.match(ready.reason, /direct CTF call/);
  });

  t('a missing account wallet is reported, not silently skipped', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    const r = new Redeemer(cfg, { signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: null }, { log: () => {} });
    assert.strictEqual(r.readiness().ready, false);
    assert.match(r.readiness().reason, /POLY_FUNDER_ADDRESS/);
  });

  t('a queued win is swept once and never re-submitted', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    cfg.redeem.verifyOnChain = false;
    const submitted = [];
    const fakeRelayer = {
      isConfigured: () => true,
      txType: () => 'WALLET',
      getStatus: () => ({ configured: true }),
      async execute(calls) { submitted.push(calls); return { ok: true, transactionID: 'tx1', state: 'STATE_NEW' }; },
      async waitForTransaction() { return { ok: true, state: 'STATE_MINED', transactionHash: '0xbeef' }; },
      async readCondition() { return { resolved: true, winningIndexSets: [1] }; },
      async holdsAnyToken() { return true; },
    };
    const auth = {
      signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20),
      liveBalanceUsd: 0, allowanceUsd: 0,
      syncBalanceAllowance: async () => null,
      checkBalanceAllowance: async () => ({ ok: true, balance: 12.5, allowance: 1000 }),
    };
    const r = new Redeemer(cfg, auth, { log: () => {}, relayer: fakeRelayer });
    r.fetchRedeemablePositions = async () => ({ ok: true, positions: [], count: 0 });

    const cid = '0x' + 'ab'.repeat(32);
    assert.strictEqual(r.queueCondition(cid, { title: 'btc-updown-5m-1', shares: 12.5, tokenIds: ['111'] }), true);
    const res = await r.sweep();
    assert.strictEqual(res.redeemed, 1, res.reason);
    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(submitted[0][0].to, RELAYER_CONTRACTS[137].ctfCollateralAdapter,
      'pUSD output must go through the V2 collateral adapter');
    assert.ok(Math.abs(res.recoveredUsdEstimate - 12.5) < 1e-9);
    assert.strictEqual(res.balanceAfter, 12.5, 'the balance is re-read after a successful redeem');

    // Second sweep: already redeemed, nothing to do, nothing re-submitted.
    const res2 = await r.sweep();
    assert.strictEqual(res2.found, 0);
    assert.strictEqual(submitted.length, 1, 'a redeemed condition must never be submitted twice');
    assert.strictEqual(r.queueCondition(cid), false, 'and cannot be re-queued');
  });

  t('a failed redemption is recorded and does not mark the condition done', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    cfg.redeem.verifyOnChain = false;
    let calls = 0;
    const fakeRelayer = {
      isConfigured: () => true, txType: () => 'WALLET', getStatus: () => ({}),
      async execute() { calls++; return { ok: true, transactionID: 'tx' + calls }; },
      async waitForTransaction() { return { ok: false, state: 'STATE_FAILED', error: 'reverted: not resolved' }; },
      async readCondition() { return { resolved: true, winningIndexSets: [2] }; },
    };
    const auth = { signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20), syncBalanceAllowance: async () => null };
    const r = new Redeemer(cfg, auth, { log: () => {}, relayer: fakeRelayer });
    r.fetchRedeemablePositions = async () => ({
      ok: true,
      positions: [normalisePosition({ conditionId: '0x' + 'cd'.repeat(32), asset: '5', size: 3, redeemable: true, currentValue: 3 })],
    });
    const res = await r.sweep();
    assert.strictEqual(res.failed, 1);
    assert.strictEqual(res.redeemed, 0);
    assert.strictEqual(r.done.size, 0, 'a failure must stay eligible for retry');
    assert.strictEqual(r.failed.size, 1);
    assert.match(r.history[0].error, /not resolved/);
  });

  t('an unready sweeper no-ops without throwing and says why once', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = null; cfg.relayer.builderApiKey = null;
    const logs = [];
    const r = new Redeemer(cfg, { signatureType: 3, wallet: null, funderAddress: null }, { log: (l, m) => logs.push([l, m]) });
    r.queueCondition('0x' + 'ef'.repeat(32), { shares: 4 });
    const res = await r.sweep();
    assert.strictEqual(res.ran, false);
    assert.match(res.reason, /no signer key/);
    assert.strictEqual(logs.filter(l => l[0] === 'WARN').length, 1, 'warned exactly once');
    await r.sweep();
    await r.sweep();
    assert.strictEqual(logs.filter(l => l[0] === 'WARN').length, 1, 'and not on every sweep');
  });

  t('the minimum-value floor leaves dust queued for a later batch', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    cfg.redeem.verifyOnChain = false;
    cfg.redeem.minValueUsd = 1;
    const submitted = [];
    const fakeRelayer = {
      isConfigured: () => true, txType: () => 'WALLET', getStatus: () => ({}),
      async execute(c) { submitted.push(c); return { ok: true, transactionID: 't' }; },
      async waitForTransaction() { return { ok: true, state: 'STATE_MINED', transactionHash: '0x1' }; },
      async readCondition() { return { resolved: true, winningIndexSets: [1] }; },
    };
    const auth = { signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20), syncBalanceAllowance: async () => null, checkBalanceAllowance: async () => ({ ok: true, balance: 0, allowance: 0 }) };
    const r = new Redeemer(cfg, auth, { log: () => {}, relayer: fakeRelayer });
    r.fetchRedeemablePositions = async () => ({
      ok: true,
      positions: [
        normalisePosition({ conditionId: '0x' + 'a1'.repeat(32), asset: '1', size: 0.4, currentValue: 0.4 }),
        normalisePosition({ conditionId: '0x' + 'a2'.repeat(32), asset: '2', size: 9, currentValue: 9 }),
      ],
    });
    const res = await r.sweep();
    assert.strictEqual(res.redeemed, 1, 'only the position above the floor');
    assert.strictEqual(submitted.length, 1);
  });

  t('an unreachable RPC does not strand a win the bot settled itself', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    cfg.redeem.verifyOnChain = false;          // operator opted out of RPC checks
    const submitted = [];
    const logs = [];
    const fakeRelayer = {
      isConfigured: () => true, txType: () => 'WALLET', getStatus: () => ({}),
      async execute(c) { submitted.push(c); return { ok: true, transactionID: 't' }; },
      async waitForTransaction() { return { ok: true, state: 'STATE_MINED', transactionHash: '0x1' }; },
      async readCondition() { throw new Error('could not detect network'); },
    };
    const auth = {
      signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20),
      syncBalanceAllowance: async () => null,
      checkBalanceAllowance: async () => ({ ok: true, balance: 5, allowance: 100 }),
    };
    const r = new Redeemer(cfg, auth, { log: (l, m) => logs.push([l, m]), relayer: fakeRelayer });
    r.fetchRedeemablePositions = async () => ({ ok: true, positions: [], count: 0 });
    r.queueCondition('0x' + 'ab'.repeat(32), { title: 'btc-updown-5m-2', shares: 5, tokenIds: ['111'] });
    const res = await r.sweep();
    assert.strictEqual(res.redeemed, 1, 'must still redeem: ' + res.reason);
    assert.strictEqual(submitted.length, 1);
    assert.ok(logs.some(l => l[0] === 'WARN' && /resolution check unavailable/.test(l[1])),
      'and must say it could not verify');
  });

  t('but a definite "not resolved on-chain" still blocks the submission', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    cfg.redeem.verifyOnChain = true;
    const submitted = [];
    const fakeRelayer = {
      isConfigured: () => true, txType: () => 'WALLET', getStatus: () => ({}),
      async execute(c) { submitted.push(c); return { ok: true, transactionID: 't' }; },
      async waitForTransaction() { return { ok: true, state: 'STATE_MINED' }; },
      async readCondition() { return { resolved: false, winningIndexSets: [], payoutDenominator: '0' }; },
      async holdsAnyToken() { return true; },
    };
    const auth = { signatureType: 3, wallet: new Wallet(TEST_PK), funderAddress: '0x' + '11'.repeat(20), syncBalanceAllowance: async () => null };
    const r = new Redeemer(cfg, auth, { log: () => {}, relayer: fakeRelayer });
    r.fetchRedeemablePositions = async () => ({
      ok: true,
      positions: [normalisePosition({ conditionId: '0x' + 'aa'.repeat(32), asset: '1', size: 3, currentValue: 3 })],
    });
    const res = await r.sweep();
    assert.strictEqual(res.redeemed, 0);
    assert.strictEqual(res.skipped, 1);
    assert.strictEqual(submitted.length, 0, 'never spend a submission on an unresolved market');
    assert.match(res.results[0].reason, /not resolved on-chain/);
  });

  t('due() respects the sweep interval', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.redeem.everyMs = 60000;
    const r = new Redeemer(cfg, { signatureType: 3 }, { log: () => {} });
    assert.strictEqual(r.due(1_000_000), true, 'never run → due');
    r.stats.lastRunAt = new Date(1_000_000).toISOString();
    assert.strictEqual(r.due(1_000_000 + 30_000), false, 'halfway through the interval → not due');
    assert.strictEqual(r.due(1_000_000 + 61_000), true, 'past the interval → due');
    r.enabled = false;
    assert.strictEqual(r.due(1_000_000 + 61_000), false, 'disabled → never due');
  });

  // ==================================================== relayer calldata
  sec('v2.3 — relayer: calldata and wallet signature schemes');

  const CID = '0x' + 'ab'.repeat(32);

  t('standard market + pUSD routes through CtfCollateralAdapter', () => {
    const e = encodeRedeem({ conditionId: CID, negativeRisk: false, outputToken: 'pUSD' });
    assert.strictEqual(e.to, RELAYER_CONTRACTS[137].ctfCollateralAdapter);
    assert.strictEqual(e.data.slice(0, 10), '0x01b7037c', 'redeemPositions(address,bytes32,bytes32,uint256[])');
    assert.strictEqual(e.mode, 'standard/pUSD');
    // The four ABI arguments, in order.
    assert.ok(e.data.toLowerCase().includes(TOKENS.pUSD.slice(2).toLowerCase()), 'pUSD is the collateral token argument');
    assert.ok(e.data.toLowerCase().includes('0'.repeat(64)), 'parentCollectionId is 32 zero bytes');
    assert.ok(e.data.toLowerCase().includes(CID.slice(2).toLowerCase()), 'conditionId is passed through');
  });

  t('standard market + USDC.e calls the CTF directly', () => {
    const e = encodeRedeem({ conditionId: CID, negativeRisk: false, outputToken: 'usdce' });
    assert.strictEqual(e.to, RELAYER_CONTRACTS[137].ctf);
    assert.ok(e.data.toLowerCase().includes(TOKENS.usdce.slice(2).toLowerCase()));
  });

  t('neg-risk + pUSD routes through NegRiskCtfCollateralAdapter', () => {
    const e = encodeRedeem({ conditionId: CID, negativeRisk: true, outputToken: 'pUSD' });
    assert.strictEqual(e.to, RELAYER_CONTRACTS[137].negRiskCtfCollateralAdapter);
    assert.strictEqual(e.data.slice(0, 10), '0x01b7037c',
      'the adapter ignores every argument but conditionId, yet the calldata stays ABI-compatible');
  });

  t('neg-risk + USDC.e uses the two-argument adapter signature', () => {
    const e = encodeRedeem({ conditionId: CID, negativeRisk: true, outputToken: 'usdce', amounts: [12n, 0n] });
    assert.strictEqual(e.to, RELAYER_CONTRACTS[137].negRiskAdapter);
    assert.strictEqual(e.data.slice(0, 10), '0x' + require('ethers').keccak256(
      require('ethers').toUtf8Bytes('redeemPositions(bytes32,uint256[])'),
    ).slice(2, 10));
  });

  t('both index sets are passed so either outcome can be redeemed', () => {
    const e = encodeRedeem({ conditionId: CID });
    // indexSets [1,2] is ABI-encoded as a dynamic uint256[] at the tail.
    assert.ok(/0000000000000000000000000000000000000000000000000000000000000002/.test(e.data), 'array length 2');
    assert.ok(/0000000000000000000000000000000000000000000000000000000000000001/.test(e.data), 'indexSet 1');
  });

  t('a malformed condition id is rejected before anything is signed', () => {
    for (const bad of ['0xnope', CID.slice(0, 20), null, undefined, '0x' + 'g'.repeat(64)]) {
      assert.throws(() => encodeRedeem({ conditionId: bad }), /invalid conditionId/, String(bad));
    }
  });

  t('an approval encodes to the standard ERC-20 selector', () => {
    const a = encodeApprove(RELAYER_CONTRACTS[137].ctfCollateralAdapter);
    assert.strictEqual(a.to, TOKENS.pUSD);
    assert.strictEqual(a.data.slice(0, 10), '0x095ea7b3', 'approve(address,uint256)');
  });

  t('the proxy batch selector matches the ABI', () => {
    const { keccak256, toUtf8Bytes } = require('ethers');
    const expected = keccak256(toUtf8Bytes('proxy((uint8,address,uint256,bytes)[])')).slice(0, 10);
    const data = encodeProxyTransactionData([{ to: RELAYER_CONTRACTS[137].ctf, data: '0xdeadbeef', value: '0' }]);
    assert.strictEqual(data.slice(0, 10), expected);
    assert.ok(data.includes('deadbeef'), 'the inner calldata is embedded');
  });

  t('CREATE2 wallet derivations are stable and checksum-valid', () => {
    const proxy = deriveProxyWallet(TEST_ADDR);
    const safe = deriveSafeAddress(TEST_ADDR);
    assert.strictEqual(proxy, deriveProxyWallet(TEST_ADDR), 'deterministic');
    assert.notStrictEqual(proxy, safe, 'the two legacy wallet types derive differently');
    assert.strictEqual(getAddress(proxy), proxy, 'proxy address is EIP-55 valid');
    assert.strictEqual(getAddress(safe), safe, 'safe address is EIP-55 valid');
  });

  t('the Deposit Wallet batch signs as EIP-712 with the wallet as verifyingContract', async () => {
    const wallet = new Wallet(TEST_PK);
    const depositWallet = '0x' + '22'.repeat(20);
    const calls = [{ target: RELAYER_CONTRACTS[137].ctfCollateralAdapter, value: '0', data: encodeRedeem({ conditionId: CID }).data }];
    const req = await signDepositWalletBatch(wallet, {
      chainId: 137, from: TEST_ADDR, walletAddress: depositWallet, nonce: '7', deadline: '1900000000', calls,
    });
    assert.strictEqual(req.type, 'WALLET');
    assert.strictEqual(req.to, RELAYER_CONTRACTS[137].depositWalletFactory,
      'the request goes to the FACTORY...');
    assert.strictEqual(req.depositWalletParams.depositWallet, depositWallet);
    assert.strictEqual(req.nonce, '7');
    assert.deepStrictEqual(req.depositWalletParams.calls.map(c => c.target), [calls[0].target]);

    // ...while the signature is verified by the WALLET itself. Swapping those
    // two is the classic way this silently fails.
    const td = depositWalletTypedData({
      chainId: 137, walletAddress: depositWallet, nonce: '7', deadline: '1900000000', calls,
    });
    assert.strictEqual(td.domain.verifyingContract, depositWallet);
    assert.strictEqual(td.domain.name, 'DepositWallet');
    assert.strictEqual(td.domain.version, '1');
    assert.strictEqual(verifyTypedData(td.domain, td.types, td.message, req.signature), TEST_ADDR);
  });

  t('the Deposit Wallet signature recovers the signer for a multi-call batch', async () => {
    const wallet = new Wallet(TEST_PK);
    const dw = '0x' + '33'.repeat(20);
    const calls = [
      encodeApprove(RELAYER_CONTRACTS[137].ctfCollateralAdapter),
      { to: RELAYER_CONTRACTS[137].ctfCollateralAdapter, data: encodeRedeem({ conditionId: CID }).data },
    ].map(c => ({ target: c.to, value: c.value || '0', data: c.data }));
    const req = await signDepositWalletBatch(wallet, { chainId: 137, from: TEST_ADDR, walletAddress: dw, nonce: '1', deadline: '1900000000', calls });
    assert.strictEqual(req.depositWalletParams.calls.length, 2, 'an approve + redeem batch is submitted atomically');
    const td = depositWalletTypedData({ chainId: 137, walletAddress: dw, nonce: '1', deadline: '1900000000', calls });
    assert.strictEqual(verifyTypedData(td.domain, td.types, td.message, req.signature), TEST_ADDR);
  });

  t('the Safe signature is an EIP-191 signature over the SafeTx struct hash, packed r||s||v', async () => {
    const wallet = new Wallet(TEST_PK);
    const safeAddress = deriveSafeAddress(TEST_ADDR);
    const args = {
      chainId: 137, from: TEST_ADDR, safeAddress, nonce: '3',
      to: RELAYER_CONTRACTS[137].ctfCollateralAdapter, value: '0',
      data: encodeRedeem({ conditionId: CID }).data, operation: 0, metadata: 'Redeem',
    };
    const req = await signSafeTransaction(wallet, args);
    assert.strictEqual(req.type, 'SAFE');
    assert.strictEqual(req.proxyWallet, safeAddress);
    assert.strictEqual(req.signatureParams.gasPrice, '0');
    assert.strictEqual(req.signature.length, 2 + 65 * 2, 'r(32) || s(32) || v(1)');

    // The Safe verifies personal_sign(structHash), NOT a raw typed-data sig.
    const td = safeTypedData(args);
    const structHash = TypedDataEncoder.hash(td.domain, td.types, td.message);

    // v must be shifted into the EOA range (31/32) or the Safe reads it as a
    // contract signature and reverts.
    const v = parseInt(req.signature.slice(-2), 16);
    assert.ok(v === 31 || v === 32, `packed v must be 31 or 32, got ${v}`);

    // Undo the Safe's v shift and the signature must recover the signer from
    // the struct hash — i.e. it really is personal_sign(hash), correctly packed.
    const canonical = req.signature.slice(0, -2) + (v - 4).toString(16).padStart(2, '0');
    assert.strictEqual(
      require('ethers').verifyMessage(require('ethers').getBytes(structHash), canonical),
      TEST_ADDR,
      'the packed signature must recover the signer from the struct hash',
    );
  });

  t('packSafeSignature shifts both v conventions into the Safe EOA range', () => {
    for (const v of [27, 28]) {
      const sig = '0x' + '11'.repeat(32) + '22'.repeat(32) + v.toString(16).padStart(2, '0');
      const packed = packSafeSignature(sig);
      const pv = parseInt(packed.slice(-2), 16);
      assert.ok(pv === 31 || pv === 32, `v=${v} → ${pv}`);
    }
    for (const v of [0, 1]) {
      const sig = '0x' + '11'.repeat(32) + '22'.repeat(32) + v.toString(16).padStart(2, '0');
      const pv = parseInt(packSafeSignature(sig).slice(-2), 16);
      assert.ok(pv === 31 || pv === 32, `compact v=${v} → ${pv}`);
    }
    assert.throws(() => packSafeSignature('0x' + '11'.repeat(32) + '22'.repeat(32) + '09'), /invalid signature v/);
  });

  t('the legacy proxy struct hash follows the documented "rlx:" field order', () => {
    const args = {
      from: TEST_ADDR,
      to: RELAYER_CONTRACTS[137].proxyFactory,
      data: encodeProxyTransactionData([{ to: RELAYER_CONTRACTS[137].ctf, data: '0xdeadbeef', value: '0' }]),
      txFee: '0', gasPrice: '0', gasLimit: 10_000_000n, nonce: '12',
      relayHubAddress: RELAYER_CONTRACTS[137].relayHub,
      relayAddress: '0x' + '44'.repeat(20),
    };
    const h1 = proxyStructHash(args);
    assert.strictEqual(h1, proxyStructHash({ ...args }), 'deterministic');
    assert.strictEqual(h1.length, 66);
    // A different relay address must produce a different hash — that field is
    // part of the signed payload precisely so a relayer cannot be swapped.
    assert.notStrictEqual(h1, proxyStructHash({ ...args, relayAddress: '0x' + '55'.repeat(20) }));
    assert.notStrictEqual(h1, proxyStructHash({ ...args, nonce: '13' }));
  });

  t('the proxy request is signed as a personal message over that hash', async () => {
    const wallet = new Wallet(TEST_PK);
    const args = {
      from: TEST_ADDR, to: RELAYER_CONTRACTS[137].proxyFactory,
      proxyWallet: deriveProxyWallet(TEST_ADDR),
      data: encodeProxyTransactionData([{ to: RELAYER_CONTRACTS[137].ctf, data: '0xdeadbeef', value: '0' }]),
      txFee: '0', gasPrice: '0', gasLimit: 10_000_000n, nonce: '12',
      relayHubAddress: RELAYER_CONTRACTS[137].relayHub, relayAddress: '0x' + '44'.repeat(20),
      metadata: 'Redeem',
    };
    const req = await signProxyTransaction(wallet, args);
    assert.strictEqual(req.type, 'PROXY');
    assert.strictEqual(req.signatureParams.relay, args.relayAddress);
    assert.strictEqual(req.signatureParams.gasLimit, '10000000');
    assert.strictEqual(
      require('ethers').verifyMessage(
        require('ethers').getBytes(proxyStructHash({ ...args, relayHubAddress: args.relayHubAddress, relayAddress: args.relayAddress })),
        req.signature,
      ),
      TEST_ADDR,
    );
  });

  t('execute() refuses an EOA and points at the direct path', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    const rc = new RelayerClient(cfg, { signatureType: 0, wallet: new Wallet(TEST_PK), funderAddress: TEST_ADDR, signerAddress: TEST_ADDR });
    const res = await rc.execute([{ to: RELAYER_CONTRACTS[137].ctf, data: '0x00' }], 'test');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /EOA/);
    assert.match(res.error, /redeemDirect/);
  });

  t('execute() refuses with no calls and names the missing setting when unconfigured', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = null; cfg.relayer.builderApiKey = null;
    const rc = new RelayerClient(cfg, { signatureType: 3, wallet: new Wallet(TEST_PK), signerAddress: TEST_ADDR });
    assert.match((await rc.execute([])).error, /no calls/);
    const res = await rc.execute([{ to: '0x' + '11'.repeat(20), data: '0x00' }]);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /RELAYER_API_KEY/);
    assert.strictEqual(rc.isConfigured(), false);
  });

  t('a Deposit Wallet submission needs the funder address', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    const rc = new RelayerClient(cfg, { signatureType: 3, wallet: new Wallet(TEST_PK), signerAddress: TEST_ADDR, funderAddress: null });
    const res = await rc.execute([{ to: '0x' + '11'.repeat(20), data: '0x00' }]);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /POLY_FUNDER_ADDRESS/);
  });

  t('a Safe account refuses a multi-call batch rather than silently dropping calls', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = 'k'; cfg.relayer.apiKeyAddress = TEST_ADDR;
    const rc = new RelayerClient(cfg, {
      signatureType: 2, wallet: new Wallet(TEST_PK), signerAddress: TEST_ADDR, funderAddress: deriveSafeAddress(TEST_ADDR),
    });
    rc.getNonce = async () => '1';
    const res = await rc.execute([
      { to: '0x' + '11'.repeat(20), data: '0x00' },
      { to: '0x' + '22'.repeat(20), data: '0x00' },
    ]);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /one call per submission/);
  });

  t('all shipped contract addresses are 20-byte checksummed-looking hex', () => {
    for (const [name, addr] of Object.entries(RELAYER_CONTRACTS[137])) {
      assert.match(addr, /^0x[0-9a-fA-F]{40}$/, `${name} = ${addr}`);
      assert.strictEqual(getAddress(addr).toLowerCase(), addr.toLowerCase(), `${name} is not a valid address`);
    }
    for (const [name, addr] of Object.entries(TOKENS)) {
      assert.match(addr, /^0x[0-9a-fA-F]{40}$/, `${name} = ${addr}`);
    }
  });

  // ============================================================ config
  sec('v2.3 — configuration guards for the new subsystem');

  t('a zero-width exit band is a hard config error', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.exit.maxSecondsToExpiry = 5;
    cfg.exit.minSecondsToExpiry = 10;
    const errs = validateConfig(cfg);
    assert.ok(errs.some(e => /EXIT_MAX_SECONDS_TO_EXPIRY/.test(e)), errs.join(' | '));
    assert.ok(errs.some(e => /no exit can ever fire/.test(e)));
  });

  t('a conviction threshold at or below 50% is refused', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.exit.minModelProb = 0.5;
    const errs = validateConfig(cfg);
    assert.ok(errs.some(e => /EXIT_MIN_MODEL_PROB/.test(e) && /thinks are losing/.test(e)), errs.join(' | '));
  });

  t('an inverted price band is refused', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.exit.minSellPrice = 0.99;
    cfg.exit.maxSellPrice = 0.95;
    assert.ok(validateConfig(cfg).some(e => /EXIT_MIN_SELL_PRICE/.test(e)));
  });

  t('a sell price at or above $1.00 is refused', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.exit.maxSellPrice = 1.0;
    assert.ok(validateConfig(cfg).some(e => /never worth more than \$1/.test(e)));
  });

  t('an unknown redemption output token is refused', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.redeem.outputToken = 'dai';
    assert.ok(validateConfig(cfg).some(e => /REDEEM_OUTPUT_TOKEN/.test(e)));
  });

  t('an aggressive sweep interval is refused', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.redeem.everyMs = 500;
    assert.ok(validateConfig(cfg).some(e => /AUTO_REDEEM_EVERY_MS/));
  });

  t('the shipped defaults are valid', () => {
    const errs = validateConfig(CONFIG).filter(e => !/POLY_FUNDER_ADDRESS/.test(e));
    assert.deepStrictEqual(errs, [], 'the shipped exit/redeem defaults must validate');
  });

  t('turning BOTH mechanisms off warns about the drain in plain words', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.exit.enabled = false;
    cfg.redeem.enabled = false;
    const w = configWarnings(cfg).join(' | ');
    assert.match(w, /nothing converts wins back into tradeable collateral/);
    assert.match(w, /drain its balance/);
  });

  t('auto-redeem without relayer credentials warns and names where to get them', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.relayer.apiKey = null; cfg.relayer.builderApiKey = null;
    const w = configWarnings(cfg).join(' | ');
    assert.match(w, /AUTO_REDEEM=true but no RELAYER_API_KEY/);
    assert.match(w, /Settings → API Keys → Relayer API Keys/);
  });

  t('the exit band is checked against the account-wide expiry floor', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.exit.minSecondsToExpiry = 4;
    cfg.risk.minSecondsToExpiry = 10;
    const w = configWarnings(cfg).join(' | ');
    assert.match(w, /EXIT_MIN_SECONDS_TO_EXPIRY=4s is below MIN_SECONDS_TO_EXPIRY=10s/);
  });

  t('the shipped defaults do not warn about the exit band', () => {
    const w = configWarnings(CONFIG).join(' | ');
    assert.ok(!/EXIT_MIN_SECONDS_TO_EXPIRY=\d+s is below/.test(w),
      'the default exit floor should match the account-wide floor: ' + w);
  });

  return { passed, failed, failures };
};

// Allow running standalone: `node test/exit.test.js`
if (require.main === module) {

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

  (async () => {
    console.log('\nCapital recycling (exit + redemption) unit tests');
    const r = await module.exports();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      console.log('\n  Failures:');
      for (const f of r.failures) console.log(`   - ${f.name}: ${f.error.message}`);
      process.exit(1);
    }
  })();
}
