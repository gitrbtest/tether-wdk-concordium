/**
 * ConcordiumIdentity.waitForIdentity / retrieveIdentity: collecting an issued
 * identity by polling the provider's code_uri. Polling replies are scripted;
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
const ISSUED_FOR = { providerIndex: 0, identityIndex: 334563111 };
const FAST = { intervalMs: 5 };

const issuedReply = () => JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
const PENDING_REPLY = { status: 'pending', token: null, detail: '' };

/**
 * An identity whose (fake) fetch answers the wallet-proxy from recorded data,
 * and each poll of the code_uri with the next of `replies` (the last one repeats).
 * A reply can be a response body, an Error (network failure) or { httpStatus } (HTTP failure).
 */
function identityWithProviderReplies(replies) {
  const { fetch: fakeWalletProxy } = walletProxyFetch('testnet');
  const pollRequests = [];
  const fakeFetch = async (url, options) => {
    if (url !== CODE_URI) return fakeWalletProxy(url, options);
    const reply = replies[Math.min(pollRequests.length, replies.length - 1)];
    pollRequests.push(url);
    if (reply instanceof Error) throw reply;
    if (reply.httpStatus) return { ok: false, status: reply.httpStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => reply };
  };
  return { identity: new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: fakeFetch }), pollRequests };
}

test('polls until the identity is issued, keeps it inside, and returns only a summary', async () => {
  const { identity, pollRequests } = identityWithProviderReplies([PENDING_REPLY, PENDING_REPLY, issuedReply()]);
  const summary = await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST });

  assert.deepEqual(summary, { ...ISSUED_FOR, createdAt: '202609', validTo: '202709', maxAccounts: 200 });
  assert.equal(pollRequests.length, 3);
  const held = identity._held._bytes.get(`${ISSUED_FOR.providerIndex}/${ISSUED_FOR.identityIndex}`);
  assert.ok(held instanceof Uint8Array, 'held as bytes');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(held)), issuedReply().token.identityObject);
  assert.doesNotMatch(JSON.stringify(summary), /John|Doe|19700101/, 'the summary carries no personal data');
});

test('an identity object without the version wrapper is accepted too', async () => {
  const done = issuedReply();
  done.token.identityObject = done.token.identityObject.value;
  const { identity } = identityWithProviderReplies([done]);
  assert.equal((await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST })).maxAccounts, 200);
});

test('an identity issued for a different seed, provider or identity index is refused and not kept', async () => {
  const { identity } = identityWithProviderReplies([issuedReply()]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { providerIndex: 0, identityIndex: 7, ...FAST }),
    /does not belong to this wallet for provider 0, identity 7/);
  assert.equal(identity._held.size, 0);
});

test('a rejection by the provider becomes IdentityIssuanceError (rejected) with its detail', async () => {
  const { identity } = identityWithProviderReplies([PENDING_REPLY, { status: 'error', token: null, detail: 'Identity verification failed' }]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST }), (e) =>
    e instanceof IdentityIssuanceError && e.reason === 'rejected' && e.detail === 'Identity verification failed'
    && /did not issue the identity: Identity verification failed/.test(e.message));
});

test('waiting stops with a timeout error, which says the same code_uri can be waited on again', async () => {
  const { identity } = identityWithProviderReplies([PENDING_REPLY]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, timeoutMs: 40, intervalMs: 10 }), (e) =>
    e instanceof IdentityIssuanceError && e.reason === 'timeout' && /Wait again with the same code_uri/.test(e.message));
});

test('waiting can be cancelled, before or during polling', async () => {
  const before = identityWithProviderReplies([PENDING_REPLY]);
  const aborted = AbortSignal.abort();
  await assert.rejects(() => before.identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, signal: aborted }),
    (e) => e instanceof IdentityIssuanceError && e.reason === 'cancelled');
  assert.equal(before.pollRequests.length, 0, 'no polling once already cancelled');

  const during = identityWithProviderReplies([PENDING_REPLY]);
  const controller = new AbortController();
  const waiting = during.identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, intervalMs: 50, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => waiting, (e) => e instanceof IdentityIssuanceError && e.reason === 'cancelled');
});

test('brief network or HTTP failures while polling are tolerated', async () => {
  const { identity, pollRequests } = identityWithProviderReplies([new Error('ECONNRESET'), { httpStatus: 503 }, issuedReply()]);
  assert.equal((await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST })).maxAccounts, 200);
  assert.equal(pollRequests.length, 3);
});

test('repeated failures while polling are reported', async () => {
  const { identity } = identityWithProviderReplies([new Error('ECONNRESET'), { httpStatus: 503 }, new Error('ETIMEDOUT')]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST }), /ETIMEDOUT/);
});

test('an unexpected status from the provider is reported', async () => {
  const { identity } = identityWithProviderReplies([{ status: 'processing' }]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST }), /unexpected status: "processing"/);
});

test('invalid inputs are rejected before any request', async () => {
  const cases = [
    ['/api/v1/identity/abc', ISSUED_FOR, /codeUri must be an absolute HTTP\(S\) URL/],
    [CODE_URI, { identityIndex: 0 }, /No identity request was started on this object: pass providerIndex/],
    [CODE_URI, { providerIndex: -1 }, /providerIndex is required/],
    [CODE_URI, { ...ISSUED_FOR, timeoutMs: 0 }, /timeoutMs must be a positive number/],
    [CODE_URI, { ...ISSUED_FOR, intervalMs: -1 }, /intervalMs must be a positive number/],
  ];
  for (const [codeUri, options, expected] of cases) {
    const { identity, pollRequests } = identityWithProviderReplies([issuedReply()]);
    await assert.rejects(() => identity.waitForIdentity(codeUri, options), expected);
    assert.equal(pollRequests.length, 0);
  }
});

