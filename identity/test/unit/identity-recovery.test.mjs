// Recovery, piece 1: the recovery request, the provider's recovery address, and its answers (scope part D).
// No network: the provider's answers are scripted; the identity is the one issued on testnet (test fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { recoveryRequest, recoveryLink, askProviderForIdentity } from '../../src/recovery/identity-recovery.js';
import { IdentityRecoveryError } from '../../index.js';
import { ipInfoFixture, globalFixture, testnetConfig, recordedNode } from '../helpers.mjs';

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

const { ConcordiumIdentity, IdentityProviderError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } = await import('../../index.js');
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

test('recoverIdentity: the identity comes back from the provider, held and ready to export', async () => {
  const network = networkWithRecovery({ status: 200, body: issued() });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch: network.fetch });
  const summary = await wallet.recoverIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  assert.deepEqual(summary, {
    providerIndex: 0, identityIndex: RECORDED_IDENTITY,
    createdAt: issued().value.attributeList.createdAt, validTo: '202709', maxAccounts: 200,
  });
  assert.equal(network.recoveryCalls.length, 1, 'one request to the provider\'s recovery address');
  assert.equal(requestSent(network.recoveryCalls[0]).value.idCredPub, issued().value.preIdentityObject.idCredPub,
    'asked for this seed\'s identity');
  // Held, exactly as after retrieveIdentity: it can be exported, and a new wallet object imports it back.
  const kept = await wallet.exportIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY });
  wallet.dispose();
  const restarted = new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch: network.fetch });
  assert.deepEqual(await restarted.importIdentity(kept), summary);
  restarted.dispose();
});

test('recoverIdentity: none issued for this identity number: null, nothing held', async () => {
  const network = networkWithRecovery({ status: 404, body: { message: 'Identity not found' } });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch: network.fetch });
  assert.equal(await wallet.recoverIdentity({ providerIndex: 0, identityIndex: 5 }), null);
  await assert.rejects(wallet.exportIdentity({ providerIndex: 0, identityIndex: 5 }), /No identity is held/);
  wallet.dispose();
});

test('recoverIdentity: an identity that is not this seed\'s is refused (not-yours) and never held', async () => {
  // The provider answers identity 1's request with the identity issued for 334563111: another key.
  const network = networkWithRecovery({ status: 200, body: issued() });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch: network.fetch });
  await rejectsWith(wallet.recoverIdentity({ providerIndex: 0, identityIndex: 1 }), 'not-yours');
  await assert.rejects(wallet.exportIdentity({ providerIndex: 0, identityIndex: 1 }), /No identity is held/);
  wallet.dispose();
});

test('recoverIdentity: providerIndex and identityIndex are required (no default number)', async () => {
  const network = networkWithRecovery({ status: 404, body: {} });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch: network.fetch });
  await assert.rejects(wallet.recoverIdentity({}), /providerIndex is required/);
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 0, identityIndex: -1 }), /identityIndex/);
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 0 }), /identityIndex is required: .*recoverAll/);
  assert.equal(network.recoveryCalls.length, 0, 'bad input is refused before anything is sent');
  assert.equal(await wallet.recoverIdentity({ providerIndex: 0, identityIndex: 0 }), null);
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
  const recorded = walletProxyFetch('testnet');
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ identityProviders: ipInfo }), { fetch: recorded.fetch });
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 0, identityIndex: 0 }),
    (e) => e instanceof IdentityProviderError && /no recovery address/.test(e.message) && e.providerIndex === 0);
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 99, identityIndex: 0 }), (e) => e instanceof IdentityProviderError);
  wallet.dispose();
});

test('recoverIdentity: cancelled before it starts; refused once disposed', async () => {
  const network = networkWithRecovery({ status: 200, body: issued() });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch: network.fetch });
  const cancelled = new AbortController();
  cancelled.abort();
  await rejectsWith(wallet.recoverIdentity({ providerIndex: 0, identityIndex: RECORDED_IDENTITY, signal: cancelled.signal }), 'cancelled');
  assert.equal(network.recoveryCalls.length, 0);
  wallet.dispose();
  await assert.rejects(wallet.recoverIdentity({ providerIndex: 0, identityIndex: 0 }), /disposed/);
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
 * The network with a pretend node answering the account checks: `existing` lists the account numbers that exist;
 * `failures` makes the first few checks fail (the node unreachable). `checked` notes each address asked about, in
 * order. The provider's recovery address answers `recovery`, in order.
 */
