'use strict';
/**
 * Central configuration. Everything is env-overridable so you can tune without
 * editing code. See .env.example for the full list.
 */
const fs = require('fs');
const path = require('path');
// Read the .env that sits next to this file, not whatever the working directory
// is. dotenv's default is process.cwd(), so starting the bot from anywhere else
// (a service manager, an IDE run configuration) silently ignored every line and
// ran on the built-in defaults. STATE_FILE is anchored the same way.
const ENV_FILE = path.join(__dirname, '.env');
const envLoad = require('dotenv').config({ path: ENV_FILE });

function env(key, def) {
  const v = process.env[key];
  return (v === undefined || v === '') ? def : v;
}
function num(key, def) { const v = env(key, null); return v === null ? def : parseFloat(v); }
/**
 * An address from the environment, normalised to EIP-55.
 *
 * ethers v6 *rejects* a mixed-case address whose checksum is wrong, so an
 * address pasted from a wallet UI or a block explorer with different casing
 * throws `bad address checksum` from deep inside an approval read — which looks
 * like an RPC failure and is not one. Lowercase and correctly-checksummed input
 * both work; only a genuinely malformed value is passed through untouched so
 * validateConfig can name it.
 */
function addr(key, def = null) {
  const v = env(key, null);
  if (v === null) return def;
  const s = String(v).trim();
  // Accept an upper-case `0X` prefix too: ethers rejects it outright, and a
  // value copied out of some explorers and terminals carries it.
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) return s;
  // Lowercase first: getAddress() *validates* the checksum of mixed-case input
  // and throws on a wrong one, which is the exact case being repaired here.
  try { return require('ethers').getAddress(s.toLowerCase()); } catch (_) { return s; }
}
function bool(key, def) {
  const v = env(key, null);
  if (v === null) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
/** True when the environment (.env or the shell) sets the key to a non-empty value. */
function isSet(key) {
  const v = process.env[key];
  return v !== undefined && v !== '';
}

const CONFIG = {
  // ---------------------------------------------------------------- platform
  endpoints: {
    gamma: env('GAMMA_URL', 'https://gamma-api.polymarket.com'),
    clob: env('CLOB_URL', 'https://clob.polymarket.com'),
    dataApi: env('DATA_API_URL', 'https://data-api.polymarket.com'),
    marketWs: env('MARKET_WS', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),
    userWs: env('USER_WS', 'wss://ws-subscriptions-clob.polymarket.com/ws/user'),
    polyboltWs: env('POLYBOLT_WS', 'wss://ws-live-v2.polymarket.com/ws'),
    geoblock: env('GEOBLOCK_URL', 'https://polymarket.com/api/geoblock'),
    // Gasless relayer: executes on-chain calls (redemption) from the account
    // wallet and pays the gas. Not part of the CLOB, and not optional if you
    // want wins converted back into tradeable collateral.
    relayer: env('RELAYER_URL', 'https://relayer-v2.polymarket.com'),
    // polygon-rpc.com now answers 401 "tenant disabled" for anonymous callers,
    // which silently kills the on-chain balance fallback.
    polygonRpc: env('POLYGON_RPC', 'https://polygon-bor-rpc.publicnode.com'),
  },

  chainId: num('CHAIN_ID', 137),

  // ------------------------------------------------------------------ wallet
  wallet: {
    privateKey: env('POLY_PRIVATE_KEY', null),
    // Account wallet address (Deposit Wallet / Proxy / Safe). REQUIRED for
    // signature types 1, 2 and 3. For EOA (type 0) it is the signer itself.
    funderAddress: addr('POLY_FUNDER_ADDRESS', null),
    // 0 = EOA, 1 = POLY_PROXY (legacy Magic/Google), 2 = GNOSIS_SAFE (legacy
    // MetaMask), 3 = DEPOSIT_WALLET (default for wallets created after
    // 2026-05-04).
    signatureType: num('POLY_SIGNATURE_TYPE', 3),
    // Optional: provide existing CLOB L2 credentials instead of deriving them.
    apiKey: env('POLY_API_KEY', null),
    apiSecret: env('POLY_API_SECRET', null),
    apiPassphrase: env('POLY_API_PASSPHRASE', null),
  },

  // -------------------------------------------------------------- market side
  market: {
    asset: env('ASSET', 'btc'),                 // btc | eth | sol | ...
    symbol: env('ASSET_SYMBOL', 'btcusd'),      // PolyBolt symbol (lowercase)
    timeframes: (env('TIMEFRAMES', '5m')).split(',').map(s => s.trim()),
    timeframesAll: ['5m', '15m'],
    windowSeconds: { '5m': 300, '15m': 900 },
    // How many future windows to track/discover
    lookaheadWindows: num('LOOKAHEAD_WINDOWS', 2),
  },

  // ------------------------------------------------------------ order sizing
  order: {
    stakeUsd: num('TRADE_SIZE_USD', 10.0),
    minStakeUsd: num('MIN_TRADE_SIZE_USD', 1.0),
    maxStakeUsd: num('MAX_TRADE_SIZE_USD', 25.0),
    // Polymarket enforces a per-market minimum SHARE count (currently 5).
    // Book values are authoritative at runtime; these are the fallbacks.
    minShares: num('MIN_ORDER_SHARES', 5),
    tickSize: num('DEFAULT_TICK_SIZE', 0.01),
    // Behaviour when the configured stake cannot buy `minShares`:
    //  'bump'  -> raise the stake to the minimum viable order (default)
    //  'skip'  -> don't trade
    minOrderPolicy: env('MIN_ORDER_POLICY', 'bump'),
    // Never pay more than best ask + this many cents
    maxSlippageCents: num('MAX_SLIPPAGE_CENTS', 2),
    // Hard price sanity cap: never buy above this price (protects against
    // fat-finger asks late in a window)
    maxBuyPrice: num('MAX_BUY_PRICE', 0.97),
    kellySizing: bool('KELLY_SIZING', false),
    kellyFraction: num('KELLY_FRACTION', 0.25),
    // Which of the sizing keys above the environment actually sets. A value saved
    // in bot_state.json replaces a key only where the environment leaves it unset
    // (see BotCore.applySavedSizing).
    setInEnv: {
      tradeAmountUsd: isSet('TRADE_SIZE_USD'),
      maxTradeAmountUsd: isSet('MAX_TRADE_SIZE_USD'),
      kellySizing: isSet('KELLY_SIZING'),
    },
    orderType: env('ORDER_TYPE', 'FAK'),  // FAK = marketable, cancels remainder
    // Signed GTD expiry is floored at 210s (CLOB minimum + transit margin).
    // Short rest/timeout deadlines are enforced by explicit cancellation.
    gtdSecondsLateWindow: num('GTD_SECONDS', 30),
  },

  // ------------------------------------------------------------------- fees
  fees: {
    // Fallback taker rate by category when a market does not publish a
    // feeSchedule. Crypto markets are currently 0.07 (rate) with exponent 1.
    defaultTakerRate: num('DEFAULT_TAKER_FEE_RATE', 0.07),
    // Require net edge (model prob - price - fee per share) of at least this.
    minNetEdge: num('MIN_NET_EDGE', 0.015),
    // Sanity guard: refuse to trade if a market's published fee rate exceeds
    // this (guards against silently mispriced edges).
    maxTakerRate: num('MAX_TAKER_FEE_RATE', 0.10),
  },

  // -------------------------------------------------------------- strategies
  strategies: {
    twapMomentum: {
      enabled: bool('ENABLE_STRAT_TWAP_MOMENTUM', true),
      minLeadMultiple: num('TWAP_MOMENTUM_MIN_LEAD', 1.25), // |E[W]-W0| / sigmaW
      minNetEdge: num('TWAP_MOMENTUM_MIN_EDGE', 0.02),
      maxEntrySecondsLeft: num('TWAP_MOMENTUM_MAX_LEFT', 240),
      minEntrySecondsLeft: num('TWAP_MOMENTUM_MIN_LEFT', 45),
    },
    fairValueEv: {
      enabled: bool('ENABLE_STRAT_FAIR_VALUE_EV', true),
      minNetEdge: num('FV_MIN_EDGE', 0.03),
      minProb: num('FV_MIN_PROB', 0.55),
      maxEntrySecondsLeft: num('FV_MAX_LEFT', 280),
      minEntrySecondsLeft: num('FV_MIN_LEFT', 40),
    },
    lateWindowConvergence: {
      enabled: bool('ENABLE_STRAT_LATE_WINDOW', true),
      windowSeconds: num('LWC_WINDOW', 180),   // only in the final N seconds
      minProb: num('LWC_MIN_PROB', 0.88),
      minNetEdge: num('LWC_MIN_EDGE', 0.015),
      maxPrice: num('LWC_MAX_PRICE', 0.95),
    },
    microstructure: {
      enabled: bool('ENABLE_STRAT_MICROSTRUCTURE', true),
      minDepthUsd: num('MS_MIN_DEPTH', 250),
      minImbalance: num('MS_MIN_IMBALANCE', 1.8),
      maxSpread: num('MS_MAX_SPREAD', 0.04),
      minNetEdge: num('MS_MIN_EDGE', 0.02),
      minEntrySecondsLeft: num('MS_MIN_LEFT', 60),
    },
    rsiReversion: {
      enabled: bool('ENABLE_STRAT_RSI_REVERSION', true),
      period: num('RSI_PERIOD', 14),
      oversold: num('RSI_OVERSOLD', 30),
      overbought: num('RSI_OVERBOUGHT', 70),
      // In a TWAP-settled market an RSI extreme is only tradeable when the
      // fair-value model agrees; require this much model confirmation.
      minModelProb: num('RSI_MIN_PROB', 0.62),
      minNetEdge: num('RSI_MIN_EDGE', 0.02),
      minEntrySecondsLeft: num('RSI_MIN_LEFT', 60),
    },
    crossExchange: {
      enabled: bool('ENABLE_STRAT_CROSS_EXCHANGE', true),
      minDivergenceUsd: num('XEX_MIN_DIVERGENCE', 12),
      maxStalenessMs: num('XEX_MAX_STALENESS_MS', 2500),
      minModelProb: num('XEX_MIN_PROB', 0.60),
      minNetEdge: num('XEX_MIN_EDGE', 0.02),
      minEntrySecondsLeft: num('XEX_MIN_LEFT', 60),
    },
    volatilityBreakout: {
      enabled: bool('ENABLE_STRAT_VOL_BREAKOUT', true),
      lookbackSeconds: num('VB_LOOKBACK', 90),
      sigmaMultiple: num('VB_SIGMA', 2.0),
      thrustSeconds: num('VB_THRUST', 15),
      minNetEdge: num('VB_MIN_EDGE', 0.025),
      minEntrySecondsLeft: num('VB_MIN_LEFT', 90),
      maxEntrySecondsLeft: num('VB_MAX_LEFT', 240),
    },
    staleQuoteSnipe: {
      enabled: bool('ENABLE_STRAT_STALE_SNIPE', true),
      onlyLastSeconds: num('SQS_LAST_SECONDS', 25),
      minProb: num('SQS_MIN_PROB', 0.965),
      maxPrice: num('SQS_MAX_PRICE', 0.93),
      minNetEdge: num('SQS_MIN_EDGE', 0.01),
      minEntrySecondsLeft: num('SQS_MIN_LEFT', 8),
    },
    /**
     * 9) Passive Reversion — the only module that does not TAKE.
     *
     * Every other module buys at the ask and pays the taker fee, which on a
     * crypto market is 0.07·p·(1−p) — up to 1.75c/share, the same order of
     * magnitude as the edge being chased. This one rests a post-only bid below
     * the market and is paid to wait: makers are never charged a fee on
     * Polymarket, and 20% of the taker fees collected in the market are
     * redistributed to makers daily.
     *
     * The edge it harvests is the gap between the book and the settlement
     * reference. Since the TWAP upgrade the book swings hard (an ask can run
     * 0.60 → 0.80 → 0.48 in seconds) while the 60s Chainlink TWAP that
     * actually settles the market moves slowly. That makes the book's implied
     * probability a noisy, mean-reverting series around the TWAP model's fair
     * value — so instead of chasing the book we quote inside the spread and
     * let the swing come to us.
     *
     * This is also the one edge class that is not a latency race: a resting bid
     * is filled because it is the best price, not because it was first.
     */
    makerReversion: {
      enabled: bool('ENABLE_STRAT_MAKER_REVERSION', true),
      // Net edge required at the QUOTE price. Fee-free, so this is pure
      // buffer — it is what pays for adverse selection when a fill happens
      // because the market moved rather than because it was noisy.
      minNetEdge: num('MR_MIN_EDGE', 0.015),
      // Don't quote a side the model is not already leaning towards.
      minProb: num('MR_MIN_PROB', 0.55),
      // Hard cap. Above ~85c a fill is almost always toxic: you collect a cent
      // and pick up a 90c loss when the "certainty" breaks.
      maxQuotePrice: num('MR_MAX_QUOTE_PRICE', 0.85),
      // How far above the best bid to join the queue. 1 tick puts us top of
      // book; 0 joins it.
      improveTicks: num('MR_IMPROVE_TICKS', 1),
      // ...and how far BELOW it we will still call it a quote. When the edge
      // gate or the price cap clamps our price well under the market, what is
      // left is a bid nobody will ever hit: it holds an open position for the
      // whole rest window and fills never. Stand down instead.
      maxTicksBelowBid: num('MR_MAX_TICKS_BELOW_BID', 2),
      // Only quote when the bid is dislocated from fair by at least this much.
      // If the book already agrees with the model there is nothing to capture
      // and we would just be warehousing inventory at fair value.
      minDislocation: num('MR_MIN_DISLOCATION', 0.02),
      // A quote needs real resting liquidity beneath it, or it is the whole
      // book and every fill is someone dumping into us.
      minBidDepthUsd: num('MR_MIN_BID_DEPTH', 150),
      // Long enough for a swing to arrive, short enough that the window is
      // still ours if it doesn't.
      restSeconds: num('MR_REST_SECONDS', 20),
      // Never leave a quote resting into the last seconds: it must be gone
      // before MIN_SECONDS_TO_EXPIRY, with room for the cancel round trip.
      cancelBufferSeconds: num('MR_CANCEL_BUFFER', 8),
      // Submit with postOnly so the CLOB rejects a quote that would cross
      // instead of letting it take (and pay the fee).
      postOnly: bool('MR_POST_ONLY', true),
      maxEntrySecondsLeft: num('MR_MAX_LEFT', 240),
      minEntrySecondsLeft: num('MR_MIN_LEFT', 45),
    },
  },

  // ------------------------------------------------------------------- risk
  risk: {
    stopLossUsd: num('STOP_LOSS_USD', 25.0),
    takeProfitUsd: num('TAKE_PROFIT_USD', 0),   // 0 = disabled
    maxOpenPositions: num('MAX_OPEN_POSITIONS', 1),
    maxTradesPerWindow: num('MAX_TRADES_PER_WINDOW', 1),
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 50),
    cooldownSeconds: num('COOLDOWN_SECONDS', 20),
    maxSpreadCents: num('MAX_SPREAD_CENTS', 6),
    minBookDepthUsd: num('MIN_BOOK_DEPTH_USD', 100),
    // Refuse to open a position if fewer than this many seconds remain
    // (the order may not fill / settle cleanly).
    minSecondsToExpiry: num('MIN_SECONDS_TO_EXPIRY', 10),
    // Cancel unfilled resting orders after this long.
    orderTimeoutSeconds: num('ORDER_TIMEOUT_SECONDS', 12),
  },

  // ------------------------------------------------- exits (capital recycling)
  /**
   * The CLOB has no redemption endpoint and `GET /balance-allowance` only ever
   * reports collateral — never unredeemed winning tokens. A bot that only buys
   * therefore drains its own float and then idles with a healthy-looking P&L.
   *
   * `exit` is the primary fix: sell a position the model already rates as
   * decided, shortly before the window closes, so the proceeds are back in
   * collateral in the same tick. `redeem` below is the sweeper that collects
   * whatever the exit could not act on.
   */
  exit: {
    enabled: bool('EXIT_ENABLED', true),
    // Band in which an exit may fire. The upper bound is when we start trying;
    // the lower bound leaves room for the order round trip *and* for the freed
    // balance to be read by the next entry — which is the entire point.
    maxSecondsToExpiry: num('EXIT_MAX_SECONDS_TO_EXPIRY', 45),
    minSecondsToExpiry: num('EXIT_MIN_SECONDS_TO_EXPIRY', 10),
    // Only sell what the model considers decided. Below this the position is
    // still a live bet and selling it is just paying the spread.
    minModelProb: num('EXIT_MIN_MODEL_PROB', 0.97),
    // Bid must be at least this (otherwise the market disagrees with the model)
    // and at most this (above it, holding for the $1.00 redemption beats selling).
    minSellPrice: num('EXIT_MIN_SELL_PRICE', 0.93),
    maxSellPrice: num('EXIT_MAX_SELL_PRICE', 0.995),
    // Never be the whole print: cap our size at this fraction of visible bid
    // depth. The endgame book on the decided side is often bid-only and thin.
    maxBidDepthParticipation: num('EXIT_MAX_BID_DEPTH_PARTICIPATION', 0.25),
    // Refuse an exit that would book less than this much profit on the shares
    // sold. 0 disables the floor (sell whenever the model is convinced).
    minProfitFloorUsd: num('EXIT_MIN_PROFIT_FLOOR_USD', 0),
    // Optional extra gate, same shape as the entry edge test. 0 disables.
    minNetEdge: num('EXIT_MIN_NET_EDGE', 0),
    // A SELL is a taker order too, and ORDER_TYPE already covers it; a separate
    // knob avoids surprising anyone who runs entries as GTC.
    orderType: env('EXIT_ORDER_TYPE', 'FAK'),
    maxAttemptsPerPosition: num('EXIT_MAX_ATTEMPTS', 3),
    retryCooldownSeconds: num('EXIT_RETRY_COOLDOWN_SECONDS', 3),
    tickSizeFallback: num('DEFAULT_TICK_SIZE', 0.01),
  },

  // ------------------------------------------------- relayer (gasless wallet)
  /**
   * Authorisation for the relayer. These are *Relayer API Keys*, created under
   * polymarket.com -> Settings -> API Keys -> Relayer API Keys. They are NOT the
   * CLOB credentials the bot derives for itself, and NOT Builder API keys —
   * though a Builder key/secret/passphrase is accepted as an alternative.
   */
  relayer: {
    url: env('RELAYER_URL', 'https://relayer-v2.polymarket.com'),
    apiKey: env('RELAYER_API_KEY', null),
    apiKeyAddress: addr('RELAYER_API_KEY_ADDRESS', null),
    builderApiKey: env('POLY_BUILDER_API_KEY', null),
    builderSecret: env('POLY_BUILDER_SECRET', null),
    builderPassphrase: env('POLY_BUILDER_PASSPHRASE', null),
    // How long a signed Deposit Wallet batch stays valid.
    deadlineSeconds: num('RELAYER_DEADLINE_SECONDS', 300),
    // Legacy proxy wallets (signature type 1) need a gas limit up front.
    proxyGasLimit: num('RELAYER_PROXY_GAS_LIMIT', 10000000),
  },

  // ----------------------------------------- trading approvals (on-chain)
  /**
   * Before an order can settle, the *account wallet* must have approved both
   * CLOB V2 exchanges to spend its pUSD (ERC-20) and its conditional tokens
   * (ERC-1155) on both V2 exchanges and both CTF collateral adapters (the
   * adapters so the redemption sweeper can convert winning shares back to pUSD).
   * For a Deposit Wallet / Safe / proxy
   * account those approvals cannot be granted by the signer EOA; they are
   * submitted as one gasless relayer batch (relayerClient.setupTradingApprovals).
   *
   * Missing approvals are the cause of "not enough balance / allowance" from
   * POST /order and of a zero allowance in the doctor. `npm run approve` grants
   * them by hand; with AUTO_APPROVE on the bot also grants them once at start-up
   * if it finds one missing.
   */
  approvals: {
    autoApprove: bool('AUTO_APPROVE', true),
  },

  // ---------------------------------------------------- redemption (sweeper)
  redeem: {
    enabled: bool('AUTO_REDEEM', true),
    // How often to sweep. 5 minutes matches the trading window, so a win that
    // the exit could not sell is back in collateral by the next few windows.
    everyMs: num('AUTO_REDEEM_EVERY_MS', 300000),
    // pUSD (via the V2 collateral adapters) is what the bot trades with.
    // 'usdce' redeems to legacy USDC.e instead.
    outputToken: env('REDEEM_OUTPUT_TOKEN', 'pUSD'),
    // Check `payoutDenominator > 0` on the CTF before submitting. Costs an RPC
    // read per condition; prevents spending submissions on unresolved markets.
    verifyOnChain: bool('REDEEM_VERIFY_ONCHAIN', true),
    // Skip redemptions worth less than this; they stay queued and are swept
    // together with a later batch.
    minValueUsd: num('REDEEM_MIN_VALUE_USD', 0),
    maxPerRun: num('REDEEM_MAX_PER_RUN', 25),
    pollMax: num('REDEEM_POLL_MAX', 20),
    pollMs: num('REDEEM_POLL_MS', 2000),
  },

  // ----------------------------------------------------------- runtime modes
  runtime: {
    port: num('PORT', 3000),
    paperMode: bool('PAPER_MODE', true),
    requireGeoblockPass: bool('REQUIRE_GEOBLOCK_PASS', true),
    dryRunOrders: bool('DRY_RUN_ORDERS', false),  // sign but don't POST
    loopMs: num('LOOP_MS', 750),
    discoveryMs: num('DISCOVERY_MS', 10000),
    stateFile: env('STATE_FILE', 'bot_state.json'),
    // A streamed book older than this is refetched from REST before it is used
    // for a price/edge decision (the stream only replaces it on an event, so a
    // quiet market can otherwise leave a stale snapshot in memory).
    maxBookAgeMs: num('MAX_BOOK_AGE_MS', 5000),
    referenceSource: env('REFERENCE_SOURCE', 'auto'), // auto | polybolt | spot
    logLevel: env('LOG_LEVEL', 'INFO'),
  },

  // -------------------------------------------------------- reference prices
  reference: {
    coinbaseWs: 'wss://ws-feed.exchange.coinbase.com',
    krakenWs: 'wss://ws.kraken.com',
    coinbaseProduct: env('COINBASE_PRODUCT', 'BTC-USD'),
    krakenPair: env('KRAKEN_PAIR', 'XBT/USD'),
    twapWindowSeconds: num('TWAP_WINDOW_SECONDS', 60),
    // Floor on per-second volatility so the normal CDF never divides by zero.
    minVolPerSec: num('MIN_VOL_PER_SEC', 0.02), // USD per sqrt(second)
    // How long after a window opens the bot may still stamp the live TWAP as
    // that window's price to beat. Bigger = more windows are tradeable after a
    // restart, but the stamped value drifts further from the true open (the
    // model would then be anchored to the wrong instant). 0 disables stamping.
    windowOpenGraceSeconds: num('WINDOW_OPEN_GRACE_SECONDS', 30),
    volatilityLookbackSeconds: num('VOL_LOOKBACK_SECONDS', 300),
  },
};

