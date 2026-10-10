'use strict';
/**
 * The approval grant, end to end, with nothing stubbed inside RelayerClient.
 *
 * Every other approval test replaces `execute()`, which means the part that
 * actually has to work against Polymarket — fetch the WALLET nonce, build the
 * EIP-712 DepositWallet batch, POST it to /submit with the relayer headers, poll
 * /transaction to STATE_CONFIRMED, re-read the chain — had never been run. This
 * stands up a fake relayer and a fake Polygon node and drives the real client
 * through both.
 *
 * Runs as part of `npm test`.
 */
const assert = require('assert');
const http = require('http');
const { Interface, Wallet, verifyTypedData } = require('ethers');

const { CONFIG } = require('../config');
const { PolymarketAuth } = require('../polymarketAuth');
const { RelayerClient, depositWalletTypedData } = require('../relayerClient');
const onchain = require('../onchain');
const {
  ADAPTERS, CTF, EXCHANGES, TOKENS, WALLETS,
} = require('../contracts');

const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SIGNER = new Wallet(TEST_PK).address;
const DEPOSIT_WALLET = '0x2e234DAe75C793f67A35089C9d99245E1C58470b';
const RELAYER_KEY = 'relayer-api-key';
const RELAYER_KEY_ADDRESS = '0x94843687ae3E57F0d1ED4CDEe98f0cC0a2D6C9fF';

// Both the read side (allowance / isApprovedForAll) and the write side
// (approve / setApprovalForAll) are needed: the fake node reads one and decodes
// the other to work out which spender a submitted call approves.
const erc20 = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const erc1155 = new Interface([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]);
const MAX_HEX = `0x${(2n ** 256n - 1n).toString(16).padStart(64, '0')}`;
const ZERO_HEX = `0x${'0'.repeat(64)}`;
const TRUE_HEX = `0x${'0'.repeat(63)}1`;

/** A Polygon node whose approval answers flip to "granted" when told to. */
function startFakeRpc() {
  const node = { granted: new Set(), calls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const one = (m) => {
        node.calls.push({ method: m.method, params: m.params });
        const { id } = m;
        if (m.method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x89' };
        if (m.method === 'eth_blockNumber') return { jsonrpc: '2.0', id, result: '0x1' };
        if (m.method === 'net_version') return { jsonrpc: '2.0', id, result: '137' };
        if (m.method === 'eth_call') {
          const data = (m.params[0] && m.params[0].data) || '0x';
          const to = String(m.params[0].to).toLowerCase();
          const sel = data.slice(0, 10);
          if (sel === erc20.getFunction('allowance').selector) {
            const [, spender] = erc20.decodeFunctionData('allowance', data);
            const key = `erc20:${String(spender).toLowerCase()}`;
            return { jsonrpc: '2.0', id, result: node.granted.has(key) ? MAX_HEX : ZERO_HEX };
          }
          if (sel === erc1155.getFunction('isApprovedForAll').selector) {
            const [, op] = erc1155.decodeFunctionData('isApprovedForAll', data);
            const key = `erc1155:${String(op).toLowerCase()}`;
            return { jsonrpc: '2.0', id, result: node.granted.has(key) ? TRUE_HEX : ZERO_HEX };
          }
          if (sel === erc20.getFunction('balanceOf').selector) {
            return { jsonrpc: '2.0', id, result: `0x${(500n * 10n ** 6n).toString(16).padStart(64, '0')}` };
          }
          void to;
        }
        return { jsonrpc: '2.0', id, result: null };
      };
      const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({
      ...node,
      rpcUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(r => server.close(r)),
    });
  }));
}

