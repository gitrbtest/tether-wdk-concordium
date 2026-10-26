/**
 * An identity store that keeps the encrypted bytes in memory: for tests and short-lived
 * processes. Nothing survives the process. For a store that persists, use FileIdentityStore
 * (Node.js) or write your own with the same three methods.
 */
export default class MemoryIdentityStore {
  #slots = new Map(); // slot name -> encrypted bytes (our own copy)

  /** Save the bytes under the slot name, replacing anything saved there before. */
  async save(slotName, bytes) {
    requireSlotName(slotName);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array.');
    this.#slots.set(slotName, Uint8Array.from(bytes)); // a copy: later changes to the caller's array do not reach it
  }

  /** The bytes saved under the slot name, or null if there are none. */
  async read(slotName) {
    requireSlotName(slotName);
    const bytes = this.#slots.get(slotName);
    return bytes ? Uint8Array.from(bytes) : null; // a copy: the caller cannot change what is stored
  }

  /** Remove what is saved under the slot name. Nothing saved there is not an error. */
  async delete(slotName) {
    requireSlotName(slotName);
    this.#slots.delete(slotName);
  }
}

function requireSlotName(slotName) {
  if (typeof slotName !== 'string' || slotName === '') throw new TypeError('slotName must be a non-empty string.');
}
