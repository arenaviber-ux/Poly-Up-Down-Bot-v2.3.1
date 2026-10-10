'use strict';
/**
 * Tests for Strategy 9 — Passive Reversion (the maker module).
 *
 * Run with `npm run test:maker`.
 *
 * This module is the only one that buys without paying the taker fee, so the
 * things that can quietly turn it from "free" into "expensive" are exactly
 * what these tests pin down:
 *
 *   - the edge really is measured without a fee, and the worst case (it
 *     crossed and took) is still reported;
 *   - a quote can never rest at or above the ask, because that is a taker
 *     order wearing a maker's clothes;
 *   - a paper fill is simulated as a PASSIVE fill, not as walking the ask
 *     ladder — otherwise paper mode reports every quote as a win;
 *   - a resting quote is cancelled when the model stops supporting it, when
 *     its clock runs out, and when the window closes;
 *   - a cancelled unfilled quote becomes TERMINAL, so it cannot park the
 *     whole bot behind MAX_OPEN_POSITIONS.
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
const fs = require('fs');
const path = require('path');

const { CONFIG, validateConfig, resolveEntryFloors, ENTRY_FLOOR_ENV } = require('../config');
const { StrategyEngine, resolveStrategyKey } = require('../strategyEngine');
const { PolymarketAuth } = require('../polymarketAuth');
const { BotCore } = require('../botCore');
const { fairProbUp, entryEdgeTest, makerEdgeTest, normalCdf, feePerShare } = require('../pricing');
const { roundPriceToTick } = require('../orderSigner');

const STATE = path.join(__dirname, '..', 'maker_state.json');
process.env.STATE_FILE = STATE;

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function test(name, fn) { return t(name, async () => fn()); }

// ---------------------------------------------------------------- fixtures
const FEE = { rate: 0.07, exponent: 1, takerOnly: true };
const TICK = 0.01;

function mkBook(bid, ask, { depthUsd = 800, tick = TICK } = {}) {
  const bids = [], asks = [];
  for (let i = 0; i < 5; i++) bids.push({ price: roundPriceToTick(bid - i * tick, tick), size: depthUsd / 5 / bid });
  for (let i = 0; i < 5; i++) asks.push({ price: roundPriceToTick(ask + i * tick, tick), size: depthUsd / 5 / ask });
  return {
    tokenId: 'tok', bids, asks, bestBid: bid, bestAsk: ask,
    spread: +(ask - bid).toFixed(4),
    bidDepthUsd: bids.reduce((a, b) => a + b.price * b.size, 0),
    askDepthUsd: asks.reduce((a, b) => a + b.price * b.size, 0),
    bidDepthShares: bids.reduce((a, b) => a + b.size, 0),
    askDepthShares: asks.reduce((a, b) => a + b.size, 0),
    tickSize: tick, minOrderSize: 5, negRisk: false, receivedAt: Date.now(),
  };
}

/**
 * A synthetic window whose real fairProbUp model returns `pTarget`, with a
 * book whose UP side is quoted `upBid`/`upAsk`.
 */
