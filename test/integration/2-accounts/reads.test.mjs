/**
 * Integration — read operations against the live testnet node.
 * Run with:  npm run test:integration   (needs network; uses the held test tokens)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, ACCOUNT_PATH, KNOWN_ADDRESS, PLT_TOKEN, CIS2_TOKEN } from '../helpers.mjs';

test('getAddress derives the known testnet address', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  assert.equal(await a.getAddress(), KNOWN_ADDRESS);
  m.dispose();
});

test('getBalance returns a positive CCD balance', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const bal = await a.getBalance();
  assert.equal(typeof bal, 'bigint');
  assert.ok(bal > 0n, `expected > 0 microCCD, got ${bal}`);
  m.dispose();
});

test('getTokenBalance reads the PLT balance', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const bal = await a.getTokenBalance(PLT_TOKEN);
  assert.ok(bal > 0n, `expected to hold some ${PLT_TOKEN}, got ${bal}`);
  m.dispose();
});

test('getTokenBalance reads the CIS-2 balance (same method, different id)', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const bal = await a.getTokenBalance(CIS2_TOKEN);
  assert.ok(bal > 0n, `expected to hold some ${CIS2_TOKEN}, got ${bal}`);
  m.dispose();
});

test('getCis2Metadata resolves the on-chain metadata URL (and symbol when reachable)', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const { url, metadata } = await a.getCis2Metadata(CIS2_TOKEN);
  // The URL comes from the contract on-chain and must always resolve.
  assert.ok(url, 'expected a metadata URL from the contract');
  // The metadata document is fetched off-chain (an IPFS gateway) and is best-effort:
  // getCis2Metadata returns metadata=null if the gateway is unreachable. Only assert
  // its shape when it was actually fetched, so the suite doesn't depend on IPFS uptime.
  if (metadata !== null) {
    assert.equal(typeof metadata.symbol, 'string', 'metadata should carry a string symbol');
  }
  m.dispose();
});
