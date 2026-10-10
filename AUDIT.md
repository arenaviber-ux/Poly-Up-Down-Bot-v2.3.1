# Compatibility Audit — "Poly Up Down Bot" vs Polymarket.com & Polymarket.us

**Audited artefact:** `download.bin` → ZIP of a Node.js project (`poly-updown-bot`, 11 files, ~3,650 lines, last modified 29 Sep 2026)
**Audit date:** 1 October 2026
**Method:** static code review + live probes against Polymarket's production APIs and WebSocket endpoints (results reproduced below)

---

## 1. Bottom line

| Target platform | Verdict | Reason |
|---|---|---|
| **polymarket.com** (global) | ❌ **Not compatible as shipped** — and **not usable from Australia even if fixed** | (a) The bot contains **zero** Polymarket WebSocket code, **zero** L1/L2 auth cryptography, and **zero** order-signing/submission code. "Live mode" is a stub that never sends an order. (b) **Australia is a "close-only" jurisdiction** on both frontend and API: new orders are rejected. |
| **polymarket.us** (US venue) | ❌ **Not compatible, different platform entirely** | Separate host (`api.polymarket.us`), different auth (`X-PM-*` headers), different WS protocol, US-only KYC onboarding, **no 5-minute markets** (15m/60m only), **whole contracts only** (no fractional shares), settlement on CF Benchmarks BRTI instead of Chainlink TWAP. |

**Headline:** the bot's *market discovery* works against the global platform (the `btc-updown-5m-{epoch}` slugs are real and live), but everything downstream of discovery — data streaming, authentication, order placement, settlement — is either missing or incompatible. Separately, **the account-level blocker matters more than the code**: Polymarket blocks *opening positions* from Australian IPs, so no amount of patching makes this legally/technically usable from Melbourne against polymarket.com.

---

## 2. Live evidence collected during this audit

All of the following were executed against production endpoints.

### 2.1 Market discovery works on the global platform
```
GET https://gamma-api.polymarket.com/events?slug=btc-updown-5m-1790861700
→ 200 OK, ticker: btc-updown-5m-1790861700
     title: "Bitcoin Up or Down - October 1, 9:35AM-9:40AM ET"
     conditionId: 0xc9f5603a385fd8d542ed56e586ec850a541b3ca44d558c3691a341da1773013a
     clobTokenIds: ["247648...44298", "588425...19498"]
     outcomes: ["Up","Down"]   outcomePrices: ["0.595","0.405"]
     negRisk: False   orderPriceMinTickSize: 0.01   orderMinSize: 5   acceptingOrders: True
```
Same result for the 15-minute slug. The bot's deterministic slug scheme is **correct** (today), and it also expands to `eth/sol/xrp/doge/bnb/zec/hype-updown-*`.

### 2.2 Market channel WebSocket — works, but the bot doesn't use it
```
wss://ws-subscriptions-clob.polymarket.com/ws/market
[SENT] {"assets_ids":["247648..."],"type":"market","custom_feature_enabled":true}
[SENT] PING
[RECV] {"market":"0xc9f5...","asset_id":"247648...","timestamp":"...","hash":"...",
        "bids":[{"price":"0.01","size":"4005.03"},...],"asks":[...]}   ← event_type "book"
[RECV] PONG
[RECV] {"market":"0xc9f5...","price_changes":[{"asset_id":"247648...","price":"0.99",
        "size":"49988.69","side":"BUY","best_bid":"0.999","best_ask":"1"}]}
→ 597 messages received in 14 seconds; app-level PING/PONG confirmed
```
Six distinct wire variants observed: `book`, `price_change`, `best_bid_ask`, `last_trade_price`, `new_market`, `tick_size_change` — all keyed by **`event_type`** on the raw wire (the SDK docs show a normalised snake_case `topic`/`type` envelope).

**Important wire-format gotcha:** the raw socket returns **snake_case** field names (`event_type`, `asset_id`, `price_changes`, `best_bid`, `fee_rate_bps`) — *not* the camelCase shown in some documentation examples (`priceChanges`, `tokenId`). Any hand-rolled parser must handle the live names.

### 2.3 User (private) channel requires in-frame L2 credentials
```
wss://ws-subscriptions-clob.polymarket.com/ws/user
[SENT] {"auth":{"apiKey":"","secret":"","passphrase":""},"markets":["0x111..."],"type":"user"}
[CLOSED] code=1008  reason="authentication failed"
```

