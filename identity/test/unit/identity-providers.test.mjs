/** Identity providers from recorded wallet-proxy data (test/fixtures); no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IdentityProviders,
  IdentityProviderError,
  CONCORDIUM_MAINNET_IDENTITY_CONFIG,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { ipInfoFixture, ipInfoFetch } from '../helpers.mjs';

const CONFIG = { testnet: CONCORDIUM_TESTNET_IDENTITY_CONFIG, mainnet: CONCORDIUM_MAINNET_IDENTITY_CONFIG };

/** Providers that read one network's recorded list; `requests` records every URL asked for. */
function recorded(network, body) {
  const { fetch, requests } = ipInfoFetch(network, body);
  return { providers: new IdentityProviders(CONFIG[network], { fetch }), requests };
}

test('list reports every published provider with its published addresses', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const { providers, requests } = recorded(network);
    const expected = ipInfoFixture(network).map((e) => ({
      index: e.ipInfo.ipIdentity,
      name: e.ipInfo.ipDescription.name,
      issuanceStart: e.metadata.issuanceStart,
      recoveryStart: e.metadata.recoveryStart,
    }));
    assert.deepEqual(await providers.list(), expected);
    assert.deepEqual(requests, [`${CONFIG[network].walletProxyUrl}/v1/ip_info`]);
  }
});

test('get returns a provider by its index, with its keys and anonymity revokers', async () => {
  for (const network of ['testnet', 'mainnet']) {
    for (const entry of ipInfoFixture(network)) {
      const { providers } = recorded(network);
      const provider = await providers.get(entry.ipInfo.ipIdentity);
      assert.equal(provider.index, entry.ipInfo.ipIdentity);
      assert.equal(provider.issuanceStart, entry.metadata.issuanceStart, 'issuance address exactly as published');
      assert.equal(provider.recoveryStart, entry.metadata.recoveryStart, 'recovery address exactly as published');
      assert.deepEqual(provider.ipInfo, entry.ipInfo);
      assert.deepEqual(provider.arsInfos, entry.arsInfos);
    }
  }
});

test('a provider is found by its index, not by its position in the list', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const list = ipInfoFixture(network);
    for (const [position, entry] of list.entries()) {
      const { providers } = recorded(network);
      const provider = await providers.get(entry.ipInfo.ipIdentity);
      assert.equal(provider.name, entry.ipInfo.ipDescription.name,
        `${network}: index ${entry.ipInfo.ipIdentity} (listed at position ${position}) resolves to its own entry`);
    }
  }
});

test('an index that is not published on the network fails clearly, with no fallback', async () => {
  const published = new Set(ipInfoFixture('mainnet').map((e) => e.ipInfo.ipIdentity));
  const missing = [0, 1, 2, 3, 4, 5].find((index) => !published.has(index));
  const { providers } = recorded('mainnet');
  await assert.rejects(
    () => providers.get(missing),
    (e) => e instanceof IdentityProviderError && e.providerIndex === missing
      && e.message === `No identity provider ${missing} is published on this network.`,
  );
});

test('an invalid index is rejected before any request', async () => {
  for (const index of [-1, 1.5, '1', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const { providers, requests } = recorded('testnet');
    await assert.rejects(() => providers.get(index), /providerIndex is required and must be a non-negative safe integer/);
    assert.deepEqual(requests, [], `no request for ${String(index)}`);
  }
});

test('an address a provider does not publish is reported as null, never invented', async () => {
  const list = ipInfoFixture('testnet');
  const entry = list[0];
  delete entry.metadata.issuanceStart;
  delete entry.metadata.recoveryStart;
  const { providers } = recorded('testnet', list);
  const provider = await providers.get(entry.ipInfo.ipIdentity);
  assert.equal(provider.issuanceStart, null);
  assert.equal(provider.recoveryStart, null);
});

test('a wallet-proxy base path is kept when building the request URL', async () => {
  const { fetch, requests } = ipInfoFetch('testnet');
  const providers = new IdentityProviders({ walletProxyUrl: 'https://proxy.example/concordium/' }, { fetch });
  await providers.list();
  assert.deepEqual(requests, ['https://proxy.example/concordium/v1/ip_info']);
});

test('an HTTP error from the wallet-proxy reports the status', async () => {
  const providers = new IdentityProviders(CONCORDIUM_TESTNET_IDENTITY_CONFIG, {
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(() => providers.list(), /HTTP 503/);
});

test('an unexpected response format is reported', async () => {
  const providers = new IdentityProviders(CONCORDIUM_TESTNET_IDENTITY_CONFIG, {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ error: 'maintenance' }) }),
  });
  await assert.rejects(() => providers.list(), /unexpected format/);
});

test('a network failure passes through unchanged, so it is not mistaken for a provider problem', async () => {
  const offline = new Error('getaddrinfo ENOTFOUND wallet-proxy.testnet.concordium.com');
  const providers = new IdentityProviders(CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: async () => { throw offline; } });
  await assert.rejects(() => providers.get(0), (e) => e === offline);
});

test('an invalid configuration is rejected before any request', () => {
  const { fetch, requests } = ipInfoFetch('testnet');
  assert.throws(() => new IdentityProviders({ walletProxyUrl: 'not a url' }, { fetch }), /walletProxyUrl/);
  assert.deepEqual(requests, []);
});