// ------------------------------------------------------- entry-floor resolution
/**
 * A module's `minEntrySecondsLeft` can never trade below the account-wide
 * `MIN_SECONDS_TO_EXPIRY` — `StrategyEngine.preflight()` clamps it with
 * `Math.max(module, floor)`. The shipped default for Stale-Quote Snipe was 8s
 * against a 10s floor, so the setting was dead on arrival: the module's
 * advertised final-8-seconds window silently became final-10, and the only hint
 * was a startup warning.
 *
 * Resolve the clamp here instead, once, at load. An unset value follows the
 * account floor automatically, so lowering MIN_SECONDS_TO_EXPIRY to 6 widens SQS
 * to 6s rather than leaving it pinned at a stale hard-coded number. A value the
 * operator set explicitly below the floor is still raised — the account floor is
 * a hard safety limit, not a suggestion — but that is reported rather than
 * applied silently.
 */
const ENTRY_FLOOR_ENV = {
  twapMomentum: 'TWAP_MOMENTUM_MIN_LEFT',
  fairValueEv: 'FV_MIN_LEFT',
  microstructure: 'MS_MIN_LEFT',
  rsiReversion: 'RSI_MIN_LEFT',
  crossExchange: 'XEX_MIN_LEFT',
  volatilityBreakout: 'VB_MIN_LEFT',
  staleQuoteSnipe: 'SQS_MIN_LEFT',
  makerReversion: 'MR_MIN_LEFT',
};
const HARD_CODED_ENTRY_FLOOR_DEFAULTS = {
  twapMomentum: 45, fairValueEv: 40, microstructure: 60, rsiReversion: 60,
  crossExchange: 60, volatilityBreakout: 90, staleQuoteSnipe: 8, makerReversion: 45,
};
/** Names whose entry floor was raised by the account floor rather than chosen. */
const entryFloorNotes = [];

