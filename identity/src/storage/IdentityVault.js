/**
 * IdentityVault: keeps identities encrypted in a store. Internal: ConcordiumIdentity owns one when it
 * is given a store, and asks it to save, load and delete; wallets use ConcordiumIdentity's methods.
 *
 * The vault knows about storage (slot names, the encryption key, the format, the store); it never sees
 * the seed. It asks for the encryption key through `storageKey()` when it needs one, and wipes it after
 * each use.
 */
import { requireIdentityStore } from './identity-store-contract.js';
import { storageSlotName, encryptIdentity, decryptIdentity } from './storage-format.js';
import { IdentityStorageError } from '../shared/errors.js';

export default class IdentityVault {
  #store;
  #derivationNetwork;
  #storageKey;

  /**
   * @param {object} options
   * @param {{ save: Function, read: Function, delete: Function }} options.store  any IdentityStore
   * @param {string} options.derivationNetwork  'Testnet' or 'Mainnet': part of every slot name
   * @param {() => Uint8Array} options.storageKey  gives a fresh copy of the 32-byte encryption key; the vault wipes it after use
   */
  constructor({ store, derivationNetwork, storageKey }) {
    this.#store = requireIdentityStore(store);
    this.#derivationNetwork = derivationNetwork;
    this.#storageKey = storageKey;
  }

  /** The slot an identity is saved in, e.g. 'concordium-identity/testnet/0/0'. */
  slotName(providerIndex, identityIndex) {
    return storageSlotName(this.#derivationNetwork, providerIndex, identityIndex);
  }

  /** Run `use(key)` with a fresh encryption key, and wipe the key afterwards, whatever happens. */
  async #withKey(use) {
    const key = this.#storageKey();
    try {
      return await use(key);
    } finally {
      key.fill(0);
    }
  }

  /**
   * Save an identity, encrypted. Unless `replace` is true, a slot already holding a different identity
   * (or bytes this wallet's seed cannot decrypt) is refused and left untouched; the same identity is
   * simply saved again.
   *
   * @returns {Promise<string>}  the slot name
   * @throws {IdentityStorageError} reason 'slot-in-use' or 'unreadable-slot' (unless replace)
   */
  async save({ providerIndex, identityIndex, identityObject, replace = false }) {
    const slotName = this.slotName(providerIndex, identityIndex);
    await this.#withKey(async (key) => {
      if (!replace) await this.#refuseToReplace(key, slotName, identityObject, providerIndex, identityIndex);
      await this.#store.save(slotName, encryptIdentity(key, slotName, { providerIndex, identityIndex, identityObject }));
    });
    return slotName;
  }

  /** Throws unless the slot is empty or already holds this same identity. */
  async #refuseToReplace(key, slotName, identityObject, providerIndex, identityIndex) {
    const existing = await this.#store.read(slotName);
    if (existing === null || existing === undefined) return;
    let saved;
    try {
      saved = decryptIdentity(key, slotName, existing);
    } catch (e) {
      if (!(e instanceof IdentityStorageError)) throw e;
      throw new IdentityStorageError(`${e.message} Pass { replace: true } to overwrite it.`, { reason: 'unreadable-slot', slotName });
    }
    // Compare the identity itself, never the encrypted bytes (they differ on every save).
    if (JSON.stringify(saved.identityObject) !== JSON.stringify(identityObject)) {
      throw new IdentityStorageError(`A different identity is already saved for provider ${providerIndex}, `
        + `identity ${identityIndex}. Pass { replace: true } to replace it, e.g. after the user verified again `
        + 'because the saved identity expired.', { reason: 'slot-in-use', slotName });
    }
  }

  /**
   * Load a saved identity. No network call: decrypting proves it was saved with this wallet's seed
   * for this slot.
   *
   * @returns {Promise<object | null>}  the identity object, or null if nothing is saved in the slot
   * @throws {IdentityStorageError} reason 'unreadable-slot' if the saved bytes cannot be decrypted
   */
  async load({ providerIndex, identityIndex }) {
    const slotName = this.slotName(providerIndex, identityIndex);
    const bytes = await this.#store.read(slotName);
    if (bytes === null || bytes === undefined) return null;
    const record = await this.#withKey((key) => decryptIdentity(key, slotName, bytes));
    if (record.providerIndex !== providerIndex || record.identityIndex !== identityIndex) {
      throw new IdentityStorageError(`The identity saved in ${slotName} is for another provider or identity index.`,
        { reason: 'unreadable-slot', slotName });
    }
    return record.identityObject;
  }

  /** Delete a saved identity. Nothing saved is not an error. */
  async delete({ providerIndex, identityIndex }) {
    await this.#store.delete(this.slotName(providerIndex, identityIndex));
  }
}
