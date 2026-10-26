/**
 * ConcordiumIdentity.saveIdentity / loadIdentity / deleteIdentity: saving the identity held inside the
 * object, encrypted, in a store, and getting it back after a restart. Uses the recorded testnet identity,
 * collected through the real waitForIdentity path with scripted replies; no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ConcordiumIdentity,
  IdentityStorageError,
  MemoryIdentityStore,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { walletProxyFetch } from '../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const ISSUED_FOR = { providerIndex: 0, identityIndex: 334563111 };
const SLOT = 'concordium-identity/testnet/0/334563111';
const issuedReply = () => JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
const SUMMARY = { ...ISSUED_FOR, createdAt: '202609', validTo: '202709', maxAccounts: 200 };

/** A new ConcordiumIdentity (offline: recorded wallet-proxy data, scripted provider replies). */
function newIdentity({ store, phrase = TEST_PHRASE } = {}) {
  const { fetch: fakeWalletProxy } = walletProxyFetch('testnet');
  const fakeFetch = async (url, options) =>
    (url === CODE_URI ? { ok: true, status: 200, json: async () => issuedReply() } : fakeWalletProxy(url, options));
  return new ConcordiumIdentity(phrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: fakeFetch, store });
}

/** An identity that has collected (and checked) the recorded identity. */
async function collected(store) {
  const identity = newIdentity({ store });
  await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, intervalMs: 5 });
  return identity;
}

/** A store that records everything it is given (a "spy"), and otherwise behaves like MemoryIdentityStore. */
function spyStore() {
  const inner = new MemoryIdentityStore();
  const saves = [];
  return {
    saves,
    save: async (slotName, bytes) => { saves.push({ slotName, bytes: Uint8Array.from(bytes) }); await inner.save(slotName, bytes); },
    read: (slotName) => inner.read(slotName),
    delete: (slotName) => inner.delete(slotName),
  };
}

const reason = (expected) => (e) => e instanceof IdentityStorageError && e.reason === expected && e.slotName === SLOT;

test('the store receives only encrypted bytes and the slot name: no identity content (spy store)', async () => {
  const store = spyStore();
  const identity = await collected(store);
  const result = await identity.saveIdentity(ISSUED_FOR);

  assert.deepEqual(result, { ...SUMMARY, slotName: SLOT });
  assert.equal(store.saves.length, 1, 'one save, nothing else');
  assert.equal(store.saves[0].slotName, SLOT);
  const asText = new TextDecoder('latin1').decode(store.saves[0].bytes);
  assert.ok(asText.startsWith('CWID'));
  const { value } = issuedReply().token.identityObject;
  // Personal values of 4+ characters (names, dates, document numbers). Shorter ones, such as a
  // one-digit document type, appear in any 14 KB of random-looking bytes by chance.
  const personal = Object.values(value.attributeList.chosenAttributes).filter((v) => String(v).length >= 4);
  assert.ok(personal.length >= 5, 'enough personal values to look for');
  for (const visible of ['preIdentityObject', 'attributeList', 'chosenAttributes', value.preIdentityObject.idCredPub, ...personal]) {
    assert.ok(!asText.includes(visible), `"${String(visible).slice(0, 24)}" must not reach the store`);
  }
});

test('saved in one object, loaded in a new one with the same seed and store (an app restart)', async () => {
  const store = new MemoryIdentityStore();
  const first = await collected(store);
  await first.saveIdentity(ISSUED_FOR);
  first.dispose();

  const restarted = newIdentity({ store });
  assert.deepEqual(await restarted.loadIdentity(ISSUED_FOR), SUMMARY);
  assert.ok(restarted._identities.has('0/334563111'), 'held inside again, ready for account creation');
  assert.deepEqual(await restarted.saveIdentity(ISSUED_FOR), { ...SUMMARY, slotName: SLOT }, 'and can be saved again');
});

test('loading is offline: no network call', async () => {
  const store = new MemoryIdentityStore();
  await (await collected(store)).saveIdentity(ISSUED_FOR);
  const calls = [];
  const offline = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG,
    { store, fetch: async (url) => { calls.push(url); throw new Error('no network'); } });
  assert.deepEqual(await offline.loadIdentity(ISSUED_FOR), SUMMARY);
  assert.deepEqual(calls, []);
});

test('nothing saved: load gives null; delete removes the saved copy but keeps the one held in memory', async () => {
  const store = new MemoryIdentityStore();
  const identity = await collected(store);
  assert.equal(await identity.loadIdentity({ providerIndex: 0, identityIndex: 1 }), null);
  await identity.saveIdentity(ISSUED_FOR);
  await identity.deleteIdentity(ISSUED_FOR);
  assert.equal(await store.read(SLOT), null);
  assert.equal(await identity.loadIdentity(ISSUED_FOR), null);
  assert.ok(identity._identities.has('0/334563111'), 'still held: dispose() clears what is held');
  await identity.deleteIdentity(ISSUED_FOR); // nothing saved: not an error
});

