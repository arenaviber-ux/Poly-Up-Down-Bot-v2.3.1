'use strict';
/**
 * Integration tests for the bot-level approval gate:
 * BotCore.ensureTradingApprovals() — the pre-flight step that verifies the four
 * exchange approvals on chain and, when allowed, grants the missing ones through
 * the gasless relayer.
 *
 * This is the code path behind the two symptoms that look identical from the
 * outside: `npm run doctor` reporting "allowance is 0", and a live order coming
 * back `400 not enough balance / allowance: the balance is not enough`.
 *
 * Run: `npm run test:approvals`
 */
process.on('unhandledRejection', (e) => {
  console.error('\nUNHANDLED REJECTION — the suite cannot vouch for this run:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('\nUNCAUGHT EXCEPTION — the suite cannot vouch for this run:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { CONFIG } = require('../config');
const { PolymarketAuth } = require('../polymarketAuth');
const { BotCore } = require('../botCore');
const { tradingApprovalCalls } = require('../relayerClient');

const STATE = path.join(__dirname, '..', 'itest_approvals_state.json');
process.env.STATE_FILE = STATE;

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const section = (s) => console.log(`\n${s}`);

function config(overrides = {}) {
  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.runtime.stateFile = path.basename(STATE);
  cfg.runtime.paperMode = true;
  cfg.market.timeframes = ['5m'];
  cfg.relayer.apiKey = 'relayer-key';
  cfg.relayer.apiKeyAddress = '0x94843687ae3E57F0d1ED4CDEe98f0cC0a2D6C9fF';
  return Object.assign(cfg, overrides);
}

/** Four approval checks, with the named ones granted. */
function checks(grantedLabels = []) {
  return tradingApprovalCalls().map(c => ({
    ...c,
    granted: grantedLabels.includes(c.label),
    allowance: c.kind === 'erc20' ? (grantedLabels.includes(c.label) ? 1e30 : 0) : null,
    approved: c.kind === 'erc1155' ? grantedLabels.includes(c.label) : null,
  }));
}
function state(grantedLabels = [], { rpcError = null } = {}) {
  const all = checks(grantedLabels);
  if (rpcError) {
    return { ok: false, owner: '0xwallet', checks: all.map(c => ({ ...c, error: rpcError, granted: false })), missing: [], error: rpcError };
  }
  return { ok: true, owner: '0xwallet', checks: all, missing: all.filter(c => !c.granted) };
}

/** A fake relayer with the three methods the bot uses. */
function fakeRelayer({ configured = true, stateToReturn = state([]), setupResult = null } = {}) {
  const calls = { setup: 0, read: 0 };
  return {
    calls,
    isConfigured: () => configured,
    // Redeemer.getState() reaches through to the relayer for the dashboard.
    getStatus: () => ({ configured, authMode: configured ? 'relayer-api-key' : 'none', txType: 'WALLET', lastError: null }),
    readiness: () => (configured ? { ready: true, mode: 'WALLET' } : { ready: false, reason: 'relayer not configured' }),
    readTradingApprovals: async () => { calls.read++; return stateToReturn; },
    setupTradingApprovals: async () => {
      calls.setup++;
      return setupResult || { ok: true, submitted: stateToReturn.missing.map(m => m.label), transactionHash: '0xfeed' };
    },
  };
}

function botFor(cfg, relayer, { authOverrides = {} } = {}) {
  const auth = new PolymarketAuth(cfg);
  Object.assign(auth, {
    liveBalanceUsd: 0,
    allowanceUsd: 0,
    syncCalls: [],
    async syncBalanceAllowance(o) { this.syncCalls.push(o); return { ok: true }; },
    checkBalanceAllowance: async () => ({ ok: true, balance: 50, allowance: 1000, allowances: {}, missingApprovals: [] }),
    ...authOverrides,
  });
  const bot = new BotCore({ config: cfg, auth, log: () => {} });
  bot.redeemer.relayer = relayer;
  return bot;
}

const logText = (bot, level) => bot.logs.filter(l => l.level === level).map(l => l.message);

(async function main() {
  console.log('\nTrading-approval gate (BotCore) integration tests');

  section('BotCore.ensureTradingApprovals()');

  await t('a fully approved wallet passes and is reported once', async () => {
    const relayer = fakeRelayer({ stateToReturn: state(checks([]).map(c => c.label)) });
    const bot = botFor(config(), relayer);
    const r1 = await bot.ensureTradingApprovals();
    assert.strictEqual(r1.ok, true);
    assert.deepStrictEqual(r1.missing, []);
    assert.strictEqual(bot.allowanceWarning, false);
    assert.strictEqual(relayer.calls.setup, 0, 'nothing to grant');
    assert.ok(logText(bot, 'SUCCESS').some(m => /Exchange approvals verified on-chain/.test(m)));
    await bot.ensureTradingApprovals();
    assert.strictEqual(logText(bot, 'SUCCESS').filter(m => /approvals verified/.test(m)).length, 1,
      'the same green line must not repeat every pre-flight');
    assert.strictEqual(bot.getState().approvals.ok, true, 'the dashboard reports the approval state');
  });

  await t('a missing approval is granted through the relayer and the CLOB cache is refreshed', async () => {
    const missing = state([checks([])[0].label, checks([])[1].label]); // neg-risk pair missing
    const relayer = fakeRelayer({ stateToReturn: missing });
    const bot = botFor(config(), relayer);
    const r = await bot.ensureTradingApprovals();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(relayer.calls.setup, 1);
    assert.strictEqual(bot.auth.syncCalls.length, 1, 'the CLOB cache is a separate system and must be told');
    assert.strictEqual(bot.auth.syncCalls[0].force, true);
    assert.strictEqual(bot.allowanceWarning, false);
    assert.ok(logText(bot, 'INFO').some(m => /Granting missing exchange approvals/.test(m)));
    assert.ok(logText(bot, 'SUCCESS').some(m => /Exchange approvals granted/.test(m)));
  });

  await t('without relayer credentials the bot names the fix instead of trading blind', async () => {
    const relayer = fakeRelayer({ configured: false });
    const bot = botFor(config(), relayer);
    const r = await bot.ensureTradingApprovals();
    assert.strictEqual(r.ok, false);
    // Both V2 exchanges and both collateral adapters, pUSD + conditional tokens.
    assert.strictEqual(r.missing.length, tradingApprovalCalls().length);
    assert.strictEqual(r.missing.length, 8);
    assert.strictEqual(relayer.calls.setup, 0);
    const err = logText(bot, 'ERROR');
    assert.ok(err.some(m => /RELAYER_API_KEY/.test(m) && /npm run approve/.test(m)), err.join(' | '));
    assert.strictEqual(bot.getState().approvals.ok, false);
    assert.deepStrictEqual(bot.getState().approvals.missing.length, 8);
  });

  await t('AUTO_APPROVE=false leaves the granting to the operator, and says so', async () => {
    const cfg = config();
    cfg.approvals.autoApprove = false;
    const relayer = fakeRelayer();
    const bot = botFor(cfg, relayer);
    const r = await bot.ensureTradingApprovals();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(relayer.calls.setup, 0, 'the bot must not submit on-chain calls it was told not to');
    assert.ok(logText(bot, 'ERROR').some(m => /npm run approve/.test(m) && /AUTO_APPROVE=true/.test(m)));
  });

  await t('an unreadable chain warns once and never reports the approvals as granted', async () => {
    const relayer = fakeRelayer({ stateToReturn: state([], { rpcError: 'socket hang up' }) });
    const bot = botFor(config(), relayer);
    const r = await bot.ensureTradingApprovals();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(relayer.calls.setup, 0, 'an RPC outage is not a green light to approve blind');
    assert.ok(logText(bot, 'WARN').some(m => /Could not verify exchange approvals on-chain/.test(m)));
    await bot.ensureTradingApprovals();
    assert.strictEqual(logText(bot, 'WARN').filter(m => /Could not verify/.test(m)).length, 1,
      'the same RPC failure must not spam the dashboard');
    assert.strictEqual(bot.getState().approvals.verifiedOnChain, false);
  });

  await t('a failed relayer batch is an ERROR that points at the CLI tool', async () => {
    const relayer = fakeRelayer({ setupResult: { ok: false, error: 'relayer rejected: invalid nonce' } });
    const bot = botFor(config(), relayer);
    const r = await bot.ensureTradingApprovals();
    assert.strictEqual(r.ok, false);
    assert.ok(logText(bot, 'ERROR').some(m => /invalid nonce/.test(m) && /npm run approve/.test(m)));
    assert.strictEqual(bot.allowanceWarning, true);
  });

  await t('force re-verifies even when everything already looks granted', async () => {
    const relayer = fakeRelayer({
      stateToReturn: state(checks([]).map(c => c.label)),
      setupResult: { ok: true, alreadyApproved: true, submitted: [] },
    });
    const bot = botFor(config(), relayer);
    const r = await bot.ensureTradingApprovals({ force: true });
    assert.strictEqual(relayer.calls.setup, 1, 'force must reach the relayer even with nothing missing');
    assert.strictEqual(r.ok, true);
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
