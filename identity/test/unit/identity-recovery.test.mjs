// Recovery, piece 1: the recovery request, the provider's recovery address, and its answers (scope part D).
// No network: the provider's answers are scripted; the identity is the one issued on testnet (test fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { recoveryRequest, recoveryLink, askProviderForIdentity } from '../../src/recovery/identity-recovery.js';
import { IdentityRecoveryError } from '../../index.js';
import { ipInfoFixture, globalFixture } from '../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED_IDENTITY = 334563111; // the identity issued on testnet for this phrase (provider 0)
const issued = () => JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8')).token.identityObject;
const provider0 = () => ipInfoFixture('testnet').find((entry) => entry.ipInfo.ipIdentity === 0);
const RECOVERY_START = 'https://id-service.testnet.concordium.com/api/v1/recover';

/** A scripted provider: each call takes the next answer (a status and body, or 'network-failure'). */
function scriptedProvider(...answers) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(url);
    if (options?.signal?.aborted) throw new Error('aborted');
    const answer = answers.shift();
    if (answer === 'network-failure') throw new TypeError('fetch failed');
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  return { fetch, calls };
}

const rejectsWith = (promise, reason) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof IdentityRecoveryError, `an IdentityRecoveryError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  return true;
});

test('the recovery request is for the identity issued to these keys (its idCredPub matches)', () => {
  const hdWallet = sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
  const request = recoveryRequest({
    provider: provider0(), globalContext: globalFixture('testnet').value, hdWallet, identityIndex: RECORDED_IDENTITY,
    now: Date.UTC(2026, 10, 1, 12, 0, 0),
  });
  assert.equal(request.value.idCredPub, issued().value.preIdentityObject.idCredPub);
  assert.equal(request.value.timestamp, Date.UTC(2026, 10, 1, 12, 0, 0) / 1000, 'the time it was made, in seconds');
  assert.equal(typeof request.value.proof, 'string');
  const other = recoveryRequest({ provider: provider0(), globalContext: globalFixture('testnet').value, hdWallet, identityIndex: 1 });
  assert.notEqual(other.value.idCredPub, request.value.idCredPub, 'another identity index gives another key');
});

test('the request goes to the provider\'s recovery address as its state', () => {
  const request = { v: 0, value: { idCredPub: 'ab', timestamp: 1, proof: 'cd' } };
  const url = new URL(recoveryLink(RECOVERY_START, request));
  assert.equal(`${url.origin}${url.pathname}`, RECOVERY_START);
  assert.deepEqual(JSON.parse(url.searchParams.get('state')), { idRecoveryRequest: request });
});

test('HTTP 200: the identity the provider returned', async () => {
  const provider = scriptedProvider({ status: 200, body: issued() });
  const identity = await askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover?state=x' });
  assert.deepEqual(identity, issued());
  assert.equal(provider.calls.length, 1);
});

test('HTTP 404: no identity for these keys, which is not an error (null)', async () => {
  const provider = scriptedProvider({ status: 404, body: { code: 404, message: 'Identity not found' } });
  assert.equal(await askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover' }), null);
});

test('another error from the provider: provider-error, with its status and message', async () => {
  const provider = scriptedProvider({ status: 400, body: { message: 'The timestamp is too old' } });
  await assert.rejects(askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover' }), (e) => {
    assert.equal(e.reason, 'provider-error');
    assert.equal(e.status, 400);
    assert.equal(e.detail, 'The timestamp is too old');
    assert.match(e.message, /HTTP 400: The timestamp is too old/);
    return true;
  });
  assert.equal(provider.calls.length, 1, 'a 4xx is not tried again');
});

test('an answer that is not an identity: provider-error', async () => {
  const provider = scriptedProvider({ status: 200, body: { status: 'pending' } });
  await rejectsWith(askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover' }), 'provider-error');
});

test('a brief network failure or server error is tried again', async () => {
  const provider = scriptedProvider('network-failure', { status: 503, body: {} }, { status: 200, body: issued() });
  assert.deepEqual(await askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover' }), issued());
  assert.equal(provider.calls.length, 3);
});

test('three network failures in a row: network', async () => {
  const provider = scriptedProvider('network-failure', 'network-failure', 'network-failure');
  await rejectsWith(askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover' }), 'network');
  assert.equal(provider.calls.length, 3);
});

test('three server errors in a row: provider-error with the last status', async () => {
  const provider = scriptedProvider({ status: 500, body: {} }, { status: 502, body: {} }, { status: 503, body: { message: 'down' } });
  await assert.rejects(askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover' }),
    (e) => e.reason === 'provider-error' && e.status === 503 && e.detail === 'down');
});

test('cancelled before or between tries: cancelled', async () => {
  const before = new AbortController();
  before.abort();
  await rejectsWith(askProviderForIdentity({ fetch: scriptedProvider().fetch, url: 'https://ip/recover', signal: before.signal }), 'cancelled');

  const during = new AbortController();
  const provider = scriptedProvider('network-failure', { status: 200, body: issued() });
  const asking = askProviderForIdentity({ fetch: provider.fetch, url: 'https://ip/recover', signal: during.signal });
  setTimeout(() => during.abort(), 50); // during the pause before the second try
  await rejectsWith(asking, 'cancelled');
  assert.equal(provider.calls.length, 1, 'no second try after cancelling');
});
