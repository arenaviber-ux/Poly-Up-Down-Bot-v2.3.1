'use strict';
/**
 * HTTP API + dashboard host.
 *
 * Security note: the API can drive live orders, so it binds to 127.0.0.1 by
 * default and requires an explicit opt-in (BIND_HOST) to widen that. A private
 * key should never be entered through a web form on a shared machine; the
 * recommended path is the .env file (mode 600) or the settings endpoint on a
 * loopback-only dashboard.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');

const { CONFIG, validateConfig, configWarnings, effectivePaperMode, envFile } = require('./config');
const { PolymarketAuth } = require('./polymarketAuth');
const { BotCore } = require('./botCore');
const { SIGNED_ORDER_VERSION } = require('./clobClient');
const { feePerShare, fairProbUp } = require('./pricing');
const { sizeOrder, tickRules } = require('./orderSigner');

// This API can place live orders and accepts a private key: loopback only
// unless the operator explicitly widens it, and never a wildcard CORS policy.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

const app = express();
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : { origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const configErrors = validateConfig(CONFIG);
const auth = new PolymarketAuth(CONFIG);
const bot = new BotCore({ config: CONFIG, auth, log: (level, msg) => console.log(`[${level}] ${msg}`) });

// Surface configuration problems immediately rather than at the first order.
for (const e of configErrors) bot.logLine('ERROR', `Config: ${e}`);
// ...and the settings that are legal but change what a threshold means.
const configNotes = configWarnings(CONFIG);
for (const w of configNotes) bot.logLine('WARN', `Config: ${w}`);

// --------------------------------------------------------------- read APIs
app.get('/api/state', (req, res) => res.json(bot.getState()));

app.get('/api/health', (req, res) => {
  const s = bot.getState();
  res.json({
    ok: configErrors.length === 0,
    configErrors,
    configWarnings: configNotes,
    running: s.isRunning,
    mode: s.paperMode ? 'paper' : 'live',
    geoblock: s.geoblock,
    ws: s.ws,
    feeds: s.feeds,
    auth: {
      configured: s.auth.isAuthenticated,
      hasCredentials: s.auth.hasCredentials,
      walletSetup: s.auth.walletSetup,
      signatureTypeName: s.auth.signatureTypeName,
      accountWallet: s.auth.accountWallet,
    },
  });
});

app.get('/api/markets', (req, res) => {
  res.json({ ok: true, markets: bot.markets });
});

app.get('/api/diagnostics', async (req, res) => {
  const out = { at: new Date().toISOString(), checks: [] };
  const add = (name, ok, detail) => out.checks.push({ name, ok, detail });

  add('config', configErrors.length === 0, configErrors.length ? configErrors.join(' | ') : 'valid');

  const geo = await auth.checkGeoblock().catch(() => null);
  add('geoblock', geo ? !geo.blocked : false,
    geo ? `${geo.country || '?'}${geo.region ? '/' + geo.region : ''} blocked=${geo.blocked}` : 'unreachable');
  bot.geoblock = geo;

  add('wallet-setup', auth.validateWalletSetup().ok, auth.validateWalletSetup().error || 'ok');
  add('credentials', auth.hasL2Credentials(), auth.credentialsSource);

  // Which exchange contract the server wants orders signed for. This bot signs
  // version 2 (the CLOB V2 CTF exchanges); anything else is a hard rejection.
  const ver = await bot.clob.getOrderVersion(true).catch(e => ({ ok: false, version: null, error: e.message }));
  bot.orderVersion = ver.ok ? ver.version : null;
  bot.orderVersionOk = ver.ok ? ver.version === SIGNED_ORDER_VERSION : null;
  // "could not verify" is reported as a failure here, like the approval check
  // below — the bot still trades, but the dashboard must not claim a green tick
  // for something it never read.
  add('order-version', ver.ok && bot.orderVersionOk === true,
    !ver.ok ? `unreachable: ${ver.error}`
      : bot.orderVersionOk ? `version ${ver.version} (what this bot signs for)`
        : `version ${ver.version} — this bot signs for ${SIGNED_ORDER_VERSION}; live orders will be rejected`);

  if (auth.hasL2Credentials()) {
    const ping = await bot.clob.pingPrivate().catch(e => ({ ok: false, error: e.message }));
    add('l2-auth', ping.ok, ping.ok ? 'authenticated' : (ping.error || `status ${ping.status}`));
    const bal = await auth.checkBalanceAllowance().catch(() => null);
    add('balance', !!(bal && bal.ok && bal.balance > 0), bal && bal.ok ? `$${bal.balance.toFixed(2)} (allowance $${bal.allowance.toFixed(2)})` : 'unavailable');
  }

  // Whether an order can actually settle is decided by on-chain approvals,
  // not by the CLOB's cached allowance. Read them here (read-only — the
  // dashboard must not submit a transaction from a GET).
  const approvalRelayer = bot.redeemer && bot.redeemer.relayer;
  if (approvalRelayer) {
    const ap = await approvalRelayer.readTradingApprovals()
      .catch(e => ({ ok: false, checks: [], missing: [], error: e.message }));
    bot.approvalState = ap;
    add('exchange-approvals', !!(ap.ok && !(ap.missing || []).length),
      ap.error && !ap.checks.length ? `unreadable: ${ap.error}`
        : (ap.missing || []).length
          ? `missing: ${ap.missing.map(m => m.label).join('; ')} — POST /api/approve`
          : `all ${(ap.checks || []).length} granted (pUSD + conditional tokens, both V2 exchanges and both collateral adapters)`);
  }

  add('ws-market', bot.marketStream.isFresh(60000), `connected=${bot.marketStream.ws ? bot.marketStream.ws.readyState === 1 : false}`);
  const refHealth = bot.ref.health();
  add('twap-feed', refHealth.twapAuthoritative, refHealth.twapAuthoritative
    ? 'PolyBolt Chainlink 60s TWAP live'
    : `fallback: ${refHealth.twapSource || 'none'} (${refHealth.polybolt.lastError || 'not connected'})`);
  add('spot-feeds', !!(refHealth.coinbase.price || refHealth.kraken.price),
    `coinbase=${refHealth.coinbase.price ?? '—'} kraken=${refHealth.kraken.price ?? '—'}`);

  // Capital recycling. Without these two checks a live bot can drain its own
  // balance into unredeemable tokens and every other check still reports green.
  const st = bot.getState();
  add('pre-expiry-exit', !!(st.exitEnabled && st.exit),
    st.exitEnabled
      ? `armed: sells at ${(st.exit.config.maxSecondsToExpiry)}s→${st.exit.config.minSecondsToExpiry}s before close, `
        + `model ≥ ${(st.exit.config.minModelProb * 100).toFixed(0)}%, bid `
        + `${(st.exit.config.minSellPrice * 100).toFixed(0)}–${(st.exit.config.maxSellPrice * 100).toFixed(1)}c `
        + `(${st.exit.filled} filled / ${st.exit.attempted} attempted, $${(st.exit.recycledUsd || 0).toFixed(2)} recycled)`
      : 'DISABLED — wins are held to resolution and only the sweeper can recycle them');

  const rd = bot.redeemer.getState();
  add('redemption-sweeper', !!(st.autoRedeem && (rd.ready || st.paperMode)),
    st.autoRedeem
      ? (rd.ready
          ? `ready via ${rd.mode}, output ${rd.outputToken}, every ${Math.round(rd.everyMs / 1000)}s `
            + `(${rd.redeemedThisSession} redeemed, ${rd.pending} queued, ${rd.failedThisSession} failed this session)`
          // ok:true in paper mode is correct — the sweep is simulated and wins
          // are credited at settlement — so the detail must say that rather than
          // reading as a failure that was graded a pass.
          : (st.paperMode ? `paper mode: ${rd.reason}` : `ON but not usable — ${rd.reason}`))
      : 'DISABLED — resolved wins must be redeemed by hand in the Polymarket UI');

  if (!st.paperMode) {
    const locked = (st.exit.positions || []).reduce((a, p) => a + (p.remainingShares || 0), 0);
    const collateral = st.collateral.live;
    // The diagnostic that actually catches the drain: money at risk in tokens
    // that the order path cannot see, against a collateral balance near zero.
    add('capital-loop', !(Number.isFinite(collateral) && collateral <= 0 && (st.realizedPnl || 0) > 0),
      `tradeable collateral $${Number.isFinite(collateral) ? collateral.toFixed(2) : '?'} · `
      + `${locked.toFixed(2)} share(s) still awaiting resolution · `
      + `realised P&L $${(st.realizedPnl || 0).toFixed(2)}`
      + (Number.isFinite(collateral) && collateral <= 0 && (st.realizedPnl || 0) > 0
          ? ' — P&L is positive but nothing is spendable: wins are locked in tokens'
          : ''));
  }

  res.json(out);
});

// -------------------------------------------------------------- bot control
app.post('/api/bot/start', (req, res) => { bot.start(); res.json({ ok: true, isRunning: bot.isRunning }); });
app.post('/api/bot/stop', (req, res) => { bot.stop('User manually paused the bot'); res.json({ ok: true, isRunning: bot.isRunning }); });
app.post('/api/bot/reset', (req, res) => { bot.resetPaperAccount(); res.json({ ok: true }); });

app.post('/api/settings', (req, res) => {
  try {
    const state = bot.updateSettings(req.body || {});
    res.json({ ok: true, state });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------- auth API
app.post('/api/auth/configure', async (req, res) => {
  const { email, privateKey, funderAddress, signatureType, apiKey, apiSecret, apiPassphrase, derive } = req.body || {};
  try {
    const status = auth.configureAccount({ email, privateKey, funderAddress, signatureType, apiKey, apiSecret, apiPassphrase });
    let derived = null;
    let geoblock = null;
    if (derive) {
      derived = await auth.deriveApiCredentials();
      geoblock = await auth.checkGeoblock();
      bot.geoblock = geoblock;
    }
    res.json({ ok: true, auth: auth.getStatus(), derived: !!derived, geoblock });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, auth: auth.getStatus() });
  }
});

app.get('/api/auth/status', (req, res) => res.json({ ok: true, auth: auth.getStatus() }));
app.post('/api/auth/derive', async (req, res) => {
  try {
    await auth.deriveApiCredentials();
    res.json({ ok: true, auth: auth.getStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
app.get('/api/auth/balance', async (req, res) => {
  try {
    const bal = await auth.checkBalance();
    res.json({ ok: true, ...bal });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
app.get('/api/geoblock', async (req, res) => {
  const geo = await auth.checkGeoblock();
  bot.geoblock = geo;
  res.json(geo);
});

// ------------------------------------------------------------- approvals
/**
 * Grant the four trading approvals from the account wallet (gasless relayer
 * batch), then re-read them and refresh the CLOB cache.
 *
 *   POST /api/approve                grant whatever is missing
 *   POST /api/approve {"dryRun":1}   report what would be submitted
 *   POST /api/approve {"force":1}    re-approve even when already granted
 *
 * This is the dashboard twin of `npm run approve`; without it the only remedy
 * for "allowance is 0" is a shell.
 */
