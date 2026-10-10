'use strict';
/**
 * On-chain reads and calldata encoders for the trading approvals.
 *
 * Why this exists: the CLOB keeps a *server-side cache* of your balance and
 * allowance (`GET /balance-allowance`), and in CLOB V2 that response reports
 * allowances per spender (`allowances: { "<exchange>": "<base units>" }`). The
 * cache is refreshed only when you ask for it, and it is not the source of
 * truth for whether an approval exists — the token contract is. Every "my
 * allowance is 0" investigation ends with reading `allowance()` /
 * `isApprovedForAll()` directly, so this module does exactly that, once, for
 * every contract that has to be approved.
 *
 * ethers v6 only, read-only, no dependency on the rest of the bot.
 */
const { Contract, JsonRpcProvider, Interface } = require('ethers');
const { CTF, EXCHANGES, MAX_UINT256, TOKENS, UNLIMITED_ALLOWANCE, tradingApprovals } = require('./contracts');

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ERC1155_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

const erc20Interface = new Interface(ERC20_ABI);
const erc1155Interface = new Interface(ERC1155_ABI);

/** Encode `approve(spender, amount)` — max uint256 by default. */
function encodeApprove(spender, token = TOKENS.pUSD, amount = MAX_UINT256) {
  void token; // kept for call-compatibility: the selector depends on `spender` only
  return erc20Interface.encodeFunctionData('approve', [spender, BigInt(amount)]);
}

/** Encode `setApprovalForAll(operator, approved)` on an ERC-1155 (the CTF). */
function encodeSetApprovalForAll(operator, token = CTF, approved = true) {
  void token;
  return erc1155Interface.encodeFunctionData('setApprovalForAll', [operator, !!approved]);
}

/**
 * One calldata call for an approval, in the shape both the relayer batch and a
 * direct EOA transaction expect.
 */
function approvalCall(approval) {
  return {
    to: approval.token,
    value: '0',
    data: approval.kind === 'erc20'
      ? encodeApprove(approval.spender, approval.token)
      : encodeSetApprovalForAll(approval.spender, approval.token, true),
  };
}

let providerCache = new Map();

/** Cached read-only provider (one per RPC URL). */
function getProvider(rpcUrl, chainId = 137) {
  const key = `${rpcUrl}#${chainId}`;
  if (!providerCache.has(key)) providerCache.set(key, new JsonRpcProvider(rpcUrl, chainId));
  return providerCache.get(key);
}

/** Test seam: drop cached providers (used by tests that swap RPC URLs). */
function resetProviders() { providerCache = new Map(); }

/**
 * Read the pUSD allowance and the CTF operator approval for one spender.
 * @returns {Promise<{granted:boolean, allowance:number|null, approved:boolean|null, error?:string}>}
 */
async function readApproval(provider, approval, owner) {
  try {
    if (approval.kind === 'erc20') {
      const token = new Contract(approval.token, ERC20_ABI, provider);
      const raw = await token.allowance(owner, approval.spender);
      const allowance = Number(raw) / 1e6;
      // A finite allowance is treated as not granted: the bot spends it down and
      // then starts failing orders mid-run. Polymarket's own tooling approves
      // max uint256 and re-approves anything below that.
      const unlimited = raw >= UNLIMITED_ALLOWANCE;
      return { granted: unlimited, allowance, approved: null, limited: raw > 0n && !unlimited };
    }
    const token = new Contract(approval.token, ERC1155_ABI, provider);
    const approved = await token.isApprovedForAll(owner, approval.spender);
    return { granted: !!approved, allowance: null, approved: !!approved };
  } catch (e) {
    return { granted: false, allowance: null, approved: null, error: e.message };
  }
}

/**
 * The ground-truth approval state of an account wallet.
 *
 * @param {object} p
 * @param {string} p.rpcUrl
 * @param {number} [p.chainId]
 * @param {string} p.owner          account wallet (funder) address
 * @param {string[]} [p.include]    which groups: 'exchange' and/or 'adapter'
 * @param {boolean} [p.negRiskOnly]
 * @param {boolean} [p.standardOnly]
 * @returns {Promise<{ok:boolean, owner:string, checks:Array, missing:Array, error?:string}>}
 */
async function readTradingApprovals({ rpcUrl, chainId = 137, owner, include, negRiskOnly = false, standardOnly = false }) {
  const approvals = tradingApprovals({ include: include || undefined, negRiskOnly, standardOnly });
  if (!owner) return { ok: false, error: 'no account wallet address to read approvals for' };
  const provider = getProvider(rpcUrl, chainId);
  const results = await Promise.all(approvals.map(a => readApproval(provider, a, owner)));
  const checks = approvals.map((a, i) => ({ ...a, ...results[i] }));
  const failed = checks.filter(c => c.error);
  return {
    ok: failed.length === 0,
    owner,
    checks,
    // A check that could not be read is NOT reported as missing: with an RPC
    // outage the caller would otherwise conclude approvals are absent and
    // submit redundant (but harmless) calls. It is surfaced as `error`.
    missing: checks.filter(c => !c.error && !c.granted),
    error: failed.length ? failed.map(c => `${c.label}: ${c.error}`).join('; ') : undefined,
  };
}

/**
 * pUSD (and USDC.e) balances of an address. The most common live-order failure
 * after funding is pUSD sitting on the signer EOA instead of the account
 * wallet, which reads as "balance is not enough" from the CLOB.
 * @returns {Promise<{ok:boolean, pUSD:number, usdce:number, total:number, error?:string}>}
 */
async function readCollateralBalances({ rpcUrl, chainId = 137, owner }) {
  if (!owner) return { ok: false, pUSD: 0, usdce: 0, total: 0, error: 'no address' };
  try {
    const provider = getProvider(rpcUrl, chainId);
    const [pusdRaw, usdceRaw] = await Promise.all([
      new Contract(TOKENS.pUSD, ERC20_ABI, provider).balanceOf(owner),
      new Contract(TOKENS.usdce, ERC20_ABI, provider).balanceOf(owner),
    ]);
    const pUSD = Number(pusdRaw) / 1e6;
    const usdce = Number(usdceRaw) / 1e6;
    return { ok: true, pUSD, usdce, total: pUSD + usdce };
  } catch (e) {
    return { ok: false, pUSD: 0, usdce: 0, total: 0, error: e.message };
  }
}

module.exports = {
  ERC20_ABI,
  ERC1155_ABI,
  CTF,
  EXCHANGES,
  MAX_UINT256,
  approvalCall,
  encodeApprove,
  encodeSetApprovalForAll,
  getProvider,
  readApproval,
  readCollateralBalances,
  readTradingApprovals,
  resetProviders,
};
