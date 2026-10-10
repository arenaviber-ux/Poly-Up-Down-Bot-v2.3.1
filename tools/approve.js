#!/usr/bin/env node
'use strict';
/**
 * Grant the trading approvals a Polymarket account wallet needs, then verify.
 *
 *     npm run approve              grant whatever is missing, then verify
 *     npm run approve -- --check   read-only: report what is missing, change nothing
 *     npm run approve -- --force   re-approve even when already granted
 *
 * What it does, and why it cannot be done in the Polymarket UI:
 *
 *   Before an order can settle, the account wallet (POLY_FUNDER_ADDRESS) must
 *   have approved both CLOB V2 exchanges twice — pUSD via ERC-20 `approve()` and
 *   the conditional tokens via ERC-1155 `setApprovalForAll()`. Four approvals.
 *
 *   An `approve()` sent from the signer EOA does nothing here: the allowance has
 *   to be granted *by the wallet that holds the funds*. On Polymarket that
 *   wallet is a Deposit Wallet / Safe / proxy, so the calls go through the
 *   gasless relayer as one signed batch — no POL, no MetaMask prompt.
 *
 *   Missing approvals surface as
 *     POST /order -> 400 "not enough balance / allowance: the balance is not enough"
 *     GET  /balance-allowance -> allowance 0
 *   which both look like a funding problem and are not.
 *
 * Afterwards the CLOB balance/allowance cache is force-refreshed, because that
 * cache — not the chain — is what the order path reads.
 */
const { CONFIG } = require('../config');
const { PolymarketAuth } = require('../polymarketAuth');
const { RelayerClient, tradingApprovalCalls } = require('../relayerClient');
const { ADAPTERS, EXCHANGES } = require('../contracts');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.some(a => ['--check', '--dry-run', '-n'].includes(a));
const FORCE = argv.some(a => ['--force', '-f'].includes(a));

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const NAMES = { 0: 'EOA', 1: 'POLY_PROXY', 2: 'GNOSIS_SAFE', 3: 'DEPOSIT_WALLET (POLY_1271)' };
const exchangeName = (addr) => {
  const a = String(addr || '').toLowerCase();
  if (a === EXCHANGES.standard.toLowerCase()) return 'CTF Exchange';
  if (a === EXCHANGES.negRisk.toLowerCase()) return 'Neg Risk CTF Exchange';
  if (a === ADAPTERS.ctfCollateralAdapter.toLowerCase()) return 'CtfCollateralAdapter';
  if (a === ADAPTERS.negRiskCtfCollateralAdapter.toLowerCase()) return 'NegRiskCtfCollateralAdapter';
  return addr;
};

function printApprovals(state) {
  for (const c of state.checks || []) {
    const detail = c.kind === 'erc20'
      ? (c.allowance === null
        ? 'unreadable'
        : `$${c.allowance.toFixed(2)} → ${exchangeName(c.spender)}${c.limited ? ' (limited — will be raised to unlimited)' : ''}`)
      : (c.approved === null ? 'unreadable' : `${c.approved ? 'approved' : 'NOT approved'} → ${exchangeName(c.spender)}`);
    if (c.error) bad(`${c.label}: ${detail} (${c.error})`);
    else if (c.granted) ok(`${c.label}: ${detail}`);
    else bad(`${c.label}: ${detail}`);
  }
}

