# Patch notes — v1 → v2

What was wrong with the original `poly-updown-bot`, and what this version does
instead. The audit evidence (live endpoint probes) is in
`../polymarket-compatibility-audit.md`.

---

## 1. Missing infrastructure (v1 had none of this)

| Requirement | v1 | v2 |
|---|---|---|
| Market data WebSocket | absent — REST polled every 2.5s | `wsMarket.js`: `/ws/market`, snapshot + delta book, `PING`/`PONG` every 10s, backoff reconnect, `tick_size_change`, `market_resolved` |
| Private WebSocket | absent | `wsUser.js`: `/ws/user` with in-frame L2 auth, condition-id subscriptions, `order`/`trade` fill reconciliation |
| L1 auth | absent | `polymarketAuth.js`: EIP-712 `ClobAuth` → `/auth/derive-api-key` (fallback `POST /auth/api-key`) |
| L2 auth | absent | HMAC-SHA256 over `ts+METHOD+path+body`, URL-safe base64 with padding, `POLY_*` headers |
| Order signing | absent | `orderSigner.js`: EIP-712 `Order` on `Polymarket CTF Exchange` v2, standard + neg-risk exchanges, ERC-7739 wrapper for Deposit Wallets |
| Order submission | **fake** — logged "submitting" and pushed an array entry | real `POST /order`, status handling (`live`/`matched`/`delayed`), fill reconciliation, remainder cancellation |
| Settlement | guessed from spot vs entry | `market_resolved` event → layered REST resolver → *never* guesses |

## 2. `botCore.js` — live mode actually trades now

- **v1:** `executeTrade()` in live mode had a comment `// Simulating / executing signed order` and no HTTP call. Live P&L was fiction.
- **v2:** full path — geoblock → credentials → balance/allowance → sizing → sign → submit → reconcile → cancel → settle. Partial fills are tracked; `POST /api/positions/:id/cancel` cancels resting orders.
- Positions are **persisted and reconciled on restart**; a fill that completed while the process was down is recovered instead of orphaned.
- **v1** settled by comparing current spot to entry spot (and often failed to find the market at all, inventing a winner). **v2** settles from the exchange's resolution event, with Gamma-by-slug → Gamma-by-condition → CLOB fallbacks, and leaves anything unresolved flagged `UNRESOLVED`.

## 3. Strategies — 8 modules rebuilt

The original traded Coinbase/Kraken **spot**; these markets settle on the **60-second
Chainlink TWAP** (`cryptoMarketConfig: {twapEnabled: true, twapLookbackSeconds: 60}`).
Full derivations in `STRATEGIES.md`.

| # | Module | Fix |
|---|---|---|
| 1 | TWAP Momentum *(was Latency Exploitation)* | trades TWAP-vs-price-to-beat in σ units, not single spot prints |
| 2 | Late Window Convergence | adds an `ask ≤ 0.95` cap so the taker fee can't eat the edge |
| 3 | Book Microstructure | imbalance now requires model agreement (flow is a trigger, not a thesis) |
| 4 | RSI Reversion | RSI extreme only fires when the TWAP model confirms |
| 5 | Fair-Value EV | model is now TWAP-based; edges are **net of the 7% crypto taker fee** |
| 6 | Cross-Venue Divergence | divergence is gated by the model; outcome from the fresher venue |
| 7 | Volatility Breakout | requires ≥90s remaining so the move can reach the closing average |
| 8 | Stale-Quote Snipe | fee-aware; requires ≥8s left to fill/cancel cleanly |

All eight now share: minimum 5-share sizing, tick conformance, spread/depth gates,
`MAX_BUY_PRICE`, concurrency caps, cooldown, and a **1.5× threshold penalty in
degraded (proxy-TWAP) mode**.

## 4. Pricing and fees (new: `pricing.js`)

- `fairProbUp()` implements the Brownian-average TWAP model.
- `feePerShare()` implements the published `fee = C · rate · p · (1−p)` schedule (crypto `rate = 0.07`).
- `breakEvenProb()`, `expectedValue()`, `kellyStake()` are all fee-inclusive.
- `VolatilityTracker` supplies per-second volatility, RSI, momentum, σ-bands and the
  time-weighted trailing TWAP used as the fallback settlement series.

## 5. Minimum order size

- **v1:** README and UI claimed a "$1.00 minimum"; the default $2 stake was **rejected above ~40¢** because the real constraint is **5 shares** (`orderMinSize: 5`, `min_order_size: "5"`).
- **v2:** reads the live book's `min_order_size`, sizes accordingly, and either **bumps** the stake to the smallest valid order (`MIN_ORDER_POLICY=bump`, logged) or **skips** (`skip`). `/api/quote` explains the maths before you commit.

