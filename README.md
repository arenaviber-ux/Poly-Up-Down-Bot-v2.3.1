# ⚡ Poly Up/Down Bot v2.3.1 — patched for real Polymarket trading

Automated trader for **Bitcoin Up/Down** windows on **polymarket.com** (the global
platform). This is a ground-up repair of the "Poly Up Down Bot" (v1) that was
audited and found not to work: v1 had no WebSockets, no order signing, no live
order path, and traded the wrong price series. See `PATCH-NOTES.md` for the
itemised diff against the original.

> **Legal first.** Polymarket restricts order placement by jurisdiction — Australia,
> the US, the UK, France, Germany, Canada (BC/ON/AB/QC), Singapore and others are
> "close-only": existing positions can be closed, new orders are rejected. Run this
> only from a jurisdiction where you are permitted to trade, and never as a way to
> route around a restriction. `npm run doctor` checks this for you before you trade.

---

## What this bot now does

| Capability | Status |
|---|---|
| CLOB **market WebSocket** (`ws-subscriptions-clob…/ws/market`) | ✅ snapshot + delta book, PING/PONG, reconnect, `market_resolved` |
| CLOB **user WebSocket** (`…/ws/user`) | ✅ in-frame L2 auth, condition-id subscriptions, order/trade fills |
| **L1 auth** (EIP-712 `ClobAuth` → `/auth/api-key` \| `/auth/derive-api-key`) | ✅ |
| **L2 auth** (`HMAC-SHA256(ts+METHOD+path+body)` → `POLY_*` headers) | ✅ |
| **EIP-712 order signing** on `Polymarket CTF Exchange` v2 | ✅ incl. neg-risk exchange and ERC-7739 wrapping for Deposit Wallets |
| **Live order path** (POST /order → reconcile → cancel remainder) | ✅ FAK/GTD, `deferExec`, post-only |
| **Settlement** from `market_resolved`, with a layered REST fallback | ✅ never guesses an outcome |
| **5-share minimum** enforcement (not "$1") | ✅ bump or skip, your choice |
| **Fee-aware** (crypto taker 0.07, peaks at 50c) | ✅ every edge is net of fees — and module 9 pays no fee at all, because the schedule is taker-only |
| **TWAP settlement model** (60s Chainlink TWAP vs price to beat) | ✅ real feed via PolyBolt, spot-proxy fallback labelled |
| Paper mode on the **real** book, fees and resolutions | ✅ |
| Geoblock preflight, stop-loss, daily loss cap, allowance checks | ✅ |
| 8 strategy modules rebuilt | ✅ see `STRATEGIES.md` |
| **9th module: Passive Reversion — the maker route** | ✅ v2.4, see `STRATEGIES.md` §9 |
| **Pre-expiry exit** — sells a model-decided position 10–45s before close | ✅ v2.3, see `CAPITAL-RECYCLING.md` |
| **On-chain redemption sweeper** — claims resolved wins via the gasless Relayer | ✅ v2.3, needs Relayer API keys |

---

## v2.4 — the ninth module makes instead of takes

Modules 1–8 are eight different triggers for one trade: buy a side at the ask.
That means every one of them pays Polymarket's crypto taker fee,
`0.07 · p · (1 − p)` — **up to 1.75¢ per share at 50¢**, which is the same size
as the 1–3¢ edges the modules chase. The fee is not a cost on the trade; on a
3¢ edge it *is* half the trade.

That fee schedule is `takerOnly`. Per Polymarket's own documentation: *"Makers
are never charged fees. Only takers pay fees."*, and 20% of the taker fees
collected in a market are redistributed daily to the makers quoting in it. So
the cheapest possible improvement to this bot is not a smarter trigger — it is
not taking.

**Module 9, Passive Reversion**, rests a **post-only bid inside the spread**,
one tick above the best bid, whenever the book has swung at least
`MR_MIN_DISLOCATION` (2¢) below what the TWAP model says the side is worth. It
is submitted `GTD` + `postOnly` for up to `MR_REST_SECONDS` (20s), and
`BotCore.managePassiveEntries()` re-prices it on **every tick** and pulls it the
moment the model stops supporting it — because a quote that no longer has an
edge is not liquidity provision, it is a standing offer to be picked off.

