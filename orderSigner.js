'use strict';
/**
 * Order construction, tick-size conformant rounding, and EIP-712 signing for
 * the Polymarket CTF Exchange (v2 typed data).
 *
 * Amounts are always 6-decimal integer strings. The rounding order matters and
 * follows the documented rules:
 *   1. round the PRICE to `priceDecimals`
 *   2. FLOOR the share quantity to `sizeDecimals`
 *   3. compute USD = price * size; if it exceeds `amountDecimals`, round UP to
 *      amountDecimals + 4 and then DOWN to amountDecimals
 * Reference: docs.polymarket.com/trading/place-orders
 */
const { AbiCoder, keccak256, toUtf8Bytes, concat } = require('ethers');
const { EXCHANGES } = require('./contracts');
const { feePerShare } = require('./pricing');

// The CLOB rejects GTD expirations less than 180 seconds ahead. Leave
// another 30 seconds for signing, transit and modest clock skew. This is an
// absolute server-side backstop, NOT the bot's short cancellation deadline.
const GTD_MIN_SECONDS = 180;
const GTD_EXPIRY_MARGIN_SECONDS = 30;
function gtdExpiration(seconds, nowMs = Date.now()) {
  const horizon = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
  return Math.ceil(nowMs / 1000)
    + Math.max(horizon, GTD_MIN_SECONDS + GTD_EXPIRY_MARGIN_SECONDS);
}

// CLOB V2 exchange domain. `verifyingContract` is the V2 exchange this order
// settles through (see contracts.js); signing against the V1 exchange address
// is rejected as an invalid signature.
const DOMAIN_NAME = 'Polymarket CTF Exchange';
const DOMAIN_VERSION = '2';

const ORDER_TYPE_SIGNATURE =
  'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,'
  + 'uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)';

const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

/** tick size -> { priceDecimals, sizeDecimals, amountDecimals } */
const TICK_RULES = {
  0.1: { price: 1, size: 2, amount: 3 },
  0.01: { price: 2, size: 2, amount: 4 },
  0.005: { price: 3, size: 2, amount: 5 },
  0.0025: { price: 4, size: 2, amount: 6 },
  0.001: { price: 3, size: 2, amount: 5 },
  0.0001: { price: 4, size: 2, amount: 6 },
};

const ZERO_BYTES32 = '0x' + '0'.repeat(64);

// --------------------------------------------------------------- decimals
function decimalsOf(n) {
  const s = Number(n).toString();
  if (s.includes('e-')) {
    const [mant, exp] = s.split('e-');
    const frac = (mant.split('.')[1] || '').length;
    return frac + parseInt(exp, 10);
  }
  return (s.split('.')[1] || '').length;
}

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) throw new Error(`roundTo: non-finite value ${value}`);
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function floorTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

function ceilTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.ceil(value * f - 1e-9) / f;
}

function toFixedSafe(value, decimals) {
  return roundTo(value, decimals).toFixed(decimals);
}

/** Decimal string -> 6-decimal integer string, validating precision. */
function toUnits6(value, maxDecimals, label) {
  const dec = decimalsOf(value);
  if (dec > maxDecimals) throw new Error(`${label}: ${value} has ${dec} decimals, max ${maxDecimals}`);
  return BigInt(Math.round(Number(value) * 1e6)).toString();
}

// -------------------------------------------------------------- tick rules
function tickRules(tickSize) {
  const t = Number(tickSize);
  if (TICK_RULES[t]) return TICK_RULES[t];
  // Unknown tick: derive conservative rules (round price to the tick itself).
  return { price: decimalsOf(t), size: 2, amount: Math.min(6, decimalsOf(t) + 3) };
}

/**
 * Snap a price to the market's tick.
 * @param {'nearest'|'up'|'down'} mode  BUY limits round up (so they still
 *   cross the ask); SELL limits round down. `nearest` is for display/quoting.
 */
function roundPriceToTick(price, tickSize, mode = 'nearest') {
  const t = Number(tickSize);
  if (!(t > 0)) throw new Error(`invalid tick size ${tickSize}`);
  const r = tickRules(t);
  const steps = price / t;
  const snapped = mode === 'up' ? Math.ceil(steps - 1e-9)
    : mode === 'down' ? Math.floor(steps + 1e-9)
      : Math.round(steps);
  return roundTo(snapped * t, Math.min(r.price, 6));
}