function networkWithAccounts(existing, { failures = 0, recovery = [] } = {}) {
  const recorded = walletProxyFetch('testnet');
  const provider = scriptedProvider(...recovery);
  const existingAddresses = new Set(existing.map((n) => addressOf(n)));
  const checked = [];
  const fetch = async (url, options) => (String(url).startsWith(`${RECOVERY_START}?`) ? provider.fetch(url, options) : recorded.fetch(url, options));
  const node = recordedNode('testnet', {
    accountExists: (address) => {
      if (failures > 0) { failures--; return Object.assign(new Error('the node is unreachable'), { name: 'RpcError', code: 'UNAVAILABLE' }); }
      checked.push(address);
      return existingAddresses.has(address);
    },
  });
  return { fetch, checked, node };
}

const newWallet = (network) => new ConcordiumIdentity(PHRASE, testnetConfig({ node: network.node }), { fetch: network.fetch });

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
  await assert.rejects(other.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY, gap: 0 }), /gap must be/);
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

test('findAccounts: a brief node failure is tried again; three in a row: reason node', async () => {
  const blip = networkWithAccounts([0], { failures: 2 });
  const wallet = newWallet(blip);
  assert.deepEqual((await wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY })).map((a) => a.credNumber), [0]);
  wallet.dispose();

  const down = networkWithAccounts([0], { failures: 3 });
  const other = newWallet(down);
  await assert.rejects(other.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY }), (e) => {
    assert.ok(e instanceof IdentityRecoveryError);
    assert.equal(e.reason, 'node');
    assert.match(e.detail, /the node is unreachable/);
    return true;
  });
  other.dispose();
});

test('findAccounts: inputs checked; cancelled; refused once disposed', async () => {
  const network = networkWithAccounts([0]);
  const wallet = newWallet(network);
  await assert.rejects(wallet.findAccounts({}), /providerIndex is required/);
  await assert.rejects(wallet.findAccounts({ providerIndex: 0 }), /identityIndex is required/); // no default number
  const cancelled = new AbortController();
  cancelled.abort();
  await rejectsWith(wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY, signal: cancelled.signal }), 'cancelled');
  assert.equal(network.checked.length, 0, 'nothing asked');
  wallet.dispose();
  await assert.rejects(wallet.findAccounts({ providerIndex: 0, identityIndex: RECORDED_IDENTITY }), /disposed/);
});

// ---- Piece 4: recoverAll --------------------------------------------------------------------------------------

const HD = sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
const providerEntry = (index) => ipInfoFixture('testnet').find((entry) => entry.ipInfo.ipIdentity === index);
const PROVIDERS = [0, 3, 5]; // every testnet provider in the recorded list publishes a recovery address

/** The public key (idCredPub) of identity `identityIndex` with provider `providerIndex`, for this seed. */
const keyOf = (providerIndex, identityIndex) => recoveryRequest({
  provider: providerEntry(providerIndex), globalContext: globalFixture('testnet').value, hdWallet: HD, identityIndex,
}).value.idCredPub;

/** An identity "issued" for this provider and identity number: the recorded one, carrying that identity's key. */
function identityFor(providerIndex, identityIndex) {
  const identity = issued();
  identity.value.preIdentityObject.idCredPub = keyOf(providerIndex, identityIndex);
  return identity;
}

/**
 * A scripted network for recoverAll. `world` says, per provider, which identity numbers exist and, for each,
 * which account numbers exist: e.g. { 0: { 0: [0], 1: [0, 1] } }. `down` lists providers whose recovery address
 * always answers HTTP 500; `accountsDown` makes every account check fail. `asked` notes, per provider, the
 * identity numbers it was asked for, in order.
 */
