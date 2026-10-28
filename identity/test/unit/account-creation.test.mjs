/**
 * ConcordiumIdentity.createAccount: the checks made before anything is sent, "already exists", several
 * accounts, revealed attributes, and the whole path to a final account. Uses the recorded testnet identity
 * and a scripted wallet-proxy; nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ConcordiumIdentity,
  AccountCreationError,
  MemoryIdentityStore,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { hasExpired } from '../../src/issuance/identity-object.js';
import { walletProxyFetch } from '../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const ISSUED_FOR = { providerIndex: 0, identityIndex: 334563111 };
/** Account 0 of the recorded identity (it also exists on testnet, created before this work). */
const ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t';
const issuedReply = () => JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const FINAL = { status: 'finalized', outcome: 'success', blockHashes: ['b1'] };

/**
 * A ConcordiumIdentity holding the recorded identity, with a scripted wallet-proxy:
 * `exists` answers the account lookup (false: `{}`; true: balances; or a response such as json(503)),
 * `submit` the sending, `status` every status check. `editIdentity` can change the identity before it is
 * collected (e.g. its validTo). Every request is recorded in `requests`.
 */
async function identityHolding({ exists = false, submit = json(200, { submissionId: 'x' }), status = FINAL, editIdentity = (o) => o, store } = {}) {
  const { fetch: recordedWalletProxy } = walletProxyFetch('testnet');
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) });
    if (url === CODE_URI) {
      const reply = issuedReply();
      reply.token.identityObject = editIdentity(reply.token.identityObject);
      return json(200, reply);
    }
    if (url.includes('/v0/accBalance/')) {
      if (typeof exists !== 'boolean') return exists;
      return json(200, exists ? { currentBalance: { accountAmount: '0' }, finalizedBalance: { accountAmount: '0' } } : {});
    }
    if (url.includes('/v0/submitCredential')) return submit;
    if (url.includes('/v0/submissionStatus/')) return json(200, status);
    return recordedWalletProxy(url, options);
  };
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch, store });
  await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, intervalMs: 1 });
  return { identity, requests, sent: () => requests.filter((r) => r.url.includes('/v0/submitCredential')) };
}
const create = (identity, options = {}) => identity.createAccount({ ...ISSUED_FOR, intervalMs: 1, ...options });
const rejectsWith = (promise, reason, check = () => true) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof AccountCreationError, e.message);
  assert.equal(e.reason, reason, e.message);
  return check(e) !== false;
});

test('an account is created from the held identity: sent, final, and its address returned', async () => {
  const { identity, sent } = await identityHolding();
  const account = await create(identity);
  assert.equal(account.address, ACCOUNT_0);
  assert.deepEqual({ ...account, transactionHash: undefined }, {
    ...ISSUED_FOR, credNumber: 0, path: '0/334563111/0', address: ACCOUNT_0, created: true, transactionHash: undefined, blockHash: 'b1',
  });
  assert.match(account.transactionHash, /^[0-9a-f]{64}$/);
  // the form the wallet package's getAccountByPath accepts (its own check, copied): "provider/identity/cred"
  assert.match(account.path, /^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/);
  const [{ body }] = sent();
  assert.equal(body.value.credential.type, 'normal');
  assert.deepEqual(body.value.credential.contents.policy.revealedAttributes, {}, 'nothing revealed by default');
});

test('an account that already exists is returned, and nothing is sent', async () => {
  const { identity, sent } = await identityHolding({ exists: true });
  assert.deepEqual(await create(identity), { ...ISSUED_FOR, credNumber: 0, path: '0/334563111/0', address: ACCOUNT_0, created: false });
  assert.equal(sent().length, 0);
});

test('several accounts under one identity: each account number has its own address', async () => {
  const { identity } = await identityHolding();
  const second = await create(identity, { credNumber: 1 });
  assert.equal(second.credNumber, 1);
  assert.equal(second.path, '0/334563111/1', "the path the wallet package's getAccountByPath takes");
  assert.notEqual(second.address, ACCOUNT_0);
});