app.post('/api/approve', async (req, res) => {
  const relayer = bot.redeemer && bot.redeemer.relayer;
  if (!relayer) return res.status(400).json({ ok: false, error: 'no relayer client available' });
  const { force = false, dryRun = false } = req.body || {};
  if (!dryRun && !relayer.isConfigured()) {
    return res.status(400).json({
      ok: false,
      error: 'relayer not configured — set RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS '
        + '(polymarket.com → Settings → API Keys → Relayer API Keys)',
    });
  }
  try {
    const r = await relayer.setupTradingApprovals({ force: !!force, dryRun: !!dryRun });
    const state = await relayer.readTradingApprovals().catch(() => null);
    bot.approvalState = state;
    bot.allowanceWarning = !!(state && (state.missing || []).length);
    if (!dryRun) await auth.syncBalanceAllowance({ force: true }).catch(() => null);
    bot.logLine(r.ok ? 'SUCCESS' : 'ERROR', dryRun
      ? `Approval dry run: ${(r.submitted || []).length} call(s) would be submitted`
      : r.ok
        ? `Exchange approvals granted${r.transactionHash ? ` (tx ${String(r.transactionHash).slice(0, 18)}…)` : ''}`
        : `Could not grant the exchange approvals: ${r.error || 'unknown error'}`);
    // A failed grant is a 400, not a 200 with ok:false — a dashboard polling
    // this endpoint must not have to inspect the body to learn it failed.
    res.status(r.ok ? 200 : 400).json({
      ok: !!r.ok,
      ...r,
      approvals: state ? {
        missing: (state.missing || []).map(m => m.label),
        checks: (state.checks || []).map(c => ({ label: c.label, granted: c.granted, allowance: c.allowance, approved: c.approved })),
      } : null,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ------------------------------------------------------------- sizing helper
/**
 * Explain — before any order is sent — exactly what the bot would do:
 * shares, cost, fee, net edge and the minimum-order adjustment.
 */
app.post('/api/quote', (req, res) => {
  const { tokenId, side = 'UP', stakeUsd } = req.body || {};
  const market = bot.markets.find(m => m.upTokenId === tokenId || m.downTokenId === tokenId) || bot.markets[0];
  if (!market) return res.status(400).json({ ok: false, error: 'no market' });
  const book = bot.marketStream.getBook(tokenId)
    || (side === 'UP' ? bot.marketStream.getBook(market.upTokenId) : bot.marketStream.getBook(market.downTokenId));
  if (!book || book.bestAsk === null) return res.status(400).json({ ok: false, error: 'no ask liquidity' });

  const tickSize = book.tickSize || market.tickSize || CONFIG.order.tickSize;
  const minShares = book.minOrderSize || market.minOrderSize || CONFIG.order.minShares;
  const price = Math.min(CONFIG.order.maxBuyPrice, book.bestAsk + CONFIG.order.maxSlippageCents / 100);
  const sizing = sizeOrder({
    stakeUsd: stakeUsd || bot.tradeAmountUsd, price, minShares, tickSize,
    maxStakeUsd: bot.maxTradeAmountUsd, minOrderPolicy: CONFIG.order.minOrderPolicy,
  });
  const fs_ = market.feeSchedule || { rate: CONFIG.fees.defaultTakerRate, exponent: 1 };
  res.json({
    ok: true,
    market: { slug: market.slug, remainingSec: market.remainingSec },
    book: { bestBid: book.bestBid, bestAsk: book.bestAsk, spread: book.spread, askDepthUsd: +book.askDepthUsd.toFixed(2) },
    constraints: { tickSize, minShares, rules: tickRules(tickSize) },
    sizing,
    price,
    feePerShare: feePerShare(price, fs_),
    feeTotal: sizing.ok ? feePerShare(price, fs_) * sizing.shares : null,
    note: !sizing.ok
      ? `Not traded: ${sizing.reason}`
      : sizing.bumped
        ? `Stake raised to the ${minShares}-share market minimum`
        : 'Stake is above the market minimum',
  });
});

// --------------------------------------------------------------- trading API
app.post('/api/trade', async (req, res) => {
  // Manual snipe: runs the same guarded path as an automatic signal.
  try {
    const { side = 'UP' } = req.body || {};
    const market = bot.markets.find(m => m.tradeable && m.remainingSec > 0);
    if (!market) return res.status(400).json({ ok: false, error: 'no tradeable window' });
    const ctx = await bot.buildContext(market);
    if (!ctx) return res.status(400).json({ ok: false, error: 'no market data' });
    const book = side === 'UP' ? ctx.books.up : ctx.books.down;
    const prob = side === 'UP' ? ctx.model.pUp : ctx.model.pDown;
    const decision = {
      signal: side === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      side,
      prob,
      price: book.bestAsk,
      edge: prob - book.bestAsk - feePerShare(book.bestAsk, ctx.feeSchedule),
      strategy: 'manual',
      strategyName: 'Manual snipe',
      reason: 'manual dashboard snipe',
    };
    const pos = await bot.executeSignal(ctx, decision);
    if (!pos) return res.status(400).json({ ok: false, error: bot.lastSkipReason || 'order not placed (see logs)' });
    res.json({ ok: true, position: pos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/positions/:id/cancel', async (req, res) => {
  const pos = bot.activePositions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ ok: false, error: 'position not found' });
  // Cancelling a position must not kill a SELL that is still trying to return
  // the operator's capital. Exit orders are cancelled only when asked for.
  const wantExits = String((req.body || {}).includeExitOrders || '') === 'true'
    || req.query.includeExitOrders === 'true';
  const results = [];
  for (const orderId of pos.orderIds) {
    if (orderId === 'dry-run') continue;
    const r = await bot.clob.cancelOrder(orderId).catch(e => ({ ok: false, error: e.message }));
    results.push({ orderId, kind: 'entry', ok: r.ok, error: r.body && (r.body.errorMsg || r.body.error) });
  }
  if (wantExits) {
    for (const orderId of pos.exitOrderIds || []) {
      if (orderId === 'dry-run-exit') continue;
      const r = await bot.clob.cancelOrder(orderId).catch(e => ({ ok: false, error: e.message }));
      results.push({ orderId, kind: 'exit', ok: r.ok, error: r.body && (r.body.errorMsg || r.body.error) });
    }
    pos.exiting = false;
  }
  res.json({ ok: results.every(r => r.ok), results, position: pos });
});

// ------------------------------------------------- capital recycling (v2.3)
/**
 * Run one exit pass now. The loop already does this every tick; the endpoint
 * exists so an operator watching a window close can force the decision and see
 * the reason it stood down, instead of guessing from the log.
 */
app.post('/api/exit/run', async (req, res) => {
  try {
    const r = await bot.forceExitPass();
    res.json({ ok: r.ok !== false, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/exit/status', (req, res) => {
  const s = bot.getState();
  res.json({ ok: true, enabled: s.exitEnabled, exit: s.exit, collateral: s.collateral });
});

/**
 * Force a redemption sweep. `?wait=false` returns immediately with the queued
 * count; the default waits for the sweep so the UI can report the outcome.
 */
app.post('/api/redeem/run', async (req, res) => {
  try {
    const r = await bot.runRedeemSweep({ force: true, manual: true });
    res.json({ ok: !!(r && r.ran), result: r, reason: r && r.reason });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/redeem/status', (req, res) => {
  res.json({ ok: true, enabled: bot.autoRedeem, redeem: bot.redeemer.getState() });
});

/**
 * What is currently claimable, without claiming it. Useful before turning the
 * sweeper on: shows whether the Data API sees the positions the bot believes it
 * is holding, which is the discrepancy that makes redemption look broken.
 */
app.get('/api/redeem/preview', async (req, res) => {
  try {
    const ready = bot.redeemer.readiness();
    if (!bot.auth.funderAddress) {
      // Say which variable to set. "no account wallet address configured" reads
      // like a bug in the endpoint rather than a missing .env line, and this is
      // the first thing anyone hits when trying the sweeper out.
      return res.json({
        ok: false, ready, accountWallet: null, count: 0, totalShares: 0, positions: [],
        queuedByBot: bot.redeemer.pending.size,
        error: 'POLY_FUNDER_ADDRESS is not set — the Data API is queried by wallet address, '
          + 'so there is nothing to look up. Copy it from polymarket.com (your deposit wallet / '
          + 'proxy address, shown in Settings) into .env and restart.',
      });
    }
    const found = await bot.redeemer.fetchRedeemablePositions();
    const grouped = [...require('./redeemer').groupByCondition(found.positions).values()]
      .map(g => ({
        conditionId: g.conditionId, title: g.title,
        shares: +g.totalSize.toFixed(4), negativeRisk: g.negativeRisk,
        outcomes: g.positions.map(p => ({ outcome: p.outcome, size: p.size, value: p.currentValue })),
      }));
    res.json({
      ok: found.ok,
      ready,
      accountWallet: bot.auth.funderAddress,
      count: grouped.length,
      totalShares: +grouped.reduce((a, g) => a + g.shares, 0).toFixed(4),
      positions: grouped,
      queuedByBot: bot.redeemer.pending.size,
      error: found.error || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------------------------------------------------------- explain
app.get('/api/pricing-explain', (req, res) => {
  const ctxSample = 'See STRATEGIES.md for the full derivation.';
  const demo = fairProbUp({
    twapOpen: 100000, twapNow: 100000, priceNow: 100150, secondsLeft: 120,
    sigmaPerSec: 20, twapWindow: 60,
  });
  res.json({ ok: true, demo, formula: ctxSample });
});

const server = app.listen(CONFIG.runtime.port, BIND_HOST, () => {
  console.log('');
  // Read the version from package.json rather than hard-coding it: the banner
  // said "v2 (patched)" while package.json said 2.3.0, which makes it impossible
  // to tell from a log which build is actually running.
  console.log(`  ⚡ Poly Up/Down Bot v${require('./package.json').version} (patched)`);
  console.log(`     dashboard: http://${BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST}:${CONFIG.runtime.port}`);
  console.log(`     asset:     ${CONFIG.market.asset.toUpperCase()} ${CONFIG.market.timeframes.join('/')}`);
  // Print the mode the bot will ACTUALLY run in. CONFIG.runtime.paperMode is only
  // the PAPER_MODE default: BotCore's constructor has already run loadState(), and
  // a saved bot_state.json overrides it. Reading the config value here printed
  // "mode: PAPER" on the banner of a bot that then logged "Bot started in LIVE
  // mode" — the exact case where a misleading banner costs real money.
  const eff = effectivePaperMode(CONFIG);
  console.log(`     mode:      ${eff.paperMode ? 'PAPER' : 'LIVE'} (change in the dashboard)`);
  if (eff.source !== 'env') {
    console.log(`                (PAPER_MODE=${CONFIG.runtime.paperMode} was overridden by the saved ${eff.source})`);
  }
  // Which .env was read, and the sizing the bot will actually use. A wrong
  // number here is the first thing to check when the stake looks wrong.
  console.log(`     env:       ${envFile.loaded ? envFile.path : `NOT FOUND (${envFile.path}) — built-in defaults in use`}`);
  console.log(`     sizing:    stake $${bot.tradeAmountUsd} (${bot.sizingSourceLabel('tradeAmountUsd')})`
      + ` · cap $${bot.maxTradeAmountUsd} (${bot.sizingSourceLabel('maxTradeAmountUsd')})`
      + ` · min order ${CONFIG.order.minOrderPolicy} · Kelly ${bot.kellySizing ? 'on' : 'off'} (${bot.sizingSourceLabel('kellySizing')})`);
  for (const note of bot.sizingIgnored) console.log(`                ⚠ ${note}`);
  if (configErrors.length) {
    console.log('     ⚠ config errors:');
    for (const e of configErrors) console.log(`       - ${e}`);
  }
  console.log('');
});

process.on('SIGINT', () => { bot.stop('shutdown'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { bot.stop('shutdown'); server.close(() => process.exit(0)); });

module.exports = { app, server, bot, auth, CONFIG };
