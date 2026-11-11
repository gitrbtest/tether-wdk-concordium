/**
 * Unit (mocked) — node-calling methods with an injected FAKE client (offline).
 * Verifies getBalanceForAddress balance parsing and error mapping using an
 * injected fake client, without contacting a testnet node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountNotCreatedError } from '../../../src/WalletAccountConcordium.js';
import { makeManager, CONFIG, KNOWN_ADDRESS, fakeClient } from '../../helpers.mjs';

/** A real account (offline-derived) with its client dependency replaced by a fake. */
async function accountWithFakeClient(client) {
  const manager = makeManager(CONFIG);
  const account = await manager.getAccountByPath('0/899424164/0');
  account._getClient = async () => client;   // inject the fake (dependency was constructor-provided)
  return { account, dispose: () => manager.dispose() };
}

test('getBalanceForAddress returns the microCCD balance reported by the node', async () => {
  const client = fakeClient({
    getAccountInfo: async () => ({ accountAmount: { microCcdAmount: 123456789n } }),
  });
  const { account, dispose } = await accountWithFakeClient(client);
  assert.equal(await account.getBalanceForAddress(KNOWN_ADDRESS), 123456789n);
  dispose();
});

test('getBalanceForAddress maps a "not found" node error to AccountNotCreatedError', async () => {
  const client = fakeClient({
    getAccountInfo: async () => { throw new Error('account not found'); },
  });
  const { account, dispose } = await accountWithFakeClient(client);
  await assert.rejects(() => account.getBalanceForAddress(KNOWN_ADDRESS), AccountNotCreatedError);
  dispose();
});

test('getBalanceForAddress rethrows a non-"not found" error unchanged', async () => {
  const client = fakeClient({
    getAccountInfo: async () => { throw new Error('connection refused'); },
  });
  const { account, dispose } = await accountWithFakeClient(client);
  await assert.rejects(() => account.getBalanceForAddress(KNOWN_ADDRESS), /connection refused/);
  dispose();
});

/** An account whose CIS-2 contract reports `url` as the metadata location, with HTTP faked by `fetchImpl`. */
async function accountWithFakeMetadata(url, fetchImpl) {
  const manager = makeManager(CONFIG);
  const account = await manager.getAccountByPath('0/899424164/0');
  account._cis2Contract = async () => ({ tokenMetadata: async () => ({ url }) });
  account._fetch = fetchImpl;   // inject the fake (dependency was constructor-provided)
  return { account, dispose: () => manager.dispose() };
}

test('getCis2Metadata downloads and parses the metadata at the on-chain URL', async () => {
  const requested = [];
  const { account, dispose } = await accountWithFakeMetadata('https://meta.example/token.json', async (url) => {
    requested.push(url);
    return { ok: true, json: async () => ({ name: 'Euro Stablecoin', symbol: 'EUROe', decimals: 6 }) };
  });
  assert.deepEqual(await account.getCis2Metadata('cis2:12754:0:01'), {
    url: 'https://meta.example/token.json',
    metadata: { name: 'Euro Stablecoin', symbol: 'EUROe', decimals: 6 },
  });
  assert.deepEqual(requested, ['https://meta.example/token.json']);
  dispose();
});

test('getCis2Metadata returns metadata: null when the URL cannot be read', async () => {
  const { account, dispose } = await accountWithFakeMetadata('https://meta.example/down.json',
    async () => { throw new Error('gateway timeout'); });
  assert.deepEqual(await account.getCis2Metadata('cis2:12754:0:01'),
    { url: 'https://meta.example/down.json', metadata: null });
  dispose();
});
