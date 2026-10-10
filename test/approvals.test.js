'use strict';
/**
 * Unit tests for the CLOB V2 trading-approval path:
 *
 *   polymarketAuth.parseBalanceAllowance   the V2 `allowances` map, not a single
 *                                          `allowance` field
 *   contracts.tradingApprovals / relayerClient.tradingApprovalCalls
 *                                          the approvals and their calldata
 *   relayerClient.setupTradingApprovals    which calls actually get submitted
 *
 * These cover the failure that reads like a funding problem and is not one:
 * `POST /order -> 400 not enough balance / allowance: the balance is not enough
 * -> balance: 0`, caused by an account wallet that never approved the V2
 * exchanges — and, before this fix, also caused by a bot that read an allowance
 * field CLOB V2 no longer returns, so it reported 0 for a fully approved wallet.
 *
 * Runs as part of `npm test`.
 */
const assert = require('assert');
const { Wallet } = require('ethers');

const { parseBalanceAllowance } = require('../polymarketAuth');
const { ADAPTERS, CTF, EXCHANGES, TOKENS, tradingApprovals, MAX_UINT256 } = require('../contracts');
const {
  RelayerClient, tradingApprovalCalls, encodeApprove, encodeApprovalForAll,
} = require('../relayerClient');
const { CONFIG } = require('../config');

const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDR = new Wallet(TEST_PK).address;
const FUNDER = '0x2e234DAe75C793f67a35089c9d99245E1C58470B';

const APPROVE_SELECTOR = '0x095ea7b3';        // approve(address,uint256)
const SET_APPROVAL_SELECTOR = '0xa22cb465';   // setApprovalForAll(address,bool)

function cfg(overrides = {}) {
  const c = JSON.parse(JSON.stringify(CONFIG));
  c.relayer.apiKey = 'relayer-key';
  c.relayer.apiKeyAddress = TEST_ADDR;
  c.wallet.privateKey = TEST_PK;
  c.wallet.funderAddress = FUNDER;
  return { ...c, ...overrides };
}

function auth(signatureType = 3, extra = {}) {
  return {
    signatureType,
    wallet: new Wallet(TEST_PK),
    signerAddress: TEST_ADDR,
    funderAddress: signatureType === 0 ? TEST_ADDR : FUNDER,
    syncCalls: [],
    async syncBalanceAllowance(o) { this.syncCalls.push(o); return { ok: true }; },
    ...extra,
  };
}

/** Approval state as readTradingApprovals returns it, from a granted set. */
function approvalState({ granted = [], errored = [] } = {}) {
  const checks = tradingApprovals().map(a => {
    const key = `${a.kind}:${a.spender}`;
    if (errored.includes(key)) {
      return { ...a, granted: false, allowance: null, approved: null, error: 'rpc down' };
    }
    const isGranted = granted.includes(key) || granted.includes('*');
    return {
      ...a,
      granted: isGranted,
      allowance: a.kind === 'erc20' ? (isGranted ? Number(MAX_UINT256 / 10n ** 6n) : 0) : null,
      approved: a.kind === 'erc1155' ? isGranted : null,
    };
  });
  const failed = checks.filter(c => c.error);
  return {
    ok: failed.length === 0,
    owner: FUNDER,
    checks,
    missing: checks.filter(c => !c.error && !c.granted),
    error: failed.length ? failed.map(c => c.error).join('; ') : undefined,
  };
}

const key = (kind, which) => `${kind}:${which === 'negRisk' ? EXCHANGES.negRisk : EXCHANGES.standard}`;

/**
 * A stub reader that reflects reality: the allowances are missing until the
 * batch lands, and granted once it has.
 */
function statefulReader({ granted = [], errored = [] } = {}) {
  let submitted = false;
  const reader = async () => (submitted
    ? approvalState({ granted: ['*'] })
    : approvalState({ granted, errored }));
  reader.markSubmitted = () => { submitted = true; };
  return reader;
}

// ------------------------------------------------------------------- runner
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