/** A relayer-v2 stand-in: /nonce, /submit, /transaction. */
function startFakeRelayer(rpc) {
  const relayer = { submits: [], nonces: [], polls: 0, nonce: 5 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://relayer');
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (u.pathname === '/nonce') {
        relayer.nonces.push({
          address: u.searchParams.get('address'),
          type: u.searchParams.get('type'),
          headers: { key: req.headers.relayer_api_key, keyAddress: req.headers.relayer_api_key_address },
        });
        return send(200, { nonce: relayer.nonce });
      }
      if (u.pathname === '/submit' && req.method === 'POST') {
        relayer.submits.push({
          body: JSON.parse(body || '{}'),
          headers: {
            key: req.headers.relayer_api_key,
            keyAddress: req.headers.relayer_api_key_address,
            contentType: req.headers['content-type'],
          },
        });
        return send(200, { transactionID: 'txn-1', state: 'STATE_NEW' });
      }
      if (u.pathname === '/transaction') {
        relayer.polls++;
        // The chain "applies" the batch the first time the client polls for it,
        // so the client's re-read afterwards sees a different chain than before.
        for (const c of relayer.submits[relayer.submits.length - 1].body.depositWalletParams.calls) {
          const sel = c.data.slice(0, 10);
          let spender = null, kind = null;
          if (sel === erc20.getFunction('approve').selector) {
            [spender] = erc20.decodeFunctionData('approve', c.data);
            kind = 'erc20';
          } else if (sel === erc1155.getFunction('setApprovalForAll').selector) {
            [spender] = erc1155.decodeFunctionData('setApprovalForAll', c.data);
            kind = 'erc1155';
          }
          if (spender) rpc.granted.add(`${kind}:${String(spender).toLowerCase()}`);
        }
        return send(200, [{
          id: u.searchParams.get('id'),
          state: 'STATE_CONFIRMED',
          transactionHash: '0x' + 'cd'.repeat(32),
        }]);
      }
      return send(404, { error: 'not found' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({
      ...relayer,
      relayerUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(r => server.close(r)),
    });
  }));
}

function clientFor(rpc, relayer, { signatureType = 3 } = {}) {
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.relayer.url = relayer.relayerUrl;
  cfg.relayer.apiKey = RELAYER_KEY;
  cfg.relayer.apiKeyAddress = RELAYER_KEY_ADDRESS;
  cfg.endpoints.polygonRpc = rpc.rpcUrl;
  cfg.wallet.privateKey = TEST_PK;
  cfg.wallet.funderAddress = signatureType === 0 ? SIGNER : DEPOSIT_WALLET;
  cfg.wallet.signatureType = signatureType;
  const auth = new PolymarketAuth(cfg);
  const syncs = [];
  auth.syncBalanceAllowance = async (o = {}) => { syncs.push(o); return { ok: true }; };
  const client = new RelayerClient(cfg, auth);
  return { client, auth, cfg, syncs };
}

