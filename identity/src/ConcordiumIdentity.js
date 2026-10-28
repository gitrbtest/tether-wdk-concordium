import * as sdk from '@concordium/web-sdk';
import { bytesToHex } from '@noble/hashes/utils';
import { parseIdentityConfig } from './shared/config.js';
import { requireIndex, toSeedBytes } from './shared/inputs.js';
import HeldIdentities from './shared/HeldIdentities.js';
import IdentityProviders from './providers/IdentityProviders.js';
import WalletProxy from './providers/WalletProxy.js';
import IdentityIssuance from './issuance/IdentityIssuance.js';
import { identityContent, summaryOf } from './issuance/identity-object.js';
import IdentityVault from './storage/IdentityVault.js';
import { deriveStorageKey } from './storage/storage-format.js';
import AccountCreator, { readAccountOptions } from './account/AccountCreator.js';

/**
 * A wallet's Concordium identity, derived from the wallet's own seed, without the Concordium ID App:
 * request an identity from a provider, collect it, save it encrypted, and create accounts from it.
 *
 * This class is the public face. It owns the seed and hands each call to a helper:
 *
 *   ConcordiumIdentity   seed, dispose, the public methods
 *     ├─ IdentityIssuance   request link, collect + ownership check        (issuance/)
 *     ├─ HeldIdentities     the identities held in memory, as bytes        (shared/)
 *     ├─ IdentityVault      save / load / delete, encrypted                 (storage/)
 *     └─ AccountCreator     checks, "exists?", build, send + wait           (account/)
 */
export default class ConcordiumIdentity {
  // ---- Creating and disposing ----

  /**
   * @param {string | Uint8Array} seed  the wallet's BIP-39 seed phrase, or its 64-byte seed
   * @param {{ useMainnetKeyDerivation: boolean, walletProxyUrl: string }} config
   *   e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG; use the same key derivation as the wallet package
   * @param {{ fetch?: typeof fetch, store?: { save: Function, read: Function, delete: Function } }} [options]
   *   fetch: HTTP implementation (defaults to the global fetch);
   *   store: where saveIdentity / loadIdentity keep encrypted identities (any IdentityStore)
   */
  constructor(seed, config, { fetch: fetchFn = (url, options) => fetch(url, options), store } = {}) {
    this._config = parseIdentityConfig(config); // validated before the seed is touched
    this._fetch = fetchFn;
    const fetchVia = (url, options) => this._fetch(url, options);
    const walletProxy = new WalletProxy(this._config, { fetch: fetchVia });
    const providers = new IdentityProviders(this._config, { fetch: fetchVia });
    const hdWallet = () => this._hdWallet; // the helpers never see the seed itself

    this._held = new HeldIdentities();
    this._issuance = new IdentityIssuance({ providers, walletProxy, fetch: fetchVia, hdWallet, held: this._held });
    this._accounts = new AccountCreator({ providers, walletProxy, hdWallet });
    // Saving identities: the vault asks for the key through _storageKey() and never sees the seed.
    this._vault = store === undefined ? undefined : new IdentityVault({
      store, derivationNetwork: this._config.derivationNetwork, storageKey: () => this._storageKey(),
    });
    this._seed = toSeedBytes(seed);
  }

  /** True once dispose() has been called. */
  get disposed() {
    return this._seed === undefined;
  }

  /** Zero the seed and any identities held, and drop them. Later calls that need the seed throw. A second call does nothing. */
  dispose() {
    if (this._seed) this._seed.fill(0);
    this._seed = undefined;
    this._held.zeroAll();
    this._issuance.dispose();
  }

  _requireNotDisposed() {
    if (this.disposed) throw new Error('This identity has been disposed.');
  }

  /** Key derivation for this identity's seed and network (the same tree as the wallet package). */
  get _hdWallet() {
    this._requireNotDisposed();
    return sdk.ConcordiumHdWallet.fromHex(bytesToHex(this._seed), this._config.derivationNetwork);
  }

  /** The encryption key for saved identities, from the seed. The vault zeroes it after each use. */
  _storageKey() {
    this._requireNotDisposed();
    return deriveStorageKey(this._seed, this._config.derivationNetwork);
  }

  // ---- Starting verification ----