function makeCtx({ left = 150, pTarget = 0.58, upBid = 0.48, upAsk = 0.50, degraded = false, cfg } = {}) {
  const twapOpen = 84000;
  const sigmaPerSec = 7;
  const nUnknown = Math.min(60, Math.max(0, left));
  const sigma = Math.max(sigmaPerSec, 0.02) * Math.sqrt(nUnknown / 3);
  let lo = -10, hi = 10;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (normalCdf(m) < pTarget) lo = m; else hi = m; }
  const drift = ((lo + hi) / 2) * sigma;
  const eClose = twapOpen + drift;
  const wNow = eClose - drift * 0.35;
  const pNow = nUnknown > 0 ? (eClose * 60 - (60 - nUnknown) * wNow) / nUnknown : eClose;
  const model = fairProbUp({ twapOpen, twapNow: wNow, priceNow: pNow, secondsLeft: left, sigmaPerSec });
  const up = mkBook(upBid, upAsk);
  const down = mkBook(roundPriceToTick(1 - upAsk, TICK), roundPriceToTick(1 - upBid, TICK));
  const endsAtEpoch = Math.floor(Date.now() / 1000) + left;
  return {
    market: {
      slug: 'btc-updown-5m-1', conditionId: '0xcond', question: 'BTC up or down?', timeframe: '5m',
      epoch: 1000, endsAtEpoch, remainingSec: left, tradeable: true, tokenMappingOk: true,
      upTokenId: '123456789', downTokenId: '987654321', windowSeconds: 300,
      feeSchedule: FEE, tickSize: TICK, minOrderSize: 5, negRisk: false,
    },
    books: { up, down },
    model,
    ref: {
      tracker: { rsi: () => 50, stdDevUsd: () => 5, momentumUsd: () => 1, resampled: () => [1], perSecond: () => 7 },
      spots: {}, spotTs: {},
    },
    twap: { value: wNow, source: 'polybolt', authoritative: true },
    spot: { value: pNow },
    windowOpen: { twap: twapOpen, source: 'polybolt' },
    windowOpenStatus: { ok: true, source: 'polybolt' },
    degraded,
    feeSchedule: FEE,
    constraints: { tickSize: TICK, minOrderSize: 5, negRisk: false },
    mode: 'paper',
  };
}

function engineWith(cfg, only) {
  const eng = new StrategyEngine(cfg, { log: () => {} });
  for (const k of Object.keys(eng.strategies)) eng.strategies[k].enabled = (k === only);
  return eng;
}

function cloneCfg() { return JSON.parse(JSON.stringify(CONFIG)); }

// --------------------------------------------------------------- bot harness
function freshBot() {
  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  const cfg = { ...CONFIG, runtime: { ...CONFIG.runtime, stateFile: path.basename(STATE) } };
  const auth = new PolymarketAuth(cfg);
  const bot = new BotCore({ config: cfg, auth, log: () => {} });
  bot.paperMode = true;
  return bot;
}

/** Wire a bot up to a synthetic world so tick()/executeSignal() can be driven. */
function wiredBot({ left = 150, pTarget = 0.58, upBid = 0.48, upAsk = 0.50 } = {}) {
  const bot = freshBot();
  const ctx = makeCtx({ left, pTarget, upBid, upAsk });
  let book = ctx.books.up;
  bot.markets = [ctx.market];
  bot.marketStream = { getBook: () => book, setAssets: () => {} };
  bot.discovery = { getMarkets: async () => [ctx.market] };
  const cancellations = [];
  bot.clob.cancelOrder = async (id) => { cancellations.push(id); return { ok: true, body: {} }; };
  bot.clob.getOrder = async () => ({ ok: true, body: { status: 'LIVE', size_matched: '0', original_size: '10', price: '0.49' } });
  bot.ref = {
    tracker: ctx.ref.tracker,
    spots: {}, spotTs: {},
    getTwap: () => ctx.twap,
    getSpot: () => ctx.spot,
    getWindowOpen: () => ctx.windowOpen,
    getVolatilityPerSec: () => 7,
    observeWindow: () => {},
    ensurePolybolt: () => {},
    health: () => ({ feeds: [] }),
  };
  return {
    bot, ctx, cancellations,
    market: ctx.market,
    /** Replace the UP book the bot will see on its next read. */
    setBook: (b) => { book = b; ctx.books.up = b; },
    getBook: () => book,
  };
}

