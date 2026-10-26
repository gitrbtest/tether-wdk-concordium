/**
 * verifyIdentityStore: checks a store against the identity store contract (see
 * ../storage/identity-store-contract.js), for operators who write their own store (a phone's storage, a
 * backend, a database). For tests only: it saves and deletes slots of its own. It works in any test
 * framework: it resolves if the store behaves, and throws an Error naming the first check that failed.
 */
import { requireIdentityStore } from '../storage/identity-store-contract.js';

const CHECK_PREFIX = 'concordium-identity-store-check';

/** True if both are byte arrays with the same bytes (Java: Arrays.equals). */
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
  && a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Check that a store behaves as the contract requires.
 *
 * It calls the store's OWN save, read and delete (whatever store is passed in: a MemoryIdentityStore,
 * a database store…) with dummy bytes in two throwaway slots, and checks each answer:
 *
 *   1. an empty slot reads as null
 *   2. read returns exactly the bytes saved
 *   3. saving again to the same slot replaces the bytes
 *   4. the store keeps its own copy: changing the caller's array afterwards changes nothing
 *   5. two slots do not affect each other
 *   6. delete empties its slot, and only its slot
 *   7. deleting an empty slot is not an error
 *
 * The slots are named 'concordium-identity-store-check/<time>-a' and '-b' (new names each run, never
 * a real identity's slot) and are deleted at the end, pass or fail. Run it against a test instance.
 *
 * @param {{ save: Function, read: Function, delete: Function }} store
 * @returns {Promise<void>}  resolves if every check passes
 * @throws {Error} naming the first check that failed
 */
export async function verifyIdentityStore(store) {
  requireIdentityStore(store);
  const slotA = `${CHECK_PREFIX}/${Date.now()}-a`;
  const slotB = `${CHECK_PREFIX}/${Date.now()}-b`;
  const check = (passed, what) => {
    if (!passed) throw new Error(`Identity store contract: ${what}.`);
  };
  // Dummy bytes, different from each other so we can tell which came back.
  const first = Uint8Array.from([0x43, 0x57, 0x49, 0x44, 1, 0, 255, 7]);
  const second = Uint8Array.from([0x43, 0x57, 0x49, 0x44, 1, 9, 9, 9, 9, 9]);
  const other = Uint8Array.from([1, 2, 3]);

  try {
    // 1. An empty slot reads as null.
    check(await store.read(slotA) === null, 'read of a slot with nothing saved must return null');

    // 2. Read returns exactly the bytes saved.
    await store.save(slotA, first);
    check(sameBytes(await store.read(slotA), first), 'read must return exactly the bytes saved (as a Uint8Array)');

    // 3. Saving again to the same slot replaces the bytes.
    const sent = Uint8Array.from(second); // our own copy, changed in step 4
    await store.save(slotA, sent);
    check(sameBytes(await store.read(slotA), second), 'saving again to the same slot must replace the bytes');

    // 4. The store keeps its own copy: zeroing our array must not change what it holds.
    sent.fill(0);
    check(sameBytes(await store.read(slotA), second),
      'the saved bytes must not change when the caller later changes its own array');

    // 5. Two slots do not affect each other.
    await store.save(slotB, other);
    check(sameBytes(await store.read(slotA), second) && sameBytes(await store.read(slotB), other),
      'slots must not affect each other');

    // 6. Delete empties its slot, and only its slot.
    await store.delete(slotA);
    check(await store.read(slotA) === null, 'read after delete must return null');
    check(sameBytes(await store.read(slotB), other), 'delete must only remove its own slot');

    // 7. Deleting an empty slot is not an error (if the store throws here, the catch reports it).
    await store.delete(slotA);
  } catch (e) {
    // Our own check failures pass through unchanged; anything the store itself threw is reported as such.
    if (e.message.startsWith('Identity store contract:')) throw e;
    throw new Error(`Identity store contract: the store threw during the checks: ${e.message}`, { cause: e });
  } finally {
    // Pass or fail, delete both test slots so the store is left as it was found.
    await Promise.allSettled([store.delete(slotA), store.delete(slotB)]);
  }
}
