import * as sdk from '@concordium/web-sdk';
import { bytesToHex } from '@noble/hashes/utils';
import { parseIdentityConfig } from './shared/config.js';
import { IdentityIssuanceError, IdentityProviderError, AccountCreationError } from './shared/errors.js';
import IdentityProviders from './providers/IdentityProviders.js';
import IdentityVault from './storage/IdentityVault.js';
import WalletProxy from './providers/WalletProxy.js';
import { deriveStorageKey } from './storage/storage-format.js';
import { buildIdentityRequest, issuanceLink, expectedIdCredPub } from './issuance/identity-request.js';
import { pollIdentityProvider, cancelledError, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_MS } from './issuance/identity-polling.js';
import { parseIdentityCallback as readIdentityCallback } from './issuance/identity-callback.js';
import { providerIdentityLabel, identityContent, summaryOf, hasExpired } from './issuance/identity-object.js';
import { buildAccountCredential, accountAddressOf, ATTRIBUTE_NAMES } from './account/credential.js';
import { submitAndWait, DEFAULT_ACCOUNT_TIMEOUT_MS, DEFAULT_ACCOUNT_INTERVAL_MS } from './account/submission.js';
import { requireIndex, requirePositive, requireRedirectUri, httpUrlOrNull, toSeedBytes } from './shared/inputs.js';