  /**
   * Start identity verification: build the identity request for a provider from
   * this wallet's seed, and the link that opens the provider's verification page.
   * Open `issuanceUrl` in a browser or web view; when verification finishes, the
   * provider sends the browser to `redirectUri`.
   *
   * @param {object} options
   * @param {number} options.providerIndex  the provider's index on this network (see IdentityProviders)
   * @param {number} [options.identityIndex=0]  which of the wallet's identities with this provider
   * @param {string} options.redirectUri  where the provider sends the browser afterwards
   * @returns {Promise<{ issuanceUrl: string, providerIndex: number, identityIndex: number }>}
   * @throws {IdentityProviderError} If the provider is not published, or publishes no issuance address.
   * @throws {Error} If the identity has been disposed.
   */
  async createIdentityRequest(options) {
    this._requireNotDisposed();
    return this._issuance.createRequest(options);
  }

  // ---- Collecting the issued identity ----

  /**
   * Read the address the provider sent the browser back to, after verification.
   * No network call: the provider's reply is in the URL itself, after `#` (or `?`).
   * On success it holds a `code_uri`, where the issued identity can be collected
   * (see waitForIdentity); save it to resume collecting after an app restart.
   *
   * @param {string} callbackUrl  the full URL the browser arrived at (the redirectUri plus the provider's reply)
   * @returns {{ codeUri: string }}
   * @throws {IdentityIssuanceError} With reason 'provider-error' if the provider reported an error.
   * @throws {Error} If the URL holds neither a code_uri nor a provider error.
   */
  parseIdentityCallback(callbackUrl) {
    return this._issuance.parseCallback(callbackUrl);
  }

  /**
   * Collect the identity the provider issued: poll the code_uri from the callback
   * until the provider reports it issued or rejected. The identity is checked to
   * be this wallet's (same seed, provider and identity index) and kept inside
   * this object for storage and account creation; only a summary is returned.
   *
   * The provider and identity index default to those of the last
   * createIdentityRequest on this object. Pass them when resuming in a new
   * object, e.g. after an app restart.
   *
   * @param {string} codeUri  from parseIdentityCallback
   * @param {object} [options]
   * @param {number} [options.providerIndex]  the provider the request was made to
   * @param {number} [options.identityIndex=0]  the identity index the request was made for
   * @param {number} [options.timeoutMs=900000]  give up after this long (default 15 minutes)
   * @param {number} [options.intervalMs=3000]  wait this long between polls
   * @param {AbortSignal} [options.signal]  cancels the wait
   * @returns {Promise<{ providerIndex: number, identityIndex: number, createdAt: string, validTo: string, maxAccounts: number }>}
   * @throws {IdentityIssuanceError} reason 'rejected', 'timeout' or 'cancelled'.
   */
  async waitForIdentity(codeUri, options) {
    this._requireNotDisposed();
    return this._issuance.waitForIdentity(codeUri, options);
  }

  /**
   * Read the provider's callback and collect the issued identity: parseIdentityCallback
   * then waitForIdentity. After createIdentityRequest on this object, the callback
   * address is all that is needed. To survive an app restart while waiting, call
   * the two separately and save the code_uri in between.
   *
   * @param {string} callbackUrl  the full URL the provider sent the browser to
   * @param {object} [options]  as for waitForIdentity: providerIndex, identityIndex, timeoutMs, intervalMs, signal
   */
  async retrieveIdentity(callbackUrl, options) {
    this._requireNotDisposed();
    return this._issuance.retrieveIdentity(callbackUrl, options);
  }

  // ---- Saving identities ----

  /**
   * Save the identity held for a provider and identity index, encrypted, in the configured store.
   * The store receives only encrypted bytes and the slot name. The identity must be held: collected
   * with retrieveIdentity / waitForIdentity, or loaded with loadIdentity.
   *
   * A slot that already holds the same identity is simply saved again. A slot holding a different
   * identity, or bytes that cannot be decrypted with this wallet's seed, is never replaced silently:
   * pass { replace: true } to replace it (ask the user first, e.g. after they verified again because
   * the saved identity expired).
   *
   * @param {{ providerIndex: number, identityIndex: number, replace?: boolean }} options
   * @returns {Promise<{ providerIndex: number, identityIndex: number, createdAt: string, validTo: string,
   *   maxAccounts: number, slotName: string }>}  the identity's summary and where it was saved
   * @throws {IdentityStorageError} reason 'slot-in-use' or 'unreadable-slot', unless replace is true
   */
  async saveIdentity({ providerIndex, identityIndex, replace = false } = {}) {
    const vault = this._ready();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    const identityObject = this._held.require(providerIndex, identityIndex);
    const slotName = await vault.save({ providerIndex, identityIndex, identityObject, replace });
    const content = identityContent(identityObject, 'The identity held is in an unexpected format.');
    return { ...summaryOf(content, providerIndex, identityIndex), slotName };
  }

