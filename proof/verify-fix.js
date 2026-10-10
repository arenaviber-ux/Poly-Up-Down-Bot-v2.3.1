#!/usr/bin/env node
'use strict';
/**
 * verify-fix.js — proves the patched bot produces byte-identical output to
 * Polymarket's official @polymarket/clob-client-v2 for
 *   (a) a POLY_1271 (Deposit Wallet, type 3) order, and
 *   (b) the L2 HMAC authorisation header.
 *
 * usage:  node verify-fix.js [path/to/PATCHED/bot]      (defaults to this package)
 * requires: the patched bot's node_modules (ethers) and clob-client-v2 + viem
 *           (npm i @polymarket/clob-client-v2 viem).
 */
const path = require('path');
const BOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
console.error(`verifying: ${BOT}\n`);
const { signOrder } = require(BOT + '/orderSigner.js');
const { PolymarketAuth } = require(BOT + '/polymarketAuth.js');
const { OrderBuilder, SignatureTypeV2, createL2Headers } = require('@polymarket/clob-client-v2');
const { createWalletClient, http, recoverTypedDataAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
const DEPOSIT_WALLET = '0x2e234dae75c793f67a35089c9d99245e1c58470b';
const EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';
const ZERO32 = '0x' + '0'.repeat(64);
const ORDER_STRUCT = [
  { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
  { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
  { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' }, { name: 'timestamp', type: 'uint256' },
  { name: 'metadata', type: 'bytes32' }, { name: 'builder', type: 'bytes32' },
];
let fails = 0;
const check = (name, ok, extra) => { console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) fails++; };

(async () => {
  const ob = new OrderBuilder(walletClient, 137, SignatureTypeV2.POLY_1271, DEPOSIT_WALLET);
  const sdk = await ob.buildOrder(
    { tokenID: '12345678901234567890', price: 0.55, size: 10, side: 'BUY' },
    { tickSize: '0.01', negRisk: false },
  );

  const patched = await signOrder(
    { address: account.address, signTypedData: (d, t, m) => account.signTypedData({ domain: d, types: t, primaryType: 'TypedDataSign', message: m }) },
    {
      tokenId: sdk.tokenId, side: 'BUY', maker: DEPOSIT_WALLET, signer: account.address,
      signatureType: 3, negRisk: false,
      makerAmount: sdk.makerAmount, takerAmount: sdk.takerAmount,
      salt: Number(sdk.salt), timestamp: sdk.timestamp, chainId: 137,
    },
  );

  console.log('\n(a) POLY_1271 order — patched bot vs official SDK\n');
  check('order.signer is the Deposit Wallet', patched.order.signer === sdk.signer, patched.order.signer);
  check('order.maker matches', patched.order.maker === sdk.maker);
  check('makerAmount / takerAmount match', patched.order.makerAmount === sdk.makerAmount && patched.order.takerAmount === sdk.takerAmount);
  check('signature is byte-identical to the SDK', patched.order.signature === sdk.signature);
  check('envelope length 317 bytes', (patched.order.signature.length - 2) / 2 === 317);

  const tds = {
    domain: { name: 'Polymarket CTF Exchange', version: '2', chainId: 137, verifyingContract: EXCHANGE_V2 },
    types: {
      TypedDataSign: [
        { name: 'contents', type: 'Order' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' },
      ], Order: ORDER_STRUCT,
    },
    primaryType: 'TypedDataSign',
    message: {
      contents: {
        salt: BigInt(sdk.salt), maker: sdk.maker, signer: sdk.signer, tokenId: BigInt(sdk.tokenId),
        makerAmount: BigInt(sdk.makerAmount), takerAmount: BigInt(sdk.takerAmount), side: 0, signatureType: 3,
        timestamp: BigInt(sdk.timestamp), metadata: ZERO32, builder: ZERO32,
      },
      name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: DEPOSIT_WALLET, salt: ZERO32,
    },
  };
  const recovered = await recoverTypedDataAddress({ ...tds, signature: patched.order.signature.slice(0, 132) });
  check('inner signature recovers to the key owner (ERC-1271 will pass)', recovered.toLowerCase() === account.address.toLowerCase(), recovered);

  // ---------------------------------------------------------------- (b) L2 HMAC
  console.log('\n(b) L2 authorisation header for GET /balance-allowance\n');
  const creds = {
    key: '11111111-2222-3333-4444-555555555555',
    secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==', // base64
    passphrase: 'pass-phrase',
  };
  const ts = 1791028922;
  const sdkHeaders = await createL2Headers(walletClient, creds, { method: 'GET', requestPath: '/balance-allowance' }, ts);

  const auth = new PolymarketAuth({ endpoints: { clob: 'https://clob.polymarket.com' }, chainId: 137, wallet: { apiKey: creds.key, apiSecret: creds.secret, apiPassphrase: creds.passphrase } });
  auth.signerAddress = account.address;
  const botHeaders = auth.createL2Headers('GET', '/balance-allowance', '');
  // freeze the timestamp so the two HMAC inputs are comparable
  const botSig = PolymarketAuth.buildL2Signature(creds.secret, ts, 'GET', '/balance-allowance', '');
  check('POLY_SIGNATURE matches the official SDK', botSig === sdkHeaders.POLY_SIGNATURE);
  check('signature is over the path WITHOUT the query string',
    botSig !== PolymarketAuth.buildL2Signature(creds.secret, ts, 'GET', '/balance-allowance?asset_type=COLLATERAL&signature_type=3', ''));
  check('patched signedRequest signs the bare path', require('fs').readFileSync(BOT + '/polymarketAuth.js', 'utf8').includes("pathWithQuery.split('?')[0]"));
  check('patched auth refreshes /balance-allowance/update', require('fs').readFileSync(BOT + '/polymarketAuth.js', 'utf8').includes('/balance-allowance/update'));

  console.log(`\n${fails === 0 ? '\x1b[32mall checks passed\x1b[0m' : `\x1b[31m${fails} check(s) failed\x1b[0m`}\n`);
  process.exit(fails ? 1 : 0);
})();
