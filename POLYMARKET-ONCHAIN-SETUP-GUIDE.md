# Polymarket Bot — Technical Setup Guide

> **What this is:** The complete list of rules, permissions, wallets, allowances,
> and technicalities a developer needs to understand BEFORE writing any bot code
> that trades on Polymarket. If you skip one of these, your bot will fail silently
> somewhere and you'll spend days chasing ghosts. This doc covers *what* happens
> and *why*. It does not build the bot for you — it keeps you from getting stuck.


When making a new wallet, you can use this Polymarket link:
https://polymarket.com/?via=alphastack-eymx

---

# Part 1: The Big Picture

## What Polymarket actually is, on-chain

```
 POLYMARKET ON POLYGON POS
 ═══════════════════════════════════════════════════════════════════

 ┌──────────┐      ┌─────────────┐      ┌─────────────────┐
 │   CLOB   │─────▶│  Exchanges  │─────▶│  CTF contract   │
 │ (off-    │      │ (on-chain)  │      │  (ERC-1155)     │
 │  chain   │      │             │      │                 │
 │  book)   │      │ settle      │      │ your shares     │
 └──────────┘      │ trades      │      │ (yes/no tokens) │
       ▲           └─────────────┘      └─────────────────┘
       │                  ▲
       │ orders           │  transfers
       │                  │
 ┌─────┴──────────────────┴──────┐
 │    your wallet                 │
 │    (USDC.e + CTF shares)       │
 └────────────────────────────────┘
```

The moving parts:

| Piece | What it is | Where it lives |
|-------|------------|----------------|
| **CLOB** | Central Limit Order Book. Off-chain matching engine. You POST orders, it finds a match, then settles on-chain. | `clob.polymarket.com` |
| **Exchanges** | On-chain contracts that do the actual token swaps. There are THREE of them. | Polygon mainnet |
| **CTF** | Conditional Tokens. An ERC-1155 contract. Every "YES share" and "NO share" is a token ID here. Your position = your balance of these tokens. | `0x4D97…6045` |
| **USDC.e** | The stablecoin used for everything. **Not** native USDC. | `0x2791…4174` |

Your bot talks to the CLOB over HTTPS, signs messages with your private key, and
never directly sends trades on-chain. The exchange contracts do that when a match
happens.

---

# Part 2: The two-wallet model (EOA vs Proxy)

This is the #1 thing that confuses developers. Polymarket uses **two addresses**
per user:

```
 ┌─────────────────────────────┐          ┌─────────────────────────────┐
 │         EOA                 │          │         PROXY WALLET        │
 │                             │  signs   │                             │
 │  Externally Owned Account   │ ───────▶ │  Smart contract wallet      │
 │  Has a private key          │ messages │  Holds USDC.e + CTF shares  │
 │  The "signer"               │          │  The "funder"               │
 │  MetaMask, Rabby, burner    │          │  All trades go to/from here │
 │  Pays POL for gas           │          │  Created automatically on   │
 │                             │          │  first Polymarket signup    │
 └─────────────────────────────┘          └─────────────────────────────┘
```

Every bot needs to know BOTH addresses:

```
  env var                       purpose
  ──────────────────────────────────────────────────────────────
  POLYMARKET_PRIVATE_KEY        EOA private key (signs orders)
  POLYMARKET_FUNDER             proxy wallet address (owns funds)
  POLYMARKET_SIG_TYPE           0 | 1 | 2  — see Part 4
```

**Why two addresses?**

1. **Security** — the EOA can be a low-value burner with a minimal POL balance.
   If leaked, the attacker can only sign trades; they can't drain funds without
   proxy permission.
2. **Gasless UX** — user signs a message off-chain, a relayer pays gas. This only
   works because the proxy is a smart contract that can verify signatures.
3. **Account abstraction** — Polymarket created this pattern before ERC-4337 was
   standard.

**Where do funds live?** On the **proxy**. Deposits arrive there, shares are held
there, sale proceeds land there.

**Where is gas paid?** From the **EOA**. The EOA signs approval transactions
(USDC `approve`, CTF `setApprovalForAll`) and those cost POL. Not much — 5 POL
(~$1.50) lasts a lifetime of setup.

---

# Part 3: The money — USDC.e (not USDC) + POL for gas

Polygon has TWO stablecoins both called "USDC":