### 2.4 REST order endpoint rejects the audit region (US IP)
```
POST https://clob.polymarket.com/order   → 403
{"error":"Trading restricted in your region, please refer to available regions - https://docs.polymarket.com/developers/CLOB/geoblock"}

GET https://polymarket.com/api/geoblock  → {"blocked":true,"ip":"136.86.194.72","country":"US","region":"OR"}
```

### 2.5 Polymarket US is a completely different API surface
```
GET https://api.polymarket.us/v1/ws/markets → 401 "unauthorized: valid API key authentication required"
GET https://api.polymarket.us/v1/ws/private → 401 "Missing required API key headers"
GET https://api.polymarket.us/v1/markets    → 401 "Missing required API key headers"
GET https://api.polymarket.us/v1/health     → 200
```

### 2.6 Reference-price feed (PolyBolt) is credentialed
```
wss://ws-live-v2.polymarket.com/ws  → [SENT] unauthenticated subscribe → [RECV] {"op":"error","code":"bad_op"}
```
Per docs this feed requires CLOB API credentials — this is the feed carrying **Chainlink crypto reference prices**, i.e. the series these markets actually settle on.

---

## 3. The five areas you asked about

### 3.1 Market Data WS (`wss://ws-subscriptions-clob.polymarket.com/ws/market`)

| | |
|---|---|
| **Required by Polymarket** | Subscribe with `{"assets_ids":[...],"type":"market","custom_feature_enabled":true}`; app-level `PING`/`PONG` every 10 s; events: `book`, `price_change`, `last_trade_price`, `tick_size_change` (+ `best_bid_ask`, `new_market`, `market_resolved` with custom features). Also available: RTDS `wss://ws-live-data.polymarket.com` (optional auth) for reference prices/trades, and `wss://sports-api.polymarket.com/ws`. |
| **What the bot has** | **Nothing.** `grep -r "wss\?://"` finds only Coinbase (`ws-feed.exchange.coinbase.com`) and Kraken (`ws.kraken.com`) in `priceFeeds.js`. |
| **How it actually gets prices** | `botCore.tick()` runs every **2,500 ms** and does **REST polling**: ~6 Gamma `events?slug=` calls + `GET https://clob.polymarket.com/book?token_id=…` (`marketDiscovery.js:96`). |
| **Verdict** | ❌ **Not implemented.** Functionally it can trade off REST (2.5 s stale on the book), but none of the requested WS integration exists. Note also: the bot's *reference* price source (Coinbase/Kraken spot) is **not the series the market settles on** — see §4.3. |

### 3.2 Private Data WS (`wss://ws-subscriptions-clob.polymarket.com/ws/user`)

| | |
|---|---|
| **Required** | Authenticated subscribe frame: `{"auth":{"apiKey":"…","secret":"…","passphrase":"…"},"type":"user"}` then `{"operation":"subscribe","markets":["0x<conditionId>"]}`; events `order` and `trade`; `{}` ping/pong. |
| **What the bot has** | **Nothing.** `polymarketAuth.js` *stores* `apiKey`/`apiSecret`/`apiPassphrase` if you type them in, but never derives them, never signs anything, and never opens a socket. Verified live: a creds-less connection is closed with **1008 `authentication failed`**. |
| **Verdict** | ❌ **Not implemented; would fail even with stored keys**, because the L2 credentials it wants you to paste are not derivable from a private key by anything in this codebase (§3.3). |

### 3.3 Auth Cryptography

