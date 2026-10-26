/**
 * The identity store contract.
 *
 * A store is any object with three async methods. It only ever receives encrypted bytes and
 * a slot name such as 'concordium-identity/testnet/0/0'; it never sees the identity itself.
 *
 *   save(slotName, bytes)   save the bytes (Uint8Array) under the name, replacing anything there
 *   read(slotName)          the bytes saved under the name, or null if there are none
 *   delete(slotName)        remove them; nothing saved there is not an error
 *
 * Operators can check their own store with verifyIdentityStore, from the testing entry point
 * (@concordium/wdk-identity-concordium/testing).
 */

/** Throws unless `store` has the three methods (used wherever a store is accepted). */
export function requireIdentityStore(store) {
  for (const method of ['save', 'read', 'delete']) {
    if (typeof store?.[method] !== 'function') {
      throw new TypeError(`An identity store needs async save, read and delete methods; ${method} is missing.`);
    }
  }
  return store;
}
