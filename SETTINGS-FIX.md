# Fix: dashboard settings were silently ignored

Two rounds of fixes. Both had the same shape: the dashboard posted a value and
the server never read it, with no error anywhere.

---

# Part 1 — strategy module toggles (8 modules)

**Symptom:** all 8 toggles did nothing; the switch visually snapped back on the
next poll.

### Bug 1 — `updateConfig()` could never turn anything OFF (all 8)

The dashboard posts objects:

```js
{ strategies: { fairValueEv: { enabled: false }, ... } }
```

`updateConfig()` did:

```js
this.strategies[key].enabled = !!val;   // val = { enabled: false }
```

`!!{...}` is `true` for *any* object — including `{ enabled: false }`. Every
toggle, on or off, wrote `true`. Disabling was impossible.

**Fix:** unwrap the object explicitly; accept the boolean form too.

### Bug 2 — three keys matched no module (3 of 8)

| Dashboard sent | Engine registered |
|---|---|
| `latencyExploit` | `latencyExploitation` |
| `microstructureEdges` | `microstructure` |
| `crossExchangeDivergence` | `crossExchange` |

`if (this.strategies[key])` was false, so they were dropped silently.

**Fix:** `STRATEGY_ALIASES` + `resolveStrategyKey()` normalise every incoming
key; unrecognised keys are returned in `{ applied, unknown }` and logged.
Same table now makes `config.strategies.twapMomentum` drive `latencyExploitation`
(it was previously an orphan read by nothing).

### Also

- Toggles weren't persisted — every restart re-enabled all 8. Now saved to
  `bot_state.json`.
- Per-module stats (`evaluated`/`fired`/`lastReason`) were collected but never
  rendered. Each row now shows live counters and its last decision reason, dims
  and strikes through when disabled, and the card header shows `n/8 enabled`.
- New `ENABLE_STRAT_*` env vars for all 8 modules (startup toggles).

---

# Part 2 — risk & order parameters

**Symptom:** stake, stop-loss, max trade cap and Kelly appeared not to change.

Audit of what the dashboard sends vs what the server read:

| Control | Dashboard sent | Server read | Status before fix |
|---|---|---|---|
| Dollar Amount Per Trade | `tradeAmountUsd` | `tradeAmountUsd` | ✅ applied, ❌ **never re-synced to the input** |
| Stop-Loss Circuit Breaker | `stopLossThresholdUsd` | `stopLossUsd` | ❌ **silently ignored — never changed** |
| Kelly Sizing | `kellySizing` | `kellySizing` | ✅ worked |
| Max Trade Cap | `maxTradeAmountUsd` | `maxTradeAmountUsd` | ✅ worked |
| Market Target Filter | `selectedMarketSlug` | *(no handler)* | ❌ **silently ignored — dead control** |
| Timeframe (5m/15m/all) | `selectedTimeframe` | *(no handler)* | ❌ **silently ignored — dead control** |

### Why the working ones *looked* broken

Only Kelly and the max-trade cap were ever written back from server state. The
stake and stop-loss inputs kept the hardcoded HTML defaults (`value="2.00"` and
`value="25.00"`) no matter what the bot was actually using — so they never
reflected a saved value and appeared to reset on reload.

### Fixes

1. **Stop-loss key mismatch.** A `SETTING_ALIASES` registry resolves every
   incoming key, so `stopLossThresholdUsd` and `stopLossUsd` both work — the
   same defence that now protects the strategy keys.
2. **Timeframe now works.** Sets `cfg.market.timeframes` (with `all` expanded by
   discovery) and re-runs `refreshMarkets()` so the market list and WebSocket
   subscriptions follow. Validated against `timeframesAll`; invalid values are
   refused.
3. **Market Target Filter now works.** `marketFilterSlug` pins the trading loop
   to one market instead of "closest to expiry". If the pinned market has no
   tradeable window, the bot says so in `lastSkipReason` rather than doing
   nothing silently.
4. **Every control is synced from server state** (stake, stop-loss, max cap,
   Kelly, timeframe, market filter), skipping whichever field currently has
   focus so it can't fight your typing. `<select>` values are only applied when
   a matching `<option>` exists — otherwise the control silently blanks.
5. **Numbers are validated.** A half-typed or non-numeric field is refused and
   reported, instead of writing `NaN` into a live risk limit.
6. **Rejections are visible.** Anything not applied comes back in
   `state.settingsChanges.unapplied` and is shown in a red banner in the Risk
   card, and logged server-side. Silent breakage is no longer possible.
7. **Absolute `STATE_FILE` paths are honoured.** `path.join(__dirname, ...)`
   grafted an absolute path onto the project directory, so state was written
   somewhere the user never specified. Absolute paths are now used verbatim.
8. All six settings persist across restarts.

## Files changed