| | |
|---|---|
| **Required by Polymarket (global)** | **L1:** sign an EIP-712 `ClobAuth` typed-data payload (domain `ClobAuthDomain`, v1, chainId 137; fields `address`, `timestamp`, `nonce`, `message`) → `POST /auth/api-key` or `GET /auth/derive-api-key` with `POLY_ADDRESS`/`POLY_SIGNATURE`/`POLY_TIMESTAMP`/`POLY_NONCE` → returns `{apiKey, secret, passphrase}`. **L2:** per-request `HMAC-SHA256(base64Decode(secret), timestamp + METHOD + path + body)`, output **URL-safe base64 with padding**. **Orders:** EIP-712 `Order` typed data on domain `Polymarket CTF Exchange` **v2**, struct `{salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder}`; exchange `0xE111180000d2663C0091e4f400237545B87B996B` (standard) or `0xe2222d279d744050d28e00520010520000310F59` (neg-risk). |
| **What the bot has** | `polymarketAuth.js` imports `ethers` but uses it for exactly one thing: constructing a `Wallet` from your private key to display its address, and reading a USDC ERC-20 balance from `polygon-rpc.com`. There is **no** `signTypedData`, **no** HMAC, **no** `/auth/api-key` or `/auth/derive-api-key` call, **no** order hashing. Verified live: calling the derive endpoint with no L1 headers returns `401 "Invalid L1 Request headers"`. |
| **Verdict** | ❌ **Absent.** The `signatureType = 1 // POLY_PROXY` label in the code is correct terminology, but nothing consumes it. Two further risks: (1) `funderAddress` defaults to the **signer** address when not supplied (`polymarketAuth.js:53`) — for a Google/Magic-Link account the funder must be the **proxy wallet**, so this silently builds wrong orders; (2) current docs also list a **Deposit Wallet / signatureType 3** path (ERC-7739 wrapped signatures) that the code has no concept of. |

### 3.4 Auth Injection

| | |
|---|---|
| **Required (global REST)** | Headers `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE` on every private request. |
| **Required (global WS)** | Credentials go **inside the subscribe frame** (`auth:{…}`) for `/ws/user`; the market channel needs no auth. |
| **Required (polymarket.us)** | Completely different: handshake headers `X-PM-Access-Key`, `X-PM-Timestamp` (ms), `X-PM-Signature` = base64 of `timestamp + "GET" + path`. Verified: `401 Missing required API key headers`. |
| **What the bot has** | One hard-coded `User-Agent: Mozilla/5.0` header in a helper (`marketDiscovery.js:5`). No POLY_* headers, no X-PM_* headers, no WS auth frames. |
| **Verdict** | ❌ **Absent on both platforms.** |

### 3.5 Asset Identifier

| | |
|---|---|
| **Required** | Market channel subscribes by **asset ID** = the ERC-1155 position token ID (long decimal string, one per outcome). User channel subscribes by **condition ID** (`0x` + 64 hex). REST `/book?token_id=` uses the asset ID. Orders carry `tokenId` (uint256). |
| **What the bot has** | It parses `clobTokenIds` from Gamma and assigns `upTokenId = tokenIds[0]`, `downTokenId = tokenIds[1]`, keeping `conditionId` unused. |
| **Verdict** | 🟡 **Correct values, fragile assumption.** Verified today: `outcomes: ["Up","Down"]` so index 0 really is Up. But the mapping is positional with no check against the `outcomes` array, and it never uses `conditionId` (because it has no user channel). Any market whose outcomes are ordered differently would be traded inverted — the worst possible silent failure for a directional bot. |

---

## 4. Additional blockers found outside the five areas (all decisive)

### 4.1 "Live mode" never places an order — it is a simulator with a live label
`botCore.js` (live branch of `executeTrade`):
```js
this.log('INFO', `[LIVE ORDER] Submitting order to Polymarket CLOB for ${side} token ${tokenId}...`);
// Simulating / executing signed order
this.activePositions.push(position);
```
No HTTP POST, no signature, no response handling. Because of that:
- Live P&L is fictional: `settlePositions()` resolves a trade by checking `market.priceUp >= 0.99`, else by comparing **current spot** to **spot at entry** — not the market's actual resolution.
- `settlePositions()` only searches markets returned by the current discovery window, so an expired market usually isn't found and the fallback path silently invents the winner.

### 4.2 Geographic restriction — the hard stop for your use case
Polymarket's own geoblock documentation lists **Australia (AU) as "Regulatory-Restricted (close-only on frontend and API)"** — you can close existing positions but **cannot open new ones**, from either the UI or the API. The US, UK, NZ, Singapore, France, Germany, Canada (BC/ON/AB/QC) and others are in the same close-only bucket; Iran/Syria/Cuba/NK/Crimea/Donetsk/Luhansk are blocked outright. My probe confirms the enforcement path is live (`{"blocked":true,...}` and a 403 on `POST /order`).

Consequences for you:
- Running this bot **from Melbourne against polymarket.com** will have its orders rejected; paper mode will "work" and give a completely false impression of viability.
- Routing around it (VPS/VPN in an unblocked region) is deliberate circumvention of Polymarket's access terms while you remain in a restricted jurisdiction — account closure/withdrawal-freezing risk on top of the regulatory issue. The repo's own co-location offer (eu-west-2) is explicitly gated by KYC/KYB.
- **polymarket.us is not the workaround**: it is a CFTC-regulated venue with mandatory KYC (name, DOB, residential address, possibly ID + selfie), funded by card/ACH/wire in USD, and it is aimed at US participants.

