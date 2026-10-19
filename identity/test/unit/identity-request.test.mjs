/**
 * ConcordiumIdentity.createIdentityRequest: real identity requests built from
 * recorded wallet-proxy data (test/fixtures) for real testnet and mainnet
 * providers; no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConcordiumIdentity,
  IdentityProviderError,
  CONCORDIUM_MAINNET_IDENTITY_CONFIG,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { ipInfoFixture, walletProxyFetch } from '../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CONFIG = { testnet: CONCORDIUM_TESTNET_IDENTITY_CONFIG, mainnet: CONCORDIUM_MAINNET_IDENTITY_CONFIG };
const REDIRECT = 'https://wallet.example/identity/return';

/** The providers used in testing (testnet 5 is published but deliberately not used). */
const PROVIDERS = [['testnet', 0], ['testnet', 3], ['mainnet', 1], ['mainnet', 2]];

/** An identity that sees one network's recorded wallet-proxy data; `requests` records every URL asked for. */
function offlineIdentity(network, overrides) {
  const { fetch, requests } = walletProxyFetch(network, overrides);
  return { identity: new ConcordiumIdentity(TEST_PHRASE, CONFIG[network], { fetch }), requests };
}

const published = (network, index) => ipInfoFixture(network).find((e) => e.ipInfo.ipIdentity === index).metadata;
const requestOf = (issuanceUrl) => JSON.parse(new URL(issuanceUrl).searchParams.get('state')).idObjectRequest;

for (const [network, index] of PROVIDERS) {
  test(`${network} provider ${index}: the link opens its published issuance address with the request`, async () => {
    const { identity, requests } = offlineIdentity(network);
    const result = await identity.createIdentityRequest({ providerIndex: index, redirectUri: REDIRECT });

    const url = new URL(result.issuanceUrl);
    assert.equal(url.origin + url.pathname, published(network, index).issuanceStart);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'identity');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
    const request = requestOf(result.issuanceUrl);
    assert.equal(typeof request.v, 'number');
    for (const field of ['idCredPub', 'choiceArData', 'ipArData', 'proofsOfKnowledge']) {
      assert.ok(request.value[field], `the request carries ${field}`);
    }
    assert.deepEqual({ providerIndex: result.providerIndex, identityIndex: result.identityIndex },
      { providerIndex: index, identityIndex: 0 });
    assert.deepEqual(requests, [
      `${CONFIG[network].walletProxyUrl}/v1/ip_info`,
      `${CONFIG[network].walletProxyUrl}/v0/global`,
    ]);
  });
}

test('each identity index gives a different identity, and the same index the same one', async () => {
  const { identity } = offlineIdentity('testnet');
  const pub = async (identityIndex) =>
    requestOf((await identity.createIdentityRequest({ providerIndex: 0, identityIndex, redirectUri: REDIRECT })).issuanceUrl)
      .value.idCredPub;
  const first = await pub(0);
  assert.equal(await pub(0), first, 'deterministic for the same seed, provider and index');
  assert.notEqual(await pub(1), first, 'a different identity index is a different identity');
});

test('the return address is passed on exactly as given, including an app scheme', async () => {
  for (const redirectUri of ['https://wallet.example', 'concordium-wallet://identity/return?flow=1']) {
    const { identity } = offlineIdentity('testnet');
    const { issuanceUrl } = await identity.createIdentityRequest({ providerIndex: 0, redirectUri });
    assert.equal(new URL(issuanceUrl).searchParams.get('redirect_uri'), redirectUri);
  }
});

test('invalid inputs are rejected before any request', async () => {
  const cases = [
    [{ redirectUri: REDIRECT }, /providerIndex is required/],
    [{ providerIndex: -1, redirectUri: REDIRECT }, /providerIndex is required/],
    [{ providerIndex: 0, identityIndex: 1.5, redirectUri: REDIRECT }, /identityIndex is required/],
    [{ providerIndex: 0 }, /redirectUri is required/],
    [{ providerIndex: 0, redirectUri: '/identity/return' }, /redirectUri is required/],
    [{ providerIndex: 0, redirectUri: ' https://wallet.example' }, /redirectUri is required/],
  ];
  for (const [options, expected] of cases) {
    const { identity, requests } = offlineIdentity('testnet');
    await assert.rejects(() => identity.createIdentityRequest(options), expected);
    assert.deepEqual(requests, [], `no request for ${JSON.stringify(options)}`);
  }
  const { identity } = offlineIdentity('testnet');
  await assert.rejects(() => identity.createIdentityRequest(), /providerIndex is required/);
});

test('a provider that is not published fails clearly, before the parameters are fetched', async () => {
  const { identity, requests } = offlineIdentity('mainnet');
  await assert.rejects(
    () => identity.createIdentityRequest({ providerIndex: 0, redirectUri: REDIRECT }),
    (e) => e instanceof IdentityProviderError && e.providerIndex === 0,
  );
  assert.deepEqual(requests, [`${CONFIG.mainnet.walletProxyUrl}/v1/ip_info`]);
});

test('a provider without an issuance address fails clearly, before any cryptographic work', async () => {
  const ipInfo = ipInfoFixture('testnet');
  delete ipInfo.find((e) => e.ipInfo.ipIdentity === 0).metadata.issuanceStart;
  const { identity, requests } = offlineIdentity('testnet', { ipInfo });
  await assert.rejects(
    () => identity.createIdentityRequest({ providerIndex: 0, redirectUri: REDIRECT }),
    (e) => e instanceof IdentityProviderError && e.providerIndex === 0 && /no issuance address/.test(e.message),
  );
  assert.deepEqual(requests, [`${CONFIG.testnet.walletProxyUrl}/v1/ip_info`], 'the parameters were never fetched');
});

test('cryptographic parameters in an unexpected format are reported', async () => {
  const { identity } = offlineIdentity('testnet', { global: { v: 0, value: {} } });
  await assert.rejects(() => identity.createIdentityRequest({ providerIndex: 0, redirectUri: REDIRECT }),
    /cryptographic parameters in an unexpected format/);
});