  /**
   * Load a saved identity from the configured store and hold it inside this object again (e.g. after
   * an app restart), ready for account creation. No network call.
   *
   * @param {{ providerIndex: number, identityIndex: number }} options
   * @returns {Promise<{ providerIndex: number, identityIndex: number, createdAt: string, validTo: string,
   *   maxAccounts: number } | null>}  the identity's summary, or null if nothing is saved for it
   * @throws {IdentityStorageError} reason 'unreadable-slot' if the saved bytes cannot be decrypted
   */
  async loadIdentity({ providerIndex, identityIndex } = {}) {
    const vault = this._ready();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    const identityObject = await vault.load({ providerIndex, identityIndex });
    if (identityObject === null) return null;
    const content = identityContent(identityObject,
      `The identity saved in ${vault.slotName(providerIndex, identityIndex)} is incomplete.`);
    this._held.hold(providerIndex, identityIndex, identityObject);
    return summaryOf(content, providerIndex, identityIndex);
  }

  /**
   * Delete the saved identity for a provider and identity index from the configured store. An identity
   * held inside this object is kept (dispose() clears those). Nothing saved is not an error.
   *
   * @param {{ providerIndex: number, identityIndex: number }} options
   */
  async deleteIdentity({ providerIndex, identityIndex } = {}) {
    const vault = this._ready();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    await vault.delete({ providerIndex, identityIndex });
  }

  /** Not disposed, and a store configured: the vault to save to and load from. */
  _ready() {
    this._requireNotDisposed();
    if (!this._vault) {
      throw new Error('No identity store is configured: pass { store } when creating ConcordiumIdentity, '
        + 'e.g. new MemoryIdentityStore().');
    }
    return this._vault;
  }

  // ---- Creating accounts ----

  /**
   * Create an account on chain from the identity held for a provider and identity index (collected, or
   * loaded with loadIdentity), with no ID App involved. Returns once the account is final on chain, so
   * the address always exists.
   *
   * An identity can have several accounts: credNumber 0, 1, 2… (below the identity's maxAccounts), the
   * same numbers as the wallet package's paths. The result's `path` (e.g. '0/0/1') is what the wallet package's
   * getAccountByPath takes, to use the new account (balance, transfers). If that account already
   * exists (e.g. created before an app restart), it is returned with created: false and nothing is sent.
   *
   * Nothing about the person is revealed on the account unless named in revealAttributes (e.g.
   * ['countryOfResidence']): those values become public on chain.
   *
   * @param {object} options
   * @param {number} options.providerIndex
   * @param {number} options.identityIndex
   * @param {number} [options.credNumber=0]  which account under this identity
   * @param {string[]} [options.revealAttributes=[]]  attribute names to show publicly on the account
   * @param {number} [options.timeoutMs=300000]  stop waiting after this long (default 5 minutes); the account may still be created
   * @param {number} [options.intervalMs=2000]  wait this long between status checks
   * @param {AbortSignal} [options.signal]  cancels the wait
   * @returns {Promise<{ providerIndex: number, identityIndex: number, credNumber: number, path: string, address: string,
   *   created: boolean, transactionHash?: string, blockHash?: string }>}
   * @throws {AccountCreationError} reason 'identity-expired', 'max-accounts' or 'unknown-attribute' (nothing
   *   sent); 'rejected', 'expired', 'timeout', 'cancelled' or 'wallet-proxy' (see AccountCreationError)
   * @throws {Error} If no identity is held for these numbers, an input is invalid, or the identity has been disposed.
   */
  async createAccount(options) {
    this._requireNotDisposed();
    const request = readAccountOptions(options);                                        // inputs checked, defaults filled in
    const identityObject = this._held.require(request.providerIndex, request.identityIndex); // the identity it is for
    return this._accounts.create(identityObject, request);                               // checks → exists? → build → send
  }
}