test('retrieveIdentity reads the callback and collects the identity', async () => {
  const { identity } = identityWithProviderReplies([PENDING_REPLY, issuedReply()]);
  const callback = `http://localhost:4000/callback#code_uri=${encodeURIComponent(CODE_URI)}`;
  assert.equal((await identity.retrieveIdentity(callback, { ...ISSUED_FOR, ...FAST })).validTo, '202709');
});

test("retrieveIdentity reports a provider's error reply without polling", async () => {
  const { identity, pollRequests } = identityWithProviderReplies([issuedReply()]);
  const error = encodeURIComponent(JSON.stringify({ error: { code: 'INVALID_REQUEST', detail: 'refused' } }));
  await assert.rejects(() => identity.retrieveIdentity(`http://localhost:4000/callback#error=${error}`, ISSUED_FOR),
    (e) => e instanceof IdentityIssuanceError && e.reason === 'provider-error' && e.code === 'INVALID_REQUEST');
  assert.equal(pollRequests.length, 0);
});

test('dispose zeroes the identities held inside, and a disposed identity cannot wait', async () => {
  const { identity } = identityWithProviderReplies([issuedReply()]);
  await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST });
  const held = identity._held._bytes.get(`${ISSUED_FOR.providerIndex}/${ISSUED_FOR.identityIndex}`);
  identity.dispose();
  assert.ok(held.every((byte) => byte === 0));
  assert.equal(identity._held.size, 0);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, ISSUED_FOR), /This identity has been disposed/);
});

test('after createIdentityRequest, the callback address is all retrieveIdentity needs', async () => {
  const { identity } = identityWithProviderReplies([PENDING_REPLY, issuedReply()]);
  await identity.createIdentityRequest({ ...ISSUED_FOR, redirectUri: 'http://localhost:4000/callback' });
  const callback = `http://localhost:4000/callback#code_uri=${encodeURIComponent(CODE_URI)}`;
  const summary = await identity.retrieveIdentity(callback, FAST);
  assert.deepEqual({ providerIndex: summary.providerIndex, identityIndex: summary.identityIndex }, ISSUED_FOR);
  assert.equal(identity._issuance.requestAwaitingIdentity, null, 'the request no longer awaits its identity');
});

test('without a request started on the object, the numbers must be given', async () => {
  const { identity, pollRequests } = identityWithProviderReplies([issuedReply()]);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, FAST), /No identity request was started on this object/);
  assert.equal(pollRequests.length, 0);
});

test('after a rejection, the request no longer awaits its identity', async () => {
  // the testnet provider's reply when verification fails
  const { identity } = identityWithProviderReplies([PENDING_REPLY, { status: 'error', token: null, detail: 'Identity object has failed' }]);
  await identity.createIdentityRequest({ ...ISSUED_FOR, redirectUri: 'http://localhost:4000/callback' });
  const callback = `http://localhost:4000/callback#code_uri=${encodeURIComponent(CODE_URI)}`;
  await assert.rejects(() => identity.retrieveIdentity(callback, FAST),
    (e) => e instanceof IdentityIssuanceError && e.reason === 'rejected' && e.detail === 'Identity object has failed');
  assert.equal(identity._issuance.requestAwaitingIdentity, null);
  await assert.rejects(() => identity.retrieveIdentity(callback, FAST), /No identity request was started on this object/);
});

test("after the provider's error reply, the request no longer awaits its identity", async () => {
  const { identity, pollRequests } = identityWithProviderReplies([issuedReply()]);
  await identity.createIdentityRequest({ ...ISSUED_FOR, redirectUri: 'http://localhost:4000/callback' });
  // as the testnet provider replies to a request whose proofs do not verify
  await assert.rejects(() => identity.retrieveIdentity('http://localhost:4000/callback#error=Invalid%20proofs', FAST),
    (e) => e instanceof IdentityIssuanceError && e.reason === 'provider-error' && e.detail === 'Invalid proofs');
  assert.equal(identity._issuance.requestAwaitingIdentity, null);
  assert.equal(pollRequests.length, 0);
});

test("an error reply for other numbers leaves the request awaiting its identity", async () => {
  const { identity } = identityWithProviderReplies([issuedReply()]);
  await identity.createIdentityRequest({ providerIndex: 0, identityIndex: 7, redirectUri: 'http://localhost:4000/callback' });
  await assert.rejects(() => identity.retrieveIdentity('http://localhost:4000/callback#error=Invalid%20proofs',
    { providerIndex: 0, identityIndex: 8 }), /Invalid proofs/);
  assert.deepEqual(identity._issuance.requestAwaitingIdentity, { providerIndex: 0, identityIndex: 7 });
});

test('numbers given explicitly take precedence over the request awaiting its identity', async () => {
  const { identity } = identityWithProviderReplies([issuedReply()]);
  await identity.createIdentityRequest({ providerIndex: 0, identityIndex: 7, redirectUri: 'http://localhost:4000/callback' });
  // the recorded identity is for identity index 334563111, not the awaiting 7
  assert.equal((await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, ...FAST })).identityIndex, ISSUED_FOR.identityIndex);
  await assert.rejects(() => identity.waitForIdentity(CODE_URI, FAST), /does not belong to this wallet for provider 0, identity 7/);
});