### 4.3 The bot is trading the wrong price series
Every BTC up/down market on the global platform carries this resolution text:
> resolves "Up" if the **time-weighted average price (TWAP) of Bitcoin, generated by Chainlink** … resolution source: `https://data.chain.link/streams/btc-usd-twap-60s-streams`.

The bot's entire edge stack — latency exploitation on Coinbase/Kraken spot, "$12 cross-exchange divergence", "fair value from spot vs window-open", "window open price" anchoring — is computed from **spot exchanges**, while the market settles on a **60-second Chainlink TWAP**. A single Coinbase print cannot move the settlement series the way the bot assumes, and the "window open" it records is not the TWAP open. This invalidates the strategy premises regardless of API compatibility.

### 4.4 Order-constraint violations
- **Minimum order size = 5 shares** (live `/book` → `min_order_size: "5"`; Gamma → `orderMinSize: 5`), not the "$1.00 minimum" the README/UI claim. The default **$2.00** trade implies `2/price` shares → **below 5 shares whenever price > $0.40**, the normal case for these markets. Orders will be rejected.
- **Tick size** is `0.01` today but can change to `0.001` (`tick_size_change` event); the docs require per-tick price/size/amount decimal rounding rules that the code doesn't implement.
- **`neg_risk`** is `false` for BTC up/down today, but the code has no neg-risk branch at all — if it toggles, both the exchange contract and the signature path change.

### 4.5 Crypto-specific gaps on the US venue (why .us is a rewrite, not a port)
- Windows are **15-minute and 60-minute only** — the bot's default 5-minute mode has **no market on polymarket.us**.
- **No fractional contracts** (whole contracts only) — the bot's `shares = cost / price` model is invalid there.
- The window **open price is fixed a few seconds *after* window start** (`assetPriceTerms.priceToBeat`) — the bot assumes it can anchor the open at window start.
- Settlement is **CF Benchmarks BRTI** (60-print simple average `[T−59s, T]`), not Chainlink TWAP.
- WS: `{"subscribe":{"request_id":…,"subscription_type":1|2|3,"market_slugs":[…]}}`, JSON heartbeats, snake_case payloads; REST `GET /v1/markets?categories=crypto&closed=false`. Nothing in this repo resembles this.

