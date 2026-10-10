# The 8 strategies, corrected

Every module in the original bot was built on a false premise: that these markets
settle on the spot price of Bitcoin. They do not. Each market's own metadata says so:

```json
"cryptoMarketConfig": { "id": "btc-5m-twap-60", "asset": "btc", "duration": "5m",
                        "twapEnabled": true, "twapLookbackSeconds": 60 }
"resolutionSource": "https://data.chain.link/streams/btc-usd-twap-60s-streams"
```

A window resolves **Up** when

```
W_close  ≥  W_open          where W(x) = the 60-second trailing TWAP at instant x
```

`W_open` is the "price to beat"; `W_close` is the TWAP over the last minute of the
window. So the correct model compares *averages of averages*, and a single Coinbase
print — which is what the original bot traded — barely moves it.

---

## The shared model (used by every module)

For a window with `r` seconds remaining, current reference price `P_now`, current
trailing TWAP `W_now` and price-to-beat `A`:

```
n_known   = max(0, 60 − r)                    prints of the closing minute already observed
n_unknown = 60 − n_known                      prints still to come
E[W_close] = (n_known·W_now + n_unknown·P_now) / 60
sd[W_close] = σ₁s · sqrt(n_unknown / 3)       variance of a Brownian path average
pUp        = Φ( (E[W_close] − A) / sd[W_close] )
```

`Φ` is the normal CDF, `σ₁s` is per-second volatility from the live reference series
(floored by `MIN_VOL_PER_SEC` so the model can never divide by zero).

**Fees are subtracted from every edge.** Polymarket publishes a per-market
`feeSchedule`; crypto markets are `{rate: 0.07, exponent: 1, takerOnly: true}`:

```
feePerShare = rate · p · (1 − p)            peaks at 1.75¢/share at 50¢
netEdge     = p_model − ask − feePerShare(ask)
```

That fee is why "buy a 60% shot at 60¢" is a losing trade (+0 → −1.75¢) and why a
93¢ snipe of a 96.5% shot is still worth taking (fee 0.46¢, edge ~3¢).

### Guardrails applied to all modules

| Guard | Setting |
|---|---|
| Spread | `MAX_SPREAD_CENTS` (6¢) |
| Ask-side depth | `MIN_BOOK_DEPTH_USD` ($100) |
| Price cap | `MAX_BUY_PRICE` (0.97) |
| Time to expiry | `MIN_SECONDS_TO_EXPIRY` (10s) is a hard floor — a module's own `*_MIN_LEFT` can only raise it, never lower it. Since v2.3.1 an **unset** `*_MIN_LEFT` resolves to that floor at load instead of carrying a stale hard-coded number the engine would then clamp |
| Net edge | **one** gate, `pricing.entryEdgeTest()`, shared by the strategy engine and the order path. Tested at the **executable price** — `min(MAX_BUY_PRICE, best ask + MAX_SLIPPAGE_CENTS)` rounded to tick — against `max(module *_MIN_EDGE, MIN_NET_EDGE)`. `MIN_NET_EDGE` is a floor over every module's own gate, not a default for it |
| Minimum order | market's `min_order_size` (5 shares) |
| Degraded mode | the module's own edge threshold × 1.5 when the TWAP feed is unavailable (the `MIN_NET_EDGE` floor is not scaled — it already applies at full strength) |
| Concurrency | `MAX_OPEN_POSITIONS`, `MAX_TRADES_PER_WINDOW`, cooldown, daily loss cap |

---

## 1. TWAP Momentum *(was "Latency Exploitation")*

**Old:** fired when Coinbase/Kraken spot jumped, assuming the book was stale.
Spot jumps do not move a 60s average, so the "edge" mostly did not exist.

**New:** trades when the settlement series has genuinely diverged from the price to
beat, measured in standard deviations of the remaining window:

```
|E[W_close] − A| / sd[W_close]  ≥  TWAP_MOMENTUM_MIN_LEAD (1.25σ)
```

plus a net edge of `TWAP_MOMENTUM_MIN_EDGE` (2¢) at the ask, inside a
45–240s entry window. It is the same intuition (the book lags the truth) with the
right truth.

## 2. Late Window Convergence

In the final `LWC_WINDOW` (180s) the residual uncertainty is small, so a high model
probability with a cheap ask is close to arbitrage:

```
p_side ≥ 0.88   ·   ask ≤ 0.95   ·   netEdge ≥ 1.5¢
```

The `ask ≤ 0.95` cap keeps the taker fee (which grows toward 50¢) from eating the
edge, and the price cap keeps a late "certainty" from being bought at 99¢.

## 3. Book Microstructure

Depth imbalance across the live book (`bids/asks`, ≥1.8x with ≥$250 on each side,
spread ≤ `MAX_SPREAD_CENTS`) — but **only in the direction the TWAP model already
agrees with**. In a market that settles on an index, order flow is a timing signal,
not a thesis; the original module traded imbalance direction alone.

## 4. RSI Reversion

RSI(14) on the 5-second reference series. `RSI ≤ 30` → Up, `≥ 70` → Down, and it only
fires when the model probability is ≥ `RSI_MIN_PROB` (0.62) on that side. A
mean-reversion signal cannot move an already-accrued 60s average on its own, so the
model gate is what converts a coin-flip into a trade. (The sandbox demo showed this
working: *"RSI 90 but model P=3% < 62%"* → correctly refused.)

## 5. Fair-Value EV

The workhorse. Compute `pUp` from the model, then buy whichever side the market
underprices by at least `FV_MIN_EDGE` (3¢) after fees, with `p ≥ FV_MIN_PROB` (0.55),
40–280s before expiry. Both sides are evaluated and the larger net edge wins.

