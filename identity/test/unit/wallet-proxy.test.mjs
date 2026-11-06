/**
 * WalletProxy (internal): reading the network's cryptographic parameters and reusing them within one
 * ConcordiumIdentity. (It no longer reads the provider list: the wallet passes that in.) Recorded data; no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import WalletProxy from '../../src/providers/WalletProxy.js';
import { walletProxyFetch, testnetConfig } from '../helpers.mjs';

const PROXY = CONCORDIUM_TESTNET_IDENTITY_CONFIG.walletProxyUrl;
const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('the cryptographic parameters are read only once; the provider list is never read', async () => {
  const { fetch, requests } = walletProxyFetch('testnet');
  const proxy = new WalletProxy({ walletProxyUrl: PROXY }, { fetch });
  const first = await proxy.globalContext();
  assert.equal(await proxy.globalContext(), first);
  assert.deepEqual(requests, [`${PROXY}/v0/global`]);
  assert.equal(proxy.providerEntries, undefined, 'no way to fetch the list');
});

test('a failed read is not remembered: the next call tries again', async () => {
  const { fetch: recorded } = walletProxyFetch('testnet');
  let fail = true;
  const fetch = async (url) => (fail ? { ok: false, status: 503, json: async () => ({}) } : recorded(url));
  const proxy = new WalletProxy({ walletProxyUrl: PROXY }, { fetch });
  await assert.rejects(() => proxy.globalContext(), /answered HTTP 503 for the cryptographic parameters/);
  fail = false;
  assert.ok((await proxy.globalContext()).genesisString);
});

test('unexpected answers are refused clearly', async () => {
  const answering = (body) => new WalletProxy({ walletProxyUrl: PROXY }, { fetch: async () => ({ ok: true, status: 200, json: async () => body }) });
  await assert.rejects(() => answering({ value: {} }).globalContext(), /cryptographic parameters in an unexpected format/);
});

test('one identity reads the cryptographic parameters once, however often it needs them', async () => {
  const { fetch, requests } = walletProxyFetch('testnet');
  const identity = new ConcordiumIdentity(TEST_PHRASE, testnetConfig(), { fetch });
  // The ownership check (used when collecting) needs them; it is much quicker than building a full request.
  await identity._issuance.expectedIdCredPub(0, 0);
  await identity._issuance.expectedIdCredPub(0, 1);
  assert.equal(requests.filter((url) => url.endsWith('/v0/global')).length, 1);
});