| File | Change |
|---|---|
| `strategyEngine.js` | `STRATEGY_ALIASES` + `resolveStrategyKey()`; correct object/boolean handling in `updateConfig()`; `applied`/`unknown` reporting; `setEnabled()`, `enabledMap()`, `setEnabledMap()` |
| `botCore.js` | `SETTING_ALIASES` registry; rewritten `updateSettings()` with validation + reporting; timeframe and market-filter support; market filter honoured in `tick()`; persist all six; absolute `STATE_FILE`; strategy toggles persisted |
| `config.js` | `ENABLE_STRAT_*` env toggles |
| `public/index.html` | canonical keys; sync all six controls; per-module live stats; disabled styling; `n/8 enabled` badge; "not applied" warning banner; `escapeHtml()` |
| `test/unit.test.js` | +22 regression tests (75 total) |

## Verification

`npm run test:all` → **75 unit + 9 integration, 0 failures.**

Live against the running API:

- The exact old dashboard payload (including `stopLossThresholdUsd`) now applies
  all six fields; `unapplied` is empty.
- `stopLossUsd: 'abc'` → refused, previous value retained, reported.
- `selectedTimeframe: '7m'` → refused with `not one of all|5m|15m`.
- `maxTradeAmountUsd` below the stake → clamped up to the stake.
- Unknown key → reported in `unapplied`, not dropped.
- All six settings survive a restart (verified `12.5 / 30 / 33 / true / 15m /
  some-slug` restored, and the startup banner switching to `BTC 15m`).

---

# Part 3 — the settlement (TWAP) feed

Investigated while explaining the dashboard's `SPOT PROXY (degraded)` badge.

### What the badge means

The badge reflects `feeds.twapAuthoritative` / `feeds.twapSource`. These markets
settle on the **60-second Chainlink TWAP**, not on spot BTC, and the bot has two
ways to know that number:

| Badge | Source | Meaning |
|---|---|---|
| `CHAINLINK 60s TWAP` (green) | `polybolt-twap60` | PolyBolt `price.crypto.twap` — the authoritative settlement series |
| `SPOT PROXY (degraded)` (amber) | `spot-proxy-twap60` | PolyBolt is not live; the bot substitutes its own 60s time-weighted average of blended Coinbase + Kraken spot |
| `NO TWAP` (amber) | `null` | Neither is available yet (no spot samples either) |

`twapIsAuthoritative()` additionally requires the PolyBolt value to be under
15s old, so a stalled authoritative feed correctly degrades.

### Consequences of degraded mode

`buildContext()` sets `degraded: !authoritative`, and `candidate()` then applies
`required = degraded ? minNetEdge * 1.5 : minNetEdge` — **every module demands
1.5× its normal net edge**, so the bot trades substantially less. That is the
intended conservative behaviour, not a fault, but paper results collected in
degraded mode are not representative.

The price-to-beat is the most exposed input: if a window opened before the bot
started, `W_open` is backfilled from spot (`spot-proxy-twap60@backfill`), which
is an approximation of an approximation.

### Bugs found and fixed

1. **PolyBolt never retried once credentials appeared.** `connectPolybolt()` was
   only reachable from `start()` and the socket `close` handler. A bot started
   before CLOB credentials existed bailed out immediately, created no socket,
   and — having no socket — could never hit the close handler. It sat in
   `SPOT PROXY (degraded)` **forever**, even after credentials were derived,
   until the process was restarted. Added `ensurePolybolt()`, called from the
   discovery cycle (every `DISCOVERY_MS`), so the authoritative feed picks itself
   up within ~10s. It deliberately does **not** retry after a `4001` (auth
   rejected), to avoid hammering the endpoint with bad credentials.
2. **The skip reason understated the bar in degraded mode.** `fairValueEv`
   reported `no side with ≥3.0c net edge` while actually requiring 4.5c. Now
   reports the threshold actually applied, tagged `(degraded: 1.5x)`.
3. **The badge had no explanation.** It now carries a `title` tooltip stating
   which series is in use, why, and the PolyBolt connection error.

### Diagnosing it

- **Run Diagnostics** → the `twap-feed` line prints the fallback source plus
  `feeds.polybolt.lastError`.
- `GET /api/state` → `feeds.polybolt` = `{connected, authed, lastError, dropped}`.

Most common cause: PolyBolt requires CLOB L2 credentials
(`auth.hasL2Credentials()`), so with no wallet configured it reports
`CLOB credentials unavailable — TWAP stream requires auth`. Other causes: a
`4001` auth rejection, `REFERENCE_SOURCE=spot` in `.env` (forces the proxy), or
egress blocked to `ws-live-v2.polymarket.com`.

---

# Part 4 — the other half of the risk card: the daily loss cap

Same shape as Parts 1 and 2, one layer deeper. The **daily cap** (`MAX_DAILY_LOSS_USD`)
did stop the bot — but it had no settings key, no dashboard input, and no
persistence, while the only control that *looked* like a circuit breaker drove the
cumulative stop-loss instead. An operator who set `-$300` therefore got stopped by
a hidden `-$50` env value and had no way to tell why.

Fixed in the same manner as the rest of this document: a `SETTING_ALIASES` entry
(`maxDailyLossUsd` + three aliases), a validated handler, persistence, separate
labelling in the UI, and a stop message that names the counter *and* the limit.
Full write-up: **`DAILY-LOSS-FIX.md`**.

## Test totals

92 unit + 11 integration, 0 failures (+12 unit and +2 integration for the daily cap).
