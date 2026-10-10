# SQS investigation — does strategy 8 ever fire?

> This is the measurement that produced the fixes in `FIXES-2.2.md`. It was run
> against the *pre-fix* code (v2.1), which is why some quoted messages read
> `ask above 0.93`; the fixed build reports `no ask offered on UP` and names the
> time-floor clamp. Ad-hoc harnesses referenced below are included here as
> `tools/replay-sqs.js`; the 1 Hz live probe and the historical tape study lived
> in the research workspace.

**Scope:** `poly-updown-bot-enhanced-V5`, all 8 strategies enabled, configuration left at the shipped defaults.
**Method:** (1) code trace of every gate, (2) deterministic replay through the bot's real `tick()` path, (3) a live 50-minute paper run of the real bot against the real Polymarket CLOB book for BTC 5-minute up/down windows, (4) a historical tape study of 94 settled windows.

---

## Verdict

**Yes — it can trigger. The code path is fully live (I made it fire and place an order through the bot's own `tick()`).** But when *actually running*, it is the least likely of the eight to fire, for three independent reasons:

1. **The snipe condition is a genuine price dislocation** — the bot must believe a side is ≥ 96.5% while the market is still **offering it at ≤ 93c** inside the final 25 s. That is a ≥ 3.5-cent disagreement between model and market.
2. **With all 8 strategies enabled, the others usually get there first.** `MAX_TRADES_PER_WINDOW=1` + `MAX_OPEN_POSITIONS=1` + a 20 s cooldown mean the first signal in a window consumes the window: `tick()` then returns *before* `evaluate()` is ever called, so SQS is not just blocked, it is never even looked at.
3. **Even when the engine fires it, the order only goes through on a *bigger* dislocation** (~4c+), because `executeSignal()` re-checks a stricter fee-aware edge at ask + 2c slippage. A marginal fire increments the dashboard counter and silently places nothing.

In ~50 minutes of live running (6 windows, 133 one-second endgame samples inside the final 25 s): **SQS was evaluated 346 times, fired 0 times.** Inside its own 25-second window it was evaluated 14 times and the blocking gate was always `ask ≤ 0.93` — in fact on that side of the book **there was no offer at all** (only bids at 99c+).

---

## 1. The exact gate chain (defaults)

SQS fires only if every one of these passes, in this order:

| # | Gate | Default | Where |
|---|---|---|---|
| 1 | module enabled | `true` (`ENABLE_STRAT_STALE_SNIPE`, dashboard checkbox) | `strategyEngine.js` |
| 2 | bot running, loss breakers not tripped | stop-loss $25 / daily $50 | `botCore.checkRiskLimits()` |
| 3 | market discovered & tradeable, `remainingSec > 10` | `MIN_SECONDS_TO_EXPIRY=10` | `botCore.tick()` filter |
| 4 | **no open position, no trade yet in this window, ≥20 s since last fill** | `MAX_OPEN_POSITIONS=1`, `MAX_TRADES_PER_WINDOW=1`, `COOLDOWN_SECONDS=20` | `botCore.canOpenNewPosition()` :387 |
| 5 | a fair-value model exists | needs the window's price-to-beat — `null` for the first window after any start/restart | `strategyEngine.preflight()` :198 |
| 6 | time window | `10 s ≤ remainingSec ≤ 25 s` (`SQS_LAST_SECONDS=25`, `SQS_MIN_LEFT=8` **overridden by** `MIN_SECONDS_TO_EXPIRY=10`) | `strategyEngine.js` :429 |
| 7 | some side of the book is tradeable | spread ≤ 6c, ask depth ≥ $100, ask ≤ 97c | `preflight()` |
| 8 | model prob on one side | `p_side ≥ 0.965` | :431 |
| 9 | ask on **that same side** | `ask_side ≤ 0.93` | :436 |
| 10 | fee-net edge | `p − ask − 0.07·ask·(1−ask) ≥ 0.01` (×1.5 degraded) | `candidate()` :210 |
| 11 | **execution re-check** | net edge ≥ `MIN_NET_EDGE=0.015` at `min(0.97, ask+0.02)` | `botCore.executeSignal()` :509 |

Gates 8 and 9 together are the whole strategy: *"the market must be at least 3.5c cheaper than my model's certainty"*, in the last 25 seconds of a 5-minute contract.

---

## 2. Proof that it *can* fire (deterministic replay of the real code)

`/home/user/analysis/replay_sqs.js` drives the **unmodified** `BotCore.tick()` — real `canOpenNewPosition`, real `buildContext`, real `StrategyEngine`, real `executeSignal`, real paper-fill path — with only the I/O edges (feeds, books) supplied synthetically.

| Scenario | Model | Ask | Result |
|---|---|---|---|
| Borderline stale quote, 20 s left | 96.7% | 93c | engine **FIRED** `staleQuoteSnipe` … **order dropped** by the execution gate (needs ≈96.83% at limit 95c) |
| Decisive stale quote, 20 s left | 98.0% | 93c | engine **FIRED** + **PAPER ORDER PLACED** @ 0.95 (10.75 shares) |
| Same quote, 40 s left | 98.0% | 93c | SQS silent (`not final 25s`) — and **another module traded the window instead** (exactly the preemption pattern seen live) |
| Model confident, market fairly priced | 98.0% | 97c | no fire, `ask above 0.93` |

Run it yourself: `cd <bot dir> && node /home/user/analysis/replay_sqs.js`

---

## 3. What a live run actually shows (50 min, 5 windows, real books)

`sqs_probe.js` runs the real bot (production timers, real discovery + CLOB market WebSocket + Coinbase/Kraken/PolyBolt reference feeds) in paper mode and records every evaluation plus a 1 Hz endgame sample.

**Bot-level counters after the run:** `staleQuoteSnipe: evaluated 346, fired 0` (dashboard-equivalent). 4 paper trades were placed during the run — all by *other* modules, and every one of them **76–276 seconds before expiry** (`latencyExploitation` 186 s, `lateWindowConvergence` 156 s and 76 s, `fairValueEv` 276 s). So in every window that traded, the single trade slot was consumed long before the endgame — which is why the engine evaluated SQS only 14 times inside its own window (in the one captured window that was still free), and why its evaluation count is so small overall.

**Endgame anatomy (192 one-second samples across 6 windows; 133 inside the final 25 s):**

| Measurement | Result |
|---|---|
| samples with a live model | 108 / 133 |
| samples where the model was ≥ 96.5% on one side | **104** |
| **samples satisfying BOTH p ≥ 96.5% AND ask ≤ 93c (fire condition)** | **0 / 133** |
| snipe-side ask during confident samples | *no offer at all* in 79; an offer at **1.00** in 25 — never ≤ 93c |
| snipe-side best **bid** (what the market would pay) | 0.990 – 0.999 — the market was *bidding* ~99c for the same claim it would not offer |
| model vs market-implied probability, favoured side | mean **+0.27c**, max **+1.00c** (needs ≥ 3.5c) |
| SQS reason inside its own window | `ask above 0.93` (14/14), `only Ns left`, `no fair-value model` |

A representative endgame (window `…987800`): model climbs 94.9% → 97.1% → 100.0% across the final 25 seconds; the UP book has **no asks**; SQS answers `ask above 0.93`. Then the window `…987900` (bot free, no trade that window): model 99.6–100% for all 25 seconds, no offers, same answer.

Two structural facts fall out of this:

* **At expiry these books are not two-sided.** The near-certain side is bid ~99.9c with **zero offers**; the losing side is offered at 0.1–1c with $6k–$22k of depth. There is no "cheap offer on the winner" to snipe — the market simply stops selling the side it thinks is decided.
* **The model and the market agree to a fraction of a cent in the endgame** (both read the same spot tape), so the ≥3.5c disagreement SQS needs is an unusual event, not an everyday one.

*(Caveat: this run used the spot-proxy TWAP — no CLOB credentials in paper mode — so signals were flagged degraded and edge thresholds ×1.5. That makes SQS marginally harder to fire than with the authoritative Chainlink feed, but it does not touch gates 8/9, which were the ones blocking.)*

---

## 4. Historical tape: 94 settled windows

For each of the last 94 settled BTC 5-minute windows I pulled the full trade tape and asked: *was the eventual winner ever buyable at ≤ 93c inside the final 25 s?*

| Measure | Result |
|---|---|
| winner traded at all in the final 25 s | 14 / 94 (15%) |
| winner buyable ≤ 95c | 10 / 94 (11%) |
| **winner buyable ≤ 93c (SQS's cap)** | **8 / 94 (9%)** |
| cheapest winner BUY print in the final 25 s | min 37c · p10 41c · median 87c · max 99c |

But the crucial detail is *when and why* those cheap prints happen. Walking through the eight:

* `…986800`: winner bought at 0.37 **while the other side printed 0.61** — the window was undecided; the model (like the market) was ~40%, nowhere near 96.5%.
* `…971800` / `…971500` / `…968200` / `…962800`: cheap prints at 0.67–0.79 while the other side printed 0.13–0.17 — market still ~85%, model would be ~85%.
* `…974700`: 0.41 print against an opposite-side 0.09 print — an internally inconsistent tape moment.
* Only 2–3 windows show the shape SQS wants (winner ~0.86–0.87 while the other side printed 0.01–0.02) and even those are at **t−25s to t−21s**, i.e. the very edge of SQS's window. And a large share of those "cheap prints" are actually **paired buy-both-sides (mint) executions** — buying Down 0.86 *and* Up 0.14 in the same tx — so a cheap print does not by itself prove a resting *ask* at that price was available to take.

Net: a snipeable quote on the eventual winner inside the final 25 s is an upper bound of ~3–9% of windows, and only a small fraction of *those* would also have the model at ≥ 96.5% at that instant.

---

## 5. Fire ≠ trade: the threshold stack (worth knowing before you read the dashboard)

Three different bars apply to the same trade, and they are not consistent with each other:

| Layer | Requirement at ask = 93c | Effect |
|---|---|---|
| Strategy module (`SQS_MIN_EDGE=0.01`) | p ≥ 94.5% | none — `SQS_MIN_PROB=0.965` dominates |
| Execution (`MIN_NET_EDGE=0.015`, at `ask+2c` slippage) | **p ≥ 96.83%** | fires at 96.5–96.8% are logged as *fired* and silently dropped: `Order skipped: net edge 1.09c < 1.50c at executable price` (seen 4× in the live log) |
| Price cap | `MAX_BUY_PRICE=0.97` | limit order is placed at 0.95, i.e. 2c **above** the snipe price |

So a *traded* snipe needs the market to be roughly **4c+ below the model**, not 3.5c.

---

## 6. Defects and quirks found along the way

1. **`SQS_MIN_LEFT=8` never applies.** `preflight()` uses `max(8, MIN_SECONDS_TO_EXPIRY=10)`, so the documented "stands down below 8 seconds" is really 10 s.
2. **Missing ask reported as "ask above 0.93".** `if (!book || book.bestAsk === null || book.bestAsk > c.maxPrice) return { reason: 'ask above ${maxPrice}' }` (`strategyEngine.js:436`). Live, the dashboard says "ask above 0.93" when the book has *no offers at all* — misleading, and it hides the real blocker (no liquidity).
3. **Spread/depth guards are market-level, not side-level.** `preflight()` accepts the market if **any** side passes, and `candidate()` checks only price and edge for the side actually bought — so SQS can buy a side with a 10c spread and a few dollars of depth. In paper mode a 5-share fill can complete against that; live FAK may not.
4. **The clock is stale.** `market.remainingSec` refreshes only every `DISCOVERY_MS=10s` (measured instances: `leftUsed=186` vs true 179; `156` vs 150), so the "final 25 s" window is really the final ~15–35 s of wall clock, and the model's `secondsLeft` is equally stale.
5. **The first window after any start/restart is untradeable.** `observeWindow()` can only record the price-to-beat if it sees the window within 30 s of its open (`referencePrice.js:314`); a restart inside a window leaves `windowOpen.twap = null` → every module reports `no fair-value model`. Observed for 25/25 endgame samples of the window I restarted in. Budget a full 5 minutes of downtime per restart.
6. **`MIN_SECONDS_TO_EXPIRY` also caps SQS from below.** With defaults the usable band collapses to 10–25 s — 15 seconds of wall clock, once per 5-minute window.

---

## 7. What would have to happen for a real, filled snipe

* A genuine stale quote: model ≥ 96.5% (≥ 96.83% to actually execute), **ask ≤ 93c** on that same side, ≥ 10 s left, ≥ $100 depth, ≤ 6c spread;
* the bot must not have already used the window (no trade, no open position, 20 s since the last fill);
* and it must win the latency race — this is a taker order against an offer that market makers will pull or take themselves; the repo's own docs note you need to be near Polymarket's `eu-west-2` infrastructure for this class of strategy.

If you want to *observe* it fire (rather than hope for a dislocation), sensible experiments — each has an EV consequence:

* `SQS_MAX_PRICE=0.95` (with `SQS_MIN_PROB=0.965` the fee at 95c is 0.33c, so a 1c engine edge still exists) — widens the fire condition from "market 3.5c below model" to "market 1.5c below model". This is the single highest-leverage knob.
* `MAX_TRADES_PER_WINDOW` ≥ 2 / a separate slot for SQS, if you want the endgame to be reachable at all once another strategy has traded the window.
* Raising `MAX_SLIPPAGE_CENTS=2` is *counterproductive*: the execution check is computed at `ask + slippage`, so a wider slippage allowance silently raises the profit bar.

---

## 8. Practical notes for your setup

* **Jurisdiction:** the bot's own audit (`AUDIT.md`) documents that **Australia is "close-only"** for Polymarket (global) — live orders are rejected from an AU IP; `REQUIRE_GEOBLOCK_PASS=true` will stop the bot in live mode. Everything above was measured in **paper mode**, which is the honest way to evaluate this strategy from Melbourne.
* **Paper mode is faithful here:** it walks the real ask ladder, pays the real published taker fee (`rate 0.07, exponent 1, takerOnly`, rebateRate 0.2 — verified from Gamma), and settles on real resolution events (my run settled from `gamma_slug` and left one unruly position `OPEN` rather than guess — by design).
* The run also shows the modules that *do* trade in practice: `fairValueEv` and `lateWindowConvergence` mid-window (0.74–0.92 asks with 4–12c model edges), which is consistent with SQS being an opportunistic extra rather than a workhorse.

---

## Artifacts (workspace)

| File | What it is |
|---|---|
| `/home/user/analysis/replay_sqs.js` | deterministic harness through the real `BotCore.tick()` — proves SQS fires & trades |
| `/home/user/analysis/sqs_probe.js` | live-run probe (real bot, paper mode, per-tick + 1 Hz endgame recording) |
| `/home/user/analysis/sqs_samples.jsonl` | 192 live endgame samples (model, both books, every gate, SQS outcome) |
| `/home/user/analysis/sqs_ticks.jsonl` | what the bot's own engine actually evaluated, with all 8 modules' reasons |
| `/home/user/analysis/sqs_trades.jsonl` | every signal execution attempt (placed / dropped + reason) |
| `/home/user/analysis/historical_sqs.py` + `historical_sqs.json` | 94-window historical tape study |
| `/home/user/analysis/analyze.py` | aggregator that reproduces the tables above |

*(The bot's own source was not modified — the probe wraps `evaluate`/`executeSignal` from outside.)*
