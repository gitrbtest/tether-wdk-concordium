import * as sdk from '@concordium/web-sdk';
import { parseIdentityConfig } from './config.js';
import { IdentityIssuanceError, IdentityProviderError } from './errors.js';
import IdentityProviders from './IdentityProviders.js';

const SEED_BYTES = 64;
const GLOBAL_PATH = '/v0/global';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 3000;
const MAX_POLL_ERRORS = 3; // consecutive network/HTTP failures tolerated while polling

function requirePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
}

/** Wait `ms`, or reject early with a 'cancelled' error if `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(cancelledError()); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function cancelledError() {
  return new IdentityIssuanceError('Waiting for the identity was cancelled.', { reason: 'cancelled' });
}

/** The label an issued identity is held under in _identities, e.g. "0/334563111" (provider 0, identity index 334563111). */
const providerIdentityLabel =(providerIndex, identityIndex) => `${providerIndex}/${identityIndex}`;

/** Same rule and wording as the wallet package's identity coordinates. */
function requireIndex(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is required and must be a non-negative safe integer.`);
  }
}

/**
 * The address the provider sends the browser back to. Any absolute URL is
 * accepted (a web address or an app's own scheme); there is no default. It is
 * passed on exactly as given: providers may compare it character for character
 * with the address the wallet registered.
 */
function requireRedirectUri(value) {
  try {
    if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error();
    new URL(value); // throws unless absolute
  } catch {
    throw new Error('redirectUri is required and must be an absolute URL.');
  }
}

/**
 * The 64-byte seed as our own copy. A seed phrase is checked and converted by
 * the SDK (BIP-39, as in the WDK base). Raw bytes are checked here, before the
 * SDK sees them: its length error repeats the seed, which must never reach a log.
 */
function toSeedBytes(seed) {
  if (typeof seed === 'string') {
    let hdWallet;
    try {
      hdWallet = sdk.ConcordiumHdWallet.fromSeedPhrase(seed, 'Testnet'); // the network does not affect the seed
    } catch {
      throw new Error('Invalid seed phrase.');
    }
    return Uint8Array.from(Buffer.from(hdWallet.seedAsHex, 'hex'));
  }
  if (seed instanceof Uint8Array && seed.length === SEED_BYTES) {
    return Uint8Array.from(seed);
  }
  throw new Error('The seed must be a BIP-39 seed phrase or a 64-byte seed.');
}

/** An absolute http(s) URL, or null. */
function httpUrlOrNull(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** The provider's error from the callback: JSON {"error":{"code","detail"}}, or plain text. */
function providerError(raw) {
  let code;
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    const error = parsed?.error ?? parsed;
    code = typeof error?.code === 'string' ? error.code : undefined;
    detail = typeof error?.detail === 'string' ? error.detail : raw;
  } catch {
    // not JSON: keep the raw text as the detail
  }
  return new IdentityIssuanceError(
    `The identity provider reported an error${code ? ` (${code})` : ''}; no identity was issued.`,
    { reason: 'provider-error', code, detail },
  );
}

/**
 * A wallet's Concordium identity, derived from the wallet's own seed: requesting
 * an identity from a provider, without the Concordium ID App.
 */
export default class ConcordiumIdentity {
  /**
   * @param {string | Uint8Array} seed  the wallet's BIP-39 seed phrase, or its 64-byte seed
   * @param {{ useMainnetKeyDerivation: boolean, walletProxyUrl: string }} config
   *   e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG; use the same key derivation as the wallet package
   * @param {{ fetch?: typeof fetch }} [options]  HTTP implementation (defaults to the global fetch)
   */
  constructor(seed, config, { fetch: fetchFn = (url, options) => fetch(url, options) } = {}) {
    this._config = parseIdentityConfig(config); // validated before the seed is touched
    this._fetch = fetchFn;
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
    return sdk.ConcordiumHdWallet.fromHex(Buffer.from(this._seed).toString('hex'), this._config.derivationNetwork);
  }

  /** The network's cryptographic parameters, as published by the wallet-proxy. */
  async _globalContext() {
    const response = await this._fetch(this._config.walletProxyUrl + GLOBAL_PATH);
    if (!response.ok) {
      throw new Error(`The wallet-proxy answered HTTP ${response.status} for the cryptographic parameters.`);
    }
    const { value } = await response.json();
    if (!value?.onChainCommitmentKey || !value?.bulletproofGenerators || !value?.genesisString) {
      throw new Error('The wallet-proxy returned cryptographic parameters in an unexpected format.');
    }
    return value;
  }

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
    // Keys are derived with the provider's own index, so the request and the keys always agree.
    const ipIdentity = provider.ipInfo.ipIdentity;
    const hdWallet = this._hdWallet;
    const idObjectRequest = sdk.createIdentityRequestWithKeys({
      ipInfo: provider.ipInfo,
      arsInfos: provider.arsInfos,
      // Any arThreshold of the provider's anonymity revokers together can reveal the identity; fewer cannot.
      arThreshold: Math.max(1, Object.keys(provider.arsInfos).length - 1),
      globalContext,
      idCredSec: hdWallet.getIdCredSec(ipIdentity, identityIndex).toString('hex'),
      prfKey: hdWallet.getPrfKey(ipIdentity, identityIndex).toString('hex'),
      blindingRandomness: hdWallet.getSignatureBlindingRandomness(ipIdentity, identityIndex).toString('hex'),
    });

    const query = new URLSearchParams({
      state: JSON.stringify({ idObjectRequest }),
      response_type: 'code',
      scope: 'identity',
      redirect_uri: redirectUri,
    });
    this._requestAwaitingIdentity = { providerIndex, identityIndex };
    return { issuanceUrl: `${provider.issuanceStart}?${query}`, providerIndex, identityIndex };
  }

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
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new Error('callbackUrl must be the absolute URL the provider sent the browser to.');
    }
    const reply = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
    if (reply.has('error')) throw providerError(reply.get('error'));
    if (!reply.has('code_uri')) {
      throw new Error('The callback holds neither a code_uri nor an error from the identity provider.');
    }
    const codeUri = httpUrlOrNull(reply.get('code_uri'));
    if (!codeUri) throw new Error("The callback's code_uri is not an absolute HTTP(S) URL.");
    return { codeUri };
  }

  /** The idCredPub an identity for this seed, provider and identity index must carry. */
  async _expectedIdCredPub(providerIndex, identityIndex) {
    const provider = await this._providers.get(providerIndex);
    const globalContext = await this._globalContext();
    const idCredSec = this._hdWallet.getIdCredSec(provider.ipInfo.ipIdentity, identityIndex).toString('hex');
    return sdk.createIdentityRecoveryRequestWithKeys({
      ipInfo: provider.ipInfo, globalContext, idCredSec, timestamp: 0,
    }).value.idCredPub;
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

    const expectedIdCredPub = await this._expectedIdCredPub(providerIndex, identityIndex);
    const deadline = Date.now() + timeoutMs;
    let failedPollsInARow = 0;

    while (true) {
      if (signal?.aborted) throw cancelledError();
      let reply;
      try {
        const response = await this._fetch(pollUrl, { signal });
        if (!response.ok) throw new Error(`The identity provider answered HTTP ${response.status}.`);
        reply = await response.json();
        failedPollsInARow = 0;
      } catch (e) {
        if (signal?.aborted) throw cancelledError();
        if (++failedPollsInARow >= MAX_POLL_ERRORS) throw e;
      }

      if (reply?.status === 'done') {
        return this._checkAndKeepIdentity(reply.token?.identityObject, { providerIndex, identityIndex, expectedIdCredPub });
      }
      if (reply?.status === 'error') {
        this._finishRequest(providerIndex, identityIndex); // a rejected request can never succeed
        throw new IdentityIssuanceError(
          `The identity provider did not issue the identity${reply.detail ? `: ${reply.detail}` : '.'}`,
          { reason: 'rejected', detail: reply.detail || undefined });
      }
      if (reply && reply.status !== 'pending') {
        throw new Error(`The identity provider answered with an unexpected status: ${JSON.stringify(reply.status)}.`);
      }

      if (Date.now() + intervalMs > deadline) {
        throw new IdentityIssuanceError(
          `The identity was not issued within ${timeoutMs} ms; the provider may still be verifying. ` +
          'Wait again with the same code_uri later.', { reason: 'timeout' });
      }
      await sleep(intervalMs, signal);
    }
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
    const content = identityObject?.value ?? identityObject;
    if (!content?.preIdentityObject || !content?.attributeList || !content?.signature) {
      throw new Error('The identity provider returned an identity in an unexpected format.');
    }
    if (content.preIdentityObject.idCredPub !== expectedIdCredPub) {
      throw new Error(
        `The issued identity does not belong to this wallet for provider ${providerIndex}, identity ${identityIndex}.`);
    }
    const label = providerIdentityLabel(providerIndex, identityIndex);
    this._identities.get(label)?.fill(0);
    this._identities.set(label, new TextEncoder().encode(JSON.stringify(identityObject)));
    this._finishRequest(providerIndex, identityIndex);
    const { createdAt, validTo, maxAccounts } = content.attributeList;
    return { providerIndex, identityIndex, createdAt, validTo, maxAccounts };
  }

  /** The request for this provider and identity index has ended (issued or rejected): it no longer awaits its identity. */
  _finishRequest(providerIndex, identityIndex) {
    const awaiting = this._requestAwaitingIdentity;
    if (awaiting?.providerIndex === providerIndex && awaiting?.identityIndex === identityIndex) this._requestAwaitingIdentity = null;
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
    const { codeUri } = this.parseIdentityCallback(callbackUrl);
    return this.waitForIdentity(codeUri, options);
  }
}