/**
 * Raise any module entry floor that sits below the account-wide floor, and
 * record what happened.
 *
 * Exported (rather than being a load-time side effect only) so it can be
 * exercised on a config built by hand: "what happens if someone sets
 * SQS_MIN_LEFT=8" is a real question, and a global computed once from the live
 * process.env cannot answer it.
 *
 * @param {object} cfg
 * @param {Function} [envGet]  how to read the environment; defaults to process.env
 * @returns {Array} the notes produced for this config
 */
function resolveEntryFloors(cfg = CONFIG, envGet = (k) => process.env[k]) {
  const notes = [];
  const floor = Number(cfg.risk && cfg.risk.minSecondsToExpiry);
  if (!Number.isFinite(floor)) return notes;
  for (const [name, envKey] of Object.entries(ENTRY_FLOOR_ENV)) {
    const st = cfg.strategies && cfg.strategies[name];
    if (!st) continue;
    const before = Number(st.minEntrySecondsLeft);
    // Already resolved on an earlier pass (this function is called again by
    // configWarnings, and a config may be resolved once at load and again when a
    // clone is inspected). Rebuild the note from the provenance recorded on the
    // config so a second call still describes it accurately — otherwise the
    // warning silently disappears the moment anything re-checks the config.
    if (!(before < floor)) {
      if (Number.isFinite(st.minEntrySecondsLeftRequested)
          && st.minEntrySecondsLeftRequested < floor
          && st.minEntrySecondsLeftResolvedFrom) {
        const prior = {
          name, envKey,
          requested: st.minEntrySecondsLeftRequested,
          resolved: floor,
          explicit: !!st.minEntrySecondsLeftExplicit,
        };
        notes.push(prior);
        if (Number.isFinite(st.onlyLastSeconds) && st.onlyLastSeconds <= floor) {
          notes.push({ ...prior, closed: true, onlyLastSeconds: st.onlyLastSeconds });
        }
      }
      continue;
    }
    const raw = envGet(envKey);
    const explicit = raw !== undefined && raw !== null && String(raw).trim() !== '';
    st.minEntrySecondsLeft = floor;
    st.minEntrySecondsLeftResolvedFrom = explicit ? 'clamped' : 'account-floor';
    // Record the REQUESTED value and its provenance on the config itself.
    // `configWarnings()` cannot otherwise tell them apart: it may be handed a
    // clone built by a test or by /api/settings, in which case process.env says
    // nothing about where that 8 came from, and describing an operator's explicit
    // override as "it follows the account floor" would be exactly the kind of
    // misleading message this whole change exists to remove.
    st.minEntrySecondsLeftRequested = before;
    st.minEntrySecondsLeftExplicit = explicit;
    const note = { name, envKey, requested: before, resolved: floor, explicit };
    notes.push(note);
    // A snipe window that the account floor has squeezed to nothing is worse than
    // no window: the module would be enabled, evaluated every tick, and unable to
    // fire. Say so instead of leaving it to look like a market problem.
    if (Number.isFinite(st.onlyLastSeconds) && st.onlyLastSeconds <= floor) {
      notes.push({ ...note, closed: true, onlyLastSeconds: st.onlyLastSeconds });
    }
  }
  return notes;
}

