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

// ---- Piece 2: recoverIdentity on ConcordiumIdentity -----------------------------------------------------------

const { ConcordiumIdentity, MemoryIdentityStore, IdentityProviderError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } = await import('../../index.js');
const { walletProxyFetch } = await import('../helpers.mjs');

/**
 * A wallet's view of the network: the wallet-proxy from recorded data, and the provider's recovery address
 * answering from the script. `recoveryCalls` notes each recovery request the provider received.
 */
function networkWithRecovery(...answers) {
  const recorded = walletProxyFetch('testnet');
  const provider = scriptedProvider(...answers);
  const fetch = (url, options) => (String(url).startsWith(`${RECOVERY_START}?`) ? provider.fetch(url, options) : recorded.fetch(url, options));
  return { fetch, recoveryCalls: provider.calls };
}

/** The recovery request a call sent, read back out of the address it asked. */
const requestSent = (url) => JSON.parse(new URL(url).searchParams.get('state')).idRecoveryRequest;

test('recoverIdentity: the identity comes back from the provider, held and ready to save', async () => {
  const network = networkWithRecovery({ status: 200, body: issued() });
  const store = new MemoryIdentityStore();
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: network.fetch, store });
  const summary = await wallet.recoverIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  assert.deepEqual(summary, {
    providerIndex: 0, identityIndex: RECORDED_IDENTITY,
    createdAt: issued().value.attributeList.createdAt, validTo: '202709', maxAccounts: 200,
  });
  assert.equal(network.recoveryCalls.length, 1, 'one request to the provider\'s recovery address');
  assert.equal(requestSent(network.recoveryCalls[0]).value.idCredPub, issued().value.preIdentityObject.idCredPub,
    'asked for this seed\'s identity');
  // Held, exactly as after retrieveIdentity: it can be saved, and a new wallet object loads it back.
  await wallet.saveIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  wallet.dispose();
  const restarted = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: network.fetch, store });
  assert.deepEqual(await restarted.loadIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY }), summary);
  restarted.dispose();
});

test('recoverIdentity: none issued for this identity number: null, nothing held', async () => {
  const network = networkWithRecovery({ status: 404, body: { message: 'Identity not found' } });
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: network.fetch, store: new MemoryIdentityStore() });
  assert.equal(await wallet.recoverIdentity({ providerIndex: 0, identityIndex: 5 }), null);
  await assert.rejects(wallet.saveIdentity({ providerIndex: 0, identityIndex: 5 }), /No identity is held/);
  wallet.dispose();
});

test('recoverIdentity: an identity that is not this seed\'s is refused (not-yours) and never held', async () => {
  // The provider answers identity 1's request with the identity issued for 334563111: another key.
  const network = networkWithRecovery({ status: 200, body: issued() });
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: network.fetch, store: new MemoryIdentityStore() });
  await rejectsWith(wallet.recoverIdentity({ providerIndex: 0, identityIndex: 1 }), 'not-yours');
  await assert.rejects(wallet.saveIdentity({ providerIndex: 0, identityIndex: 1 }), /No identity is held/);
  wallet.dispose();
});

test('recoverIdentity: identityIndex defaults to 0; providerIndex is required', async () => {
  const network = networkWithRecovery({ status: 404, body: {} });
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: network.fetch });
  await assert.rejects(wallet.recoverIdentity({}), /providerIndex is required/);
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 0, identityIndex: -1 }), /identityIndex/);
  assert.equal(network.recoveryCalls.length, 0, 'bad input is refused before anything is sent');
  assert.equal(await wallet.recoverIdentity({ providerIndex: 0 }), null);
  const expected = recoveryRequest({
    provider: provider0(), globalContext: globalFixture('testnet').value,
    hdWallet: sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet'), identityIndex: 0,
  });
  assert.equal(requestSent(network.recoveryCalls[0]).value.idCredPub, expected.value.idCredPub, 'identity 0 was asked for');
  wallet.dispose();
});

test('recoverIdentity: a provider that publishes no recovery address is reported (IdentityProviderError)', async () => {
  const ipInfo = ipInfoFixture('testnet');
  delete ipInfo.find((entry) => entry.ipInfo.ipIdentity === 0).metadata.recoveryStart;
  const recorded = walletProxyFetch('testnet', { ipInfo });
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: recorded.fetch });
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 0 }),
    (e) => e instanceof IdentityProviderError && /no recovery address/.test(e.message) && e.providerIndex === 0);
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 99 }), (e) => e instanceof IdentityProviderError);
  wallet.dispose();
});

test('recoverIdentity: cancelled before it starts; refused once disposed', async () => {
  const network = networkWithRecovery({ status: 200, body: issued() });
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: network.fetch });
  const cancelled = new AbortController();
  cancelled.abort();
  await rejectsWith(wallet.recoverIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY, signal: cancelled.signal }), 'cancelled');
  assert.equal(network.recoveryCalls.length, 0);
  wallet.dispose();
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 0 }), /disposed/);
});

// ---- Piece 3: findAccounts ------------------------------------------------------------------------------------

const ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t'; // account 0 of the recorded identity, on testnet
const { accountAddressOf } = await import('../../src/account/credential.js');