(async function main() {
  console.log('\n\x1b[1mPolymarket trading approvals\x1b[0m');

  const auth = new PolymarketAuth(CONFIG);
  const st = auth.getStatus();
  console.log(`  signature type: ${st.signatureType} (${st.signatureTypeName || NAMES[st.signatureType]})`);
  if (st.signerAddressFull) console.log(`  signer EOA:     ${st.signerAddressFull}`);
  console.log(`  account wallet: ${st.accountWalletFull || '(not configured)'}`);

  const relayer = new RelayerClient(CONFIG, auth);
  const owner = relayer.accountWalletAddress();
  if (!owner) {
    bad('no account wallet configured — set POLY_FUNDER_ADDRESS (your Polymarket account wallet address)');
    process.exit(1);
  }

  head('1. On-chain approval state');
  let state = await relayer.readTradingApprovals();
  if (state.error) warn(`RPC: ${state.error}`);
  printApprovals(state);

  head('2. Where the collateral actually is');
  const bal = await auth.checkOnChainBalance({ owner });
  if (bal.ok) {
    if (bal.pUSD > 0) ok(`account wallet: $${bal.pUSD.toFixed(2)} pUSD (tradeable)`);
    else bad('account wallet: $0.00 pUSD — approvals alone will not let an order settle');
    if (bal.usdce > 0) warn(`account wallet also holds $${bal.usdce.toFixed(2)} USDC.e — wrap it to pUSD via the CollateralOnramp (0x93070a847efEf7F70739046A929D47a521F5B8ee)`);
  } else {
    warn(`could not read on-chain balances: ${bal.error}`);
  }
  if (Number(auth.signatureType) !== 0 && auth.signerAddress) {
    const eoa = await auth.checkOnChainBalance({ owner: auth.signerAddress }).catch(() => null);
    if (eoa && eoa.ok && eoa.pUSD > 0) {
      bad(`$${eoa.pUSD.toFixed(2)} pUSD is on the signer EOA — transfer it to the account wallet; the CLOB cannot spend it there`);
    }
  }

  if (!relayer.isConfigured()) {
    head('3. Granting approvals');
    bad('the relayer is not configured. Create a Relayer API key at '
      + 'polymarket.com → Settings → API Keys → Relayer API Keys and set '
      + 'RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS in .env');
    if (Number(auth.signatureType) === 0) warn('an EOA account (signature type 0) can approve directly, but it needs POL for gas');
    process.exit(1);
  }

  const missing = (state.missing || []).map(m => m.label);

  // An RPC outage reads as "no missing approvals" — that is unknown, not granted.
  // Claiming success here would be the worst possible outcome of this tool.
  if (!state.ok && !FORCE) {
    bad(`could not verify the approvals on-chain (${state.error || 'RPC failure'}). `
      + 'Set POLYGON_RPC to a reachable node and re-run, or pass --force to re-approve regardless.');
    process.exit(1);
  }
  if (!missing.length && !FORCE) {
    console.log('\n  Nothing to do — every required approval is already granted by the account wallet.');
    await syncClob(auth);
    process.exit(0);
  }

  head('3. Granting approvals');
  if (CHECK_ONLY) {
    const labels = FORCE ? tradingApprovalCalls().map(c => c.label) : missing;
    warn(`--check: would submit ${labels.length} approval call(s) via the relayer (nothing sent)`);
    for (const label of labels) console.log(`      · ${label}`);
    process.exit(missing.length ? 1 : 0);
  }

  const res = await relayer.setupTradingApprovals({ force: FORCE });
  if (res.transactionHash) {
    const hashes = Array.isArray(res.transactionHash) ? res.transactionHash : [res.transactionHash];
    for (const h of hashes) console.log(`  tx: https://polygonscan.com/tx/${h}`);
  }
  if (!res.ok) {
    bad(res.error || 'the relayer did not confirm the approval batch');
    if (res.state) console.log(`  relayer state: ${res.state}`);
    process.exit(1);
  }
  ok(res.alreadyApproved
    ? 'approvals were already in place'
    : `granted: ${(res.submitted || []).join('; ')}`);

  head('4. Verification');
  state = await relayer.readTradingApprovals();
  printApprovals(state);
  const stillMissing = (state.missing || []).map(m => m.label);
  if (stillMissing.length) {
    bad(`still missing: ${stillMissing.join('; ')}`);
    process.exit(1);
  }
  ok(`all ${state.checks.length} approvals confirmed on-chain`);
  await syncClob(auth);
  console.log('\n  Ready to place orders. Re-run `npm run doctor` for the full pre-flight.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\napprove crashed:', e && e.message ? e.message : e);
  process.exit(2);
});

/** Force the CLOB to re-read balance/allowance from chain. */
async function syncClob(auth) {
  head('5. CLOB balance/allowance cache');
  if (!auth.wallet) { warn('no POLY_PRIVATE_KEY — cannot authenticate to refresh the cache'); return; }
  if (!auth.hasL2Credentials()) {
    try {
      await auth.deriveApiCredentials();
      ok(`CLOB credentials ${auth.credentialsSource}`);
    } catch (e) {
      warn(`could not derive CLOB credentials: ${e.message}`);
      return;
    }
  }
  const r = await auth.syncBalanceAllowance({ force: true }).catch(e => ({ ok: false, error: e.message }));
  if (r && r.ok) ok('cache refreshed (asset_type=COLLATERAL)');
  else warn(`cache refresh failed: ${(r && r.error) || (r && r.status) || 'unknown'}`);
  const b = await auth.checkBalanceAllowance({ refresh: false }).catch(() => null);
  if (b && b.ok) {
    ok(`CLOB now reports balance $${b.balance.toFixed(2)}, allowance $${b.allowance.toFixed(2)}`);
    for (const [ex, v] of Object.entries(b.allowances || {})) {
      if (v === null) continue;
      const line = `  ${exchangeName(ex)}: $${v.toFixed(2)}`;
      if (v > 0) ok(line.trim()); else bad(line.trim());
    }
  } else if (b) {
    warn(`could not read the CLOB balance: ${b.error || b.status}`);
  }
}
