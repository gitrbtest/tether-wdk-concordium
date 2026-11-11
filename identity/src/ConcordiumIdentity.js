import * as sdk from '@concordium/web-sdk';
import { bytesToHex } from '@noble/hashes/utils';
import { parseIdentityConfig } from './shared/config.js';
import { requireIndex, toSeedBytes } from './shared/inputs.js';
import HeldIdentities from './shared/HeldIdentities.js';
import IdentityProviders from './providers/IdentityProviders.js';
import ChainNode from './chain/ChainNode.js';
import IdentityIssuance from './issuance/IdentityIssuance.js';
import IdentityRecovery from './recovery/IdentityRecovery.js';
import IdentityProofs from './proofs/IdentityProofs.js';
import { identityContent, summaryOf } from './issuance/identity-object.js';
import { IdentityStorageError } from './shared/errors.js';
import { networkLabel, exportText, readExport } from './storage/identity-export.js';
import AccountCreator, { readAccountOptions } from './account/AccountCreator.js';
import { isSignedByProvider } from './issuance/identity-signature.js';

/**
 * A wallet's Concordium identity, derived from the wallet's own seed, without the Concordium ID App:
 * request an identity from a provider, collect it, export it for the wallet to keep (NOT encrypted: the wallet keeps
 * it in its own secure storage, like the seed phrase), and create accounts from it.
 *
 * This class is the public face. It owns the seed and hands each call to a helper:
 *
 *   ConcordiumIdentity   seed, dispose, the public methods
 *     ├─ IdentityIssuance   request link, collect + ownership check        (issuance/)
 *     ├─ IdentityRecovery   get an identity back with the seed alone        (recovery/)
 *     ├─ IdentityProofs     answer a website's question with a proof        (proofs/)
 *     ├─ HeldIdentities     the identities held in memory, as bytes        (shared/)
 *     ├─ identity-export    the exported form (plain JSON, NOT encrypted)   (storage/)
 *     └─ AccountCreator     checks, "exists?", build, send + wait           (account/)
 */
export default class ConcordiumIdentity {
  // ---- Creating and disposing ----

