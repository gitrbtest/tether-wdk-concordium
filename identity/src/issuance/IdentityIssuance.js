/**
 * Getting an identity from a provider: building the request and the link to the provider's verification
 * page, reading the provider's callback, and collecting the issued identity (checked to be this wallet's).
 * Internal: ConcordiumIdentity is the public face and hands each call on to this.
 *
 *   createRequest ─► (user verifies in the browser) ─► parseCallback ─► waitForIdentity ─► held
 */
import { IdentityIssuanceError, IdentityProviderError } from '../shared/errors.js';
import { requireIndex, requirePositive, requireRedirectUri, httpUrlOrNull } from '../shared/inputs.js';
import { buildIdentityRequest, issuanceLink, expectedIdCredPub } from './identity-request.js';
import { pollIdentityProvider, cancelledError, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_MS } from './identity-polling.js';
import { parseIdentityCallback } from './identity-callback.js';
import { identityContent, summaryOf } from './identity-object.js';

export default class IdentityIssuance {
  #providers;
  #walletProxy;
  #fetch;
  #hdWallet;
  #held;

  /**
   * The provider and identity index of the last request started here, so the wallet can hand back just
   * the callback address (see retrieveIdentity). null when no request awaits its identity.
   */
  requestAwaitingIdentity = null;

  /**
   * @param {{ providers: object, walletProxy: object, fetch: typeof fetch, hdWallet: () => object,
   *   held: import('../shared/HeldIdentities.js').default }} collaborators
   *   hdWallet: returns the key derivation for the wallet's seed (throws once the seed is disposed)
   */
  constructor({ providers, walletProxy, fetch, hdWallet, held }) {
    this.#providers = providers;
    this.#walletProxy = walletProxy;
    this.#fetch = fetch;
    this.#hdWallet = hdWallet;
    this.#held = held;
  }

  /** Forget the request awaiting its identity (when the ConcordiumIdentity is disposed). */
  dispose() {
    this.requestAwaitingIdentity = null;
  }

  // ---- Starting verification ----

  /** See ConcordiumIdentity.createIdentityRequest. */
  async createRequest({ providerIndex, identityIndex = 0, redirectUri } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    requireRedirectUri(redirectUri);

    const provider = await this.#providers.get(providerIndex);
    if (!provider.issuanceStart) {
      throw new IdentityProviderError(
        `Identity provider ${providerIndex} publishes no issuance address on this network.`, providerIndex);
    }
    const globalContext = await this.#walletProxy.globalContext();
    const idObjectRequest = buildIdentityRequest({ provider, globalContext, hdWallet: this.#hdWallet(), identityIndex });
    this.requestAwaitingIdentity = { providerIndex, identityIndex };
    return { issuanceUrl: issuanceLink(provider.issuanceStart, idObjectRequest, redirectUri), providerIndex, identityIndex };
  }

  // ---- Collecting the issued identity ----

  /** See ConcordiumIdentity.parseIdentityCallback. */
  parseCallback(callbackUrl) {
    return parseIdentityCallback(callbackUrl);
  }

  /** See ConcordiumIdentity.waitForIdentity. */
  async waitForIdentity(codeUri, options = {}) {
    const { pollUrl, providerIndex, identityIndex, timeoutMs, intervalMs, signal } = this.#checkWaitOptions(codeUri, options);
    const ownersIdCredPub = await this.expectedIdCredPub(providerIndex, identityIndex);
    const reply = await pollIdentityProvider({ fetch: this.#fetch, url: pollUrl, timeoutMs, intervalMs, signal });
    if (reply.status === 'error') {
      this.#finishRequest(providerIndex, identityIndex); // a rejected request can never succeed
      throw new IdentityIssuanceError(
        `The identity provider did not issue the identity${reply.detail ? `: ${reply.detail}` : '.'}`,
        { reason: 'rejected', detail: reply.detail || undefined });
    }
    return this.#checkAndKeep(reply.token?.identityObject, { providerIndex, identityIndex, ownersIdCredPub });
  }

  /** See ConcordiumIdentity.retrieveIdentity. */
  async retrieveIdentity(callbackUrl, options = {}) {
    let codeUri;
    try {
      ({ codeUri } = this.parseCallback(callbackUrl));
    } catch (e) {
      // The provider's error reply ends the request, as a rejection does.
      if (e instanceof IdentityIssuanceError) this.#finishRequestFor(options);
      throw e;
    }
    return this.waitForIdentity(codeUri, options);
  }

  /** The idCredPub an identity for this seed, provider and identity index must carry. */
  async expectedIdCredPub(providerIndex, identityIndex) {
    const provider = await this.#providers.get(providerIndex);
    const globalContext = await this.#walletProxy.globalContext();
    return expectedIdCredPub({ provider, globalContext, hdWallet: this.#hdWallet(), identityIndex });
  }

  /** Check waitForIdentity's inputs before any network call; resolves which identity is being collected. */
  #checkWaitOptions(codeUri, options) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS, signal } = options;
    const pollUrl = httpUrlOrNull(codeUri);
    if (!pollUrl) throw new Error('codeUri must be an absolute HTTP(S) URL.');
    const { providerIndex, identityIndex } = this.#identityToCollect(options);
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    requirePositive(timeoutMs, 'timeoutMs');
    requirePositive(intervalMs, 'intervalMs');
    if (signal?.aborted) throw cancelledError();
    return { pollUrl, providerIndex, identityIndex, timeoutMs, intervalMs, signal };
  }

  /** The provider and identity index to collect for: as given, or those of the request awaiting its identity. */
  #identityToCollect({ providerIndex, identityIndex } = {}) {
    if (providerIndex !== undefined) return { providerIndex, identityIndex: identityIndex ?? 0 };
    if (identityIndex === undefined && this.requestAwaitingIdentity) return { ...this.requestAwaitingIdentity };
    throw new Error('No identity request was started on this object: pass providerIndex '
      + '(and identityIndex, if not 0) to collect, e.g. when resuming after a restart.');
  }

  /** Check an issued identity is this wallet's, hold it, and return its summary. */
  #checkAndKeep(identityObject, { providerIndex, identityIndex, ownersIdCredPub }) {
    const content = identityContent(identityObject, 'The identity provider returned an identity in an unexpected format.');
    if (content.preIdentityObject.idCredPub !== ownersIdCredPub) {
      throw new Error(
        `The issued identity does not belong to this wallet for provider ${providerIndex}, identity ${identityIndex}.`);
    }
    this.#held.hold(providerIndex, identityIndex, identityObject);
    this.#finishRequest(providerIndex, identityIndex);
    return summaryOf(content, providerIndex, identityIndex);
  }

  /** The request for this provider and identity index has ended (issued, rejected or refused): it no longer awaits its identity. */
  #finishRequest(providerIndex, identityIndex) {
    const awaiting = this.requestAwaitingIdentity;
    if (awaiting?.providerIndex === providerIndex && awaiting?.identityIndex === identityIndex) this.requestAwaitingIdentity = null;
  }

  /** As #finishRequest, for the request a call is about: the numbers given, or else the request awaiting its identity. */
  #finishRequestFor(options) {
    let request;
    try {
      request = this.#identityToCollect(options);
    } catch {
      return; // no request to finish
    }
    this.#finishRequest(request.providerIndex, request.identityIndex);
  }
}
