'use strict';
/**
 * The order-version handshake.
 *
 * Which exchange contract an order is signed against is not fixed: the CLOB
 * reports the version it is currently accepting on `GET /version` (1 = legacy
 * CTF Exchange, 2 = the CLOB V2 CTF exchanges, 3 = ExchangeV3 / Protocol V2
 * positions), and Polymarket's own client reads it before building an order and
 * re-reads it when the server answers `order_version_mismatch`.
 *
 * This bot signs for version 2 only. These tests pin down what happens when the
 * server says otherwise: the bot must say so in plain words and refuse to trade,
 * rather than submit an order that cannot be matched.
 *
 * Runs as part of `npm test`.
 */
const assert = require('assert');
const http = require('http');

const { ClobClient, SIGNED_ORDER_VERSION } = require('../clobClient');
const { MarketDiscovery } = require('../marketDiscovery');
const { CONFIG } = require('../config');
const { PolymarketAuth } = require('../polymarketAuth');
const { BotCore } = require('../botCore');

const fs = require('fs');
const path = require('path');
const STATE = path.join(__dirname, '..', 'itest_orderversion_state.json');

/** A stand-in for clob.polymarket.com that answers `GET /version`. */
function startFakeClob(response) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof response === 'function' ? response(hits.length) : JSON.stringify(response));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      hits,
      close: () => new Promise(r => server.close(r)),
    });
  }));
}

function clobFor(clobUrl, authOverrides = {}) {
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.endpoints.clob = clobUrl;
  const auth = new PolymarketAuth(cfg);
  Object.assign(auth, {
    apiKey: 'key',
    hasL2Credentials: () => true,
    signedRequest: async () => ({ ok: true, status: 200, body: {} }),
    ...authOverrides,
  });
  return new ClobClient(cfg, auth);
}

