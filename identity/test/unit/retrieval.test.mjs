/**
 * ConcordiumIdentity.waitForIdentity / retrieveIdentity: collecting an issued
 * identity by polling the provider's code_uri. Polling answers are scripted;
 * the issued identity is a real one recorded from the testnet identity provider
 * (test/fixtures/identity-done.testnet.json); no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ConcordiumIdentity,
  IdentityIssuanceError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { walletProxyFetch } from '../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
/** The provider and identity index the recorded identity was issued for. */
const ISSUED = { providerIndex: 0, identityIndex: 334563111 };
const FAST = { intervalMs: 5 };

const DONE = () => JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
const PENDING = { status: 'pending', token: null, detail: '' };

/**
 * An identity whose fetch answers the wallet-proxy from recorded data and the
 * code_uri from `answers`, in order (the last one repeats). An answer can be a
 * reply body, an Error (network failure) or { httpStatus } (HTTP failure).
 */
function polling(answers) {
  const { fetch: walletProxy } = walletProxyFetch('testnet');
  const polls = [];
  const fetch = async (url, options) => {
    if (url !== CODE_URI) return walletProxy(url, options);
    const answer = answers[Math.min(polls.length, answers.length - 1)];
    polls.push(url);
    if (answer instanceof Error) throw answer;
    if (answer.httpStatus) return { ok: false, status: answer.httpStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  };
  return { identity: new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch }), polls };
}

test('polls until the identity is issued, keeps it inside, and returns only a summary', async () => {
  const { identity, polls } = polling([PENDING, PENDING, DONE()]);
  const summary = await identity.waitForIdentity(CODE_URI, { ...ISSUED, ...FAST });

  assert.deepEqual(summary, { ...ISSUED, createdAt: '202609', validTo: '202709', maxAccounts: 200 });
  assert.equal(polls.length, 3);
  const held = identity._identities.get(`${ISSUED.providerIndex}/${ISSUED.identityIndex}`);
  assert.ok(held instanceof Uint8Array, 'held as bytes');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(held)), DONE().token.identityObject);
  assert.doesNotMatch(JSON.stringify(summary), /John|Doe|19700101/, 'the summary carries no personal data');
});

test('an identity object without the version wrapper is accepted too', async () => {
  const done = DONE();
  done.token.identityObject = done.token.identityObject.value;
  const { identity } = polling([done]);
  assert.equal((await identity.waitForIdentity(CODE_URI, { ...ISSUED, ...FAST })).maxAccounts, 200);
});

test('an identity issued for a different seed, provider or identity index is refused and not kept', async () => {
  const { identity } = polling([DONE()]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { providerIndex: 0, identityIndex: 7, ...FAST }),
    /does not belong to this wallet for provider 0, identity 7/);
  assert.equal(identity._identities.size, 0);
});

test('a rejection by the provider becomes IdentityIssuanceError (rejected) with its detail', async () => {
  const { identity } = polling([PENDING, { status: 'error', token: null, detail: 'Identity verification failed' }]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED, ...FAST }), (e) =>
    e instanceof IdentityIssuanceError && e.reason === 'rejected' && e.detail === 'Identity verification failed'
    && /did not issue the identity: Identity verification failed/.test(e.message));
});

test('waiting stops with a timeout error, which says the same code_uri can be waited on again', async () => {
  const { identity } = polling([PENDING]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED, timeoutMs: 40, intervalMs: 10 }), (e) =>
    e instanceof IdentityIssuanceError && e.reason === 'timeout' && /Wait again with the same code_uri/.test(e.message));
});

test('waiting can be cancelled, before or during polling', async () => {
  const before = polling([PENDING]);
  const aborted = AbortSignal.abort();
  await assert.rejects(() => before.identity.waitForIdentity(CODE_URI, { ...ISSUED, signal: aborted }),
    (e) => e instanceof IdentityIssuanceError && e.reason === 'cancelled');
  assert.equal(before.polls.length, 0, 'no polling once already cancelled');

  const during = polling([PENDING]);
  const controller = new AbortController();
  const waiting = during.identity.waitForIdentity(CODE_URI, { ...ISSUED, intervalMs: 50, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => waiting, (e) => e instanceof IdentityIssuanceError && e.reason === 'cancelled');
});

test('brief network or HTTP failures while polling are tolerated', async () => {
  const { identity, polls } = polling([new Error('ECONNRESET'), { httpStatus: 503 }, DONE()]);
  assert.equal((await identity.waitForIdentity(CODE_URI, { ...ISSUED, ...FAST })).maxAccounts, 200);
  assert.equal(polls.length, 3);
});

test('repeated failures while polling are reported', async () => {
  const { identity } = polling([new Error('ECONNRESET'), { httpStatus: 503 }, new Error('ETIMEDOUT')]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED, ...FAST }), /ETIMEDOUT/);
});

test('an unexpected status from the provider is reported', async () => {
  const { identity } = polling([{ status: 'processing' }]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED, ...FAST }), /unexpected status: "processing"/);
});

test('invalid inputs are rejected before any request', async () => {
  const cases = [
    ['/api/v1/identity/abc', ISSUED, /codeUri must be an absolute HTTP\(S\) URL/],
    [CODE_URI, { identityIndex: 0 }, /providerIndex is required/],
    [CODE_URI, { ...ISSUED, timeoutMs: 0 }, /timeoutMs must be a positive number/],
    [CODE_URI, { ...ISSUED, intervalMs: -1 }, /intervalMs must be a positive number/],
  ];
  for (const [codeUri, options, expected] of cases) {
    const { identity, polls } = polling([DONE()]);
    await assert.rejects(() => identity.waitForIdentity(codeUri, options), expected);
    assert.equal(polls.length, 0);
  }
});

test('retrieveIdentity reads the callback and collects the identity', async () => {
  const { identity } = polling([PENDING, DONE()]);
  const callback = `http://localhost:4000/callback#code_uri=${encodeURIComponent(CODE_URI)}`;
  assert.equal((await identity.retrieveIdentity(callback, { ...ISSUED, ...FAST })).validTo, '202709');
});

test("retrieveIdentity reports a provider's error reply without polling", async () => {
  const { identity, polls } = polling([DONE()]);
  const error = encodeURIComponent(JSON.stringify({ error: { code: 'INVALID_REQUEST', detail: 'refused' } }));
  await assert.rejects(() => identity.retrieveIdentity(`http://localhost:4000/callback#error=${error}`, ISSUED),
    (e) => e instanceof IdentityIssuanceError && e.reason === 'provider-error' && e.code === 'INVALID_REQUEST');
  assert.equal(polls.length, 0);
});

test('dispose zeroes the identities held inside, and a disposed identity cannot wait', async () => {
  const { identity } = polling([DONE()]);
  await identity.waitForIdentity(CODE_URI, { ...ISSUED, ...FAST });
  const held = identity._identities.get(`${ISSUED.providerIndex}/${ISSUED.identityIndex}`);
  identity.dispose();
  assert.ok(held.every((byte) => byte === 0));
  assert.equal(identity._identities.size, 0);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, ISSUED), /This identity has been disposed/);
});
