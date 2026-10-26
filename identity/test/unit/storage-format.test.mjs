/**
 * The encrypted storage format (src/storage/storage-format.js): the key from the seed, encrypting and
 * decrypting, binding to the slot, and reading identities saved in format version 1.
 * Uses the recorded testnet identity; no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConcordiumIdentity, IdentityStorageError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import {
  STORAGE_FORMAT_VERSION, storageSlotName, deriveStorageKey, encryptIdentity, decryptIdentity,
} from '../../src/storage/storage-format.js';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url);
const identityObject = JSON.parse(readFileSync(fixture('identity-done.testnet.json'), 'utf8')).token.identityObject;
const RECORD = { providerIndex: 0, identityIndex: 334563111, identityObject };
const SLOT = storageSlotName('Testnet', 0, 334563111);

function seedOf(phrase) {
  const identity = new ConcordiumIdentity(phrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  const seed = Uint8Array.from(identity._seed);
  identity.dispose();
  return seed;
}
const KEY = deriveStorageKey(seedOf(TEST_PHRASE), 'Testnet');
const isUnreadable = (pattern) => (e) =>
  e instanceof IdentityStorageError && e.reason === 'unreadable-slot' && e.slotName === SLOT && pattern.test(e.message);

test('slot names say network, provider and identity index', () => {
  assert.equal(SLOT, 'concordium-identity/testnet/0/334563111');
  assert.equal(storageSlotName('Mainnet', 2, 0), 'concordium-identity/mainnet/2/0');
});

test('the key is 32 bytes, the same for the same seed and network, different otherwise', () => {
  const seed = seedOf(TEST_PHRASE);
  assert.equal(KEY.length, 32);
  assert.deepEqual(deriveStorageKey(seed, 'Testnet'), KEY);
  assert.notDeepEqual(deriveStorageKey(seed, 'Mainnet'), KEY);
  assert.notDeepEqual(deriveStorageKey(seedOf(OTHER_PHRASE), 'Testnet'), KEY);
});

test('an identity encrypts and decrypts back to the same record', () => {
  const bytes = encryptIdentity(KEY, SLOT, RECORD);
  assert.deepEqual(decryptIdentity(KEY, SLOT, bytes), RECORD);
});

test('the saved bytes start with "CWID" and the format version, and hold no identity content', () => {
  const bytes = encryptIdentity(KEY, SLOT, RECORD);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'CWID');
  assert.equal(bytes[4], STORAGE_FORMAT_VERSION);
  const asText = new TextDecoder('latin1').decode(bytes);
  for (const visible of ['preIdentityObject', 'attributeList', 'idCredPub', identityObject.value.preIdentityObject.idCredPub]) {
    assert.ok(!asText.includes(visible), `${visible.slice(0, 20)} is not visible in the saved bytes`);
  }
});

test('every save uses a new nonce, so the same identity never gives the same bytes', () => {
  const first = encryptIdentity(KEY, SLOT, RECORD);
  const second = encryptIdentity(KEY, SLOT, RECORD);
  assert.notDeepEqual(first.subarray(5, 17), second.subarray(5, 17));
  assert.notDeepEqual(first, second);
});

test('another seed cannot decrypt it', () => {
  const otherKey = deriveStorageKey(seedOf(OTHER_PHRASE), 'Testnet');
  assert.throws(() => decryptIdentity(otherKey, SLOT, encryptIdentity(KEY, SLOT, RECORD)),
    isUnreadable(/cannot be decrypted with this wallet's seed/));
});

test('one changed byte anywhere is detected', () => {
  const bytes = encryptIdentity(KEY, SLOT, RECORD);
  for (const position of [5, 20, bytes.length - 1]) { // nonce, ciphertext, authentication tag
    const damaged = Uint8Array.from(bytes);
    damaged[position] ^= 0x01;
    assert.throws(() => decryptIdentity(KEY, SLOT, damaged), isUnreadable(/cannot be decrypted/));
  }
});

test('bytes are bound to their slot: copied to another identity or network, they cannot be decrypted', () => {
  const bytes = encryptIdentity(KEY, SLOT, RECORD);
  for (const otherSlot of [storageSlotName('Testnet', 0, 7), storageSlotName('Mainnet', 0, 334563111)]) {
    assert.throws(() => decryptIdentity(KEY, otherSlot, bytes),
      (e) => e instanceof IdentityStorageError && e.slotName === otherSlot && /cannot be decrypted/.test(e.message));
  }
});

test('data that is not a saved identity, or an unknown format version, is refused clearly', () => {
  assert.throws(() => decryptIdentity(KEY, SLOT, new TextEncoder().encode('{"hello":"world"} and some more text')),
    isUnreadable(/is not a saved identity/));
  assert.throws(() => decryptIdentity(KEY, SLOT, new Uint8Array(3)), isUnreadable(/is not a saved identity/));
  const future = encryptIdentity(KEY, SLOT, RECORD);
  future[4] = 2;
  assert.throws(() => decryptIdentity(KEY, SLOT, future), isUnreadable(/storage format version 2/));
});

/*
 * GOLDEN FILE: never regenerate test/fixtures/golden/identity-v1.bin (see the README there).
 * It was made once, with format version 1, from the public test phrase above and the recorded
 * identity (identity-done.testnet.json) for slot concordium-identity/testnet/0/334563111.
 * If this test fails, identities saved by earlier versions of the package can no longer be read:
 * - an accidental format change: fix the code, not this file;
 * - an intentional change: add format version 2 with its own golden file, and keep this one passing.
 */
test('reads identities saved in storage format version 1 (golden file)', () => {
  const golden = new Uint8Array(readFileSync(fixture('golden/identity-v1.bin')));
  assert.equal(golden[4], 1, 'the golden file is format version 1');
  assert.deepEqual(decryptIdentity(KEY, SLOT, golden), RECORD);
});
