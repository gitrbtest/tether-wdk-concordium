/**
 * Getting an identity back from its provider with the seed alone, e.g. on a new device (scope part D).
 * Internal: ConcordiumIdentity is the public face and hands each call on to this.
 *
 *   recover      ─► recovery request (seed's keys) ─► provider's recovery address ─► checked to be this
 *                   wallet's ─► held (ready for saveIdentity / createAccount)
 *   findAccounts ─► account 0, 1, 2 … : address from the seed ─► on chain? (wallet-proxy) ─► stop after
 *                   `gap` missing numbers in a row
 */
import { IdentityProviderError, IdentityRecoveryError } from '../shared/errors.js';
import { requireIndex } from '../shared/inputs.js';
import { identityContent, summaryOf } from '../issuance/identity-object.js';
import { recoveryRequest, recoveryLink, askProviderForIdentity, cancelledRecovery } from './identity-recovery.js';
import { accountAddressOf } from '../account/credential.js';
import { sleep } from '../shared/sleep.js';

/** findAccounts stops after this many account numbers in a row with no account (wallets number accounts 0, 1, 2 …). */
export const DEFAULT_GAP = 3;
const ATTEMPTS = 3;         // a wallet-proxy failure is tried this many times in all
const RETRY_PAUSE_MS = 500;

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

  /** See ConcordiumIdentity.findAccounts. */
  async findAccounts({ providerIndex, identityIndex = 0, gap = DEFAULT_GAP, signal } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    if (!Number.isSafeInteger(gap) || gap < 1) throw new Error('gap must be a whole number of at least 1.');
    if (signal?.aborted) throw cancelledRecovery();

    const provider = await this.#providers.get(providerIndex);
    const globalContext = await this.#walletProxy.globalContext();
    const hdWallet = this.#hdWallet();
    // An identity held here says how many accounts it allows; there is no point looking beyond that.
    const limit = this.#held.has(providerIndex, identityIndex)
      ? identityContent(this.#held.require(providerIndex, identityIndex), 'The identity held is in an unexpected format.')
        .attributeList.maxAccounts
      : Infinity;

    const found = [];
    let missingInARow = 0;
    for (let credNumber = 0; credNumber < limit && missingInARow < gap; credNumber++) {
      const address = accountAddressOf({ provider, globalContext, hdWallet, identityIndex, credNumber });
      if (await this.#exists(address, signal)) {
        found.push({ credNumber, address, path: `${providerIndex}/${identityIndex}/${credNumber}` });
        missingInARow = 0;
      } else {
        missingInARow++;
      }
    }
    return found;
  }

  /** Whether an account exists on chain. Brief wallet-proxy failures are tried again, up to ATTEMPTS times. */
  async #exists(address, signal) {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw cancelledRecovery();
      try {
        return await this.#walletProxy.accountExists(address, { signal });
      } catch (e) {
        if (signal?.aborted) throw cancelledRecovery();
        if (attempt >= ATTEMPTS) {
          throw new IdentityRecoveryError(`The wallet-proxy could not say whether account ${address} exists: ${e.message}`,
            { reason: 'wallet-proxy', detail: e.message });
        }
        await sleep(RETRY_PAUSE_MS, signal, cancelledRecovery);
      }
    }
  }
}
