# Fix: "I set the risk circuit breaker to -$300 and it stopped at -$59.67"

**Reported symptom**

> Why does this bot stop trading when it hits the daily loss limit -$59.67? I can
> see the risk circuit breaker was set to -$300.00 in the dashboard, yet it did
> not follow through with this rule I set.

**Verdict:** nothing was broken in the sense of a crash — two *different* limits
were being conflated by the UI, and only one of them was settable from the
dashboard. The `-$59.67` stop was the daily cap doing its job. The `-$300` you
typed went somewhere else.

---

## 1. There are two independent loss breakers

`botCore.js → checkRiskLimits()` has always evaluated both, as separate `if`
statements with separate counters:

| | Stop-loss breaker | Daily loss cap |
|---|---|---|
| Config key | `STOP_LOSS_USD` | `MAX_DAILY_LOSS_USD` |
| Runtime field | `bot.stopLossUsd` | *(was)* `cfg.risk.maxDailyLossUsd` |
| Counter | `realizedPnl` | `dailyLoss` |
| Accumulated in | `settlePosition()` — every P&L, win or lose | `settlePosition()` — **losses only** |
| Semantics | cumulative **net** P&L since the account was reset | **gross** losses in the current UTC day |
| Resets | only when the paper account is reset | automatically at 00:00 UTC |
| Stop message | `Stop-loss hit: …` | `Daily loss limit hit: -$…` |

Your `-$59.67` stop carries the second message, so it was the daily cap. Your
`$300` went into the first control.

## 2. Why the dashboard made that inevitable

The stat tile was labelled generically…

```html
<span class="stat-label">Risk Circuit Breaker</span>
<span id="circuitBreaker" class="stat-value">-$25.00</span>
```

…and rendered the **stop-loss** value, not the daily cap:

```js
document.getElementById('circuitBreaker').innerText = `-$${(botState.stopLossUsd || 0).toFixed(2)}`;
```

The only input in the Risk card that looked like a circuit breaker posted
`stopLossUsd`:

```html
<label class="form-label">Stop-Loss Circuit Breaker ($ Max Loss)</label>
```

Meanwhile `maxDailyLossUsd` — the limit that actually stopped you — was
**unreachable from the UI**:

* it read `cfg.risk.maxDailyLossUsd` straight off the environment (`config.js`);
* `SETTING_ALIASES` in `botCore.js` had **no key for it**, so a POST carrying
  `maxDailyLossUsd` came back in `settingsChanges.unapplied` — a silent no-op;
* the Risk card had no input for it;
* `saveState()`/`loadState()` did not persist it, so it could not even be
  inherited across restarts.

So the tile, the label and the input all pointed at the cumulative breaker,
while the cap that governed your day was a hidden constant in `.env`.

## 3. Why specifically -$59.67, and not -$50.00

Three mechanics compound, all in the settlement path:

1. **Losses are booked per settled position**, not continuously
   (`botCore.js`: `if (pnl < 0) this.dailyLoss += Math.abs(pnl)`).
2. **The check runs once per loop tick** (`loopMs` default 750 ms), before any
   other work in `tick()`.
3. Therefore the counter can only be tested *after* a loss lands, and it stops at
   the first tick where the sum has already crossed the limit. The reported
   figure is the **overshoot**, not the threshold: `$49.50` of losses (still
   under, so the bot traded on) plus one ~`$10.17` losing trade (a $10 stake plus
   the 0.07 taker fee) lands at `$59.67` → stop.

It is worth stating plainly: **a stop reported as `-$59.67` is a `$50` cap
working correctly.** The number in the log is the counter, and it will always
read a little over the limit. The message now says so.

4. **It is gross, not net.** Winners never reduce `dailyLoss`. A choppy day with
   wins and losses trips the cap sooner than a net-P&L view would suggest — which
   is sensible as a *daily* risk control, but means it is not comparable to the
   stop-loss figure.

5. **"Daily" means UTC.** The rollover is `toISOString().slice(0, 10)`, i.e.
   00:00 UTC — roughly 10–11 am in Melbourne, not local midnight.

## 4. A second trap, one keystroke away

`updateSettings()` clamped the stop-loss with `Math.max(1, n)`. A user who types
a literal minus sign — `-300`, copying the `-$300.00` the tile displays — gets
`Math.max(1, -300) === 1`: a **$1.00** circuit breaker that stops the bot on the
very next tick, for a reason nobody would guess. (The tile's own output invites
exactly this input.) `min="1.00"` on the input does not prevent it, because a
typed value plus `onchange` never consults constraint validation.