test('saving the same identity again is allowed; the bytes change (a new nonce each time)', async () => {
  const store = new MemoryIdentityStore();
  const identity = await collected(store);
  await identity.saveIdentity(ISSUED_FOR);
  const before = await store.read(SLOT);
  await identity.saveIdentity(ISSUED_FOR);
  assert.notDeepEqual(await store.read(SLOT), before);
});

test('a different identity already saved is not replaced unless replace: true, and is left untouched', async () => {
  const store = new MemoryIdentityStore();
  const older = newIdentity({ store });
  const olderObject = issuedReply().token.identityObject;
  olderObject.value.attributeList.validTo = '202609'; // e.g. an earlier identity for the same slot
  older._holdIdentity(0, 334563111, olderObject);
  await older.saveIdentity(ISSUED_FOR);
  const olderBytes = await store.read(SLOT);

  const identity = await collected(store);
  await assert.rejects(() => identity.saveIdentity(ISSUED_FOR),
    (e) => reason('slot-in-use')(e) && /A different identity is already saved .* Pass \{ replace: true \}/.test(e.message));
  assert.deepEqual(await store.read(SLOT), olderBytes, 'the saved identity is unchanged');

  await identity.saveIdentity({ ...ISSUED_FOR, replace: true });
  assert.equal((await newIdentity({ store }).loadIdentity(ISSUED_FOR)).validTo, '202709', 'replaced');
});

test('bytes that cannot be decrypted (another seed, damaged) are not overwritten unless replace: true', async () => {
  const store = new MemoryIdentityStore();
  const otherSeed = newIdentity({ store, phrase: OTHER_PHRASE });
  otherSeed._holdIdentity(0, 334563111, issuedReply().token.identityObject);
  await otherSeed.saveIdentity(ISSUED_FOR);
  const theirs = await store.read(SLOT);

  const identity = await collected(store);
  await assert.rejects(() => identity.saveIdentity(ISSUED_FOR),
    (e) => reason('unreadable-slot')(e) && /cannot be decrypted with this wallet's seed.* Pass \{ replace: true \} to overwrite it/.test(e.message));
  assert.deepEqual(await store.read(SLOT), theirs);
  await assert.rejects(() => identity.loadIdentity(ISSUED_FOR), reason('unreadable-slot'));

  await identity.saveIdentity({ ...ISSUED_FOR, replace: true });
  assert.deepEqual(await identity.loadIdentity(ISSUED_FOR), SUMMARY);
});

test('clear errors: no store, nothing held, bad numbers, a store without the three methods', async () => {
  const noStore = await collected(undefined);
  for (const call of [() => noStore.saveIdentity(ISSUED_FOR), () => noStore.loadIdentity(ISSUED_FOR), () => noStore.deleteIdentity(ISSUED_FOR)]) {
    await assert.rejects(call, /No identity store is configured: pass \{ store \}/);
  }
  const nothingHeld = newIdentity({ store: new MemoryIdentityStore() });
  await assert.rejects(() => nothingHeld.saveIdentity(ISSUED_FOR), /No identity is held for provider 0, identity 334563111/);
  await assert.rejects(() => nothingHeld.loadIdentity({ providerIndex: -1, identityIndex: 0 }), /providerIndex is required/);
  await assert.rejects(() => nothingHeld.saveIdentity({ providerIndex: 0 }), /identityIndex is required/);
  assert.throws(() => newIdentity({ store: { save() {} } }), /needs async save, read and delete methods; read is missing/);
});

test('a disposed identity refuses to save, load or delete; dispose zeroes a loaded identity', async () => {
  const store = new MemoryIdentityStore();
  await (await collected(store)).saveIdentity(ISSUED_FOR);
  const identity = newIdentity({ store });
  await identity.loadIdentity(ISSUED_FOR);
  const held = identity._identities.get('0/334563111');
  identity.dispose();
  assert.ok(held.every((byte) => byte === 0), 'the loaded identity is zeroed');
  for (const call of [() => identity.saveIdentity(ISSUED_FOR), () => identity.loadIdentity(ISSUED_FOR), () => identity.deleteIdentity(ISSUED_FOR)]) {
    await assert.rejects(call, /This identity has been disposed/);
  }
});

test('the encryption key is wiped after every save and load', async () => {
  const store = new MemoryIdentityStore();
  const identity = await collected(store);
  const keys = [];
  const original = identity._storageKey.bind(identity);
  identity._storageKey = () => { const key = original(); keys.push(key); return key; };
  await identity.saveIdentity(ISSUED_FOR);
  await identity.loadIdentity(ISSUED_FOR);
  assert.equal(keys.length, 2);
  for (const key of keys) assert.ok(key.every((byte) => byte === 0));
});
