import * as sdk from '@concordium/web-sdk';
import { bytesToHex } from '@noble/hashes/utils';
import { parseIdentityConfig } from './shared/config.js';
import { requireIndex, toSeedBytes } from './shared/inputs.js';
import HeldIdentities from './shared/HeldIdentities.js';
import IdentityProviders from './providers/IdentityProviders.js';
import WalletProxy from './providers/WalletProxy.js';
import IdentityIssuance from './issuance/IdentityIssuance.js';
import IdentityRecovery from './recovery/IdentityRecovery.js';
import IdentityProofs from './proofs/IdentityProofs.js';
import { identityContent, summaryOf } from './issuance/identity-object.js';
import { IdentityStorageError } from './shared/errors.js';
import {
  deriveStorageKey, identityLabel, networkLabel, encryptExport, decryptExport, decryptVersion1, plainExport, readExport,
} from './storage/identity-export.js';
import AccountCreator, { readAccountOptions } from './account/AccountCreator.js';

/**
 * A wallet's Concordium identity, derived from the wallet's own seed, without the Concordium ID App:
 * request an identity from a provider, collect it, export it for the wallet to keep (encrypted), and create
 * accounts from it.
 *
 * This class is the public face. It owns the seed and hands each call to a helper:
 *
 *   ConcordiumIdentity   seed, dispose, the public methods
 *     ├─ IdentityIssuance   request link, collect + ownership check        (issuance/)
 *     ├─ IdentityRecovery   get an identity back with the seed alone        (recovery/)
 *     ├─ IdentityProofs     answer a website's question with a proof        (proofs/)
 *     ├─ HeldIdentities     the identities held in memory, as bytes        (shared/)
 *     ├─ identity-export    the exported form (encrypted or plain)          (storage/)
 *     └─ AccountCreator     checks, "exists?", build, send + wait           (account/)
 */
export default class ConcordiumIdentity {
  // ---- Creating and disposing ----

