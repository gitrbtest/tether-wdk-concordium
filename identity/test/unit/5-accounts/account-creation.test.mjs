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
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { hasExpired } from '../../../src/issuance/identity-object.js';
import { testnetConfig, recordedNode } from '../../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const ISSUED_FOR = { providerIndex: 0, identityIndex: 334563111 };
/** Account 0 of the recorded identity (it also exists on testnet, created before this work). */
const ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t';
const issuedReply = () => JSON.parse(readFileSync(new URL('../../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/**
 * A ConcordiumIdentity holding the recorded identity, with a pretend node (see recordedNode in helpers.mjs):
 * `exists` answers the account lookup (true, false, or an Error: the node unreachable), `send` the sending,
 * `statuses` the status checks. `editIdentity` can change the identity before it is collected (e.g. its validTo).
 * `node` records what was asked of it; `sent()` lists the credentials sent.
 */
async function identityHolding({ exists = false, send, statuses, editIdentity = (o) => o } = {}) {
  const fetch = async (url) => {
    if (url !== CODE_URI) throw new Error(`no network in this test: ${url}`);
    const reply = issuedReply();
    reply.token.identityObject = editIdentity(reply.token.identityObject);
    return json(200, reply);
  };
  const node = recordedNode('testnet', { accountExists: () => exists, send, statuses });
  const identity = new ConcordiumIdentity(TEST_PHRASE, testnetConfig({ node }), { fetch });
  await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, intervalMs: 1 });
  return { identity, node, sent: () => node.sent };
}

/** Whether the sent credential bytes reveal the country of residence "DK" (attribute 4, length 2, "D", "K"). */
const revealsCountryDK = (payload) => {
  const look = [4, 2, 0x44, 0x4b];
  for (let i = 0; i + look.length <= payload.length; i++) if (look.every((b, j) => payload[i + j] === b)) return true;
  return false;
};
// Account 0 unless a test names another: always passed explicitly, as the package has no default account number.
const create = (identity, options = {}) => identity.createAccount({ ...ISSUED_FOR, credNumber: 0, intervalMs: 1, ...options });
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
    ...ISSUED_FOR, credNumber: 0, path: '0/334563111/0', address: ACCOUNT_0, created: true, transactionHash: undefined, blockHash: 'b1'.repeat(32),
  });
  assert.match(account.transactionHash, /^[0-9a-f]{64}$/);
  // the form the wallet package's getAccountByPath accepts (its own check, copied): "provider/identity/cred"
  assert.match(account.path, /^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/);
  const [{ payload, expiry }] = sent();
  assert.ok(payload instanceof Uint8Array && payload.length > 1000, 'the signed credential, as bytes for the node');
  assert.ok(expiry?.expiryEpochSeconds > 0n, 'with its expiry');
  assert.equal(revealsCountryDK(payload), false, 'nothing revealed by default');
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
  const { identity, node } = await identityHolding();
  await rejectsWith(create(identity, { credNumber: 200 }), 'max-accounts', (e) => /200 accounts/.test(e.message));
  assert.deepEqual([node.accountsAsked.length, node.sent.length], [0, 0], 'nothing asked, nothing sent');
});

test('chosen attributes are revealed; an attribute the identity does not hold is refused before sending', async () => {
  const { identity, sent } = await identityHolding();
  await create(identity, { revealAttributes: ['countryOfResidence', 'countryOfResidence'] });
  assert.equal(revealsCountryDK(sent()[0].payload), true, 'the country of residence (DK) is shown on the account');

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
  const { identity, node } = await identityHolding({ editIdentity: expired });
  await rejectsWith(create(identity), 'identity-expired', (e) => /2025-09/.test(e.message));
  assert.deepEqual([node.accountsAsked.length, node.sent.length], [0, 0], 'nothing asked, nothing sent');
});

test('an identity is valid until the end of its validTo month', () => {
  const identity = { attributeList: { validTo: '202610' } };
  assert.equal(hasExpired(identity, new Date(Date.UTC(2026, 9, 31, 23, 59))), false); // 31 Oct 2026
  assert.equal(hasExpired(identity, new Date(Date.UTC(2026, 10, 1))), true);         // 1 Nov 2026
  assert.equal(hasExpired(identity, new Date(Date.UTC(2025, 11, 31))), false);        // Dec 2025
});

test('a node that cannot say whether the account exists stops it before sending', async () => {
  const unreachable = Object.assign(new Error('connection refused'), { name: 'RpcError', code: 'UNAVAILABLE' });
  const { identity, sent } = await identityHolding({ exists: unreachable });
  await rejectsWith(create(identity), 'node', (e) => e.address === ACCOUNT_0 && /connection refused/.test(e.detail));
  assert.equal(sent().length, 0);
});

test('a refusal while sending is reported with the account and the reason', async () => {
  const refused = Object.assign(new Error('Credential deployment rejected'), { name: 'RpcError', code: 'INVALID_ARGUMENT' });
  const { identity } = await identityHolding({ send: refused });
  await rejectsWith(create(identity), 'rejected', (e) => e.address === ACCOUNT_0);
});

test('after a restart: import the exported identity in a new object, then create the account', async () => {
  const first = await identityHolding();
  const kept = await first.identity.exportIdentity(ISSUED_FOR); // what the wallet keeps, its own way
  first.identity.dispose();

  const restarted = new ConcordiumIdentity(TEST_PHRASE, testnetConfig(), {
    fetch: async (url) => { throw new Error(`no network in this test: ${url}`); },
  });
  await restarted.importIdentity(kept);
  assert.equal((await create(restarted)).address, ACCOUNT_0);
});

test('clear errors: no identity held, bad inputs, a disposed identity', async () => {
  const empty = new ConcordiumIdentity(TEST_PHRASE, testnetConfig(), { fetch: async () => { throw new Error('no network'); } });
  await assert.rejects(create(empty), /No identity is held for provider 0, identity 334563111/);
  await assert.rejects(create(empty, { credNumber: -1 }), /credNumber/);
  // No default account number: leaving it out is an error that says how to find one.
  await assert.rejects(empty.createAccount({ ...ISSUED_FOR }), /credNumber is required: .*nextCredNumber/);
  await assert.rejects(empty.createAccount({ providerIndex: 0, credNumber: 0 }), /identityIndex is required/);
  await assert.rejects(create(empty, { revealAttributes: 'dob' }), /revealAttributes/);
  empty.dispose();
  await assert.rejects(create(empty), /disposed/);
});