  /**
   * @param {string | Uint8Array} seed  the wallet's BIP-39 seed phrase, or its 64-byte seed
   * @param {{ useMainnetKeyDerivation: boolean, identityProviders: object[], node: object }} config
   *   e.g. { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node }: use the same key derivation as the
   *   wallet package; identityProviders is the identity provider list (the wallet-proxy's /v2/ip_info shape), which
   *   the package does not fetch; node is the wallet's connection to a Concordium node (the package never opens one)
   * @param {{ fetch?: typeof fetch }} [options]  fetch: HTTP implementation (defaults to the global fetch).
   *   (`_signatureCheck` is internal, for the package's own tests only: it replaces the check that an identity's
   *   provider signature fits it, so tests can try identities with a detail changed on purpose. Never pass it.)
   */
  constructor(seed, config, { fetch: fetchFn = (url, options) => fetch(url, options), _signatureCheck = isSignedByProvider, ...rest } = {}) {
    if ('store' in rest) {
      throw new Error('The store option is gone: the package no longer stores identities. Use exportIdentity to get '
        + 'the identity as text to keep your own way, and importIdentity to hold it again.');
    }
    this._config = parseIdentityConfig(config); // validated before the seed is touched
    this._fetch = fetchFn;
    const fetchVia = (url, options) => this._fetch(url, options);
    const node = new ChainNode(this._config.node); // the wallet's own node connection
    const providers = new IdentityProviders(this._config.identityProviders, { node }); // checked against the chain on first use
    const hdWallet = () => this._hdWallet; // the helpers never see the seed itself

    this._held = new HeldIdentities();
    const network = this._config.derivationNetwork;
    const isSigned = _signatureCheck;
    this._issuance = new IdentityIssuance({ providers, node, fetch: fetchVia, hdWallet, held: this._held, network, isSigned });
    this._recovery = new IdentityRecovery({ providers, node, fetch: fetchVia, hdWallet, held: this._held, network, isSigned });
    this._proofs = new IdentityProofs({
      node, hdWallet, held: this._held, network: this._config.derivationNetwork,
      findAccounts: (options) => this._recovery.findAccounts(options), providers,
    });
    this._accounts = new AccountCreator({ providers, node, hdWallet });
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
   * account's address comes from this wallet's seed (account 0, 1, 2 …) and the node says
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
   * @throws {IdentityRecoveryError} reason 'node' or 'cancelled'.
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
   * @throws {IdentityRecoveryError} reason 'node' or 'cancelled'.
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
   * Answer a website's version 1 question with a proof from the identity itself: no account is named or needed
   * (identity-based). The website recorded the question on chain first (its anchor); the answer is tied to the
   * anchor's block, so it answers this question only.
   *
   * The question comes in as it arrived (Concordium's VerificationRequestV1, as JSON, JSON text or the SDK's object,
   * or WalletConnect's `{ paramsJson }`). Show the person describeProofRequest's and describeProofContext's wording
   * and get their agreement first. The identity never leaves the wallet: the proof shows only what was asked, plus
   * any detail the question asks to show, and which provider issued the identity.
   *
   * Refuses before building anything if the answer would not be true or acceptable (as prove does), and refuses a
   * question whose anchor is not on chain and final, or does not record this question. Reads the anchor and the
   * network's parameters from the node (config.node).
   *
   * @param {object} options
   * @param {number} options.providerIndex  the identity's provider
   * @param {number} options.identityIndex  which of the wallet's identities with that provider
   * @param {object|string} options.request  the website's version 1 question
   * @param {Record<string, string>} [options.context]  what the question asks the wallet to fill in besides the
   *   anchor's block, if anything: e.g. { ResourceID: 'shop.example' }, the site the wallet is connected to
   * @returns {Promise<object>}  the proof (Concordium's VerifiablePresentationV1); JSON.stringify(proof) is what to
   *   send back to the website
   * @throws {ProofError} reason 'invalid-request', 'unknown-attribute', 'not-held', 'identity-expired',
   *   'account-only', 'provider-not-accepted', 'cannot-prove', 'anchor-not-found', 'anchor-mismatch' or 'node'
   */
  async proveIdentity(options) {
    this._requireNotDisposed();
    return this._proofs.proveIdentity(options);
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
   * The identity held for a provider and identity number, as text for the wallet to keep, its own way. The package
   * stores nothing itself. Hold it again later with importIdentity.
   *
   * NOT ENCRYPTED. The text is plain JSON holding the person's verified details (name, date of birth, nationality,
   * ID document number, …), readable by anyone who has it. Keep it like any other secret: in the same secure storage
   * as the seed phrase (a phone's Keychain / Keystore, an encrypted database, a key vault). Never log it, put it in
   * analytics or crash reports, or keep it in plain files or unencrypted backups. It holds no keys.
   *
   * No network call. The identity must be held: verified, recovered, or imported.
   *
   * @param {object} options
   * @param {number} options.providerIndex
   * @param {number} options.identityIndex
   * @returns {Promise<string>}  plain JSON text (see docs/storage-format.md)
   * @throws {Error} If no identity is held for these numbers, or the identity has been disposed.
   */
  async exportIdentity({ providerIndex, identityIndex } = {}) {
    this._requireNotDisposed();
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    const identityObject = this._held.require(providerIndex, identityIndex);
    return exportText(this._config.derivationNetwork, { providerIndex, identityIndex, identityObject });
  }

  /**
   * Hold an identity again from the text exportIdentity gave, e.g. after an app restart. Before it is held, the
   * identity is checked to be this wallet's (its public key must be the one this seed phrase gives for that provider
   * and identity number, as when it was collected from the provider), and to be genuine (its provider's signature
   * must fit it exactly as it is: a changed detail, or a forged identity, is refused). This needs the network's
   * cryptographic parameters (one call to the node, then kept) and takes about a second.
   *
   * The text is the person's details in plain JSON: read it from the wallet's secure storage, as the seed phrase.
   *
   * @param {string} exported  the text exportIdentity gave
   * @returns {Promise<{ providerIndex: number, identityIndex: number, createdAt: string, validTo: string,
   *   maxAccounts: number }>}  the identity's summary
   * @throws {IdentityStorageError} reason 'unreadable' (not an exported identity, another network, an unknown format
   *   version, damaged text), 'not-yours' (an identity that does not belong to this seed phrase) or 'not-genuine'
   *   (its provider's signature does not fit it: changed since it was issued, or forged)
   */
  async importIdentity(exported) {
    this._requireNotDisposed();
    const network = networkLabel(this._config.derivationNetwork);
    const record = readExport(exported);
    if (record.network !== network) {
      throw new IdentityStorageError(`This exported identity is for ${record.network}, not ${network}.`, { reason: 'unreadable' });
    }
    const content = identityContent(record.identityObject, 'This exported identity is in an unexpected format.');
    const expected = await this._issuance.expectedIdCredPub(record.providerIndex, record.identityIndex);
    if (content.preIdentityObject.idCredPub !== expected) {
      throw new IdentityStorageError(`This identity does not belong to this wallet for provider ${record.providerIndex}, `
        + `identity ${record.identityIndex}.`, { reason: 'not-yours' });
    }
    // And it is genuine: its provider's signature fits it exactly as it is (nothing changed since it was issued).
    if (!await this._issuance.isGenuine(content, record.providerIndex, record.identityIndex)) {
      throw new IdentityStorageError(`This identity (provider ${record.providerIndex}, identity ${record.identityIndex}) `
        + 'is not as its provider issued it: its signature does not fit (changed or damaged text, or a forged identity).', { reason: 'not-genuine' });
    }
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
   *   sent); 'rejected', 'expired', 'timeout', 'cancelled' or 'node' (see AccountCreationError)
   * @throws {Error} If no identity is held for these numbers, an input is invalid, or the identity has been disposed.
   */
  async createAccount(options) {
    this._requireNotDisposed();
    const request = readAccountOptions(options);                                        // inputs checked, defaults filled in
    const identityObject = this._held.require(request.providerIndex, request.identityIndex); // the identity it is for
    return this._accounts.create(identityObject, request);                               // checks → exists? → build → send
  }
}
