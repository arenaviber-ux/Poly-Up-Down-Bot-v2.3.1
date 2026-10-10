# FIXES-2.2 — defects found while measuring the Stale-Quote Snipe

Investigation: *"does strategy 8 ever trigger with all strategies enabled?"* —
see `SQS-INVESTIGATION.md`, included here, and run `node tools/replay-sqs.js`
for the offline proof that the module fires (and where it is stopped).

While measuring it, six defects surfaced. All six are fixed here, each with a
regression test in `test/unit.test.js`. **Nothing in the trading economics was
changed**: the execution-layer edge check at `ask + MAX_SLIPPAGE_CENTS` is
deliberate and stays, so a marginal snipe still needs ≈96.8% rather than 96.5%
to actually place an order — it just says so now instead of counting as a fire
with no fill.

Test status after the patch: **108 unit + 11 integration tests, all passing.**

---

## 1. A module's time floor below `MIN_SECONDS_TO_EXPIRY` was silently raised

**Symptom.** `SQS_MIN_LEFT=8` and the docs promise "the module stands down below
8 seconds", but `preflight()` used `max(moduleFloor, MIN_SECONDS_TO_EXPIRY)`, so
the real floor was 10s and the reason string was a bare `only 9s left`.

**Fix.** The clamp is now named in the reason
(`only 9s left (need ≥10s; module floor 8s is clamped by MIN_SECONDS_TO_EXPIRY=10s)`),
`StrategyEngine.getState()` exposes `configuredMinSecondsLeft`,
`effectiveMinSecondsLeft` and `minSecondsClamped` per module, and `configWarnings()`
logs the clamp at startup (also on `/api/health`).

*Tests: "a module floor below MIN_SECONDS_TO_EXPIRY is reported as a clamp", "reachable floors are reported without a clamp note", "state exposes the effective floor per module", "configWarnings names a module floor that is clamped". Files: `strategyEngine.js`, `config.js`, `server.js`.*

## 2. "No offer" was reported as "ask above 0.93"

**Symptom.** `if (!book || book.bestAsk === null || book.bestAsk > c.maxPrice) return { reason: 'ask above ${maxPrice}' }` — so a bid-only book (the normal
endgame state on a decided side) looked like an overpriced quote. This is the
reason the live dashboard said `ask above 0.93` 14 times in the final 25s when
in fact **there was no ask at all**.

**Fix.** The three cases are distinct now: `no <side> book`, `no ask offered on <side>`,
and `<side> ask 97.0c above the 93c cap`. Applied to Stale-Quote Snipe, Late
Window Convergence and the shared `candidate()` path.

*Tests: "a side with no offers says so, instead of blaming the price cap", "an ask above the module cap is named with both prices". File: `strategyEngine.js`.*

## 3. Spread/depth gates were market-level, not side-level

**Symptom.** `preflight()` passes as soon as *one* side of the market is
tradeable, and `candidate()` only checked price and edge — so a module could buy
a side with a 10¢ spread and a few dollars of depth because the *other* side
looked healthy. Paper fills can complete against such a book (5 shares) while a
live FAK order may not.

**Fix.** `candidate()` now applies the spread, ask-depth and price-cap checks to
the side actually being bought, and returns `{ reason }` rather than `null` so the
dashboard shows which gate rejected it. `bestSide()` reports both sides' reasons.

*Tests: "per-side depth: a thin traded side is refused even when the market passes", "per-side spread: a wide traded side is refused even when the market passes", "fair-value EV reports both sides when neither qualifies". File: `strategyEngine.js`.*

## 4. The clock was stale by up to a discovery interval

**Symptom.** `market.remainingSec` is stamped by discovery, which runs every
`DISCOVERY_MS` (10s). Measured live: `leftUsed=186` vs true `179`,
`156` vs `150`. Everything downstream — the "final 25s" gate, the model's
`secondsLeft`, `MIN_SECONDS_TO_EXPIRY` — inherited that error.

**Fix.** `tick()` recomputes `remainingSec` from `endsAtEpoch` on every pass, and
`buildContext()` re-derives it for the market it is handed (so `POST /api/trade`
and any other caller with an old copy is safe too). Measured after the fix: max
skew **1s**.

