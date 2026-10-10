'use strict';
/**
 * End-to-end read of the approval state against a fake JSON-RPC node.
 *
 * Every other approval test stubs `readTradingApprovals`, so nothing but this
 * exercises the real path: the ABI encoding of `allowance(owner, spender)` /
 * `isApprovedForAll(owner, operator)`, the hex decoding of the answer, and the
 * rule that decides whether an answer means "granted". Those three things are
 * exactly where a silent "everything is fine" can be produced — an empty
 * allowance, a mis-decoded bool, or a finite allowance treated as unlimited.
 *
 * Runs as part of `npm test`.
 */
const assert = require('assert');
const http = require('http');
const { Interface, Wallet } = require('ethers');

const onchain = require('../onchain');
const {
  ADAPTERS, CTF, EXCHANGES, TOKENS, UNLIMITED_ALLOWANCE,
} = require('../contracts');

const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OWNER = new Wallet(TEST_PK).address;

const erc20 = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const erc1155 = new Interface([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

const MAX_HEX = `0x${(2n ** 256n - 1n).toString(16).padStart(64, '0')}`;
const FALSE_HEX = `0x${'0'.repeat(64)}`;
const TRUE_HEX = `0x${'0'.repeat(63)}1`;

/**
 * A minimal Polygon node. `allowances` maps "token:spender" -> base units
 * (as a BigInt); `operators` maps "token:operator" -> boolean. Every request
 * is recorded so a test can assert on the decoded arguments.
 */
function startFakeRpc({ allowances = {}, operators = {}, failFor = [] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const one = (m) => {
        calls.push({ method: m.method, params: m.params });
        const id = m.id;
        const reply = (result) => res.end && { jsonrpc: '2.0', id, result };
        if (m.method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x89' };
        if (m.method === 'eth_blockNumber') return { jsonrpc: '2.0', id, result: '0x1' };
        if (m.method === 'net_version') return { jsonrpc: '2.0', id, result: '137' };
        if (m.method === 'eth_call') {
          const data = (m.params && m.params[0] && m.params[0].data) || '0x';
          const to = ((m.params && m.params[0] && m.params[0].to) || '').toLowerCase();
          const sel = data.slice(0, 10);
          if (failFor.includes(sel)) return { jsonrpc: '2.0', id, error: { code: -32000, message: 'execution reverted' } };
          try {
            if (sel === erc20.getFunction('allowance').selector) {
              const [, spender] = erc20.decodeFunctionData('allowance', data);
              const key = `${to}:${String(spender).toLowerCase()}`;
              const value = allowances[key] === undefined ? MAX_HEX : `0x${allowances[key].toString(16).padStart(64, '0')}`;
              return reply(value);
            }
            if (sel === erc1155.getFunction('isApprovedForAll').selector) {
              const [, operator] = erc1155.decodeFunctionData('isApprovedForAll', data);
              const key = `${to}:${String(operator).toLowerCase()}`;
              return reply(operators[key] === false ? FALSE_HEX : TRUE_HEX);
            }
            if (sel === erc20.getFunction('balanceOf').selector) {
              return reply(`0x${(1000n * 10n ** 6n).toString(16).padStart(64, '0')}`);
            }
          } catch (e) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: e.message } };
          }
          return { jsonrpc: '2.0', id, result: '0x' };
        }
        return { jsonrpc: '2.0', id, result: null };
      };
      const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        rpcUrl: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// ------------------------------------------------------------------- runner
let passed = 0, failed = 0;
const failures = [];
function section(t) { console.log(`\n${t}`); }
async function t_(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const allowanceKey = (token, spender) => `${token.toLowerCase()}:${spender.toLowerCase()}`;
const find = (state, spender, kind) => state.checks.find(c => c.spender.toLowerCase() === spender.toLowerCase() && c.kind === kind);

module.exports = async function runApprovalRpcTests(harness = {}) {
  const { testAsync, section: sec = section } = harness;
  // On the shared harness the results land in its counters and its single
  // summary; standalone, this file counts for itself.
  const standalone = !testAsync;
  const t = testAsync || t_;

  if (standalone) sec('CLOB V2 — reading the approval state off-chain');
  else sec('CLOB V2 — reading the approval state off a real JSON-RPC node');

  await t('a wallet that approved max on everything reads as fully granted', async () => {
    const node = await startFakeRpc();
    try {
      const state = await onchain.readTradingApprovals({ rpcUrl: node.rpcUrl, owner: OWNER });
      assert.strictEqual(state.ok, true, JSON.stringify(state.error));
      assert.strictEqual(state.checks.length, 8, '4 spenders x 2 token kinds');
      assert.strictEqual(state.missing.length, 0, state.missing.map(m => m.label).join('; '));
      const check = find(state, EXCHANGES.standard, 'erc20');
      assert.strictEqual(check.granted, true);
      assert.strictEqual(check.limited, false);
      assert.ok(check.allowance > 1e20, `max uint256 decodes as an absurd allowance, got ${check.allowance}`);
      assert.strictEqual(find(state, EXCHANGES.standard, 'erc1155').approved, true);
    } finally { await node.close(); onchain.resetProviders(); }
  });

  await t('the reader asks the right contract about the right spender for the right owner', async () => {
    const node = await startFakeRpc();
    try {
      await onchain.readTradingApprovals({ rpcUrl: node.rpcUrl, owner: OWNER });
      const allowanceCalls = node.calls.filter(c => c.method === 'eth_call'
        && c.params[0].data.slice(0, 10) === erc20.getFunction('allowance').selector);
      assert.strictEqual(allowanceCalls.length, 4, 'one pUSD allowance read per spender');
      const owners = new Set();
      for (const c of allowanceCalls) {
        const [owner] = erc20.decodeFunctionData('allowance', c.params[0].data);
        assert.strictEqual(owner.toLowerCase(), OWNER.toLowerCase(), 'the owner must be the account wallet, not the signer EOA');
        owners.add(String(c.params[0].to).toLowerCase());
      }
      assert.deepStrictEqual([...owners], [TOKENS.pUSD.toLowerCase()], 'allowance is read on pUSD');
      const operatorCalls = node.calls.filter(c => c.method === 'eth_call'
        && c.params[0].data.slice(0, 10) === erc1155.getFunction('isApprovedForAll').selector);
      assert.strictEqual(operatorCalls.length, 4);
      assert.ok(operatorCalls.every(c => String(c.params[0].to).toLowerCase() === CTF.toLowerCase()));
      const spenders = [...new Set([
        ...allowanceCalls.map(c => erc20.decodeFunctionData('allowance', c.params[0].data)[1].toLowerCase()),
        ...operatorCalls.map(c => erc1155.decodeFunctionData('isApprovedForAll', c.params[0].data)[1].toLowerCase()),
      ])].sort();
      assert.deepStrictEqual(spenders, [
        EXCHANGES.standard, EXCHANGES.negRisk, ADAPTERS.ctfCollateralAdapter, ADAPTERS.negRiskCtfCollateralAdapter,
      ].map(a => a.toLowerCase()).sort());
    } finally { await node.close(); onchain.resetProviders(); }
  });

  await t('a finite allowance is reported as missing, and flagged as limited', async () => {
    // The bug this guards: a $500 allowance reads as "granted" to any
    // `allowance > 0` test, the bot starts trading, and fails mid-run when the
    // exchange has spent it all. Polymarket's own tooling approves max uint256
    // and re-approves anything below that.
    const node = await startFakeRpc({
      allowances: { [allowanceKey(TOKENS.pUSD, EXCHANGES.negRisk)]: 500n * 10n ** 6n },
    });
    try {
      const state = await onchain.readTradingApprovals({ rpcUrl: node.rpcUrl, owner: OWNER });
      assert.strictEqual(state.ok, true);
      const check = find(state, EXCHANGES.negRisk, 'erc20');
      assert.strictEqual(check.granted, false, 'a finite allowance is not a grant');
      assert.strictEqual(check.limited, true, 'the report must say it is limited, not zero');
      assert.strictEqual(Math.round(check.allowance), 500, 'the USD figure is surfaced');
      assert.deepStrictEqual(state.missing.map(m => m.label), ['pUSD -> Neg Risk CTF Exchange']);
    } finally { await node.close(); onchain.resetProviders(); }
  });

  await t('a zero allowance and a revoked operator approval are both missing', async () => {
    const node = await startFakeRpc({
      allowances: { [allowanceKey(TOKENS.pUSD, EXCHANGES.standard)]: 0n },
      operators: { [allowanceKey(CTF, ADAPTERS.ctfCollateralAdapter)]: false },
    });
    try {
      const state = await onchain.readTradingApprovals({ rpcUrl: node.rpcUrl, owner: OWNER });
      const labels = state.missing.map(m => m.label).sort();
      assert.deepStrictEqual(labels, ['Conditional Tokens -> CtfCollateralAdapter', 'pUSD -> CTF Exchange'].sort());
      assert.strictEqual(find(state, EXCHANGES.standard, 'erc20').limited, false, 'zero is not "limited"');
      assert.strictEqual(find(state, ADAPTERS.ctfCollateralAdapter, 'erc1155').approved, false);
      // An operator approval is a boolean: there is no partial state to report.
      assert.strictEqual(find(state, ADAPTERS.ctfCollateralAdapter, 'erc1155').limited, undefined);
    } finally { await node.close(); onchain.resetProviders(); }
  });

  await t('a reverting read is an error, never an empty allowance', async () => {
    const node = await startFakeRpc({ failFor: [erc20.getFunction('allowance').selector] });
    try {
      const state = await onchain.readTradingApprovals({ rpcUrl: node.rpcUrl, owner: OWNER });
      assert.strictEqual(state.ok, false, 'a chain that cannot be read is not a clean bill of health');
      assert.strictEqual(state.missing.length, 0, 'unreadable checks are not reported as missing');
      assert.ok(state.checks.filter(c => c.error).length === 4, 'every allowance read failed');
      assert.ok(/pUSD -> CTF Exchange/.test(state.error));
    } finally { await node.close(); onchain.resetProviders(); }
  });

  await t('only the exchange group can be read', async () => {
    const node = await startFakeRpc();
    try {
      const state = await onchain.readTradingApprovals({
        rpcUrl: node.rpcUrl, owner: OWNER, include: ['exchange'],
      });
      assert.strictEqual(state.checks.length, 4);
      assert.ok(state.checks.every(c => c.purpose === 'exchange'));
    } finally { await node.close(); onchain.resetProviders(); }
  });

  await t('without an owner the read refuses rather than reading address(0)', async () => {
    const state = await onchain.readTradingApprovals({ rpcUrl: 'http://127.0.0.1:1', owner: null });
    assert.strictEqual(state.ok, false);
    assert.match(state.error, /no account wallet address/);
  });

  await t('collateral balances are read from pUSD and USDC.e', async () => {
    const node = await startFakeRpc();
    try {
      const bal = await onchain.readCollateralBalances({ rpcUrl: node.rpcUrl, owner: OWNER });
      assert.strictEqual(bal.ok, true);
      assert.strictEqual(bal.pUSD, 1000);
      const reads = node.calls.filter(c => c.method === 'eth_call'
        && c.params[0].data.slice(0, 10) === erc20.getFunction('balanceOf').selector)
        .map(c => String(c.params[0].to).toLowerCase());
      assert.deepStrictEqual(reads.sort(), [TOKENS.pUSD.toLowerCase(), TOKENS.usdce.toLowerCase()].sort());
    } finally { await node.close(); onchain.resetProviders(); }
  });

  await t('the unlimited threshold is what the reader compares against', async () => {
    assert.strictEqual(UNLIMITED_ALLOWANCE, 2n ** 128n);
    assert.ok(MAX_HEX.length === 66, 'the fixture max uint256 is a full word');
  });

  if (standalone) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log('\n  Failures:');
      for (const f of failures) console.log(`   - ${f.name}: ${f.error.message.split('\n')[0]}`);
    }
  }
  return { passed, failed };
};

if (require.main === module) {
  module.exports().then(({ failed }) => process.exit(failed ? 1 : 0));
}