```
 ┌────────────────────────────────────────────────────────────────┐
 │ TOKEN       CONTRACT                                   USED BY │
 ├────────────────────────────────────────────────────────────────┤
 │ USDC.e      0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174  ✅      │
 │ (bridged,                                            Polymarket│
 │  the "old" one)                                                │
 ├────────────────────────────────────────────────────────────────┤
 │ USDC        0x3c499c542cEF5E3811e1192ce70d8cC03d38ef17  ❌      │
 │ (native,                                             NOT used  │
 │  Circle-issued)                                                │
 └────────────────────────────────────────────────────────────────┘
```

**Your bot must fund in USDC.e.** Native USDC is useless for Polymarket trading.

```
  CEX (Coinbase / Binance / Kraken)
           │
           │  withdraw USDC to Polygon network
           ▼
     Your proxy wallet address
           │
    (arrives as USDC.e because
     exchanges default to the
     bridged version on Polygon)
           ▼
        Ready to trade
```

If you accidentally send native USDC to your proxy:
- Swap USDC → USDC.e via Uniswap or 1inch on Polygon.
- Or bridge it back out and re-send as USDC.e.

**POL** (formerly MATIC) is the gas token on Polygon. The bot needs POL on the
**EOA**, not the proxy.

---

# Part 4: Signature types (0 / 1 / 2) — and which one is yours

```
 How did you sign up for Polymarket?
 │
 ├─── Email + SMS verification
 │    (no wallet connect step)      ──▶  sigType 1: POLY_PROXY
 │                                       EOA = magic-link generated
 │                                       Funder = new proxy
 │
 ├─── Connected MetaMask / Rabby
 │    (clicked "Connect Wallet")     ──▶  sigType 0: EOA
 │                                       EOA = MetaMask key
 │                                       Funder = same as EOA
 │
 └─── Connected Gnosis Safe          ──▶  sigType 2: POLY_GNOSIS_SAFE
                                          EOA = Safe signer
                                          Funder = Safe address
```

**Why it matters:** the CLOB needs to know what kind of signature to verify. If
you set the wrong sigType, every order is rejected with a cryptic error like
"invalid signature" or "allowance not enough."

**Most common for bots:** `sigType 0` (EOA). Generate a fresh private key, send
it some POL, use the same address as both EOA and funder. Simplest mental model.