Two reasons it is the highest-value addition here:

* **It removes the largest term in the P&L, not a fraction of it.** At 50¢ the
  maker route is worth 1.75¢/share more than taking *at the same price*.
* **It is the only edge that is not a latency race.** As the honest-expectations
  section of `STRATEGIES.md` says, the momentum and divergence modules compete
  with co-located market makers; from a home connection you lose that race. A
  resting bid is filled because it is the best price on the book, not because
  it arrived first.

The risk is named and guarded: **adverse selection** — you are filled because
somebody chose your price. `MR_MIN_EDGE` is the premium charged for it (with no
fee to pay, the whole 1.5¢ threshold is insurance), `MR_MAX_QUOTE_PRICE` (85¢)
keeps the module away from near-certain outcomes where a fill is nearly always
toxic, and the module refuses to quote at all on the degraded spot-proxy feed.

Full mechanics, the guard table and the tuning notes: **`STRATEGIES.md` §9**.
Tests: `npm run test:maker`.

> One operational note: a resting quote counts as an open position, so with the
> shipped `MAX_OPEN_POSITIONS=1` nothing else trades in that window while it
> rests. `configWarnings()` says so at startup.

---

## v2.3 — capital recycling (read this before running live)

Up to v2.2 this bot could only ever **buy**, and a win was *booked*, not sold.
That is survivable in paper mode and **fatal in live mode**, because
`GET /balance-allowance` reports collateral only — winning shares are ERC-1155
conditional tokens that count toward neither the CLOB balance nor the on-chain
pUSD/USDC.e fallback. Every win therefore permanently removed capital from the
order path:

```
$100 float → win → 20 tokens → collateral ~$80 → win → … → collateral $0
  → botCore skips every order: "$5.00 needed, $0.00 available"
  → forever, while realizedPnl climbs and the dashboard looks healthy
```