## 6. Asset identifiers

- **v1:** `clobTokenIds[0]` = Up, `[1]` = Down, positionally, with no verification.
- **v2:** outcomes are matched by **label** (`Up`/`Down`) and the mapping is validated; markets that fail validation are marked `tokenMappingOk: false` and **will not be traded**. Condition IDs are now used for the user-channel subscriptions, which v1 couldn't do at all.

## 7. Auth/wallet correctness

- v1 defaulted `funderAddress` to the **signer** address — wrong for every Magic
  Link/Google/proxy account, and orders would be rejected for `not enough balance / allowance`.
- v2 requires an explicit account wallet for types 1/2/3, **refuses to trade** when the funder equals the signer, supports the current wallet types (0 EOA / 1 Proxy / 2 Safe / 3 Deposit Wallet, the last being the default since 2026-05-04) and checks the **allowance**, not just the balance.
- Balance lookups use the CLOB's own `/balance-allowance` (what the exchange debits), with an on-chain pUSD/USDC.e fallback. v1 read USDC.e only — the protocol's collateral is now **pUSD**.

## 8. Reference prices (new: `referencePrice.js`)

- **Primary:** PolyBolt `wss://ws-live-v2.polymarket.com/ws`, authenticated with your CLOB credentials, subscribed to `price.crypto.twap` — the actual Chainlink 60s TWAP series. Handles the documented `{v,channel,seq,snapshot,dropped,payload}` frames, prefers `full_accuracy_value`, honours server pings and the 4001/4002/4003/4008 close codes.
- **Fallback:** Coinbase + Kraken spot with a genuinely **time-weighted** 60s average (v1's "window open" was just a spot snapshot). Every signal derived from the fallback is flagged `degraded` and traded at 1.5× thresholds.
- The dashboard shows which series is live, plus the current price-to-beat.

## 9. Safety and hygiene

- **Geoblock preflight** (`GET polymarket.com/api/geoblock`); `REQUIRE_GEOBLOCK_PASS=true` by default.
- **Circuit breakers:** stop-loss, take-profit, **daily loss cap**, cooldown, per-window trade cap, max open positions.
- **CORS:** v1 shipped `app.use(cors())` on an API that accepts a private key. v2 binds to `127.0.0.1` and only widens CORS when `DASHBOARD_ORIGIN` is set.
- State file records open positions and is reconciled on restart.
- `npm run doctor` validates everything end-to-end, and `npm run test:all` (108 unit + 11 integration tests) covers signing, tick maths, sizing, fees, the model, strategy gating, restart persistence and every settlement path.

## 9b. v2.1 — the daily loss cap is a setting, not a hidden constant

The daily cap **stopped the bot correctly**, but the dashboard gave no way to see
or change it: it read `MAX_DAILY_LOSS_USD` from the environment, had no settings
key, no input, and was not persisted. The "Risk Circuit Breaker" tile and input
both drove the *cumulative* stop-loss, so a user who set `-$300` still got
stopped by a `-$50` cap and reasonably read it as "my rule was ignored".

- `maxDailyLossUsd` is now a first-class setting: `SETTING_ALIASES` entry,
  settings handler, instance field, persistence, and validation.
- Both breakers are labelled, displayed and documented separately, with a
  "remaining today" tile and progress bar.
- Stop messages name the counter **and** the limit, and say "UTC day".
- A stopped banner surfaces `stoppedReason` in the UI (it was log-only) and
  explains what to do next.
- `Math.abs()` on both loss limits: typing `-300` used to become a **$1** breaker.
- `getState()` exposes `maxDailyLossUsd`, `dailyLossPct`, `dailyLossResetAtUtc`.

Details and the reproduction: `DAILY-LOSS-FIX.md`. Run `node proof.js` to see the
old vs new behaviour side by side.

## 10. Still on you

- **Redemption:** after a win, shares pay $1.00 but must be redeemed on-chain (or via the relayer) to realise USDC. The bot logs a reminder at settlement.
- **Latency:** time-sensitive modules need a host near Polymarket's `eu-west-2` infrastructure. Co-location is available only to traders operating their own account (and is gated by KYC/KYB); Builder Program participants are excluded.
- **Polymarket US** is a different venue with a different API, 15m/60m windows, BRTI settlement and whole-contract orders. This bot targets the global platform only.

## 11. v2.2 — fixes from the Stale-Quote-Snipe investigation

Six defects found while measuring whether strategy 8 can fire in a live run are
fixed, with regression tests: honest time-floor reporting, "no offer" vs "above
the cap", per-side spread/depth gates, a live clock, explicit mid-window-start
messaging, and a skip reason for every signal that fires but does not trade. See
`FIXES-2.2.md`.