/**
 * Build makerAmount / takerAmount (6-decimal strings) for a BUY.
 * @returns {{price:number, size:number, makerAmount:string, takerAmount:string, usd:number}}
 */
function computeBuyAmounts(rawPrice, rawSize, tickSize) {
  const r = tickRules(tickSize);
  // A BUY limit rounds UP to the tick so the order still crosses the ask.
  const price = roundPriceToTick(rawPrice, tickSize, 'up');
  const size = floorTo(rawSize, r.size);
  if (size <= 0) throw new Error('size rounds to zero');
  if (price <= 0 || price >= 1) throw new Error(`price ${price} out of range (0,1)`);

  let usdDecimals = r.amount;
  let usd = price * size;
  if (decimalsOf(usd.toFixed(12)) > usdDecimals) {
    usd = roundTo(usd, usdDecimals + 4);
    usd = floorTo(usd, usdDecimals);
  }
  usd = floorTo(usd, usdDecimals);

  return {
    price,
    size,
    usd,
    // BUY: maker pays USD, taker receives shares.
    makerAmount: toUnits6(toFixedSafe(usd, usdDecimals), 6, 'makerAmount(usd)'),
    takerAmount: toUnits6(toFixedSafe(size, r.size), 6, 'takerAmount(shares)'),
  };
}

/** Order types the exchange validates as MARKET orders, not limit orders. */
const MARKET_ORDER_TYPES = ['FAK', 'FOK'];

/**
 * Build makerAmount / takerAmount (6-decimal strings) for a MARKETABLE buy
 * (orderType FAK or FOK).
 *
 * The exchange validates market orders under MIRRORED precision rules compared
 * to limit orders. For a limit BUY the taker amount (shares) carries `size`
 * decimals and the maker amount (USD) carries `amount` decimals; for a market
 * BUY it is the other way round — maker (USD) is capped at `size` decimals and
 * taker (shares) at `amount`. With tick 0.01 that is maker<=2, taker<=4.
 *
 * Sending limit-shaped amounts on a FAK order is rejected with:
 *   "invalid amounts, the market buy orders maker amount supports a max
 *    accuracy of 2 decimals, taker amount a max of 4 decimals"
 *
 * The bot hit this on every entry whose price*size product ran past 2 decimals
 * (e.g. 0.51 * 10.78 = 5.4978) and silently passed the ones that happened to
 * land on a round cent.
 *
 * Mirrors getMarketOrderRawAmounts() in @polymarket/clob-client-v2.
 *
 * @param {number} rawPrice  worst acceptable price
 * @param {number} rawUsd    USD to spend (the maker amount for a market buy)
 * @returns {{price:number, size:number, usd:number, makerAmount:string, takerAmount:string}}
 */
function computeMarketBuyAmounts(rawPrice, rawUsd, tickSize) {
  const r = tickRules(tickSize);
  // Still round UP so a marketable order crosses the ask; the price is already
  // tick-aligned, so the market-order roundDown in the SDK is a no-op here.
  const price = roundPriceToTick(rawPrice, tickSize, 'up');
  if (price <= 0 || price >= 1) throw new Error(`price ${price} out of range (0,1)`);

  // Maker amount is the USD spend, capped at `size` decimals (2).
  const usd = floorTo(rawUsd, r.size);
  if (usd <= 0) throw new Error('usd rounds to zero');

  // Taker amount is what that USD buys, capped at `amount` decimals (4).
  let shares = usd / price;
  if (decimalsOf(shares.toFixed(12)) > r.amount) {
    shares = roundTo(shares, r.amount + 4);
    shares = floorTo(shares, r.amount);
  }
  shares = floorTo(shares, r.amount);
  if (shares <= 0) throw new Error('shares round to zero');

  return {
    price,
    size: shares,
    usd,
    // Market BUY: maker pays USD, taker receives shares.
    makerAmount: toUnits6(toFixedSafe(usd, r.size), 6, 'makerAmount(usd)'),
    takerAmount: toUnits6(toFixedSafe(shares, r.amount), 6, 'takerAmount(shares)'),
  };
}

