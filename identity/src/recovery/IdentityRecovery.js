/**
 * Getting an identity back from its provider with the seed alone, e.g. on a new device (scope part D).
 * Internal: ConcordiumIdentity is the public face and hands each call on to this.
 *
 *   recover ─► recovery request (seed's keys) ─► provider's recovery address ─► checked to be this
 *              wallet's ─► held (ready for saveIdentity / createAccount)
 */
import { IdentityProviderError, IdentityRecoveryError } from '../shared/errors.js';
import { requireIndex } from '../shared/inputs.js';
import { identityContent, summaryOf } from '../issuance/identity-object.js';
import { recoveryRequest, recoveryLink, askProviderForIdentity, cancelledRecovery } from './identity-recovery.js';

export default class IdentityRecovery {
  #providers;
  #walletProxy;
  #fetch;
  #hdWallet;
  #held;

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

  /** See ConcordiumIdentity.recoverIdentity. */
  async recover({ providerIndex, identityIndex = 0, signal } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    if (signal?.aborted) throw cancelledRecovery();

    const provider = await this.#providers.get(providerIndex);
    if (!provider.recoveryStart) {
      throw new IdentityProviderError(
        `Identity provider ${providerIndex} publishes no recovery address on this network.`, providerIndex);
    }
    const globalContext = await this.#walletProxy.globalContext();
    const request = recoveryRequest({ provider, globalContext, hdWallet: this.#hdWallet(), identityIndex });
    const identityObject = await askProviderForIdentity({
      fetch: this.#fetch, url: recoveryLink(provider.recoveryStart, request), signal,
    });
    if (identityObject === null) return null;

    // The provider found the identity by the request's public key (idCredPub); it must carry that same key,
    // or it is not this wallet's identity and is never kept.
    const content = identityContent(identityObject, 'The identity provider returned an identity in an unexpected format.');
    if (content.preIdentityObject.idCredPub !== request.value.idCredPub) {
      throw new IdentityRecoveryError(
        `The identity provider returned an identity that does not belong to this wallet for provider ${providerIndex}, `
        + `identity ${identityIndex}.`, { reason: 'not-yours' });
    }
    this.#held.hold(providerIndex, identityIndex, identityObject);
    return summaryOf(content, providerIndex, identityIndex);
  }
}
