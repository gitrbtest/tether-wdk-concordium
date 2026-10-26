/**
 * IdentityVault (internal): storage on its own, without ConcordiumIdentity. It gets the encryption key
 * through a function and never sees the seed. No external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IdentityStorageError, MemoryIdentityStore } from '@concordium/wdk-identity-concordium';
import IdentityVault from '../../src/IdentityVault.js';

const identityObject = JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8')).token.identityObject;
const SLOT = { providerIndex: 0, identityIndex: 5 };

/** A vault with a fixed test key; records every key it hands out so tests can check they were wiped. */
function vaultWith({ store = new MemoryIdentityStore(), derivationNetwork = 'Testnet', keyByte = 7 } = {}) {
  const keys = [];
  const storageKey = () => { const key = new Uint8Array(32).fill(keyByte); keys.push(key); return key; };
  return { vault: new IdentityVault({ store, derivationNetwork, storageKey }), store, keys };
}

test('slot names follow the network, provider and identity index', () => {
  assert.equal(vaultWith().vault.slotName(0, 5), 'concordium-identity/testnet/0/5');
  assert.equal(vaultWith({ derivationNetwork: 'Mainnet' }).vault.slotName(2, 0), 'concordium-identity/mainnet/2/0');
});

test('save returns the slot name; load gives the identity back; delete removes it', async () => {
  const { vault } = vaultWith();
  assert.equal(await vault.save({ ...SLOT, identityObject }), 'concordium-identity/testnet/0/5');
  assert.deepEqual(await vault.load(SLOT), identityObject);
  await vault.delete(SLOT);
  assert.equal(await vault.load(SLOT), null);
});

test('a key is asked for per operation that needs one, and every key is wiped afterwards', async () => {
  const { vault, keys } = vaultWith();
  await vault.save({ ...SLOT, identityObject }); // reads the slot (empty), then saves: one key
  await vault.save({ ...SLOT, identityObject }); // same identity again: one key
  await vault.load(SLOT);
  assert.equal(await vault.load({ providerIndex: 0, identityIndex: 6 }), null, 'nothing saved: no key needed');
  assert.equal(keys.length, 3);
  for (const key of keys) assert.ok(key.every((byte) => byte === 0));
});

test('the key is wiped even when the store fails', async () => {
  const failing = { save: async () => { throw new Error('disk full'); }, read: async () => null, delete: async () => {} };
  const { vault, keys } = vaultWith({ store: failing });
  await assert.rejects(() => vault.save({ ...SLOT, identityObject }), /disk full/);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].every((byte) => byte === 0));
});

test('refined C: a different identity or unreadable bytes are refused unless replace, and left untouched', async () => {
  const store = new MemoryIdentityStore();
  const { vault } = vaultWith({ store });
  const older = structuredClone(identityObject);
  older.value.attributeList.validTo = '202609';
  await vault.save({ ...SLOT, identityObject: older });
  const before = await store.read('concordium-identity/testnet/0/5');

  await assert.rejects(() => vault.save({ ...SLOT, identityObject }), (e) => e instanceof IdentityStorageError && e.reason === 'slot-in-use');
  assert.deepEqual(await store.read('concordium-identity/testnet/0/5'), before);
  await vault.save({ ...SLOT, identityObject, replace: true });
  assert.deepEqual(await vault.load(SLOT), identityObject);

  const { vault: otherKeyVault } = vaultWith({ store, keyByte: 9 }); // as if another seed
  await assert.rejects(() => otherKeyVault.save({ ...SLOT, identityObject }), (e) => e.reason === 'unreadable-slot');
  await assert.rejects(() => otherKeyVault.load(SLOT), (e) => e.reason === 'unreadable-slot');
});

test('the vault refuses an object that is not a store', () => {
  assert.throws(() => new IdentityVault({ store: {}, derivationNetwork: 'Testnet', storageKey: () => new Uint8Array(32) }),
    /needs async save, read and delete methods/);
});