### 4.6 Security / operational notes
- `app.use(cors())` — wide-open CORS on a service that accepts a **private key** via `POST /api/auth/configure` (`server.js:98`). Any web page open in the same browser can reach `http://localhost:3000` and drive it. The key isn't persisted to `bot_state.json` (good) but lives in process memory and is submitted over plain HTTP.
- The README instructs users to **export a private key** whose compromise means loss of the proxy wallet's funds. That plus a wide-open local API is a poor security posture for something advertised as production trading software.
- `package.json` has no `start` script (`main: index.js`, which doesn't exist); `node server.js` is the documented path — fine, but the packaging is sloppy.

---

## 5. So what *would* work on polymarket.com (effort + spec)

If you were in an eligible jurisdiction, the minimum viable patch set is:

1. **Add the market WebSocket** (replace 2.5 s REST polling in `botCore`):
   ```js
   ws.send(JSON.stringify({ assets_ids:[upId, downId], type:'market', custom_feature_enabled:true }));
   // maintain in-memory book from event_type: book (snapshot) / price_change (deltas)
   // send 'PING' every 10s, expect 'PONG'; reconnect with backoff on close
   ```
   Parse raw wire names: `event_type`, `asset_id`, `price_changes`, `best_bid`, `best_ask`, `fee_rate_bps`. Handle `market_resolved` for real settlement instead of guessing from spot.
2. **Add L1 credential derivation** (`ethers` v6 already present): `signTypedData` on `ClobAuthDomain`/chainId 137 → `GET /auth/derive-api-key`, cache `{apiKey, secret, passphrase}`.
3. **Add L2 request signing**: `HMAC-SHA256(base64decode(secret), ts + "GET" + "/data/orders")` → URL-safe base64 w/ padding, injected as the five `POLY_*` headers.
4. **Add order signing + submission**: EIP-712 `Order` on `Polymarket CTF Exchange` **v2**, `maker` = proxy wallet (funder), `signer` = EOA from the exported key, `signatureType` 1 (or 3 if it's a Deposit Wallet), `makerAmount`/`takerAmount` in 6-decimals, then `POST /order`. Or skip all of this and use the maintained SDKs — `@polymarket/client` (v0.11.0, TypeScript), `@polymarket/clob-client` (v5.8.1, the CommonJS one that matches this repo's style), or `py-clob-client`.
5. **Add the user WebSocket** for fill truth: `{"auth":{apiKey,secret,passphrase},"type":"user"}` then `{"operation":"subscribe","markets":[conditionId]}`; drive P&L from `trade` events, not from spot comparisons.
6. **Enforce order constraints**: ≥ 5 shares, tick-conformant rounding, project `tick_size`/`neg_risk` from `/book` (or `tick_size_change` events) before every order.
7. **Replace the reference price** with the Chainlink-based crypto feed (`wss://ws-live-v2.polymarket.com/ws`, PolyBolt, CLOB-credentialed) or your own Chainlink TWAP read, and rebuild the 8 strategies around *TWAP-vs-price-to-beat* rather than spot momentum.
8. **Wire in the geoblock check** (`GET https://polymarket.com/api/geoblock`) as a hard preflight before any live order, so the bot can't silently fire into a rejection.

Realistically that's a near-rewrite of `botCore.js`, `polymarketAuth.js` and `strategyEngine.js` — the good news is `marketDiscovery.js`'s slug logic and the dashboard/UI scaffolding survive.

---

## 6. Practical recommendation

1. **Don't point this at live money on polymarket.com from Australia.** Orders from AU IPs are rejected by policy; any workaround undermines your account's standing. Same reasoning rules out `polymarket.us` unless you're a KYC-verified US participant — and even then, this bot isn't the right codebase (no 5-minute windows, no fractional shares, different API in every layer).
2. **If you keep it, keep it in paper mode only** — but fix the three things that make paper results meaningless: use the Chainlink TWAP series (not Coinbase/Kraken spot), apply the 5-share minimum and tick rounding, and mark to the actual `market_resolved` outcome. Otherwise the dashboard numbers are noise.
3. **If you want a real, supported integration**, build on `@polymarket/client` / `clob-client` / `py-clob-client` in an eligible region rather than hand-rolling EIP-712 + HMAC, and keep the execution host's geoblock status clean.
4. Treat the README's claims ("live order routing", "export private key to trade live", "$1 minimum") as **marketing, not documentation** — each is inaccurate against today's platform.

---

### Appendix — verified reference facts

| Item | Value |
|---|---|
| Market WS | `wss://ws-subscriptions-clob.polymarket.com/ws/market` (no auth) |
| User WS | `wss://ws-subscriptions-clob.polymarket.com/ws/user` (in-frame L2 creds) |
| Reference prices (RTDS) | `wss://ws-live-data.polymarket.com`; PolyBolt `wss://ws-live-v2.polymarket.com/ws` (CLOB creds) |
| REST | Gamma `https://gamma-api.polymarket.com`; CLOB `https://clob.polymarket.com`; Data `https://data-api.polymarket.com` |
| L1 | EIP-712 `ClobAuthDomain` v1, chainId 137 → `/auth/api-key` \| `/auth/derive-api-key` |
| L2 | `HMAC-SHA256(base64decode(secret), ts+METHOD+path+body)` → url-safe base64 |
| REST auth headers | `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE` |
| Order EIP-712 | domain `Polymarket CTF Exchange` v2, chainId 137; exchange `0xE11118…B996B` / neg-risk `0xe2222d…310F59` |
| Wallet types | 0 EOA, 1 Proxy, 2 Safe, 3 Deposit Wallet |
| Market constraints (BTC up/down) | `min_order_size` 5 shares, `tick_size` 0.01, `neg_risk` false |
| Settlement (global) | Chainlink BTC/USD 60 s TWAP stream |
| Heartbeat | Market/User channel: text `PING` → `PONG` every 10 s |
| US venue | `wss://api.polymarket.us/v1/ws/markets` & `/v1/ws/private`; headers `X-PM-Access-Key`/`X-PM-Timestamp`/`X-PM-Signature` (base64 of `ts+"GET"+path`); 15m/60m windows; BRTI settlement; whole contracts; mandatory KYC |
| Geoblock | `GET https://polymarket.com/api/geoblock`; **AU = close-only (frontend + API)** |
