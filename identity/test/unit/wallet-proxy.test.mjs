/**
 * WalletProxy (internal): reading the provider list and the network's cryptographic parameters, and
 * reusing the parameters within one ConcordiumIdentity. Recorded data; no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import WalletProxy from '../../src/providers/WalletProxy.js';
import { walletProxyFetch } from '../helpers.mjs';

const PROXY = CONCORDIUM_TESTNET_IDENTITY_CONFIG.walletProxyUrl;
const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('the provider list is read fresh each time; the cryptographic parameters only once', async () => {
  const { fetch, requests } = walletProxyFetch('testnet');
  const proxy = new WalletProxy({ walletProxyUrl: PROXY }, { fetch });
  await proxy.providerEntries();
  await proxy.providerEntries();
  const first = await proxy.globalContext();
  assert.equal(await proxy.globalContext(), first);
  assert.deepEqual(requests, [`${PROXY}/v1/ip_info`, `${PROXY}/v1/ip_info`, `${PROXY}/v0/global`]);
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
  await assert.rejects(() => answering({ not: 'a list' }).providerEntries(), /identity provider list in an unexpected format/);
  await assert.rejects(() => answering({ value: {} }).globalContext(), /cryptographic parameters in an unexpected format/);
});

test('one identity reads the cryptographic parameters once, however often it needs them', async () => {
  const { fetch, requests } = walletProxyFetch('testnet');
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch });
  // The ownership check (used when collecting) needs them; it is much quicker than building a full request.
  await identity._expectedIdCredPub(0, 0);
  await identity._expectedIdCredPub(0, 1);
  assert.equal(requests.filter((url) => url.endsWith('/v0/global')).length, 1);
});