entryFloorNotes.push(...resolveEntryFloors(CONFIG));

// Sanity checks that fail fast rather than producing silently wrong orders.
function validateConfig(cfg = CONFIG) {
  const errs = [];
  const st = Number(cfg.wallet.signatureType);
  if (![0, 1, 2, 3].includes(st)) errs.push(`POLY_SIGNATURE_TYPE must be 0,1,2 or 3 (got ${cfg.wallet.signatureType})`);
  if (st !== 0 && !cfg.wallet.funderAddress) {
    errs.push(`POLY_FUNDER_ADDRESS (your Polymarket account wallet) is required for signature type ${st}`);
  }
  if (cfg.wallet.funderAddress && !/^0x[0-9a-fA-F]{40}$/.test(cfg.wallet.funderAddress)) {
    // Anything that reached here unnormalised is not an address at all.
    errs.push(`POLY_FUNDER_ADDRESS is not a 20-byte address: ${cfg.wallet.funderAddress}`);
  }
  if (st !== 0 && cfg.wallet.funderAddress && cfg.wallet.privateKey) {
    // Not an error, but a very common and expensive mistake: the funder is the
    // account wallet, NOT the signer EOA.
    const signer = require('ethers').Wallet ? null : null; // checked at runtime in auth
    void signer;
  }
  if (cfg.order.stakeUsd <= 0) errs.push('TRADE_SIZE_USD must be > 0');
  if (cfg.order.maxStakeUsd < cfg.order.stakeUsd) errs.push('MAX_TRADE_SIZE_USD must be >= TRADE_SIZE_USD');
  if (cfg.fees.maxTakerRate < cfg.fees.defaultTakerRate) errs.push('MAX_TAKER_FEE_RATE must be >= DEFAULT_TAKER_FEE_RATE');
  if (cfg.risk.maxSpreadCents <= 0) errs.push('MAX_SPREAD_CENTS must be > 0');

  // An exit band with no width inside it silently disables capital recycling,
  // which is the one failure mode this whole subsystem exists to prevent.
  if (cfg.exit && cfg.exit.enabled) {
    const lo = cfg.exit.minSecondsToExpiry;
    const hi = cfg.exit.maxSecondsToExpiry;
    if (!(hi > lo)) {
      errs.push(`EXIT_MAX_SECONDS_TO_EXPIRY (${hi}) must be greater than EXIT_MIN_SECONDS_TO_EXPIRY (${lo}) — `
        + 'otherwise no exit can ever fire and wins stay locked as unredeemable tokens');
    }
    if (!(cfg.exit.minModelProb > 0.5 && cfg.exit.minModelProb <= 1)) {
      errs.push(`EXIT_MIN_MODEL_PROB must be in (0.5, 1] (got ${cfg.exit.minModelProb}) — `
        + 'at or below 0.5 the bot would sell positions it thinks are losing');
    }
    if (!(cfg.exit.minSellPrice > 0 && cfg.exit.minSellPrice < cfg.exit.maxSellPrice)) {
      errs.push(`EXIT_MIN_SELL_PRICE (${cfg.exit.minSellPrice}) must be > 0 and below EXIT_MAX_SELL_PRICE (${cfg.exit.maxSellPrice})`);
    }
    if (cfg.exit.maxSellPrice >= 1) {
      errs.push(`EXIT_MAX_SELL_PRICE must be < 1.00 (got ${cfg.exit.maxSellPrice}) — a share is never worth more than $1`);
    }
    if (!(cfg.exit.maxBidDepthParticipation > 0 && cfg.exit.maxBidDepthParticipation <= 1)) {
      errs.push(`EXIT_MAX_BID_DEPTH_PARTICIPATION must be in (0, 1] (got ${cfg.exit.maxBidDepthParticipation})`);
    }
  }
  if (cfg.redeem && cfg.redeem.enabled) {
    const ot = String(cfg.redeem.outputToken).toLowerCase();
    if (ot !== 'pusd' && ot !== 'usdce') {
      errs.push(`REDEEM_OUTPUT_TOKEN must be 'pUSD' or 'usdce' (got ${cfg.redeem.outputToken})`);
    }
    if (!(cfg.redeem.everyMs >= 5000)) {
      errs.push(`AUTO_REDEEM_EVERY_MS must be >= 5000 (got ${cfg.redeem.everyMs}) — the relayer rate-limits and each sweep costs submissions`);
    }
  }

  // A maker module whose quote can never rest is worse than no maker module:
  // it would be evaluated every tick and place orders that are cancelled in
  // the same breath.
  const mr = cfg.strategies && cfg.strategies.makerReversion;
  if (mr && mr.enabled) {
    if (!(mr.maxQuotePrice > 0 && mr.maxQuotePrice < 1)) {
      errs.push(`MR_MAX_QUOTE_PRICE must be in (0, 1) (got ${mr.maxQuotePrice})`);
    }
    if (!(mr.restSeconds > 0)) {
      errs.push(`MR_REST_SECONDS must be > 0 (got ${mr.restSeconds}) — a quote cancelled the instant it is placed is a taker order with extra steps`);
    }
    const usable = Number(mr.minEntrySecondsLeft) - Number(cfg.risk.minSecondsToExpiry) - Number(mr.cancelBufferSeconds);
    if (Number.isFinite(usable) && usable <= 0) {
      errs.push(`makerReversion can never place a resting quote: MR_MIN_LEFT=${mr.minEntrySecondsLeft}s `
        + `- MIN_SECONDS_TO_EXPIRY=${cfg.risk.minSecondsToExpiry}s - MR_CANCEL_BUFFER=${mr.cancelBufferSeconds}s `
        + `leaves ${usable}s. Raise MR_MIN_LEFT or lower the buffer`);
    }
    if (!(mr.minDislocation > 0)) {
      errs.push(`MR_MIN_DISLOCATION must be > 0 (got ${mr.minDislocation}) — quoting at fair value is how a maker turns into a warehouse`);
    }
  }
  return errs;
}