/** Build makerAmount / takerAmount for a SELL. */
function computeSellAmounts(rawPrice, rawSize, tickSize) {
  const r = tickRules(tickSize);
  // A SELL limit rounds DOWN to the tick so the order still crosses the bid.
  const price = roundPriceToTick(rawPrice, tickSize, 'down');
  const size = floorTo(rawSize, r.size);
  if (size <= 0) throw new Error('size rounds to zero');
  let usd = price * size;
  usd = floorTo(usd, r.amount);
  return {
    price,
    size,
    usd,
    // SELL: maker gives shares, taker pays USD.
    makerAmount: toUnits6(toFixedSafe(size, r.size), 6, 'makerAmount(shares)'),
    takerAmount: toUnits6(toFixedSafe(usd, r.amount), 6, 'takerAmount(usd)'),
  };
}

/**
 * Minimum order size expressed in shares, plus the USD cost of that minimum.
 */
function minimumOrderNotional({ minShares, price }) {
  return { shares: minShares, usd: minShares * price };
}

/**
 * Decide the executable share count for a desired USD stake, honouring the
 * market's minimum share count and the MAX_TRADE_SIZE_USD cap.
 *
 * The cap is a hard limit on what ONE order costs *including the taker fee*:
 * cost + fee <= maxStakeUsd, both measured at `price` (the limit price). The
 * fee is the bot's own model (feePerShare over the market's feeSchedule), the
 * same one the edge gate and Kelly use. Without a feeSchedule the fee is 0 and
 * the cap is on the cost alone.
 *
 * The cap is applied to the stake before the share count is derived, and the
 * minimum-share nudge must not break it: if the market's minimum order costs
 * more than `maxStakeUsd`, the order is declined (ok:false) whatever
 * `minOrderPolicy` says.
 *
 * @returns {{ok:boolean, shares:number, usd:number, feeUsd:number, totalUsd:number, bumped:boolean, reason?:string}}
 *   usd      cost of the shares at the limit price
 *   feeUsd   estimated taker fee on those shares
 *   totalUsd usd + feeUsd, the figure the cap and the balance check apply to
 */
function sizeOrder({
  stakeUsd, price, minShares, tickSize, maxStakeUsd = Infinity, minOrderPolicy = 'bump', feeSchedule = null,
}) {
  const rules = tickRules(tickSize);
  const feePerSh = feePerShare(price, feeSchedule);
  const perShareTotal = price + feePerSh;   // what one share costs including its fee
  const costOf = (shares) => roundTo(shares * price, rules.amount);
  const feeOf = (shares) => shares * feePerSh;
  const totalOf = (shares) => costOf(shares) + feeOf(shares);
  const capOk = (total) => total <= maxStakeUsd + 1e-9;
  const decline = (reason, bumped = false) => ({
    ok: false, shares: 0, usd: 0, feeUsd: 0, totalUsd: 0, bumped, reason,
  });

  const minViableUsd = minShares * price;
  let usd = stakeUsd;
  let bumped = false;

  if (usd < minViableUsd) {
    if (minOrderPolicy === 'skip') {
      return decline(`stake $${stakeUsd.toFixed(2)} buys ${(stakeUsd / price).toFixed(2)} shares < market minimum ${minShares}`);
    }
    usd = minViableUsd;
    bumped = true;
  }

  // The smallest order the market accepts must fit under the cap, fee included.
  // If it does not, no size of order does, so decline rather than buy a larger one.
  if (minShares * perShareTotal > maxStakeUsd + 1e-9) {
    const minCost = costOf(minShares);
    const minFee = feeOf(minShares);
    const feeText = minFee > 0 ? ` plus $${minFee.toFixed(2)} fee` : '';
    return decline(
      `the ${minShares}-share market minimum costs $${minCost.toFixed(2)}${feeText} at ${(price * 100).toFixed(1)}c, `
        + `above the $${maxStakeUsd.toFixed(2)} cap (MAX_TRADE_SIZE_USD)`,
      bumped,
    );
  }

  // Cap the cost so that cost + fee fits: cost <= cap * price / (price + fee per share).
  const maxCostUsd = Number.isFinite(maxStakeUsd) ? maxStakeUsd * price / perShareTotal : Infinity;
  if (usd > maxCostUsd) usd = maxCostUsd;

  let shares = floorTo(usd / price, rules.size);
  if (shares < minShares) {
    // Rounding down dropped us below the minimum: nudge up to it. The pre-check
    // above guarantees the minimum still fits under the cap.
    shares = ceilTo(minShares, rules.size);
  }
  // Cost is rounded to the tick's amount precision, which can push the total a
  // fraction over the cap. Step down one size increment until it fits, never
  // below the minimum (which is known to fit).
  while (!capOk(totalOf(shares)) && shares - rules.size >= minShares - 1e-9) {
    shares = roundTo(shares - rules.size, 6);
  }
  if (!capOk(totalOf(shares)) || shares + 1e-9 < minShares) {
    return decline(`cannot size an order of at least ${minShares} shares within the $${maxStakeUsd.toFixed(2)} cap`, bumped);
  }

  const cost = costOf(shares);
  const fee = roundTo(feeOf(shares), 6);
  return { ok: true, shares, usd: cost, feeUsd: fee, totalUsd: roundTo(cost + fee, 6), bumped };
}