/**
 * A wallet's Concordium identity, derived from the wallet's own seed: requesting
 * an identity from a provider, without the Concordium ID App.
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
    // Saving identities: an IdentityVault on the given store. It asks for the key through _storageKey()
    // and never sees the seed.
    this._vault = store === undefined ? undefined : new IdentityVault({
      store, derivationNetwork: this._config.derivationNetwork, storageKey: () => this._storageKey(),
    });
    this._fetch = fetchFn;
    this._walletProxy = new WalletProxy(this._config, { fetch: (url, options) => this._fetch(url, options) });
    this._providers = new IdentityProviders(this._config, { fetch: (url, options) => this._fetch(url, options) });
    this._seed = toSeedBytes(seed);
    // Issued identities collected by waitForIdentity, held as UTF-8 JSON bytes so dispose() can zero them.
    this._identities = new Map();
    // The provider and identity index of the last request started here, so the
    // wallet can hand back just the callback address (see retrieveIdentity).
    this._requestAwaitingIdentity = null;
  }

  /** True once dispose() has been called. */
  get disposed() {
    return this._seed === undefined;
  }

  /** Zero the seed and any collected identities, and drop them. Later calls that need the seed throw. A second call does nothing. */
  dispose() {
    if (this._seed) this._seed.fill(0);
    this._seed = undefined;
    for (const bytes of this._identities.values()) bytes.fill(0);
    this._identities.clear();
    this._requestAwaitingIdentity = null;
  }

  _requireNotDisposed() {
    if (this.disposed) throw new Error('This identity has been disposed.');
  }

  /** Key derivation for this identity's seed and network (the same tree as the wallet package). */
  get _hdWallet() {
    this._requireNotDisposed();
    return sdk.ConcordiumHdWallet.fromHex(bytesToHex(this._seed), this._config.derivationNetwork);
  }

  /** The network's cryptographic parameters, as published by the wallet-proxy (read once per object). */
  _globalContext() {
    return this._walletProxy.globalContext();
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
  async createIdentityRequest({ providerIndex, identityIndex = 0, redirectUri } = {}) {
    this._requireNotDisposed();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    requireRedirectUri(redirectUri);

    const provider = await this._providers.get(providerIndex);
    if (!provider.issuanceStart) {
      throw new IdentityProviderError(
        `Identity provider ${providerIndex} publishes no issuance address on this network.`, providerIndex);
    }

    const globalContext = await this._globalContext();
    const idObjectRequest = buildIdentityRequest({ provider, globalContext, hdWallet: this._hdWallet, identityIndex });
    this._requestAwaitingIdentity = { providerIndex, identityIndex };
    return { issuanceUrl: issuanceLink(provider.issuanceStart, idObjectRequest, redirectUri), providerIndex, identityIndex };
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
    return readIdentityCallback(callbackUrl);
  }

  /** The idCredPub an identity for this seed, provider and identity index must carry. */
  async _expectedIdCredPub(providerIndex, identityIndex) {
    const provider = await this._providers.get(providerIndex);
    const globalContext = await this._globalContext();
    return expectedIdCredPub({ provider, globalContext, hdWallet: this._hdWallet, identityIndex });
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
  async waitForIdentity(codeUri, options = {}) {
    const { pollUrl, providerIndex, identityIndex, timeoutMs, intervalMs, signal } = this._checkWaitOptions(codeUri, options);
    const expectedIdCredPub = await this._expectedIdCredPub(providerIndex, identityIndex);
    const reply = await pollIdentityProvider({ fetch: this._fetch, url: pollUrl, timeoutMs, intervalMs, signal });
    if (reply.status === 'error') {
      this._finishRequest(providerIndex, identityIndex); // a rejected request can never succeed
      throw new IdentityIssuanceError(
        `The identity provider did not issue the identity${reply.detail ? `: ${reply.detail}` : '.'}`,
        { reason: 'rejected', detail: reply.detail || undefined });
    }
    return this._checkAndKeepIdentity(reply.token?.identityObject, { providerIndex, identityIndex, expectedIdCredPub });
  }

  /** Check waitForIdentity's inputs before any network call; resolves which identity is being collected. */
  _checkWaitOptions(codeUri, options) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS, signal } = options;
    this._requireNotDisposed();
    const pollUrl = httpUrlOrNull(codeUri);
    if (!pollUrl) throw new Error('codeUri must be an absolute HTTP(S) URL.');
    const { providerIndex, identityIndex } = this._identityToCollect(options);
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    requirePositive(timeoutMs, 'timeoutMs');
    requirePositive(intervalMs, 'intervalMs');
    if (signal?.aborted) throw cancelledError();
    return { pollUrl, providerIndex, identityIndex, timeoutMs, intervalMs, signal };
  }

  /** The provider and identity index to collect for: as given, or those of the request awaiting its identity. */
  _identityToCollect({ providerIndex, identityIndex } = {}) {
    if (providerIndex !== undefined) return { providerIndex, identityIndex: identityIndex ?? 0 };
    if (identityIndex === undefined && this._requestAwaitingIdentity) return { ...this._requestAwaitingIdentity };
    throw new Error('No identity request was started on this object: pass providerIndex '
      + '(and identityIndex, if not 0) to collect, e.g. when resuming after a restart.');
  }

  /** Check an issued identity is this wallet's, keep it as bytes, and return its summary. */
  _checkAndKeepIdentity(identityObject, { providerIndex, identityIndex, expectedIdCredPub }) {
    const content = identityContent(identityObject, 'The identity provider returned an identity in an unexpected format.');
    if (content.preIdentityObject.idCredPub !== expectedIdCredPub) {
      throw new Error(
        `The issued identity does not belong to this wallet for provider ${providerIndex}, identity ${identityIndex}.`);
    }
    this._holdIdentity(providerIndex, identityIndex, identityObject);
    this._finishRequest(providerIndex, identityIndex);
    return summaryOf(content, providerIndex, identityIndex);
  }

  /** Keep an identity inside this object as UTF-8 JSON bytes (zeroing any it replaces), so dispose() can zero it. */
  _holdIdentity(providerIndex, identityIndex, identityObject) {
    const label = providerIdentityLabel(providerIndex, identityIndex);
    this._identities.get(label)?.fill(0);
    this._identities.set(label, new TextEncoder().encode(JSON.stringify(identityObject)));
  }

  /** The request for this provider and identity index has ended (issued, rejected or refused): it no longer awaits its identity. */
  _finishRequest(providerIndex, identityIndex) {
    const awaiting = this._requestAwaitingIdentity;
    if (awaiting?.providerIndex === providerIndex && awaiting?.identityIndex === identityIndex) this._requestAwaitingIdentity = null;
  }

  /** As _finishRequest, for the request a call is about: the numbers given, or else the request awaiting its identity. */
  _finishRequestFor(options) {
    let request;
    try {
      request = this._identityToCollect(options);
    } catch {
      return; // no request to finish
    }
    this._finishRequest(request.providerIndex, request.identityIndex);
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
  async retrieveIdentity(callbackUrl, options = {}) {
    let codeUri;
    try {
      ({ codeUri } = this.parseIdentityCallback(callbackUrl));
    } catch (e) {
      // The provider's error reply ends the request, as a rejection does.
      if (e instanceof IdentityIssuanceError) this._finishRequestFor(options);
      throw e;
    }
    return this.waitForIdentity(codeUri, options);
  }

  // ---- Saving identities (the vault does the storage; this object holds the identities) ----

  _requireVault() {
    if (!this._vault) {
      throw new Error('No identity store is configured: pass { store } when creating ConcordiumIdentity, '
        + 'e.g. new MemoryIdentityStore().');
    }
    return this._vault;
  }

  /** The encryption key for saved identities, from the seed. The vault zeroes it after each use. */
  _storageKey() {
    this._requireNotDisposed();
    return deriveStorageKey(this._seed, this._config.derivationNetwork);
  }

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
    this._requireNotDisposed();
    const vault = this._requireVault();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    const held = this._identities.get(providerIdentityLabel(providerIndex, identityIndex));
    if (!held) {
      throw new Error(`No identity is held for provider ${providerIndex}, identity ${identityIndex}: `
        + 'collect it (retrieveIdentity) or load it (loadIdentity) first.');
    }
    const identityObject = JSON.parse(new TextDecoder().decode(held));
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
    this._requireNotDisposed();
    const vault = this._requireVault();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    const identityObject = await vault.load({ providerIndex, identityIndex });
    if (identityObject === null) return null;
    const content = identityContent(identityObject,
      `The identity saved in ${vault.slotName(providerIndex, identityIndex)} is incomplete.`);
    this._holdIdentity(providerIndex, identityIndex, identityObject);
    return summaryOf(content, providerIndex, identityIndex);
  }

  /**
   * Delete the saved identity for a provider and identity index from the configured store. An identity
   * held inside this object is kept (dispose() clears those). Nothing saved is not an error.
   *
   * @param {{ providerIndex: number, identityIndex: number }} options
   */
  async deleteIdentity({ providerIndex, identityIndex } = {}) {
    this._requireNotDisposed();
    const vault = this._requireVault();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    await vault.delete({ providerIndex, identityIndex });
  }

  // ---- Creating accounts ----

  /**
   * Create an account on chain from the identity held for a provider and identity index (collected, or
   * loaded with loadIdentity), with no ID App involved. Returns once the account is final on chain, so
   * the address always exists.
   *
   * An identity can have several accounts: credNumber 0, 1, 2… (below the identity's maxAccounts), the
   * same numbers as the wallet package's paths ("provider/identity/credNumber"). If that account already
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
   * @returns {Promise<{ providerIndex: number, identityIndex: number, credNumber: number, address: string,
   *   created: boolean, transactionHash?: string, blockHash?: string }>}
   * @throws {AccountCreationError} reason 'identity-expired', 'max-accounts' or 'unknown-attribute' (nothing
   *   sent); 'rejected', 'expired', 'timeout', 'cancelled' or 'wallet-proxy' (see AccountCreationError)
   * @throws {Error} If no identity is held for these numbers, an input is invalid, or the identity has been disposed.
   */
  async createAccount({
    providerIndex, identityIndex, credNumber = 0, revealAttributes = [],
    timeoutMs = DEFAULT_ACCOUNT_TIMEOUT_MS, intervalMs = DEFAULT_ACCOUNT_INTERVAL_MS, signal,
  } = {}) {
    this._requireNotDisposed();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    requireIndex(credNumber, 'credNumber');
    requirePositive(timeoutMs, 'timeoutMs');
    requirePositive(intervalMs, 'intervalMs');
    if (!Array.isArray(revealAttributes) || !revealAttributes.every((name) => typeof name === 'string')) {
      throw new Error('revealAttributes must be an array of attribute names.');
    }
    const held = this._identities.get(providerIdentityLabel(providerIndex, identityIndex));
    if (!held) {
      throw new Error(`No identity is held for provider ${providerIndex}, identity ${identityIndex}: `
        + 'collect it (retrieveIdentity) or load it (loadIdentity) first.');
    }
    const content = identityContent(JSON.parse(new TextDecoder().decode(held)), 'The identity held is in an unexpected format.');
    this._checkAccountRequest(content, { credNumber, revealAttributes });

    const provider = await this._providers.get(providerIndex);
    const globalContext = await this._globalContext();
    const hdWallet = this._hdWallet;
    const address = accountAddressOf({ provider, globalContext, hdWallet, identityIndex, credNumber });
    const result = { providerIndex, identityIndex, credNumber, address };

    // Already on chain (e.g. created before a restart): return it, send nothing.
    if (await this._accountExists(address, signal)) return { ...result, created: false };

    const credential = await buildAccountCredential({
      provider, globalContext, hdWallet, idObject: content, identityIndex, credNumber,
      revealAttributes: [...new Set(revealAttributes)],
      expiry: new Date(Date.now() + timeoutMs + ACCOUNT_CREDENTIAL_MARGIN_MS),
    });
    const { transactionHash, blockHash } = await submitAndWait({
      walletProxy: this._walletProxy, credential, timeoutMs, intervalMs, signal,
    });
    return { ...result, created: true, transactionHash, blockHash };
  }

  /** The checks made before anything is sent: each gives its own reason. */
  _checkAccountRequest(content, { credNumber, revealAttributes }) {
    const { validTo, maxAccounts, chosenAttributes } = content.attributeList;
    if (hasExpired(content)) {
      throw new AccountCreationError(`The identity expired at the end of ${validTo.slice(0, 4)}-${validTo.slice(4)}: `
        + 'verify again for a new identity to create accounts.', { reason: 'identity-expired' });
    }
    if (credNumber >= maxAccounts) {
      throw new AccountCreationError(`This identity allows ${maxAccounts} accounts (credNumber 0 to ${maxAccounts - 1}); `
        + `credNumber ${credNumber} is not one of them.`, { reason: 'max-accounts' });
    }
    const unknown = revealAttributes.find((name) => !ATTRIBUTE_NAMES.includes(name) || !(name in chosenAttributes));
    if (unknown !== undefined) {
      throw new AccountCreationError(`"${unknown}" is not an attribute this identity holds, so it cannot be revealed.`,
        { reason: 'unknown-attribute', detail: unknown });
    }
  }

  /** Whether the account exists on chain; a wallet-proxy failure is an AccountCreationError. */
  async _accountExists(address, signal) {
    try {
      return await this._walletProxy.accountExists(address, { signal });
    } catch (e) {
      if (signal?.aborted) {
        throw new AccountCreationError('Creating the account was cancelled before anything was sent.', { reason: 'cancelled', address });
      }
      throw new AccountCreationError(`The wallet-proxy could not say whether account ${address} exists: ${e.message}`,
        { reason: 'wallet-proxy', address, detail: e.message });
    }
  }
}

/**
 * The credential stays valid for the whole wait plus this margin, so it cannot expire while createAccount
 * is still waiting for it.
 */
const ACCOUNT_CREDENTIAL_MARGIN_MS = 2 * 60 * 1000;