// ------------------------------------------------------------------- runner
let passed = 0, failed = 0;
const failures = [];
function section(t) { console.log(`\n${t}`); }
async function t_(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

module.exports = async function runOrderVersionTests(harness = {}) {
  const { testAsync, section: sec = section } = harness;
  const standalone = !testAsync;
  const t = testAsync || t_;

  sec('CLOB V2 — the order version the server is accepting');

  await t('version 2 is read from GET /version and matches what the bot signs', async () => {
    const node = await startFakeClob({ version: 2 });
    try {
      const r = await clobFor(node.url).getOrderVersion();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.version, 2);
      assert.strictEqual(SIGNED_ORDER_VERSION, 2, 'this bot signs CLOB V2 CTF Exchange orders');
      assert.deepStrictEqual(node.hits, ['/version']);
    } finally { await node.close(); }
  });

  await t('a server that has moved to version 3 is reported, not assumed away', async () => {
    const node = await startFakeClob({ version: 3 });
    try {
      const r = await clobFor(node.url).getOrderVersion();
      assert.strictEqual(r.ok, true, 'the endpoint answered; the mismatch is the finding');
      assert.strictEqual(r.version, 3);
    } finally { await node.close(); }
  });

  await t('a response without a version field means 2, like the official client', async () => {
    const node = await startFakeClob({});
    try {
      const r = await clobFor(node.url).getOrderVersion();
      assert.strictEqual(r.version, 2);
    } finally { await node.close(); }
  });

  await t('the answer is cached, and force re-reads it', async () => {
    let n = 0;
    const node = await startFakeClob(() => { n++; return JSON.stringify({ version: n === 1 ? 2 : 3 }); });
    try {
      const clob = clobFor(node.url);
      assert.strictEqual((await clob.getOrderVersion()).version, 2);
      assert.strictEqual((await clob.getOrderVersion()).version, 2, 'cached — no second request');
      assert.strictEqual(node.hits.length, 1);
      assert.strictEqual((await clob.getOrderVersion(true)).version, 3, 'force re-reads the server');
      assert.strictEqual(node.hits.length, 2);
    } finally { await node.close(); }
  });

  await t('an unreachable CLOB is an error, never a guessed version', async () => {
    const r = await clobFor('http://127.0.0.1:1').getOrderVersion();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.version, null);
    assert.ok(r.error, 'the failure is reported');
  });

  await t('an order_version_mismatch rejection is named, and drops the cached version', async () => {
    const node = await startFakeClob({ version: 2 });
    try {
      const clob = clobFor(node.url, {
        signedRequest: async () => ({
          ok: false,
          status: 400,
          body: { error: 'order_version_mismatch: expected version 3' },
        }),
      });
      await clob.getOrderVersion();
      assert.strictEqual(node.hits.length, 1);
      const r = await clob.postOrder({ order: { maker: '0x0' } }, { orderType: 'GTC' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.orderVersionMismatch, true);
      assert.match(r.error, /different order version/);
      // The cached version must be gone, so the next attempt re-reads the server.
      await clob.getOrderVersion();
      assert.strictEqual(node.hits.length, 2, 'the mismatch invalidated the cache');
    } finally { await node.close(); }
  });

  await t('an ordinary rejection is passed through untouched', async () => {
    const node = await startFakeClob({ version: 2 });
    try {
      const clob = clobFor(node.url, {
        signedRequest: async () => ({ ok: false, status: 400, body: { error: 'not enough balance / allowance' } }),
      });
      const r = await clob.postOrder({ order: { maker: '0x0' } }, { orderType: 'GTC' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(!!r.orderVersionMismatch, false, 'a funding rejection is not a version problem');
    } finally { await node.close(); }
  });

  sec('CLOB V2 — BotCore refuses to trade against the wrong exchange');

  function botFor(cfg, { version = 2, versionOk = true } = {}) {
    if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
    const c = JSON.parse(JSON.stringify(cfg));
    c.runtime.stateFile = path.basename(STATE);
    c.runtime.paperMode = false;
    const auth = new PolymarketAuth(c);
    Object.assign(auth, {
      hasL2Credentials: () => true,
      apiKey: 'key',
      checkBalance: async () => ({ ok: true, balance: 50 }),
      checkBalanceAllowance: async () => ({ ok: true, balance: 50, allowance: 1000, allowances: {}, missingApprovals: [] }),
      syncBalanceAllowance: async () => ({ ok: true }),
    });
    const bot = new BotCore({ config: c, auth, log: () => {} });
    bot.clob.getOrderVersion = async () => (versionOk ? { ok: true, version } : { ok: false, version: null, error: 'unreachable' });
    bot.clob.postOrder = async () => { throw new Error('an order must not be submitted in this test'); };
    bot.redeemer.relayer = {
      isConfigured: () => true,
      getStatus: () => ({ configured: true, authMode: 'relayer-api-key', txType: 'WALLET', lastError: null }),
      readiness: () => ({ ready: true, mode: 'WALLET' }),
      readTradingApprovals: async () => ({ ok: true, owner: '0xwallet', checks: [], missing: [] }),
    };
    return bot;
  }

  const ctx = {
    market: { upTokenId: '11', downTokenId: '22', tokenMappingOk: true, negRisk: false },
    constraints: { tickSize: 0.01 },
    feeSchedule: null,
    books: { up: { bestAsk: 0.5, bestBid: 0.49 }, down: { bestAsk: 0.5, bestBid: 0.49 } },
  };
  const decision = { side: 'UP', strategy: 'test', strategyName: 'Test', prob: 0.6 };

  await t('version 2 is accepted and reported once', async () => {
    const bot = botFor(CONFIG);
    const r = await bot.checkOrderVersion();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(bot.orderVersion, 2);
    assert.strictEqual(bot.orderVersionOk, true);
    assert.strictEqual(bot.getState().orderVersion, 2);
    const info = bot.logs.filter(l => /order version/.test(l.message));
    assert.strictEqual(info.length, 1, 'reported once, not on every pre-flight');
    await bot.checkOrderVersion();
    assert.strictEqual(bot.logs.filter(l => /order version/.test(l.message)).length, 1);
  });

  await t('a version-3 server is an ERROR, and a live entry is refused', async () => {
    const bot = botFor(CONFIG, { version: 3 });
    const r = await bot.checkOrderVersion();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(bot.orderVersionOk, false);
    const errs = bot.logs.filter(l => l.level === 'ERROR').map(l => l.message);
    assert.ok(errs.some(m => /order version 3/.test(m) && /order_version_mismatch|rejected/i.test(m)), errs.join(' | '));
    const placed = await bot.executeSignal(ctx, decision);
    assert.strictEqual(placed, null, 'no order may be built for the wrong exchange');
    assert.match(bot.lastSkipReason, /order version 3/);
    assert.strictEqual(bot.getState().orderVersionOk, false);
  });

  await t('the gate re-checks the server before refusing, so a rollback unblocks it', async () => {
    let version = 3;
    const bot = botFor(CONFIG, { version: 3 });
    await bot.checkOrderVersion();
    assert.strictEqual(bot.orderVersionOk, false);
    // Polymarket rolls the book back: the gate must notice instead of refusing
    // forever on a stale reading.
    bot.clob.getOrderVersion = async () => ({ ok: true, version: 2 });
    void version;
    await bot.executeSignal(ctx, decision).catch(() => null);
    assert.strictEqual(bot.orderVersionOk, true, 'a fresh read of version 2 clears the block');
    assert.ok(!/order version/.test(bot.lastSkipReason || ''), bot.lastSkipReason);
  });

  await t('an unreadable /version warns and does not stop trading', async () => {
    const bot = botFor(CONFIG, { versionOk: false });
    const r = await bot.checkOrderVersion();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(bot.orderVersionOk, null, 'unknown is not a mismatch');
    assert.ok(bot.logs.some(l => l.level === 'WARN' && /order version/.test(l.message)));
    // The gate only fires on a known mismatch, so this still reaches sizing.
    await bot.executeSignal(ctx, decision).catch(() => null);
    assert.ok(!/order version/.test(bot.lastSkipReason || ''), bot.lastSkipReason);
  });

  sec('CLOB V2 — a Protocol-V2 market is not traded with a CTF token ID');

  const parse = (extra) => {
    const md = new MarketDiscovery(CONFIG, () => {});
    return md.parseEvent({
      id: 1, slug: 'btc-updown-5m-1', title: 'Bitcoin Up or Down',
      markets: [{
        id: 9, question: 'Up or Down?', conditionId: '0x' + 'ab'.repeat(32),
        outcomes: '["Up","Down"]', outcomePrices: '["0.5","0.5"]',
        clobTokenIds: '["111","222"]', active: true, closed: false, acceptingOrders: true,
        ...extra,
      }],
    }, 'btc-updown-5m-1');
  };

  await t('Gamma version is captured, and absent means a CTF market', async () => {
    assert.strictEqual(parse({}).marketVersion, null);
    assert.strictEqual(parse({}).protocolV2, false, 'an absent version must not stand the market down');
    assert.strictEqual(parse({ version: 'v1' }).protocolV2, false);
    assert.strictEqual(parse({ version: 'V2' }).protocolV2, true, 'case-insensitive');
    assert.strictEqual(parse({ version: 2 }).protocolV2, false, 'a numeric 2 is not the string "v2"');
  });

  await t('a Protocol-V2 market is not reported as tradeable', async () => {
    const md = new MarketDiscovery(CONFIG, () => {});
    md.fetchEvent = async () => parse({ version: 'v2' });
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.market.timeframes = ['5m'];
    const md2 = new MarketDiscovery(cfg, () => {});
    md2.fetchEvent = async () => parse({ version: 'v2' });
    const markets = await md2.getMarkets();
    void md;
    assert.ok(markets.length, 'the window is still discovered');
    assert.ok(markets.every(m => !m.tradeable), 'but it is not tradeable');
  });

  await t('the entry path refuses a Protocol-V2 market and names it', async () => {
    const bot = botFor(CONFIG);
    const v2ctx = { ...ctx, market: { ...ctx.market, slug: 'btc-updown-5m-1', protocolV2: true } };
    const placed = await bot.executeSignal(v2ctx, decision);
    assert.strictEqual(placed, null);
    assert.match(bot.lastSkipReason, /Protocol-V2 market/);
    assert.match(bot.lastSkipReason, /btc-updown-5m-1/);
    assert.ok(bot.logs.some(l => l.level === 'ERROR' && /Protocol-V2/.test(l.message)));
  });

  await t('the same market without the flag still reaches the order path', async () => {
    const bot = botFor(CONFIG);
    await bot.executeSignal({ ...ctx, market: { ...ctx.market, protocolV2: false } }, decision)
      .catch(() => null);
    assert.ok(!/Protocol-V2/.test(bot.lastSkipReason || ''), bot.lastSkipReason);
  });

  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);

  if (standalone) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log('\n  Failures:');
      for (const f of failures) console.log(`   - ${f.name}: ${f.error.message.split('\n')[0]}`);
    }
  }
  return { passed, failed };
};

if (require.main === module) {
  module.exports().then(({ failed }) => process.exit(failed ? 1 : 0));
}
