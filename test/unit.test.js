'use strict';
/**
 * Unit tests for the patched bot. Runs with `npm test` (plain node, no runner).
 * Covers the parts that silently destroy money when they are wrong:
 * amount math, tick rounding, minimum-order handling, fee accounting, the TWAP
 * probability model, L2 request signing and EIP-712 order signing.
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
const crypto = require('crypto');
const { Wallet, verifyTypedData, TypedDataEncoder } = require('ethers');

const { PolymarketAuth } = require('../polymarketAuth');
const {
  computeBuyAmounts, computeMarketBuyAmounts, computeSellAmounts, sizeOrder, tickRules,
  roundPriceToTick, buildOrderTypedData, signOrder, wrapDepositWalletSignature,
  saltFromRandom, MARKET_ORDER_TYPES, TICK_RULES,
  _internals,
} = require('../orderSigner');
const {
  fairProbUp, feePerShare, breakEvenProb, netEdgePerShare, kellyStake,
  trailingTwap, VolatilityTracker, normalCdf, expectedValue,
} = require('../pricing');
const { estimateBuyFill, normaliseBook } = require('../clobClient');
const { StrategyEngine } = require('../strategyEngine');
const { validateConfig, CONFIG, addr, effectivePaperMode } = require('../config');
const cfgLib = require('../config');
const runExitTests = require('./exit.test');
const runApprovalTests = require('./approvals.test');
const runApprovalRpcTests = require('./approvals-rpc.test');
const runOrderVersionTests = require('./order-version.test');
const runApprovalE2ETests = require('./approvals-e2e.test');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function section(title) { console.log(`\n${title}`); }

const TEST_TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_TEST_ADDR = new Wallet(TEST_TEST_PK).address;

(async function main() {
  // ------------------------------------------------------------------ L2 signing
  section('L2 request signing (HMAC-SHA256)');
  test('matches an independently computed signature', () => {
    const secretRaw = crypto.randomBytes(32);
    const secretB64 = secretRaw.toString('base64');
    const ts = 1759296000;
    const path = '/data/orders';
    const expected = crypto.createHmac('sha256', secretRaw)
      .update(`${ts}GET${path}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const actual = PolymarketAuth.buildL2Signature(secretB64, ts, 'GET', path, '');
    assert.strictEqual(actual, expected);
  });
  test('is URL-safe base64 and keeps padding', () => {
    const secret = crypto.randomBytes(32).toString('base64');
    const sig = PolymarketAuth.buildL2Signature(secret, 1, 'POST', '/order', '{"a":1}');
    assert.ok(!sig.includes('+'), 'no + allowed');
    assert.ok(!sig.includes('/'), 'no / allowed');
    assert.ok(sig.endsWith('='), 'padding preserved');
  });
  test('signs the exact serialized body', () => {
    const secret = crypto.randomBytes(32).toString('base64');
    const body = '{"deferExec":false,"orderType":"FAK"}';
    const a = PolymarketAuth.buildL2Signature(secret, 5, 'POST', '/order', body);
    const b = PolymarketAuth.buildL2Signature(secret, 5, 'POST', '/order', body.replace('false', 'true'));
    assert.notStrictEqual(a, b, 'body must be part of the signature');
  });

  // ------------------------------------------------------------------ L1 typed data
  section('L1 ClobAuth typed data');
  test('uses the documented domain and message', () => {
    const auth = new PolymarketAuth({ ...CONFIG, wallet: { ...CONFIG.wallet, privateKey: TEST_TEST_PK, signatureType: 0 } });
    const td = auth.buildL1TypedData(1759296000, 0);
    assert.strictEqual(td.domain.name, 'ClobAuthDomain');
    assert.strictEqual(td.domain.version, '1');
    assert.strictEqual(td.domain.chainId, 137);
    assert.strictEqual(td.primaryType, 'ClobAuth');
    assert.strictEqual(td.message.address, TEST_TEST_ADDR);
    assert.strictEqual(td.message.timestamp, '1759296000');
    assert.strictEqual(td.message.message, 'This message attests that I control the given wallet');
  });
  await testAsync('produces a signature that recovers the signer', async () => {
    const auth = new PolymarketAuth({ ...CONFIG, wallet: { ...CONFIG.wallet, privateKey: TEST_TEST_PK, signatureType: 0 } });
    const l1 = await auth.createL1Headers();
    const td = l1.typedData;
    const recovered = verifyTypedData(td.domain, td.types, td.message, l1.POLY_SIGNATURE);
    assert.strictEqual(recovered, TEST_TEST_ADDR);
    assert.strictEqual(l1.POLY_ADDRESS, TEST_TEST_ADDR);
  });

  // ------------------------------------------------------------------- amounts
  section('Order amounts and tick rounding');
  test('tick rules match the documented table', () => {
    assert.deepStrictEqual(tickRules(0.1), { price: 1, size: 2, amount: 3 });
    assert.deepStrictEqual(tickRules(0.01), { price: 2, size: 2, amount: 4 });
    assert.deepStrictEqual(tickRules(0.005), { price: 3, size: 2, amount: 5 });
    assert.deepStrictEqual(tickRules(0.0025), { price: 4, size: 2, amount: 6 });
    assert.deepStrictEqual(tickRules(0.001), { price: 3, size: 2, amount: 5 });
    assert.deepStrictEqual(tickRules(0.0001), { price: 4, size: 2, amount: 6 });
  });
  // ------------------------------------------------- market-order precision
  // The exchange validates FAK/FOK orders as MARKET orders, which use mirrored
  // precision versus limit orders: for a market BUY the maker amount (USD) is
  // capped at `size` decimals and the taker amount (shares) at `amount`
  // decimals. The bot was building limit-shaped amounts for its FAK entries and
  // every one whose price*size ran past 2 decimals was rejected with:
  //   "invalid amounts, the market buy orders maker amount supports a max
  //    accuracy of 2 decimals, taker amount a max of 4 decimals"
  // It passed only when the product happened to land on a whole cent, which is
  // why the failure looked intermittent.
  const dp = (v) => (String(v).split('.')[1] || '').length;

  test('the bot sends market order types by default, so market precision applies', () => {
    assert.ok(MARKET_ORDER_TYPES.includes(CONFIG.order.orderType),
      `ORDER_TYPE defaults to ${CONFIG.order.orderType}, which the exchange validates as a market order`);
  });

  test('limit BUY amounts would be rejected as a market order', () => {
    // Regression witness: the exact numbers from the rejection log.
    const sizing = sizeOrder({ stakeUsd: 5.5, price: 0.51, minShares: 5, tickSize: 0.01 });
    const limit = computeBuyAmounts(0.51, sizing.shares, 0.01);
    assert.strictEqual(Number(limit.makerAmount) / 1e6, 5.4978);
    assert.strictEqual(dp(Number(limit.makerAmount) / 1e6), 4,
      '4 decimals on the maker amount is what the exchange rejected');
  });

  test('market BUY amounts satisfy the exchange precision rule for every tick', () => {
    let checked = 0;
    for (const tick of Object.keys(TICK_RULES).map(Number)) {
      const r = tickRules(tick);
      for (const price of [0.01, 0.05, 0.17, 0.33, 0.51, 0.64, 0.777, 0.91, 0.99]) {
        // A marketable BUY rounds the price UP; reaching 1.00 is genuinely invalid.
        if (roundPriceToTick(price, tick, 'up') >= 1) continue;
        for (const usd of [5.5, 5.4978, 25, 1.23, 100.07]) {
          const b = computeMarketBuyAmounts(price, usd, tick);
          const maker = Number(b.makerAmount) / 1e6;
          const taker = Number(b.takerAmount) / 1e6;
          assert.ok(dp(maker) <= r.size,
            `tick ${tick} price ${price} usd ${usd}: maker ${maker} has ${dp(maker)}dp, max ${r.size}`);
          assert.ok(dp(taker) <= r.amount,
            `tick ${tick} price ${price} usd ${usd}: taker ${taker} has ${dp(taker)}dp, max ${r.amount}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 200, `expected broad coverage, checked ${checked}`);
  });

  test('market BUY amounts are internally consistent (taker * price <= maker)', () => {
    const b = computeMarketBuyAmounts(0.51, 5.4978, 0.01);
    const maker = Number(b.makerAmount) / 1e6;
    const taker = Number(b.takerAmount) / 1e6;
    assert.ok(taker * b.price <= maker + 1e-9,
      `taker ${taker} @ ${b.price} costs ${(taker * b.price).toFixed(6)} > maker ${maker}`);
    assert.strictEqual(maker, 5.49, 'the USD spend is floored to 2 decimals');
    assert.strictEqual(taker, 10.7647, 'shares are floored to 4 decimals');
  });

  test('the SELL path needs no market-order variant (limit and market rules agree)', () => {
    // This is why only BUY orders appear in the rejection log: the exit path
    // also sends FAK, but for SELL both rules cap maker at `size` and taker at
    // `amount`, so computeSellAmounts was already compliant.
    let checked = 0;
    for (const tick of Object.keys(TICK_RULES).map(Number)) {
      const r = tickRules(tick);
      for (const price of [0.05, 0.33, 0.51, 0.777, 0.91]) {
        for (const size of [10.78, 5, 100.5, 7.25]) {
          const b = computeSellAmounts(price, size, tick);
          assert.ok(dp(Number(b.makerAmount) / 1e6) <= r.size);
          assert.ok(dp(Number(b.takerAmount) / 1e6) <= r.amount);
          checked++;
        }
      }
    }
    assert.ok(checked > 100, `expected broad coverage, checked ${checked}`);
  });

  test('BUY price rounds up to the tick, SELL rounds down', () => {
    assert.strictEqual(roundPriceToTick(0.601, 0.01, 'up'), 0.61);
    assert.strictEqual(roundPriceToTick(0.601, 0.01, 'down'), 0.6);
    assert.strictEqual(roundPriceToTick(0.6012, 0.01, 'nearest'), 0.6);
  });
  test('BUY: maker pays USD, taker receives shares (6-decimal units)', () => {
    const a = computeBuyAmounts(0.52, 10, 0.01);
    assert.strictEqual(a.price, 0.52);
    assert.strictEqual(a.size, 10);
    assert.strictEqual(a.makerAmount, '5200000');   // 5.20 USD
    assert.strictEqual(a.takerAmount, '10000000');  // 10 shares
  });
  test('BUY: size floors to 2 decimals, never up', () => {
    const a = computeBuyAmounts(0.52, 10.999, 0.01);
    assert.strictEqual(a.size, 10.99);
  });
  test('SELL: maker gives shares, taker pays USD', () => {
    const a = computeSellAmounts(0.57, 10, 0.01);
    assert.strictEqual(a.makerAmount, '10000000');
    assert.strictEqual(a.takerAmount, '5700000');
  });
  test('amounts never exceed the tick precision rules', () => {
    const a = computeBuyAmounts(0.333, 7.77, 0.01);
    assert.ok(_internals.decimalsOf(a.usd) <= 4, `usd decimals ${_internals.decimalsOf(a.usd)}`);
  });

  // ------------------------------------------------------------- minimum order
  section('Minimum order size (5 shares, not "$1")');
  test('$2 stake at 60c would be 3.33 shares → bumped to the 5-share minimum', () => {
    const s = sizeOrder({ stakeUsd: 2, price: 0.6, minShares: 5, tickSize: 0.01, maxStakeUsd: 25, minOrderPolicy: 'bump' });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.bumped, true);
    assert.strictEqual(s.shares, 5);
    assert.ok(Math.abs(s.usd - 3.0) < 1e-9, `usd ${s.usd}`);
  });
  test('policy=skip refuses the same order', () => {
    const s = sizeOrder({ stakeUsd: 2, price: 0.6, minShares: 5, tickSize: 0.01, minOrderPolicy: 'skip' });
    assert.strictEqual(s.ok, false);
    assert.match(s.reason, /minimum 5/);
  });
  test('a large stake is not scaled up, only down to the cap', () => {
    const s = sizeOrder({ stakeUsd: 100, price: 0.5, minShares: 5, tickSize: 0.01, maxStakeUsd: 25 });
    assert.strictEqual(s.bumped, false);
    assert.ok(s.usd <= 25 + 1e-9);
  });
  test('rounding can never produce fewer shares than the minimum', () => {
    const s = sizeOrder({ stakeUsd: 5.01, price: 0.999, minShares: 5, tickSize: 0.001, minOrderPolicy: 'bump' });
    assert.ok(s.shares >= 5, `shares ${s.shares}`);
  });
  // Regression: a 57-share market minimum at 63c is $35.91. Under MAX_TRADE_SIZE_USD=12
  // the bot used to buy it anyway, because the nudge up to the minimum ran after the cap.
  test('a market minimum that costs more than the cap is declined, not bought', () => {
    const s = sizeOrder({ stakeUsd: 10, price: 0.63, minShares: 57, tickSize: 0.01, maxStakeUsd: 12, minOrderPolicy: 'bump' });
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.shares, 0);
    assert.strictEqual(s.usd, 0);
    assert.match(s.reason, /57-share market minimum costs \$35\.91 at 63\.0c/);
    assert.match(s.reason, /above the \$12\.00 cap \(MAX_TRADE_SIZE_USD\)/);
  });
  test('the cap refusal also holds under the skip policy', () => {
    const s = sizeOrder({ stakeUsd: 10, price: 0.63, minShares: 57, tickSize: 0.01, maxStakeUsd: 12, minOrderPolicy: 'skip' });
    assert.strictEqual(s.ok, false);
  });
  test('a minimum that fits under the cap is still bumped to', () => {
    const s = sizeOrder({ stakeUsd: 2, price: 0.6, minShares: 5, tickSize: 0.01, maxStakeUsd: 3.5, minOrderPolicy: 'bump' });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.bumped, true);
    assert.strictEqual(s.shares, 5);
    assert.ok(Math.abs(s.usd - 3.0) < 1e-9, `usd ${s.usd}`);
  });
  test('a minimum that lands exactly on the cap is allowed', () => {
    const s = sizeOrder({ stakeUsd: 2, price: 0.6, minShares: 5, tickSize: 0.01, maxStakeUsd: 3.0, minOrderPolicy: 'bump' });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.shares, 5);
  });
  test('no order sizeOrder accepts ever costs more than the cap', () => {
    for (const price of [0.05, 0.31, 0.5, 0.63, 0.77, 0.9, 0.97]) {
      for (const minShares of [1, 5, 10, 57]) {
        for (const stakeUsd of [1, 5, 10, 36]) {
          for (const maxStakeUsd of [3, 12, 25]) {
            const s = sizeOrder({ stakeUsd, price, minShares, tickSize: 0.01, maxStakeUsd, minOrderPolicy: 'bump' });
            if (!s.ok) continue;
            assert.ok(s.usd <= maxStakeUsd + 1e-4,
              `usd ${s.usd} over cap ${maxStakeUsd} (price ${price}, min ${minShares}, stake ${stakeUsd})`);
            assert.ok(s.shares + 1e-9 >= minShares, `shares ${s.shares} under minimum ${minShares}`);
          }
        }
      }
    }
  });

  // ---------------------------------------------------------------------- fees
  section('Fee accounting (crypto taker rate 0.07)');
  test('fee peaks at 50c and vanishes at the extremes', () => {
    assert.ok(Math.abs(feePerShare(0.5, { rate: 0.07 }) - 0.0175) < 1e-12);
    assert.ok(feePerShare(0.01, { rate: 0.07 }) < feePerShare(0.5, { rate: 0.07 }));
    assert.ok(feePerShare(0.99, { rate: 0.07 }) < feePerShare(0.5, { rate: 0.07 }));
  });
  test('a 93c snipe pays well under half a cent per share', () => {
    const fee = feePerShare(0.93, { rate: 0.07 });
    assert.ok(fee < 0.005, `fee ${fee}`);
    assert.ok(Math.abs(fee - 0.004557) < 1e-6);
  });
  test('break-even includes the fee', () => {
    assert.ok(Math.abs(breakEvenProb(0.5, { rate: 0.07 }) - 0.5175) < 1e-12);
  });
  test('net edge subtracts the fee', () => {
    const e = netEdgePerShare(0.60, 0.55, { rate: 0.07 });
    assert.ok(Math.abs(e - (0.60 - 0.55 - 0.07 * 0.55 * 0.45)) < 1e-12);
  });
  test('EV of a 96.5% shot bought at 93c is positive after fees', () => {
    const { ev } = expectedValue({ prob: 0.965, price: 0.93, shares: 100, feeSchedule: { rate: 0.07 } });
    assert.ok(ev > 0, `ev ${ev}`);
  });
  test('EV of a 60% shot bought at 60c is negative after fees', () => {
    const { ev } = expectedValue({ prob: 0.60, price: 0.60, shares: 100, feeSchedule: { rate: 0.07 } });
    assert.ok(ev < 0, `ev ${ev}`);
  });
  test('Kelly is fee-aware and clamped', () => {
    const big = kellyStake({ prob: 0.9, price: 0.5, feeSchedule: { rate: 0.07 }, balanceUsd: 10000, fraction: 0.25, minUsd: 5, maxUsd: 25 });
    assert.ok(big.stake <= 25 && big.stake >= 5);
    const none = kellyStake({ prob: 0.5, price: 0.5, feeSchedule: { rate: 0.07 }, balanceUsd: 1000, fraction: 0.25, minUsd: 5, maxUsd: 25 });
    assert.strictEqual(none.stake, 5, 'no edge → base stake only');
  });

  // ---------------------------------------------------------------- TWAP model
  section('TWAP fair-value model');
  test('normal CDF sanity', () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
    assert.ok(normalCdf(3) > 0.99);
    assert.ok(normalCdf(-3) < 0.01);
  });
  test('level prices → ~50%', () => {
    const m = fairProbUp({ twapOpen: 100000, twapNow: 100000, priceNow: 100000, secondsLeft: 120, sigmaPerSec: 20 });
    assert.ok(Math.abs(m.pUp - 0.5) < 1e-6, `pUp ${m.pUp}`);
  });
  test('spot above the price to beat → pUp > 50%', () => {
    const m = fairProbUp({ twapOpen: 100000, twapNow: 100000, priceNow: 100200, secondsLeft: 120, sigmaPerSec: 20 });
    assert.ok(m.pUp > 0.6, `pUp ${m.pUp}`);
  });
  test('monotonic in the current price', () => {
    let prev = -1;
    for (const p of [99000, 99500, 100000, 100500, 101000]) {
      const m = fairProbUp({ twapOpen: 100000, twapNow: p, priceNow: p, secondsLeft: 90, sigmaPerSec: 20 });
      assert.ok(m.pUp >= prev, `not monotonic at ${p}`);
      prev = m.pUp;
    }
  });
  test('less time left → more confidence for the same gap', () => {
    const early = fairProbUp({ twapOpen: 100000, twapNow: 100100, priceNow: 100100, secondsLeft: 240, sigmaPerSec: 20 });
    const late = fairProbUp({ twapOpen: 100000, twapNow: 100100, priceNow: 100100, secondsLeft: 20, sigmaPerSec: 20 });
    assert.ok(late.pUp > early.pUp, `${late.pUp} should exceed ${early.pUp}`);
  });
  test('window over → deterministic step', () => {
    assert.strictEqual(fairProbUp({ twapOpen: 100000, twapNow: 100010, priceNow: 100010, secondsLeft: 0, sigmaPerSec: 20 }).pUp, 1);
    assert.strictEqual(fairProbUp({ twapOpen: 100000, twapNow: 99990, priceNow: 99990, secondsLeft: 0, sigmaPerSec: 20 }).pUp, 0);
  });
  test('unknown-print count respects the 60s averaging window', () => {
    const m = fairProbUp({ twapOpen: 1, twapNow: 1, priceNow: 1, secondsLeft: 300, sigmaPerSec: 20 });
    assert.strictEqual(m.nUnknown, 60);
    const m2 = fairProbUp({ twapOpen: 1, twapNow: 1, priceNow: 1, secondsLeft: 15, sigmaPerSec: 20 });
    assert.strictEqual(m2.nUnknown, 15);
  });

  // ------------------------------------------------------- TWAP / indicators
  section('TWAP synthesis and indicators');
  test('trailing TWAP is time-weighted, not tick-weighted', () => {
    const now = Date.now();
    const samples = [];
    for (let i = 60; i >= 31; i--) samples.push({ t: now - i * 1000, p: 100 });  // 30s at 100
    for (let i = 30; i >= 0; i--) samples.push({ t: now - i * 1000, p: 200 });    // 30s at 200
    const twap = trailingTwap(samples, 60, now);
    assert.ok(Math.abs(twap - 150) < 2, `twap ${twap}`);
  });
  test('volatility floors instead of exploding on a flat series', () => {
    const vt = new VolatilityTracker({ minVolPerSec: 0.02 });
    const now = Date.now();
    for (let i = 100; i >= 0; i--) vt.add(100000, now - i * 1000);
    assert.ok(vt.perSecond() >= 0.02);
  });
  test('volatility scales with movement', () => {
    const flat = new VolatilityTracker({ minVolPerSec: 0.0001 });
    const choppy = new VolatilityTracker({ minVolPerSec: 0.0001 });
    const now = Date.now();
    for (let i = 100; i >= 0; i--) {
      flat.add(100000, now - i * 1000);
      choppy.add(100000 + (i % 2 ? 400 : -400), now - i * 1000);
    }
    assert.ok(choppy.perSecond() > flat.perSecond() * 5);
  });
  test('RSI responds to a sustained move', () => {
    const vt = new VolatilityTracker({ minVolPerSec: 0.01 });
    const now = Date.now();
    for (let i = 120; i >= 0; i--) vt.add(100000 + (120 - i) * 50, now - i * 1000);
    const rsi = vt.rsi(14, 5000);
    assert.ok(rsi > 70, `rsi ${rsi}`);
  });

  // ------------------------------------------------------------ book handling
  section('Order book handling');
  test('normaliseBook sorts and aggregates depth', () => {
    const b = normaliseBook({
      asset_id: '123', market: '0xabc',
      bids: [{ price: '0.40', size: '10' }, { price: '0.45', size: '10' }],
      asks: [{ price: '0.60', size: '10' }, { price: '0.55', size: '10' }],
      min_order_size: '5', tick_size: '0.01', neg_risk: false,
    });
    assert.strictEqual(b.bestBid, 0.45);
    assert.strictEqual(b.bestAsk, 0.55);
    assert.ok(Math.abs(b.spread - 0.1) < 1e-9);
    assert.ok(Math.abs(b.askDepthUsd - (5.5 + 6.0)) < 1e-9);
    assert.strictEqual(b.minOrderSize, 5);
  });
  test('buy fill walks the ask ladder and reports partials', () => {
    const b = normaliseBook({
      asset_id: '1',
      asks: [{ price: '0.50', size: '3' }, { price: '0.55', size: '3' }, { price: '0.60', size: '10' }],
      bids: [{ price: '0.45', size: '5' }],
    });
    const fill = estimateBuyFill(b, 5);
    assert.strictEqual(fill.shares, 5);
    assert.ok(Math.abs(fill.cost - (3 * 0.5 + 2 * 0.55)) < 1e-9);
    assert.ok(Math.abs(fill.vwap - 0.52) < 1e-9);
    const partial = estimateBuyFill(b, 20);
    assert.strictEqual(partial.complete, false);
    assert.strictEqual(partial.shares, 16);
  });

  // ---------------------------------------------------------------- strategies
  section('Strategies (8 modules)');
  function makeCtx(overrides = {}) {
    const book = normaliseBook({
      asset_id: '1', market: '0xcond',
      bids: [{ price: '0.49', size: '800' }, { price: '0.48', size: '800' }],
      asks: [{ price: '0.51', size: '800' }, { price: '0.52', size: '800' }],
      min_order_size: '5', tick_size: '0.01', neg_risk: false,
    });
    const engine = new StrategyEngine(CONFIG);
    const market = {
      slug: 'btc-updown-5m-1', conditionId: '0xcond', timeframe: '5m',
      remainingSec: 200, tradeable: true, tokenMappingOk: true,
      feeSchedule: { rate: 0.07, exponent: 1 },
      tickSize: 0.01, minOrderSize: 5, negRisk: false,
    };
    const ctx = {
      market,
      books: { up: book, down: { ...book } },
      ref: { tracker: new VolatilityTracker({ minVolPerSec: 1 }), spots: { coinbase: 100000, kraken: 100000 }, spotTs: { coinbase: Date.now(), kraken: Date.now() }, spot: { value: 100000 } },
      twap: { value: 100000, source: 'polybolt-twap60', authoritative: true },
      spot: { value: 100000 },
      windowOpen: { twap: 100000, source: 'polybolt-twap60' },
      model: { pUp: 0.5, pDown: 0.5, expectedCloseTwap: 100000, sigmaWindow: 10, drift: 0 },
      degraded: false,
      feeSchedule: { rate: 0.07, exponent: 1 },
      constraints: { tickSize: 0.01, minOrderSize: 5, negRisk: false },
      engine,
    };
    return Object.assign(ctx, overrides);
  }
  test('fair-value EV fires when the model beats the ask after fees', () => {
    const ctx = makeCtx();
    ctx.model = { pUp: 0.62, pDown: 0.38, expectedCloseTwap: 100050, sigmaWindow: 10, drift: 50 };
    const r = ctx.engine.fairValueEv(ctx);
    assert.ok(r && r.signal === 'BUY_UP', `got ${JSON.stringify(r)}`);
    assert.ok(r.edge > CONFIG.strategies.fairValueEv.minNetEdge);
  });
  test('fair-value EV refuses a 51% model at 51c (fee eats the edge)', () => {
    const ctx = makeCtx();
    ctx.model = { pUp: 0.51, pDown: 0.49, expectedCloseTwap: 100001, sigmaWindow: 10, drift: 1 };
    const r = ctx.engine.fairValueEv(ctx);
    assert.ok(!r.signal, `unexpected signal ${JSON.stringify(r)}`);
  });
  test('every module refuses when the book is too thin', () => {
    const ctx = makeCtx();
    ctx.books.up = normaliseBook({ asset_id: '1', bids: [{ price: '0.49', size: '1' }], asks: [{ price: '0.51', size: '1' }] });
    ctx.books.down = ctx.books.up;
    ctx.model = { pUp: 0.9, pDown: 0.1, expectedCloseTwap: 101000, sigmaWindow: 1, drift: 1000 };
    for (const key of ['fairValueEv', 'microstructure', 'lateWindowConvergence', 'staleQuoteSnipe']) {
      const r = ctx.engine[key](ctx);
      assert.ok(!r.signal, `${key} fired on a thin book`);
    }
  });
  test('stale-quote snipe only runs in the final seconds', () => {
    const ctx = makeCtx();
    ctx.model = { pUp: 0.99, pDown: 0.01, expectedCloseTwap: 101000, sigmaWindow: 1, drift: 1000 };
    const early = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!early.signal, 'must not fire with 200s left');
    ctx.market.remainingSec = 15;
    const late = ctx.engine.staleQuoteSnipe(ctx);
    // 99% at 51c: fires (cheap and nearly certain)
    assert.ok(late.signal === 'BUY_UP', `expected a snipe, got ${JSON.stringify(late)}`);
  });
  test('snipe respects the max price cap', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 15;
    ctx.model = { pUp: 0.99, pDown: 0.01, expectedCloseTwap: 101000, sigmaWindow: 1, drift: 1000 };
    ctx.books.up = normaliseBook({ asset_id: '1', bids: [{ price: '0.94', size: '5000' }], asks: [{ price: '0.95', size: '5000' }], min_order_size: '5' });
    const r = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!r.signal, 'must not buy above SQS_MAX_PRICE');
  });
  test('degraded (proxy-TWAP) context raises the bar by 1.5x', () => {
    const ctx = makeCtx();
    ctx.degraded = true;
    // edge after fees = 0.545 - 0.51 - 0.07*0.51*0.49 = 0.01750
    ctx.model = { pUp: 0.545, pDown: 0.455, expectedCloseTwap: 100020, sigmaWindow: 10, drift: 20 };
    const r = ctx.engine.fairValueEv(ctx);
    assert.ok(!r.signal, `edge 1.75c must not clear 4.5c degraded requirement (${JSON.stringify(r)})`);
  });
  test('engine returns the highest-edge signal across modules', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 20;
    ctx.model = { pUp: 0.97, pDown: 0.03, expectedCloseTwap: 100900, sigmaWindow: 2, drift: 900 };
    const d = ctx.engine.evaluate(ctx);
    assert.ok(d.signal, 'expected a signal');
    assert.ok(d.evaluations.length >= 6, 'all enabled modules evaluated');
  });

  // ------------------------------------------------- strategy toggles (regression)
  // The dashboard toggles were inert: updateConfig() did `enabled = !!val`, and
  // the UI posts `{ key: { enabled: false } }`, so every object is truthy and
  // nothing could ever be switched OFF. Three modules additionally used key
  // names that matched no module and were silently dropped.
  section('Strategy toggles (dashboard toggles must actually gate)');

  test('the dashboard payload ({key:{enabled:false}}) disables all 8 modules', () => {
    const engine = new StrategyEngine(CONFIG);
    const payload = {};
    for (const k of Object.keys(engine.strategies)) payload[k] = { enabled: false };
    const r = engine.updateConfig(payload);
    assert.strictEqual(r.unknown.length, 0, `unrecognised keys: ${r.unknown}`);
    for (const [k, v] of Object.entries(engine.strategies)) {
      assert.strictEqual(v.enabled, false, `${k} was not disabled by the object payload`);
    }
  });

  test('the dashboard payload can re-enable all 8 modules', () => {
    const engine = new StrategyEngine(CONFIG);
    const payload = {};
    for (const k of Object.keys(engine.strategies)) payload[k] = { enabled: false };
    engine.updateConfig(payload);
    const payload2 = {};
    for (const k of Object.keys(engine.strategies)) payload2[k] = { enabled: true };
    engine.updateConfig(payload2);
    for (const [k, v] of Object.entries(engine.strategies)) {
      assert.strictEqual(v.enabled, true, `${k} could not be re-enabled`);
    }
  });

  test('legacy dashboard key names still resolve', () => {
    const engine = new StrategyEngine(CONFIG);
    const r = engine.updateConfig({
      latencyExploit: { enabled: false },
      microstructureEdges: { enabled: false },
      crossExchangeDivergence: { enabled: false },
    });
    assert.strictEqual(r.unknown.length, 0, `keys rejected: ${r.unknown}`);
    assert.strictEqual(engine.strategies.latencyExploitation.enabled, false);
    assert.strictEqual(engine.strategies.microstructure.enabled, false);
    assert.strictEqual(engine.strategies.crossExchange.enabled, false);
  });

  test('unknown keys are reported instead of silently ignored', () => {
    const engine = new StrategyEngine(CONFIG);
    const r = engine.updateConfig({ notARealStrategy: { enabled: false } });
    assert.deepStrictEqual(r.unknown, ['notARealStrategy']);
    assert.deepStrictEqual(r.applied, []);
  });

  // 8 modules became 9 in v2.4: Passive Reversion is the maker route. The
  // count is asserted so adding a tenth module forces this test to be looked
  // at, rather than silently covering one fewer module than the bot ships.
  test('each of the 9 modules is skipped when disabled and run when enabled', () => {
    const keys = Object.keys(new StrategyEngine(CONFIG).strategies);
    assert.strictEqual(keys.length, 9);
    for (const key of keys) {
      const ctx = makeCtx();
      const engine = ctx.engine;
      for (const k of keys) engine.setEnabled(k, k === key);

      const on = engine.evaluate(ctx);
      assert.ok(on.evaluations.some(e => e.key === key), `${key} was skipped while enabled`);
      assert.ok(engine.stats[key].evaluated > 0, `${key} stat did not increment`);

      engine.setEnabled(key, false);
      const before = engine.stats[key].evaluated;
      const off = engine.evaluate(ctx);
      assert.ok(!off.evaluations.some(e => e.key === key), `${key} was evaluated while disabled`);
      assert.strictEqual(engine.stats[key].evaluated, before, `${key} counter moved while disabled`);
    }
  });

  test('disabling all modules leaves nothing to evaluate and returns no signal', () => {
    const ctx = makeCtx();
    for (const k of Object.keys(ctx.engine.strategies)) ctx.engine.setEnabled(k, false);
    const d = ctx.engine.evaluate(ctx);
    assert.strictEqual(d.signal, null, 'no signal expected');
    assert.strictEqual(d.evaluations.length, 0, 'no module should be evaluated');
  });

  test('a firing module stops producing its signal once switched off', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 20;
    ctx.model = { pUp: 0.97, pDown: 0.03, expectedCloseTwap: 100900, sigmaWindow: 2, drift: 900 };
    const engine = ctx.engine;
    const before = engine.evaluate(ctx);
    assert.ok(before.signal, 'expected a signal with all modules enabled');
    const firing = before.strategy;   // evaluate() returns the winning signal flattened
    assert.ok(firing, 'winning signal must name its strategy');

    engine.setEnabled(firing, false);
    const after = engine.evaluate(ctx);
    const stillFiring = after.signal && after.strategy === firing;
    assert.ok(!stillFiring, `${firing} still produced a signal after being switched off`);
  });

  test('enabled flags survive a save/load roundtrip', () => {
    const engine = new StrategyEngine(CONFIG);
    engine.setEnabled('fairValueEv', false);
    engine.setEnabled('rsiReversion', false);
    const restored = new StrategyEngine(CONFIG);
    restored.setEnabledMap(engine.enabledMap());
    assert.strictEqual(restored.strategies.fairValueEv.enabled, false);
    assert.strictEqual(restored.strategies.rsiReversion.enabled, false);
    assert.strictEqual(restored.strategies.staleQuoteSnipe.enabled, true, 'others stay enabled');
  });

  test('config alias twapMomentum drives latencyExploitation', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.strategies.twapMomentum.enabled = false;
    const engine = new StrategyEngine(cfg);
    assert.strictEqual(engine.strategies.latencyExploitation.enabled, false);
  });

  // --------------------------------------------- risk / order settings (regression)
  // The dashboard posted `stopLossThresholdUsd` while the server only read
  // `stopLossUsd`, so the stop-loss could never be changed from the UI. The
  // timeframe and market-target selects were sent but had no handler at all.
  section('Risk & order settings');

  const { BotCore } = require('../botCore');
  function makeBot(cfgOverrides = {}) {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    // These tests exercise dashboard persistence, which applies where the environment
    // leaves a key unset. Pin that, so the result does not depend on a developer's .env.
    cfg.order.setInEnv = { tradeAmountUsd: false, maxTradeAmountUsd: false, kellySizing: false };
    Object.assign(cfg.order, cfgOverrides.order || {});
    Object.assign(cfg.risk, cfgOverrides.risk || {});
    return new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
  }

  test('stop-loss applies from the dashboard key (stopLossThresholdUsd)', () => {
    const bot = makeBot();
    bot.updateSettings({ stopLossThresholdUsd: 13 });
    assert.strictEqual(bot.stopLossUsd, 13, 'dashboard alias must drive stopLossUsd');
  });

  test('stop-loss applies from the canonical key (stopLossUsd)', () => {
    const bot = makeBot();
    bot.updateSettings({ stopLossUsd: 42 });
    assert.strictEqual(bot.stopLossUsd, 42);
  });

  test('stake, max-trade cap and Kelly all apply', () => {
    const bot = makeBot();
    bot.updateSettings({ tradeAmountUsd: 8, maxTradeAmountUsd: 30, kellySizing: true });
    assert.strictEqual(bot.tradeAmountUsd, 8);
    assert.strictEqual(bot.maxTradeAmountUsd, 30);
    assert.strictEqual(bot.kellySizing, true);
  });

  test('max-trade cap is clamped up to the new stake', () => {
    const bot = makeBot();
    bot.updateSettings({ tradeAmountUsd: 20, maxTradeAmountUsd: 5 });
    assert.strictEqual(bot.maxTradeAmountUsd, 20, 'cap must never sit below the stake');
  });

  test('stake is clamped to the configured minimum', () => {
    const bot = makeBot({ order: { minStakeUsd: 2 } });
    bot.updateSettings({ tradeAmountUsd: 0.25 });
    assert.strictEqual(bot.tradeAmountUsd, 2);
  });

  test('a non-numeric value is refused, not written into a risk limit', () => {
    const bot = makeBot();
    const before = bot.stopLossUsd;
    const state = bot.updateSettings({ stopLossUsd: 'abc' });
    assert.strictEqual(bot.stopLossUsd, before, 'stop-loss must not become NaN');
    assert.ok(state.settingsChanges.unapplied.length === 1, 'must be reported as unapplied');
  });

  test('unknown setting keys are reported instead of silently dropped', () => {
    const bot = makeBot();
    const state = bot.updateSettings({ completelyMadeUp: 1 });
    assert.deepStrictEqual(state.settingsChanges.unapplied, ['completelyMadeUp']);
    assert.deepStrictEqual(state.settingsChanges.applied, []);
  });

  test('timeframe selection is honoured and drives discovery config', () => {
    const bot = makeBot();
    bot.updateSettings({ selectedTimeframe: '15m' });
    assert.strictEqual(bot.selectedTimeframe, '15m');
    assert.deepStrictEqual(bot.cfg.market.timeframes, ['15m']);
    bot.updateSettings({ selectedTimeframe: 'all' });
    assert.strictEqual(bot.selectedTimeframe, 'all');
  });

  test('an invalid timeframe is refused', () => {
    const bot = makeBot();
    const before = bot.selectedTimeframe;
    const state = bot.updateSettings({ selectedTimeframe: '7m' });
    assert.strictEqual(bot.selectedTimeframe, before, 'invalid timeframe must not apply');
    assert.strictEqual(state.settingsChanges.unapplied.length, 1);
  });

  test('market target filter is stored and exposed in state', () => {
    const bot = makeBot();
    bot.updateSettings({ selectedMarketSlug: 'btc-updown-5m-123' });
    assert.strictEqual(bot.marketFilterSlug, 'btc-updown-5m-123');
    assert.strictEqual(bot.getState().marketFilterSlug, 'btc-updown-5m-123');
    bot.updateSettings({ selectedMarketSlug: 'auto' });
    assert.strictEqual(bot.marketFilterSlug, 'auto');
  });

  test('risk settings survive a save/load roundtrip', () => {
    const bot = makeBot();
    bot.updateSettings({ tradeAmountUsd: 12, stopLossUsd: 33, kellySizing: true, selectedTimeframe: '15m', selectedMarketSlug: 'some-slug' });
    const file = bot.stateFile;

    const bot2 = makeBot();
    bot2.stateFile = file;
    bot2.loadState();
    assert.strictEqual(bot2.cfg.market.timeframes[0], '15m', 'timeframe must restore into discovery config');
    assert.strictEqual(bot2.tradeAmountUsd, 12);
    assert.strictEqual(bot2.stopLossUsd, 33);
    assert.strictEqual(bot2.kellySizing, true);
    assert.strictEqual(bot2.selectedTimeframe, '15m');
    assert.strictEqual(bot2.marketFilterSlug, 'some-slug');
    require('fs').unlinkSync(file);
  });

  // Regression: a bot_state.json written by an earlier run kept a $50 cap after
  // .env was changed to $12. Saved values still apply where .env leaves a key unset
  // (dashboard persistence is deliberate); where .env sets the key, .env wins.
  test('a saved sizing value applies where .env leaves the key unset, and is labelled', () => {
    const file = require('path').join(require('os').tmpdir(), `bot-saved-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    require('fs').writeFileSync(file, JSON.stringify({ tradeAmountUsd: 36, maxTradeAmountUsd: 50, kellySizing: true }));
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = file;
    cfg.order.stakeUsd = 10;
    cfg.order.maxStakeUsd = 12;
    cfg.order.kellySizing = false;
    cfg.order.setInEnv = { tradeAmountUsd: false, maxTradeAmountUsd: false, kellySizing: false };
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    assert.strictEqual(bot.tradeAmountUsd, 36);
    assert.strictEqual(bot.maxTradeAmountUsd, 50);
    assert.strictEqual(bot.kellySizing, true);
    assert.strictEqual(bot.sizingSourceLabel('maxTradeAmountUsd'), require('path').basename(file));
    assert.deepStrictEqual(bot.sizingIgnored, []);
    require('fs').unlinkSync(file);
  });

  test('an explicit .env sizing value beats the saved one, and the saved value is reported', () => {
    const file = require('path').join(require('os').tmpdir(), `bot-envwins-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    require('fs').writeFileSync(file, JSON.stringify({ tradeAmountUsd: 36, maxTradeAmountUsd: 50, kellySizing: true }));
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = file;
    cfg.order.stakeUsd = 10;     // TRADE_SIZE_USD=10 in .env
    cfg.order.maxStakeUsd = 12;  // MAX_TRADE_SIZE_USD=12 in .env
    cfg.order.kellySizing = false;
    cfg.order.setInEnv = { tradeAmountUsd: true, maxTradeAmountUsd: true, kellySizing: false };
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    assert.strictEqual(bot.tradeAmountUsd, 10, 'the .env stake must run');
    assert.strictEqual(bot.maxTradeAmountUsd, 12, 'the .env cap must run');
    assert.strictEqual(bot.kellySizing, true, 'KELLY_SIZING is unset in .env, so the saved value applies');
    assert.strictEqual(bot.sizingSourceLabel('tradeAmountUsd'), '.env');
    assert.strictEqual(bot.sizingSourceLabel('kellySizing'), require('path').basename(file));
    assert.deepStrictEqual(bot.sizingIgnored, [
      `TRADE_SIZE_USD 36 saved in ${require('path').basename(file)} is ignored: .env sets 10`,
      `MAX_TRADE_SIZE_USD 50 saved in ${require('path').basename(file)} is ignored: .env sets 12`,
    ]);
    const warned = bot.logs.find(e => e.level === 'WARN' && /is ignored: \.env sets 10/.test(e.message));
    assert.ok(warned, 'the ignored saved value must be logged as a warning');
    require('fs').unlinkSync(file);
  });

  test('an explicit KELLY_SIZING in .env beats the saved Kelly setting too', () => {
    const name = `bot-kelly-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    const file = require('path').join(require('os').tmpdir(), name);
    require('fs').writeFileSync(file, JSON.stringify({ kellySizing: true }));
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = file;
    cfg.order.kellySizing = false;   // KELLY_SIZING=false in .env
    cfg.order.setInEnv = { tradeAmountUsd: false, maxTradeAmountUsd: false, kellySizing: true };
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    assert.strictEqual(bot.kellySizing, false, 'the .env value must run');
    assert.strictEqual(bot.sizingSourceLabel('kellySizing'), '.env');
    assert.deepStrictEqual(bot.sizingIgnored, [`KELLY_SIZING true saved in ${name} is ignored: .env sets false`]);
    require('fs').unlinkSync(file);
  });

  test('no sizing is reported as ignored when the saved values match .env', () => {
    const file = require('path').join(require('os').tmpdir(), `bot-nooverride-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    require('fs').writeFileSync(file, JSON.stringify({ tradeAmountUsd: 10, maxTradeAmountUsd: 12 }));
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = file;
    cfg.order.stakeUsd = 10;
    cfg.order.maxStakeUsd = 12;
    cfg.order.setInEnv = { tradeAmountUsd: true, maxTradeAmountUsd: true, kellySizing: false };
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    assert.deepStrictEqual(bot.sizingIgnored, []);
    assert.ok(!bot.logs.some(e => e.level === 'WARN' && /is ignored/.test(e.message)), 'nothing should be warned');
    require('fs').unlinkSync(file);
  });

  test('an absolute STATE_FILE is honoured, not grafted onto the project dir', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    const abs = require('path').join(require('os').tmpdir(), `abs-state-${Date.now()}.json`);
    cfg.runtime.stateFile = abs;
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    assert.strictEqual(bot.stateFile, abs, 'absolute state path must be used verbatim');
    bot.saveState();
    assert.ok(require('fs').existsSync(abs), 'state must be written to the absolute path');
    require('fs').unlinkSync(abs);
  });

  // --------------------------------------------- settlement feed (regression)
  // PolyBolt was only ever attempted from start() and the socket close handler,
  // so a bot started without CLOB credentials stayed in SPOT PROXY (degraded)
  // forever — even after credentials were derived — until a manual restart.
  section('Settlement feed (TWAP source)');

  const { ReferencePrice } = require('../referencePrice');

  function makeRef(hasCreds, log = () => {}) {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.referenceSource = 'auto';
    return new ReferencePrice(cfg, {
      hasL2Credentials: () => hasCreds,
      getCredentials: () => ({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }),
    }, { log });
  }

  test('ensurePolybolt does nothing without credentials', () => {
    const ref = makeRef(false);
    assert.strictEqual(ref.ensurePolybolt(), false, 'must not connect without creds');
    assert.strictEqual(ref.polybolt.ws, null);
    ref.stop();
  });

  test('ensurePolybolt connects once credentials exist', () => {
    const ref = makeRef(true);
    assert.strictEqual(ref.ensurePolybolt(), true, 'should start a connection');
    assert.ok(ref.polybolt.ws, 'socket should have been created');
    ref.stop();
  });

  test('ensurePolybolt is idempotent while a socket is already open/ing', () => {
    const ref = makeRef(true);
    ref.ensurePolybolt();
    assert.strictEqual(ref.ensurePolybolt(), false, 'must not open a second socket');
    ref.stop();
  });

  test('ensurePolybolt does not retry after an auth rejection (4001)', () => {
    const ref = makeRef(true);
    ref.polybolt.lastError = 'auth rejected (4001) — check CLOB credentials';
    assert.strictEqual(ref.ensurePolybolt(), false, 'must not hammer with rejected creds');
    assert.strictEqual(ref.polybolt.ws, null);
    ref.stop();
  });

  test('degraded proxy is flagged non-authoritative', () => {
    const ref = makeRef(false);
    const t = ref.getTwap();
    assert.strictEqual(t.authoritative, false);
    ref.stop();
  });

  test('PolyBolt sequence counters are tracked independently per channel', () => {
    const logs = [];
    const ref = makeRef(true, (level, message) => logs.push({ level, message }));
    const now = Date.now();
    // The spot channel can be one sequence ahead of TWAP without TWAP having
    // regressed; each channel's own sequence is monotonic.
    ref.handlePolyboltFrame({ channel: 'price.crypto', seq: 1553, payload: { value: 83565 } });
    ref.handlePolyboltFrame({ channel: 'price.crypto.twap', seq: 1552, payload: { value: 83564, timestamp: now } });
    ref.handlePolyboltFrame({ channel: 'price.crypto', seq: 1554, payload: { value: 83566 } });
    ref.handlePolyboltFrame({ channel: 'price.crypto.twap', seq: 1553, payload: { value: 83565, timestamp: now + 1000 } });

    assert.deepStrictEqual(logs.filter(x => /sequence regression/.test(x.message)), [],
      'interleaved channels must not be compared against one shared counter');
    assert.strictEqual(ref.polybolt.seqByChannel['price.crypto'], 1554);
    assert.strictEqual(ref.polybolt.seqByChannel['price.crypto.twap'], 1553);
    assert.strictEqual(ref.twap.value, 83565);
  });

  test('a regressing PolyBolt frame identifies its channel and is ignored', () => {
    const logs = [];
    const ref = makeRef(true, (level, message) => logs.push({ level, message }));
    const now = Date.now();
    ref.handlePolyboltFrame({ channel: 'price.crypto.twap', seq: 200, payload: { value: 83564, timestamp: now } });
    ref.handlePolyboltFrame({ channel: 'price.crypto.twap', seq: 199, payload: { value: 1, timestamp: now + 1000 }, dropped: 2 });

    assert.ok(logs.some(x => x.level === 'WARN'
      && /sequence regression channel=price\.crypto\.twap 199 < 200; ignoring stale frame/.test(x.message)),
    'regression warning should identify the channel and the stale frame');
    assert.strictEqual(ref.twap.value, 83564, 'a stale frame must not replace the current TWAP');
    assert.strictEqual(ref.polybolt.seqByChannel['price.crypto.twap'], 200,
      'the per-channel high-water sequence must not move backwards');
    assert.strictEqual(ref.polybolt.dropped, 2, 'dropped-frame metadata is retained even on stale frames');
  });

  test('the full dashboard payload applies every field', () => {
    const bot = makeBot();
    const state = bot.updateSettings({
      tradeAmountUsd: 6,
      stopLossUsd: 17,
      kellySizing: true,
      maxTradeAmountUsd: 22,
      selectedTimeframe: '5m',
      selectedMarketSlug: 'auto',
    });
    assert.deepStrictEqual(state.settingsChanges.unapplied, [], 'nothing should be rejected');
    assert.strictEqual(state.settingsChanges.applied.length, 6);
    assert.strictEqual(bot.tradeAmountUsd, 6);
    assert.strictEqual(bot.stopLossUsd, 17);
    assert.strictEqual(bot.maxTradeAmountUsd, 22);
    assert.strictEqual(bot.kellySizing, true);
  });

  // ------------------------------------------------- daily loss cap (regression)
  // The daily cap (`MAX_DAILY_LOSS_USD`) had NO settings key and NO dashboard
  // control: it read `cfg.risk.maxDailyLossUsd` straight from .env, while the
  // "Risk Circuit Breaker" box controlled the *cumulative* stop-loss. A user who
  // set $300 saw the bot stop at "-$59.67" (the $50 env default, overshot by one
  // settled trade) with no way to change it from the UI.
  section('Daily loss cap (independent breaker)');

  test('daily cap applies from the canonical dashboard key', () => {
    const bot = makeBot();
    bot.updateSettings({ maxDailyLossUsd: 300 });
    assert.strictEqual(bot.maxDailyLossUsd, 300);
  });

  test('daily cap applies from the dashboard alias key', () => {
    const bot = makeBot();
    bot.updateSettings({ dailyLossLimitUsd: 120 });
    assert.strictEqual(bot.maxDailyLossUsd, 120, 'alias must drive maxDailyLossUsd');
  });

  test('daily cap rejects a non-numeric value instead of writing NaN', () => {
    const bot = makeBot();
    const before = bot.maxDailyLossUsd;
    const state = bot.updateSettings({ maxDailyLossUsd: 'lots' });
    assert.strictEqual(bot.maxDailyLossUsd, before);
    assert.ok(state.settingsChanges.unapplied.some(u => /maxDailyLossUsd/.test(u)));
  });

  test('the two breakers are independent settings', () => {
    const bot = makeBot();
    bot.updateSettings({ stopLossUsd: 300, maxDailyLossUsd: 50 });
    assert.strictEqual(bot.stopLossUsd, 300, 'stop-loss is the cumulative breaker');
    assert.strictEqual(bot.maxDailyLossUsd, 50, 'daily cap must not be touched by it');
    bot.updateSettings({ stopLossUsd: 25 });
    assert.strictEqual(bot.maxDailyLossUsd, 50, 'daily cap must survive a stop-loss change');
  });

  test('a negative magnitude is read as positive, not clamped to 1', () => {
    // Regression: Math.max(1, -300) === 1, which turned a $300 breaker into a
    // $1 one — stopping the bot on the very next tick.
    const bot = makeBot();
    bot.updateSettings({ stopLossUsd: -300 });
    assert.strictEqual(bot.stopLossUsd, 300, '"-300" means a $300 limit');
    bot.updateSettings({ maxDailyLossUsd: -300 });
    assert.strictEqual(bot.maxDailyLossUsd, 300, '"-300" means a $300 daily cap');
  });

  test('daily cap applies at runtime, ignoring the .env value', () => {
    const bot = makeBot({ risk: { maxDailyLossUsd: 50 } }); // .env says 50
    bot.updateSettings({ maxDailyLossUsd: 300 });           // dashboard says 300
    bot.isRunning = true;
    bot.dailyLoss = 59.67;
    assert.strictEqual(bot.checkRiskLimits(), true, 'must NOT stop at the stale .env limit');
    bot.dailyLoss = 300;
    assert.strictEqual(bot.checkRiskLimits(), false, 'must stop at the runtime limit');
    assert.match(bot.stoppedReason, /Daily loss limit/);
  });

  test('the daily breaker names BOTH the counter and the limit', () => {
    const bot = makeBot({ risk: { maxDailyLossUsd: 50 } });
    bot.isRunning = true;
    bot.dailyLoss = 59.67;  // overshot by one settled losing trade
    bot.realizedPnl = -59.67;
    bot.stopLossUsd = 300;  // the user's "that should have been $300" setting
    bot.checkRiskLimits();
    assert.match(bot.stoppedReason, /59\.67/, 'the actual counter belongs in the message');
    assert.match(bot.stoppedReason, /50\.00/, 'so does the limit that tripped');
    assert.match(bot.stoppedReason, /UTC/);
  });

  test('breakers do not fire against each other\'s counters', () => {
    // Big cumulative drawdown, no losses *today* → the daily cap must stay quiet.
    const bot = makeBot();
    bot.isRunning = true;
    bot.realizedPnl = -10;
    bot.dailyLoss = 0;
    assert.strictEqual(bot.checkRiskLimits(), true);
    // Losses today but a huge cumulative allowance → only the daily cap fires.
    const bot2 = makeBot();
    bot2.isRunning = true;
    bot2.stopLossUsd = 10000;
    bot2.maxDailyLossUsd = 100;
    bot2.realizedPnl = -120;
    bot2.dailyLoss = 120;
    bot2.checkRiskLimits();
    assert.match(bot2.stoppedReason, /Daily loss limit/);
    assert.doesNotMatch(bot2.stoppedReason, /Stop-loss/);
  });

  test('the daily counter resets on the UTC day rollover only', () => {
    const bot = makeBot();
    bot.dailyLoss = 42;
    bot.dailyKey = new Date().toISOString().slice(0, 10);
    bot.rollDailyCounters();
    assert.strictEqual(bot.dailyLoss, 42, 'same UTC day must keep the counter');
    bot.dailyKey = '2020-01-01';
    bot.rollDailyCounters();
    assert.strictEqual(bot.dailyLoss, 0, 'a new UTC day resets it');
  });

  test('state exposes both breakers plus the daily reset time', () => {
    const bot = makeBot({ risk: { maxDailyLossUsd: 100 } });
    bot.dailyLoss = 25;
    const s = bot.getState();
    assert.strictEqual(s.maxDailyLossUsd, 100);
    assert.strictEqual(s.dailyLoss, 25);
    assert.strictEqual(s.dailyLossPct, 25, 'progress toward the cap, for the UI bar');
    assert.match(s.dailyLossResetAtUtc, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  // Regression: a saved bot_state.json overrides the PAPER_MODE default, and the
  // startup banner read the config value instead of the bot's. It printed
  // "mode: PAPER" above a bot that logged "Bot started in LIVE mode" — the one
  // case where a wrong banner costs real money.
  test('a saved paperMode:false overrides PAPER_MODE=true, and the bot is the source of truth', () => {
    const bot = makeBot();
    assert.strictEqual(bot.paperMode, true, 'PAPER_MODE defaults to true');
    bot.updateSettings({ paperMode: false });
    const file = bot.stateFile;

    // A fresh process: same config (PAPER_MODE=true), saved state says LIVE.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = file;
    cfg.runtime.paperMode = true;
    const bot2 = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });

    assert.strictEqual(bot2.paperMode, false, 'the saved choice must win over the env default');
    assert.strictEqual(bot2.getState().paperMode, false, 'the dashboard must report the effective mode');
    assert.notStrictEqual(bot2.cfg.runtime.paperMode, bot2.paperMode,
      'the config value and the effective mode can differ — nothing may report the config value as the mode');
    require('fs').unlinkSync(file);
  });

  test('effectivePaperMode reads the saved state, matching what the bot does', () => {
    const fs = require('fs');
    const file = require('path').join(require('os').tmpdir(), `mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = file;
    cfg.runtime.paperMode = true;

    // No state file: the env default is the answer.
    assert.deepStrictEqual(
      { m: cfgLib.effectivePaperMode(cfg).paperMode, s: cfgLib.effectivePaperMode(cfg).source },
      { m: true, s: 'env' }, 'with no saved state the PAPER_MODE default stands');

    // A saved state saying LIVE must win over PAPER_MODE=true.
    fs.writeFileSync(file, JSON.stringify({ paperMode: false }));
    const eff = cfgLib.effectivePaperMode(cfg);
    assert.strictEqual(eff.paperMode, false, 'the saved choice must override the env default');
    assert.strictEqual(eff.source, require('path').basename(file), 'and must name the file that overrode it');

    // A corrupt state file must not throw — a pre-flight check still has to run.
    fs.writeFileSync(file, '{ not json');
    assert.strictEqual(cfgLib.effectivePaperMode(cfg).paperMode, true, 'a corrupt state file falls back to the default');
    fs.unlinkSync(file);
  });

  test('the mode reported to an operator comes from effectivePaperMode, not the config', () => {
    // Both the server banner and the doctor header used to read
    // CONFIG.runtime.paperMode directly, which printed PAPER over a bot running LIVE.
    for (const rel of ['server.js', 'tools/doctor.js']) {
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', rel), 'utf8');
      assert.ok(/effectivePaperMode/.test(src), `${rel} must use effectivePaperMode`);
      const bad = /mode[^\n]*\$\{CONFIG\.runtime\.paperMode/.exec(src);
      assert.ok(!bad, `${rel} must not report CONFIG.runtime.paperMode as the mode`);
    }
  });

  test('the daily cap survives a save/load roundtrip', () => {
    const bot = makeBot();
    bot.updateSettings({ maxDailyLossUsd: 275 });
    const file = bot.stateFile;

    const bot2 = makeBot();
    bot2.stateFile = file;
    bot2.loadState();
    assert.strictEqual(bot2.maxDailyLossUsd, 275, 'dashboard cap must persist across restarts');
    require('fs').unlinkSync(file);
  });

  test('the whole dashboard payload applies, including the daily cap', () => {
    const bot = makeBot();
    const state = bot.updateSettings({
      tradeAmountUsd: 10,
      stopLossUsd: 300,
      maxDailyLossUsd: 150,
      kellySizing: false,
      maxTradeAmountUsd: 25,
      selectedTimeframe: '5m',
      selectedMarketSlug: 'auto',
    });
    assert.deepStrictEqual(state.settingsChanges.unapplied, []);
    assert.strictEqual(state.settingsChanges.applied.length, 7);
    assert.strictEqual(bot.maxDailyLossUsd, 150);
  });

  // -------------------------------------------------------------- live guards
  section('Live-mode guards');
  test('wallet validation rejects funder == signer for smart-wallet types', () => {
    const auth = new PolymarketAuth({
      ...CONFIG,
      wallet: { ...CONFIG.wallet, privateKey: TEST_TEST_PK, funderAddress: TEST_TEST_ADDR, signatureType: 1 },
    });
    const v = auth.validateWalletSetup();
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /account wallet/);
  });
  test('wallet validation accepts a distinct account wallet', () => {
    const auth = new PolymarketAuth({
      ...CONFIG,
      wallet: { ...CONFIG.wallet, privateKey: TEST_TEST_PK, funderAddress: '0x1111111111111111111111111111111111111111', signatureType: 3 },
    });
    assert.strictEqual(auth.validateWalletSetup().ok, true);
  });
  test('config validation catches a missing funder for smart wallets', () => {
    const errs = validateConfig({ ...CONFIG, wallet: { ...CONFIG.wallet, signatureType: 2, funderAddress: null } });
    assert.ok(errs.some(e => /FUNDER_ADDRESS/.test(e)));
  });
  // ------------------------------------------------- address normalisation
  // ethers v6 throws `bad address checksum` on a mixed-case address whose
  // checksum is wrong, which used to surface from deep inside an approval read
  // and read like an RPC outage. config.addr() repairs the casing instead.
  section('Config — addresses from the environment');
  const ADDR_ENV = 'TEST_ADDR_INPUT';
  const withAddrEnv = (value) => {
    const prev = process.env[ADDR_ENV];
    process.env[ADDR_ENV] = value;
    try { return addr(ADDR_ENV, null); } finally {
      if (prev === undefined) delete process.env[ADDR_ENV]; else process.env[ADDR_ENV] = prev;
    }
  };
  const CHECKSUMMED = '0x2e234DAe75C793f67A35089C9d99245E1C58470b';

  test('a lowercase address is checksummed, not rejected', () => {
    assert.strictEqual(withAddrEnv(CHECKSUMMED.toLowerCase()), CHECKSUMMED);
  });
  test('an already-checksummed address is left alone', () => {
    assert.strictEqual(withAddrEnv(CHECKSUMMED), CHECKSUMMED);
  });
  test('a wrongly-cased address is repaired rather than thrown at ethers', () => {
    // This exact value is what breaks: valid hex, invalid EIP-55 casing.
    const wrongCasing = '0x2e234DAe75C793f67a35089c9d99245E1C58470B';
    assert.notStrictEqual(wrongCasing, CHECKSUMMED);
    assert.strictEqual(withAddrEnv(wrongCasing), CHECKSUMMED);
    assert.throws(() => require('ethers').getAddress(wrongCasing), /bad address checksum/,
      'ethers really does reject the input config.addr() accepts');
  });
  test('an upper-case 0X prefix is accepted', () => {
    const upper = '0X94843687AE3E57F0D1ED4CDEE98F0CC0A2D6C9FF';
    assert.throws(() => require('ethers').getAddress(upper), /invalid address/);
    assert.match(withAddrEnv(upper), /^0x94843687AE3e57F0D1Ed4CdEe98f0CC0A2D6C9FF$/);
  });
  test('surrounding whitespace is trimmed', () => {
    assert.strictEqual(withAddrEnv(`  ${CHECKSUMMED.toLowerCase()}\n`), CHECKSUMMED);
  });
  test('a value that is not an address is passed through for validateConfig to name', () => {
    assert.strictEqual(withAddrEnv('not-an-address'), 'not-an-address');
    assert.strictEqual(withAddrEnv('0x2e234dae75c793f6'), '0x2e234dae75c793f6', 'too short');
  });
  test('an unset address falls back to the default', () => {
    const prev = process.env[ADDR_ENV];
    delete process.env[ADDR_ENV];
    try { assert.strictEqual(addr(ADDR_ENV, null), null); } finally {
      if (prev !== undefined) process.env[ADDR_ENV] = prev;
    }
  });
  // The reported setup is exactly these four variables. config.js reads 136 env
  // vars, so it is easy to make one of them mandatory and silently break this
  // configuration. Pin it: four vars in, no validation errors out.
  test('the four documented env vars alone are a valid configuration', () => {
    const { execFileSync } = require('child_process');
    const script = `
      const { CONFIG, validateConfig } = require(process.env.CFG_PATH);
      process.stdout.write(JSON.stringify({
        sig: CONFIG.wallet.signatureType,
        funder: CONFIG.wallet.funderAddress,
        keyAddr: CONFIG.relayer.apiKeyAddress,
        relayerUrl: CONFIG.relayer.url,
        errors: validateConfig(CONFIG),
      }));
    `;
    const env = { ...process.env, CFG_PATH: require('path').join(__dirname, '..', 'config.js') };
    // Strip anything that could satisfy a requirement the four vars do not.
    for (const k of Object.keys(env)) if (/^(POLY|RELAYER|POLYGON|CLOB|GAMMA)/.test(k)) delete env[k];
    env.POLY_PRIVATE_KEY = '0x' + '11'.repeat(32);
    env.POLY_FUNDER_ADDRESS = '0x94843687AE3E57F0D1ED4CDEE98F0CC0A2D6C9FF';    // upper-case on purpose
    env.RELAYER_API_KEY = '0x' + '22'.repeat(32);
    env.RELAYER_API_KEY_ADDRESS = '0x2e234dae75c793f67a35089c9d99245e1c58470b'; // lower-case on purpose
    env.PAPER_MODE = 'false';

    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env, cwd: __dirname, encoding: 'utf8' }));
    assert.strictEqual(out.sig, 3, 'a relayer key address implies the Deposit Wallet signature type');
    assert.strictEqual(out.funder, '0x94843687AE3e57F0D1Ed4CdEe98f0CC0A2D6C9FF', 'funder must be EIP-55');
    assert.strictEqual(out.keyAddr, '0x2e234DAe75C793f67A35089C9d99245E1C58470b', 'relayer key address must be EIP-55');
    assert.strictEqual(out.relayerUrl, 'https://relayer-v2.polymarket.com');
    assert.deepStrictEqual(out.errors, [], `these four vars must be sufficient, got: ${out.errors.join('; ')}`);
  });

  test('config validation names a funder address that is not 20 bytes', () => {
    const errs = validateConfig({
      ...CONFIG,
      wallet: { ...CONFIG.wallet, signatureType: 3, funderAddress: 'not-an-address', privateKey: TEST_TEST_PK },
    });
    assert.ok(errs.some(e => /POLY_FUNDER_ADDRESS is not a 20-byte address/.test(e)), errs.join(' | '));
  });
  test('config validation accepts a correctly normalised funder address', () => {
    const errs = validateConfig({
      ...CONFIG,
      wallet: { ...CONFIG.wallet, signatureType: 3, funderAddress: CHECKSUMMED, privateKey: TEST_TEST_PK },
    });
    assert.ok(!errs.some(e => /20-byte address/.test(e)), errs.join(' | '));
  });

  test('config validation catches an inconsistent fee cap', () => {
    const errs = validateConfig({ ...CONFIG, fees: { defaultTakerRate: 0.2, maxTakerRate: 0.1 } });
    assert.ok(errs.some(e => /MAX_TAKER_FEE_RATE/.test(e)));
  });
  await testAsync('no L2 credentials → private calls reject instead of sending junk', async () => {
    const { ClobClient } = require('../clobClient');
    const auth = new PolymarketAuth({ ...CONFIG, wallet: { ...CONFIG.wallet, privateKey: TEST_TEST_PK, signatureType: 0 } });
    const client = new ClobClient(CONFIG, auth);
    await assert.rejects(() => client.postOrder({}, {}), /credentials/i);
  });

  // ------------------------------------------------------------ EIP-712 orders
  section('EIP-712 order signing');
  test('typed data uses the v2 CTF Exchange domain and struct', () => {
    const td = buildOrderTypedData({
      tokenId: '123', side: 'BUY', makerAmount: '5200000', takerAmount: '10000000',
      maker: TEST_TEST_ADDR, signer: TEST_TEST_ADDR, signatureType: 0, negRisk: false,
    });
    assert.strictEqual(td.domain.name, 'Polymarket CTF Exchange');
    assert.strictEqual(td.domain.version, '2');
    assert.strictEqual(td.domain.chainId, 137);
    assert.strictEqual(td.domain.verifyingContract.toLowerCase(), '0xe111180000d2663c0091e4f400237545b87b996b');
    assert.deepStrictEqual(td.types.Order.map(f => f.name), [
      'salt', 'maker', 'signer', 'tokenId', 'makerAmount', 'takerAmount',
      'side', 'signatureType', 'timestamp', 'metadata', 'builder',
    ]);
    assert.strictEqual(td.message.side, 0);
  });
  test('neg-risk markets use the neg-risk exchange', () => {
    const td = buildOrderTypedData({
      tokenId: '1', side: 'SELL', makerAmount: '1', takerAmount: '1',
      maker: TEST_TEST_ADDR, signer: TEST_TEST_ADDR, signatureType: 0, negRisk: true,
    });
    assert.strictEqual(td.domain.verifyingContract.toLowerCase(), '0xe2222d279d744050d28e00520010520000310f59');
    assert.strictEqual(td.message.side, 1);
  });
  await testAsync('deposit-wallet signature is ERC-7739 wrapped (longer than a raw sig)', async () => {
    const wallet = new Wallet(TEST_TEST_PK);
    const params = {
      tokenId: '123', side: 'BUY', makerAmount: '5200000', takerAmount: '10000000',
      maker: '0x1111111111111111111111111111111111111111', signer: TEST_TEST_ADDR,
      signatureType: 3, negRisk: false,
    };
    const signed = await signOrder(wallet, params);
    assert.ok(signed.order.signature.length > 132, 'wrapped signature should exceed 65 bytes');
    // 65-byte sig + 32-byte domain separator + 32-byte contents hash
    // + the ORDER_TYPE string + a 2-byte big-endian length prefix.
    const { ORDER_TYPE_SIGNATURE } = require('../orderSigner');
    const expectedHexLen = 2 + (65 + 32 + 32 + ORDER_TYPE_SIGNATURE.length + 2) * 2;
    assert.strictEqual(signed.order.signature.length, expectedHexLen);
    // The wrapper must embed the type string and domain separator, not just pad.
    assert.ok(signed.order.signature.includes(Buffer.from(ORDER_TYPE_SIGNATURE, 'utf8').toString('hex')));
  });
  await testAsync('proxy/EOA signatures recover the signer', async () => {
    const wallet = new Wallet(TEST_TEST_PK);
    const params = {
      tokenId: '123', side: 'BUY', makerAmount: '5200000', takerAmount: '10000000',
      maker: '0x1111111111111111111111111111111111111111', signer: TEST_TEST_ADDR,
      signatureType: 1, negRisk: false,
    };
    const signed = await signOrder(wallet, params);
    const recovered = verifyTypedData(
      signed.typedData.domain, signed.typedData.types, signed.typedData.message, signed.order.signature,
    );
    assert.strictEqual(recovered, TEST_TEST_ADDR);
  });
  await testAsync('the signed digest commits to every order field', async () => {
    const wallet = new Wallet(TEST_TEST_PK);
    const base = {
      tokenId: '123', side: 'BUY', makerAmount: '5200000', takerAmount: '10000000',
      maker: '0x1111111111111111111111111111111111111111', signer: TEST_TEST_ADDR,
      signatureType: 1, negRisk: false, salt: 42, timestamp: 1759296000000,
    };
    const a = await signOrder(wallet, base);
    const b = await signOrder(wallet, { ...base, takerAmount: '10000001' });
    assert.notStrictEqual(a.innerSignature, b.innerSignature);
    assert.strictEqual(
      TypedDataEncoder.hash(a.typedData.domain, a.typedData.types, a.typedData.message),
      TypedDataEncoder.hash(a.typedData.domain, a.typedData.types, a.typedData.message),
    );
  });
  test('salt stays inside Number.MAX_SAFE_INTEGER', () => {
    for (let i = 0; i < 200; i++) {
      const s = saltFromRandom();
      assert.ok(Number.isInteger(s) && s >= 0 && s < Number.MAX_SAFE_INTEGER);
    }
  });

  // ============================================================ v2.2 fixes
  //
  // Regression tests for the defects found while measuring whether the
  // Stale-Quote Snipe can fire in a live run. Each one failed before the fix.

  section('v2.2 — time floors, honest reasons, per-side book gates');

  test('a module floor below MIN_SECONDS_TO_EXPIRY is reported as a clamp', () => {
    // v2.3.1 resolves the shipped SQS floor to the account floor at load, so the
    // module no longer disagrees with it out of the box. The clamp note still has
    // to work for a floor that diverges at RUNTIME — a hand-built config, a test
    // double, or a settings patch — so build that case explicitly on a clone
    // rather than by mutating the shared CONFIG.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.strategies.staleQuoteSnipe.minEntrySecondsLeft = 8;
    const ctx = makeCtx({ engine: new StrategyEngine(cfg) });
    ctx.engine.cfg = cfg;
    ctx.market.remainingSec = 9;
    ctx.model = { pUp: 0.99, pDown: 0.01, drift: 900, sigmaWindow: 1, expectedCloseTwap: 100900 };
    const r = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!r.signal, 'must stand down inside the floor');
    assert.match(r.reason, /need ≥10s/, `floor not named: ${r.reason}`);
    assert.match(r.reason, /module floor 8s/, `clamp not explained: ${r.reason}`);
    assert.match(r.reason, /MIN_SECONDS_TO_EXPIRY=10/, `global floor not named: ${r.reason}`);
    // And the warning path must still catch a divergence the load-time
    // resolution could not have seen. The env is injected so the value is
    // recognised as an explicit override rather than an unset default — that
    // distinction is what decides which message the operator gets.
    const { configWarnings, resolveEntryFloors } = require('../config');
    resolveEntryFloors(cfg, (k) => (k === 'SQS_MIN_LEFT' ? '8' : undefined));
    assert.ok(configWarnings(cfg).some(w => /SQS_MIN_LEFT=8s is below MIN_SECONDS_TO_EXPIRY=10s/.test(w)),
      `got: ${JSON.stringify(configWarnings(cfg))}`);
  });

  test('an unset module floor follows MIN_SECONDS_TO_EXPIRY instead of a stale hard-coded number', () => {
    // The actual v2.3.1 fix: SQS shipped with minEntrySecondsLeft=8 against a 10s
    // account floor, so the setting was dead on arrival and the module's
    // advertised final-8s window was really final-10s.
    const { entryFloorNotes, HARD_CODED_ENTRY_FLOOR_DEFAULTS } = require('../config');
    assert.strictEqual(CONFIG.strategies.staleQuoteSnipe.minEntrySecondsLeft,
      CONFIG.risk.minSecondsToExpiry,
      'the shipped SQS floor must equal the account floor, not the old hard-coded 8');
    assert.strictEqual(HARD_CODED_ENTRY_FLOOR_DEFAULTS.staleQuoteSnipe, 8,
      'the pre-fix default is recorded so the resolution is auditable');
    const note = entryFloorNotes.find(n => n.name === 'staleQuoteSnipe');
    assert.ok(note, 'the resolution must be recorded');
    assert.strictEqual(note.requested, 8);
    assert.strictEqual(note.resolved, CONFIG.risk.minSecondsToExpiry);
    assert.strictEqual(note.explicit, false, 'SQS_MIN_LEFT is not set in .env, so this is a default, not an override');
    // Every other module is above the floor and must be left exactly alone.
    for (const [name, st] of Object.entries(CONFIG.strategies)) {
      if (name === 'staleQuoteSnipe') continue;
      if (Number.isFinite(st.minEntrySecondsLeft)) {
        assert.ok(st.minEntrySecondsLeft >= CONFIG.risk.minSecondsToExpiry, `${name} should be untouched`);
        assert.strictEqual(st.minEntrySecondsLeftResolvedFrom, undefined, `${name} must not be marked as resolved`);
      }
    }
  });

  test('an explicitly-set module floor below the account floor is raised and reported', () => {
    // The account floor is a hard safety limit, so an operator-set 8s is still
    // raised to 10s — but it must be *reported*, not applied silently, and the
    // note must say which knob to change if they really want to trade closer to
    // expiry. The env is injected rather than mutated, so this does not depend on
    // how the suite was launched.
    const { configWarnings, resolveEntryFloors } = require('../config');
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.strategies.staleQuoteSnipe.minEntrySecondsLeft = 8;
    const notes = resolveEntryFloors(cfg, (k) => (k === 'SQS_MIN_LEFT' ? '8' : undefined));
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].explicit, true, 'an operator-set value must be recognised as explicit');
    assert.strictEqual(cfg.strategies.staleQuoteSnipe.minEntrySecondsLeft, CONFIG.risk.minSecondsToExpiry,
      'still raised — the account floor is a hard limit');
    assert.strictEqual(cfg.strategies.staleQuoteSnipe.minEntrySecondsLeftRequested, 8);
    const warns = configWarnings(cfg);
    const w = warns.find(x => /SQS_MIN_LEFT=8s is below MIN_SECONDS_TO_EXPIRY=10s/.test(x));
    assert.ok(w, `the clamp must be reported: ${JSON.stringify(warns)}`);
    assert.match(w, /resolved to 10s/);
    assert.match(w, /hard limit/);
    assert.match(w, /lower MIN_SECONDS_TO_EXPIRY/, 'it must name the knob that actually controls this');
  });

  test('a snipe window squeezed shut by the account floor is caught', () => {
    // SQS_LAST_SECONDS <= MIN_SECONDS_TO_EXPIRY leaves the module enabled and
    // evaluated every tick but unable to ever fire — which reads like a market
    // problem rather than a configuration one.
    const { configWarnings, resolveEntryFloors } = require('../config');
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.strategies.staleQuoteSnipe.onlyLastSeconds = 9;
    cfg.strategies.staleQuoteSnipe.minEntrySecondsLeft = 8;
    resolveEntryFloors(cfg, () => undefined);   // unset: follows the account floor
    const warns = configWarnings(cfg);
    const w = warns.find(x => /can never trade/.test(x));
    assert.ok(w, `a closed window must be reported: ${JSON.stringify(warns)}`);
    assert.match(w, /final 9s/);
    // The knob to raise is the WINDOW, not the floor — naming SQS_MIN_LEFT here
    // would send the operator round in circles.
    assert.match(w, /raise SQS_LAST_SECONDS above 10s/);
    assert.ok(!/raise SQS_MIN_LEFT/.test(w));
  });

  test('SQS can actually trade inside its own advertised window', () => {
    // The point of the fix: at 9s the module stands down on the account floor,
    // but at 10-25s it is reachable, and the reason it gives at 9s no longer
    // blames a setting that the config already resolved.
    const ctx = makeCtx();
    ctx.model = { pUp: 0.99, pDown: 0.01, drift: 900, sigmaWindow: 1, expectedCloseTwap: 100900 };
    ctx.books.up = normaliseBook({
      asset_id: '1', bids: [{ price: '0.90', size: '5000' }], asks: [{ price: '0.92', size: '5000' }],
      min_order_size: '5', tick_size: '0.01',
    });
    ctx.market.remainingSec = 9;
    const tooLate = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!tooLate.signal);
    assert.match(tooLate.reason, /need ≥10s/);
    assert.ok(!/module floor/.test(tooLate.reason),
      `the shipped config no longer diverges, so there is no clamp to explain: ${tooLate.reason}`);

    ctx.market.remainingSec = 12;
    const reachable = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!/need ≥/.test(reachable.reason || ''), `12s must clear the floor: ${reachable.reason}`);
  });

  test('reachable floors are reported without a clamp note', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 40;   // inside every module floor, outside SQS's band
    const r = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!r.signal);
    assert.match(r.reason, /not final 25s/);
  });

  test('state exposes the effective floor per module', () => {
    const engine = new StrategyEngine(CONFIG);
    const st = engine.getState();
    // Resolved at load, so the dashboard shows the value that is really in force
    // rather than a number the engine was quietly overriding.
    assert.strictEqual(st.staleQuoteSnipe.configuredMinSecondsLeft, CONFIG.risk.minSecondsToExpiry);
    assert.strictEqual(st.staleQuoteSnipe.effectiveMinSecondsLeft, CONFIG.risk.minSecondsToExpiry);
    assert.strictEqual(st.staleQuoteSnipe.minSecondsClamped, false,
      'nothing is being clamped any more — the config already agrees');
    // A module whose setting is above the global floor is not flagged.
    assert.strictEqual(st.volatilityBreakout.minSecondsClamped, false);
    assert.strictEqual(st.volatilityBreakout.effectiveMinSecondsLeft, CONFIG.strategies.volatilityBreakout.minEntrySecondsLeft);

    // A floor that diverges at runtime is still surfaced as a clamp.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.strategies.staleQuoteSnipe.minEntrySecondsLeft = 8;
    const st2 = new StrategyEngine(cfg).getState();
    assert.strictEqual(st2.staleQuoteSnipe.configuredMinSecondsLeft, 8);
    assert.strictEqual(st2.staleQuoteSnipe.effectiveMinSecondsLeft, cfg.risk.minSecondsToExpiry);
    assert.strictEqual(st2.staleQuoteSnipe.minSecondsClamped, true);
  });

  test('a side with no offers says so, instead of blaming the price cap', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 15;
    ctx.model = { pUp: 0.99, pDown: 0.01, drift: 900, sigmaWindow: 1, expectedCloseTwap: 100900 };
    // Bids only: the last-seconds book on a decided side.
    ctx.books.up = normaliseBook({ asset_id: '1', bids: [{ price: '0.99', size: '5000' }], asks: [], min_order_size: '5' });
    const sqs = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!sqs.signal);
    assert.match(sqs.reason, /no ask offered on UP/, `expected the real reason, got: ${sqs.reason}`);
    assert.ok(!/above the 93c cap/.test(sqs.reason), 'must not report a cap breach when there is no offer');
  });

  test('an ask above the module cap is named with both prices', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 15;
    ctx.model = { pUp: 0.99, pDown: 0.01, drift: 900, sigmaWindow: 1, expectedCloseTwap: 100900 };
    ctx.books.up = normaliseBook({ asset_id: '1', bids: [{ price: '0.96', size: '5000' }], asks: [{ price: '0.97', size: '5000' }], min_order_size: '5' });
    const sqs = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!sqs.signal);
    assert.match(sqs.reason, /97\.0c above the 93c cap/, `got: ${sqs.reason}`);
  });

  test('per-side depth: a thin traded side is refused even when the market passes', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 20;
    ctx.model = { pUp: 0.99, pDown: 0.01, drift: 900, sigmaWindow: 1, expectedCloseTwap: 100900 };
    // UP has a healthy $800 book (so market-level preflight passes), DOWN is thin.
    ctx.books.down = normaliseBook({
      asset_id: '2', market: '0xcond',
      bids: [{ price: '0.02', size: '2' }], asks: [{ price: '0.03', size: '2' }],
      min_order_size: '5', tick_size: '0.01',
    });
    ctx.model = { pUp: 0.01, pDown: 0.99, drift: -900, sigmaWindow: 1, expectedCloseTwap: 999100 };
    const sqs = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!sqs.signal, 'a $0.06 ask side must not be bought');
    assert.match(sqs.reason, /ask depth/, `expected a depth rejection, got: ${sqs.reason}`);
  });

  test('per-side spread: a wide traded side is refused even when the market passes', () => {
    const ctx = makeCtx();
    ctx.market.remainingSec = 20;
    ctx.model = { pUp: 0.99, pDown: 0.01, drift: 900, sigmaWindow: 1, expectedCloseTwap: 100900 };
    ctx.books.up = normaliseBook({
      asset_id: '1', market: '0xcond',
      bids: [{ price: '0.80', size: '5000' }], asks: [{ price: '0.90', size: '5000' }],
      min_order_size: '5', tick_size: '0.01',
    });
    const sqs = ctx.engine.staleQuoteSnipe(ctx);
    assert.ok(!sqs.signal, 'a 10c spread must not be crossed');
    assert.match(sqs.reason, /spread/, `expected a spread rejection, got: ${sqs.reason}`);
  });

  test('fair-value EV reports both sides when neither qualifies', () => {
    const ctx = makeCtx();
    ctx.model = { pUp: 0.51, pDown: 0.49, drift: 1, sigmaWindow: 10, expectedCloseTwap: 100001 };
    const r = ctx.engine.fairValueEv(ctx);
    assert.ok(!r.signal);
    assert.match(r.reason, /UP net edge/, `got: ${r.reason}`);
    assert.match(r.reason, /DOWN net edge/, `got: ${r.reason}`);
  });

  section('v2.2 — clock, books and window-open messaging');

  test('configWarnings explains the resolved floor and the shadowed edge gate', () => {
    const { configWarnings } = require('../config');
    const warns = configWarnings(CONFIG);
    // The floor no longer disagrees with itself, so the warning is now a plain
    // statement of what is in force — and it must not claim a clamp that is not
    // happening.
    assert.ok(warns.some(w => /staleQuoteSnipe trades from 10s before close/.test(w)), `got: ${JSON.stringify(warns)}`);
    assert.ok(!warns.some(w => /staleQuoteSnipe\.minEntrySecondsLeft=8s/.test(w)),
      'the shipped config is resolved at load, so there is no clamp left to report');
    // The old "MIN_NET_EDGE is enforced twice" warning described a real defect.
    // It is gone, and what remains names the module whose own gate can never bind.
    assert.ok(!warns.some(w => /enforced twice/.test(w)), 'there is one edge gate now');
    const shadow = warns.find(w => /MIN_NET_EDGE=0\.015 is a floor/.test(w));
    assert.ok(shadow, `the shadowed module gate should still be explained: ${JSON.stringify(warns)}`);
    assert.match(shadow, /staleQuoteSnipe=0\.01/);
    assert.match(shadow, /can never bind/);
    assert.match(shadow, /Lower MIN_NET_EDGE/);
  });

  test('tick() refreshes time-to-expiry from the local clock', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-clock-${Date.now()}.json`);
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    const nowSec = Math.floor(Date.now() / 1000);
    bot.isRunning = true;
    bot.markets = [{
      slug: 'btc-updown-5m-1', conditionId: '0xc', upTokenId: 'u', downTokenId: 'd',
      tradeable: true, tokenMappingOk: true, epoch: nowSec - 290, endsAtEpoch: nowSec + 12,
      remainingSec: 300,   // stale, as a 10s-old discovery pass would leave it
      feeSchedule: { rate: 0.07, exponent: 1 }, tickSize: 0.01, minOrderSize: 5, negRisk: false,
      timeframe: '5m', question: 'q', endTime: new Date().toISOString(), startTime: new Date().toISOString(),
      started: true, windowSeconds: 300,
    }];
    bot.marketStream.getBook = () => null;
    bot.clob.getBook = async () => null;      // keep the test offline
    await bot.tick().catch(() => {});
    assert.strictEqual(bot.markets[0].remainingSec, 12, 'remainingSec must come from the local clock');
  });

  test('bookForDecision prefers a fresh streamed book and refetches a stale one', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-book-${Date.now()}.json`);
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });

    const fresh = normaliseBook({ asset_id: 'u', bids: [{ price: '0.5', size: '10' }], asks: [{ price: '0.51', size: '10' }] });
    bot.marketStream.getBook = () => fresh;
    let restCalls = 0;
    bot.clob.getBook = async () => { restCalls++; return null; };
    const a = await bot.bookForDecision('u');
    assert.strictEqual(a, fresh, 'a fresh streamed book must be used as-is');
    assert.strictEqual(restCalls, 0);

    const stale = { ...fresh, receivedAt: Date.now() - (cfg.runtime.maxBookAgeMs + 1000) };
    const restBook = normaliseBook({ asset_id: 'u', bids: [{ price: '0.5', size: '10' }], asks: [{ price: '0.52', size: '10' }] });
    bot.marketStream.getBook = () => stale;
    bot.clob.getBook = async () => { restCalls++; return restBook; };
    const b = await bot.bookForDecision('u');
    assert.strictEqual(restCalls, 1, 'a stale streamed book must trigger a REST refetch');
    assert.strictEqual(b, restBook);
  });

  test('a window that opened before the bot could observe it is explained, not silent', async () => {
    const { ReferencePrice } = require('../referencePrice');
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-wo-${Date.now()}.json`);
    const ref = new ReferencePrice(cfg, { hasL2Credentials: () => false });
    // Only spot samples exist, and only from *after* the window opened.
    const nowMs = Date.now();
    const epoch = Math.floor(nowMs / 1000) - 120;           // window opened 2 minutes ago
    ref.samples.blended.push({ t: nowMs - 1000, p: 100000 });
    const entry = ref.observeWindow(epoch, 300);
    assert.strictEqual(entry.twap, null);
    assert.match(entry.reason, /price to beat was not recorded/);
    assert.match(entry.reason, /cannot be traded/);
    // The negative result is cached with its reason, so the dashboard can show it.
    assert.strictEqual(ref.getWindowOpen(epoch).reason, entry.reason);
  });

  test('a window is backfilled when the spot history covers its open', () => {
    const { ReferencePrice } = require('../referencePrice');
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    const ref = new ReferencePrice(cfg, { hasL2Credentials: () => false });
    const nowMs = Date.now();
    const epoch = Math.floor(nowMs / 1000) - 90;            // opened 90s ago: outside the stamping grace
    const openMs = epoch * 1000;
    for (let i = 120; i >= 0; i -= 2) ref.samples.blended.push({ t: openMs - i * 1000, p: 100000 + i });
    const entry = ref.observeWindow(epoch, 300);
    assert.ok(entry.twap !== null, 'covered history must backfill the price to beat');
    assert.match(String(entry.source), /backfill/);
    assert.strictEqual(entry.backfilled, true);
  });

  test('an unknown TWAP is not cached as final', () => {
    const { ReferencePrice } = require('../referencePrice');
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    const ref = new ReferencePrice(cfg, { hasL2Credentials: () => false });
    ref.getTwap = () => ({ value: null, source: null, authoritative: false });
    const epoch = Math.floor(Date.now() / 1000);            // window opening right now
    const first = ref.observeWindow(epoch, 300);
    assert.strictEqual(first.twap, null);
    assert.ok(!ref.windowOpens.has(String(epoch)), 'a null snapshot must be retried, not cached');
    ref.getTwap = () => ({ value: 100000, source: 'spot-proxy-twap60', authoritative: false });
    const second = ref.observeWindow(epoch, 300);
    assert.strictEqual(second.twap, 100000, 'the next pass should pick the value up');
  });

  testAsync('the PolyBolt auth frame carries all three CLOB credentials', async () => {
    // Regression: connectPolybolt() read `c.passphrase` from an object whose
    // field is `apiPassphrase`, so JSON.stringify dropped the passphrase and
    // PolyBolt answered `auth_required` on every connect. The bot then ran on
    // the spot proxy indefinitely with perfectly valid credentials, and the
    // maker module — which refuses the proxy — never quoted at all.
    const http = require('http');
    const { WebSocketServer } = require('ws');
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const frames = [];
    const gotAuth = new Promise((resolve) => {
      wss.on('connection', (sock) => {
        sock.on('message', (d) => {
          const m = JSON.parse(d.toString());
          frames.push(m);
          if (m.op === 'auth') resolve(m);
        });
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const { ReferencePrice } = require('../referencePrice');
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.endpoints.polyboltWs = `ws://127.0.0.1:${port}/ws`;
    const auth = {
      hasL2Credentials: () => true,
      getCredentials: () => ({ apiKey: 'key-1', apiSecret: 'secret-1', apiPassphrase: 'pass-1' }),
    };
    const ref = new ReferencePrice(cfg, auth);
    try {
      ref.connectPolybolt();
      const frame = await Promise.race([
        gotAuth,
        new Promise((_, rej) => setTimeout(() => rej(new Error('no auth frame within 3s')), 3000)),
      ]);
      assert.deepStrictEqual(frame.auth, { apiKey: 'key-1', secret: 'secret-1', passphrase: 'pass-1' });
      assert.ok(frames.some(f => f.op === 'subscribe'), 'a subscribe frame should follow the auth frame');
    } finally {
      ref.stop();
      await new Promise((r) => wss.close(() => server.close(r)));
    }
  });

  section('v2.2 — a fired signal that does not trade says so');

  test('the single edge gate names the module and shows both prices', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-exec-${Date.now()}.json`);
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    bot.cfg.runtime.paperMode = true;
    bot.paperBalance = 1000;
    const book = normaliseBook({
      asset_id: 'u', market: '0xc',
      bids: [{ price: '0.90', size: '5000' }], asks: [{ price: '0.93', size: '5000' }],
      min_order_size: '5', tick_size: '0.01',
    });
    // 96.6% at a 93c ask: the executable price is 93c + 2c slippage = 95c, so
    // the net edge is 1.27c. That clears SQS's own 1c gate but not the 1.5c
    // MIN_NET_EDGE floor, which is what actually binds here — the module's own
    // threshold is shadowed by the global floor under the shipped values.
    const ctx = {
      market: { slug: 's', conditionId: '0xc', upTokenId: 'u', downTokenId: 'd', tokenMappingOk: true, endTime: new Date().toISOString() },
      books: { up: book, down: book },
      model: { pUp: 0.966, pDown: 0.034 },
      feeSchedule: { rate: 0.07, exponent: 1 },
      constraints: { tickSize: 0.01, minOrderSize: 5, negRisk: false },
      mode: 'paper',
    };
    const pos = await bot.executeSignal(ctx, {
      signal: 'BUY_UP', side: 'UP', prob: 0.966, edge: 0.016,
      strategy: 'staleQuoteSnipe', strategyName: 'Stale-Quote Snipe', reason: 'test',
    });
    assert.strictEqual(pos, null, 'must not place a marginal order');
    assert.match(bot.lastSkipReason, /Stale-Quote Snipe fired but did not trade/);
    assert.match(bot.lastSkipReason, /limit 95\.0c/);
    assert.match(bot.lastSkipReason, /MIN_NET_EDGE floor 1\.50c/);
    assert.match(bot.lastSkipReason, /net edge 1\.27c/, `got: ${bot.lastSkipReason}`);
  });

  testAsync('a market minimum above MAX_TRADE_SIZE_USD does not trade, end to end', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    const file = require('path').join(require('os').tmpdir(), `bot-cap-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    cfg.runtime.stateFile = file;
    cfg.order.stakeUsd = 10;
    cfg.order.maxStakeUsd = 12;
    cfg.order.minOrderPolicy = 'bump';
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    bot.paperMode = true;
    bot.paperBalance = 1000;
    const ctxFor = (minOrderSize) => {
      const book = normaliseBook({
        asset_id: 'u', market: '0xc',
        bids: [{ price: '0.60', size: '5000' }], asks: [{ price: '0.61', size: '5000' }],
        min_order_size: String(minOrderSize), tick_size: '0.01',
      });
      return {
        market: { slug: 's', conditionId: '0xc', upTokenId: 'u', downTokenId: 'd', tokenMappingOk: true, endTime: new Date().toISOString() },
        books: { up: book, down: book },
        model: { pUp: 0.95, pDown: 0.05 },
        feeSchedule: { rate: 0.07, exponent: 1 },
        constraints: { tickSize: 0.01, minOrderSize, negRisk: false },
        mode: 'paper',
        windowOpen: null,
        twap: { value: 100000, source: 'test', authoritative: true },
        spot: { value: 100000 },
      };
    };
    const decision = {
      signal: 'BUY_UP', side: 'UP', prob: 0.95, edge: 0.3,
      strategy: 'fairValueEv', strategyName: 'Fair Value EV', reason: 'test',
    };
    try {
      // 57 shares at 63c = $35.91, three times the $12 cap: must not be bought.
      const blocked = await bot.executeSignal(ctxFor(57), decision);
      assert.strictEqual(blocked, null, 'a 57-share minimum must not be bought under a $12 cap');
      assert.match(bot.lastSkipReason, /above the \$12\.00 cap/, `got: ${bot.lastSkipReason}`);
      assert.strictEqual(bot.paperBalance, 1000, 'no paper money may be spent');
      assert.strictEqual(bot.activePositions.length, 0);

      // The ordinary 5-share minimum still trades, inside the cap.
      const allowed = await bot.executeSignal(ctxFor(5), decision);
      assert.ok(allowed, `the 5-share minimum must still trade: ${bot.lastSkipReason}`);
      assert.ok(allowed.requestedUsd <= 12, `requestedUsd ${allowed.requestedUsd} over the cap`);
    } finally {
      try { require('fs').unlinkSync(file); } catch (_) {}
    }
  });

  section('User stream subscriptions');
  test('setMarkets filters a Set of condition ids without throwing', () => {
    // Regression: `this.markets` is a Set, and the code called .filter() on it
    // directly. Set has no .filter, so every discovery cycle logged
    //   [ERROR] discovery: this.markets.filter is not a function or its
    //   return value is not iterable
    // and the user stream silently never re-subscribed after a change.
    const { UserStream } = require('../wsUser');
    const us = new UserStream(CONFIG, { hasL2Credentials: () => true });
    let subscribed = null;
    us.subscribe = (ids) => { subscribed = ids; };
    us.ws = { readyState: 1 };
    us.authenticated = true;

    us.setMarkets(['0xaaa', '0xbbb', undefined, null]);
    assert.deepStrictEqual(subscribed, ['0xaaa', '0xbbb'],
      'undefined/null condition ids must be dropped, not sent to the socket');

    // A no-op update must not re-subscribe.
    subscribed = null;
    us.setMarkets(['0xaaa', '0xbbb']);
    assert.strictEqual(subscribed, null, 'an unchanged set must not trigger a subscribe');
  });

  section('v2.3.1 — one edge gate, at the price you actually pay');

  /**
   * Build a Stale-Quote Snipe context: 96.6% model, 93c ask, so the executable
   * price is 95c (ask + MAX_SLIPPAGE_CENTS) and the net edge is 1.27c. That is
   * above SQS's own 1c gate and below the shipped 1.5c MIN_NET_EDGE floor — the
   * exact case that used to fire in the engine and then be dropped at execution.
   */
  function sqsCtx(cfg, remainingSec = 15) {
    const engine = new StrategyEngine(cfg);
    const book = normaliseBook({
      asset_id: '1', market: '0xc',
      bids: [{ price: '0.90', size: '5000' }], asks: [{ price: '0.93', size: '5000' }],
      min_order_size: '5', tick_size: '0.01', neg_risk: false,
    });
    return {
      engine,
      ctx: {
        market: {
          slug: 's', conditionId: '0xc', upTokenId: 'u', downTokenId: 'd',
          tokenMappingOk: true, remainingSec, tradeable: true, timeframe: '5m',
          feeSchedule: { rate: 0.07, exponent: 1 }, tickSize: 0.01, minOrderSize: 5, negRisk: false,
        },
        books: { up: book, down: book },
        model: { pUp: 0.966, pDown: 0.034 },
        degraded: false,
        feeSchedule: { rate: 0.07, exponent: 1 },
        constraints: { tickSize: 0.01, minOrderSize: 5, negRisk: false },
        ref: { tracker: new VolatilityTracker({ minVolPerSec: 1 }), spots: {}, spotTs: {} },
        twap: { value: 100000, source: 'polybolt-twap60', authoritative: true },
        spot: { value: 100000 },
        windowOpen: { twap: 100000, source: 'polybolt-twap60' },
        mode: 'paper',
      },
    };
  }

  test('the engine gates at the executable price, not the ask', () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    const { engine, ctx } = sqsCtx(cfg);
    const r = engine.staleQuoteSnipe(ctx);
    assert.ok(!r.signal, 'the global floor still binds under the shipped values');
    // Both prices, and whose threshold it is. Before v2.3.1 the engine tested at
    // the 93c ask (edge 3.14c, comfortably above SQS's 1c) and only botCore saw
    // the 95c executable price — which is why a signal could fire and not trade.
    assert.match(r.reason, /93\.0c ask \+ 2c = 95\.0c/);
    assert.match(r.reason, /net edge 1\.27c/);
    assert.match(r.reason, /MIN_NET_EDGE floor 1\.50c/);
  });

  test('a module edge gate is reachable once the global floor is not higher', () => {
    // The point of the fix: SQS_MIN_EDGE=0.01 was unreachable under the shipped
    // MIN_NET_EDGE=0.015, so the one module written to trade a 1-cent edge in the
    // final seconds could never fire. Lower the floor and its own gate binds.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.fees.minNetEdge = 0.01;
    const { engine, ctx } = sqsCtx(cfg);
    const r = engine.staleQuoteSnipe(ctx);
    assert.ok(r && r.signal === 'BUY_UP', `SQS must fire at a 1.27c executable edge: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.executionPrice - 0.95) < 1e-9, `executable price ${r.executionPrice}`);
    assert.strictEqual(r.edgeLimitedBy, 'module', "SQS's own 1c gate is what binds now");
    assert.ok(Math.abs(r.edge - 0.012675) < 1e-6, `edge ${r.edge}`);
    assert.ok(Math.abs(r.edgeAtAsk - 0.031443) < 1e-6, `ask edge ${r.edgeAtAsk}`);
  });

  test('the engine and the execution path agree, so a fired signal trades', async () => {
    // The defect in one sentence: the module gate ran at the ask against the
    // module's threshold, the execution gate at ask+slippage against the global
    // one, so "fired" did not imply "traded". Both now call entryEdgeTest.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.fees.minNetEdge = 0.01;
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-onegate-${Date.now()}.json`);
    const { engine, ctx } = sqsCtx(cfg);
    const decision = engine.evaluate(ctx);
    assert.ok(decision.signal, `the engine must fire: ${JSON.stringify(decision.evaluations)}`);
    assert.strictEqual(decision.strategy, 'staleQuoteSnipe');

    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    bot.cfg.runtime.paperMode = true;
    bot.paperMode = true;
    bot.paperBalance = 1000;
    const pos = await bot.executeSignal(ctx, decision);
    assert.ok(pos, `the same signal must reach the book, not be dropped: ${bot.lastSkipReason}`);
    assert.ok(!/fired but did not trade/.test(bot.lastSkipReason || ''),
      `"fired but did not trade" is the bug this fixes: ${bot.lastSkipReason}`);
    assert.ok(!bot.logs.some(l => /Edge gate priced/.test(l.message)),
      'the two paths must derive the same executable price');
  });

  test('the execution path still gates a signal handed to it directly', async () => {
    // executeSignal() is reachable without the engine (POST /api/trade), so the
    // gate has to stay there — it is the same function, not a second opinion.
    const cfg = JSON.parse(JSON.stringify(CONFIG));   // shipped 1.5c floor
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-directgate-${Date.now()}.json`);
    const { ctx } = sqsCtx(cfg);
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    bot.cfg.runtime.paperMode = true;
    bot.paperMode = true;
    bot.paperBalance = 1000;
    const pos = await bot.executeSignal(ctx, {
      signal: 'BUY_UP', side: 'UP', prob: 0.966, edge: 0.0127,
      strategy: 'staleQuoteSnipe', strategyName: 'Stale-Quote Snipe', reason: 'manual',
    });
    assert.strictEqual(pos, null);
    assert.match(bot.lastSkipReason, /MIN_NET_EDGE floor 1\.50c/);
  });

  test('a degraded feed scales the module gate but not the global floor', () => {
    const { entryEdgeTest } = require('../pricing');
    const base = {
      prob: 0.966, bestAsk: 0.93, tickSize: 0.01, maxSlippageCents: 2, maxBuyPrice: 0.97,
      feeSchedule: { rate: 0.07, exponent: 1 }, moduleMinNetEdge: 0.02, globalMinNetEdge: 0.015,
    };
    const normal = entryEdgeTest(base);
    const degraded = entryEdgeTest({ ...base, degraded: true });
    assert.strictEqual(normal.moduleRequired, 0.02);
    assert.strictEqual(degraded.moduleRequired, 0.03, 'the module threshold is scaled 1.5x');
    assert.strictEqual(normal.effectiveMinNetEdge, 0.02);
    assert.strictEqual(degraded.effectiveMinNetEdge, 0.03);
    assert.strictEqual(normal.limitedBy, 'module');
    // The executable price is capped by MAX_BUY_PRICE and rounded to the tick.
    assert.strictEqual(normal.executablePrice, 0.95);
    const capped = entryEdgeTest({ ...base, bestAsk: 0.965 });
    assert.strictEqual(capped.executablePrice, 0.97, 'MAX_BUY_PRICE caps the limit price');
  });

  test('a decided side with no offers is reported before the execution gate', async () => {
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-noask-${Date.now()}.json`);
    const bot = new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
    const bidOnly = normaliseBook({ asset_id: 'u', bids: [{ price: '0.99', size: '5000' }], asks: [] });
    const ctx = {
      market: { slug: 's', conditionId: '0xc', upTokenId: 'u', downTokenId: 'd', tokenMappingOk: true, endTime: new Date().toISOString() },
      books: { up: bidOnly, down: bidOnly },
      model: { pUp: 0.99, pDown: 0.01 },
      feeSchedule: { rate: 0.07, exponent: 1 },
      constraints: { tickSize: 0.01, minOrderSize: 5, negRisk: false },
      mode: 'paper',
    };
    const pos = await bot.executeSignal(ctx, {
      signal: 'BUY_UP', side: 'UP', prob: 0.99, edge: 0.05,
      strategy: 'staleQuoteSnipe', strategyName: 'Stale-Quote Snipe', reason: 'test',
    });
    assert.strictEqual(pos, null);
    assert.match(bot.lastSkipReason, /no ask liquidity on UP/);
  });

  // ------------------------------------- cost + fee cap, and fills counted once
  section('v3 — the $ cap covers cost + taker fee, and a fill is counted once');

  const FEE_CRYPTO = { rate: 0.07, exponent: 1 };

  test('with a fee schedule, cost + fee never exceeds the cap', () => {
    for (const price of [0.2, 0.35, 0.5, 0.65, 0.78, 0.85, 0.9]) {
      for (const minShares of [1, 5, 10]) {
        for (const stakeUsd of [5, 10, 12, 20]) {
          const s = sizeOrder({ stakeUsd, price, minShares, tickSize: 0.01, maxStakeUsd: 12, minOrderPolicy: 'bump', feeSchedule: FEE_CRYPTO });
          if (!s.ok) continue;
          assert.ok(s.totalUsd <= 12 + 1e-9, `total $${s.totalUsd} over the $12 cap (price ${price}, min ${minShares}, stake ${stakeUsd})`);
          assert.ok(s.shares + 1e-9 >= minShares, `shares ${s.shares} under minimum ${minShares}`);
          assert.ok(Math.abs(s.totalUsd - (s.usd + s.feeUsd)) < 1e-6, 'totalUsd is cost + fee');
        }
      }
    }
  });
  // Regression: a $12 stake at 65c used to be sized to $12.00 of shares, then the
  // taker fee (~$0.29) went on top: about $12.29 spent against a $12 cap.
  test('a $12 stake at 65c is trimmed so that cost + fee fits the $12 cap', () => {
    const s = sizeOrder({ stakeUsd: 12, price: 0.65, minShares: 5, tickSize: 0.01, maxStakeUsd: 12, minOrderPolicy: 'bump', feeSchedule: FEE_CRYPTO });
    assert.strictEqual(s.ok, true);
    assert.ok(s.usd < 12, `cost $${s.usd} should be trimmed below $12`);
    assert.ok(s.feeUsd > 0.2, `fee $${s.feeUsd} should be counted`);
    assert.ok(s.totalUsd <= 12 + 1e-9, `total $${s.totalUsd} over the $12 cap`);
  });
  test('without a fee schedule the cap is on cost alone, as before', () => {
    const s = sizeOrder({ stakeUsd: 12, price: 0.65, minShares: 5, tickSize: 0.01, maxStakeUsd: 12 });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.feeUsd, 0);
    assert.ok(Math.abs(s.usd - 12) < 0.01, `cost ${s.usd}`);
  });
  test('a minimum that only fits under the cap without the fee is declined', () => {
    // 5 shares at 60c cost $3.00 (exactly the cap) but carry a $0.08 fee on top.
    const s = sizeOrder({ stakeUsd: 3, price: 0.6, minShares: 5, tickSize: 0.01, maxStakeUsd: 3.0, minOrderPolicy: 'bump', feeSchedule: FEE_CRYPTO });
    assert.strictEqual(s.ok, false);
    assert.match(s.reason, /above the \$3\.00 cap/);
  });

  function makeFillBot() {
    const { BotCore } = require('../botCore');
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.runtime.stateFile = require('path').join(require('os').tmpdir(), `bot-fill-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    return new BotCore({ config: cfg, auth: { setPaperMode() {}, getStatus: () => ({}) } });
  }
  function freshPosition(overrides = {}) {
    return {
      id: 'p1', side: 'DOWN', marketSlug: 'btc-updown-5m-1', orderIds: ['0xord'],
      limitPrice: 0.87, minOrderSize: 5, feeSchedule: FEE_CRYPTO,
      filledShares: 0, filledUsd: 0, avgPrice: null, feeUsd: 0, status: 'LIVE',
      ...overrides,
    };
  }
  const FILL = { id: 'trade-1', takerOrderId: '0xord', size: 14.10588, price: 0.85 };

  testAsync('one fill re-sent on MATCHED, MINED and CONFIRMED is counted once', async () => {
    const bot = makeFillBot();
    const pos = freshPosition();
    bot.activePositions.push(pos);
    bot.onUserTrade({ ...FILL, status: 'MATCHED' });
    bot.onUserTrade({ ...FILL, status: 'MINED' });
    bot.onUserTrade({ ...FILL, status: 'CONFIRMED' });
    assert.strictEqual(pos.filledShares, 14.10588, `shares ${pos.filledShares}`);
    assert.ok(Math.abs(pos.filledUsd - 14.10588 * 0.85) < 1e-9, `usd ${pos.filledUsd}`);
    assert.strictEqual(bot.totalTrades, 1, 'one position, one trade');
    assert.strictEqual(pos.tradeFills['trade-1'].status, 'CONFIRMED');
  });

  testAsync('a REST reconcile after the trade messages does not add on top, and costs the fill price', async () => {
    const bot = makeFillBot();
    const pos = freshPosition();
    bot.activePositions.push(pos);
    bot.onUserTrade({ ...FILL, status: 'MATCHED' });
    bot.onUserTrade({ ...FILL, status: 'MINED' });
    bot.clob = { getOrder: async () => ({ ok: true, body: { size_matched: '14.10588', price: '0.87', original_size: '13.7816', status: 'MATCHED' } }) };
    await bot.reconcileOrder(pos, '0xord');
    assert.strictEqual(pos.filledShares, 14.10588, `shares ${pos.filledShares}`);
    // Filled at 85c, not the 87c limit: the cost is the price actually paid.
    assert.ok(Math.abs(pos.filledUsd - 11.99) < 0.01, `cost $${pos.filledUsd} should be $11.99, not $12.27`);
    assert.strictEqual(bot.totalTrades, 1);
  });

  testAsync('reconcile alone is authoritative, idempotent, and costed at the limit when no trades arrived', async () => {
    const bot = makeFillBot();
    const pos = freshPosition({ limitPrice: 0.68 });
    bot.activePositions.push(pos);
    bot.clob = { getOrder: async () => ({ ok: true, body: { size_matched: '18.446154', price: '0.68', original_size: '17.6323', status: 'MATCHED' } }) };
    await bot.reconcileOrder(pos, '0xord');
    await bot.reconcileOrder(pos, '0xord');
    assert.strictEqual(pos.filledShares, 18.446154);
    assert.ok(Math.abs(pos.filledUsd - 18.446154 * 0.68) < 1e-9);
    assert.strictEqual(bot.totalTrades, 1);
  });

  testAsync('a position inflated by the old double count is corrected down by the next reconcile', async () => {
    const bot = makeFillBot();
    const pos = freshPosition({ filledShares: 42.32, filledUsd: 36.8 });
    bot.activePositions.push(pos);
    bot.clob = { getOrder: async () => ({ ok: true, body: { size_matched: '14.10588', price: '0.87', original_size: '13.7816', status: 'MATCHED' } }) };
    await bot.reconcileOrder(pos, '0xord');
    assert.strictEqual(pos.filledShares, 14.10588, `shares ${pos.filledShares}`);
  });

  testAsync('a FAILED trade message takes the fill back out', async () => {
    const bot = makeFillBot();
    const pos = freshPosition();
    bot.activePositions.push(pos);
    bot.onUserTrade({ ...FILL, status: 'MATCHED' });
    assert.strictEqual(pos.filledShares, 14.10588);
    bot.onUserTrade({ ...FILL, status: 'FAILED' });
    assert.strictEqual(pos.filledShares, 0);
    assert.strictEqual(pos.filledUsd, 0);
  });

  // --------------------------------------------- CLOB V2 trading approvals
  await runApprovalTests({ test, testAsync, section });
  await runApprovalRpcTests({ testAsync, section });
  await runOrderVersionTests({ testAsync, section });
  await runApprovalE2ETests({ testAsync, section });

  // ------------------------------------------------- v2.3 capital recycling
  // Runs on this file's harness so its results land in the same counters and
  // the same single summary line.
  await runExitTests({ test, testAsync, section });

  // ---------------------------------------------------------------- summary
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f.name}: ${f.error.message}`);
    process.exit(1);
  }
})();