// ------------------------------------------------------------------- runner
let passed = 0, failed = 0;
const failures = [];
function section(t) { console.log(`\n${t}`); }
async function t_(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

module.exports = async function runApprovalE2ETests(harness = {}) {
  const { testAsync, section: sec = section } = harness;
  const standalone = !testAsync;
  const t = testAsync || t_;

  sec('CLOB V2 — granting the approvals through a real relayer round-trip');

  await t('the batch is signed, submitted, confirmed and re-verified', async () => {
    const rpc = await startFakeRpc();
    const relayer = await startFakeRelayer(rpc);
    try {
      const { client, syncs } = clientFor(rpc, relayer);
      const res = await client.setupTradingApprovals({ maxPolls: 3, pollMs: 1 });

      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.strictEqual(relayer.submits.length, 1, 'one relayer batch for all eight approvals');
      assert.strictEqual(res.stillMissing.length, 0, 'chain agrees afterwards');
      assert.strictEqual(res.transactionHash, '0x' + 'cd'.repeat(32));
      assert.strictEqual(syncs.length, 1, 'the CLOB cache is refreshed once');
      assert.strictEqual(syncs[0].force, true);
    } finally {
      await relayer.close(); await rpc.close(); onchain.resetProviders();
    }
  });

  await t('the nonce is fetched for the signer EOA with type WALLET', async () => {
    const rpc = await startFakeRpc();
    const relayer = await startFakeRelayer(rpc);
    try {
      const { client } = clientFor(rpc, relayer);
      await client.setupTradingApprovals({ maxPolls: 3, pollMs: 1 });
      assert.strictEqual(relayer.nonces.length, 1);
      assert.strictEqual(relayer.nonces[0].type, 'WALLET');
      assert.strictEqual(relayer.nonces[0].address.toLowerCase(), SIGNER.toLowerCase(),
        'the nonce belongs to the signer EOA, not the Deposit Wallet');
      // /nonce is unauthenticated in the client, but /submit is not.
      assert.strictEqual(relayer.submits[0].headers.key, RELAYER_KEY);
      assert.strictEqual(relayer.submits[0].headers.keyAddress, RELAYER_KEY_ADDRESS);
      assert.match(relayer.submits[0].headers.contentType, /application\/json/);
    } finally {
      await relayer.close(); await rpc.close(); onchain.resetProviders();
    }
  });

  await t('the submitted payload is a WALLET batch signed by the signer', async () => {
    const rpc = await startFakeRpc();
    const relayer = await startFakeRelayer(rpc);
    try {
      const { client } = clientFor(rpc, relayer);
      await client.setupTradingApprovals({ maxPolls: 3, pollMs: 1 });
      const req = relayer.submits[0].body;

      assert.strictEqual(req.type, 'WALLET');
      assert.strictEqual(req.from.toLowerCase(), SIGNER.toLowerCase());
      assert.strictEqual(req.to, WALLETS.depositWalletFactory, 'submitted to the factory…');
      assert.strictEqual(req.nonce, '5', 'the nonce the relayer handed out');
      assert.strictEqual(req.depositWalletParams.depositWallet, DEPOSIT_WALLET,
        '…executed by the Deposit Wallet');
      assert.ok(Number(req.depositWalletParams.deadline) > Math.floor(Date.now() / 1000),
        'the deadline is in the future');

      // The signature must recover the signer against the DepositWallet domain.
      const td = depositWalletTypedData({
        chainId: 137,
        walletAddress: DEPOSIT_WALLET,
        nonce: req.nonce,
        deadline: req.depositWalletParams.deadline,
        calls: req.depositWalletParams.calls,
      });
      assert.strictEqual(td.domain.name, 'DepositWallet');
      assert.strictEqual(td.domain.verifyingContract, DEPOSIT_WALLET);
      assert.strictEqual(
        verifyTypedData(td.domain, td.types, td.message, req.signature),
        SIGNER,
        'the batch signature must recover the signer EOA',
      );
    } finally {
      await relayer.close(); await rpc.close(); onchain.resetProviders();
    }
  });

  await t('the batch carries exactly the eight approval calls', async () => {
    const rpc = await startFakeRpc();
    const relayer = await startFakeRelayer(rpc);
    try {
      const { client } = clientFor(rpc, relayer);
      await client.setupTradingApprovals({ maxPolls: 3, pollMs: 1 });
      const calls = relayer.submits[0].body.depositWalletParams.calls;

      assert.strictEqual(calls.length, 8);
      assert.ok(calls.every(c => c.value === '0'), 'approvals move no ETH');
      const approvals = calls.filter(c => c.data.startsWith(erc20.getFunction('approve').selector));
      const operators = calls.filter(c => c.data.startsWith(erc1155.getFunction('setApprovalForAll').selector));
      assert.strictEqual(approvals.length, 4, 'four pUSD approvals');
      assert.strictEqual(operators.length, 4, 'four conditional-token operator approvals');
      // The relayer batch call shape is { target, value, data } — `target`, not
      // the `to` the internal call list uses.
      assert.ok(approvals.every(c => c.target.toLowerCase() === TOKENS.pUSD.toLowerCase()),
        `pUSD approvals target pUSD: ${approvals.map(c => c.target).join(', ')}`);
      assert.ok(operators.every(c => c.target.toLowerCase() === CTF.toLowerCase()),
        `operator approvals target the CTF: ${operators.map(c => c.target).join(', ')}`);

      const spenders = [...new Set([
        ...approvals.map(c => erc20.decodeFunctionData('approve', c.data)[0].toLowerCase()),
        ...operators.map(c => erc1155.decodeFunctionData('setApprovalForAll', c.data)[0].toLowerCase()),
      ])].sort();
      assert.deepStrictEqual(spenders, [
        EXCHANGES.standard, EXCHANGES.negRisk,
        ADAPTERS.ctfCollateralAdapter, ADAPTERS.negRiskCtfCollateralAdapter,
      ].map(a => a.toLowerCase()).sort());
      // Every pUSD approval is for max uint256.
      assert.ok(approvals.every(c => c.data.toLowerCase().endsWith('f'.repeat(64))),
        'max uint256, so the allowance cannot run out mid-run');
      assert.ok(operators.every(c => /0{63}1$/.test(c.data)), 'operator approved = true');
    } finally {
      await relayer.close(); await rpc.close(); onchain.resetProviders();
    }
  });

  await t('a relayer rejection is reported, and nothing is claimed as granted', async () => {
    const rpc = await startFakeRpc();
    const relayer = await startFakeRelayer(rpc);
    relayer.close();
    // Re-open the same port with a server that rejects /submit.
    const rejecting = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://relayer');
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (u.pathname === '/nonce') return send(200, { nonce: 1 });
        if (u.pathname === '/submit') return send(400, { error: 'invalid nonce' });
        return send(404, {});
      });
    });
    await new Promise(r => rejecting.listen(0, '127.0.0.1', r));
    try {
      const cfgUrl = `http://127.0.0.1:${rejecting.address().port}`;
      const cfg = JSON.parse(JSON.stringify(CONFIG));
      cfg.relayer.url = cfgUrl;
      cfg.relayer.apiKey = RELAYER_KEY;
      cfg.relayer.apiKeyAddress = RELAYER_KEY_ADDRESS;
      cfg.endpoints.polygonRpc = rpc.rpcUrl;
      cfg.wallet.privateKey = TEST_PK;
      cfg.wallet.funderAddress = DEPOSIT_WALLET;
      cfg.wallet.signatureType = 3;
      const auth = new PolymarketAuth(cfg);
      auth.syncBalanceAllowance = async () => ({ ok: true });
      const client = new RelayerClient(cfg, auth);
      const res = await client.setupTradingApprovals({ maxPolls: 2, pollMs: 1 });

      assert.strictEqual(res.ok, false);
      assert.match(res.error, /invalid nonce/);
      assert.strictEqual(res.attempted.length, 8, 'the report names every call it tried');
      assert.strictEqual(res.submitted, undefined, 'nothing was submitted');
      assert.ok(rpc.granted.size === 0, 'the chain was never touched');
    } finally {
      await new Promise(r => rejecting.close(r));
      await rpc.close();
      onchain.resetProviders();
    }
  });

  await t('an already-approved wallet submits nothing at all', async () => {
    const rpc = await startFakeRpc();
    const relayer = await startFakeRelayer(rpc);
    try {
      for (const spender of [
        EXCHANGES.standard, EXCHANGES.negRisk,
        ADAPTERS.ctfCollateralAdapter, ADAPTERS.negRiskCtfCollateralAdapter,
      ]) {
        rpc.granted.add(`erc20:${spender.toLowerCase()}`);
        rpc.granted.add(`erc1155:${spender.toLowerCase()}`);
      }
      const { client, syncs } = clientFor(rpc, relayer);
      const res = await client.setupTradingApprovals({ maxPolls: 2, pollMs: 1 });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.alreadyApproved, true);
      assert.strictEqual(relayer.submits.length, 0, 'no transaction for an approved wallet');
      assert.strictEqual(relayer.nonces.length, 0, 'not even a nonce was fetched');
      assert.strictEqual(syncs.length, 0, 'and no pointless cache refresh');
    } finally {
      await relayer.close(); await rpc.close(); onchain.resetProviders();
    }
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