function recoveryWorld(world, { down = [], accountsDown = false } = {}) {
  const recorded = walletProxyFetch('testnet');
  const keys = {}; // idCredPub → identity number, for identity numbers 0 to 9 with each provider
  for (const p of PROVIDERS) for (let i = 0; i < 10; i++) keys[keyOf(p, i)] = i;
  const addresses = new Set();
  for (const [p, identities] of Object.entries(world)) {
    for (const [i, accounts] of Object.entries(identities)) {
      for (const n of accounts) {
        addresses.add(accountAddressOf({
          provider: providerEntry(Number(p)), globalContext: globalFixture('testnet').value, hdWallet: HD,
          identityIndex: Number(i), credNumber: n,
        }));
      }
    }
  }
  const recoveryStarts = Object.fromEntries(PROVIDERS.map((p) => [providerEntry(p).metadata.recoveryStart, p]));
  const asked = Object.fromEntries(PROVIDERS.map((p) => [p, []]));
  const json = (status, body) => ({ ok: status === 200, status, json: async () => body });
  const fetch = async (url, options) => {
    const text = String(url);
    const start = Object.keys(recoveryStarts).find((s) => text.startsWith(`${s}?`));
    if (start) {
      const p = recoveryStarts[start];
      if (down.includes(p)) return json(500, { message: 'down' });
      const i = keys[JSON.parse(new URL(text).searchParams.get('state')).idRecoveryRequest.value.idCredPub];
      asked[p].push(i);
      return world[p]?.[i] ? json(200, identityFor(p, i)) : json(404, { message: 'not found' });
    }
    return recorded.fetch(url, options);
  };
  const node = recordedNode('testnet', {
    accountExists: (address) => (accountsDown
      ? Object.assign(new Error('the node is unreachable'), { name: 'RpcError', code: 'UNAVAILABLE' })
      : addresses.has(address)),
  });
  /** How many times the provider list (/v1/ip_info) was downloaded: never, it is passed in. */
  const listDownloads = () => recorded.requests.filter((u) => String(u).endsWith('/v1/ip_info')).length;
  return { fetch, asked, listDownloads, node };
}

const describe = (identities) => identities.map((x) => `${x.providerIndex}/${x.identityIndex}: ${x.accounts.map((a) => a.credNumber)}`);

test('recoverAll: every identity with every provider comes back, with its accounts, held and ready to export', async () => {
  const world = recoveryWorld({ 0: { 0: [0], 1: [0, 1] } });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  const { identities, problems } = await wallet.recoverAll();
  assert.deepEqual(problems, []);
  assert.deepEqual(identities.map((x) => [x.providerIndex, x.identityIndex, x.accounts.map((a) => a.path)]), [
    [0, 0, ['0/0/0']],
    [0, 1, ['0/1/0', '0/1/1']],
  ]);
  assert.equal(identities[0].summary.validTo, '202709');
  assert.deepEqual(world.asked, { 0: [0, 1, 2, 3, 4], 3: [0, 1, 2], 5: [0, 1, 2] },
    'each provider is asked 0, 1, 2 … until 3 numbers in a row have no identity');
  assert.equal(world.listDownloads(), 0, 'the provider list is passed in by the wallet, never downloaded');
  for (const { providerIndex, identityIndex } of identities) assert.equal(typeof await wallet.exportIdentity({ providerIndex, identityIndex }), 'string');
  wallet.dispose();
});

test('recoverAll: a hole shorter than the gap is skipped over; identityGap and accountGap can be changed', async () => {
  // Provider 0: identities 0, 2, 4 and 6, each one missing number apart: the count of missing numbers starts
  // again after each one found, so all four are found (without that, it would stop before 6).
  const world = recoveryWorld({ 0: { 0: [0], 2: [0], 4: [0], 6: [0] }, 5: { 0: [0, 2] } });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  assert.deepEqual(describe((await wallet.recoverAll()).identities), ['0/0: 0', '0/2: 0', '0/4: 0', '0/6: 0', '5/0: 0,2']);
  assert.deepEqual(describe((await wallet.recoverAll({ identityGap: 1, accountGap: 1 })).identities), ['0/0: 0', '5/0: 0'],
    'gaps of 1: stops at the first missing number');
  await assert.rejects(wallet.recoverAll({ identityGap: 0 }), /identityGap must be/);
  await assert.rejects(wallet.recoverAll({ accountGap: 0 }), /accountGap must be/);
  wallet.dispose();
});

test('recoverAll: a provider that is down is noted in problems; the others are still asked', async () => {
  const world = recoveryWorld({ 0: { 0: [0] }, 5: { 0: [] } }, { down: [3] });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  const { identities, problems } = await wallet.recoverAll();
  assert.deepEqual(identities.map((x) => `${x.providerIndex}/${x.identityIndex}`), ['0/0', '5/0']);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].providerIndex, 3);
  assert.equal(problems[0].identityIndex, 0);
  assert.ok(problems[0].error instanceof IdentityRecoveryError && problems[0].error.reason === 'provider-error');
  wallet.dispose();
});