The clamp is now `Math.max(1, Math.abs(n))` for both breakers.

---

## 5. What the patch changes

### `botCore.js`
* `maxDailyLossUsd` added to `SETTING_ALIASES` (aliases: `dailyLossLimitUsd`,
  `maxDailyLoss`, `dailyLossLimit`) — the daily cap is now a first-class setting.
* New instance field `this.maxDailyLossUsd` (seeded from `config.risk`), so the
  dashboard can change it at runtime and so it is independent of `.env`.
* `checkRiskLimits()` reads `this.maxDailyLossUsd`, and **both** stop messages
  now name the counter *and* the limit that tripped, including the UTC wording.
* `Math.abs()` on both `stopLossUsd` and `maxDailyLossUsd` — the `-300 → $1` trap.
* `saveState()` / `loadState()` persist `maxDailyLossUsd` (the stop-loss already
  persisted; the daily cap silently reset from `.env` on every restart).
* `getState()` exposes `maxDailyLossUsd`, `dailyLossPct` and `dailyLossResetAtUtc`
  so the UI can show progress and the real reset time.

### `public/index.html`
* The single ambiguous "Risk Circuit Breaker" tile is replaced by three:
  **Stop-Loss Breaker (cumulative)**, **Daily Loss Cap (UTC day)** with its
  limit, and **Daily Loss Cap Remaining** with a progress bar.
* New input **"Max Daily Loss ($ per UTC day)"**, sitting directly under the
  stop-loss, each explaining how it differs from the other.
* A **stopped banner** now surfaces `stoppedReason` at the top of the page —
  previously the reason existed only in the log. It names the breaker that fired
  and explains what to do about it (raise the cap; the counter is persisted, so a
  restart alone will not resume trading).
* A dirty-field set stops the 1.5 s status poll from reverting a value that has
  been typed but not yet committed.

### `.env.example` / `README.md`
* The risk section documents the two breakers, the overshoot behaviour, and the
  fact that a dashboard value supersedes `.env` for the life of the process.

### Tests
`test/unit.test.js` — 12 new; `test/integration.test.js` — 2 new. Total now
**92 unit + 11 integration, 0 failures** (was 80 + 9). They cover: the canonical
and alias keys, rejection of non-numeric input, independence of the two breakers,
the negative-magnitude regression, runtime override of a stale `.env` value, the
message naming both counter and limit, cross-breaker isolation, the UTC-only
rollover, the new state fields, and persistence across a restart.

---

## 6. Reproducing the original bug and the fix

`node proof.js <project-dir> "<label>"` runs the same payload and the same losing
day against a given checkout:

```
ORIGINAL — poly-updown-bot-enhanced-V4
  "Stop-Loss Circuit Breaker" box accepted the $300 ... yes
  "Max Daily Loss" control accepted the $300 ....... NO  (rejected: ["maxDailyLossUsd"])
  Daily cap is a runtime setting .................... NO — read live from .env, unreachable from the UI
  Daily cap the bot actually enforces .............. $50.00
  After -$59.67 of losses, bot is .................. STOPPED
  Reason ........................................... Daily loss limit hit: -$59.67
```

```
PATCHED — same payload, same losing day
  "Stop-Loss Circuit Breaker" box accepted the $300 ... yes
  "Max Daily Loss" control accepted the $300 ....... yes
  Daily cap is a runtime setting .................... yes
  Daily cap the bot actually enforces .............. $300.00
  After -$59.67 of losses, bot is .................. STILL TRADING
```

---

## 7. Operating notes

* **To get a real $300 daily stop:** set it in the dashboard ("Max Daily Loss"),
  or `MAX_DAILY_LOSS_USD=300` in `.env` before starting. The dashboard wins.
* **After a daily-cap stop, restarting does nothing.** `dailyLoss` is persisted
  in `bot_state.json` and restored on boot, so the bot stops again on the first
  tick. Either raise the cap above the current counter, or wait for 00:00 UTC.
  (This is deliberate: a restart should not be a way to lose the day's P&L.)
* **The cap is gross of wins.** If you want a net-drawdown control for the day,
  the cumulative stop-loss is the net one — but it never resets on its own.
* **Where to see it:** the three tiles at the top, the stopped banner, and
  `GET /api/state` → `{ maxDailyLossUsd, dailyLoss, dailyLossPct, dailyLossResetAtUtc }`.
* Unchanged: the daily cap does **not** liquidate open positions. It stops new
  entries; positions already open still settle normally.
