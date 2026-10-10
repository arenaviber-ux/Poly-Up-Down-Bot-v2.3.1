#!/usr/bin/env node
'use strict';
/**
 * Pre-flight doctor. Run this before you ever think about live money:
 *
 *     npm run doctor
 *
 * It checks configuration, wallet wiring, credentials, geoblock, on-chain
 * exchange approvals, market discovery, both WebSockets, the reference feeds
 * and the fee/tick/min-order constraints of the market you are about to trade —
 * and exits non-zero if anything would block a live order.
 *
 *     npm run doctor              check everything, change nothing
 *     npm run doctor -- --approve also grant any missing exchange approvals
 */
const { CONFIG, validateConfig, effectivePaperMode } = require('../config');
const { BotCore } = require('../botCore');
const { PolymarketAuth } = require('../polymarketAuth');
const { ClobClient, SIGNED_ORDER_VERSION } = require('../clobClient');
const { RelayerClient } = require('../relayerClient');
const { EXCHANGES } = require('../contracts');
const { MarketDiscovery } = require('../marketDiscovery');
const { MarketStream } = require('../wsMarket');
const { ReferencePrice } = require('../referencePrice');
const { signOrder, sizeOrder, computeBuyAmounts, tickRules } = require('../orderSigner');
const { feePerShare } = require('../pricing');
const { Wallet } = require('ethers');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// `--approve` turns the doctor from read-only into a repair tool: it submits the
// missing approvals through the gasless relayer and re-checks.
const DO_APPROVE = process.argv.slice(2).some(a => ['--approve', '-a', 'approve'].includes(a));
let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const warn = (m) => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${m}`); };
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

(async function main() {
  console.log('\n\x1b[1mPoly Up/Down Bot — pre-flight doctor\x1b[0m');
  // Report the mode the bot will actually run in. A saved bot_state.json
  // overrides PAPER_MODE, so reading the config value here said PAPER while the
  // server came up LIVE — a pre-flight check that contradicts the thing it checks.
  const eff = effectivePaperMode(CONFIG);
  console.log(`  asset: ${CONFIG.market.asset.toUpperCase()} · timeframes: ${CONFIG.market.timeframes.join(', ')} · mode: ${eff.paperMode ? 'PAPER' : 'LIVE'}`
    + (eff.source !== 'env' ? `  (PAPER_MODE=${CONFIG.runtime.paperMode}, overridden by ${eff.source})` : ''));

  head('1. Configuration');
  const errs = validateConfig(CONFIG);
  if (errs.length) errs.forEach(e => bad(e));
  else ok('configuration is internally consistent');

  head('2. Wallet wiring');
  const auth = new PolymarketAuth(CONFIG);
  // The sizing the live bot will actually use: .env, unless bot_state.json replaces it.
  // Read from a BotCore rather than CONFIG so this cannot disagree with the bot. Its
  // constructor starts no timers and opens no sockets; those begin in start().
  const bot = new BotCore({ config: CONFIG, auth, log: () => {} });
  ok(`sizing: stake $${bot.tradeAmountUsd} (${bot.sizingSourceLabel('tradeAmountUsd')}) · cap $${bot.maxTradeAmountUsd} (${bot.sizingSourceLabel('maxTradeAmountUsd')})`
    + ` · Kelly ${bot.kellySizing ? 'on' : 'off'} (${bot.sizingSourceLabel('kellySizing')})`);
  for (const note of bot.sizingIgnored) warn(note);
  const st = auth.getStatus();
  console.log(`  signature type: ${st.signatureType} (${st.signatureTypeName})`);
  if (st.signerAddress) ok(`signer key loaded: ${st.signerAddressFull}`);
  else warn('no POLY_PRIVATE_KEY — live signing unavailable (paper mode still works)');
  if (st.signatureType !== 0) {
    if (st.accountWalletFull) ok(`account wallet (maker): ${st.accountWalletFull}`);
    else bad('POLY_FUNDER_ADDRESS is required for signature types 1/2/3');
  }
  const v = auth.validateWalletSetup();
  if (!v.ok) bad(v.error);
  if (auth.wallet && st.accountWalletFull && auth.wallet.address.toLowerCase() === String(st.accountWalletFull).toLowerCase() && st.signatureType !== 0) {
    bad('account wallet equals the signer EOA — funds live in the account wallet, orders would fail');
  }

  head('3. Geoblock');
  const geo = await auth.checkGeoblock();
  if (geo.blocked === null) warn(`geoblock check failed: ${geo.error}`);
  else if (geo.blocked) bad(`blocked in ${geo.country}${geo.region ? '/' + geo.region : ''} — Polymarket rejects new orders from here`);
  else ok(`not blocked (${geo.country}${geo.region ? '/' + geo.region : ''})`);

  head('4. CLOB credentials & balance');
  if (!auth.hasL2Credentials()) {
    if (auth.wallet) {
      try {
        await auth.deriveApiCredentials();
        ok(`derived L2 credentials (source: ${auth.credentialsSource})`);
      } catch (e) {
        bad(`could not derive credentials: ${e.message}`);
      }
    } else warn('skipped (no private key)');
  } else ok(`credentials present (source: ${auth.credentialsSource})`);

  const clob = new ClobClient(CONFIG, auth);
  if (auth.hasL2Credentials()) {
    const ping = await clob.pingPrivate().catch(e => ({ ok: false, error: e.message }));
    if (ping.ok) ok('L2-authenticated request accepted (/data/orders)');
    else bad(`L2 authentication failed: ${ping.error || ping.status}`);
    const bal = await auth.checkBalanceAllowance().catch(() => null);
    if (bal && bal.ok) {
      if (bal.balance > 0) ok(`CLOB collateral balance $${bal.balance.toFixed(2)}`);
      else warn('CLOB collateral balance is $0.00 — deposit funds before going live');
      // CLOB V2 reports allowances per spender (`allowances: { exchange: units }`),
      // not one singular number. Show what the cache actually holds.
      const named = Object.entries(bal.allowances || {});
      if (named.length) {
        for (const [ex, v] of named) {
          const label = ex.toLowerCase() === EXCHANGES.standard.toLowerCase() ? 'CTF Exchange'
            : ex.toLowerCase() === EXCHANGES.negRisk.toLowerCase() ? 'Neg Risk CTF Exchange' : ex;
          if (v === null) warn(`  CLOB allowance cache: ${label} not reported`);
          else if (v > 0) ok(`  CLOB allowance cache: ${label} $${v.toFixed(2)}`);
          else bad(`  CLOB allowance cache: ${label} is 0`);
        }
      } else if (bal.legacyAllowance !== null) {
        if (bal.allowance > 0) ok(`CLOB allowance cache: $${bal.allowance.toFixed(2)} (legacy single-allowance response)`);
        else bad('CLOB allowance cache: $0.00');
      } else {
        warn('the CLOB returned no allowance data at all — the on-chain check below is authoritative');
      }
    } else warn(`balance/allowance unavailable${bal && bal.error ? ` (${bal.error})` : ''}`);
  }

  head('5. Exchange approvals (on-chain, authoritative)');
  const relayer = new RelayerClient(CONFIG, auth);
  if (!relayer.isConfigured()) {
    warn('relayer not configured (RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS) — approvals cannot be granted gaslessly');
  }
  let approvals = await relayer.readTradingApprovals();
  if (!approvals.ok && approvals.error) {
    bad(`could not read approvals on-chain: ${approvals.error}`);
  }
  for (const c of approvals.checks || []) {
    const detail = c.kind === 'erc20'
      ? (c.allowance === null ? 'unreadable' : `$${c.allowance.toFixed(2)}`)
      : (c.approved === null ? 'unreadable' : (c.approved ? 'approved' : 'not approved'));
    if (c.error) bad(`  ${c.label}: ${detail} (${c.error})`);
    else if (c.granted) ok(`  ${c.label}: ${detail}`);
    else bad(`  ${c.label}: ${detail} — every order on this exchange is rejected`);
  }
  const missing = approvals.missing || [];
  if (missing.length || (!approvals.ok && DO_APPROVE)) {
    // The other half of the same failure: approvals granted, funds in the wrong
    // wallet. Both read as "not enough balance / allowance" from POST /order.
    const chainBal = await auth.checkOnChainBalance().catch(() => null);
    if (chainBal && chainBal.ok) {
      if (chainBal.pUSD > 0) ok(`account wallet holds $${chainBal.pUSD.toFixed(2)} pUSD on-chain`);
      else bad(`the account wallet holds $0.00 pUSD on-chain${chainBal.usdce > 0 ? ` (it holds $${chainBal.usdce.toFixed(2)} USDC.e, which is not tradeable — wrap it via the CollateralOnramp)` : ''}`);
      if (auth.signatureType !== 0 && auth.signerAddress) {
        const eoaBal = await auth.checkOnChainBalance({ owner: auth.signerAddress }).catch(() => null);
        if (eoaBal && eoaBal.ok && eoaBal.pUSD > 0) {
          bad(`$${eoaBal.pUSD.toFixed(2)} pUSD is sitting on the signer EOA — transfer it to the account wallet, the CLOB cannot spend it there`);
        }
      }
    }
    if (DO_APPROVE) {
      console.log('  granting the missing approvals via the relayer…');
      // force: the chain could not be read, so approve everything rather than
      // trusting an empty "missing" list produced by the RPC failure.
      const res = await relayer.setupTradingApprovals({ force: !approvals.ok })
        .catch(e => ({ ok: false, error: e.message }));
      if (res.ok) {
        ok(`approvals granted${res.transactionHash ? ` (tx ${String(res.transactionHash).slice(0, 18)}…)` : ''}`);
        approvals = await relayer.readTradingApprovals();
        if (!approvals.ok) {
          bad(`the approvals were submitted but could not be re-read (${approvals.error}) — set POLYGON_RPC to a reachable node and re-run`);
        }
        for (const c of approvals.checks || []) {
          if (c.error) continue;
          if (c.granted) ok(`  ${c.label}: now granted`);
          else bad(`  ${c.label}: still missing`);
        }
        const synced = await auth.syncBalanceAllowance({ force: true }).catch(() => null);
        if (synced && synced.ok) ok('CLOB balance/allowance cache refreshed');
      } else {
        bad(`could not grant the approvals: ${res.error || 'unknown error'}`);
      }
    } else {
      bad(`run \`npm run approve\` (or \`npm run doctor -- --approve\`) to grant ${missing.length} missing approval(s) `
        + 'from the account wallet — an EOA approve() does not work for a Deposit Wallet/Safe/proxy');
    }
  } else if (approvals.ok && (approvals.checks || []).length) {
    ok(`all ${(approvals.checks || []).length} required approvals are in place (both V2 exchanges + both collateral adapters)`);
  } else if (!approvals.ok) {
    // An RPC outage reads as "nothing missing". Reporting that as granted is the
    // one answer this check must never give.
    bad('the exchange approvals could not be verified on-chain — point POLYGON_RPC at a reachable Polygon node and '
      + 're-run, or `npm run approve -- --force` to re-approve without reading first');
  }

  head('6. Market discovery');
  const discovery = new MarketDiscovery(CONFIG, { log: () => {} });
  const markets = await discovery.getMarkets();
  if (!markets.length) { warn('no markets discovered (check ASSET/TIMEFRAMES)'); }
  else {
    ok(`${markets.length} window(s) discovered`);
    for (const m of markets.slice(0, 3)) {
      const line = `${m.slug} · ends in ${Math.round(m.remainingSec)}s · tick ${m.tickSize} · min ${m.minOrderSize} shares · fee ${m.feeSchedule ? m.feeSchedule.rate : '?'}`;
      if (!m.tokenMappingOk) bad(`${line} → OUTCOME MAPPING INVALID (${m.tokenMappingNote})`);
      else if (m.protocolV2) bad(`${line} → PROTOCOL V2 (ExchangeV3 position IDs) — this bot signs CTF orders and cannot trade it`);
      else if (m.started && m.remainingSec > 0) ok(`${line} → tradeable${m.marketVersion ? ` (version ${m.marketVersion})` : ''}`);
      else ok(`${line}`);
      // Order-constraint maths for a default-sized order.
      const price = m.bestAsk || 0.5;
      const sizing = sizeOrder({
        stakeUsd: bot.tradeAmountUsd, price,
        minShares: m.minOrderSize || CONFIG.order.minShares,
        tickSize: m.tickSize || CONFIG.order.tickSize,
        maxStakeUsd: bot.maxTradeAmountUsd, minOrderPolicy: CONFIG.order.minOrderPolicy,
      });
      if (sizing.ok) {
        const amounts = computeBuyAmounts(price, sizing.shares, m.tickSize || CONFIG.order.tickSize);
        const fee = feePerShare(amounts.price, m.feeSchedule || { rate: CONFIG.fees.defaultTakerRate }) * sizesharesSafe(sizing);
        ok(`  order preview: ${sizing.shares} shares @ ${amounts.price} = $${amounts.usd.toFixed(2)} (+~$${fee.toFixed(3)} fee)${sizing.bumped ? ' [raised to the market minimum]' : ''}`);
      } else bad(`  sizing: ${sizing.reason}`);
    }
  }
  function sizesharesSafe(s) { return s.shares; }

  head('7. Reference feeds (settlement series)');
  const ref = new ReferencePrice(CONFIG, auth, { log: () => {} });
  ref.start();
  await sleep(6000);
  const h = ref.health();
  if (h.twapAuthoritative) ok(`Chainlink 60s TWAP live: ${h.twap}`);
  else if (h.twapSource) warn(`TWAP proxy in use (${h.twapSource}: ${h.twap && h.twap.toFixed(2)}) — strategies widen thresholds. ${h.polybolt.lastError || 'authenticate to enable the real TWAP feed'}`);
  else bad('no TWAP source available');
  if (h.coinbase.price) ok(`Coinbase ${h.coinbase.price}`);
  else warn('Coinbase feed not connected');
  if (h.kraken.price) ok(`Kraken ${h.kraken.price}`);
  else warn('Kraken feed not connected');

  head('8. Market WebSocket');
  const ms = new MarketStream(CONFIG, { log: () => {} });
  const live = markets.filter(m => m.tradeable).slice(0, 1)[0] || markets[0];
  if (live) {
    ms.setAssets([live.upTokenId, live.downTokenId].filter(Boolean));
    ms.connect();
    await sleep(6000);
    const book = ms.getBook(live.upTokenId);
    if (ms.isFresh()) ok(`connected, receiving data (${ms.isFresh() ? 'fresh' : 'stale'})`);
    else bad('no messages received on the market socket');
    if (book) {
      ok(`book: bid ${book.bestBid} / ask ${book.bestAsk} · spread ${book.spread} · ask depth $${book.askDepthUsd.toFixed(0)}`);
      if (book.minOrderSize !== null && book.minOrderSize !== (live.minOrderSize || null)) warn(`min order size differs between book (${book.minOrderSize}) and Gamma (${live.minOrderSize})`);
      if (book.bestAsk !== null && book.spread * 100 > CONFIG.risk.maxSpreadCents) warn(`spread ${(book.spread * 100).toFixed(1)}c exceeds MAX_SPREAD_CENTS (${CONFIG.risk.maxSpreadCents}) — the bot will stand down`);
      if (book.askDepthUsd < CONFIG.risk.minBookDepthUsd) warn(`ask depth $${book.askDepthUsd.toFixed(0)} below MIN_BOOK_DEPTH_USD (${CONFIG.risk.minBookDepthUsd})`);
    } else bad('no book available for the active window');
  } else warn('no tradable window to test the socket against');

  head('9. Order signing (dry run)');
  if (auth.wallet && auth.funderAddress) {
    try {
      const m0 = live || markets[0];
      const price = 0.5;
      const sizing = sizeOrder({
        stakeUsd: bot.tradeAmountUsd, price,
        minShares: (m0 && m0.minOrderSize) || 5,
        tickSize: (m0 && m0.tickSize) || 0.01,
        maxStakeUsd: bot.maxTradeAmountUsd, minOrderPolicy: CONFIG.order.minOrderPolicy,
      });
      const amounts = computeBuyAmounts(price, sizing.shares || 5, (m0 && m0.tickSize) || 0.01);
      const signed = await signOrder(auth.wallet, {
        tokenId: (m0 && m0.upTokenId) || '1',
        side: 'BUY',
        maker: auth.funderAddress,
        signer: auth.signerAddress,
        signatureType: auth.signatureType,
        negRisk: !!(m0 && m0.negRisk),
        makerAmount: amounts.makerAmount,
        takerAmount: amounts.takerAmount,
        chainId: CONFIG.chainId,
      });
      ok(`EIP-712 order signed (${auth.signatureType === 3 ? 'ERC-7739 wrapped for Deposit Wallet' : 'raw signature'}), exchange ${signed.verifyingContract}`);
      ok(`  maker ${signed.order.maker} · signer ${signed.order.signer} · ${signed.order.makerAmount} / ${signed.order.takerAmount}`);
      console.log('  (nothing was submitted)');

      // The exchange contract above is chosen by the order version the server
      // is accepting right now. A mismatch is a hard rejection
      // (order_version_mismatch), so check it here rather than on live money.
      const ver = await clob.getOrderVersion(true).catch(e => ({ ok: false, error: e.message }));
      if (!ver.ok) warn(`could not read the CLOB order version (${ver.error}) — assuming ${SIGNED_ORDER_VERSION}`);
      else if (ver.version !== SIGNED_ORDER_VERSION) {
        bad(`the CLOB is accepting order version ${ver.version}, but this bot signs for version ${SIGNED_ORDER_VERSION} `
          + '(the CLOB V2 CTF exchanges) — every live order will be rejected with order_version_mismatch');
      } else ok(`the CLOB is accepting order version ${ver.version}, which is what this bot signs for`);
    } catch (e) {
      bad(`signing failed: ${e.message}`);
    }
  } else warn('skipped (wallet not fully configured)');

  ms.disconnect();
  ref.stop();

  console.log(`\n\x1b[1mResult:\x1b[0m ${failures === 0 ? '\x1b[32mready\x1b[0m' : `\x1b[31m${failures} blocker(s)\x1b[0m`}${warnings ? `, ${warnings} warning(s)` : ''}\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nDoctor crashed:', e.message);
  process.exit(2);
});
