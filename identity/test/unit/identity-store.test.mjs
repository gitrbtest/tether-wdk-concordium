/**
 * The identity store contract (save / read / delete), MemoryIdentityStore, and verifyIdentityStore,
 * the check operators can run against their own stores. No external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryIdentityStore } from '@concordium/wdk-identity-concordium';
import { verifyIdentityStore } from '@concordium/wdk-identity-concordium/testing';

const SLOT = 'concordium-identity/testnet/0/7';

test('MemoryIdentityStore passes the contract check', async () => {
  await verifyIdentityStore(new MemoryIdentityStore());
});

test('MemoryIdentityStore: read of nothing is null; save, replace and delete work per slot', async () => {
  const store = new MemoryIdentityStore();
  assert.equal(await store.read(SLOT), null);
  await store.save(SLOT, Uint8Array.from([1, 2]));
  await store.save(SLOT, Uint8Array.from([3]));
  assert.deepEqual(await store.read(SLOT), Uint8Array.from([3]));
  await store.delete(SLOT);
  assert.equal(await store.read(SLOT), null);
});

test('MemoryIdentityStore keeps its own copy: neither the saved nor the returned array can change it', async () => {
  const store = new MemoryIdentityStore();
  const bytes = Uint8Array.from([1, 2, 3]);
  await store.save(SLOT, bytes);
  bytes.fill(0);
  (await store.read(SLOT)).fill(9);
  assert.deepEqual(await store.read(SLOT), Uint8Array.from([1, 2, 3]));
});

test('MemoryIdentityStore refuses a missing slot name or bytes that are not a Uint8Array', async () => {
  const store = new MemoryIdentityStore();
  await assert.rejects(() => store.save('', Uint8Array.from([1])), /slotName must be a non-empty string/);
  await assert.rejects(() => store.read(undefined), /slotName must be a non-empty string/);
  await assert.rejects(() => store.save(SLOT, 'text'), /bytes must be a Uint8Array/);
});

/** A store built from a Map, with one behaviour broken, to show the check names what is wrong. */
function brokenStore(broken) {
  const slots = new Map();
  const store = {
    async save(name, bytes) { slots.set(name, Uint8Array.from(bytes)); },
    async read(name) { return slots.has(name) ? Uint8Array.from(slots.get(name)) : null; },
    async delete(name) { slots.delete(name); },
  };
  return { ...store, ...broken(slots, store) };
}

test('verifyIdentityStore names the broken behaviour of a store', async () => {
  const cases = [
    ['returns undefined for nothing saved', (slots) => ({ async read(n) { return slots.get(n); } }),
      /read of a slot with nothing saved must return null/],
    ['returns text instead of bytes', (slots) => ({ async read(n) { return slots.has(n) ? 'abc' : null; } }),
      /read must return exactly the bytes saved/],
    ['keeps the first save', (slots) => ({ async save(n, b) { if (!slots.has(n)) slots.set(n, Uint8Array.from(b)); } }),
      /saving again to the same slot must replace the bytes/],
    ['keeps the caller\'s array', (slots) => ({ async save(n, b) { slots.set(n, b); }, async read(n) { return slots.get(n) ?? null; } }),
      /must not change when the caller later changes its own array/],
    ['puts everything in one slot', (slots) => ({
      async save(n, b) { slots.set('one', Uint8Array.from(b)); },
      async read() { return slots.has('one') ? Uint8Array.from(slots.get('one')) : null; },
    }), /read of a slot with nothing saved must return null|slots must not affect each other/],
    ['ignores delete', () => ({ async delete() {} }), /read after delete must return null/],
    ['deletes everything', (slots) => ({ async delete() { slots.clear(); } }), /delete must only remove its own slot/],
    ['throws when deleting nothing', (slots) => ({ async delete(n) { if (!slots.delete(n)) throw new Error('no such slot'); } }),
      /the store threw during the checks: no such slot/],
  ];
  for (const [name, broken, expected] of cases) {
    await assert.rejects(() => verifyIdentityStore(brokenStore(broken)), expected, name);
  }
});

test('verifyIdentityStore refuses an object without the three methods', async () => {
  await assert.rejects(() => verifyIdentityStore({ save() {}, read() {} }), /needs async save, read and delete methods; delete is missing/);
  await assert.rejects(() => verifyIdentityStore(undefined), /save is missing/);
});

test('verifyIdentityStore leaves nothing behind in the store', async () => {
  const names = new Set();
  const store = new MemoryIdentityStore();
  const watched = {
    save: (n, b) => { names.add(n); return store.save(n, b); },
    read: (n) => store.read(n),
    delete: (n) => store.delete(n),
  };
  await verifyIdentityStore(watched);
  assert.ok(names.size > 0);
  for (const name of names) {
    assert.match(name, /^concordium-identity-store-check\//);
    assert.equal(await store.read(name), null);
  }
});