**For email-signup users:** `sigType 1`. The EOA private key can be exported from
[polymarket.com](https://polymarket.com/?via=alphastack-eymx) → profile →
"Export private key." The funder address is different from the EOA and is
shown in your Polymarket profile.

**For teams / multi-sig:** `sigType 2`. Rare for individual bots.

---

# Part 5: Standard markets vs NegRisk markets — the hidden split

Polymarket has TWO market types and they use DIFFERENT contracts.

```
 ┌─────────────────────────────────────────────────────────────────┐
 │ STANDARD MARKETS (binary yes/no)                                │
 │                                                                 │
 │   "Will X happen by date?"                                      │
 │                                                                 │
 │   Exchange: CTFExchange                                         │
 │             0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E          │
 │                                                                 │
 │   All trades settle through this one contract.                  │
 └─────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────┐
 │ NEGRISK MARKETS (multi-outcome / categorical)                   │
 │                                                                 │
 │   "Who will win the election?" with candidates A, B, C, D       │
 │   "How many Fed rate cuts in 2026?" with 0, 1, 2, 3+ outcomes   │
 │                                                                 │
 │   Exchange:  NegRiskCtfExchange                                 │
 │              0xC5d563A36AE78145C45a50134d48A1215220f80a         │
 │                                                                 │
 │   Adapter:   NegRiskAdapter                                     │
 │              0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296         │
 │                                                                 │
 │   Trades touch both contracts (adapter → exchange). The         │
 │   "sum of outcome prices = 1" invariant is enforced by the      │
 │   adapter, which lets users trade YES on multiple outcomes      │
 │   without depositing more capital.                              │
 └─────────────────────────────────────────────────────────────────┘
```

**How to tell them apart programmatically:** the Gamma API returns a
`negRisk: true/false` flag per market. Store this on the position — your sell
logic will need it later.

**Why it matters:** approvals for standard markets DO NOT cover NegRisk markets.
If your bot only approves the standard exchange and then tries to trade a NegRisk
market, everything silently fails.

---

# Part 6: CLOB API credentials (how your bot talks to Polymarket)

The CLOB requires a separate API credential set, derived from your private key:

```
    Your EOA private key
            │
            │ sign: "derive API key"
            ▼
    clob.polymarket.com/auth/derive-api-key
            │
            │ returns
            ▼
    ┌───────────────────────┐
    │  key        (public)  │
    │  secret     (private) │
    │  passphrase (private) │
    └───────────────────────┘
            │
            ▼
    Store these server-side.
    Every CLOB request adds these in headers.
```

With `@polymarket/clob-client` (npm), it's one line:

```typescript
const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet);
const creds = await client.createOrDeriveApiKey();
// Persist creds.key, creds.secret, creds.passphrase somewhere durable.
```

**Gotcha:** `createOrDeriveApiKey` returns the EXISTING creds if one was already
derived for this EOA. If you lose the passphrase, you can't recover it from
another process. **Always persist the creds on first derivation.**

---

# Part 7: The allowance matrix, part 1 — for BUYING

To BUY on Polymarket, you spend USDC.e. The exchange contract must be allowed to
transfer USDC.e out of your proxy wallet.

```
   USDC.e contract (ERC-20)
        │
        │ approve(spender, MAX_UINT256)
        │
        ├──────▶ CTFExchange              [standard markets]
        │
        ├──────▶ NegRiskCtfExchange       [negRisk markets]
        │
        └──────▶ NegRiskAdapter           [negRisk markets]
```

**Three separate approve() calls.** Each is an on-chain transaction signed by
the EOA, paid in POL.

**Why three?** The standard CTFExchange handles binary markets by itself. NegRisk
markets route through the NegRiskAdapter first (which enforces the sum-to-1
invariant), which then calls the NegRiskCtfExchange. Both adapter and exchange
need the allowance.

**Amount:** Always approve `MAX_UINT256` (effectively infinite). Re-approving
every trade wastes gas.

**Check before approving:** Call `allowance(owner, spender)` first. If non-zero,
skip the approve.

---

# Part 8: The allowance matrix, part 2 — for SELLING

**THIS IS WHERE MOST BOTS FAIL SILENTLY.**

To SELL, you transfer CTF shares (ERC-1155 tokens) to the exchange. The CTF
contract must be set to allow the exchange to pull your tokens.

```
   CTF contract (ERC-1155)
        │
        │ setApprovalForAll(operator, true)
        │
        ├──────▶ CTFExchange              [standard markets]
        │
        ├──────▶ NegRiskCtfExchange       [negRisk markets]
        │
        └──────▶ NegRiskAdapter           [negRisk markets]
```

**Same three targets as the USDC side.** Separate on-chain transactions from the
USDC approvals.

**Why this is the silent failure:**

- FOK market-sell orders sometimes work even WITHOUT this approval, because they
  settle atomically with a buy (the exchange can do internal accounting).
- **GTC limit-sell orders always need this approval.** If it's missing,
  `createAndPostOrder` returns a response that looks structurally normal but the
  order never shows up on the book. No clear error message. Your bot thinks it
  posted a sell; nothing is actually happening.
- A bot that only ever buys (no sell logic) will never hit this wall. The silent
  failure shows up the first time you try to exit a position via limit order.

**CTF contract address on Polygon:** `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`

**The full on-chain check your bot should run on startup:**

```
  isApprovedForAll(myProxy, CTFExchange)           → should be true
  isApprovedForAll(myProxy, NegRiskCtfExchange)    → should be true
  isApprovedForAll(myProxy, NegRiskAdapter)        → should be true
```

If any is false, sell orders on that market type will fail silently.

---

# Part 9: Order types — FOK, FAK, GTC, GTD

The CLOB accepts four order types. Each behaves differently when there's
insufficient counter-side liquidity:

```
 ┌─────────────────────────────────────────────────────────────────┐
 │ TYPE   FULL NAME              BEHAVIOR                          │
 ├─────────────────────────────────────────────────────────────────┤
 │ FOK    Fill-Or-Kill           Either fill 100% now or cancel.   │
 │                                Best for: market-takers who      │
 │                                want guaranteed fill or nothing. │
 ├─────────────────────────────────────────────────────────────────┤
 │ FAK    Fill-And-Kill          Fill as much as possible, cancel  │
 │                                the rest immediately.            │
 │                                Best for: partial fills OK.      │
 ├─────────────────────────────────────────────────────────────────┤
 │ GTC    Good-Till-Cancel       Post on the book and wait for a   │
 │                                taker. Never expires — you must  │
 │                                cancel it yourself.              │
 │                                Best for: patient sellers,       │
 │                                limit-order makers.              │
 ├─────────────────────────────────────────────────────────────────┤
 │ GTD    Good-Till-Date         Like GTC but expires on a set     │
 │                                date/time. Auto-canceled.        │
 │                                Best for: time-bounded limits.   │
 └─────────────────────────────────────────────────────────────────┘
```

**Bot design implications:**

- **Pure FOK bot:** simple, never orphans orders, but can't sell into thin books.
  If nobody's bidding near fair price, your position is stuck.
- **FOK + GTC fallback bot:** tries FOK first, posts GTC if it fails. Unlocks
  exits on illiquid markets but requires state tracking — you have to record the
  resting order ID, check if it filled each cycle, cancel and repost if fair
  price moves, etc.
- **Pure GTC maker bot:** passive strategy. Post offers, collect spreads. Highest
  complexity because prices move and you have to manage a web of open orders.

Most bots start pure-FOK, hit the "stuck position" wall within weeks, and evolve
to FOK + GTC fallback.

---

# Part 10: The anatomy of a trading cycle

A typical automated cycle looks like this:

```
                        CYCLE START
                            │
                            ▼
              ┌─────────────────────────┐
              │  1. Fetch USDC balance  │
              │     (are we solvent?)   │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  2. Fetch edge data     │
              │     (probability per    │
              │      market + edge)     │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  3. REVIEW positions    │◀─────┐
              │     (one by one)        │      │
              └─────────────────────────┘      │
                            │                  │
                            ▼                  │
        ┌─────────────────────────────────┐    │
        │  3a. Reconcile resting GTC      │    │
        │      filled? leave it? cancel?  │    │
        └─────────────────────────────────┘    │
                            │                  │
                            ▼                  │
        ┌─────────────────────────────────┐    │
        │  3b. Check sell triggers:       │    │
        │      - market resolved (≥95¢)   │    │
        │      - edge reversed            │    │
        │      - target price hit         │    │
        │      - stop-loss hit            │    │
        │      - time decay (too old)     │    │
        └─────────────────────────────────┘    │
                            │                  │
                        triggered?             │
                     ┌──────┴──────┐           │
                     │ no          │ yes       │
                     │             ▼           │
                     │   ┌─────────────────┐   │
                     │   │ Try FOK at fair │   │
                     │   └─────────────────┘   │
                     │             │           │
                     │       ┌─────┴─────┐    │
                     │       │ filled?   │    │
                     │       └─────┬─────┘    │
                     │      no  ┌──┴──┐ yes   │
                     │          ▼     ▼       │
                     │   ┌──────────┐ ┌──────┐│
                     │   │ Post GTC │ │ done ││
                     │   │ @ fair×  │ └──────┘│
                     │   │   0.95   │         │
                     │   └──────────┘         │
                     │             │          │
                     └─────────────┘          │
                            │                 │
                     more positions? ──yes────┘
                            │
                            no
                            ▼
              ┌─────────────────────────┐
              │  4. SCAN candidates     │
              │     (from edge feed)    │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  4a. Liquidity filter:  │
              │      - bid ≥ 60% fair?  │
              │      - book depth ≥ $X? │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  4b. Edge filter:       │
              │      - edge ≥ minEdge?  │
              │      - confidence ≥ X?  │
              │      - not already held?│
              │      - data fresh?      │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  5. BUY via FOK         │
              │     (up to maxBets/     │
              │      cycle, within      │
              │      balance)           │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  6. Save state          │
              │     (positions, P&L,    │
              │      cycle log)         │
              └─────────────────────────┘
                            │
                            ▼
                         CYCLE END
```

**Key invariant:** every cycle must be idempotent-safe. If it crashes halfway
through step 3 and restarts, nothing should break. Use a single-writer lock to
guard against concurrent runs.

---

# Part 11: Tick sizes and minimum order sizes (per-market)

Every market has its own tick size and min order size, fetched from the order
book endpoint:

```
  GET /book?token_id=<tokenId>
       │
       ▼
  {
    "bids": [...],
    "asks": [...],
    "tick_size": "0.01",        ← minimum price increment
    "min_order_size": "5"       ← minimum # of shares per order
  }
```

Tick sizes seen in practice:

| Tick    | Typical market                              |
|---------|---------------------------------------------|
| 0.01    | Most binary markets. Default.               |
| 0.001   | High-liquidity markets (elections, sports)  |
| 0.0001  | Very tight spreads (rare)                   |
| 0.1     | Low-resolution markets (uncommon)           |

**Critical:** your order price MUST be an exact multiple of the tick. A GTC at
$0.304 on a tick=0.01 market is rejected. Round **down** to the nearest tick for
sells, **up** for buys:

```typescript
const sellPrice = Math.floor(desired / tick) * tick;
const buyPrice  = Math.ceil(desired / tick) * tick;
```

**Minimum order size:** if your bet is smaller than `min_order_size`, the CLOB
rejects it. For most markets this is 5 shares. With 5¢ markets, that's $0.25
minimum. Your bet sizer should check this before placing.

---

# Part 12: Order management — cancel, query, re-post

Once a GTC order is resting, you need to manage it:

```
 ┌─────────────────────────────────────────────────────────────────┐
 │  GET /order/<orderID>           → current status                │
 │                                                                 │
 │  Returns:                                                       │
 │    status: "LIVE" | "MATCHED" | "CANCELED"                      │
 │    size_matched: shares already filled                          │
 │    original_size: shares requested                              │
 │    price: limit price                                           │
 ├─────────────────────────────────────────────────────────────────┤
 │  POST /order/cancel  { orderID }     → cancel one               │
 │  POST /orders/cancel { hashes }      → cancel many (atomic)     │
 │  GET  /orders                        → all your live orders     │
 └─────────────────────────────────────────────────────────────────┘
```

**State reconciliation pattern** — each cycle, for each position with a resting
GTC:

```
  GET /order/<pos.restingOrder>
          │
   ┌──────┴──────┐
   │  status?    │
   └──────┬──────┘
          │
  ┌───────┼────────┬──────────┐
  │       │        │          │
  ▼       ▼        ▼          ▼
MATCHED  LIVE   CANCELED   not-found
  │       │        │          │
  ▼       ▼        ▼          ▼
Record  Leave    Clear      Clear
sell.   it.      state.     state.
Clear
state.
```

Partial fills: check `size_matched` vs `original_size`. Remaining size is still
resting.

---

# Part 13: Rate limits

Approximate CLOB limits per API key (subject to change):

| Endpoint              | Limit         | Notes              |
|-----------------------|---------------|--------------------|
| `POST /order`         | 50 / 10 sec   | Order submission   |
| `GET /order`          | 100 / 10 sec  | Status checks      |
| `/cancel`             | 50 / 10 sec   | Cancellations      |
| `/book`               | 1000 / min    | Order book reads   |
| `/prices`             | 1000 / min    | Price snapshots    |
| `/markets` (gamma)    | 600 / min     | Market metadata    |
| `/positions` (data)   | 300 / min     | Portfolio reads    |

**Practical impact:** a single cycle reviewing 20 positions + scanning 50
candidates hits `/book` ~70 times. Well within limits. High-frequency bots
reviewing thousands of markets should batch and cache aggressively.

Exceeding a limit returns `429 Too Many Requests`. Back off with exponential
delay.

---

# Part 14: Complete setup checklist

If any of these are unchecked, something will break.

```
  WALLET
  ──────
  [ ] EOA created (MetaMask, Rabby, or fresh-generated key)
  [ ] EOA private key saved securely (env var, KMS, or equivalent)
  [ ] EOA funded with ~5 POL for gas

  POLYMARKET ACCOUNT
  ──────────────────
  [ ] Signed up at polymarket.com with that wallet
      https://polymarket.com/?via=alphastack-eymx
  [ ] Proxy wallet address noted
      (shown in profile, or = EOA for sigType 0)

  FUNDING
  ───────
  [ ] USDC.e deposited to the PROXY wallet
      (not the EOA, not native USDC)
      Contract: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

  BOT ENVIRONMENT
  ───────────────
  [ ] POLYMARKET_PRIVATE_KEY  — EOA key
  [ ] POLYMARKET_FUNDER       — proxy address
  [ ] POLYMARKET_SIG_TYPE     — 0 (EOA), 1 (email/proxy), or 2 (safe)

  CLOB CREDENTIALS
  ────────────────
  [ ] Derived via createOrDeriveApiKey()
  [ ] Stored (key + secret + passphrase) somewhere durable

  USDC ALLOWANCES (for BUYING)
  ────────────────────────────
  [ ] USDC.e → CTFExchange         (standard markets)
  [ ] USDC.e → NegRiskCtfExchange  (negRisk markets)
  [ ] USDC.e → NegRiskAdapter      (negRisk markets)

  CTF ALLOWANCES (for SELLING — the silent-failure trap)
  ──────────────────────────────────────────────────────
  [ ] setApprovalForAll(CTFExchange, true)         on CTF
  [ ] setApprovalForAll(NegRiskCtfExchange, true)  on CTF
  [ ] setApprovalForAll(NegRiskAdapter, true)      on CTF

  VERIFICATION
  ────────────
  [ ] Test buy of $1 completes via the bot
  [ ] Test GTC sell is returned by GET /orders with LIVE status
  [ ] Both a standard AND a negRisk market can be traded
```

---

# Appendix A: Contract addresses (Polygon mainnet)

```
 USDC.e                   0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
 CTF (ERC-1155)           0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
 CTFExchange              0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
 NegRiskCtfExchange       0xC5d563A36AE78145C45a50134d48A1215220f80a
 NegRiskAdapter           0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296

 CLOB host                https://clob.polymarket.com
 Gamma API (markets)      https://gamma-api.polymarket.com
 Data API (positions)     https://data-api.polymarket.com
```

---

# Appendix B: Common failure modes & diagnoses

```
 ┌─────────────────────────────────────────────────────────────────┐
 │ SYMPTOM                          LIKELY CAUSE                   │
 ├─────────────────────────────────────────────────────────────────┤
 │ "invalid signature"           ▶  Wrong POLYMARKET_SIG_TYPE      │
 │                                                                 │
 │ "allowance not enough"        ▶  Missing USDC or CTF allowance  │
 │   on buy                         for that market type           │
 │                                                                 │
 │ GTC sell returns ok but       ▶  Missing CTF                    │
 │   never appears on book          setApprovalForAll              │
 │                                                                 │
 │ Orders work on standard       ▶  NegRisk allowances not set     │
 │   markets but not on             (either USDC or CTF side)      │
 │   multi-outcome                                                 │
 │                                                                 │
 │ "DNS cache overflow" or       ▶  Edge/CDN flake — usually       │
 │   503 from CLOB                  transient, retry in 30s        │
 │                                                                 │
 │ Funds not visible in the      ▶  Sent native USDC instead of    │
 │   proxy balance                  USDC.e, or sent to EOA         │
 │                                  instead of proxy               │
 │                                                                 │
 │ Bot sees balance but can't    ▶  USDC.e on proxy but allowances │
 │   trade                          not run — check Parts 7 & 8    │
 └─────────────────────────────────────────────────────────────────┘
```

---

# Appendix C: The one-time on-chain setup, as actual code

This is roughly what a setup function does. Run it once per wallet, save the
transaction hashes, and you're done forever.

```typescript
import { Wallet } from "@ethersproject/wallet";
import { StaticJsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

const USDC_ADDR            = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_ADDR             = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_EXCHANGE         = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER     = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const MAX = "0xff".repeat(32);

const provider = new StaticJsonRpcProvider("https://polygon.drpc.org", 137);
const wallet   = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!, provider);

const usdc = new Contract(USDC_ADDR, [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
], wallet);

const ctf  = new Contract(CTF_ADDR, [
  "function setApprovalForAll(address,bool) external",
  "function isApprovedForAll(address,address) view returns (bool)",
], wallet);

// USDC approvals (for BUYING on NegRisk — standard is handled by CLOB SDK)
for (const spender of [NEG_RISK_CTF_EXCHANGE, NEG_RISK_ADAPTER]) {
  if ((await usdc.allowance(wallet.address, spender)).isZero()) {
    await usdc.approve(spender, MAX);
  }
}

// CTF setApprovalForAll (for SELLING — all markets, incl. GTC limit sells)
for (const spender of [CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, NEG_RISK_ADAPTER]) {
  if (!(await ctf.isApprovedForAll(wallet.address, spender))) {
    await ctf.setApprovalForAll(spender, true);
  }
}
```

Five transactions on first run. Zero on every run after. The CLOB SDK handles
the standard-exchange USDC approval via `client.updateBalanceAllowance()`.

---

**End of doc.** If you got through all of this before writing your bot, you've
saved yourself a lot of pain.