(async function main() {
  console.log('\nPassive Reversion (strategy 9 — maker)');

  // ------------------------------------------------------------- pricing
  await test('a maker fill is charged no fee; the taker route is', () => {
    const prob = 0.58, price = 0.49;
    const m = makerEdgeTest({
      prob, quotePrice: price, tickSize: TICK, maxBuyPrice: 0.97, feeSchedule: FEE,
      moduleMinNetEdge: 0.015, globalMinNetEdge: 0.015,
    });
    // Priced at the same share: no slippage allowance, because a maker quote
    // has none to apply. Otherwise the comparison would be measuring slippage
    // rather than the fee.
    const k = entryEdgeTest({
      prob, bestAsk: price, tickSize: TICK, maxSlippageCents: 0, maxBuyPrice: 0.97, feeSchedule: FEE,
      moduleMinNetEdge: 0.015, globalMinNetEdge: 0.015,
    });
    assert.strictEqual(m.netEdge, prob - price, 'maker edge must carry no fee term');
    assert.ok(m.netEdge > k.netEdge, 'the maker route must out-earn taking at the same price');
    assert.ok(Math.abs((m.netEdge - k.netEdge) - feePerShare(price, FEE)) < 1e-12,
      'the whole difference is the taker fee');
    // The worst case is still reported, so an operator can see it.
    assert.ok(Math.abs(m.netEdgeIfCrossed - (prob - price - feePerShare(price, FEE))) < 1e-12);
  });

  await test('a maker bid is rounded DOWN to the tick (rounding up can cross)', () => {
    const q = 0.494;
    const m = makerEdgeTest({
      prob: 0.58, quotePrice: q, tickSize: TICK, maxBuyPrice: 0.97, feeSchedule: FEE,
      moduleMinNetEdge: 0.01, globalMinNetEdge: 0.01,
    });
    assert.strictEqual(m.executablePrice, 0.49, `expected 0.49, got ${m.executablePrice}`);
    assert.ok(m.executablePrice <= q + 1e-12, 'a bid must never be rounded up');
  });

  await test('MIN_NET_EDGE still floors the maker gate', () => {
    const m = makerEdgeTest({
      prob: 0.50, quotePrice: 0.49, tickSize: TICK, maxBuyPrice: 0.97, feeSchedule: FEE,
      moduleMinNetEdge: 0.001, globalMinNetEdge: 0.015,
    });
    assert.strictEqual(m.ok, false);
    assert.strictEqual(m.limitedBy, 'global');
  });

  // ------------------------------------------------------------- module
  await test('resolves every alias to makerReversion', () => {
    for (const a of ['makerReversion', 'maker_reversion', 'passiveReversion', 'passive', 'maker', 'makerQuote', 'mr', 'MAKER-REVERSION']) {
      assert.strictEqual(resolveStrategyKey(a), 'makerReversion', `alias ${a}`);
    }
  });

  await test('quotes one tick above the bid and reports the fee it avoided', () => {
    const cfg = cloneCfg();
    const ctx = makeCtx({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const r = engineWith(cfg, 'makerReversion').makerReversion(ctx);
    assert.ok(r.signal, `expected a signal, got: ${r.reason}`);
    assert.strictEqual(r.side, 'UP');
    assert.strictEqual(r.quotePrice, 0.49);
    assert.strictEqual(r.maker, true);
    assert.strictEqual(r.postOnly, true);
    assert.ok(r.edge > r.edgeIfCrossed, 'the maker edge must exceed the take-it edge');
    assert.ok(Math.abs(r.feeAvoidedPerShare - feePerShare(0.49, FEE)) < 1e-9);
    assert.ok(r.restSeconds > 0);
  });

  await test('refuses to quote when the feed is degraded', () => {
    const cfg = cloneCfg();
    const ctx = makeCtx({ degraded: true });
    const r = engineWith(cfg, 'makerReversion').makerReversion(ctx);
    assert.ok(!r.signal);
    assert.match(r.reason, /authoritative TWAP feed/);
  });

  await test('never rests a quote at or above the ask', () => {
    const cfg = cloneCfg();
    // 1-tick spread, huge model edge: the tempting price is the ask itself.
    const ctx = makeCtx({ left: 150, pTarget: 0.90, upBid: 0.49, upAsk: 0.50 });
    const r = engineWith(cfg, 'makerReversion').makerReversion(ctx);
    assert.ok(r.signal, `expected a signal, got: ${r.reason}`);
    assert.ok(r.quotePrice < ctx.books.up.bestAsk - 1e-9,
      `quote ${r.quotePrice} must sit below the ${ctx.books.up.bestAsk} ask`);
  });

  await test('stands down when the book already agrees with the model', () => {
    const cfg = cloneCfg();
    const ctx = makeCtx({ left: 150, pTarget: 0.58, upBid: 0.57, upAsk: 0.59 });
    const r = engineWith(cfg, 'makerReversion').makerReversion(ctx);
    assert.ok(!r.signal);
    assert.match(r.reason, /dislocation/);
  });

  await test('stands down when its best price is too far below the market to fill', () => {
    const cfg = cloneCfg();
    // Model says 96c but MR_MAX_QUOTE_PRICE caps us at 85c, 8 ticks under the bid.
    const ctx = makeCtx({ left: 150, pTarget: 0.96, upBid: 0.93, upAsk: 0.94 });
    const r = engineWith(cfg, 'makerReversion').makerReversion(ctx);
    assert.ok(!r.signal, `expected no signal, got ${JSON.stringify(r)}`);
    assert.match(r.reason, /would not fill/);
  });

  await test('stands down too close to expiry and outside its entry window', () => {
    const cfg = cloneCfg();
    const near = engineWith(cfg, 'makerReversion').makerReversion(makeCtx({ left: 25 }));
    assert.ok(!near.signal); assert.match(near.reason, /only 25s left/);
    const far = engineWith(cfg, 'makerReversion').makerReversion(makeCtx({ left: 280 }));
    assert.ok(!far.signal); assert.match(far.reason, /max 240s/);
  });

  await test('requires a bid to quote behind', () => {
    const cfg = cloneCfg();
    const ctx = makeCtx({});
    ctx.books.up.bids = [];
    ctx.books.up.bestBid = null;
    const r = engineWith(cfg, 'makerReversion').makerReversion(ctx);
    assert.ok(!r.signal);
    assert.match(r.reason, /no bid on UP/);
  });

  await test('ranks against the taker modules on the same `edge` field', () => {
    const cfg = cloneCfg();
    const ctx = makeCtx({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const eng = new StrategyEngine(cfg, { log: () => {} });   // all modules on
    const out = eng.evaluate(ctx);
    assert.ok(out.signal, 'some module should fire in a 10c-dislocated book');
    assert.strictEqual(out.strategy, 'makerReversion',
      'at the same price the fee-free route must win the ranking');
    assert.ok(out.evaluations.find(e => e.key === 'makerReversion').signal);
  });

  // ------------------------------------------------------------- config
  await test('is registered as a strategy and an entry floor', () => {
    assert.ok(CONFIG.strategies.makerReversion, 'config block missing');
    assert.strictEqual(ENTRY_FLOOR_ENV.makerReversion, 'MR_MIN_LEFT');
    const eng = new StrategyEngine(CONFIG, { log: () => {} });
    assert.ok(eng.strategies.makerReversion, 'engine entry missing');
    assert.strictEqual(eng.getState().makerReversion.name, 'Passive Reversion (maker)');
    // Only the account-floor/wallet complaint should remain.
    const errs = validateConfig(CONFIG).filter(e => !/POLY_FUNDER_ADDRESS|POLY_PRIVATE_KEY/.test(e));
    assert.deepStrictEqual(errs, [], `unexpected config errors: ${errs.join('; ')}`);
  });

  await test('a makerReversion floor below the account floor is raised, not ignored', () => {
    const cfg = cloneCfg();
    cfg.strategies.makerReversion.minEntrySecondsLeft = 4;
    resolveEntryFloors(cfg, () => '4');
    assert.strictEqual(cfg.strategies.makerReversion.minEntrySecondsLeft, cfg.risk.minSecondsToExpiry);
  });

  // ------------------------------------------------- execution (paper)
  await test('a paper maker entry rests instead of filling immediately', async () => {
    const { bot, ctx, market } = wiredBot({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const eng = engineWith(bot.cfg, 'makerReversion');
    const decision = eng.makerReversion(ctx);
    assert.ok(decision.signal, decision.reason);
    decision.strategy = 'makerReversion';
    decision.strategyName = 'Passive Reversion (maker)';
    bot.strategies = eng;

    const before = bot.paperBalance;
    const pos = await bot.executeSignal(ctx, decision);
    assert.ok(pos, 'executeSignal returned nothing');
    assert.strictEqual(pos.maker, true);
    assert.strictEqual(pos.status, 'PENDING', 'a resting quote must not be marked filled');
    assert.strictEqual(pos.filledShares, 0);
    assert.strictEqual(pos.quotePrice, decision.quotePrice);
    assert.strictEqual(bot.paperBalance, before, 'no cash is spent until a fill happens');
    assert.strictEqual(bot.totalTrades, 0, 'an unfilled quote is not a trade');
    assert.ok(pos.quoteDeadlineMs > Date.now());
    void market;
  });

  await test('a paper maker fill happens only when the ask reaches the quote', async () => {
    const w = wiredBot({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const { bot, ctx } = w;
    const eng = engineWith(bot.cfg, 'makerReversion');
    const decision = eng.makerReversion(ctx);
    decision.strategy = 'makerReversion';
    decision.strategyName = 'Passive Reversion (maker)';
    bot.strategies = eng;
    const pos = await bot.executeSignal(ctx, decision);
    const quote = pos.quotePrice;
    const shares = pos.requestedShares;
    const before = bot.paperBalance;

    // The market has NOT come down to us: still resting.
    w.setBook(mkBook(0.48, roundPriceToTick(quote + 0.02, TICK)));
    await bot.managePassiveEntries();
    assert.strictEqual(pos.status, 'PENDING', 'must not fill while the ask is above the quote');
    assert.strictEqual(bot.paperBalance, before);

    // The market trades down into the bid.
    w.setBook(mkBook(0.44, quote));
    await bot.managePassiveEntries();
    assert.strictEqual(pos.status, 'FILLED');
    assert.strictEqual(pos.filledShares, shares, 'the whole quote fills at our price');
    assert.strictEqual(pos.avgPrice, quote, 'a passive fill is at OUR price, not the ask');
    assert.strictEqual(pos.feeUsd, 0, 'makers are not charged the taker fee');
    assert.ok(Math.abs((before - bot.paperBalance) - shares * quote) < 1e-9,
      'cash spent is shares x quote, with no fee');
    assert.strictEqual(bot.totalTrades, 1);
  });

  await test('an unfilled quote is cancelled at its deadline and goes terminal', async () => {
    const w = wiredBot({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const { bot, ctx } = w;
    const eng = engineWith(bot.cfg, 'makerReversion');
    const decision = eng.makerReversion(ctx);
    decision.strategy = 'makerReversion';
    bot.strategies = eng;
    const pos = await bot.executeSignal(ctx, decision);

    pos.quoteDeadlineMs = Date.now() - 1;   // clock ran out
    await bot.managePassiveEntries();
    assert.strictEqual(pos.status, 'CANCELLED');
    assert.match(pos.cancelReason || '', /rest window/);
    assert.strictEqual(bot.isRestingQuote(pos), false, 'a cancelled quote is no longer resting');
    assert.strictEqual(BotCore.isTerminalPosition(pos), true,
      'a cancelled quote must not keep counting as open exposure');
    assert.strictEqual(bot.exitablePositions().length, 0, 'it must not block the next window');
  });

  await test('a quote is pulled when the window reaches MIN_SECONDS_TO_EXPIRY', async () => {
    const w = wiredBot({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const { bot, ctx } = w;
    const eng = engineWith(bot.cfg, 'makerReversion');
    const decision = eng.makerReversion(ctx);
    decision.strategy = 'makerReversion';
    bot.strategies = eng;
    const pos = await bot.executeSignal(ctx, decision);

    pos.expiresAtEpoch = Math.floor(Date.now() / 1000) + bot.cfg.risk.minSecondsToExpiry - 1;
    await bot.managePassiveEntries();
    assert.strictEqual(pos.status, 'CANCELLED');
    assert.match(pos.cancelReason || '', /MIN_SECONDS_TO_EXPIRY/);
  });

  await test('a quote is pulled when the ask falls through it (it would take, not make)', async () => {
    const w = wiredBot({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const { bot, ctx } = w;
    const eng = engineWith(bot.cfg, 'makerReversion');
    const decision = eng.makerReversion(ctx);
    decision.strategy = 'makerReversion';
    bot.strategies = eng;
    const pos = await bot.executeSignal(ctx, decision);
    const quote = pos.quotePrice;

    // Sellers are now offering BELOW our bid: the quote has become an offer to
    // take liquidity at a price the edge gate never charged a fee for.
    w.setBook(mkBook(roundPriceToTick(quote - 0.02, TICK), roundPriceToTick(quote - 0.01, TICK)));
    await bot.managePassiveEntries();
    assert.strictEqual(pos.status, 'CANCELLED');
    assert.match(pos.cancelReason || '', /take liquidity/);
  });

  // ------------------------------------------- execution (live-ish shapes)
  await test('a resting quote is pulled when the model stops supporting it', async () => {
    const w = wiredBot({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const { bot, ctx, cancellations } = w;
    const eng = engineWith(bot.cfg, 'makerReversion');
    const decision = eng.makerReversion(ctx);
    decision.strategy = 'makerReversion';
    bot.strategies = eng;

    // Place it through the LIVE path so there is a real order id to cancel.
    bot.paperMode = false;
    bot.auth.hasL2Credentials = () => true;
    bot.auth.checkBalance = async () => ({ ok: true, balance: 100 });
    // A real Wallet, because the order path actually signs: stubbing the wallet
    // would make this test pass on an exception caught three frames up.
    const wallet = new (require('ethers').Wallet)('0x' + require('crypto').randomBytes(32).toString('hex'));
    bot.auth.wallet = wallet;
    bot.auth.funderAddress = wallet.address;
    bot.auth.signerAddress = wallet.address;
    bot.auth.signatureType = 0;
    bot.orderVersionOk = true;
    bot.approvalState = { ok: true, missing: [] };
    let posted = null;
    bot.clob.postOrder = async (order, opts) => {
      posted = opts;
      return { ok: true, body: { success: true, orderID: 'order-1', status: 'live' } };
    };
    const pos = await bot.executeSignal(ctx, decision);
    assert.ok(pos, 'live placement failed');
    assert.deepStrictEqual(posted, { orderType: 'GTD', postOnly: true },
      'a maker entry must be GTD + postOnly regardless of ORDER_TYPE');
    pos.orderIds = ['order-1'];

    // The model has moved against us.
    bot.currentModelProb = async () => Number(pos.quotePrice) - 0.05;
    await bot.managePassiveEntries();
    assert.deepStrictEqual(cancellations, ['order-1'], 'the resting order must be cancelled');
    assert.strictEqual(pos.status, 'CANCELLED');
    assert.match(pos.cancelReason || '', /no longer supports/);
  });

  await test('a partially filled quote keeps its shares when the rest is pulled', async () => {
    const w = wiredBot({ left: 150, pTarget: 0.58, upBid: 0.48, upAsk: 0.51 });
    const { bot, ctx } = w;
    const eng = engineWith(bot.cfg, 'makerReversion');
    const decision = eng.makerReversion(ctx);
    decision.strategy = 'makerReversion';
    bot.strategies = eng;
    const pos = await bot.executeSignal(ctx, decision);
    pos.orderIds = [];
    pos.filledShares = 6;
    pos.minOrderSize = 5;
    pos.quoteDeadlineMs = Date.now() - 1;
    await bot.managePassiveEntries();
    assert.strictEqual(pos.status, 'FILLED', 'a partial fill is a real position, not a cancellation');
    assert.strictEqual(pos.filledShares, 6);
    assert.ok(pos.passiveCancelled);
  });

  await test('an unfilled order cancelled by the timeout becomes terminal', async () => {
    const { bot } = wiredBot({});
    const pos = { id: 'p1', maker: true, filledShares: 0, minOrderSize: 5, orderIds: ['o1'], status: 'PENDING' };
    bot.activePositions = [pos];
    await bot.cancelIfResting(pos, 'o1');
    assert.strictEqual(pos.status, 'CANCELLED', 'a cancelled unfilled order must not stay PENDING');
    assert.strictEqual(BotCore.isTerminalPosition(pos), true);
  });

  await test('ORDER_TYPE=FAK does not apply to maker entries', () => {
    // The guard is in executeSignal; assert the intent at the config level too.
    assert.strictEqual(CONFIG.order.orderType, 'FAK');
    assert.strictEqual(CONFIG.strategies.makerReversion.postOnly, true);
  });

  // ----------------------------------------------------------------- done
  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  // BotCore starts its own timers and the real ReferencePrice opens feeds on
  // construction; without an explicit exit this suite would hang on those
  // handles rather than reporting.
  process.exit(failed ? 1 : 0);
})();