## 6. Cross-Venue Divergence

Coinbase vs Kraken lead-lag, on the theory that the staler venue (and the book)
converges to the fresher one:

```
|Coinbase − Kraken| ≥ $12   ·   both feeds < 2.5s old   ·   model agrees (p ≥ 0.60)
```

The model gate is the fix: the original traded the divergence *direction* alone, so a
stale print on a venue that does not settle the market could drag it into a losing
trade. Now divergence is a trigger, and the TWAP model has veto power.

## 7. Volatility Breakout

Bollinger burst on the reference series (90s lookback, 2σ) confirmed by a 15s thrust,
**only while ≥90s remain** — a move with 20 seconds left cannot reach the closing TWAP
average, so the original's "early/mid window" restriction was right for the wrong
reason. Requires a 2.5¢ net edge.

## 8. Stale-Quote Snipe

The final `SQS_LAST_SECONDS` (25s):

```
p_side ≥ 0.965   ·   ask ≤ 0.93   ·   netEdge ≥ max(1¢, MIN_NET_EDGE)   ·   ≥10s left to fill/cancel
```

The edge is measured at the **executable price**, not the ask: at a 93¢ ask the
limit is 95¢ (ask + `MAX_SLIPPAGE_CENTS`), where the taker fee is 0.33¢/share.

Three things are worth knowing before reading this module's dashboard line:

* **Its own 1¢ gate is shadowed by `MIN_NET_EDGE`.** This module is the one place
  where a one-cent edge is the whole point, but `MIN_NET_EDGE=0.015` is a floor
  over every module's gate, so the effective requirement is 1.5¢ and `SQS_MIN_EDGE`
  can never bind. Concretely: a 96.6% model at a 93¢ ask gives **1.27¢ at the
  executable price** — above this module's 1¢ gate, below the 1.5¢ floor, so it
  does not trade. Set `MIN_NET_EDGE=0.01` (or `0`) to let SQS trade the edge it was
  written for. `configWarnings()` says this at startup rather than leaving you to
  infer it from a module that never fires.
* **The window is resolved, not clamped.** `SQS_MIN_LEFT` shipped as 8s against a
  10s account floor, so the setting was dead on arrival — the advertised
  final-8-seconds window was really final-10, and the only hint was a startup
  warning. Since v2.3.1 an unset `SQS_MIN_LEFT` **resolves to
  `MIN_SECONDS_TO_EXPIRY` at load**, so the config and the engine cannot disagree
  and lowering the floor to 6s widens this module to 6s. If you *do* set it below
  the floor it is still raised — the account floor is a hard safety limit — and
  both the log (`only 9s left (need ≥10s; module floor 8s is clamped by
  MIN_SECONDS_TO_EXPIRY=10s)`) and `getState()` say so.
  Note `SQS_LAST_SECONDS=25` is what sets the upper end of the window; if it were
  ever ≤ `MIN_SECONDS_TO_EXPIRY` the module could not trade at all, and
  `configWarnings()` names the knob to raise.
* **"No offer" is not "too expensive".** In the last seconds of these windows the
  near-certain side is typically *bid* at 99–100¢ with **no offers at all** — the
  market stops selling the side it thinks is decided. That is reported as
  `no ask offered on UP` rather than as a price-cap breach, because the two mean
  very different things to an operator.

The module trades only when the market is offering that side at or below
`SQS_MAX_PRICE` *and* the model is at least `SQS_MIN_PROB` — a ≥3.5¢ disagreement
between model and quote in the last 25 seconds. It is opportunistic by
construction; the other seven modules are the workhorses.
---

## Sizing

- Base stake `TRADE_SIZE_USD`, raised to the market minimum when necessary, unless that
  would cost more than `MAX_TRADE_SIZE_USD`, in which case the trade is skipped. The cap
  covers cost **plus the estimated taker fee**, so the stake is trimmed until the total fits.
- Optional **¼-Kelly** (`KELLY_SIZING=true`) using the *fee-inclusive* odds
  `b = (1 − (p+fee)) / (p+fee)`, clamped between the base stake and
  `MAX_TRADE_SIZE_USD`.
- Hard caps: `MAX_OPEN_POSITIONS`, `MAX_TRADES_PER_WINDOW`, `MAX_DAILY_LOSS_USD`.

## Honest expectations

These modules trade a ~5-minute event contract against a 7%-of-notional taker fee
that peaks in the middle of the price range. The realistic edges are the ones with
structural reasons: model-vs-quote divergence late in the window, and convergence
trades where the fee is small. Latency-sensitive plays (momentum, cross-venue
divergence) require your host to be close to Polymarket's `eu-west-2` infrastructure;
from a home connection you are competing with market makers who are co-located. Paper
trade for a few hundred windows before risking capital, and expect the live numbers to
be worse than the paper ones — that gap is your latency and slippage.

### What the endgame book actually looks like

Measured over 133 one-second samples of the final 25 seconds of live BTC 5-minute
windows: on the side the model rated ≥96.5%, the book was **bid 99.0–99.9¢ with no
offers at all in 79 samples**, and offered only at 1.00 in the other 25. Across
those same samples the model and the market's implied probability agreed to within
**±1¢** (mean +0.3¢) — the ≥3.5¢ disagreement SQS needs is a rare event, not an
everyday one. Note also that all eight modules share one trade slot per window
(`MAX_TRADES_PER_WINDOW`), and the mid-window modules usually take it minutes
before SQS is even evaluated.
