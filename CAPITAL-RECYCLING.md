# Capital Recycling (v2.3)

**Two mechanisms that convert winning positions back into spendable collateral.**

1. **Pre-expiry exit** (primary) — sell a position the model already considers
   decided, in the last 10–45 seconds of the window, into measured bid depth.
   No new credentials. Recycles capital in the same tick.
2. **Redemption sweeper** (backstop) — submit `redeemPositions` for resolved
   conditions through Polymarket's gasless Relayer. Needs Relayer or Builder
   API keys. Collects whatever the exit could not act on.

Both are **on by default**. Turning both off in live mode will strand your
balance; see [Failure modes](#failure-modes) for what that looks like.

---

## 1. The problem

Up to v2.2 this bot could only ever **buy**. The single runtime signing call
was hard-coded to a BUY, the sell machinery in `clobClient.estimateSellFill()`
and `orderSigner.computeSellAmounts()` was dead code referenced only by
exports, and a win was *booked*, not sold:

```js
// botCore.js (v2.2)
const payout = won ? pos.filledShares : 0;   // accounting only
pos.status = 'SETTLED';
this.logLine('INFO', '... redeem on-chain to release collateral');  // a reminder, not code
```

There was no redemption code anywhere in the tree. That combination is fatal in
live mode, for a reason that is easy to miss because **paper mode hides it
completely**:

| | paper | live |
|---|---|---|
| available capital | `this.paperBalance` | `(await this.auth.checkBalance()).balance` |
| credited on a win | `this.paperBalance += payout` | **nothing** |

`polymarketAuth.checkBalance()` calls CLOB
`GET /balance-allowance?asset_type=COLLATERAL&signature_type=N`, which reports
**collateral only**. Its on-chain fallback sums `balanceOf` for pUSD and
USDC.e — also collateral only. Winning shares are **ERC-1155 conditional
tokens** and count toward neither.

So in live mode every win permanently removed capital from the order path:

```
$100 float → win → 20 tokens → collateral now ~$80 → win → ... → collateral $0
             → botCore skips every order: "$5.00 needed, $0.00 available"
             → forever, while realizedPnl climbs and the dashboard looks healthy
```

With the shipped defaults (`TRADE_SIZE_USD=5`, `MAX_TRADE_SIZE_USD=25`,
`MAX_OPEN_POSITIONS=1`) that is roughly **4–20 unsettled wins** before the bot
goes quiet. Nothing errors. Nothing stops. It just stops trading.

**Polymarket's CLOB has no redemption endpoint** — this is not an oversight in
the bot. `py-clob-client` issue #139 asks for one;
`conditional-token-examples-py` issue #1 shows Polymarket's *own* `redeem.py`
failing, because the tokens are held by the proxy wallet rather than the EOA
that signs. Redemption is an on-chain call against the Conditional Tokens
Framework, executed *by the wallet that holds the tokens* — which is exactly
what the Relayer exists to do.

---

## 2. Mechanism 1 — pre-expiry exit

**File:** `exitManager.js` (pure decision logic) + `botCore.manageExits()` (the
live loop).

### Where it runs

`manageExits()` is the **first thing `tick()` does** after
`rollDailyCounters()` — above `checkRiskLimits()`, above the discovery refresh,
above every entry bail-out. That ordering is deliberate and was a bug on the
first pass:

- a tripped stop-loss calls `this.stop()`, which would have stranded a position
  that was still perfectly sellable;
- the `m.tradeable` filter and the empty-discovery `return` would have made any
  window the bot stopped *entering* impossible to *exit*.

It prices off each position's own `expiresAtEpoch`, so it does not need a
discovery refresh to work.

### The gates, in order

| Gate | Env | Refusal code | Why |
|---|---|---|---|
| enabled | `EXIT_ENABLED` | `disabled` | explicit opt-out |
| has a position | — | `no-position` | nothing to act on |
| not terminal | — | `terminal` | `SETTLED` / `EXITED` / `CANCELLED` / `REJECTED` |
| no live order | — | `in-flight` | one SELL at a time per position |
| has fills | — | `unfilled` | a resting BUY is cancelled, not sold |
| something left | — | `already-exited` | fully sold |
| not too early | `EXIT_MAX_SECONDS_TO_EXPIRY=45` | `too-early` | outcome not yet certain; selling is just paying the spread |
| not too late | `EXIT_MIN_SECONDS_TO_EXPIRY=10` | `too-late` | no time for the round trip *and* re-use of the proceeds |
| has a model | — | `no-model` | no fair-value window |
| conviction | `EXIT_MIN_MODEL_PROB=0.97` | `not-decided` | side-aware: a DOWN exit fires when `pUp <= 0.03` |
| bid exists | — | `no-bids` | the common endgame shape on the losing side |
| bid not too low | `EXIT_MIN_SELL_PRICE=0.93` | `bid-too-low` | the market disagrees with your model |
| bid not too high | `EXIT_MAX_SELL_PRICE=0.995` | `bid-above-cap` | above this, holding for the $1.00 redemption beats selling |
| enough depth | `EXIT_MAX_BID_DEPTH_PARTICIPATION=0.25` | `depth-too-thin` | never be the whole print |
| sizeable | — | `sizing-failed`, `bad-price` | tick-size / rounding |
| worth it | `EXIT_MIN_PROFIT_FLOOR_USD=0` | `below-profit-floor` | 0 disables the floor |
| edge | `EXIT_MIN_NET_EDGE=0` | `edge-too-thin` | optional; `probSide − bid − fee(bid)`, the sell-side mirror of `entryEdgeTest()` |
| attempts | `EXIT_MAX_ATTEMPTS=3` | `attempts-exhausted` | stop hammering a book that will not take it |
| cooldown | `EXIT_RETRY_COOLDOWN_SECONDS=3` | `retry-cooldown` | between attempts |
| clock | — | `no-clock` | time to expiry unknown |

Every refusal is logged with its code, so `grep '\[exit\]' bot.log` tells you
exactly why nothing sold.

### The conviction is recomputed, never reused

The gate uses `fairProbUp()` **at exit time**, not the probability recorded when
the position was opened. A position bought at 60c on a $50 lead is a live bet;
20 seconds later on a $200 lead it is `pUp = 0.99994`. Selling the first one is
paying the spread for nothing, and not selling the second one is leaving money
locked. Measured with the shipped model:

```
lead $200 @ 20s to expiry → pUp 0.99994   → exits
lead $50  @ 20s to expiry → pUp 0.83350   → refused (not-decided)
```

### The book at expiry is not two-sided

From `SQS-INVESTIGATION.md`, measured on real windows: near expiry the
near-certain side shows a **bid ~99.9c with zero offers**, and the losing side
shows offers at 0.1–1c with $6k–$22k of depth. So the exit sells into a thin,
bid-only ladder — which is why `EXIT_MAX_BID_DEPTH_PARTICIPATION` exists and why
a **partial fill is a success, not an error**. The thin-ladder integration test
sells 10 of 20 shares and records `exitStats.partial = 1`; the remaining 10 go
to resolution and the sweeper.

### The arithmetic

Published crypto fee schedule `{rate: 0.07, exponent: 1, takerOnly: true}`:

```
feePerShare = rate × p × (1 − p)
```

| price | fee/share | 20 shares |
|---|---|---|
| 0.50 | 1.750c | $0.3500 |
| 0.95 | 0.3325c | $0.0665 |
| 0.97 | 0.2037c | $0.0407 |
| **0.99** | **0.0693c** | **$0.0139** |
| 0.995 | 0.0348c | $0.0070 |

The fee **vanishes at the extremes**, which is what makes this mechanism cheap
exactly where it fires. Selling 20 shares at 99c:

```
gross   20 × $0.99  = $19.80
fee     20 × 0.0693c = $0.0139
net                   $19.7861   → collateral, immediately
hold to resolution    $20.0000   → tokens, until redeemed
cost of recycling     $0.2139    ≈ 1.07%
```

That is the trade: **give up ~1c per share to get the capital back one window
early**, and the taker fee is under 2c on the whole thing. For a bot whose
binding constraint is a small float being reused every few minutes, paying 1% to
recover 100% of the capital is the right side of that trade. If your float is
large relative to your stakes, raise `EXIT_MAX_SELL_PRICE` toward 0.999 or
disable the exit and rely on the sweeper alone.

`EXIT_ORDER_TYPE=FAK` (fill-and-kill) matters here: a partial fill must never
leave a resting order that the position tracker could mistake for an entry.

---

## 3. Mechanism 2 — redemption sweeper

**Files:** `redeemer.js` (queue + policy) and `relayerClient.js` (signing +
transport).

### Trigger points

- a **300s timer** (`AUTO_REDEEM_EVERY_MS`), matching the trading window;
- **queued immediately** after each live win that still has remaining shares;
- **manually** via `POST /api/redeem/run` or the dashboard button.

A live **loss** is not queued — there is nothing to redeem. A win that was fully
sold by the exit is not queued either.

### What gets submitted

```
CTF.redeemPositions(address collateralToken, bytes32 parentCollectionId,
                    bytes32 conditionId, uint256[] indexSets)   // 0x01b7037c
```

Binary markets pass `[pUSD, 0x00…00, conditionId, [1, 2]]` — index set 1 is Up,
2 is Down, and passing both is safe because the losing side pays nothing.
`groupByCondition()` collapses both outcome tokens of one condition into a
single submission and propagates `negativeRisk`. Legacy neg-risk conditions use
`redeemPositions(bytes32 conditionId, uint256[] amounts)` instead.

Output token: `REDEEM_OUTPUT_TOKEN=pUSD` routes through the V2 collateral
adapters; `usdce` redeems to legacy USDC.e.

### Resolution policy — the part that is easy to get wrong

`REDEEM_VERIFY_ONCHAIN=true` reads `payoutDenominator(conditionId) > 0` before
submitting. The subtle case is when **the RPC is unreachable**:

- a *definite* `resolved: false` **always blocks**;
- an *unavailable* check blocks **only** when `verifyOnChain` is true. Otherwise
  the bot WARNs and lets the Relayer be the authority — it rejects a redeem on
  an unresolved condition anyway.

The first implementation forced an on-chain confirmation for queued conditions
regardless of the flag, which meant a queued win was **stranded whenever the RPC
blipped** even though the operator had explicitly said "trust the API". A
verification knob that cannot be turned off is not a knob.

### Authorisation — three wallet types, three signing schemas

`POST /submit` accepts one of three transaction types, and picking the wrong one
is the single most common failure:

| `POLY_SIGNATURE_TYPE` | Type | EIP-712 domain `verifyingContract` | `to` |
|---|---|---|---|
| 3 (deposit wallet) | `WALLET` | **the deposit wallet itself** | the Deposit Wallet **factory** |
| 2 (Safe) | `SAFE` | the Safe address | — (`signatureParams` + `proxyWallet`) |
| 1 (proxy) | `PROXY` | — (struct hash, not EIP-712) | the Proxy **factory** |

The `WALLET` row is the trap: **the domain's `verifyingContract` is the wallet,
but the call is submitted to the factory.** Sign against the factory and the
Relayer returns an opaque signature error.

- **Safe** signatures are EIP-191 over the *struct hash* (`signMessage(hash)`,
  not `signTypedData`), packed `r‖s‖v` with **v shifted 27/28 → 31/32**.
- **Proxy** uses a bespoke struct:
  `keccak256("rlx:" ‖ from ‖ to ‖ data ‖ txFee32 ‖ gasPrice32 ‖ gasLimit32 ‖ nonce32 ‖ relayHub ‖ relay)`,
  then `signMessage`. `data` is the `proxy((uint8,address,uint256,bytes)[])`
  call, selector **`0x34ee9791`**, `CallType.Call = 1`.
- CREATE2 address derivation is implemented for Proxy and Safe
  (`deriveProxyWallet`, `deriveSafeAddress`). The **Deposit Wallet needs Solady
  ERC-1967 clone hashing, which is deliberately not reimplemented** — supply
  `POLY_FUNDER_ADDRESS` from the Polymarket UI instead.

`POST /submit` returns `{transactionID, state: "STATE_NEW"}` with **no
`transactionHash`**. You must poll `GET /transaction?id=` until the state is
`MINED` or `CONFIRMED`; `INVALID` and `FAILED` are terminal.

### Credentials

Get **Relayer API Keys** at `polymarket.com → Settings → API Keys → Relayer API
Keys`, then set `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`.

> **Your CLOB credentials will not work here.** `POLY_API_KEY` /
> `POLY_API_SECRET` / `POLY_API_PASSPHRASE` are L2 keys derived for order
> signing and cannot authorise a relayer transaction. This is a separate
> credential and it is the most likely reason the sweeper reports "not ready".

Builder HMAC keys (`POLY_BUILDER_API_KEY` / `_SECRET` / `_PASSPHRASE`) are
accepted as an alternative. `POLY_BUILDER_SECRET` is the key material; the
timestamp and signature headers are derived per request.

Without either, `AUTO_REDEEM` **degrades gracefully**: one setup warning at
start, `redeem.ready = false` with a `reason`, and the exit keeps working. It is
never a silent no-op — the dashboard says so in red.

**Also enable the account-level auto-redeem toggle in the Polymarket UI**
(Settings). It is not API-triggerable, but it is a free backstop that costs
nothing and covers anything this bot misses.

### Contract addresses (Polygon mainnet)

`RELAYER_CONTRACTS['137']` in `relayerClient.js` is the authoritative list —
this table is a copy, and the "used for" column says whether redemption actually
touches it:

| Contract | Address | Used for |
|---|---|---|
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | **`redeemPositions` target** + resolution reads |
| pUSD CollateralToken | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | **`collateralToken` arg + `REDEEM_OUTPUT_TOKEN=pUSD`** |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | `REDEEM_OUTPUT_TOKEN=usdce` (legacy) |
| CtfCollateralAdapter | `0xAdA100Db00Ca00073811820692005400218FcE1f` | **routing CTF shares → pUSD** |
| NegRiskCtfCollateralAdapter | `0xadA2005600Dec949baf300f4C6120000bDB6eAab` | same, neg-risk conditions |
| Deposit Wallet Factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` | **`to` for a `WALLET` submission** |
| Gnosis Safe Factory | `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b` | CREATE2 derivation for `SAFE` |
| Safe MultiSend | `0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761` | batching >1 Safe call |
| Polymarket Proxy Factory | `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052` | **`to` + CREATE2 for `PROXY`** |
| RelayHub | `0xD216153c06E857cD7f72665E0aF1d7D82172F494` | `rlx:` struct hash (proxy) |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | **deprecated** — the V2 adapters replace it |
| CTF Exchange | `0xE111180000d2663C0091e4f400237545B87B996B` | *reference only* — order matching, not redemption |
| Neg Risk CTF Exchange | `0xe2222d279d744050d28e00520010520000310F59` | *reference only* — order matching, not redemption |

Every address is asserted against `/^0x[0-9a-fA-F]{40}$/` and the EIP-55
checksum in the unit suite, so a typo fails the build rather than signing against
the wrong contract.

---

## 4. Accounting — positions are not deleted on exit

This is the design decision everything else depends on. An exited position is
**not removed**; it accumulates exit fields and then settles normally:

```
exitShares, exitProceedsUsd, exitFeeUsd, exitAvgPrice, remainingShares,
exitOrderIds, exitAttempts, lastExitAttemptAt, lastExitReason,
exiting, exitedAt, exitMode
```

```js
payout = exitProceedsUsd + (won ? remainingShares : 0)
cost   = filledUsd + totalFees(pos)          // entry fee + exit fee
```

A position that was **never exited** reduces exactly to the original
`won ? filledShares : 0`. That invariant is what makes the change safe to ship:
every pre-v2.3 settlement path is preserved bit-for-bit.

`status` becomes `EXITED` when every filled share was sold. `EXITED` is
**terminal for the open-position count** but the position **still settles** —
so `MAX_OPEN_POSITIONS=1` is not blocked by a position that is already flat.
`settlePosition()` is idempotent (it guards on `status === 'SETTLED'`, cancels
any resting exit order in live mode, and accepts
`resolutionSource: 'fully_exited'` to retire an exited position without waiting
for resolution).

### Paper and live credit differently, on purpose

| | when collateral arrives | what `settlePosition` credits |
|---|---|---|
| **live** | at SELL fill time (the exchange returns it) | only `remainingShares` |
| **paper** | there is no exchange | the **full** exit-adjusted `payout`, once |

The first implementation credited paper exits **twice** — once in
`executeExit()` and again in `settlePosition()`. Paper mode now credits once, at
settlement; `exitStats.recycledUsd` is the paper recycling metric. Live mode
needed no change, because the exchange already returned the money at fill time.

### `reconcileExitOrder()` sets, it does not accumulate

`size_matched` on a CLOB order is the order's **running total**, not an
increment. `reconcileExitOrder()` can fire three times for one fill — immediately,
on the 4s delayed re-check, and on the user-channel websocket event — and
accumulating it inflated `exitShares` to 60 for a 20-share exit.

`applyExitFill()` therefore takes an `authoritative` flag: **set** for
reconciliation, **accumulate** for incremental paper/partial fills.
`reconcileExitOrder()` also early-returns `{unchanged: true}` when the total has
not advanced, so stats and logs never re-count a fill.

### SELL fills must not look like entries

`onUserTrade()` accumulates into `filledShares` / `filledUsd`. A SELL fill
routed through it **inflated exposure** — the bot thought it held more than it
did, and would then refuse to open a new position. Exit orders are now diverted
to `reconcileExitOrder()` before that path can see them.

---

## 5. Configuration

Canonical names — these are the only keys `config.js` reads. A misspelled knob
silently does nothing, so `config.js` is the source of truth.

```bash
# --- Mechanism 1 ---
EXIT_ENABLED=true
EXIT_MIN_SECONDS_TO_EXPIRY=10
EXIT_MAX_SECONDS_TO_EXPIRY=45
EXIT_MIN_MODEL_PROB=0.97
EXIT_MIN_SELL_PRICE=0.93
EXIT_MAX_SELL_PRICE=0.995
EXIT_MAX_BID_DEPTH_PARTICIPATION=0.25
EXIT_MIN_PROFIT_FLOOR_USD=0
EXIT_MIN_NET_EDGE=0
EXIT_ORDER_TYPE=FAK
EXIT_MAX_ATTEMPTS=3
EXIT_RETRY_COOLDOWN_SECONDS=3

# --- Mechanism 2 ---
AUTO_REDEEM=true
AUTO_REDEEM_EVERY_MS=300000
REDEEM_OUTPUT_TOKEN=pUSD
REDEEM_VERIFY_ONCHAIN=true
REDEEM_MIN_VALUE_USD=0
REDEEM_MAX_PER_RUN=25
RELAYER_URL=https://relayer-v2.polymarket.com
RELAYER_API_KEY=
RELAYER_API_KEY_ADDRESS=
RELAYER_DEADLINE_SECONDS=300
RELAYER_PROXY_GAS_LIMIT=10000000
POLY_BUILDER_API_KEY=
POLY_BUILDER_SECRET=
POLY_BUILDER_PASSPHRASE=
```

`validateConfig()` errors on a malformed exit band; `configWarnings()` warns when
both mechanisms are off in live mode, when only the exit is off (naming the
sweeper dependency), and when `AUTO_REDEEM=true` with no relayer credentials.

No new npm dependencies — **ethers v6 only**. Adding
`@polymarket/builder-relayer-client` would drag in ethers v5 *and* viem, and it
`console.log`s unconditionally. The three signing schemas are mirrored in
`relayerClient.js` with the published client's behaviour asserted in tests.

---

## 6. API and dashboard

```
POST /api/exit/run             one exit pass now; returns the refusal reason if it stood down
GET  /api/exit/status          enabled + exitStats + collateral
POST /api/redeem/run           force a sweep; returns {redeemed, failed, skipped}
GET  /api/redeem/status        readiness, mode, reason, pending, done, history
GET  /api/redeem/preview       what the Data API says is claimable, WITHOUT claiming it
```

`GET /api/redeem/preview` is the diagnostic to reach for first: it compares what
the bot believes it holds against what
`data-api.polymarket.com/positions?user=<funder>&redeemable=true` reports. When
those disagree, redemption is not broken — the funder address is wrong.

`POST /api/positions/:id/cancel` no longer cancels exit orders unless you pass
`includeExitOrders=true`. Killing a SELL that is still trying to return your
capital is not what "cancel this position" means.

Dashboard additions: three stat cards (**Capital Recycled**, **Redemption
Sweeper**, **Tradeable Collateral**), a **Capital Recycling** settings card with
both toggles and the two manual buttons, positions still exposed to resolution,
and recent redemption history. The card carries the combined warning in-page
rather than only in the log.

`GET /api/diagnostics` gained `pre-expiry-exit`, `redemption-sweeper`, and —
live mode only — `capital-loop`, which fails when **P&L is positive while
tradeable collateral is zero**. That is the check that would have caught the
original bug.

---

## 7. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| P&L rising, no new orders, `"$X needed, $0.00 available"` | both mechanisms off, or the sweeper not authorised | enable the exit; add Relayer keys |
| `[exit] not-decided` every window | model not confident at your timeframe | lower `EXIT_MIN_MODEL_PROB`, or widen the band |
| `[exit] depth-too-thin` | stake larger than 25% of the bid ladder | raise `EXIT_MAX_BID_DEPTH_PARTICIPATION`, or reduce stake |
| `[exit] bid-above-cap` | book already at 99.6c+ | correct behaviour — holding beats selling there |
| `[exit] too-late` | loop is slower than the window | raise `EXIT_MIN_SECONDS_TO_EXPIRY`; check `LOOP_MS` |
| `[redeem] ... still locked` at ERROR | Relayer rejected or the RPC blipped | condition stays retryable; check `redeem/status` history |
| sweeper `NOT READY` | CLOB keys pasted instead of Relayer keys | create Relayer API Keys |
| `redeem/preview` shows 0 but the bot holds wins | `POLY_FUNDER_ADDRESS` is not the wallet holding the tokens | copy it from the Polymarket UI |
| exit fills but `exitShares` is 3× the stake | you are on a pre-fix build | `reconcileExitOrder` must set, not accumulate |

---

## 8. Testing

```bash
npm test                # 198 passed — includes the 81 exit unit tests
npm run test:exit       #  37 passed — real BotCore tick loop, no mocks in the path
npm run test:integration # 11 passed — the original suite, unchanged
npm run test:all        # everything
```

`test/exit.test.js` (81) covers all 20 refusal codes, inclusive band edges,
side-aware conviction, `floorShares` tick precision, cumulative partial fills,
`exitAdjustedPayout` for full/partial/never, `groupByCondition` neg-risk
propagation, sweeper idempotence, one-time WARN, `encodeRedeem` for all four
(negRisk × outputToken) combinations, malformed-`conditionId` rejection, the
three signing schemas, CREATE2 derivations, and EIP-55 validity of every shipped
address.

`test/exit-integration.test.js` (37) drives the **real `BotCore`** — real `tick()`,
real `settlePosition()`, real `manageExits()` — with only the network boundary
stubbed (`bot.ref`, `bot.marketStream.getBook`, the relayer). It asserts: exits
fire in-band and are model-driven; band edges refuse; a thin ladder sells only
part; a partial-exit win pays 19.88 and a partial-exit loss pays 11.88; a
never-exited position settles exactly as before; double-settle does not
double-book; a fully-exited position retires without resolution; `EXITED` /
`SETTLED` / `CANCELLED` / `REJECTED` do not block `MAX_OPEN_POSITIONS`; **exits
survive a tripped stop-loss and an untradeable or absent discovery window**; a
SELL fill never inflates `filledShares`; reconciliation is idempotent; a
cancelled SELL keeps the shares and does not cancel the position; a resting exit
order is cancelled at resolution; a live win is queued and swept; a live loss is
not; a paper sweep simulates; a failure stays retryable; collateral is
force-refreshed after a redemption; both toggles are live-changeable; stats
survive a restart; `resetPaperAccount` clears them; and `getState()` exposes the
whole picture. Two further tests pin the runtime-toggle semantics: switching to
paper mode must not report `AUTO_REDEEM` as off, and re-enabling the sweeper must
not log a sentence that contradicts itself.

---

## 9. Australia

`AUDIT.md` records that Polymarket applies a **close-only restriction to
Australia on both the frontend and the API**. The shipped `.env` sets
`REQUIRE_GEOBLOCK_PASS=true`, which refuses live trading; a probe returned
`{"blocked": true}` and a 403 on `POST /order`.

**Neither mechanism changes that.** The exit is a SELL through the same CLOB that
a BUY uses, and the sweeper is an on-chain call through Polymarket's own Relayer.
If your account cannot place orders, it cannot place exit orders either. This
work makes the bot's capital loop correct — it is not a geoblock workaround, and
it should not be treated as one.
