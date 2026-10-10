# FIXES-APPLIED.md — v2.2.1 "Deposit Wallet fix"

This build is the audited `poly-updown-bot-enhanced-V5` (v2.2.0) with six defects
fixed. Everything is in the code — you do **not** need to patch anything.

Full audit: see the workspace report `polymarket-bot-audit.md`.

---

## Quick start

```bash
# 1. dependencies are already vendored in node_modules/, so this is optional:
npm install

# 2. edit .env  (a safe starting file is included; at minimum set
#    POLY_PRIVATE_KEY and POLY_FUNDER_ADDRESS — see below)

# 3. pre-flight
npm run doctor

# 4. run
npm start            # dashboard: http://127.0.0.1:3000
```

The bot starts in **paper mode** with `DRY_RUN_ORDERS=true`. Enable live trading
only after `npm run doctor` reports no blockers.

### What goes in `.env`

| Variable | Value |
|---|---|
| `POLY_PRIVATE_KEY` | the signer key (Settings → Export Private Key), or a Session Key |
| `POLY_FUNDER_ADDRESS` | your **account wallet** from the profile menu (Deposit Wallet / proxy / Safe) — *not* the EOA |
| `POLY_SIGNATURE_TYPE` | `3` for accounts created on/after 2026-05-04 (default), `1` legacy Google/Magic Link, `2` legacy MetaMask Safe, `0` plain EOA |

Your funds must be in the **account wallet**, not on the EOA that holds the key.
Money sent to the EOA does not fund orders.

---

## What was fixed, and how it was verified

### 1. Deposit-Wallet (POLY_1271, type 3) order signing — **blocking**
**Was:** `signOrder()` put the **EOA** in the order's `signer` field and signed the
plain `Order` struct before wrapping it in the ERC-7739 envelope. A Deposit Wallet
validates through ERC-1271 by re-hashing the **`TypedDataSign`** struct with its own
domain, so it could never validate that signature → every live order rejected.

**Now:** for type 3 the order's `signer` is the **Deposit Wallet** (matching `maker`),
and the inner signature is produced over the nested `TypedDataSign` struct —
`{ contents: Order, name: "DepositWallet", version: "1", chainId, verifyingContract:
<deposit wallet>, salt: 0x00…0 }` — exactly as Polymarket's official
`@polymarket/clob-client-v2` does. Legacy types 1/2/0 keep the raw `Order` signature,
byte-for-byte as before.

**Evidence:** `proof/verify-fix.js` signs the same order with this bot and with the
official SDK and compares. The full 317-byte signature is **byte-identical**, and the
inner signature recovers to the key owner.

### 2. L2 HMAC signed the path *with* the query string — **blocking**
**Was:** `signedRequest()` computed the HMAC over e.g.
`/balance-allowance?asset_type=COLLATERAL&signature_type=3`. Official clients sign the
**bare path** and send the query parameters separately, so the server rejected it →
HTTP 401 on every parameterised signed GET (i.e. the balance call), while the
parameterless connectivity check still passed.

**Now:** the HMAC is over the bare path; query params still go on the URL.

### 3. Balance cache was never refreshed — **blocking**
**Was:** the bot only read `/balance-allowance`, never
`/balance-allowance/update`. Polymarket's docs require the update call after funding
or approving, or its server-side cache keeps returning `0` for a freshly funded
Deposit Wallet.

**Now:** new `syncBalanceAllowance()` hits `GET /balance-allowance/update` (throttled
to once per 60 s) before every balance read.

### 4. On-chain fallback was broken twice — **blocking**
**Was:** the pUSD address was `0x93070a84…B8ee`, which **is not a contract** on
Polygon (`symbol()` reverts); and the default RPC `polygon-rpc.com` now returns
`401 tenant disabled` for anonymous callers.

**Now:** pUSD is `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (verified on-chain:
`symbol()` returns `pUSD` — the same address Polymarket's SDK lists as `collateral`),
and the default RPC is a working public Polygon endpoint.

### 5. Dashboard forced the wrong wallet type — **correctness**
**Was:** the "Save & Verify Live Account" button hard-coded `signatureType: 1`,
never derived credentials, never persisted anything, and always alerted
*"Credentials saved and wallet verified!"*. The "Signature Type: Type 1 (POLY_PROXY)"
line was static text that never updated — so the dashboard disagreed with `.env`.

**Now:** a wallet-type selector (defaults to **3 — Deposit Wallet**), the chosen type
is actually sent, credentials are derived on save, the fake success alert is replaced
with the real result (account wallet + reported balance, or an honest failure), and
the Signature Type line renders live state.

*Note:* the dashboard's **email field is cosmetic** — it is stored in memory and never
used. Polymarket's CLOB API has no email field; it is not a misconfiguration in your
`.env`.

### 6. Network defaults contradicted the README — **security**
**Was:** `server.js` bound `0.0.0.0` and applied wildcard CORS (`origin: true`) on an
API that can place trades and accepts a private key.

**Now:** binds `127.0.0.1` and restricts CORS to localhost origins unless
`BIND_HOST` / `DASHBOARD_ORIGIN` are set explicitly.

---

## Verification summary (run on this exact tree)

```
108 unit tests + 11 integration tests ....... passed, 0 failed
proof/verify-fix.js ........................ all checks passed
  (a) POLY_1271 order
      ✓ order.signer is the Deposit Wallet
      ✓ order.maker / makerAmount / takerAmount match the official SDK
      ✓ signature byte-identical to the official SDK (317 bytes)
      ✓ inner signature recovers to the key owner (ERC-1271 will pass)
  (b) L2 header for GET /balance-allowance
      ✓ POLY_SIGNATURE matches the official SDK
      ✓ signature is over the path WITHOUT the query string
```

Re-run the proof yourself:

```bash
npm i @polymarket/clob-client-v2 viem     # in a scratch dir; viem + SDK are dev-only
NODE_PATH=/path/to/that/node_modules node proof/verify-fix.js
```

---

## What was NOT changed

Everything else in the original package is intact and was confirmed correct against
Polymarket's live API and official SDK: market discovery and slug scheme, Up/Down
outcome mapping by label, tick sizes and rounding tables, the 5-share minimum
("bump" policy), the `fee = rate·pᵉ·(1−p)ᵉ` maths, the V2 exchange addresses and
EIP-712 domain, L1 auth, the two WebSocket URLs, the `POST /order` wire body,
strategy gating, and the risk/circuit-breaker logic.

## Still on you (unchanged from the original notes)

- **Test with `DRY_RUN_ORDERS=true` first** — orders are signed but not submitted.
- Start with a small `TRADE_SIZE_USD` (the 5-share minimum at ≤$1/share is the floor).
- Confirm the exchange **allowance** is non-zero (approve pUSD in the Polymarket UI;
  the doctor flags it).
- **Key safety:** the private key in `.env` controls the wallet's funds. Keep `.env`
  at mode 600, never in the dashboard form on a shared machine, and prefer a scoped,
  time-limited **Session Key** over the owner key.
- **Redemption:** winning shares pay $1.00 but must be redeemed on-chain (or via the
  relayer) to realise cash; the bot logs a reminder at settlement.
- **Jurisdiction:** run this only where you are permitted to trade on Polymarket. From
  Hong Kong the bot's geoblock preflight passes, but the SFC/IFEC has warned that
  prediction-market trading may constitute illegal gambling locally — a personal legal
  call, not a technical one.