/**
 * Non-fatal configuration notes. These are not errors — the bot runs — but each
 * one changes what a setting actually means, so they are logged at startup and
 * exposed on /api/health rather than left for the operator to discover.
 */
function configWarnings(cfg = CONFIG) {
  const out = [];
  const floor = cfg.risk.minSecondsToExpiry;
  // Entry floors are resolved at load (see resolveEntryFloors), so this no longer
  // reports a clamp the engine is about to apply behind your back — it reports
  // what the value became, and why.
  // Recomputed per call so a hand-built or cloned config is described accurately
  // rather than inheriting the notes from whatever the live process.env produced.
  const notes = cfg === CONFIG ? entryFloorNotes : resolveEntryFloors(cfg);
  for (const note of notes) {
    if (note.closed) {
      // `note.envKey` is the FLOOR knob (e.g. SQS_MIN_LEFT); the window knob that
      // has to be raised is SQS_LAST_SECONDS. Naming the wrong one here would send
      // the operator round in circles.
      out.push(`${note.name}: its window is the final ${note.onlyLastSeconds}s but MIN_SECONDS_TO_EXPIRY=${floor}s `
        + `means it can never trade — raise SQS_LAST_SECONDS above ${floor}s, or lower MIN_SECONDS_TO_EXPIRY`);
      continue;
    }
    out.push(note.explicit
      ? `${note.envKey}=${note.requested}s is below MIN_SECONDS_TO_EXPIRY=${floor}s — resolved to ${floor}s. `
        + `The account floor is a hard limit; lower MIN_SECONDS_TO_EXPIRY if you want ${note.name} to trade closer to expiry`
      : `${note.name} trades from ${floor}s before close (it follows MIN_SECONDS_TO_EXPIRY, so the two can never disagree)`);
  }
  // Still catch a floor injected after load (tests, /api/settings, a hand-built
  // config object) that the load-time resolution could not have seen.
  for (const [name, st] of Object.entries(cfg.strategies || {})) {
    if (Number.isFinite(st.minEntrySecondsLeft) && st.minEntrySecondsLeft < floor) {
      out.push(`${name}.minEntrySecondsLeft=${st.minEntrySecondsLeft}s is below MIN_SECONDS_TO_EXPIRY=${floor}s `
        + `— the module will stand down at ${floor}s, not ${st.minEntrySecondsLeft}s`);
    }
  }
  const grace = cfg.reference.windowOpenGraceSeconds;
  if (Number.isFinite(grace) && grace > 60) {
    out.push(`WINDOW_OPEN_GRACE_SECONDS=${grace}s: the price to beat is stamped up to ${grace}s after the window opens, `
      + `so the model is anchored to a later instant than the market's own open`);
  }
  // MIN_NET_EDGE used to be enforced twice — once per module at the ask, once at
  // execution at ask + MAX_SLIPPAGE_CENTS — so a signal could fire and place
  // nothing. Both callers now share pricing.entryEdgeTest(), one test at the
  // executable price. What is still worth saying is which threshold binds.
  if (cfg.order.maxSlippageCents > 0 && cfg.fees.minNetEdge > 0) {
    const shadowed = Object.entries(cfg.strategies || {})
      .filter(([, st]) => Number.isFinite(st.minNetEdge) && st.minNetEdge < cfg.fees.minNetEdge)
      .map(([name, st]) => `${name}=${st.minNetEdge}`);
    if (shadowed.length) {
      out.push(`MIN_NET_EDGE=${cfg.fees.minNetEdge} is a floor over every module's own edge gate, and it is higher than `
        + `${shadowed.join(', ')} — those module thresholds can never bind, so those modules effectively need `
        + `${cfg.fees.minNetEdge} of net edge at ask + ${cfg.order.maxSlippageCents}c. Lower MIN_NET_EDGE to let them trade thinner edges.`);
    }
  }
  // The exit band must sit inside the window the bot is still allowed to act
  // in. If EXIT_MIN_SECONDS_TO_EXPIRY is below the account-wide floor the exit
  // can be scheduled for a moment the entry path already refuses to trade.
  if (cfg.exit && cfg.exit.enabled) {
    if (cfg.exit.minSecondsToExpiry < cfg.risk.minSecondsToExpiry) {
      out.push(`EXIT_MIN_SECONDS_TO_EXPIRY=${cfg.exit.minSecondsToExpiry}s is below MIN_SECONDS_TO_EXPIRY=`
        + `${cfg.risk.minSecondsToExpiry}s — exits will only fire from ${cfg.risk.minSecondsToExpiry}s, narrowing the band`);
    }
    if (cfg.exit.maxSecondsToExpiry >= (cfg.market.windowSeconds[(cfg.market.timeframes || [])[0]] || 300)) {
      out.push(`EXIT_MAX_SECONDS_TO_EXPIRY=${cfg.exit.maxSecondsToExpiry}s is at or beyond the whole window — `
        + 'the exit gate would be open from the moment the position is filled');
    }
  }
  // Both mechanisms off means nothing ever returns capital to the balance.
  if (cfg.exit && !cfg.exit.enabled && cfg.redeem && !cfg.redeem.enabled) {
    out.push('EXIT_ENABLED=false and AUTO_REDEEM=false: nothing converts wins back into tradeable collateral. '
      + 'In live mode the bot will drain its balance and then stop trading while realised P&L keeps rising.');
  }
  /**
   * Passive Reversion is the one module whose execution style is not the
   * configured ORDER_TYPE. Say so, because "I set ORDER_TYPE=FAK" is a
   * reasonable thing to believe and it does not apply here.
   */
  const mr = cfg.strategies && cfg.strategies.makerReversion;
  if (mr && mr.enabled) {
    out.push(`makerReversion rests post-only GTD bids, so ORDER_TYPE=${cfg.order.orderType} does not apply to it `
      + `(it always uses GTD + postOnly=${mr.postOnly ? 'true' : 'false'}). Makers are never charged the taker fee on `
      + 'Polymarket, so its edge is measured without one.');
    if (mr.postOnly === false) {
      out.push('MR_POST_ONLY=false: a quote that crosses the spread will execute as a taker and be charged the '
        + '0.07 crypto fee, while the edge gate still measured the trade as fee-free');
    }
    // While a quote rests it is an open position, so MAX_OPEN_POSITIONS=1
    // parks the rest of the book for the duration. That is a real cost and it
    // is the operator's call, not something to discover from a quiet dashboard.
    const usable = Number(mr.maxEntrySecondsLeft) - Number(cfg.risk.minSecondsToExpiry) - Number(mr.cancelBufferSeconds);
    if (Number.isFinite(usable) && Number(mr.restSeconds) > usable) {
      out.push(`MR_REST_SECONDS=${mr.restSeconds}s exceeds the ${usable}s the module's widest entry window allows — `
        + 'quotes will be cut short by the cancel deadline');
    }
    if (cfg.risk.maxOpenPositions <= 1) {
      out.push(`makerReversion holds an open position while a quote rests (up to ${mr.restSeconds}s), and `
        + `MAX_OPEN_POSITIONS=${cfg.risk.maxOpenPositions} — no other module can trade in that window during the rest`);
    }
  }
  if (cfg.redeem && cfg.redeem.enabled && !cfg.relayer.apiKey && !cfg.relayer.builderApiKey) {
    out.push('AUTO_REDEEM=true but no RELAYER_API_KEY (and no Builder key) is set — the redemption sweeper cannot '
      + 'authorise a transaction and will report itself not-ready. Create one under polymarket.com → Settings → '
      + 'API Keys → Relayer API Keys, or rely on EXIT_ENABLED alone plus the UI auto-redeem toggle.');
  }
  return out;
}