Related: `buildContext()` now takes a book for decision via `bookForDecision()`,
which refetches from REST when the streamed snapshot is older than
`MAX_BOOK_AGE_MS` (5s default) — a quiet market used to leave an arbitrarily old
snapshot in memory, with every price/edge decision inheriting its age.

*Tests: "tick() refreshes time-to-expiry from the local clock", "bookForDecision prefers a fresh streamed book and refetches a stale one". Files: `botCore.js`, `config.js`.*

## 5. The first window after every start/restart was silently untradeable

**Symptom.** `observeWindow()` can only record the price to beat if it sees the
window within 30s of its open, and a window that opened earlier (start/restart
mid-window) got a `null` that was cached in some paths and not others. Result:
every module reported `no fair-value model` for the whole window, with no
explanation. Reproduced live: 25/25 endgame samples of the restart window.

**Fix.**

* `WINDOW_OPEN_GRACE_SECONDS` (default 30) makes the stamping window configurable
  and documents the trade-off (a later stamp anchors the model to a later instant).
* The reference feed keeps a short TWAP history, so a window whose open was
  covered by the authoritative series (or by the spot samples) is backfilled and
  labelled `@backfill`.
* A window that genuinely cannot be stamped is cached **with its reason**, and
  `tick()` reports it once in plain language:
  `No trades in btc-updown-5m-…: the price to beat was not recorded: the window opened 35s before the bot could observe it (grace 30s) — this window cannot be traded. Waiting for the next window.`
* A `null` TWAP snapshot is no longer cached as final, so a feed that was not up
  yet gets another chance on the next discovery pass.
* `getState().priceToBeat` now carries `ok` + `reason`, so the dashboard can show
  it instead of a bare `—`.

*Tests: "a window that opened before the bot could observe it is explained, not silent", "a window is backfilled when the spot history covers its open", "an unknown TWAP is not cached as final". Files: `referencePrice.js`, `botCore.js`, `config.js`.*

## 6. A signal could fire and place nothing, with no record of why

**Symptom.** The module edge test runs at the ask; the execution test runs at
`ask + MAX_SLIPPAGE_CENTS` and against `MIN_NET_EDGE`. A marginal signal therefore
increments the strategy's `fired` counter and drops out with only a generic
`Order skipped: net edge 1.09c < 1.50c at executable price` in the log.

**Fix.** Every drop path in `executeSignal()` now names the module and sets
`lastSkipReason`, e.g.

```
Stale-Quote Snipe fired but did not trade: net edge 1.37c at the executable price
(UP ask 93.0c + 2c slippage = limit 95.0c) is below MIN_NET_EDGE 1.50c
```

`configWarnings()` also states that `MIN_NET_EDGE` is enforced twice, and raising
`MAX_SLIPPAGE_CENTS` raises the profit bar rather than helping.

*Tests: "the execution gate names the module and shows both prices", "a decided side with no offers is reported before the execution gate". File: `botCore.js`.*

---

## Also in this patch

* Removed `StrategyEngine.sidePrice()` — dead code, and it returned `bestAsk` for
  both sides, so it was wrong for `DOWN` if anyone ever called it.
* `configWarnings()` is new: legal-but-surprising settings (clamped floors, a
  large window-open grace, the double edge check) are logged at startup and
  exposed on `/api/health` instead of waiting to be discovered.
* New configuration: `MAX_BOOK_AGE_MS` (5000), `WINDOW_OPEN_GRACE_SECONDS` (30).

## Not changed (deliberately)

* The execution-layer edge check at `ask + MAX_SLIPPAGE_CENTS` (≈96.8% to trade a
  marginal snipe). It is the safety margin against paying a worse price than the
  one the edge was computed on; the fix is transparency, not loosening it.
* The default `SQS_MAX_PRICE=0.93`, `SQS_MIN_PROB=0.965`, `MAX_TRADES_PER_WINDOW=1`.
  See `STRATEGIES.md` §8 for what those thresholds mean in practice.