/** The address of account n of the recorded identity, worked out from the seed. */
function addressOf(credNumber, identityIndex = RECORDED_IDENTITY) {
  return accountAddressOf({
    provider: provider0(), globalContext: globalFixture('testnet').value,
    hdWallet: sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet'), identityIndex, credNumber,
  });
}

/**
 * The network with a scripted wallet-proxy account check: `existing` lists the account numbers that exist;
 * `failures` makes the first few checks fail (HTTP 502). `checked` notes each address asked about, in order.
 */
function networkWithAccounts(existing, { failures = 0, recovery = [] } = {}) {
  const recorded = walletProxyFetch('testnet');
  const provider = scriptedProvider(...recovery);
  const existingAddresses = new Set(existing.map((n) => addressOf(n)));
  const checked = [];
  const fetch = async (url, options) => {
    const text = String(url);
    if (text.startsWith(`${RECOVERY_START}?`)) return provider.fetch(url, options);
    if (text.includes('/v0/accBalance/')) {
      if (failures > 0) { failures--; return { ok: false, status: 502, json: async () => ({}) }; }
      const address = text.split('/v0/accBalance/')[1];
      checked.push(address);
      const body = existingAddresses.has(address) ? { finalizedBalance: { accountAmount: '1000000' } } : {};
      return { ok: true, status: 200, json: async () => body };
    }
    return recorded.fetch(url, options);
  };
  return { fetch, checked };
}

const newWallet = (network) => new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: network.fetch });

test('findAccounts: accounts 0 and 1 exist: both found, with their paths; it stops after 3 missing in a row', async () => {
  const network = networkWithAccounts([0, 1]);
  const wallet = newWallet(network);
  const accounts = await wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  assert.deepEqual(accounts, [
    { credNumber: 0, address: ACCOUNT_0, path: `0/${RECORDED_IDENTITY}/0` },
    { credNumber: 1, address: addressOf(1), path: `0/${RECORDED_IDENTITY}/1` },
  ]);
  assert.equal(accounts[0].address, ACCOUNT_0, 'account 0 is the real testnet account of this identity');
  assert.deepEqual(network.checked, [0, 1, 2, 3, 4].map((n) => addressOf(n)), 'asked about 0 to 4, then stopped');
  wallet.dispose();
});

test('findAccounts: a hole shorter than the gap is skipped over (0 and 2 exist)', async () => {
  const network = networkWithAccounts([0, 2]);
  const wallet = newWallet(network);
  const accounts = await wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  assert.deepEqual(accounts.map((a) => a.credNumber), [0, 2]);
  assert.equal(network.checked.length, 6, '0 to 5: three missing in a row after account 2');
  wallet.dispose();
});

test('findAccounts: no accounts: an empty list after 3 checks; the gap can be changed', async () => {
  const network = networkWithAccounts([]);
  const wallet = newWallet(network);
  assert.deepEqual(await wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY }), []);
  assert.equal(network.checked.length, 3);
  const narrow = networkWithAccounts([0, 2]);
  const other = newWallet(narrow);
  assert.deepEqual((await other.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY, gap: 1 })).map((a) => a.credNumber), [0],
    'gap 1: stops at the first missing number');
  await assert.rejects(other.findAccounts({ providerIndex: 0, gap: 0 }), /gap must be/);
  wallet.dispose();
  other.dispose();
});

test('findAccounts: with the identity held, it never looks beyond the identity\'s maxAccounts', async () => {
  const allowsTwo = issued();
  allowsTwo.value.attributeList.maxAccounts = 2;
  const network = networkWithAccounts([0, 1, 2, 3], { recovery: [{ status: 200, body: allowsTwo }] });
  const wallet = newWallet(network);
  await wallet.recoverIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  const accounts = await wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  assert.deepEqual(accounts.map((a) => a.credNumber), [0, 1]);
  assert.equal(network.checked.length, 2, 'accounts 2 and 3 are never asked about');
  wallet.dispose();
});

test('findAccounts: a brief wallet-proxy failure is tried again; three in a row: wallet-proxy', async () => {
  const blip = networkWithAccounts([0], { failures: 2 });
  const wallet = newWallet(blip);
  assert.deepEqual((await wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY })).map((a) => a.credNumber), [0]);
  wallet.dispose();

  const down = networkWithAccounts([0], { failures: 3 });
  const other = newWallet(down);
  await assert.rejects(other.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY }), (e) => {
    assert.ok(e instanceof IdentityRecoveryError);
    assert.equal(e.reason, 'wallet-proxy');
    assert.match(e.detail, /HTTP 502/);
    return true;
  });
  other.dispose();
});

test('findAccounts: inputs checked; cancelled; refused once disposed', async () => {
  const network = networkWithAccounts([0]);
  const wallet = newWallet(network);
  await assert.rejects(wallet.findAccounts({}), /providerIndex is required/);
  const cancelled = new AbortController();
  cancelled.abort();
  await rejectsWith(wallet.findAccounts({ providerIndex: 0, signal: cancelled.signal }), 'cancelled');
  assert.equal(network.checked.length, 0, 'nothing asked');
  wallet.dispose();
  await assert.rejects(wallet.findAccounts({ providerIndex: 0 }), /disposed/);
});
