/**
 * The issued identities a ConcordiumIdentity holds in memory: collected from a provider or loaded from a
 * store, ready to be saved or to create accounts. Held as UTF-8 JSON bytes rather than objects, so they
 * can be zeroed (a JavaScript object or string cannot be wiped). Internal.
 */
import { providerIdentityLabel } from '../issuance/identity-object.js';

export default class HeldIdentities {
  /** label "provider/identity" → the identity as UTF-8 JSON bytes. (Underscore: tests check the zeroing.) */
  _bytes = new Map();

  /** Hold an identity, zeroing any identity it replaces for the same provider and identity index. */
  hold(providerIndex, identityIndex, identityObject) {
    const label = providerIdentityLabel(providerIndex, identityIndex);
    this._bytes.get(label)?.fill(0);
    this._bytes.set(label, new TextEncoder().encode(JSON.stringify(identityObject)));
  }

  has(providerIndex, identityIndex) {
    return this._bytes.has(providerIdentityLabel(providerIndex, identityIndex));
  }

  /** How many identities are held. */
  get size() {
    return this._bytes.size;
  }

  /**
   * The identity held for a provider and identity index, as a fresh object.
   * @throws {Error} If none is held: it must be collected or loaded first.
   */
  require(providerIndex, identityIndex) {
    const bytes = this._bytes.get(providerIdentityLabel(providerIndex, identityIndex));
    if (!bytes) {
      throw new Error(`No identity is held for provider ${providerIndex}, identity ${identityIndex}: `
        + 'collect it (retrieveIdentity) or load it (loadIdentity) first.');
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /** Zero every identity held, and drop them. */
  zeroAll() {
    for (const bytes of this._bytes.values()) bytes.fill(0);
    this._bytes.clear();
  }
}