With the shipped defaults that is roughly **4–20 unsettled wins** before the bot
goes quiet. Nothing errors, nothing stops — it just stops trading. Polymarket's
CLOB has no redemption endpoint (`py-clob-client` #139), and redemption must be
executed *by the wallet holding the tokens* (`conditional-token-examples-py` #1),
which is what the gasless Relayer is for.

v2.3 closes the loop with two mechanisms, both on by default:

| | What | When | Credentials |
|---|---|---|---|
| **Primary** | marketable SELL into measured bid depth | 10–45s before close, model ≥ 97% | none — same CLOB path as entries |
| **Backstop** | `redeemPositions` via the Relayer | 300s timer + queued after each live win | **Relayer** or Builder API keys |

Selling 20 shares at 99c nets **$19.786** against **$20.00** at resolution — you
give up ~1c/share (plus a 0.069c/share taker fee, because `rate × p × (1−p)`
vanishes at the extremes) to get 100% of the capital back one window early.
Positions are never deleted on exit; they accumulate `exitShares` /
`exitProceedsUsd` / `remainingShares` and settle normally, and a never-exited
position reduces exactly to the old `won ? filledShares : 0`.

> **Your CLOB credentials will not authorise the sweeper.** `POLY_API_KEY` /
> `POLY_API_SECRET` / `POLY_API_PASSPHRASE` are L2 order-signing keys. The
> Relayer needs its own keys from `polymarket.com → Settings → API Keys →
> Relayer API Keys`. Without them `AUTO_REDEEM` degrades loudly — one warning,
> `redeem.ready = false` with a reason, and the exit keeps working.

Full mechanics, every gate and refusal code, the three wallet signing schemas,
and the failure-mode table: **`CAPITAL-RECYCLING.md`**.

---

## v2.3.1 — two configuration defects that silently disabled things

Both were found by the bot's own `configWarnings()`, which correctly reported
that something was off but could not fix it. Both are now fixed rather than
warned about.

**1. One edge gate instead of two.** `MIN_NET_EDGE` was enforced twice, at two
different prices against two different thresholds:

| | price tested | threshold |
|---|---|---|
| strategy engine | best **ask** | the module's own `*_MIN_EDGE` |
| order path | ask **+ `MAX_SLIPPAGE_CENTS`** | the global `MIN_NET_EDGE` |

So a signal could fire and place nothing — the "`… fired but did not trade`"
log line. Worse, because the execution gate used the *global* threshold, any
module whose own gate was lower than `MIN_NET_EDGE` had that gate silently
overridden. Both callers now share `pricing.entryEdgeTest()`: one test, at the
executable price, against `max(module gate, MIN_NET_EDGE)`. A fired signal now
implies a placed order.

**2. `SQS_MIN_LEFT` resolved instead of clamped.** Stale-Quote Snipe shipped
with `minEntrySecondsLeft = 8` against an account floor of
`MIN_SECONDS_TO_EXPIRY = 10`, so the setting was dead on arrival — the
advertised final-8-seconds window was really final-10, and `StrategyEngine`
clamped it behind your back. An unset `*_MIN_LEFT` now **resolves to the account
floor at load**, so config and engine cannot disagree and lowering the floor to
6s actually widens the module to 6s. An explicitly-set value below the floor is
still raised (it is a hard safety limit) and still reported.

> **Consequence worth knowing.** With the shipped values, `MIN_NET_EDGE=0.015`
> is higher than `SQS_MIN_EDGE=0.01`, so Stale-Quote Snipe's own 1¢ gate can
> never bind — the one module written to trade a one-cent edge in the final
> seconds effectively needs 1.5¢. A 96.6% model at a 93¢ ask yields **1.27¢ at
> the executable price**, which does not trade. That is the global floor working
> as a floor, not a bug — but if you want SQS to do what it was written for, set
> `MIN_NET_EDGE=0.01` or `0`. `configWarnings()` now names the shadowed modules
> at startup instead of describing a double gate.

Test harness hardening came with this: an `await`ed test that returns a rejected
promise nobody awaits used to surface *after* the summary printed, so a run
could report `198 passed, 0 failed` and exit 0 while `executeSignal()` was
dying on a `ReferenceError` in the code under test. It did exactly that during
this change, and the summary was the only output. All four runners now fail the
run on an unhandled rejection or uncaught exception.

---

## Quick start

```bash
npm install
cp .env.example .env      # then edit it — section 1 is the only required part
npm run doctor            # checks config, wallet, geoblock, approvals, sockets, signing
npm run approve           # grants the exchange + adapter approvals (gasless, one time)
npm start                 # dashboard on http://127.0.0.1:3000
```

The bot starts in **paper mode**. Flip to live in the dashboard (or `PAPER_MODE=false`)
only after `npm run doctor` reports no blockers.

### Wallet setup (the part people get wrong)

Polymarket accounts use three wallet shapes. The bot signs with your **signer key**
but trades from your **account wallet**, and those are different addresses.

| Your account | `POLY_SIGNATURE_TYPE` | `POLY_FUNDER_ADDRESS` |
|---|---|---|
| EOA / imported key | `0` | your EOA address |
| Legacy Google / Magic Link | `1` | the proxy wallet shown in your profile menu |
| Legacy MetaMask / Rabby | `2` | the Safe wallet address |
| Created on/after 2026-05-04 (**default**) | `3` | the Deposit Wallet address |

- `POLY_PRIVATE_KEY` — the signer (for Magic Link accounts: Settings → Export Private Key).
- `POLY_FUNDER_ADDRESS` — copy the **account wallet address** from the profile menu.
  This is the `maker` of every order and the address holding your collateral.

The bot refuses to start live trading if the funder equals the signer on a
smart-wallet account — that combination silently produces orders that can never
fill.

### Exchange approvals (the step that blocks your first live order)

Before an order can settle, the **account wallet** must have approved both CLOB V2
exchanges — for pUSD (ERC-20 `approve`) and for the conditional tokens (ERC-1155
`setApprovalForAll`). The two CTF collateral adapters need the same pair so the
redemption sweeper can turn winning shares back into pUSD. Eight approvals:

| Token | Approve | Call | Needed for |
|---|---|---|---|
| pUSD `0xC011…2DFB` | CTF Exchange `0xE111…996B` | `approve(exchange, max)` | orders (standard markets) |
| pUSD | Neg Risk CTF Exchange `0xe222…0F59` | `approve(exchange, max)` | orders (neg-risk markets) |
| Conditional Tokens `0x4D97…6045` | CTF Exchange | `setApprovalForAll(exchange, true)` | orders (standard markets) |
| Conditional Tokens | Neg Risk CTF Exchange | `setApprovalForAll(exchange, true)` | orders (neg-risk markets) |
| pUSD | CtfCollateralAdapter `0xAdA1…cE1f` | `approve(adapter, max)` | redeeming winners |
| pUSD | NegRiskCtfCollateralAdapter `0xadA2…eAab` | `approve(adapter, max)` | redeeming winners |
| Conditional Tokens | CtfCollateralAdapter | `setApprovalForAll(adapter, true)` | redeeming winners |
| Conditional Tokens | NegRiskCtfCollateralAdapter | `setApprovalForAll(adapter, true)` | redeeming winners |

Approving only the exchanges is the quieter half of the same bug: orders fill, then
every won market reverts when the sweeper tries to redeem it, so the capital sits in
conditional tokens instead of recycling. This is the same plan Polymarket's own SDK
submits (minus the Protocol-V2 and perps contracts this bot never touches).

An allowance that is merely *non-zero* is not enough — a finite allowance gets spent
and the bot starts failing orders mid-run. Anything below unlimited is treated as
missing and re-approved to max uint256, exactly as Polymarket's tooling does.

An `approve()` sent from your **signer EOA does nothing**: the allowance must be
granted by the wallet that holds the funds, and on Polymarket that is a smart
wallet — so the calls go through the gasless relayer as one signed batch (no POL,
no MetaMask prompt). That is what `npm run approve` submits, and what the bot does
itself at start-up when `AUTO_APPROVE=true` (default).

```bash
npm run approve            # grant whatever is missing, verify, refresh the CLOB cache
npm run approve -- --check # read-only report
npm run doctor -- --approve
```

Skip it and every live order comes back
`400 not enough balance / allowance: the balance is not enough -> balance: 0`,
which reads like a funding problem and is not one. `npm run doctor` section 5 reads
the allowances straight off the contracts and shows which of the eight are missing —
the CLOB's own `/balance-allowance` number is a cache that lags behind chain. From the
dashboard the same thing is `GET /api/diagnostics` (read-only) and `POST /api/approve`
(`{"force":1}` to re-approve, `{"dryRun":1}` to preview).

### Which exchange an order is signed for

Every order is signed against a specific exchange contract, and the CLOB decides
which one: `GET /version` reports the order version it is currently accepting
(1 = the legacy CTF Exchange, 2 = the CLOB V2 CTF exchanges, 3 = ExchangeV3 with
Protocol-V2 position IDs). This bot signs **version 2** — `0xE111…996B`, or
`0xe222…0F59` for a neg-risk market — and checks the server's answer at pre-flight
and again before every live entry. If the server has moved on, the bot says so in
the log and stands down instead of submitting an order that cannot match
(`npm run doctor` section 9 and the dashboard's `order-version` row report it).

### Credentials

Leave `POLY_API_KEY`/`POLY_API_SECRET`/`POLY_API_PASSPHRASE` empty and the bot will
derive them: it signs the L1 `ClobAuth` payload with your key, calls
`/auth/derive-api-key`, and falls back to `POST /auth/api-key` if none exist yet.

### The real TWAP feed

Set `REFERENCE_SOURCE=auto` (default). Once L2 credentials exist the bot connects to
PolyBolt (`wss://ws-live-v2.polymarket.com/ws`), authenticates, and subscribes to
`price.crypto.twap` — the 60-second Chainlink TWAP these markets actually settle on.
If that feed is unavailable it falls back to a **time-weighted average of Coinbase +
Kraken spot** and marks every signal `degraded`, which widens the edge thresholds by
1.5x. The dashboard always shows which series is in use.

---

## Order sizing and the minimum-order trap

Polymarket sets a **minimum share count per market**, not a $1 minimum. The order
book reports it for each market as `min_order_size`, and the value differs between
markets. The bot uses the book's value and falls back to `MIN_ORDER_SHARES` only when
the book does not report one. At 60¢ a 5-share minimum costs $3.00, so the original
bot's default $2 stake was **rejected** at any price above ~40¢.

`MIN_ORDER_POLICY` controls what happens when your stake cannot buy the minimum:

- `bump` (default) — raise the stake to the smallest valid order and log it, as long as that order stays within `MAX_TRADE_SIZE_USD`;
- `skip` — decline the trade.

**`MAX_TRADE_SIZE_USD` is a hard ceiling on what one order can cost, taker fee included**:
`shares × limit price + estimated taker fee ≤ MAX_TRADE_SIZE_USD`, both measured at the
limit price the bot would pay. The fee is the market's fee schedule, the same one the edge
gate and Kelly use. It is applied after the minimum-share bump, so the bot never buys more
than the cap to reach a market minimum. If the minimum costs more than
the cap, the trade is declined and the log says why, for example
`the 20-share market minimum costs $12.60 at 63.0c, above the $12.00 cap (MAX_TRADE_SIZE_USD)`.

**Where the sizing values come from.** `TRADE_SIZE_USD`, `MAX_TRADE_SIZE_USD` and
`KELLY_SIZING` are read from the `.env` file next to `config.js`, whatever directory the
bot is started from. A key that is set in `.env` or in the shell environment wins on
every start. The dashboard saves its values to `bot_state.json`, and a saved value
applies only where the environment leaves the key unset, so a dashboard change to one of
these keys lasts until the next restart. The start-up banner's `sizing:` line names the
source of each value, and a `⚠` line names any saved value that `.env` overrode.
`npm run doctor` reports the same. To keep the dashboard's value across restarts, remove
the line from `.env`. Other dashboard-saved settings, such as `PAPER_MODE` and the loss
limits, still take the saved value.

Ask the API exactly what would happen before you trade:

```bash
curl -s -X POST localhost:3000/api/quote -H 'content-type: application/json' \
  -d '{"tokenId":"<token>","stakeUsd":2}' | jq
```

Its `note` starts with `Not traded:` when the order would be declined, whether by the cap or by `MIN_ORDER_POLICY=skip`.

The order path also enforces tick-size conformance (prices round up for BUY, sizes
floor, USD amounts follow the documented decimal rules), never pays more than
`MAX_BUY_PRICE` or ask + `MAX_SLIPPAGE_CENTS`, and cancels any unfilled remainder
after `ORDER_TIMEOUT_SECONDS`.

---

## Safety features worth knowing

- **Geoblock preflight** — `GET https://polymarket.com/api/geoblock`; with
  `REQUIRE_GEOBLOCK_PASS=true` the bot refuses to run live from a restricted region.
- **Circuit breakers** — `STOP_LOSS_USD`, `MAX_DAILY_LOSS_USD`, `TAKE_PROFIT_USD`,
  `MAX_OPEN_POSITIONS`, `MAX_TRADES_PER_WINDOW`, per-window cooldown.
- **Two loss breakers, and they are not the same thing** (see `DAILY-LOSS-FIX.md`):

  | Breaker | Measures | Resets | Dashboard control |
  |---|---|---|---|
  | Stop-loss | cumulative **net** realised P&L since the account was reset | never | "Stop-Loss Circuit Breaker" |
  | Daily loss cap | **gross** realised losses in the current UTC day | 00:00 UTC | "Max Daily Loss" |

  Either one stops the bot, and the stop banner + log name which one fired and
  what the limit was. The counter overshoots by up to one settled trade, so a
  stop reported at `-$59.67` against a `$50` cap is working as intended.
  Both are changeable live from the dashboard without a restart.
- **Paper mode is honest** — fills walk the real ladder, pay the real fee, and settle
  from the real resolution event. Positions that cannot be resolved are left
  `UNRESOLVED` with a warning rather than guessed.
- **Crash safety** — open positions are persisted and reconciled against the CLOB on
  restart, so nothing is orphaned.
- **Capital recycling** (v2.3) — the pre-expiry exit and the redemption sweeper
  above. `GET /api/diagnostics` gained a `capital-loop` check (live mode) that
  fails when **realised P&L is positive while tradeable collateral is zero**,
  which is the signature of the drain this closes.
- **Diagnostics** — dashboard "Run diagnostics" or `GET /api/diagnostics`.

---

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | everything the dashboard renders |
| `GET /api/health` | compact readiness summary |
| `GET /api/diagnostics` | per-subsystem checks (auth, geoblock, ws, feeds, balance) |
| `GET /api/markets` | discovered windows with tick/min-size/fee metadata |
| `POST /api/bot/start` \| `/stop` \| `/reset` | lifecycle |
| `POST /api/settings` | stake, stop-loss, Kelly, mode, per-strategy toggles |
| `POST /api/auth/configure` \| `/api/auth/derive` | wallet + credential setup |
| `GET /api/geoblock` \| `/api/auth/balance` | preflight helpers |
| `POST /api/quote` | **explains order sizing/fees before you commit** |
| `POST /api/trade` | manual snipe through the same guarded path |
| `POST /api/positions/:id/cancel` | cancel resting **entry** orders (exit orders only with `includeExitOrders=true`) |
| `POST /api/exit/run` \| `GET /api/exit/status` | one exit pass now / recycling stats |
| `POST /api/redeem/run` \| `GET /api/redeem/status` | force a sweep / sweeper readiness |
| `GET /api/redeem/preview` | what the Data API says is claimable, **without** claiming it |

The dashboard binds to `127.0.0.1` by default because it can place orders and accepts
a private key. Change `BIND_HOST` only if you understand that exposure.

---

## Tests

```bash
npm test                 # 198 unit tests: signing, ticks, sizing, fees, model, strategies, exit planning, relayer signing
npm run test:integration #  11 tests: position lifecycle — restart, settlement, fallbacks, risk
npm run test:exit        #  37 tests: the recycling subsystem driving the real BotCore tick loop
npm run test:all         # everything
```

`test/exit-integration.test.js` drives the **real** `BotCore` — real `tick()`,
real `settlePosition()`, real `manageExits()` — with only the network boundary
stubbed. It asserts the things a unit test cannot see: a SELL fill is never
booked as extra BUY exposure; a fully-exited position stops counting against
`MAX_OPEN_POSITIONS`; settling twice does not book P&L twice; and **exits still
run after the risk breaker has tripped or the window has gone untradeable** —
otherwise a stopping bot would strand a position it could perfectly well have
sold.

The suite deliberately covers the failure modes that are invisible until money is at
risk — it caught an ERC-7739 length-encoding bug during development that would have
made every Deposit Wallet order invalid.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `not enough balance / allowance: the balance is not enough` | the account wallet has not approved the V2 exchanges (or `POLY_FUNDER_ADDRESS` is not the wallet holding the pUSD). Run `npm run approve` — an EOA `approve()` does not work for a Deposit Wallet/Safe/proxy |
| `allowance is 0` in the doctor | same cause. `npm run doctor` section 5 shows which approvals are missing, read off-chain; `npm run approve` grants them |
| CLOB balance $0 but you funded the account | pUSD landed on the **signer EOA** instead of the account wallet — transfer it, or you deposited USDC.e, which must be wrapped to pUSD via the CollateralOnramp |
| `Trading restricted in your region` | geoblocked IP; run from an eligible jurisdiction |
| SQS stands down with `only 9s left (need ≥10s)` | correct: `MIN_SECONDS_TO_EXPIRY=10` is the account floor. Lower it if you want the module to trade closer to expiry — `SQS_MIN_LEFT` now follows it automatically |
| No signals, reason `no fair-value model` | the current window opened before the bot had 60s of TWAP history — it will trade the next window |
| `SPOT PROXY (degraded)` badge | PolyBolt TWAP needs L2 credentials; the bot widens thresholds until then |
| `order_version_mismatch` from `POST /order` | the CLOB moved this book to a different exchange version (`GET /version` reports it). This bot signs version 2 (the CLOB V2 CTF exchanges); the doctor and `GET /api/diagnostics` say which version the server wants, and live entries stand down rather than submit an unmatched order |
| Orders rejected on price | market tick changed (0.01 → 0.001); the bot tracks `tick_size_change` live |
| Position stuck `UNRESOLVED` | the exchange hasn't published a resolution yet; the bot will settle it on the next pass |
| `no ask offered on UP` | not an error: in the final seconds the decided side is often bid-only — the market stops selling it. SQS needs an *offer* at ≤93¢ to snipe |
| `… fired but did not trade: net edge … at the executable price` | one gate now (v2.3.1), so this only fires for a signal handed to the order path directly, e.g. `POST /api/trade`, or when the book moved between evaluation and execution. The message names the module, both prices and **whose** threshold bound — `MIN_NET_EDGE floor` or the module's own gate |
| A module never fires and you cannot see why | its own `*_MIN_EDGE` may be below `MIN_NET_EDGE`, which is a floor over every module. `configWarnings()` names the shadowed modules at startup |
| `the price to beat was not recorded … Waiting for the next window` | the bot started (or restarted) more than `WINDOW_OPEN_GRACE_SECONDS` into a window. That window is not tradeable; the next one is |
| P&L rising but no new orders, `$X needed, $0.00 available` | wins are locked in unredeemable tokens — see `CAPITAL-RECYCLING.md`. Enable the exit, or add Relayer keys so the sweeper can claim them |
| `[exit] not-decided` / `depth-too-thin` / `bid-above-cap` every window | not errors: the model is not convinced, your stake exceeds 25% of the bid ladder, or the book is already above 99.5c so holding beats selling |
| Sweeper reports `NOT READY` | you pasted CLOB L2 keys instead of **Relayer** API Keys — they are separate credentials |
| `GET /api/redeem/preview` returns 0 but the bot holds wins | `POLY_FUNDER_ADDRESS` is not the wallet holding the tokens — copy it from the Polymarket UI |
| A book "is Xs old — refetching from REST" | the stream went quiet on that market and the snapshot exceeded `MAX_BOOK_AGE_MS`; the REST snapshot is used for the decision |

---

## Files

```
config.js            env-driven configuration + validation (entry floors resolved at load)
contracts.js         every Polymarket contract address (single source of truth)
onchain.js           on-chain approval/balance reads + approval calldata encoders
polymarketAuth.js    L1/L2 auth, balances, per-exchange allowances, geoblock
orderSigner.js       tick rules, amounts, EIP-712 signing (+ ERC-7739 wrap)
pricing.js           TWAP fair-value model, fee maths, Kelly, volatility tracker, entryEdgeTest
clobClient.js        public + L2 REST client, book/fill estimation
wsMarket.js          market WebSocket (book state, heartbeat, reconnect)
wsUser.js            private WebSocket (fills, order state)
referencePrice.js    PolyBolt Chainlink TWAP + Coinbase/Kraken fallback
marketDiscovery.js   slug discovery, constraint harvesting, settlement resolver
strategyEngine.js    the 9 modules
exitManager.js       v2.3 pre-expiry exit: gates, sizing against bid depth, exit-adjusted payout
relayerClient.js     v2.3 gasless Relayer: WALLET/SAFE/PROXY signing, CREATE2, redeemPositions calldata
redeemer.js          v2.3 redemption sweeper: queue, resolution policy, polling, history
botCore.js           orchestration, execution, risk, settlement, state
server.js            HTTP API + dashboard host
tools/doctor.js      pre-flight checks (config, wallet, approvals, sockets, signing)
tools/approve.js     grants the eight exchange/adapter approvals via the relayer, then verifies
tools/replay-sqs.js  offline harness: does Stale-Quote Snipe fire, and where is it stopped
tools/check-dashboard-banner.js
                     renders the real dashboard in jsdom and reads back the setup banner
tools/check-dashboard-renders.js
                     loads the dashboard against the live server and fails on any JS error
test/                unit + integration suites (approvals, approvals-rpc, order-version,
                     exit, exit-integration, approvals-integration)
CAPITAL-RECYCLING.md v2.3: why the loop was broken, both mechanisms, every knob, failure modes
```
