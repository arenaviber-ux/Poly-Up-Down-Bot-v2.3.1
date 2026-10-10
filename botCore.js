'use strict';
/**
 * Bot core — orchestration, execution lifecycle and risk.
 *
 * Live mode performs the full, real order path:
 *   geoblock → credentials → balance/allowance → sizing (min shares + tick)
 *   → EIP-712 sign → POST /order → fill reconciliation (user WS) → cancel any
 *   remainder → settle from `market_resolved`.
 *
 * Paper mode simulates against the *real* book (walking the ask ladder), pays
 * the real published taker fee, and settles from the real resolution event. It
 * never invents an outcome: if a market resolves while the bot is offline the
 * position is left UNRESOLVED rather than guessed.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { MarketDiscovery } = require('./marketDiscovery');
const { ClobClient, estimateBuyFill, estimateSellFill, SIGNED_ORDER_VERSION } = require('./clobClient');
const { MarketStream } = require('./wsMarket');
const { UserStream } = require('./wsUser');
const { ReferencePrice } = require('./referencePrice');
const { StrategyEngine } = require('./strategyEngine');
const { signOrder, sizeOrder, computeBuyAmounts, computeMarketBuyAmounts, MARKET_ORDER_TYPES, roundPriceToTick, tickRules } = require('./orderSigner');
const { fairProbUp, feeTotal, feePerShare, kellyStake, entryEdgeTest } = require('./pricing');
const { Redeemer } = require('./redeemer');
const exitLogic = require('./exitManager');

/**
 * Settings keys accepted by `updateSettings()`, with the aliases the dashboard
 * may send.
 *
 * This exists because the stop-loss was silently dead for a long time: the UI
 * posts `stopLossThresholdUsd` while the server only ever read `stopLossUsd`, so
 * the value was dropped without a word. Every unrecognised key is now reported
 * back to the client in `settingsChanges.unapplied` instead of vanishing.
 */
const SETTING_ALIASES = {
  tradeAmountUsd: ['tradeAmountUsd', 'stakeUsd', 'tradeAmount'],
  maxTradeAmountUsd: ['maxTradeAmountUsd', 'maxStakeUsd', 'maxTrade', 'maxTradeCap'],
  stopLossUsd: ['stopLossUsd', 'stopLossThresholdUsd', 'stopLoss'],
  // Second stop-*family* breaker, and a different one: `stopLossUsd` watches
  // cumulative net P&L since the account was reset, `maxDailyLossUsd` watches
  // *gross* realised losses inside the current UTC day. Before this key
  // existed the daily cap was reachable only through the MAX_DAILY_LOSS_USD
  // env var, so the dashboard's "Risk Circuit Breaker" box (which posts
  // stopLossUsd) silently controlled the cumulative limit instead — and the
  // daily cap stopped the bot anyway, reporting a number the user never set.
  maxDailyLossUsd: ['maxDailyLossUsd', 'dailyLossLimitUsd', 'maxDailyLoss', 'dailyLossLimit'],
  kellySizing: ['kellySizing', 'kelly'],
  paperMode: ['paperMode', 'paper'],
  selectedTimeframe: ['selectedTimeframe', 'timeframe'],
  selectedMarketSlug: ['selectedMarketSlug', 'marketSlug', 'marketFilter'],
  strategies: ['strategies'],
  // Exit / redemption toggles. Accepted from the dashboard under either
  // spelling so a renamed control cannot silently no-op again.
  exitEnabled: ['exitEnabled', 'autoSell', 'autoExit', 'preExpiryExit'],
  autoRedeem: ['autoRedeem', 'redeemEnabled', 'autoRedeemEnabled'],
};

const SETTING_INDEX = (() => {
  const idx = new Map();
  for (const [canonical, aliases] of Object.entries(SETTING_ALIASES)) {
    idx.set(canonical.toLowerCase(), canonical);
    for (const a of aliases) idx.set(String(a).toLowerCase(), canonical);
  }
  return idx;
})();

function resolveSettingKey(key) {
  return SETTING_INDEX.get(String(key === undefined || key === null ? '' : key).toLowerCase()) || null;
}

class BotCore extends EventEmitter {
  constructor({ config, auth, log = () => {} }) {
    super();
    this.cfg = config;
    this.auth = auth;
    this.log = log;

    this.discovery = new MarketDiscovery(config, { log });
    this.clob = new ClobClient(config, auth);
    this.ref = new ReferencePrice(config, auth, { log });
    this.marketStream = new MarketStream(config, { log });
    this.userStream = new UserStream(config, auth, { log });
    this.strategies = new StrategyEngine(config, { log });
    // Sweeper that converts resolved winning tokens back into collateral.
    // Constructed unconditionally so paper mode and the dashboard can report
    // its readiness; it no-ops unless AUTO_REDEEM is on and it is usable.
    this.redeemer = new Redeemer(config, auth, { log });

    // ------------------------------------------------------------- settings
    this.isRunning = false;
    this.paperMode = config.runtime.paperMode;
    // The sweeper mirrors this so its readiness() can explain itself accurately:
    // in paper mode there is genuinely nothing to redeem, which is not the same
    // statement as "AUTO_REDEEM is off".
    this.redeemer.setPaperMode(this.paperMode);
    this.tradeAmountUsd = config.order.stakeUsd;
    this.maxTradeAmountUsd = config.order.maxStakeUsd;
    this.kellySizing = config.order.kellySizing;
    // Where each sizing value came from ('env' | 'state' | 'default'), and saved
    // values that .env overrode. Both are reported at start-up (see applySavedSizing).
    const setInEnv = config.order.setInEnv || {};
    this.sizingSource = {
      tradeAmountUsd: setInEnv.tradeAmountUsd ? 'env' : 'default',
      maxTradeAmountUsd: setInEnv.maxTradeAmountUsd ? 'env' : 'default',
      kellySizing: setInEnv.kellySizing ? 'env' : 'default',
    };
    this.sizingIgnored = [];
    this.stopLossUsd = config.risk.stopLossUsd;
    // The per-UTC-day loss cap. Instance state (not read straight off `cfg`)
    // so the dashboard can change it at runtime and so it survives a restart
    // via bot_state.json, exactly like the stop-loss above.
    this.maxDailyLossUsd = config.risk.maxDailyLossUsd;
    this.takeProfitUsd = config.risk.takeProfitUsd;
    this.cooldownSeconds = config.risk.cooldownSeconds;
    // Dashboard-selected timeframe + market target (both are now actually
    // honoured; previously the UI sent them and nothing read them).
    this.selectedTimeframe = (config.market.timeframes || []).includes('all')
      ? 'all'
      : (config.market.timeframes || ['5m'])[0];
    this.marketFilterSlug = 'auto';

    // Runtime toggles for the two capital-recycling mechanisms. Instance state
    // (not read straight off `cfg`) so the dashboard can flip them live and so
    // they survive a restart, exactly like the stop-loss.
    this.exitEnabled = config.exit.enabled;
    this.autoRedeem = config.redeem.enabled;

    // --------------------------------------------------------------- state
    this.markets = [];
    this.activePositions = [];
    this.tradeHistory = [];
    this.orders = new Map();      // orderId -> {…}  open/known orders
    this.logs = [];
    this.signals = [];
    this.startingBalance = 1000;
    this.paperBalance = 1000;
    this.realizedPnl = 0;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.tradesThisWindow = new Map(); // slug -> count
    this.lastTradeAt = 0;
    this.lastSkipReason = null;
    this.stoppedReason = null;
    this.dailyLoss = 0;
    this.dailyKey = new Date().toISOString().slice(0, 10);
    this.geoblock = null;
    this.allowanceWarning = false;
    // Last on-chain verification of the required exchange approvals
    // (relayerClient.readTradingApprovals). `missing` is what gates a live entry.
    this.approvalState = null;
    this.lastApprovalError = null;
    // Which order version the CLOB is accepting right now (`GET /version`). The
    // exchange contract an order is signed against depends on it, so a mismatch
    // is a hard stop rather than a skipped trade.
    this.orderVersion = null;
    this.orderVersionOk = null;

    // Exit accounting: how much capital the pre-expiry sell has recycled, and
    // how often it fired versus stood down. Reported on the dashboard so a
    // silent no-op is visible rather than inferred from a stalling balance.
    this.exitStats = {
      attempted: 0, filled: 0, partial: 0, failed: 0,
      sharesSold: 0, proceedsUsd: 0, feesUsd: 0, recycledUsd: 0,
      lastReason: null, lastExitAt: null,
    };

    this.loopTimer = null;
    this.discoveryTimer = null;
    this.redeemTimer = null;
    this.loopBusy = false;
    this.discoveryBusy = false;
    this.redeemBusy = false;

    // Relative paths resolve against the project dir; an absolute STATE_FILE
    // must be honoured as-is (path.join() would graft it onto __dirname and
    // silently write the state somewhere the user never asked for).
    this.stateFile = path.isAbsolute(config.runtime.stateFile)
      ? config.runtime.stateFile
      : path.join(__dirname, config.runtime.stateFile);
    this.loadState();
    this.wireEvents();
    this.auth.setPaperMode(this.paperMode);
  }

  // ------------------------------------------------------------------ log
  logLine(level, message, details = null) {
    const entry = { timestamp: new Date().toISOString(), timeStr: new Date().toLocaleTimeString(), level, message, details };
    this.logs.unshift(entry);
    if (this.logs.length > 400) this.logs.pop();
    this.log(level, message, details);
    return entry;
  }

  // -------------------------------------------------------------- lifecycle
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stoppedReason = null;
    this.ref.start();
    this.marketStream.connect();
    if (!this.paperMode) this.userStream.connect();
    this.logLine('INFO', `Bot started in ${this.paperMode ? 'PAPER' : 'LIVE'} mode (${this.cfg.market.asset.toUpperCase()} ${this.cfg.market.timeframes.join('/')})`);
    this.discoveryTimer = setInterval(() => this.refreshMarkets().catch(e => this.logLine('ERROR', `discovery: ${e.message}`)), this.cfg.runtime.discoveryMs);
    this.loopTimer = setInterval(() => this.tick().catch(e => this.logLine('ERROR', `loop: ${e.message}`)), this.cfg.runtime.loopMs);
    // Redemption runs on its own timer rather than inside `tick()`: a sweep can
    // take seconds (relayer submit + poll) and must never delay an entry or an
    // exit decision in the 750ms trading loop.
    if (!this.paperMode && this.autoRedeem) this.startRedeemTimer();
    this.refreshMarkets().catch(() => {});
    if (!this.paperMode) this.runLivePreflight().catch(e => this.logLine('ERROR', `preflight: ${e.message}`));