module.exports = async function runApprovalTests(harness = {}) {
  const { test: t, testAsync: ta, section: sec } = harness && harness.test ? harness : { test, testAsync, section };

  // ================================================ CLOB V2 balance/allowance
  sec('CLOB V2 — balance/allowance decoding');

  t('the V2 per-spender allowance map is decoded, not the singular field', () => {
    const r = parseBalanceAllowance({
      balance: '12500000',
      allowances: {
        [EXCHANGES.standard]: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
        [EXCHANGES.negRisk]: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.balance, 12.5);
    assert.ok(r.allowance > 0, 'a fully approved wallet must not read as allowance 0');
    assert.deepStrictEqual(r.missingApprovals, [], 'nothing is missing when both exchanges are approved');
    assert.strictEqual(Object.keys(r.allowances).length, 2, 'both V2 exchanges are reported');
  });

  t('a single zero in the allowance map is reported as that exchange missing', () => {
    const r = parseBalanceAllowance({
      balance: '0',
      allowances: {
        [EXCHANGES.standard]: '100000000000',
        [EXCHANGES.negRisk]: '0',
      },
    });
    assert.strictEqual(r.allowance, 0, 'the effective allowance is the minimum across exchanges');
    assert.deepStrictEqual(r.missingApprovals, [EXCHANGES.negRisk]);
    assert.strictEqual(r.allowances[EXCHANGES.standard], 100000);
  });

  t('a legacy singular allowance still decodes', () => {
    const r = parseBalanceAllowance({ balance: '5000000', allowance: '115792089237316195423570985008687907853269984665640564039457584007913129639935' });
    assert.strictEqual(r.balance, 5);
    assert.ok(r.allowance > 0);
    assert.deepStrictEqual(r.missingApprovals, []);
  });

  t('the map wins over a stale singular field', () => {
    const r = parseBalanceAllowance({
      balance: '0',
      allowance: '999999999999999',
      allowances: { [EXCHANGES.standard]: '0', [EXCHANGES.negRisk]: '0' },
    });
    assert.strictEqual(r.allowance, 0, 'the per-spender map is authoritative');
    assert.strictEqual(r.missingApprovals.length, 2);
  });

  t('an empty response is "unknown", not "missing"', () => {
    const r = parseBalanceAllowance({});
    assert.strictEqual(r.balance, 0);
    assert.strictEqual(r.allowance, 0);
    assert.deepStrictEqual(r.missingApprovals, [],
      'an exchange the response never mentions is unknown — the on-chain read decides');
    assert.strictEqual(r.legacyAllowance, null);
  });

  // ================================================== the approval call set
  sec('CLOB V2 — the required approvals');

  t('pUSD and conditional tokens, on both V2 exchanges', () => {
    const calls = tradingApprovalCalls({ include: ['exchange'] });
    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(calls.map(c => c.to).sort(), [TOKENS.pUSD, TOKENS.pUSD, CTF, CTF].sort());
    const spenders = calls.map(c => c.spender).sort();
    assert.deepStrictEqual(spenders, [EXCHANGES.standard, EXCHANGES.standard, EXCHANGES.negRisk, EXCHANGES.negRisk].sort());
  });

  t('the collateral adapters are approved too, so the redeemer can still redeem', () => {
    // Approving only the exchanges is the silent half of the same bug: orders
    // work, then every winning position reverts when the sweeper converts it
    // back to pUSD. Polymarket's own SDK plan includes both adapters.
    const calls = tradingApprovalCalls();
    assert.strictEqual(calls.length, 8);
    const adapters = calls.filter(c => c.purpose === 'adapter');
    assert.strictEqual(adapters.length, 4);
    assert.deepStrictEqual(adapters.map(c => c.spender).sort(), [
      ADAPTERS.ctfCollateralAdapter, ADAPTERS.ctfCollateralAdapter,
      ADAPTERS.negRiskCtfCollateralAdapter, ADAPTERS.negRiskCtfCollateralAdapter,
    ].sort());
    assert.deepStrictEqual(adapters.map(c => c.to).sort(), [TOKENS.pUSD, TOKENS.pUSD, CTF, CTF].sort());
    assert.deepStrictEqual(calls.filter(c => c.purpose === 'exchange').map(c => c.spender).sort(),
      [EXCHANGES.standard, EXCHANGES.standard, EXCHANGES.negRisk, EXCHANGES.negRisk].sort());
  });

  t('the pUSD calls are approve(exchange, max uint256)', () => {
    const call = tradingApprovalCalls().find(c => c.kind === 'erc20' && c.spender === EXCHANGES.standard);
    assert.ok(call.data.startsWith(APPROVE_SELECTOR), `selector was ${call.data.slice(0, 10)}`);
    assert.ok(call.data.toLowerCase().includes(EXCHANGES.standard.slice(2).toLowerCase()), 'the spender is the exchange');
    assert.ok(call.data.toLowerCase().includes('f'.repeat(64)), 'the amount is max uint256');
    assert.strictEqual(call.value, '0');
  });

  t('the CTF calls are setApprovalForAll(exchange, true)', () => {
    const call = tradingApprovalCalls().find(c => c.kind === 'erc1155' && c.spender === EXCHANGES.negRisk);
    assert.ok(call.data.startsWith(SET_APPROVAL_SELECTOR), `selector was ${call.data.slice(0, 10)}`);
    assert.ok(call.data.toLowerCase().includes(EXCHANGES.negRisk.slice(2).toLowerCase()));
    assert.ok(/0{63}1$/.test(call.data), 'approved = true');
  });

  t('one side of the order book can be approved on its own', () => {
    const negRisk = tradingApprovalCalls({ include: ['exchange'], negRiskOnly: true });
    assert.strictEqual(negRisk.length, 2);
    assert.ok(negRisk.every(c => c.spender === EXCHANGES.negRisk));
    assert.ok(tradingApprovalCalls({ include: ['exchange'], standardOnly: true })
      .every(c => c.spender === EXCHANGES.standard));
  });

  t('the standalone encoders agree with the call list', () => {
    const a = encodeApprove(EXCHANGES.standard);
    assert.strictEqual(a.to, TOKENS.pUSD);
    assert.ok(a.data.startsWith(APPROVE_SELECTOR));
    const b = encodeApprovalForAll(EXCHANGES.standard);
    assert.strictEqual(b.to, CTF);
    assert.ok(b.data.startsWith(SET_APPROVAL_SELECTOR));
  });

  // ============================================== setupTradingApprovals flow
  sec('CLOB V2 — granting the approvals');

  await ta('nothing is submitted when every approval is already granted', async () => {
    const a = auth(3);
    const rc = new RelayerClient(cfg(), a);
    rc.readTradingApprovals = async () => approvalState({ granted: ['*'] });
    let submitted = 0;
    rc.execute = async () => { submitted++; return { ok: true, transactionID: 'x' }; };
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.alreadyApproved, true);
    assert.strictEqual(submitted, 0, 'a fully approved wallet must not be re-approved');
  });

  await ta('only the missing approvals are submitted', async () => {
    const a = auth(3);
    const rc = new RelayerClient(cfg(), a);
    const reader = statefulReader({ granted: [key('erc20', 'standard'), key('erc1155', 'standard')] });
    rc.readTradingApprovals = reader;
    const batches = [];
    rc.execute = async (calls) => { batches.push(calls); reader.markSubmitted(); return { ok: true, transactionID: 'tx1' }; };
    rc.waitForTransaction = async () => ({ ok: true, state: 'STATE_CONFIRMED', transactionHash: '0xabc' });
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(batches.length, 1, 'one relayer batch, not one submission per call');
    assert.strictEqual(batches[0].length, 6, 'the neg-risk exchange pair plus the four adapter approvals');
    assert.ok(batches[0].every(c => c.data.startsWith(APPROVE_SELECTOR) || c.data.startsWith(SET_APPROVAL_SELECTOR)));
    assert.deepStrictEqual(res.submitted.sort(), [
      'Conditional Tokens -> Neg Risk CTF Exchange',
      'pUSD -> Neg Risk CTF Exchange',
      'pUSD -> CtfCollateralAdapter',
      'Conditional Tokens -> CtfCollateralAdapter',
      'pUSD -> NegRiskCtfCollateralAdapter',
      'Conditional Tokens -> NegRiskCtfCollateralAdapter',
    ].sort());
  });

  await ta('the CLOB balance/allowance cache is force-refreshed afterwards', async () => {
    const a = auth(3);
    const rc = new RelayerClient(cfg(), a);
    const reader = statefulReader({ granted: [] });
    rc.readTradingApprovals = reader;
    rc.execute = async () => { reader.markSubmitted(); return { ok: true, transactionID: 'tx1' }; };
    rc.waitForTransaction = async () => ({ ok: true, state: 'STATE_CONFIRMED', transactionHash: '0xabc' });
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(a.syncCalls.length, 1);
    assert.strictEqual(a.syncCalls[0].force, true, 'a non-forced sync would keep the stale zeros');
  });

  await ta('--force re-approves everything, granted or not', async () => {
    const a = auth(3);
    const rc = new RelayerClient(cfg(), a);
    rc.readTradingApprovals = async () => approvalState({ granted: ['*'] });
    const batches = [];
    rc.execute = async (calls) => { batches.push(calls); return { ok: true, transactionID: 'tx1' }; };
    rc.waitForTransaction = async () => ({ ok: true, state: 'STATE_CONFIRMED', transactionHash: '0xabc' });
    const res = await rc.setupTradingApprovals({ force: true });
    assert.strictEqual(batches[0].length, 8);
    assert.strictEqual(res.ok, true, JSON.stringify(res));
  });

  await ta('a dry run submits nothing', async () => {
    const a = auth(3);
    const rc = new RelayerClient(cfg(), a);
    rc.readTradingApprovals = async () => approvalState({ granted: [] });
    let submitted = 0;
    rc.execute = async () => { submitted++; return { ok: true }; };
    const res = await rc.setupTradingApprovals({ dryRun: true });
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(submitted, 0);
    assert.strictEqual(res.submitted.length, 8);
  });

  await ta('an unreadable chain is reported as an error, never as "already approved"', async () => {
    const a = auth(3);
    const rc = new RelayerClient(cfg(), a);
    rc.readTradingApprovals = async () => approvalState({ errored: [key('erc20', 'standard')] });
    let submitted = 0;
    rc.execute = async () => { submitted++; return { ok: true }; };
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(res.ok, false);
    assert.strictEqual(submitted, 0, 'an RPC outage must not be treated as a green light');
    assert.match(res.error, /could not read on-chain approvals/);
  });

  await ta('a Safe account submits one call per transaction', async () => {
    const a = auth(2);
    const rc = new RelayerClient(cfg(), a);
    const reader = statefulReader({ granted: [] });
    rc.readTradingApprovals = reader;
    const batches = [];
    rc.execute = async (calls) => { batches.push(calls); reader.markSubmitted(); return { ok: true, transactionID: `tx${batches.length}` }; };
    rc.waitForTransaction = async () => ({ ok: true, state: 'STATE_CONFIRMED', transactionHash: '0xabc' });
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(batches.length, 8, 'Safe executes one call per submission');
    assert.ok(batches.every(b => b.length === 1));
    assert.strictEqual(res.ok, true, JSON.stringify(res));
  });

  await ta('an EOA account approves directly rather than via the relayer', async () => {
    const a = auth(0);
    const rc = new RelayerClient(cfg(), a);
    const reader = statefulReader({ granted: [] });
    rc.readTradingApprovals = reader;
    let relayed = 0, direct = null;
    rc.execute = async () => { relayed++; return { ok: true }; };
    rc.approveDirect = async (calls) => { direct = calls; reader.markSubmitted(); return { ok: true, transactionHash: '0xdirect' }; };
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(relayed, 0, 'signature type 0 does not use the relayer');
    assert.strictEqual(direct.length, 8);
    assert.strictEqual(res.ok, true, JSON.stringify(res));
  });

  await ta('a failed relayer batch is reported with the calls it tried', async () => {
    const a = auth(3);
    const rc = new RelayerClient(cfg(), a);
    rc.readTradingApprovals = async () => approvalState({ granted: [] });
    rc.execute = async () => ({ ok: false, status: 400, error: 'invalid nonce' });
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /invalid nonce/);
    assert.strictEqual(res.attempted.length, 8, 'the report must name every call it tried');
  });

  t('the approval owner is the account wallet, and the EOA only for type 0', () => {
    assert.strictEqual(new RelayerClient(cfg(), auth(3)).accountWalletAddress(), FUNDER);
    assert.strictEqual(new RelayerClient(cfg(), auth(2)).accountWalletAddress(), FUNDER);
    assert.strictEqual(new RelayerClient(cfg(), auth(0)).accountWalletAddress(), TEST_ADDR);
  });

  t('approvals cannot be granted without an account wallet', async () => {
    const a = auth(3); a.funderAddress = null;
    const rc = new RelayerClient(cfg(), a);
    const res = await rc.setupTradingApprovals();
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /POLY_FUNDER_ADDRESS/);
  });

  return { passed, failed, failures };
};

// Allow running standalone: `node test/approvals.test.js`
if (require.main === module) {
  process.on('unhandledRejection', (e) => {
    console.error('\nUNHANDLED REJECTION — the suite cannot vouch for this run:');
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
  (async () => {
    console.log('\nCLOB V2 trading-approval tests');
    const r = await module.exports();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      console.log('\n  Failures:');
      for (const f of r.failures) console.log(`   - ${f.name}: ${f.error.message}`);
      process.exit(1);
    }
  })();
}