/**
 * Where the bot persists its state. Mirrors BotCore's own resolution: a relative
 * STATE_FILE resolves against the project dir, an absolute one is honoured as-is
 * (path.join would graft an absolute path onto __dirname).
 */
function resolveStateFile(cfg = CONFIG) {
  const f = cfg.runtime.stateFile;
  return path.isAbsolute(f) ? f : path.join(__dirname, f);
}

/**
 * The paper/live mode the bot will ACTUALLY run in.
 *
 * cfg.runtime.paperMode is only the PAPER_MODE default. BotCore's constructor
 * calls loadState(), and a saved state file overrides it — so the two can
 * disagree. Every place that reports the mode to an operator must call this
 * rather than read the config value: a banner that says PAPER over a bot
 * trading live money is worse than no banner at all.
 *
 * Returns { paperMode, source } where source is 'env' or the state file name.
 */
function effectivePaperMode(cfg = CONFIG) {
  const fallback = !!cfg.runtime.paperMode;
  try {
    const file = resolveStateFile(cfg);
    if (!fs.existsSync(file)) return { paperMode: fallback, source: 'env', file };
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved.paperMode === 'boolean') {
      return { paperMode: saved.paperMode, source: saved.paperMode === fallback ? 'env' : path.basename(file), file };
    }
  } catch (_) { /* an unreadable state file must not break a pre-flight check */ }
  return { paperMode: fallback, source: 'env', file: resolveStateFile(cfg) };
}

module.exports = { CONFIG, validateConfig, configWarnings, env, num, bool, addr, resolveEntryFloors, entryFloorNotes, ENTRY_FLOOR_ENV, HARD_CODED_ENTRY_FLOOR_DEFAULTS, resolveStateFile, effectivePaperMode, envFile: { path: ENV_FILE, loaded: !envLoad.error } };
