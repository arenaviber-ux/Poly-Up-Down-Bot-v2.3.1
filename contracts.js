'use strict';
/**
 * Polymarket contract addresses — the single source of truth for this repo.
 *
 * Every address here was checked on 2026-10-08 against
 *   docs.polymarket.com/resources/contracts
 *   @polymarket/clob-client-v2@1.2.0  dist/config.js (MATIC_CONTRACTS)
 * Both agree; the previous copy of these constants in three files is what let
 * a stale value survive unnoticed.
 *
 * Polygon mainnet only (chainId 137). Amoy (80002) is deliberately absent —
 * this bot trades real money and there is no paper venue to drift into.
 */
const CHAIN_ID = 137;

/** Collateral. pUSD (not USDC.e) is what every CLOB V2 order settles in. */
const TOKENS = {
  // pUSD — ERC-20, 6 decimals, backed 1:1 by USDC.
  pUSD: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  // Legacy bridged USDC.e. Only used to wrap into pUSD via the onramp and by
  // the deprecated USDC.e redemption path.
  usdce: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};

/** Conditional Tokens Framework — ERC-1155, holds every outcome share. */
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/**
 * The CLOB V2 exchanges. These two addresses are doing three jobs at once:
 *   1. the EIP-712 `verifyingContract` of every order signature,
 *   2. the spender that must be approved for the account wallet's pUSD,
 *   3. the ERC-1155 operator that must be approved on the CTF.
 * Signing against the wrong one yields "invalid signature"; approving only one
 * yields "not enough balance / allowance" on the other market type.
 */
const EXCHANGES = {
  standard: '0xE111180000d2663C0091e4f400237545B87B996B',  // CTF Exchange (V2)
  negRisk: '0xe2222d279d744050d28e00520010520000310F59',   // Neg Risk CTF Exchange (V2)
};

/** pUSD <-> USDC.e conversion. */
const RAMPS = {
  onramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',   // wrap  USDC.e -> pUSD
  offramp: '0x2957922Eb93258b93368531d39fAcCA3B4dC5854',  // unwrap pUSD -> USDC.e
};

/** V2 collateral adapters — redemption straight into pUSD. */
const ADAPTERS = {
  ctfCollateralAdapter: '0xAdA100Db00Ca00073811820692005400218FcE1f',
  negRiskCtfCollateralAdapter: '0xadA2005600Dec949baf300f4C6120000bDB6eAab',
  // Neg-risk adapter for the deprecated CLOB V1 exchange (USDC.e output).
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
};

/** Account-wallet infrastructure used by the gasless relayer. */
const WALLETS = {
  // Deposit Wallet (signature type 3): a WALLET batch is submitted *to* the
  // factory, while the EIP-712 domain's verifyingContract is the wallet itself.
  depositWalletFactory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
  depositWalletBeacon: '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a',
  safeFactory: '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b',
  safeMultisend: '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
  proxyFactory: '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052',
  relayHub: '0xD216153c06E857cD7f72665E0aF1d7D82172F494',
};

const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * An ERC-20 allowance counts as "granted" only at or above this. The official
 * SDK approves max uint256 and re-approves anything below it, so a wallet that
 * was once approved a finite amount is treated as still needing the call —
 * otherwise the bot dies mid-run when the allowance runs out.
 */
const UNLIMITED_ALLOWANCE = 2n ** 128n;

/**
 * The approvals a Polymarket account wallet needs, in the order they are
 * submitted as one relayer batch.
 *
 * Two groups, both required by this bot:
 *
 *   exchange — the CLOB V2 exchanges. Without these, `POST /order` is rejected
 *              with "not enough balance / allowance". This is the table in
 *              docs.polymarket.com/trading/wallets-auth ("Set Up Trading
 *              Approvals"): pUSD via ERC-20 `approve`, conditional tokens via
 *              ERC-1155 `setApprovalForAll`, on both exchanges.
 *
 *   adapter  — the CTF collateral adapters the redemption sweeper calls to turn
 *              winning shares back into pUSD (redeemer.js). Approving only the
 *              exchanges leaves every redemption reverting, which is the silent
 *              half of the same bug. The official SDK's own approval plan
 *              includes both adapters for the same reason.
 *
 * @param {object} [o]
 * @param {string[]} [o.include]      which groups: 'exchange' and/or 'adapter'
 * @param {boolean} [o.negRiskOnly]   only the neg-risk side
 * @param {boolean} [o.standardOnly]  only the standard side
 * @returns {Array<{label:string, token:string, spender:string, kind:'erc20'|'erc1155', purpose:string}>}
 */
function tradingApprovals({ include = ['exchange', 'adapter'], negRiskOnly = false, standardOnly = false } = {}) {
  const spenders = [];
  if (include.includes('exchange')) {
    if (!negRiskOnly) spenders.push({ name: 'CTF Exchange', address: EXCHANGES.standard, purpose: 'exchange' });
    if (!standardOnly) spenders.push({ name: 'Neg Risk CTF Exchange', address: EXCHANGES.negRisk, purpose: 'exchange' });
  }
  if (include.includes('adapter')) {
    if (!negRiskOnly) spenders.push({ name: 'CtfCollateralAdapter', address: ADAPTERS.ctfCollateralAdapter, purpose: 'adapter' });
    if (!standardOnly) spenders.push({ name: 'NegRiskCtfCollateralAdapter', address: ADAPTERS.negRiskCtfCollateralAdapter, purpose: 'adapter' });
  }
  const out = [];
  for (const s of spenders) {
    out.push({
      label: `pUSD -> ${s.name}`,
      token: TOKENS.pUSD,
      spender: s.address,
      kind: 'erc20',
      purpose: s.purpose,
    });
    out.push({
      label: `Conditional Tokens -> ${s.name}`,
      token: CTF,
      spender: s.address,
      kind: 'erc1155',
      purpose: s.purpose,
    });
  }
  return out;
}

module.exports = {
  CHAIN_ID,
  TOKENS,
  CTF,
  EXCHANGES,
  RAMPS,
  ADAPTERS,
  WALLETS,
  MAX_UINT256,
  UNLIMITED_ALLOWANCE,
  tradingApprovals,
};