// ------------------------------------------------------------- signing
function exchangeAddress(negRisk) {
  return negRisk ? EXCHANGES.negRisk : EXCHANGES.standard;
}

function saltFromRandom() {
  // Keep within Number.MAX_SAFE_INTEGER because the request body serialises
  // the salt as a JSON number.
  const buf = require('crypto').randomBytes(6); // 48 bits
  return Number(BigInt('0x' + buf.toString('hex')));
}

/**
 * @param {object} p
 * @param {number|string} p.tokenId
 * @param {'BUY'|'SELL'} p.side
 * @param {string} p.makerAmount   6-dec units
 * @param {string} p.takerAmount   6-dec units
 * @param {string} p.maker         account wallet (funder)
 * @param {string} p.signer        EOA that signs
 * @param {number} p.signatureType 0..3
 * @param {boolean} p.negRisk
 * @param {number} [p.expiration]  unix seconds (GTD); 0 for GTC/FAK
 * @param {number} [p.chainId]
 * @param {string} [p.metadata]
 * @param {string} [p.builder]
 */
function buildOrderTypedData(p) {
  const chainId = p.chainId || 137;
  const verifyingContract = exchangeAddress(!!p.negRisk);
  const domain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract };
  const types = {
    Order: [
      { name: 'salt', type: 'uint256' },
      { name: 'maker', type: 'address' },
      { name: 'signer', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'makerAmount', type: 'uint256' },
      { name: 'takerAmount', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'signatureType', type: 'uint8' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'metadata', type: 'bytes32' },
      { name: 'builder', type: 'bytes32' },
    ],
  };
  const message = {
    salt: p.salt !== undefined ? p.salt : saltFromRandom(),
    maker: p.maker,
    signer: p.signer,
    tokenId: String(p.tokenId),
    makerAmount: String(p.makerAmount),
    takerAmount: String(p.takerAmount),
    side: p.side === 'SELL' ? 1 : 0,
    signatureType: Number(p.signatureType),
    timestamp: String(p.timestamp || Date.now()),
    metadata: p.metadata || ZERO_BYTES32,
    builder: p.builder || ZERO_BYTES32,
  };
  return { domain, types, message, orderTypeSignature: ORDER_TYPE_SIGNATURE, verifyingContract };
}

/**
 * ERC-7739 wrapper for Deposit Wallets (signature type 3). Proxy / Safe / EOA
 * submit the raw EIP-712 signature instead.
 */