  /**
   * @param {string | Uint8Array} seed  the wallet's BIP-39 seed phrase, or its 64-byte seed
   * @param {{ useMainnetKeyDerivation: boolean, walletProxyUrl: string }} config
   *   e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG; use the same key derivation as the wallet package
   * @param {{ fetch?: typeof fetch }} [options]  fetch: HTTP implementation (defaults to the global fetch)
   */
  constructor(seed, config, { fetch: fetchFn = (url, options) => fetch(url, options), ...rest } = {}) {
    if ('store' in rest) {
      throw new Error('The store option is gone: the package no longer stores identities. Use exportIdentity to get '
        + 'the identity as text to keep your own way, and importIdentity to hold it again.');
    }
    this._config = parseIdentityConfig(config); // validated before the seed is touched
    this._fetch = fetchFn;
    const fetchVia = (url, options) => this._fetch(url, options);
    const walletProxy = new WalletProxy(this._config, { fetch: fetchVia });
    const providers = new IdentityProviders(this._config, { fetch: fetchVia });
    const hdWallet = () => this._hdWallet; // the helpers never see the seed itself

    this._held = new HeldIdentities();
    this._issuance = new IdentityIssuance({ providers, walletProxy, fetch: fetchVia, hdWallet, held: this._held });
    this._recovery = new IdentityRecovery({ providers, walletProxy, fetch: fetchVia, hdWallet, held: this._held });
    this._proofs = new IdentityProofs({
      walletProxy, hdWallet, held: this._held, network: this._config.derivationNetwork,
      findAccounts: (options) => this._recovery.findAccounts(options),
    });
    this._accounts = new AccountCreator({ providers, walletProxy, hdWallet });
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

  /**
   * Lend the encryption key for exported identities to a piece of work, then wipe it. The key is made from the
   * seed each time and never kept: `use` gets it, and the `finally` overwrites it with zeros even if `use` fails.
   */
  _withStorageKey(use) {
    this._requireNotDisposed();
    const key = deriveStorageKey(this._seed, this._config.derivationNetwork);
    try {
      return use(key);
    } finally {
      key.fill(0);
    }
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
   * @param {number} options.identityIndex  which of the wallet's identities with this provider (0, 1, 2 …; no default:
   *   nextIdentityIndex gives the number for a new identity)
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
   * createIdentityRequest on this object. Pass both when resuming in a new
   * object, e.g. after an app restart.
   *
   * @param {string} codeUri  from parseIdentityCallback
   * @param {object} [options]
   * @param {number} [options.providerIndex]  the provider the request was made to
   * @param {number} [options.identityIndex]  the identity index the request was made for (required with providerIndex)
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

  // ---- Getting an identity back ----

  /**
   * Get an identity back from its provider with the seed alone, e.g. on a new device or after the
   * saved copy was lost: no verification, no browser. The provider looks the identity up by a request
   * built from this wallet's seed; the identity is checked to be this wallet's and kept inside this
   * object, as after retrieveIdentity (export it with exportIdentity, create accounts with createAccount).
   *
   * @param {object} options
   * @param {number} options.providerIndex  the provider that issued it
   * @param {number} options.identityIndex  which of the wallet's identities with this provider (0, 1, 2 …; no default:
   *   nextIdentityIndex gives the number for a new identity)
   * @param {AbortSignal} [options.signal]  cancels the request
   * @returns {Promise<{ providerIndex: number, identityIndex: number, createdAt: string, validTo: string,
   *   maxAccounts: number } | null>}  the identity's summary, or null if the provider has none for it
   * @throws {IdentityProviderError} If the provider is not published, or publishes no recovery address.
   * @throws {IdentityRecoveryError} reason 'provider-error', 'not-yours', 'network' or 'cancelled'.
   */
  async recoverIdentity(options) {
    this._requireNotDisposed();
    return this._recovery.recover(options);
  }

  /**
   * Find the accounts an identity has on chain, e.g. after recoverIdentity on a new device. Each
   * account's address comes from this wallet's seed (account 0, 1, 2 …) and the wallet-proxy says
   * whether it exists; the search stops after `gap` account numbers in a row with no account, or at the
   * identity's maxAccounts when the identity is held here. Read-only: it only asks whether each address
   * exists, and sends no transaction (nothing changes on chain, no fee). The addresses come from the seed
   * and the provider's public details, not from the identity itself, so this also works before (or
   * without) recovering the identity.
   *
   * @param {object} options
   * @param {number} options.providerIndex  the provider that issued the identity
   * @param {number} options.identityIndex  which of the wallet's identities with this provider (0, 1, 2 …; no default:
   *   nextIdentityIndex gives the number for a new identity)
   * @param {number} [options.gap=3]  stop after this many missing account numbers in a row
   * @param {AbortSignal} [options.signal]  cancels the search
   * @returns {Promise<Array<{ credNumber: number, address: string, path: string }>>}  the accounts found,
   *   in order; `path` is what the wallet package's getAccountByPath takes ('provider/identity/credNumber')
   * @throws {IdentityProviderError} If the provider is not published.
   * @throws {IdentityRecoveryError} reason 'wallet-proxy' or 'cancelled'.
   */
  async findAccounts(options) {
    this._requireNotDisposed();
    return this._recovery.findAccounts(options);
  }

  /**
   * The identity number to use for a NEW identity with a provider: the number after the highest identity this wallet
   * already has with it, or 0 if it has none. Found by asking the provider's recovery address for identity 0, 1, 2 …
   * (as recoverAll does) until `gap` numbers in a row have none. Nothing is kept or changed. Pass the result to
   * createIdentityRequest, so a new identity never lands on the number of an existing one.
   *
   * @param {object} options
   * @param {number} options.providerIndex  the provider to verify with
   * @param {number} [options.gap=3]  stop after this many missing identity numbers in a row
   * @param {AbortSignal} [options.signal]  cancels the search
   * @returns {Promise<number>}
   * @throws {IdentityProviderError} If the provider is not published, or publishes no recovery address.
   * @throws {IdentityRecoveryError} reason 'provider-error', 'not-yours', 'network' or 'cancelled'.
   */
  async nextIdentityIndex(options) {
    this._requireNotDisposed();
    return this._recovery.nextIdentityIndex(options);
  }

  /**
   * The account number to use for a NEW account under an identity: the number after the highest account the identity
   * has on chain (as findAccounts finds them), or 0 if it has none. Read-only. Pass the result to createAccount, so a
   * new account never lands on an existing one (createAccount would then return that existing account).
   *
   * @param {object} options
   * @param {number} options.providerIndex
   * @param {number} options.identityIndex
   * @param {number} [options.gap=3]  stop after this many missing account numbers in a row
   * @param {AbortSignal} [options.signal]  cancels the search
   * @returns {Promise<number>}
   * @throws {IdentityProviderError} If the provider is not published.
   * @throws {IdentityRecoveryError} reason 'wallet-proxy' or 'cancelled'.
   */
  async nextCredNumber(options) {
    this._requireNotDisposed();
    return this._recovery.nextCredNumber(options);
  }

  // ---- Answering a website's question (proofs) ----

  /**
   * Answer a website's question with a proof, from the identity held here and one of its accounts (version 0:
   * account-based, the format Concordium's apps and WalletConnect's request_verifiable_presentation use).
   *
   * The website's question comes in as it arrived: `challenge` and `credentialStatements` (or WalletConnect's
   * `paramsJson`). The identity itself never leaves the wallet: the proof shows only what was asked (e.g. "born
   * before …"), plus any detail the question asks to show. Show the person describeProofRequest's wording and get
   * their agreement first.
   *
   * Refuses before building anything if the answer would not be true (e.g. under the age asked for), so a wallet
   * never sends a proof that cannot be right.
   *
   * @param {object} options
   * @param {number} options.providerIndex  the identity's provider
   * @param {number} options.identityIndex  which of the wallet's identities with that provider
   * @param {number} options.credNumber  which of the identity's accounts answers (accountsThatCanAnswer lists the ones
   *   that can; no default)
   * @param {string} [options.challenge]  from the website's question
   * @param {object[]} [options.credentialStatements]  from the website's question
   * @param {string} [options.paramsJson]  or the question as WalletConnect wraps it
   * @returns {Promise<object>}  the proof (a VerifiablePresentation); its toString() is the JSON to send back
   *   (WalletConnect's verifiablePresentationJson)
   * @throws {ProofError} reason 'invalid-request', 'unknown-attribute', 'not-held', 'identity-expired',
   *   'provider-not-accepted' or 'cannot-prove'
   */
  async prove(options) {
    this._requireNotDisposed();
    return this._proofs.prove(options);
  }

  /**
   * Which of the identity's accounts on chain can answer a website's question: none if the identity cannot truly
   * answer it (expired, provider not accepted, or its details do not satisfy it), otherwise its accounts (as findAccounts
   * finds them). Read-only. The wallet picks one (or lets the person pick) and passes its credNumber to prove.
   *
   * @param {object} options  providerIndex, identityIndex (required), the question (challenge and
   *   credentialStatements, or paramsJson), and optionally gap and signal as for findAccounts
   * @returns {Promise<Array<{ credNumber: number, address: string, path: string }>>}
   * @throws {ProofError} reason 'invalid-request', 'unknown-attribute' or 'not-held'
   */
  async accountsThatCanAnswer(options) {
    this._requireNotDisposed();
    return this._proofs.accountsThatCanAnswer(options);
  }

  /**
   * Get everything back from the seed alone, in one call: what a wallet does on a new device.
   *
   * For each identity provider (every one that publishes a recovery address, or the ones listed in
   * `providerIndexes`), it tries identity 0, 1, 2 … with recoverIdentity, until `identityGap` numbers in
   * a row have no identity; for each identity it gets back, it finds its accounts with findAccounts.
   * Every identity found is held inside this object, ready for exportIdentity (call it for each one you
   * want to keep). Expired identities come back too: check `summary.validTo`.
   *
   * If one provider cannot be asked (it is down, or refuses), that is noted in `problems` and the others
   * are still asked, so nothing found is lost. Cancelling (`signal`) stops everything.
   *
   * Identities made with unusual identity numbers (far apart, or random as in the demo wallet) cannot be
   * found by counting 0, 1, 2 …; recover those with recoverIdentity and their number.
   *
   * @param {object} [options]
   * @param {number[]} [options.providerIndexes]  only these providers (default: all with a recovery address)
   * @param {number} [options.identityGap=3]  stop after this many missing identity numbers in a row, per provider
   * @param {number} [options.accountGap=3]  stop after this many missing account numbers in a row, per identity
   * @param {AbortSignal} [options.signal]  cancels it
   * @returns {Promise<{
   *   identities: Array<{ providerIndex: number, identityIndex: number,
   *     summary: { providerIndex: number, identityIndex: number, createdAt: string, validTo: string, maxAccounts: number },
   *     accounts: Array<{ credNumber: number, address: string, path: string }> | null }>,
   *   problems: Array<{ providerIndex: number, identityIndex: number | null, error: Error }> }>}
   *   `accounts` is null when the identity came back but its accounts could not be looked up (see problems);
   *   a problem's `identityIndex` is null when the provider itself could not be used
   * @throws {IdentityRecoveryError} reason 'cancelled'
   */
  async recoverAll(options) {
    this._requireNotDisposed();
    return this._recovery.recoverAll(options);
  }

  // ---- Keeping identities: export and import ----

  /**
   * The identity held for a provider and identity number, as text for the wallet to keep, its own way (e.g. next to
   * the seed). The package stores nothing itself. Hold it again later with importIdentity.
   *
   * Encrypted by default: the key is made from the seed (and never stored), so the text reveals nothing personal
   * and is safe to keep anywhere; only this seed can read it. Which identity it is (network, provider, identity
   * number) stays readable, and any change to the text is detected.
   *
   * With `encrypted: false`, the identity as plain JSON text, for a wallet that already keeps everything in an
   * encrypted vault of its own. It holds the person's details (name, date of birth, ID number) in the clear: keep it
   * as carefully as the seed.
   *
   * No network call. The identity must be held: verified, recovered, or imported.
   *
   * @param {object} options
   * @param {number} options.providerIndex
   * @param {number} options.identityIndex
   * @param {boolean} [options.encrypted=true]
   * @returns {Promise<string>}
   * @throws {Error} If no identity is held for these numbers, or the identity has been disposed.
   */
  async exportIdentity({ providerIndex, identityIndex, encrypted = true } = {}) {
    this._requireNotDisposed();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    if (typeof encrypted !== 'boolean') throw new Error('encrypted must be true or false.');
    const identityObject = this._held.require(providerIndex, identityIndex);
    const record = { providerIndex, identityIndex, identityObject };
    if (!encrypted) return plainExport(this._config.derivationNetwork, record);
    const label = identityLabel(this._config.derivationNetwork, providerIndex, identityIndex);
    return this._withStorageKey((key) => encryptExport(key, label, record));
  }

  /**
   * Hold an identity again from the text exportIdentity gave (either form; it tells them apart), e.g. after an app
   * restart. The identity is checked to be this wallet's before it is held:
   * - encrypted: it can only be decrypted with this seed's key; no network call;
   * - plain: its public key must be the one this seed gives for that provider and identity number (as when it was
   *   collected from the provider); this needs the network's cryptographic parameters (one call, then kept).
   *
   * Also reads identities saved by the earlier, store-based package (format version 1). Those bytes do not say which
   * identity they hold, so give its numbers: importIdentity(saved, { providerIndex, identityIndex }).
   *
   * @param {string | Uint8Array} exported  the text exportIdentity gave (or saved version-1 bytes)
   * @param {{ providerIndex?: number, identityIndex?: number }} [version1]  only for version-1 bytes: which identity
   * @returns {Promise<{ providerIndex: number, identityIndex: number, createdAt: string, validTo: string,
   *   maxAccounts: number }>}  the identity's summary
   * @throws {IdentityStorageError} reason 'unreadable' (not an exported identity, another network, another seed,
   *   changed or damaged text, an unknown format version) or 'not-yours' (a plain identity that is not this seed's)
   */
  async importIdentity(exported, { providerIndex, identityIndex } = {}) {
    this._requireNotDisposed();
    const network = networkLabel(this._config.derivationNetwork);
    const found = readExport(exported);
    let record;
    if (found.kind === 'version-1') {
      requireIndex(providerIndex, 'providerIndex', 'version-1 data (saved by the earlier, store-based package) does not '
        + 'say which identity it holds: pass { providerIndex, identityIndex }.');
      requireIndex(identityIndex, 'identityIndex', 'pass { providerIndex, identityIndex } for version-1 data.');
      const slotName = identityLabel(this._config.derivationNetwork, providerIndex, identityIndex); // the same text as the old slot name
      record = this._withStorageKey((key) => decryptVersion1(key, slotName, found.bytes));
      if (record.providerIndex !== providerIndex || record.identityIndex !== identityIndex) {
        throw new IdentityStorageError(`This saved identity is for another provider or identity number than ${slotName}.`, { reason: 'unreadable' });
      }
    } else if (found.kind === 'encrypted') {
      const [, labelNetwork] = found.label.split('/');
      if (labelNetwork !== network) {
        throw new IdentityStorageError(`This exported identity is for ${labelNetwork}, not ${network}.`, { reason: 'unreadable' });
      }
      record = this._withStorageKey((key) => decryptExport(key, found.bytes));
      if (found.label !== identityLabel(this._config.derivationNetwork, record.providerIndex, record.identityIndex)) {
        throw new IdentityStorageError('This exported identity is damaged (its label does not match its content).', { reason: 'unreadable' });
      }
    } else {
      if (found.network !== network) {
        throw new IdentityStorageError(`This exported identity is for ${found.network}, not ${network}.`, { reason: 'unreadable' });
      }
      record = found;
      const content = identityContent(record.identityObject, 'This exported identity is in an unexpected format.');
      const expected = await this._issuance.expectedIdCredPub(record.providerIndex, record.identityIndex);
      if (content.preIdentityObject.idCredPub !== expected) {
        throw new IdentityStorageError(`This identity does not belong to this wallet for provider ${record.providerIndex}, `
          + `identity ${record.identityIndex}.`, { reason: 'not-yours' });
      }
    }
    const content = identityContent(record.identityObject, 'This exported identity is in an unexpected format.');
    this._held.hold(record.providerIndex, record.identityIndex, record.identityObject);
    return summaryOf(content, record.providerIndex, record.identityIndex);
  }

  // ---- Creating accounts ----

  /**
   * Create an account on chain from the identity held for a provider and identity index (collected, or
   * imported with importIdentity), with no ID App involved. Returns once the account is final on chain, so
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
   * @param {number} options.credNumber  which account under this identity (0, 1, 2 …; no default: nextCredNumber gives
   *   the number for a new account, findAccounts lists the existing ones)
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