test('recoverAll: accounts that cannot be looked up: the identity still comes back (accounts null), the problem is noted', async () => {
  const world = recoveryWorld({ 0: { 0: [0] } }, { accountsDown: true });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  const { identities, problems } = await wallet.recoverAll({ providerIndexes: [0] });
  assert.deepEqual(identities.map((x) => [x.identityIndex, x.accounts]), [[0, null]]);
  assert.equal(problems[0].error.reason, 'node');
  assert.equal(typeof await wallet.exportIdentity({ providerIndex: 0, identityIndex: 0 }), 'string'); // held all the same
  wallet.dispose();
});

test('recoverAll: only the providers asked for; an unknown provider is a problem, not a failure', async () => {
  const world = recoveryWorld({ 0: { 0: [0] }, 5: { 0: [0] } });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  const only0 = await wallet.recoverAll({ providerIndexes: [0, 99] });
  assert.deepEqual(only0.identities.map((x) => `${x.providerIndex}/${x.identityIndex}`), ['0/0']);
  assert.deepEqual(world.asked[5], [], 'provider 5 was not asked');
  assert.equal(only0.problems.length, 1);
  assert.ok(only0.problems[0].error instanceof IdentityProviderError);
  assert.equal(only0.problems[0].identityIndex, null, 'the provider itself could not be used');
  await assert.rejects(wallet.recoverAll({ providerIndexes: 0 }), /must be a list/);
  wallet.dispose();
});

test('recoverAll: cancelled stops everything; refused once disposed', async () => {
  const world = recoveryWorld({ 0: { 0: [0] } });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  const cancelled = new AbortController();
  cancelled.abort();
  await rejectsWith(wallet.recoverAll({ signal: cancelled.signal }), 'cancelled');
  assert.deepEqual(world.asked, { 0: [], 3: [], 5: [] });
  wallet.dispose();
  await assert.rejects(wallet.recoverAll(), /disposed/);
});

// ---- No default numbers: the next free identity and account numbers --------------------------------------------

test('nextIdentityIndex: one after the highest identity this seed has with the provider; 0 if none; nothing kept', async () => {
  const world = recoveryWorld({ 0: { 0: [0], 1: [], 3: [0] } }); // identities 0, 1 and 3 (2 is a hole)
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  assert.equal(await wallet.nextIdentityIndex({ providerIndex: 0 }), 4, 'past the hole at 2, so 3 is not reused');
  assert.deepEqual(world.asked[0], [0, 1, 2, 3, 4, 5, 6], 'asked until 3 numbers in a row had none');
  assert.equal(await wallet.nextIdentityIndex({ providerIndex: 3 }), 0, 'none with provider 3');
  assert.equal(await wallet.nextIdentityIndex({ providerIndex: 0, gap: 1 }), 2, 'gap 1: stops at the hole');
  await assert.rejects(wallet.createAccount({ providerIndex: 0, identityIndex: 0, credNumber: 0 }), /No identity is held/,
    'asking does not hold the identities');
  await assert.rejects(wallet.nextIdentityIndex({}), /providerIndex is required/);
  await assert.rejects(wallet.nextIdentityIndex({ providerIndex: 0, gap: 0 }), /gap must be/);
  wallet.dispose();
  await assert.rejects(wallet.nextIdentityIndex({ providerIndex: 0 }), /disposed/);
});

test('nextCredNumber: one after the highest account the identity has on chain; 0 if none', async () => {
  const world = recoveryWorld({ 0: { 1: [0, 1], 2: [] } });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node: world.node }), { fetch: world.fetch });
  assert.equal(await wallet.nextCredNumber({ providerIndex: 0, identityIndex: 1 }), 2);
  assert.equal(await wallet.nextCredNumber({ providerIndex: 0, identityIndex: 2 }), 0);
  await assert.rejects(wallet.nextCredNumber({ providerIndex: 0 }), /identityIndex is required/);
  wallet.dispose();
  await assert.rejects(wallet.nextCredNumber({ providerIndex: 0, identityIndex: 1 }), /disposed/);
});