function wrapDepositWalletSignature(typedData, innerSignature) {
  const abi = AbiCoder.defaultAbiCoder();
  const { domain } = typedData;
  const o = typedData.message;

  const appDomainSeparator = keccak256(abi.encode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [
      keccak256(toUtf8Bytes(EIP712_DOMAIN_TYPE)),
      keccak256(toUtf8Bytes(domain.name)),
      keccak256(toUtf8Bytes(domain.version)),
      BigInt(domain.chainId),
      domain.verifyingContract,
    ],
  ));

  const contentsHash = keccak256(abi.encode(
    ['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint8', 'uint8', 'uint256', 'bytes32', 'bytes32'],
    [
      keccak256(toUtf8Bytes(ORDER_TYPE_SIGNATURE)),
      BigInt(o.salt),
      o.maker,
      o.signer,
      BigInt(o.tokenId),
      BigInt(o.makerAmount),
      BigInt(o.takerAmount),
      Number(o.side),
      Number(o.signatureType),
      BigInt(o.timestamp),
      o.metadata,
      o.builder,
    ],
  ));

  const orderTypeBytes = toUtf8Bytes(ORDER_TYPE_SIGNATURE);
  // ERC-7739 terminates the wrapped signature with the type string followed by
  // its length as a 2-byte (uint16) big-endian value.
  const lenBytes = `0x${ORDER_TYPE_SIGNATURE.length.toString(16).padStart(4, '0')}`;
  return concat([innerSignature, appDomainSeparator, contentsHash, orderTypeBytes, lenBytes]);
}

/**
 * Sign a fully-formed order and return the exact order object accepted by
 * POST /order (minus salt/timestamp, which are included).
 */
/**
 * ERC-7739 / EIP-712 nested signing for Deposit Wallets (POLY_1271).
 *
 * The deposit wallet validates the order through ERC-1271, which unwraps the
 * envelope and re-hashes the *TypedDataSign* struct with the wallet's own
 * domain (name "DepositWallet"). Signing the plain Order struct — as this bot
 * used to — produces a signature the wallet cannot validate, so the order is
 * rejected. Mirror of ExchangeOrderBuilderV2.buildOrderSignature() in
 * @polymarket/clob-client-v2.
 */
function buildPoly1271TypedData(typedData) {
  const { domain, message } = typedData;
  return {
    domain,
    types: {
      TypedDataSign: [
        { name: 'contents', type: 'Order' },
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      Order: typedData.types.Order,
    },
    primaryType: 'TypedDataSign',
    message: {
      contents: message,
      name: 'DepositWallet',
      version: '1',
      chainId: domain.chainId,
      verifyingContract: message.signer, // the deposit wallet == the order's signer
      salt: ZERO_BYTES32,
    },
  };
}

async function signOrder(wallet, params) {
  const type = Number(params.signatureType);
  // For POLY_1271 the order's signer field is the Deposit Wallet itself,
  // not the EOA that holds the key (the EOA's role is only to produce the
  // inner EIP-712 signature).
  const signerField = type === 3 ? params.maker : params.signer;
  const typedData = buildOrderTypedData({ ...params, signer: signerField });
  const { domain, types, message } = typedData;
  const inner = type === 3
    ? await wallet.signTypedData(
        domain,
        buildPoly1271TypedData(typedData).types,
        buildPoly1271TypedData(typedData).message,
      )
    : await wallet.signTypedData(domain, types, message);
  const signature = type === 3
    ? wrapDepositWalletSignature(typedData, inner)
    : inner;

  return {
    order: {
      salt: message.salt,
      maker: message.maker,
      signer: message.signer,
      tokenId: String(message.tokenId),
      makerAmount: String(message.makerAmount),
      takerAmount: String(message.takerAmount),
      side: params.side,
      signatureType: Number(params.signatureType),
      timestamp: String(message.timestamp),
      expiration: String(params.expiration || 0),
      metadata: message.metadata,
      builder: message.builder,
      signature,
    },
    typedData,
    innerSignature: inner,
    verifyingContract: typedData.verifyingContract,
  };
}

module.exports = {
  EXCHANGES,
  ORDER_TYPE_SIGNATURE,
  TICK_RULES,
  ZERO_BYTES32,
  buildOrderTypedData,
  buildPoly1271TypedData,
  computeBuyAmounts,
  computeMarketBuyAmounts,
  computeSellAmounts,
  exchangeAddress,
  minimumOrderNotional,
  roundPriceToTick,
  saltFromRandom,
  signOrder,
  gtdExpiration,
  sizeOrder,
  tickRules,
  MARKET_ORDER_TYPES,
  wrapDepositWalletSignature,
  // exported for tests
  _internals: { decimalsOf, roundTo, floorTo, ceilTo, toUnits6 },
};
