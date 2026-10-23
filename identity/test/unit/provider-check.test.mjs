/**
 * The provider check (scripts/lib/provider-check.mjs, used by `npm run check:providers`):
 * how each kind of provider answer is reported. Provider answers are scripted after
 * those seen from the live testnet and mainnet providers; no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { checkProvider, CHECK_REDIRECT_URI } from '../../scripts/lib/provider-check.mjs';
import { ipInfoFixture, walletProxyFetch } from '../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ISSUANCE_START = 'https://id-service.testnet.concordium.com/api/v1/identity';

/**
 * A testnet identity (recorded wallet-proxy data) and a provider fetch that answers each hop from `hops`.
 * Unless `buildRequest` is set, the identity hands out a ready-made link instead of building a
 * request (slow, and covered by the identity-request tests).
 */
function setup(hops, { buildRequest = false, ...overrides } = {}) {
  const { fetch: fakeWalletProxy } = walletProxyFetch('testnet', overrides);
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: fakeWalletProxy });
  if (!buildRequest) {
    identity.createIdentityRequest = async () => ({ issuanceUrl: `${ISSUANCE_START}?state=%7B%7D` });
  }
  const visited = [];
  const fakeProviderFetch = async (url, options) => {
    assert.equal(options.redirect, 'manual', 'redirects are followed one at a time');
    const hop = hops[visited.length];
    visited.push(new URL(url).host);
    if (hop instanceof Error) throw hop;
    return {
      status: hop.status,
      ok: hop.status >= 200 && hop.status < 300,
      headers: new Headers(hop.location ? { location: hop.location } : {}),
      text: async () => hop.body ?? '',
    };
  };
  return { identity, visited, check: (index = 0) => checkProvider(identity, index, { fetch: fakeProviderFetch }) };
}

test('a provider that serves its verification page after redirects is accepted', async () => {
  const { check, visited } = setup([
    { status: 302, location: 'https://id-verifier.testnet.concordium.com/api/verify/v1/abc' },
    { status: 200, body: '<!doctype html><form>' },
  ]);
  assert.deepEqual(await check(), { outcome: 'accepted', detail: 'id-verifier.testnet.concordium.com' });
  assert.deepEqual(visited, ['id-service.testnet.concordium.com', 'id-verifier.testnet.concordium.com']);
});

test("a provider that sends the browser straight back with an error is reported with the provider's words", async () => {
  const { check, visited } = setup([{ status: 302, location: `${CHECK_REDIRECT_URI}#error=Invalid%20proofs` }]);
  assert.deepEqual(await check(),
    { outcome: 'provider-error', detail: 'The identity provider reported an error: Invalid proofs' });
  assert.equal(visited.length, 1, 'the return address is never opened');
});

test('a JSON error reply keeps its code', async () => {
  const error = encodeURIComponent(JSON.stringify({ error: { code: 'INVALID_REQUEST', detail: 'not authorized to perform: kms:Decrypt' } }));
  const { check } = setup([{ status: 302, location: `${CHECK_REDIRECT_URI}#error=${error}` }]);
  assert.match((await check()).detail, /\(INVALID_REQUEST\): not authorized to perform: kms:Decrypt/);
});

test('an HTTP error from the provider is reported with the start of its body', async () => {
  const { check } = setup([{ status: 400, body: '{"code":400,"message":"Malformed request"}' }]);
  assert.deepEqual(await check(), { outcome: 'http-error', detail: 'HTTP 400 {"code":400,"message":"Malformed request"}' });
});

test('a provider that cannot be reached is reported as unreachable', async () => {
  const { check } = setup([Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })]);
  assert.deepEqual(await check(), { outcome: 'unreachable', detail: 'id-service.testnet.concordium.com: ENOTFOUND' });
});

test('endless redirects are reported', async () => {
  const { check } = setup(Array.from({ length: 10 }, (_, i) => ({ status: 302, location: `https://loop.example/${i}` })));
  assert.deepEqual(await check(), { outcome: 'http-error', detail: 'more than 5 redirects' });
});

test('a provider without an issuance address is not contacted', async () => {
  const ipInfo = ipInfoFixture('testnet');
  ipInfo.find((entry) => entry.ipInfo.ipIdentity === 0).metadata.issuanceStart = '';
  const { check, visited } = setup([], { buildRequest: true, ipInfo });
  assert.equal((await check()).outcome, 'no-issuance-address');
  assert.equal(visited.length, 0);
});

test('the check builds a real request and sends it to the published issuance address', async () => {
  const { identity } = setup([], { buildRequest: true });
  let opened;
  const result = await checkProvider(identity, 0, {
    fetch: async (url) => { opened = new URL(url); return { status: 200, ok: true, headers: new Headers() }; },
  });
  assert.equal(result.outcome, 'accepted');
  assert.equal(opened.origin + opened.pathname, ISSUANCE_START);
  assert.equal(opened.searchParams.get('redirect_uri'), CHECK_REDIRECT_URI);
  assert.ok(JSON.parse(opened.searchParams.get('state')).idObjectRequest.value.proofsOfKnowledge);
});