test('an account number not below maxAccounts is refused before anything is sent', async () => {
  const { identity, requests } = await identityHolding();
  const before = requests.length;
  await rejectsWith(create(identity, { credNumber: 200 }), 'max-accounts', (e) => /200 accounts/.test(e.message));
  assert.equal(requests.length, before, 'no request at all');
});

test('chosen attributes are revealed; an attribute the identity does not hold is refused before sending', async () => {
  const { identity, sent } = await identityHolding();
  await create(identity, { revealAttributes: ['countryOfResidence', 'countryOfResidence'] });
  const revealed = sent()[0].body.value.credential.contents.policy.revealedAttributes;
  assert.deepEqual(Object.keys(revealed), ['countryOfResidence']);

  const other = await identityHolding();
  await rejectsWith(create(other.identity, { revealAttributes: ['favouriteColour'] }), 'unknown-attribute',
    (e) => e.detail === 'favouriteColour');
  assert.equal(other.sent().length, 0);
});

test('an expired identity is refused before anything is sent', async () => {
  const expired = (identityObject) => {
    identityObject.value.attributeList.validTo = '202509';
    return identityObject;
  };
  const { identity, requests } = await identityHolding({ editIdentity: expired });
  const before = requests.length;
  await rejectsWith(create(identity), 'identity-expired', (e) => /2025-09/.test(e.message));
  assert.equal(requests.length, before);
});

test('an identity is valid until the end of its validTo month', () => {
  const identity = { attributeList: { validTo: '202610' } };
  assert.equal(hasExpired(identity, new Date(Date.UTC(2026, 9, 31, 23, 59))), false); // 31 Oct 2026
  assert.equal(hasExpired(identity, new Date(Date.UTC(2026, 10, 1))), true);         // 1 Nov 2026
  assert.equal(hasExpired(identity, new Date(Date.UTC(2025, 11, 31))), false);        // Dec 2025
});

test('a wallet-proxy that cannot say whether the account exists stops it before sending', async () => {
  const { identity, sent } = await identityHolding({ exists: json(503) });
  await rejectsWith(create(identity), 'wallet-proxy', (e) => e.address === ACCOUNT_0);
  assert.equal(sent().length, 0);
});

test('a refusal while sending is reported with the account and the reason', async () => {
  const { identity } = await identityHolding({ submit: json(400, { error: 1, errorMessage: 'Credential rejected by the node' }) });
  await rejectsWith(create(identity), 'rejected', (e) => e.address === ACCOUNT_0);
});

test('after a restart: load the saved identity in a new object, then create the account', async () => {
  const store = new MemoryIdentityStore();
  const first = await identityHolding({ store });
  await first.identity.saveIdentity(ISSUED_FOR);
  first.identity.dispose();

  const { fetch: recordedWalletProxy } = walletProxyFetch('testnet');
  const restarted = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, {
    store,
    fetch: async (url, options = {}) => {
      if (url.includes('/v0/accBalance/')) return json(200, {});
      if (url.includes('/v0/submitCredential')) return json(200, { submissionId: 'x' });
      if (url.includes('/v0/submissionStatus/')) return json(200, FINAL);
      return recordedWalletProxy(url, options);
    },
  });
  await restarted.loadIdentity(ISSUED_FOR);
  assert.equal((await create(restarted)).address, ACCOUNT_0);
});

test('clear errors: no identity held, bad inputs, a disposed identity', async () => {
  const empty = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: async () => { throw new Error('no network'); } });
  await assert.rejects(create(empty), /No identity is held for provider 0, identity 334563111/);
  await assert.rejects(create(empty, { credNumber: -1 }), /credNumber/);
  await assert.rejects(create(empty, { revealAttributes: 'dob' }), /revealAttributes/);
  empty.dispose();
  await assert.rejects(create(empty), /disposed/);
});