    if (this.exitEnabled) {
      this.logLine('INFO', `Pre-expiry exit armed: sell from ${this.cfg.exit.maxSecondsToExpiry}s to `
        + `${this.cfg.exit.minSecondsToExpiry}s before close when the model is >= `
        + `${(this.cfg.exit.minModelProb * 100).toFixed(0)}% and the bid is `
        + `${(this.cfg.exit.minSellPrice * 100).toFixed(0)}-${(this.cfg.exit.maxSellPrice * 100).toFixed(1)}c`);
    }
  }

  /** Start (or restart) the periodic redemption sweep. */
  startRedeemTimer() {
    this.stopRedeemTimer();
    const every = Math.max(5000, Number(this.cfg.redeem.everyMs || 300000));
    this.redeemTimer = setInterval(() => { this.runRedeemSweep().catch(e => this.logLine('ERROR', `redeem: ${e.message}`)); }, every);
    // Sweep once shortly after start: a restart mid-session usually means there
    // are already-resolved wins sitting unclaimed.
    setTimeout(() => { this.runRedeemSweep().catch(() => {}); }, 15000);
  }

  stopRedeemTimer() {
    if (this.redeemTimer) { clearInterval(this.redeemTimer); this.redeemTimer = null; }
  }

  /** Guarded sweep — never throws into the caller, always reports why it no-oped. */
  async runRedeemSweep({ force = false, manual = false } = {}) {
    if (this.paperMode && !this.redeemer.readiness().ready) {
      // Paper wins are credited to `paperBalance` at settlement and there is
      // nothing on-chain to claim, so a paper bot with no relayer credentials
      // simulates the sweep rather than reporting a hard failure. A paper bot
      // that *is* configured (e.g. testing the redemption path against a real
      // account) falls through to the real sweeper.
      // Simulate so the dashboard is not blank.
      const queued = this.redeemer.pending.size;
      const summary = {
        ok: true, ran: true, paper: true, found: queued, redeemed: queued, failed: 0, skipped: 0,
        recoveredUsdEstimate: 0, results: [],
        reason: queued
          ? `[paper] ${queued} queued win(s) already credited to the paper balance at settlement`
          : '[paper] nothing to redeem — paper wins are credited at settlement',
      };
      for (const cid of [...this.redeemer.pending]) this.redeemer.pending.delete(cid);
      this.redeemer.stats.runs++;
      this.redeemer.stats.lastRunAt = new Date().toISOString();
      this.redeemer.stats.lastResult = summary;
      if (manual) this.logLine('INFO', summary.reason);
      return summary;
    }
    if (this.redeemBusy) return { ok: false, ran: false, reason: 'a sweep is already running' };
    this.redeemBusy = true;
    try {
      // `enabled` tracks the AUTO_REDEEM toggle only. It used to be
      // `autoRedeem && !paperMode`, which meant switching to paper made the
      // sweeper report "AUTO_REDEEM=false" while the setting still said true —
      // and it contradicted runRedeemSweep(), whose paper branch deliberately
      // simulates the sweep. Paper handling lives in the sweep, not the flag.
      this.redeemer.enabled = this.autoRedeem;
      this.redeemer.setPaperMode(this.paperMode);
      const res = await this.redeemer.sweep({ force });
      if (res && res.failed > 0) {
        // The sweeper logs each failure itself, but at bot level a failed
        // redemption means capital is still locked, so it must be an ERROR in
        // the dashboard log rather than something you have to go looking for.
        const detail = (res.results || []).filter(r => !r.ok && !r.skipped)
          .map(r => `${String(r.title || r.conditionId).slice(0, 24)}: ${r.error}`).join('; ');
        this.logLine('ERROR', `[redeem] ${res.failed} redemption(s) failed — that capital is still locked as tokens `
          + `and does not count toward your tradeable balance${detail ? ` (${detail})` : ''}`);
      }
      if (res && res.redeemed > 0) {
        // The recovered pUSD is now spendable; make sure the next sizing read
        // is not served from the pre-redemption cache.
        await this.auth.syncBalanceAllowance({ force: true }).catch(() => {});
      }
      return res;
    } finally {
      this.redeemBusy = false;
    }
  }

  stop(reason = 'User requested stop') {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.stoppedReason = reason;
    clearInterval(this.loopTimer); this.loopTimer = null;
    clearInterval(this.discoveryTimer); this.discoveryTimer = null;
    this.stopRedeemTimer();
    this.marketStream.disconnect();
    this.userStream.disconnect();
    this.ref.stop();
    this.logLine('WARN', `Bot stopped: ${reason}`);
  }

  /** Live-mode prerequisites: geoblock, credentials, balance, allowance, clock. */
  async runLivePreflight() {
    const geo = await this.auth.checkGeoblock();
    this.geoblock = geo;
    if (geo.blocked) {
      this.logLine('ERROR', `Geoblock: trading is not permitted from this location (${geo.country || '?'}${geo.region ? '/' + geo.region : ''}). Live orders are rejected by Polymarket.`);
      if (this.cfg.runtime.requireGeoblockPass) {
        this.stop(`Geoblocked region (${geo.country || 'unknown'}) — live trading disabled`);
        return { ok: false, reason: 'geoblocked' };
      }
    }
    const wallet = this.auth.validateWalletSetup();
    if (!wallet.ok) {
      this.logLine('ERROR', `Wallet config: ${wallet.error}`);
      return { ok: false, reason: wallet.error };
    }
    if (!this.auth.hasL2Credentials()) {
      try {
        await this.auth.deriveApiCredentials();
        this.logLine('SUCCESS', `CLOB credentials ${this.auth.credentialsSource} for signer ${this.auth.signerAddress.slice(0, 8)}…`);
      } catch (e) {
        this.logLine('ERROR', `Credential derivation failed: ${e.message}`);
        return { ok: false, reason: e.message };
      }
    }
    const bal = await this.auth.checkBalanceAllowance().catch(() => null);
    if (bal && bal.ok) {
      this.logLine('INFO', `CLOB collateral balance $${bal.balance.toFixed(2)}, allowance $${bal.allowance.toFixed(2)}`);
      if (bal.balance <= 0) {
        this.logLine('WARN', 'The CLOB reports $0.00 of collateral for this account wallet — pUSD must sit in the '
          + 'account wallet (POLY_FUNDER_ADDRESS), not on the signer EOA.');
      }
    } else if (bal && !bal.ok) {
      this.logLine('WARN', `Balance/allowance lookup failed: ${bal.error || bal.status}`);
    }

    // The CLOB's allowance number is a cache; the token contracts are the truth.
    // This is also where the missing approvals get fixed, if they can be.
    await this.ensureTradingApprovals();

    // Which exchange version the server wants. Signing for the wrong one is
    // rejected outright, so find out now rather than on the first live order.
    await this.checkOrderVersion();

    // The user stream needs credentials; connect it once they exist.
    if (this.isRunning && !this.userStream.ws) this.userStream.connect();

    // Reconcile any positions restored from disk against live CLOB order state
    // (fills may have completed, or the order may have been cancelled, while
    // the process was down).
    for (const pos of this.activePositions) {
      for (const orderId of pos.orderIds || []) {
        if (orderId === 'dry-run') continue;
        await this.reconcileOrder(pos, orderId).catch(() => {});
      }
      if (pos.filledShares > 0 && pos.status !== 'FILLED') pos.status = 'FILLED';
      // Positions saved before fills were counted once still carry the old
      // counters; a restored fill must not be counted a second time.
      if (pos.filledShares > 0 && pos.fillCounted === undefined) pos.fillCounted = true;
    }
    return { ok: true };
  }

  /**
   * Read the order version the CLOB is currently accepting.
   *
   * This bot signs every order for the CLOB V2 CTF exchanges (version 2). The
   * server can move a book to another exchange version — 1 is the legacy CTF
   * exchange, 3 is ExchangeV3 with Protocol-V2 position IDs — and an order
   * signed for the wrong contract is rejected with `order_version_mismatch`.
   * Polymarket's own client checks this before building an order and re-checks
   * it after that rejection, so the bot does the same at pre-flight.
   *
   * @param {boolean} [force] re-read even when a value is already cached
   * @returns {Promise<{ok:boolean, version:number|null, error?:string}>}
   */
  async checkOrderVersion(force = false) {
    const r = await this.clob.getOrderVersion(force).catch(e => ({ ok: false, version: null, error: e.message }));
    if (!r.ok) {
      // Unreachable endpoint: say so, but do not stop the bot on a guess.
      this.orderVersion = null;
      this.orderVersionOk = null;
      if (this.lastOrderVersionError !== r.error) {
        this.lastOrderVersionError = r.error;
        this.logLine('WARN', `Could not read the CLOB order version (${r.error}) — assuming ${SIGNED_ORDER_VERSION}`);
      }
      return { ok: false, version: null, error: r.error };
    }
    this.orderVersion = r.version;
    this.lastOrderVersionError = null;
    this.orderVersionOk = r.version === SIGNED_ORDER_VERSION;
    if (this.orderVersionOk) {
      if (this._orderVersionReported !== r.version) {
        this._orderVersionReported = r.version;
        this.logLine('INFO', `CLOB order version ${r.version} — matches the exchanges this bot signs for`);
      }
    } else if (this._orderVersionReported !== `bad-${r.version}`) {
      this._orderVersionReported = `bad-${r.version}`;
      this.logLine('ERROR', `The CLOB is accepting order version ${r.version}, but this bot signs orders for version `
        + `${SIGNED_ORDER_VERSION} (the CLOB V2 CTF exchanges). Live orders will be rejected — Polymarket has moved `
        + 'the book to a different exchange contract.');
    }
    return { ok: this.orderVersionOk, version: r.version };
  }

  /**
   * Verify — and, when allowed, repair — the four on-chain approvals the CLOB
   * needs before an order can settle.
   *
   * Without them POST /order fails with
   * `not enough balance / allowance: the balance is not enough -> balance: 0`,
   * which reads like a funding problem and is not one. Approving from the
   * signer EOA does not help either: the allowance has to come from the account
   * wallet, which on Polymarket means a gasless relayer batch.
   *
   * @param {object} [o]
   * @param {boolean} [o.force] re-approve even when everything is already granted
   * @returns {Promise<{ok:boolean, missing:Array, error?:string}>}
   */
  async ensureTradingApprovals({ force = false } = {}) {
    const relayer = this.redeemer && this.redeemer.relayer;
    if (!relayer) return { ok: true, missing: [] };

    const state = await relayer.readTradingApprovals().catch(e => ({ ok: false, checks: [], missing: [], error: e.message }));
    this.approvalState = state;

    if (!state.ok) {
      // Cannot read chain (RPC). Say so once; do not block trading on a guess.
      if (this.lastApprovalError !== state.error) {
        this.lastApprovalError = state.error;
        this.logLine('WARN', `Could not verify exchange approvals on-chain: ${state.error}`);
      }
      return { ok: false, missing: [], error: state.error };
    }

    if (!state.missing.length && !force) {
      this.allowanceWarning = false;
      this.lastApprovalError = null;
      if (this._approvalsReported !== 'granted') {
        this._approvalsReported = 'granted';
        this.logLine('SUCCESS', 'Exchange approvals verified on-chain (pUSD + conditional tokens, both V2 exchanges and both collateral adapters)');
      }
      return { ok: true, missing: [] };
    }

    const missing = state.missing.map(m => m.label);
    this.allowanceWarning = true;

    if (!relayer.isConfigured()) {
      this.logLine('ERROR', `Missing exchange approvals (${missing.join('; ')}). Set RELAYER_API_KEY + `
        + 'RELAYER_API_KEY_ADDRESS (polymarket.com → Settings → API Keys → Relayer API Keys) and run `npm run approve`.');
      return { ok: false, missing, error: 'relayer not configured' };
    }
    if (!this.cfg.approvals.autoApprove && !force) {
      this.logLine('ERROR', `Missing exchange approvals (${missing.join('; ')}). Run \`npm run approve\` to grant them `
        + '(or set AUTO_APPROVE=true to let the bot do it at start-up).');
      return { ok: false, missing, error: 'auto-approve disabled' };
    }

    this.logLine('INFO', `Granting missing exchange approvals from the account wallet: ${missing.join('; ')}`);
    const res = await relayer.setupTradingApprovals({ force: false }).catch(e => ({ ok: false, error: e.message }));
    if (res.ok) {
      this.allowanceWarning = false;
      this.lastApprovalError = null;
      this._approvalsReported = 'granted';
      this.logLine('SUCCESS', `Exchange approvals granted${res.transactionHash ? ` (tx ${String(res.transactionHash).slice(0, 18)}…)` : ''}`
        + ' — the CLOB balance cache was refreshed');
      // The CLOB caches balance/allowance; make the next read agree with chain.
      await this.auth.syncBalanceAllowance({ force: true }).catch(() => null);
      return { ok: true, missing: [] };
    }
    this.logLine('ERROR', `Could not grant the exchange approvals: ${res.error || res.state || 'unknown error'} — `
      + 'run `npm run approve` for the full report');
    return { ok: false, missing, error: res.error || 'setup failed' };
  }

  wireEvents() {
    this.marketStream.on('market_resolved', (payload) => this.onMarketResolved(payload));
    this.marketStream.on('tick_size_change', ({ tokenId, newTickSize }) => {
      this.logLine('INFO', `Tick size for ${String(tokenId).slice(0, 12)}… changed to ${newTickSize}`);
    });
    this.marketStream.on('error', () => {});
    this.userStream.on('trade', (trade) => this.onUserTrade(trade));
    this.userStream.on('order', (order) => this.onUserOrder(order));
    this.userStream.on('error', () => {});
    this.ref.on('window_open', (w) => {
      this.logLine('INFO', `Window ${w.epoch} opened — price to beat ${w.twap !== null ? w.twap.toFixed(2) : 'unavailable'} (${w.source || 'n/a'})`);
    });
  }

  // -------------------------------------------------------------- discovery
  async refreshMarkets() {
    if (this.discoveryBusy) return;
    this.discoveryBusy = true;
    try {
      // Self-heal the settlement feed: if CLOB credentials appeared after
      // startup, PolyBolt was never attempted. Picks up the Chainlink TWAP
      // within one discovery cycle instead of needing a restart.
      this.ref.ensurePolybolt();
      const markets = await this.discovery.getMarkets();
      this.markets = markets;
      // Observe the price-to-beat for every visible window.
      for (const m of markets) this.ref.observeWindow(m.epoch, m.windowSeconds);

      // Keep the market socket subscribed to the windows we could trade, and
      // the user socket subscribed to their condition ids.
      const tokenIds = [];
      const conditionIds = [];
      for (const m of markets) {
        if (!m.tokenMappingOk) continue;
        if (m.started && m.remainingSec > 0) {
          tokenIds.push(m.upTokenId, m.downTokenId);
          conditionIds.push(m.conditionId);
        }
      }
      // Also stay subscribed to markets we still hold positions in: the
      // `market_resolved` event arrives after the window closes, and dropping
      // the subscription at expiry would mean missing the settlement.
      for (const pos of this.activePositions) {
        if (pos.status === 'SETTLED') continue;
        if (pos.tokenId) tokenIds.push(pos.tokenId);
        const holding = markets.find(m => m.conditionId === pos.conditionId);
        if (holding) {
          if (holding.upTokenId) tokenIds.push(holding.upTokenId);
          if (holding.downTokenId) tokenIds.push(holding.downTokenId);
        }
        if (pos.conditionId) conditionIds.push(pos.conditionId);
      }
      this.marketStream.setAssets([...new Set(tokenIds)]);
      if (!this.paperMode) this.userStream.setMarkets([...new Set(conditionIds)]);
    } finally {
      this.discoveryBusy = false;
    }
  }

  // ------------------------------------------------------------- main loop
  async tick() {
    if (!this.isRunning || this.loopBusy) return;
    this.loopBusy = true;
    try {
      this.rollDailyCounters();

      // Exits run FIRST — before the risk breakers, before market filtering and
      // before any entry logic. Three reasons, each of which is a real way to
      // strand money:
      //   1. a tripped breaker must not strand a position that can still be
      //      sold for cash;
      //   2. the early `return`s below (no tradeable window, no book, no price
      //      to beat) fire constantly and would otherwise skip exits entirely;
      //   3. the sale is what returns collateral to the balance the entry path
      //      reads a few lines later.
      // It uses each position's own `expiresAtEpoch`, so it does not depend on
      // the discovery refresh that happens further down.
      await this.manageExits();

      if (!this.checkRiskLimits()) return;

      // Discovery refreshes every DISCOVERY_MS (10s by default), so a market's
      // `remainingSec` can be up to ~10s stale by the time it is acted on —
      // enough to misjudge the final-seconds modules and the
      // MIN_SECONDS_TO_EXPIRY gate. Recompute from the local clock each tick.
      const nowSec = Math.floor(Date.now() / 1000);
      for (const m of this.markets) {
        if (Number.isFinite(m.endsAtEpoch)) m.remainingSec = Math.max(0, m.endsAtEpoch - nowSec);
      }

      const filtered = this.markets
        .filter(m => m.tradeable && m.remainingSec > this.cfg.risk.minSecondsToExpiry);
      // 'auto' = the window closest to expiry; an explicit slug pins the bot to
      // one market. Say so when the pin matches nothing, rather than silently
      // doing nothing.
      const pinned = this.marketFilterSlug && this.marketFilterSlug !== 'auto'
        ? filtered.filter(m => m.slug === this.marketFilterSlug)
        : filtered;
      if (this.marketFilterSlug && this.marketFilterSlug !== 'auto' && !pinned.length) {
        this.lastSkipReason = `market target "${this.marketFilterSlug}" has no tradeable window right now`;
        return;
      }
      const candidates = pinned.sort((a, b) => a.remainingSec - b.remainingSec);

      if (!candidates.length) return;
      // Trade the window closest to expiry that we have live data for.
      let target = null;
      for (const m of candidates) {
        if (this.marketStream.getBook(m.upTokenId) || this.marketStream.getBook(m.downTokenId)) { target = m; break; }
      }
      if (!target) target = candidates[0];

      await this.settleExpiredPositions();
      if (!this.canOpenNewPosition(target)) return;

      const ctx = await this.buildContext(target);
      if (!ctx) return;

      // Every module needs the window's price to beat; without it there is no
      // fair-value model at all. This happens when the bot starts (or restarts)
      // more than WINDOW_OPEN_GRACE_SECONDS into a window. Say so once, in
      // plain words, instead of letting eight modules each report
      // "no fair-value model".
      if (!ctx.windowOpenStatus.ok) {
        const msg = `No trades in ${target.slug}: ${ctx.windowOpenStatus.reason}. Waiting for the next window.`;
        if (this.lastSkipReason !== msg) this.logLine('INFO', msg);
        this.lastSkipReason = msg;
        return;
      }

      const decision = this.strategies.evaluate(ctx);
      this.recordSignals(target, decision);
      if (!decision.signal) { this.lastSkipReason = (decision.evaluations || []).map(e => `${e.key}: ${e.reason}`); return; }

      await this.executeSignal(ctx, decision);
    } finally {
      this.loopBusy = false;
    }
  }

  /**
   * A book for order decisions: the streamed snapshot while it is recent,
   * otherwise a REST snapshot.
   *
   * The streamed book is only replaced when an event arrives, so a quiet or
   * one-sided market can leave an old snapshot in memory — and every price,
   * spread and edge decision downstream inherits its age. Books with no
   * timestamp (test doubles, hand-built objects) are taken at face value.
   */
  async bookForDecision(tokenId) {
    if (!tokenId) return null;
    const streamed = this.marketStream.getBook(tokenId);
    if (streamed) {
      const ageMs = streamed.receivedAt ? Date.now() - streamed.receivedAt : 0;
      if (ageMs <= this.cfg.runtime.maxBookAgeMs) return streamed;
      const rest = await this.clob.getBook(tokenId).catch(() => null);
      if (rest) return rest;
      this.logLine('INFO', `Book for ${String(tokenId).slice(0, 10)}… is ${(ageMs / 1000).toFixed(1)}s old and REST is unavailable — using it anyway`);
      return streamed;
    }
    return this.clob.getBook(tokenId).catch(() => null);
  }

  /** Assemble everything a strategy or the order path needs. */
  async buildContext(market) {
    // Time-to-expiry is recomputed from the local clock because `market` may
    // come from a discovery pass up to DISCOVERY_MS old (or from a caller that
    // holds a stale copy, e.g. POST /api/trade).
    if (market && Number.isFinite(market.endsAtEpoch)) {
      market = { ...market, remainingSec: Math.max(0, market.endsAtEpoch - Math.floor(Date.now() / 1000)) };
    }
    const upBook = await this.bookForDecision(market.upTokenId);
    const downBook = await this.bookForDecision(market.downTokenId);
    if (!upBook && !downBook) return null;

    // Book values are authoritative for the trading constraints.
    const tickSize = (upBook && upBook.tickSize) || market.tickSize || this.cfg.order.tickSize;
    const minOrderSize = (upBook && upBook.minOrderSize) || market.minOrderSize || this.cfg.order.minShares;
    const negRisk = (upBook && upBook.negRisk !== null) ? upBook.negRisk : market.negRisk;

    const twap = this.ref.getTwap();
    const spot = this.ref.getSpot();
    const windowOpen = this.ref.getWindowOpen(market.epoch);
    const windowOpenStatus = (windowOpen && windowOpen.twap !== null && windowOpen.twap !== undefined)
      ? {
          ok: true,
          source: windowOpen.source,
          backfilled: !!windowOpen.backfilled,
          lateSnapshotSeconds: windowOpen.lateSnapshotSeconds,
        }
      : {
          ok: false,
          reason: (windowOpen && windowOpen.reason)
            || `no price to beat recorded for window ${market.epoch} yet`,
        };
    const authoritative = twap.authoritative && !!(windowOpen && windowOpen.twap !== null);

    const model = fairProbUp({
      twapOpen: windowOpen ? windowOpen.twap : null,
      twapNow: twap.value,
      priceNow: spot.value,
      secondsLeft: market.remainingSec,
      sigmaPerSec: this.ref.getVolatilityPerSec(),
      twapWindow: this.cfg.reference.twapWindowSeconds,
      minSigmaPerSec: this.cfg.reference.minVolPerSec,
    });

    return {
      market,
      books: { up: upBook, down: downBook },
      ref: { ...this.ref.health(), tracker: this.ref.tracker, spots: this.ref.spots, spotTs: this.ref.spotTs },
      twap,
      spot,
      windowOpen,
      windowOpenStatus,
      model,
      degraded: !authoritative,
      feeSchedule: market.feeSchedule || { rate: this.cfg.fees.defaultTakerRate, exponent: 1, takerOnly: true },
      constraints: { tickSize, minOrderSize, negRisk },
      mode: this.paperMode ? 'paper' : 'live',
    };
  }

  recordSignals(market, decision) {
    const entry = {
      at: new Date().toISOString(),
      slug: market.slug,
      remainingSec: market.remainingSec,
      evaluations: (decision.evaluations || []).map(e => ({ key: e.key, name: e.name, reason: e.reason, fired: !!e.signal })),
      fired: decision.signal || null,
    };
    this.signals.unshift(entry);
    if (this.signals.length > 60) this.signals.pop();
  }

  // -------------------------------------------------------------- guards
  canOpenNewPosition(market) {
    // Settled, fully-exited, cancelled and rejected positions are not open
    // exposure. Counting a fully-sold position against MAX_OPEN_POSITIONS would
    // block the next window even though its capital has already been recycled —
    // which defeats the point of selling early.
    const open = this.exitablePositions();
    if (open.length >= this.cfg.risk.maxOpenPositions) { this.lastSkipReason = `max ${this.cfg.risk.maxOpenPositions} open position(s)`; return false; }
    if (open.find(p => p.marketSlug === market.slug)) { this.lastSkipReason = 'already positioned in this window'; return false; }
    // Note: an EXITED position in this window does not trigger the check above,
    // so re-entry after a full exit is possible in the same window if
    // MAX_TRADES_PER_WINDOW allows it.
    const perWindow = this.tradesThisWindow.get(market.slug) || 0;
    if (perWindow >= this.cfg.risk.maxTradesPerWindow) { this.lastSkipReason = `max ${this.cfg.risk.maxTradesPerWindow} trade(s) per window`; return false; }
    if (Date.now() - this.lastTradeAt < this.cooldownSeconds * 1000) { this.lastSkipReason = `cooldown ${this.cooldownSeconds}s`; return false; }
    return true;
  }

  /**
   * The two loss breakers are deliberately independent:
   *
   *   stopLossUsd      vs realizedPnl  — cumulative NET P&L since the account
   *                                      was reset. Never resets daily.
   *   maxDailyLossUsd  vs dailyLoss    — GROSS realised losses inside the
   *                                      current UTC day (winners do not
   *                                      offset losers). Resets at 00:00 UTC.
   *
   * Both messages name the limit that tripped, because "stop: -$59.67" is
   * meaningless when the configured limit was $50 — the counter overshoots by
   * one settled trade (losses are booked per position, and this runs once per
   * loop tick), so the reported figure is the overshoot, not the threshold.
   */
  checkRiskLimits() {
    if (this.realizedPnl <= -Math.abs(this.stopLossUsd)) {
      this.stop(
        `Stop-loss hit: cumulative realised P&L $${this.realizedPnl.toFixed(2)} `
        + `(limit -$${Math.abs(this.stopLossUsd).toFixed(2)})`,
      );
      return false;
    }
    if (this.takeProfitUsd > 0 && this.realizedPnl >= Math.abs(this.takeProfitUsd)) {
      this.stop(`Take-profit hit: realised P&L $${this.realizedPnl.toFixed(2)}`);
      return false;
    }
    if (this.dailyLoss >= this.maxDailyLossUsd) {
      this.stop(
        `Daily loss limit hit: -$${this.dailyLoss.toFixed(2)} of -$${this.maxDailyLossUsd.toFixed(2)} `
        + `allowed today (gross realised losses, UTC day)`,
      );
      return false;
    }
    return true;
  }

  rollDailyCounters() {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dailyKey) {
      this.dailyKey = key;
      this.dailyLoss = 0;
      this.tradesThisWindow = new Map();
    }
  }

  // ------------------------------------------------------------ execution
  /**
   * Take a signal through the full order path.
   */
  async executeSignal(ctx, decision) {
    const { market, constraints, feeSchedule } = ctx;
    const side = decision.side;
    const book = side === 'UP' ? ctx.books.up : ctx.books.down;
    const tokenId = side === 'UP' ? market.upTokenId : market.downTokenId;
    // Name the module that produced the signal in every drop path, and record
    // the reason on the bot state: a signal that fires in the engine but is
    // dropped here must not look like a fill on the dashboard.
    const tag = decision.strategyName || decision.strategy || 'signal';
    if (!book || book.bestAsk === null || book.bestAsk === undefined) {
      this.lastSkipReason = `${tag} fired but did not trade: no ask liquidity on ${side}`;
      this.logLine('WARN', this.lastSkipReason);
      return null;
    }
    if (!market.tokenMappingOk) {
      this.lastSkipReason = `${tag} fired but did not trade: market outcome mapping is invalid`;
      this.logLine('ERROR', this.lastSkipReason);
      return null;
    }
    // A Protocol-V2 market trades position IDs on ExchangeV3. The asset ID this
    // bot signs is a CTF token ID, so the order would be rejected — or, worse,
    // sit in the wrong book. Stand down and say which market it was.
    if (market.protocolV2) {
      this.lastSkipReason = `${tag} fired but did not trade: ${market.slug} is a Protocol-V2 market `
        + '(ExchangeV3 position IDs), which this bot does not sign orders for';
      this.logLine('ERROR', this.lastSkipReason);
      return null;
    }

    // ---- pricing: marketable limit at ask + slippage allowance
    const limitPrice = roundPriceToTick(
      Math.min(this.cfg.order.maxBuyPrice, book.bestAsk + this.cfg.order.maxSlippageCents / 100),
      constraints.tickSize,
    );

    // ---- sizing with the minimum share rule and the available balance
    let available = Infinity;
    if (this.paperMode) {
      available = this.paperBalance;
    } else {
      const bal = await this.auth.checkBalance().catch(() => null);
      if (!bal || !bal.ok) { this.logLine('ERROR', `Cannot size order: balance unavailable (${bal && bal.error})`); return null; }
      available = bal.balance;

      // The allowance gate. The CLOB's number is a cache that this bot used to
      // read from a field CLOB V2 no longer returns, which made every live order
      // look unapproved. The gate is now the on-chain verification from
      // preflight, and a known-missing approval is repaired (gasless relayer
      // batch) instead of just skipping the trade.
      if (this.orderVersionOk === false) {
        const recheck = await this.checkOrderVersion(true);
        if (!recheck.ok) {
          this.lastSkipReason = `the CLOB is accepting order version ${recheck.version}, not ${SIGNED_ORDER_VERSION}`;
          this.logLine('ERROR', `Cannot trade: the CLOB is accepting order version ${recheck.version} and this bot signs `
            + `for version ${SIGNED_ORDER_VERSION}. The order would be rejected with order_version_mismatch.`);
          return null;
        }
      }

      const approvals = this.approvalState;
      if (approvals && approvals.ok && (approvals.missing || []).length) {
        const fixed = await this.ensureTradingApprovals();
        if (!fixed.ok) {
          this.lastSkipReason = 'the account wallet has not approved the CLOB V2 exchanges';
          this.logLine('ERROR', `Cannot trade: the account wallet has not approved the exchanges for `
            + `${(fixed.missing || []).join('; ') || 'pUSD/conditional tokens'}. Run \`npm run approve\`.`);
          return null;
        }
      }
      if (!(available > 0)) {
        this.lastSkipReason = 'the account wallet holds no tradeable collateral';
        this.logLine('ERROR', 'Cannot trade: the CLOB reports $0.00 of collateral for POLY_FUNDER_ADDRESS. '
          + 'pUSD must be in the account wallet, not on the signer EOA.');
        return null;
      }
    }

    let stake = this.tradeAmountUsd;
    if (this.kellySizing && Number.isFinite(decision.prob)) {
      const k = kellyStake({
        prob: decision.prob,
        price: limitPrice,
        feeSchedule,
        balanceUsd: Number.isFinite(available) ? available : this.tradeAmountUsd * 10,
        fraction: this.cfg.order.kellyFraction,
        minUsd: this.tradeAmountUsd,
        maxUsd: this.maxTradeAmountUsd,
      });
      stake = k.stake;
      this.logLine('INFO', `Kelly: P=${(decision.prob * 100).toFixed(1)}% @ ${(limitPrice * 100).toFixed(1)}c → stake $${stake.toFixed(2)} (f=${(k.kelly || 0).toFixed(3)})`);
    }

    // The cap covers cost + taker fee, so sizing takes the market's fee schedule.
    const sizing = sizeOrder({
      stakeUsd: stake,
      price: limitPrice,
      minShares: constraints.minOrderSize,
      tickSize: constraints.tickSize,
      maxStakeUsd: this.maxTradeAmountUsd,
      minOrderPolicy: this.cfg.order.minOrderPolicy,
      feeSchedule,
    });
    if (!sizing.ok) {
      this.lastSkipReason = `${tag} fired but did not trade: ${sizing.reason}`;
      this.logLine('INFO', `Order skipped: ${sizing.reason}`);
      return null;
    }
    if (sizing.totalUsd > available) {
      this.lastSkipReason = `${tag} fired but did not trade: $${sizing.totalUsd.toFixed(2)} needed, $${Number.isFinite(available) ? available.toFixed(2) : '∞'} available`;
      this.logLine('WARN', `Order skipped: $${sizing.totalUsd.toFixed(2)} needed, $${Number.isFinite(available) ? available.toFixed(2) : '∞'} available`);
      return null;
    }
    if (sizing.bumped) {
      this.logLine('INFO', `Sizing raised to the ${constraints.minOrderSize}-share market minimum: $${sizing.usd.toFixed(2)} (${sizing.shares} shares @ ${(limitPrice * 100).toFixed(1)}c)`);
    }
    this.logLine('INFO', `Order sized: ${sizing.shares} shares @ ${(limitPrice * 100).toFixed(1)}c = $${sizing.usd.toFixed(2)} cost + $${sizing.feeUsd.toFixed(2)} est. fee = $${sizing.totalUsd.toFixed(2)} (cap $${this.maxTradeAmountUsd.toFixed(2)} incl. fee)`);

    // ---- the edge gate, shared verbatim with the strategy engine
    // `entryEdgeTest` is the same function `candidate()` used to produce this
    // signal, at the same price against the same threshold, so the engine and
    // the execution path cannot disagree. It is still evaluated here because
    // `executeSignal()` is reachable without the engine (POST /api/trade) and
    // because `limitPrice` is recomputed from the live book, which may have moved
    // between evaluation and execution.
    const moduleCfg = (this.strategies && decision && decision.strategy)
      ? this.strategies.configFor(decision.strategy)
      : null;
    const t = entryEdgeTest({
      prob: decision.prob,
      bestAsk: book.bestAsk,
      tickSize: constraints.tickSize,
      maxSlippageCents: this.cfg.order.maxSlippageCents,
      maxBuyPrice: this.cfg.order.maxBuyPrice,
      feeSchedule,
      moduleMinNetEdge: Number.isFinite(moduleCfg && moduleCfg.minNetEdge)
        ? moduleCfg.minNetEdge
        : this.cfg.fees.minNetEdge,
      globalMinNetEdge: this.cfg.fees.minNetEdge,
      degraded: !!(decision && decision.degraded),
    });
    if (Math.abs(t.executablePrice - limitPrice) > 1e-9) {
      // Should be unreachable: both sides derive the limit price the same way.
      // If the book or the tick rules ever diverge this says so loudly instead of
      // quietly gating on a different price than the one the order will use.
      this.logLine('WARN', `Edge gate priced ${(t.executablePrice * 100).toFixed(2)}c but the order will use `
        + `${(limitPrice * 100).toFixed(2)}c — gating on the order price`);
    }
    if (!t.ok) {
      const who = t.limitedBy === 'global'
        ? `MIN_NET_EDGE floor ${(t.effectiveMinNetEdge * 100).toFixed(2)}c`
        : `${tag} module gate ${(t.effectiveMinNetEdge * 100).toFixed(2)}c`;
      this.lastSkipReason =
        `${tag} fired but did not trade: net edge ${(t.netEdge * 100).toFixed(2)}c at the executable price `
        + `(${side} ask ${(book.bestAsk * 100).toFixed(1)}c + ${this.cfg.order.maxSlippageCents}c slippage = limit ${(limitPrice * 100).toFixed(1)}c) `
        + `is below the ${who}`;
      this.logLine('INFO', `Order skipped: ${this.lastSkipReason}`);
      return null;
    }

    const orderType = this.cfg.order.orderType;
    // FAK/FOK are validated by the exchange as MARKET orders, which use mirrored
    // precision: the maker amount (USD) is capped at `size` decimals and the
    // taker amount (shares) at `amount` decimals. Building limit-shaped amounts
    // for a marketable buy gets rejected with "invalid amounts, the market buy
    // orders maker amount supports a max accuracy of 2 decimals, taker amount a
    // max of 4 decimals" — which silently passed whenever price*size happened to
    // land on a whole cent, so the failure looked intermittent.
    const amounts = MARKET_ORDER_TYPES.includes(orderType)
      ? computeMarketBuyAmounts(limitPrice, sizing.usd, constraints.tickSize)
      : computeBuyAmounts(limitPrice, sizing.shares, constraints.tickSize);

    const position = {
      id: `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      marketSlug: market.slug,
      conditionId: market.conditionId,
      question: market.question,
      timeframe: market.timeframe,
      side,
      strategy: decision.strategy,
      strategyName: decision.strategyName,
      modelProb: decision.prob,
      // The edge the single gate actually tested: at the executable price, net of
      // the fee at that price. `edgeAtAsk` is recorded alongside it because the
      // dashboard used to show the ask-price edge, and the two differ by the
      // slippage allowance — keeping both makes an entry auditable after the fact.
      expectedEdge: t.netEdge,
      edgeAtAsk: t.netEdgeAtAsk,
      executionPrice: t.executablePrice,
      edgeLimitedBy: t.limitedBy,
      limitPrice: amounts.price,
      requestedShares: amounts.size,
      requestedUsd: amounts.usd,
      tickSize: constraints.tickSize,
      minOrderSize: constraints.minOrderSize,
      negRisk: constraints.negRisk,
      feeSchedule,
      tokenId,
      entryTime: new Date().toISOString(),
      expiryTime: market.endTime,
      expiresAtEpoch: market.endsAtEpoch,
      referenceAtEntry: {
        twapOpen: ctx.windowOpen ? ctx.windowOpen.twap : null,
        twapNow: ctx.twap.value,
        spot: ctx.spot.value,
        source: ctx.twap.source,
        degraded: ctx.degraded,
      },
      filledShares: 0,
      filledUsd: 0,
      avgPrice: null,
      feeUsd: 0,
      orderIds: [],
      status: 'PENDING',
      isPaper: this.paperMode,
      reason: decision.reason,
    };

    if (this.paperMode) {
      const fill = estimateBuyFill(book, amounts.size);
      if (!fill || fill.shares + 1e-9 < constraints.minOrderSize) {
        this.logLine('WARN', `Paper order skipped: only ${fill ? fill.shares.toFixed(2) : 0} shares of depth`);
        return null;
      }
      const fee = feeTotal(fill.shares, fill.vwap, feeSchedule);
      position.filledShares = fill.shares;
      position.filledUsd = fill.cost;
      position.avgPrice = fill.vwap;
      position.feeUsd = fee;
      position.status = 'FILLED';
      position.paperPartial = !fill.complete;
      this.paperBalance -= (fill.cost + fee);
      this.activePositions.push(position);
      this.afterFill(position);
      this.logLine('SUCCESS', `[PAPER] ${side} ${fill.shares.toFixed(2)} shares @ ${(fill.vwap * 100).toFixed(1)}c ($${fill.cost.toFixed(2)} + $${fee.toFixed(3)} fee) via ${decision.strategyName}. ${decision.reason}`);
      return position;
    }

    // ---------------------------------------------------------- live path
    if (!this.auth.hasL2Credentials()) {
      this.logLine('ERROR', 'Live order aborted: no CLOB credentials (run derive first)');
      return null;
    }
    if (this.auth.geoblock && this.auth.geoblock.blocked) {
      this.logLine('ERROR', 'Live order aborted: geoblocked region');
      return null;
    }

    let signed;
    try {
      const expiration = orderType === 'GTD'
        ? Math.floor(Date.now() / 1000) + this.cfg.order.gtdSecondsLateWindow
        : 0;
      signed = await signOrder(this.auth.wallet, {
        tokenId,
        side: 'BUY',
        maker: this.auth.funderAddress,
        signer: this.auth.signerAddress,
        signatureType: this.auth.signatureType,
        negRisk: !!constraints.negRisk,
        makerAmount: amounts.makerAmount,
        takerAmount: amounts.takerAmount,
        expiration,
        chainId: this.cfg.chainId,
      });
    } catch (e) {
      this.logLine('ERROR', `Order signing failed: ${e.message}`);
      return null;
    }

    if (this.cfg.runtime.dryRunOrders) {
      this.logLine('WARN', `[DRY RUN] Order signed but not submitted: ${side} ${amounts.size} shares @ ${amounts.price} (maker ${this.auth.funderAddress})`);
      position.status = 'DRY_RUN';
      position.orderIds.push('dry-run');
      this.activePositions.push(position);
      return position;
    }

    let res;
    try {
      res = await this.clob.postOrder(signed.order, { orderType });
    } catch (e) {
      this.logLine('ERROR', `Order submission failed: ${e.message}`);
      return null;
    }

    const body = res.body || {};
    if (!res.ok || body.success === false) {
      const msg = body.errorMsg || body.error || body.message || `HTTP ${res.status}`;
      this.logLine('ERROR', `Order rejected: ${msg}`);
      position.status = 'REJECTED';
      position.rejectReason = msg;
      this.tradeHistory.unshift(position);
      return null;
    }

    position.status = body.status === 'matched' ? 'FILLED_PARTIAL_OR_FULL' : 'LIVE';
    position.orderIds.push(body.orderID);
    position.clobStatus = body.status;
    position.makingAmount = body.makingAmount;
    position.takingAmount = body.takingAmount;
    this.orders.set(body.orderID, { positionId: position.id, orderId: body.orderID, status: body.status, at: Date.now() });
    this.activePositions.push(position);
    this.logLine('SUCCESS', `[LIVE] Order ${body.orderID} status=${body.status} — ${side} ${amounts.size} shares @ ${amounts.price} via ${decision.strategyName}`);

    // Reconcile fills immediately, then again shortly after for resting orders.
    await this.reconcileOrder(position, body.orderID);
    setTimeout(() => { this.reconcileOrder(position, body.orderID).catch(() => {}); }, 4000);
    setTimeout(() => { this.cancelIfResting(position, body.orderID).catch(() => {}); }, this.cfg.risk.orderTimeoutSeconds * 1000);
    return position;
  }

  /**
   * Count an entry position once, on its first fill. The counters feed
   * MAX_TRADES_PER_WINDOW, so they must not move again for the same position.
   */
  afterFill(position) {
    this.lastTradeAt = Date.now();
    if (!position.fillCounted) {
      position.fillCounted = true;
      this.tradesThisWindow.set(position.marketSlug, (this.tradesThisWindow.get(position.marketSlug) || 0) + 1);
      this.totalTrades++;
    }
    this.saveState();
  }

  /**
   * Derive an entry position's filled shares, cost and fee from its recorded
   * trades and the CLOB's matched size. Both are authoritative, so this is
   * idempotent and may move the figures down as well as up.
   *
   *  - shares = the larger of the CLOB's size_matched and the trades' total.
   *  - cost, when the trades account for every matched share, is the trades'
   *    actual prices. Otherwise it falls back to the limit price, which is an
   *    upper bound: the cost is never understated.
   *
   * @returns {boolean} true when the position's shares changed
   */
  applyEntryFills(position) {
    const fills = Object.values(position.tradeFills || {}).filter(f => f.status !== 'FAILED');
    const tradeShares = fills.reduce((a, f) => a + f.size, 0);
    const tradeUsd = fills.reduce((a, f) => a + f.size * f.price, 0);
    const tradeFee = fills.reduce((a, f) => a + f.feeUsd, 0);
    const matched = Math.max(Number(position.clobMatched) || 0, tradeShares);
    const before = Number(position.filledShares) || 0;
    if (!(matched > 0)) {
      // Every recorded trade was reversed (FAILED): nothing is held any more.
      if (Object.keys(position.tradeFills || {}).length) {
        position.filledShares = 0;
        position.filledUsd = 0;
        position.avgPrice = null;
        position.feeUsd = 0;
      }
      return Math.abs(before) > 1e-9 && !(position.filledShares > 0);
    }

    const covered = fills.length > 0 && Math.abs(tradeShares - matched) <= 1e-6;
    const limit = Number(position.limitPrice) || 0;
    position.filledShares = matched;
    position.filledUsd = covered ? tradeUsd : matched * limit;
    position.avgPrice = matched > 0 ? position.filledUsd / matched : limit;
    position.feeUsd = covered ? tradeFee : feeTotal(matched, limit, position.feeSchedule);
    return Math.abs(matched - before) > 1e-9;
  }

  /**
   * Record one matched trade against an entry position. The user channel
   * re-sends a trade on every status change (MATCHED, MINED, CONFIRMED), so
   * trades are keyed by id: a repeat only refreshes the status and never adds
   * shares. Before this, each repeat was added on top, so a single fill was
   * counted two or three times.
   */
  recordEntryTrade(position, trade) {
    const size = Number(trade.size);
    const price = Number(trade.price);
    if (!(size > 0) || !(price > 0)) return false;
    const key = trade.id || `${trade.takerOrderId}|${trade.matchTime || ''}|${size}|${price}`;
    const status = String(trade.status || '').toUpperCase();
    position.tradeFills = position.tradeFills || {};

    const known = position.tradeFills[key];
    if (known) {
      known.status = status || known.status;
    } else {
      const fee = Number.isFinite(trade.feeRateBps)
        ? size * price * (trade.feeRateBps / 10000)
        : feeTotal(size, price, position.feeSchedule);
      position.tradeFills[key] = { size, price, feeUsd: fee, status };
      this.logLine('SUCCESS', `[TRADE] ${position.side} filled ${size} @ ${price} (fee $${fee.toFixed(4)})`);
    }
    position.transactionHash = trade.transactionHash || position.transactionHash;

    const changed = this.applyEntryFills(position);
    if (position.filledShares > 0) {
      position.status = 'FILLED';
      this.afterFill(position);
    }
    return changed;
  }

  /** Pull authoritative order state and turn it into position fills. */
  async reconcileOrder(position, orderId) {
    const r = await this.clob.getOrder(orderId).catch(() => null);
    if (!r || !r.ok || !r.body) return;
    const o = r.body;
    const matched = parseFloat(o.size_matched || '0');
    const price = parseFloat(o.price || '0');
    if (Number.isFinite(matched)) {
      position.clobMatched = matched;
      if (Number.isFinite(price) && price > 0 && !(position.limitPrice > 0)) position.limitPrice = price;
      const before = position.filledShares || 0;
      if (this.applyEntryFills(position)) {
        position.status = matched >= parseFloat(o.original_size || '0') - 1e-9 ? 'FILLED' : 'PARTIAL';
        if (position.filledShares >= position.minOrderSize) this.afterFill(position);
        this.logLine('INFO', `Fill update ${orderId.slice(0, 10)}…: ${position.filledShares} shares matched (was ${before}) @ ${(position.avgPrice * 100).toFixed(1)}c`);
      }
    }
    if (o.status) position.clobStatus = o.status;
  }

  async cancelIfResting(position, orderId) {
    const r = await this.clob.getOrder(orderId).catch(() => null);
    if (!r || !r.ok || !r.body) return;
    if (r.body.status === 'LIVE') {
      const c = await this.clob.cancelOrder(orderId).catch(() => null);
      this.logLine('INFO', `Cancelled resting order ${orderId.slice(0, 10)}… (${c && c.ok ? 'ok' : 'failed'})`);
      await this.reconcileOrder(position, orderId);
    }
  }

  onUserTrade(trade) {
    // Fill truth from the authenticated stream.
    const tid = trade.takerOrderId || trade.id || trade.orderId || null;
    const mid = trade.makerOrderId || null;

    // A SELL fill belongs to an exit order. It must NEVER fall through into the
    // entry accounting below: that accumulates into `filledShares`/`filledUsd`,
    // so a sell would look like buying more of the position and inflate both
    // the exposure and the cost basis. Reconcile from the authoritative order
    // state instead, which is idempotent.
    const exitPos = this.activePositions.find(p => (p.exitOrderIds || []).includes(tid)
      || (p.exitOrderIds || []).includes(mid));
    if (exitPos) {
      const oid = (exitPos.exitOrderIds || []).find(x => x === tid || x === mid);
      this.reconcileExitOrder(exitPos, oid).catch(() => {});
      return;
    }
    if (this.orders.has(tid) && this.orders.get(tid).kind === 'exit') {
      const rec = this.orders.get(tid);
      const p = this.activePositions.find(x => x.id === rec.positionId);
      if (p) { this.reconcileExitOrder(p, tid).catch(() => {}); return; }
    }

    const pos = this.activePositions.find(p => p.orderIds.includes(trade.takerOrderId) || p.orderIds.includes(trade.id));
    if (!pos) return;
    this.recordEntryTrade(pos, trade);
  }

  onUserOrder(order) {
    if (!order.id) return;
    // Exit orders get their own reconcile; a CANCELED sell must not mark the
    // position CANCELLED (it still holds shares worth settling).
    const exitPos = this.activePositions.find(p => (p.exitOrderIds || []).includes(order.id));
    if (exitPos) {
      exitPos.exitClobStatus = order.status;
      this.reconcileExitOrder(exitPos, order.id).catch(() => {});
      if (order.status === 'CANCELED' || order.status === 'CANCELLED' || order.status === 'EXPIRED') {
        exitLogic.clearExitPending(exitPos);
      }
      return;
    }
    const pos = this.activePositions.find(p => p.orderIds.includes(order.id));
    if (pos) {
      pos.clobStatus = order.status;
      if (order.status === 'CANCELED' && !pos.filledShares) pos.status = 'CANCELLED';
    }
  }


  // ------------------------------------------------------- exits (sell side)
  /**
   * Positions are terminal for counting purposes once they are settled, fully
   * sold, cancelled or rejected. A fully-exited position still waits for
   * resolution (so `settlePosition` books the exact payout) but it is no longer
   * live exposure and must not block the next window — otherwise
   * MAX_OPEN_POSITIONS=1 would stall the bot for the rest of the window even
   * though the capital has already been recycled.
   */
  static isTerminalPosition(p) {
    return !p || p.status === 'SETTLED' || p.status === 'EXITED'
      || p.status === 'CANCELLED' || p.status === 'REJECTED';
  }

  /** Positions that could still be sold before resolution. */
  exitablePositions() {
    return this.activePositions.filter(p => !BotCore.isTerminalPosition(p));
  }

  /**
   * One exit pass on demand, for POST /api/exit/run. Reports what it did rather
   * than leaving the operator to read the log.
   */
  async forceExitPass() {
    if (!this.exitEnabled) {
      return { ok: false, exited: 0, reason: 'EXIT_ENABLED is off — turn on the pre-expiry exit first' };
    }
    const before = this.exitStats.filled;
    const sharesBefore = this.exitStats.sharesSold;
    await this.manageExits();
    const exited = this.exitStats.filled - before;
    const shares = this.exitStats.sharesSold - sharesBefore;
    const open = this.exitablePositions().length;
    return {
      ok: true,
      exited,
      shares: +shares.toFixed(2),
      openPositions: open,
      reason: exited
        ? `sold ${shares.toFixed(2)} share(s) across ${exited} position(s)`
        : (open
            ? `no position met the exit gate${this.exitStats.lastReason ? ` — last reason: ${this.exitStats.lastReason}` : ''}`
            : 'no open positions to exit'),
    };
  }

  /**
   * Look at every open position and sell the ones the model already considers
   * decided. Runs every tick, before entries, so the proceeds are in collateral
   * by the time the entry path reads the balance.
   */
  async manageExits() {
    if (!this.exitEnabled) return;
    const candidates = this.exitablePositions();
    if (!candidates.length) return;
    const nowSec = Math.floor(Date.now() / 1000);

    for (const pos of candidates) {
      if (pos.exiting) continue;                       // an exit order is live
      if (!(Number(pos.filledShares) > 0)) continue;   // nothing to sell yet
      if (exitLogic.remainingShares(pos) <= 0) continue;

      const secondsLeft = Number.isFinite(pos.expiresAtEpoch)
        ? pos.expiresAtEpoch - nowSec
        : null;
      if (secondsLeft === null) continue;
      // Cheap time gate first: don't fetch a book or run the model outside the
      // exit band. planExit() re-checks authoritatively.
      if (secondsLeft > this.cfg.exit.maxSecondsToExpiry) continue;
      if (secondsLeft < this.cfg.exit.minSecondsToExpiry) continue;

      // Find the window this position belongs to. It may already be past
      // discovery's tradeable horizon — exits must still work there, which is
      // exactly why this does not reuse tick()'s filtered candidate list.
      const market = this.markets.find(m => m.conditionId === pos.conditionId
        || (pos.marketSlug && m.slug === pos.marketSlug));
      if (!market || !market.tokenMappingOk) {
        if (!pos.exitNoMarketWarned) {
          pos.exitNoMarketWarned = true;
          this.logLine('WARN', `Exit: ${pos.marketSlug} is no longer in discovery — cannot price an exit, holding to resolution`);
        }
        continue;
      }

      const book = await this.bookForDecision(pos.tokenId).catch(() => null);
      if (!book) continue;

      // Re-derive the model probability with the current clock. Falling back to
      // the entry-time probability would be wrong: it is the whole basis of the
      // conviction gate, and it goes stale within seconds.
      let probUp = null;
      const twap = this.ref.getTwap();
      const windowOpen = this.ref.getWindowOpen(market.epoch);
      if (windowOpen && windowOpen.twap !== null && windowOpen.twap !== undefined) {
        const m = fairProbUp({
          twapOpen: windowOpen.twap,
          twapNow: twap.value,
          priceNow: this.ref.getSpot().value,
          secondsLeft: Math.max(0, secondsLeft),
          sigmaPerSec: this.ref.getVolatilityPerSec(),
          twapWindow: this.cfg.reference.twapWindowSeconds,
          minSigmaPerSec: this.cfg.reference.minVolPerSec,
        });
        probUp = m ? m.pUp : null;
      }
      if (!Number.isFinite(probUp)) probUp = Number(pos.modelProb) || null;

      const plan = exitLogic.planExit({
        position: pos,
        book,
        probUp,
        secondsLeft,
        feeSchedule: pos.feeSchedule || market.feeSchedule
          || { rate: this.cfg.fees.defaultTakerRate, exponent: 1, takerOnly: true },
        cfg: this.cfg.exit,
      });

      if (!plan.exit) {
        // Record the most informative stand-down for the dashboard, but don't
        // spam the log with the every-tick reasons.
        if (plan.code !== 'too-early' && plan.code !== 'not-decided' && plan.code !== 'retry-cooldown') {
          pos.lastExitReason = `${plan.code}: ${plan.reason}`;
        }
        this.exitStats.lastReason = `${pos.side} ${plan.code}: ${plan.reason}`;
        continue;
      }

      await this.executeExit(pos, plan, { market, book });
    }
  }

  /** Place (or paper-simulate) the sell order produced by planExit(). */
  async executeExit(pos, plan, { market, book }) {
    const feeSchedule = pos.feeSchedule || market.feeSchedule
      || { rate: this.cfg.fees.defaultTakerRate, exponent: 1, takerOnly: true };

    // ---------------------------------------------------------- paper path
    if (this.paperMode || pos.isPaper) {
      const fill = estimateSellFill(book, plan.sellShares);
      if (!fill || !(fill.shares > 0)) {
        pos.lastExitReason = 'paper exit skipped: bid ladder cannot take the order';
        this.exitStats.lastReason = pos.lastExitReason;
        return null;
      }
      const fee = feePerShare(fill.vwap, feeSchedule) * fill.shares;
      exitLogic.markExitPending(pos, { attemptReason: plan.reason });
      exitLogic.applyExitFill(pos, {
        shares: fill.shares, grossUsd: fill.proceeds, feeUsd: fee,
        vwap: fill.vwap, orderId: null, isPaper: true,
      });
      // Deliberately NOT credited to `paperBalance` here. settlePosition credits
      // the full exit-adjusted payout once, at resolution; crediting it here too
      // would double-count every paper win (and every paper loss would keep the
      // sale proceeds it should have lost). Live mode is different: the
      // exchange returns the collateral when the SELL fills, which is the whole
      // point, and `settlePosition` only credits the shares still held.
      // `exitStats.recycledUsd` is the paper-mode visibility into recycling.
      this.recordExitFill(pos, {
        shares: fill.shares, vwap: fill.vwap,
        proceedsUsd: fill.proceeds, feeUsd: fee, mode: 'paper',
      });
      return pos;
    }

    // ----------------------------------------------------------- live path
    if (!this.auth.hasL2Credentials()) {
      this.logLine('ERROR', 'Exit aborted: no CLOB credentials — position will be held to resolution');
      return null;
    }
    if (this.auth.geoblock && this.auth.geoblock.blocked) {
      this.logLine('ERROR', 'Exit aborted: geoblocked region — position will be held to resolution');
      return null;
    }

    // The CLOB checks a SELL against its own cached conditional-token
    // allowance, and that cache only updates when you ask for it — per token.
    // A freshly granted setApprovalForAll therefore still reads as zero here,
    // and the exit is rejected with the same "not enough balance / allowance"
    // as an unapproved BUY. Refresh this token before signing.
    await this.auth.syncBalanceAllowance({ force: true, tokenId: pos.tokenId }).catch(() => null);

    const orderType = this.cfg.exit.orderType || 'FAK';
    let signed;
    try {
      const expiration = orderType === 'GTD'
        ? Math.floor(Date.now() / 1000) + this.cfg.order.gtdSecondsLateWindow
        : 0;
      signed = await signOrder(this.auth.wallet, {
        tokenId: pos.tokenId,
        // The one place in the bot that signs anything other than a BUY.
        side: 'SELL',
        maker: this.auth.funderAddress,
        signer: this.auth.signerAddress,
        signatureType: this.auth.signatureType,
        negRisk: !!pos.negRisk,
        makerAmount: plan.makerAmount,   // shares we give
        takerAmount: plan.takerAmount,   // USD we receive
        expiration,
        chainId: this.cfg.chainId,
      });
    } catch (e) {
      this.logLine('ERROR', `Exit signing failed for ${pos.marketSlug}: ${e.message}`);
      pos.lastExitReason = `signing failed: ${e.message}`;
      this.exitStats.failed++;
      return null;
    }

    if (this.cfg.runtime.dryRunOrders) {
      this.logLine('WARN', `[DRY RUN] Exit order signed but not submitted: SELL ${plan.sellShares} ${pos.side} @ ${(plan.limitPrice * 100).toFixed(1)}c`);
      exitLogic.markExitPending(pos, { orderId: 'dry-run-exit', attemptReason: plan.reason });
      exitLogic.clearExitPending(pos);
      return pos;
    }

    let res;
    try {
      res = await this.clob.postOrder(signed.order, { orderType });
    } catch (e) {
      this.logLine('ERROR', `Exit order submission failed: ${e.message}`);
      pos.lastExitReason = `submission failed: ${e.message}`;
      this.exitStats.failed++;
      return null;
    }

    const body = res.body || {};
    if (!res.ok || body.success === false) {
      const msg = body.errorMsg || body.error || body.message || `HTTP ${res.status}`;
      this.logLine('ERROR', `Exit order rejected: ${msg}`);
      pos.lastExitReason = `rejected: ${msg}`;
      exitLogic.clearExitPending(pos);
      this.exitStats.failed++;
      this.exitStats.attempted++;
      return null;
    }

    pos.exitClobStatus = body.status;
    exitLogic.markExitPending(pos, { orderId: body.orderID, attemptReason: plan.reason });
    this.orders.set(body.orderID, {
      positionId: pos.id, orderId: body.orderID, kind: 'exit', status: body.status, at: Date.now(),
    });
    this.exitStats.attempted++;
    this.logLine('INFO', `[LIVE] Exit order ${body.orderID} status=${body.status} — SELL ${plan.sellShares} ${pos.side} @ ${(plan.limitPrice * 100).toFixed(1)}c (${plan.reason})`);

    // FAK means the remainder is killed immediately, so the first reconcile is
    // usually authoritative; the delayed one catches a resting GTD/GTC.
    await this.reconcileExitOrder(pos, body.orderID, feeSchedule);
    setTimeout(() => {
      this.reconcileExitOrder(pos, body.orderID, feeSchedule).catch(() => {});
    }, 4000);
    setTimeout(() => { this.cancelRestingExit(pos, body.orderID).catch(() => {}); },
      this.cfg.risk.orderTimeoutSeconds * 1000);
    return pos;
  }

  /**
   * Pull authoritative SELL order state and turn it into a booked exit.
   *
   * Sets (not accumulates) from `size_matched`, so it is idempotent: the user
   * websocket, the immediate reconcile and the delayed reconcile can all call
   * it without double-counting a fill. That is the bug shape this avoids —
   * `onUserTrade` accumulates, and it must never be allowed to see a SELL.
   */
  async reconcileExitOrder(pos, orderId, feeScheduleOverride = null) {
    const r = await this.clob.getOrder(orderId).catch(() => null);
    if (!r || !r.ok || !r.body) return null;
    const o = r.body;
    const matched = parseFloat(o.size_matched || '0');
    const price = parseFloat(o.price || '0');
    const original = parseFloat(o.original_size || '0');
    const status = o.status;

    pos.exitClobStatus = status;
    if (!(matched > 0)) {
      // Nothing filled. FAK/MATCHED terminal states mean this exit is over.
      if (status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED'
        || status === 'MATCHED' || status === 'FILLED') {
        exitLogic.clearExitPending(pos);
        pos.lastExitReason = `exit order ${status} with 0 shares matched`;
      }
      return null;
    }

    const feeSchedule = feeScheduleOverride || pos.feeSchedule
      || { rate: this.cfg.fees.defaultTakerRate, exponent: 1, takerOnly: true };
    const proceedsUsd = matched * price;
    const feeUsd = feeTotal(matched, price, feeSchedule);

    // `size_matched` is the order's running total, so this must REPLACE the
    // booked exit, not add to it — see applyExitFill's two modes.
    const previousShares = Number(pos.exitShares || 0);
    exitLogic.applyExitFill(pos, {
      shares: matched, grossUsd: proceedsUsd, feeUsd,
      vwap: price, orderId, isPaper: false, authoritative: true,
    });
    if (matched <= previousShares + 1e-9) {
      // Already booked at this level by an earlier reconcile: don't re-count
      // the stats or re-log the fill.
      return { shares: matched, proceedsUsd, feeUsd, complete: original > 0 && matched >= original - 1e-9, unchanged: true };
    }
    this.orders.set(orderId, {
      positionId: pos.id, orderId, kind: 'exit', status, matched, price, at: Date.now(),
    });
    const complete = original > 0 && matched >= original - 1e-9;
    this.recordExitFill(pos, {
      shares: matched, vwap: price, proceedsUsd, feeUsd,
      mode: 'live', complete, orderId,
    });
    return { shares: matched, proceedsUsd, feeUsd, complete };
  }

  /** Cancel a SELL order that is still resting after the exit timeout. */
  async cancelRestingExit(pos, orderId) {
    const r = await this.clob.getOrder(orderId).catch(() => null);
    if (!r || !r.ok || !r.body) return;
    if (r.body.status === 'LIVE') {
      const c = await this.clob.cancelOrder(orderId).catch(() => null);
      this.logLine('INFO', `Cancelled resting exit order ${String(orderId).slice(0, 10)}… (${c && c.ok ? 'ok' : 'failed'})`);
      await this.reconcileExitOrder(pos, orderId);
    }
    exitLogic.clearExitPending(pos);
  }

  /**
   * Book an exit fill: stats, position status, and — in live mode — an
   * immediate forced refresh of the collateral balance, which is the step that
   * actually closes the capital loop.
   */
  recordExitFill(pos, { shares, vwap, proceedsUsd, feeUsd, mode, complete = null, orderId = null }) {
    const net = proceedsUsd - feeUsd;
    const heldTotal = Number(pos.filledShares || 0);
    const avgCost = heldTotal > 0 ? Number(pos.filledUsd || 0) / heldTotal : 0;
    const allocatedCost = avgCost * Number(shares);
    const pnl = net - allocatedCost;
    const remaining = exitLogic.remainingShares(pos);

    this.exitStats.filled++;
    this.exitStats.sharesSold += Number(shares);
    this.exitStats.proceedsUsd += proceedsUsd;
    this.exitStats.feesUsd += feeUsd;
    this.exitStats.recycledUsd += net;
    this.exitStats.lastExitAt = new Date().toISOString();
    if (complete === false || remaining > 0) this.exitStats.partial++;

    // Fully sold = no exposure left. It still waits for resolution so
    // settlePosition books the exact payout, but it stops counting as open.
    if (remaining <= 0 && pos.status !== 'SETTLED') pos.status = 'EXITED';

    pos.exitPnlUsd = Number((Number(pos.exitPnlUsd || 0) + pnl).toFixed(6));
    this.saveState();

    this.logLine('SUCCESS',
      `[EXIT ${mode === 'paper' ? 'PAPER' : 'LIVE'}] Sold ${Number(shares).toFixed(2)} ${pos.side} @ ${(vwap * 100).toFixed(1)}c `
      + `→ $${net.toFixed(2)} back into collateral (${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} vs entry, `
      + `${remaining > 0 ? `${remaining.toFixed(2)} share(s) still held` : 'position fully closed'})`);

    if (mode !== 'paper') {
      // Polymarket caches balance/allowance server-side. Force a refresh so the
      // next entry sees the freed capital immediately instead of up to a minute
      // later — recycling the capital is the entire reason this exists.
      this.auth.syncBalanceAllowance({ force: true }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ settlement
  onMarketResolved(payload) {
    const { conditionId, winningTokenId, winningOutcome } = payload;
    const affected = this.activePositions.filter(p => p.conditionId === conditionId || p.marketSlug === payload.slug);
    if (!affected.length) return;
    for (const pos of affected) {
      let winner = null;
      if (winningTokenId) winner = String(winningTokenId) === String(pos.tokenId) ? pos.side : (pos.side === 'UP' ? 'DOWN' : 'UP');
      else if (winningOutcome) winner = String(winningOutcome).toLowerCase() === pos.side.toLowerCase() ? pos.side : (pos.side === 'UP' ? 'DOWN' : 'UP');
      if (!winner) continue;
      this.settlePosition(pos, {
        winningSide: winner,
        source: 'market_resolved',
        winningTokenId: winningTokenId || null,
      });
    }
  }

  /** Fallback for positions whose market resolved while we were offline. */
  async settleExpiredPositions() {
    const now = Math.floor(Date.now() / 1000);
    for (const pos of this.activePositions) {
      if (pos.status === 'SETTLED') continue;
      if (pos.expiresAtEpoch > now) continue;
      if (!pos.filledShares) {
        // Nothing filled: close the record as cancelled.
        pos.status = 'CANCELLED';
        pos.settledAt = new Date().toISOString();
        this.activePositions = this.activePositions.filter(p => p.id !== pos.id);
        this.tradeHistory.unshift(pos);
        continue;
      }
      if (exitLogic.remainingShares(pos) <= 0) {
        // Everything was sold before the close, so the payout is already known
        // and does not depend on the outcome. Retire it now rather than waiting
        // for a resolution that cannot change the numbers — otherwise these
        // records accumulate in activePositions for the life of the process.
        pos.status = 'SETTLED';
        pos.exitedBeforeResolution = true;
        pos.resolutionSource = 'fully_exited';
        pos.payout = Number(pos.exitProceedsUsd || 0);
        pos.pnl = pos.payout - (Number(pos.filledUsd || 0) + exitLogic.totalFees(pos));
        pos.settledAt = new Date().toISOString();
        this.realizedPnl += pos.pnl;
        if (pos.pnl < 0) this.dailyLoss += Math.abs(pos.pnl);
        this.winningTrades += pos.pnl >= 0 ? 1 : 0;
        this.losingTrades += pos.pnl < 0 ? 1 : 0;
        this.activePositions = this.activePositions.filter(p => p.id !== pos.id);
        this.tradeHistory.unshift(pos);
        this.saveState();
        this.logLine('INFO', `Closed [${pos.marketSlug}] — fully sold pre-expiry, ${pos.pnl >= 0 ? '+' : '-'}$${Math.abs(pos.pnl).toFixed(2)} banked without waiting for resolution`);
        continue;
      }
      // Resolve the outcome from the layered resolver (Gamma by slug →
      // Gamma by condition id → CLOB market record). Never inferred from spot.
      const res = await this.discovery
        .resolveOutcome({ conditionId: pos.conditionId, slug: pos.marketSlug })
        .catch(() => ({ winner: null, source: 'error' }));
      if (res.winner) {
        this.settlePosition(pos, {
          winningSide: res.winner,
          source: res.source,
          winningTokenId: res.winner === pos.side ? pos.tokenId : null,
        });
        continue;
      }
      // Do NOT guess. Leave it open and flag it for inspection.
      if (!pos.unresolvedWarned) {
        pos.unresolvedWarned = true;
        this.logLine('WARN', `Position ${pos.marketSlug} expired but no resolution is available yet — left OPEN (not guessed).`);
      }
    }
  }

  settlePosition(pos, { winningSide, source, winningTokenId = null }) {
    // Idempotent: `market_resolved` and `settleExpiredPositions` can both reach
    // the same position, and booking the P&L twice would corrupt every breaker.
    if (pos.status === 'SETTLED') return pos;

    const won = winningSide === pos.side;
    const exited = exitLogic.wasExited(pos);
    const remaining = exitLogic.remainingShares(pos);

    // A SELL order still resting when the market resolves will never fill
    // usefully; cancel it so it cannot print against a dead market.
    if (pos.exiting && pos.exitOrderIds && pos.exitOrderIds.length && !pos.isPaper) {
      for (const oid of pos.exitOrderIds) {
        if (oid === 'dry-run-exit') continue;
        this.clob.cancelOrder(oid).catch(() => {});
      }
      pos.exiting = false;
    }

    // Payout = cash already banked by the exit, plus $1.00/share on whatever is
    // still held if that side won. Cost = the full entry cost plus both sides'
    // fees. This is the single accounting path: a position that was never
    // exited has exitProceedsUsd = 0 and remaining = filledShares, which
    // reduces exactly to the original `won ? filledShares : 0`.
    const payout = exitLogic.exitAdjustedPayout(pos, won);
    const cost = Number(pos.filledUsd || 0) + exitLogic.totalFees(pos);
    const pnl = payout - cost;

    pos.status = 'SETTLED';
    pos.winningSide = winningSide;
    pos.winningTokenId = winningTokenId;
    pos.resolutionSource = source;
    pos.payout = payout;
    pos.pnl = pnl;
    pos.remainingShares = remaining;
    pos.exitedBeforeResolution = exited;
    pos.settledAt = new Date().toISOString();

    // Paper: credit the whole exit-adjusted payout exactly once, here. The
    // exit itself does not touch paperBalance (see executeExit).
    // Live: the SELL already returned its proceeds to collateral when it
    // filled, so only the shares still held are owed anything — and those are
    // tokens until the sweeper redeems them, hence the queue below.
    if (pos.isPaper) this.paperBalance += payout;
    this.realizedPnl += pnl;
    if (pnl < 0) this.dailyLoss += Math.abs(pnl);
    if (won) this.winningTrades++; else this.losingTrades++;

    this.activePositions = this.activePositions.filter(p => p.id !== pos.id);
    this.tradeHistory.unshift(pos);
    this.saveState();

    this.logLine(won ? 'SUCCESS' : 'WARN',
      `Settled [${pos.marketSlug}] ${pos.side} → ${winningSide} (${source})`
      + `${exited ? ` [sold ${Number(pos.exitShares).toFixed(2)} @ ${((pos.exitAvgPrice || 0) * 100).toFixed(1)}c pre-expiry]` : ''}`
      + `: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);

    if (pos.isPaper) return pos;

    if (won && remaining > 0) {
      // Winning shares are still ERC-1155 tokens: invisible to
      // GET /balance-allowance, so invisible to the order path. Queue them for
      // the sweeper instead of only logging a reminder the operator has to act
      // on by hand.
      const queued = this.redeemer.queueCondition(pos.conditionId, {
        title: pos.marketSlug,
        shares: remaining,
        tokenIds: [pos.tokenId],
        negativeRisk: !!pos.negRisk,
      });
      if (this.autoRedeem && queued) {
        this.logLine('INFO', `Winner pays $1.00/share — queued ${remaining.toFixed(2)} share(s) of ${pos.marketSlug} for automatic redemption`);
        // Don't wait for the next scheduled sweep: this capital is idle now.
        setTimeout(() => { this.runRedeemSweep().catch(() => {}); }, 3000);
      } else if (queued) {
        this.logLine('WARN', `Winner pays $1.00/share — redeem ${remaining.toFixed(2)} share(s) manually (AUTO_REDEEM is off); `
          + 'until then they do not count toward your tradeable balance.');
      }
    } else if (!won && remaining > 0) {
      // Losing shares are worth $0 and cost gas/relayer submissions to clear.
      // Note them and move on.
      this.logLine('INFO', `${remaining.toFixed(2)} losing share(s) of ${pos.marketSlug} are worthless — not redeemed`);
    }
    return pos;
  }

  // ---------------------------------------------------------------- state
  loadState() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const d = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.paperBalance = d.paperBalance ?? this.paperBalance;
      this.startingBalance = d.startingBalance ?? this.startingBalance;
      this.realizedPnl = d.realizedPnl ?? 0;
      this.totalTrades = d.totalTrades ?? 0;
      this.winningTrades = d.winningTrades ?? 0;
      this.losingTrades = d.losingTrades ?? 0;
      this.tradeHistory = d.tradeHistory || [];
      // Open positions must survive a restart, otherwise they could never be
      // settled (or cancelled) and the P&L would silently disappear.
      this.activePositions = d.activePositions || [];
      if (this.activePositions.length) {
        this.logLine('INFO', `Restored ${this.activePositions.length} open position(s) from ${this.stateFile}`);
      }
      this.applySavedSizing(d);
      if (d.stopLossUsd !== undefined) this.stopLossUsd = d.stopLossUsd;
      if (d.maxDailyLossUsd !== undefined) this.maxDailyLossUsd = Math.max(1, Math.abs(d.maxDailyLossUsd));
      if (d.paperMode !== undefined) {
        this.paperMode = d.paperMode;
        this.redeemer.setPaperMode(this.paperMode);
      }
      if (d.strategies) this.strategies.setEnabledMap(d.strategies);
      if (d.selectedTimeframe) {
        const allowed = ['all', ...(this.cfg.market.timeframesAll || [])];
        if (allowed.includes(d.selectedTimeframe)) {
          this.selectedTimeframe = d.selectedTimeframe;
          this.cfg.market.timeframes = [d.selectedTimeframe];
        }
      }
      if (d.marketFilterSlug !== undefined) this.marketFilterSlug = d.marketFilterSlug || 'auto';
      if (d.exitEnabled !== undefined) {
        this.exitEnabled = !!d.exitEnabled;
        this.cfg.exit.enabled = this.exitEnabled;
      }
      if (d.autoRedeem !== undefined) {
        this.autoRedeem = !!d.autoRedeem;
        this.cfg.redeem.enabled = this.autoRedeem;
        this.redeemer.enabled = this.autoRedeem;
      }
      if (d.exitStats) this.exitStats = { ...this.exitStats, ...d.exitStats };
      if (Array.isArray(d.redeemPending)) {
        for (const cid of d.redeemPending) this.redeemer.queueCondition(cid);
      }
      if (Array.isArray(d.redeemed)) {
        for (const cid of d.redeemed) {
          this.redeemer.done.add(String(cid).toLowerCase());
          this.redeemer.pending.delete(String(cid).toLowerCase());
        }
      }
      this.dailyLoss = d.dailyLoss ?? 0;
      this.dailyKey = d.dailyKey ?? this.dailyKey;
    } catch (e) {
      this.logLine('WARN', `Failed to load state: ${e.message}`);
    }
  }

  /**
   * Apply the sizing saved in bot_state.json.
   *
   * A saved value applies only where the environment leaves the key unset. An
   * explicit TRADE_SIZE_USD, MAX_TRADE_SIZE_USD or KELLY_SIZING in .env (or the
   * shell) wins on every start; the saved value is then recorded in sizingIgnored
   * and reported. Before this rule the saved value always won: saveState() wrote the
   * live value back on every trade, so an edited .env line did nothing once a state
   * file existed.
   *
   * @param {object} saved the parsed bot_state.json
   */
  applySavedSizing(saved) {
    const setInEnv = (this.cfg.order && this.cfg.order.setInEnv) || {};
    const keys = [
      ['tradeAmountUsd', 'TRADE_SIZE_USD'],
      ['maxTradeAmountUsd', 'MAX_TRADE_SIZE_USD'],
      ['kellySizing', 'KELLY_SIZING'],
    ];
    const fromState = [];
    for (const [key, name] of keys) {
      if (saved[key] === undefined) continue;
      if (setInEnv[key]) {
        if (saved[key] !== this[key]) {
          this.sizingIgnored.push(`${name} ${saved[key]} saved in ${path.basename(this.stateFile)} is ignored: .env sets ${this[key]}`);
        }
        continue;
      }
      this[key] = saved[key];
      this.sizingSource[key] = 'state';
      fromState.push(name);
    }
    if (this.sizingIgnored.length) {
      this.logLine('WARN', `${this.sizingIgnored.join('; ')}. To use a saved value instead, delete its line from .env.`);
    }
    if (fromState.length) {
      this.logLine('INFO', `Sizing from ${path.basename(this.stateFile)} (not set in .env): ${fromState.join(', ')}`);
    }
  }

  /** Where a sizing value came from, for operator-facing text: '.env', the state file, or 'default'. */
  sizingSourceLabel(key) {
    const src = this.sizingSource[key];
    if (src === 'env') return '.env';
    if (src === 'state') return path.basename(this.stateFile);
    return 'default';
  }

  saveState() {
    try {
      const s = {
        paperBalance: this.paperBalance,
        startingBalance: this.startingBalance,
        realizedPnl: this.realizedPnl,
        totalTrades: this.totalTrades,
        winningTrades: this.winningTrades,
        losingTrades: this.losingTrades,
        tradeHistory: this.tradeHistory.slice(0, 100).map(p => ({ ...p })),
        activePositions: this.activePositions.map(p => ({ ...p })),
        tradeAmountUsd: this.tradeAmountUsd,
        maxTradeAmountUsd: this.maxTradeAmountUsd,
        stopLossUsd: this.stopLossUsd,
        maxDailyLossUsd: this.maxDailyLossUsd,
        kellySizing: this.kellySizing,
        paperMode: this.paperMode,
        dailyLoss: this.dailyLoss,
        dailyKey: this.dailyKey,
        // Persist the module toggles, otherwise every restart silently
        // re-enabled the strategies the user had switched off.
        strategies: this.strategies.enabledMap(),
        selectedTimeframe: this.selectedTimeframe,
        marketFilterSlug: this.marketFilterSlug,
        exitEnabled: this.exitEnabled,
        autoRedeem: this.autoRedeem,
        // Exit counters survive a restart so the dashboard does not show a
        // freshly-reset recycling record after every crash.
        exitStats: this.exitStats,
        // Conditions still awaiting redemption, so a restart mid-sweep does not
        // silently drop them (the Data API sweep would usually re-find them,
        // but a bot that was offline when a market resolved cannot rely on it).
        redeemPending: [...this.redeemer.pending],
        redeemed: [...this.redeemer.done],
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2));
    } catch (_) {}
  }

  /**
   * Apply a settings patch from the dashboard.
   *
   * Keys are resolved through SETTING_ALIASES so a rename on either side can
   * never silently drop a value again, and numbers are validated (a NaN from a
   * half-typed field must not be written into live risk limits). Anything not
   * applied comes back in `settingsChanges.unapplied` so the UI can say so.
   */
  updateSettings(patch = {}) {
    const applied = [];
    const unapplied = [];
    const next = {};

    for (const [rawKey, val] of Object.entries(patch || {})) {
      const key = resolveSettingKey(rawKey);
      if (!key) { unapplied.push(String(rawKey)); continue; }
      if (val === undefined || val === null) { unapplied.push(String(rawKey)); continue; }
      next[key] = val;
    }

    const num = (key, v) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) { unapplied.push(`${key} (not a number: ${v})`); return null; }
      return n;
    };

    // Order matters: maxTrade is clamped against the *new* tradeAmount.
    if (next.tradeAmountUsd !== undefined) {
      const n = num('tradeAmountUsd', next.tradeAmountUsd);
      if (n !== null) {
        this.tradeAmountUsd = Math.max(this.cfg.order.minStakeUsd, n);
        applied.push({ key: 'tradeAmountUsd', value: this.tradeAmountUsd });
      }
    }
    if (next.maxTradeAmountUsd !== undefined) {
      const n = num('maxTradeAmountUsd', next.maxTradeAmountUsd);
      if (n !== null) {
        this.maxTradeAmountUsd = Math.max(this.tradeAmountUsd, n);
        applied.push({ key: 'maxTradeAmountUsd', value: this.maxTradeAmountUsd });
      }
    }
    if (next.kellySizing !== undefined) {
      this.kellySizing = !!next.kellySizing;
      applied.push({ key: 'kellySizing', value: this.kellySizing });
    }
    if (next.stopLossUsd !== undefined) {
      const n = num('stopLossUsd', next.stopLossUsd);
      if (n !== null) {
        // Math.abs: the input is a *magnitude*. A typed "-300" means "300";
        // the previous Math.max(1, -300) silently made a $300 breaker a $1 one,
        // which stops the bot on the next tick for no visible reason.
        this.stopLossUsd = Math.max(1, Math.abs(n));
        applied.push({ key: 'stopLossUsd', value: this.stopLossUsd });
      }
    }
    if (next.maxDailyLossUsd !== undefined) {
      const n = num('maxDailyLossUsd', next.maxDailyLossUsd);
      if (n !== null) {
        this.maxDailyLossUsd = Math.max(1, Math.abs(n));
        applied.push({ key: 'maxDailyLossUsd', value: this.maxDailyLossUsd });
      }
    }
    if (next.paperMode !== undefined) {
      this.paperMode = !!next.paperMode;
      this.auth.setPaperMode(this.paperMode);
      this.redeemer.setPaperMode(this.paperMode);
      this.redeemer.enabled = this.autoRedeem;
      if (!this.paperMode && this.isRunning) {
        this.userStream.connect();
        this.runLivePreflight().catch(() => {});
        if (this.autoRedeem) this.startRedeemTimer(); else this.stopRedeemTimer();
      } else if (this.paperMode) {
        this.stopRedeemTimer();
      }
      applied.push({ key: 'paperMode', value: this.paperMode });
    }
    if (next.exitEnabled !== undefined) {
      this.exitEnabled = !!next.exitEnabled;
      this.cfg.exit.enabled = this.exitEnabled;
      applied.push({ key: 'exitEnabled', value: this.exitEnabled });
      this.logLine('INFO', this.exitEnabled
        ? `Pre-expiry exit ENABLED — decided positions will be sold from ${this.cfg.exit.maxSecondsToExpiry}s before close`
        : 'Pre-expiry exit DISABLED — wins will be held to resolution and must be redeemed on-chain');
    }
    if (next.autoRedeem !== undefined) {
      this.autoRedeem = !!next.autoRedeem;
      this.cfg.redeem.enabled = this.autoRedeem;
      this.redeemer.enabled = this.autoRedeem;
      applied.push({ key: 'autoRedeem', value: this.autoRedeem });
      this.redeemer.configWarningIssued = false;   // re-announce readiness
      if (this.isRunning && !this.paperMode) {
        if (this.autoRedeem) this.startRedeemTimer(); else this.stopRedeemTimer();
      }
      // Report readiness, not the raw reason string: printing `readiness().reason`
      // unconditionally produced "Auto-redemption ENABLED ... — AUTO_REDEEM=false",
      // a line that contradicts itself and reads like the toggle was ignored.
      if (this.autoRedeem) {
        const rdy = this.redeemer.readiness();
        const cadence = `every ${Math.round(this.cfg.redeem.everyMs / 1000)}s`;
        // Decide the level from the MESSAGE, not from rdy.ready: in paper mode
        // the sweep is simulated so missing relayer credentials are not a
        // problem, and grading that WARN emitted a correct sentence at the wrong
        // severity. Paper first, then readiness — never the other way round.
        if (this.paperMode) {
          this.logLine('INFO', `Auto-redemption ENABLED (${cadence}) — paper mode simulates the sweep; no relayer credentials needed`);
        } else if (rdy.ready) {
          this.logLine('INFO', `Auto-redemption ENABLED (${cadence}) — ready via the ${rdy.mode} relayer path, redeeming to ${this.redeemer.outputToken}`);
        } else {
          this.logLine('WARN', `Auto-redemption ENABLED (${cadence}) but NOT USABLE — ${rdy.reason}`);
        }
      } else {
        this.logLine('INFO', 'Auto-redemption DISABLED — resolved wins must be redeemed manually');
      }
    }
    if (next.selectedTimeframe !== undefined) {
      const tf = String(next.selectedTimeframe);
      const allowed = ['all', ...(this.cfg.market.timeframesAll || [])];
      if (!allowed.includes(tf)) {
        unapplied.push(`selectedTimeframe (${tf} not one of ${allowed.join('|')})`);
      } else {
        const changed = tf !== this.selectedTimeframe;
        this.selectedTimeframe = tf;
        // discovery.getMarkets() expands 'all' against timeframesAll.
        this.cfg.market.timeframes = [tf];
        applied.push({ key: 'selectedTimeframe', value: tf });
        if (changed) {
          // Re-discover so the market list and WS subscriptions follow.
          this.refreshMarkets().catch(e => this.logLine('ERROR', `discovery: ${e.message}`));
        }
      }
    }
    if (next.selectedMarketSlug !== undefined) {
      const slug = String(next.selectedMarketSlug) || 'auto';
      this.marketFilterSlug = slug;
      applied.push({ key: 'selectedMarketSlug', value: slug });
    }

    // Evaluated after BOTH toggles have been applied: checking it inside the
    // exitEnabled block would read the previous autoRedeem value and stay
    // silent when a single request turns both off.
    if (next.exitEnabled !== undefined || next.autoRedeem !== undefined) {
      if (!this.exitEnabled && !this.autoRedeem) {
        this.logLine('WARN', 'Both capital-recycling mechanisms are now off: in live mode the bot will drain its '
          + 'tradeable balance into unredeemable tokens and then stop placing orders while realised P&L keeps rising.');
      } else if (!this.exitEnabled) {
        this.logLine('WARN', 'Pre-expiry exit is off: wins are held to resolution and depend entirely on the '
          + 'redemption sweeper to return capital. If the relayer is not configured, nothing will.');
      }
    }

    let strategyChanges = null;
    if (next.strategies) {
      strategyChanges = this.strategies.updateConfig(next.strategies);
      for (const c of strategyChanges.applied) {
        this.logLine('INFO', `Strategy "${c.name}" ${c.enabled ? 'ENABLED' : 'DISABLED'}`);
      }
      for (const u of strategyChanges.unknown) {
        this.logLine('WARN', `Ignored unknown strategy key in settings: "${u}"`);
        unapplied.push(`strategies.${u}`);
      }
    }

    for (const a of applied) {
      if (a.key === 'strategies') continue;
      this.logLine('INFO', `Setting ${a.key} = ${typeof a.value === 'boolean' ? a.value : a.value}`);
    }
    for (const u of unapplied) {
      this.logLine('WARN', `Setting not applied: ${u}`);
    }

    this.saveState();
    this.logLine('INFO', 'Settings updated');
    const state = this.getState();
    // So the dashboard can surface anything that was not applied.
    state.settingsChanges = { applied, unapplied };
    if (strategyChanges) state.strategyChanges = strategyChanges;
    return state;
  }

  resetPaperAccount() {
    this.paperBalance = 1000;
    this.startingBalance = 1000;
    this.realizedPnl = 0;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.tradeHistory = [];
    this.activePositions = [];
    this.dailyLoss = 0;
    this.exitStats = {
      attempted: 0, filled: 0, partial: 0, failed: 0,
      sharesSold: 0, proceedsUsd: 0, feesUsd: 0, recycledUsd: 0,
      lastReason: null, lastExitAt: null,
    };
    this.redeemer.pending.clear();
    this.redeemer.done.clear();
    this.redeemer.failed.clear();
    this.redeemer.history = [];
    this.saveState();
    this.logLine('INFO', 'Paper account reset to $1,000');
  }

  getState() {
    const winRate = this.totalTrades > 0 ? +((this.winningTrades / this.totalTrades) * 100).toFixed(1) : 0;
    const tick = (this.markets[0] && (this.markets[0].tickSize || this.cfg.order.tickSize)) || this.cfg.order.tickSize;
    const minShares = (this.markets[0] && this.markets[0].minOrderSize) || this.cfg.order.minShares;
    return {
      isRunning: this.isRunning,
      stoppedReason: this.stoppedReason,
      paperMode: this.paperMode,
      asset: this.cfg.market.asset,
      timeframes: this.cfg.market.timeframes,
      tradeAmountUsd: this.tradeAmountUsd,
      maxTradeAmountUsd: this.maxTradeAmountUsd,
      stopLossUsd: this.stopLossUsd,
      maxDailyLossUsd: this.maxDailyLossUsd,
      kellySizing: this.kellySizing,
      paperBalance: +this.paperBalance.toFixed(2),
      startingBalance: this.startingBalance,
      realizedPnl: +this.realizedPnl.toFixed(2),
      // Gross realised losses for the current UTC day, and when that counter
      // rolls over — "daily" here is 00:00 UTC, not local midnight.
      dailyLoss: +this.dailyLoss.toFixed(2),
      dailyLossPct: this.maxDailyLossUsd > 0
        ? +Math.min(100, (this.dailyLoss / this.maxDailyLossUsd) * 100).toFixed(1)
        : 0,
      dailyLossResetAtUtc: `${this.dailyKey}T00:00:00.000Z`,
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      winRate,
      minOrderShares: minShares,
      tickSize: tick,
      // minimum viable order at current prices, so the UI can explain sizing
      minOrderUsdAt50c: +(minShares * 0.5).toFixed(2),
      activePositions: this.activePositions,
      tradeHistory: this.tradeHistory.slice(0, 30),
      markets: this.markets.slice(0, 8),
      strategies: this.strategies.getState(),
      selectedTimeframe: this.selectedTimeframe,
      marketFilterSlug: this.marketFilterSlug,
      signals: this.signals.slice(0, 5),
      lastSkipReason: this.lastSkipReason,
      logs: this.logs.slice(0, 60),
      auth: this.auth.getStatus(),
      feeds: this.ref.health(),
      // Price to beat for the window the bot is currently watching, including
      // whether it is known at all — a window that opened before the bot could
      // observe it is not tradeable, and the dashboard should say why.
      priceToBeat: (() => {
        const m = this.markets.find(x => x.remainingSec > 0);
        if (!m) return null;
        const w = this.ref.getWindowOpen(m.epoch);
        const known = !!(w && w.twap !== null && w.twap !== undefined);
        return {
          epoch: m.epoch,
          twap: known ? w.twap : null,
          source: known ? w.source : null,
          authoritative: known ? !!w.authoritative : false,
          backfilled: known ? !!w.backfilled : false,
          ok: known,
          reason: known ? null : ((w && w.reason) || 'not recorded yet'),
        };
      })(),
      ws: {
        market: {
          connected: this.marketStream.ws ? this.marketStream.ws.readyState === 1 : false,
          fresh: this.marketStream.isFresh(),
          assets: [...this.marketStream.assets].length,
          lastError: this.marketStream.lastError,
        },
        user: this.userStream.getStatus(),
      },
      geoblock: this.geoblock,
      allowanceWarning: this.allowanceWarning,
      orderVersion: this.orderVersion,
      orderVersionOk: this.orderVersionOk,
      approvals: this.approvalState ? {
        ok: this.approvalState.ok && !(this.approvalState.missing || []).length,
        verifiedOnChain: this.approvalState.ok,
        missing: (this.approvalState.missing || []).map(m => m.label),
        error: this.approvalState.error || this.lastApprovalError || null,
      } : null,

      // ------------------------------------------------- capital recycling
      // Everything needed to see whether wins are actually coming back into
      // the tradeable balance. Without this the failure mode is invisible:
      // realised P&L rises, the bot quietly stops trading, and the only clue
      // is a "Order skipped: $X needed, $0.00 available" line in the log.
      exitEnabled: this.exitEnabled,
      autoRedeem: this.autoRedeem,
      exit: {
        ...this.exitStats,
        sharesSold: +this.exitStats.sharesSold.toFixed(2),
        proceedsUsd: +this.exitStats.proceedsUsd.toFixed(4),
        feesUsd: +this.exitStats.feesUsd.toFixed(4),
        recycledUsd: +this.exitStats.recycledUsd.toFixed(4),
        config: {
          maxSecondsToExpiry: this.cfg.exit.maxSecondsToExpiry,
          minSecondsToExpiry: this.cfg.exit.minSecondsToExpiry,
          minModelProb: this.cfg.exit.minModelProb,
          minSellPrice: this.cfg.exit.minSellPrice,
          maxSellPrice: this.cfg.exit.maxSellPrice,
          maxBidDepthParticipation: this.cfg.exit.maxBidDepthParticipation,
          minProfitFloorUsd: this.cfg.exit.minProfitFloorUsd,
          orderType: this.cfg.exit.orderType,
        },
        // Live exposure per position, so the UI can show what is still
        // waiting on resolution versus already banked.
        positions: this.exitablePositions().map(exitLogic.exitView),
      },
      redeem: this.redeemer.getState(),
      // Tradeable collateral as the order path sees it. Compare against
      // realised P&L: if P&L is rising while this falls, wins are being locked
      // into tokens instead of recycled.
      collateral: {
        live: Number.isFinite(this.auth.liveBalanceUsd) ? +this.auth.liveBalanceUsd.toFixed(2) : null,
        allowance: Number.isFinite(this.auth.allowanceUsd) ? +this.auth.allowanceUsd.toFixed(2) : null,
        paper: +this.paperBalance.toFixed(2),
        mode: this.paperMode ? 'paper' : 'live',
      },
    };
  }
}

module.exports = { BotCore };
