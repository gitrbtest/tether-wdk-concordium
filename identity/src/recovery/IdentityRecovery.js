/**
 * Getting an identity back from its provider with the seed alone, e.g. on a new device (scope part D).
 * Internal: ConcordiumIdentity is the public face and hands each call on to this.
 *
 *   recover      ─► recovery request (seed's keys) ─► provider's recovery address ─► checked to be this
 *                   wallet's ─► held (ready for exportIdentity / createAccount)
 *   findAccounts ─► account 0, 1, 2 … : address from the seed ─► on chain? (node) ─► stop after
 *                   `gap` missing numbers in a row
 *   recoverAll   ─► for each provider: identity 0, 1, 2 … (recover, then findAccounts) until
 *                   `identityGap` missing numbers in a row; a provider that fails is noted, not fatal
 */
import { IdentityProviderError, IdentityRecoveryError } from '../shared/errors.js';
import { requireIndex, IDENTITY_INDEX_HINT, MAX_CRED_NUMBER } from '../shared/inputs.js';
import { identityContent, summaryOf } from '../issuance/identity-object.js';
import { recoveryRequest, recoveryLink, askProviderForIdentity, cancelledRecovery } from './identity-recovery.js';
import { accountAddressOf } from '../account/credential.js';
import { mismatchError } from '../providers/IdentityProviders.js';
import { sleep } from '../shared/sleep.js';

/** findAccounts stops after this many account numbers in a row with no account (wallets number accounts 0, 1, 2 …). */
export const DEFAULT_GAP = 3;
const ATTEMPTS = 3;         // a node failure is tried this many times in all
const RETRY_PAUSE_MS = 500;

/** The provider, checked to publish a recovery address (else IdentityProviderError). */
function requireRecoveryAddress(provider) {
  if (!provider.recoveryStart) {
    throw new IdentityProviderError(
      `Identity provider ${provider.index} publishes no recovery address on this network.`, provider.index);
  }
  return provider;
}

export default class IdentityRecovery {
  #providers;
  #node;
  #fetch;
  #hdWallet;
  #held;

  /**
   * @param {{ providers: object, node: object, fetch: typeof fetch, hdWallet: () => object,
   *   held: import('../shared/HeldIdentities.js').default }} collaborators
   *   hdWallet: returns the key derivation for the wallet's seed (throws once the seed is disposed)
   */
  constructor({ providers, node, fetch, hdWallet, held }) {
    this.#providers = providers;
    this.#node = node;
    this.#fetch = fetch;
    this.#hdWallet = hdWallet;
    this.#held = held;
  }

  /** See ConcordiumIdentity.recoverIdentity. */
  async recover({ providerIndex, identityIndex, signal } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex', IDENTITY_INDEX_HINT);
    if (signal?.aborted) throw cancelledRecovery();

    return this.#recoverFrom(await this.#recoverableProvider(providerIndex), identityIndex, signal);
  }

  /** A provider by its number, checked to publish a recovery address. */
  async #recoverableProvider(providerIndex) {
    return requireRecoveryAddress(await this.#providers.get(providerIndex));
  }

  /** recover, for a provider already looked up (recoverAll takes it from the list it downloaded once). */
  async #recoverFrom(provider, identityIndex, signal) {
    const found = await this.#askFor(provider, identityIndex, signal);
    if (found === null) return null;
    this.#held.hold(provider.index, identityIndex, found.identityObject);
    return summaryOf(found.content, provider.index, identityIndex);
  }

  /**
   * Ask the provider whether it issued this wallet's identity `identityIndex`; null if not. The identity is checked to
   * be this wallet's, but not kept (recover keeps it; nextIdentityIndex only needs to know it exists).
   */
  async #askFor(provider, identityIndex, signal) {
    const providerIndex = provider.index;
    const globalContext = await this.#node.globalContext();
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
    return { identityObject, content };
  }

  /**
   * See ConcordiumIdentity.nextIdentityIndex: the number after the highest identity this wallet has with the provider
   * (asking for 0, 1, 2 … until `gap` numbers in a row have none), or 0 if it has none. Nothing is kept.
   */
  async nextIdentityIndex({ providerIndex, gap = DEFAULT_GAP, signal } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    if (!Number.isSafeInteger(gap) || gap < 1) throw new Error('gap must be a whole number of at least 1.');
    if (signal?.aborted) throw cancelledRecovery();
    const provider = await this.#recoverableProvider(providerIndex);
    let next = 0;
    let missingInARow = 0;
    for (let identityIndex = 0; missingInARow < gap; identityIndex++) {
      if (await this.#askFor(provider, identityIndex, signal) === null) {
        missingInARow++;
      } else {
        next = identityIndex + 1;
        missingInARow = 0;
      }
    }
    return next;
  }

  /**
   * See ConcordiumIdentity.nextCredNumber: the number after the highest account the identity has on chain (as
   * findAccounts finds them), or 0 if it has none.
   */
  async nextCredNumber({ providerIndex, identityIndex, gap = DEFAULT_GAP, signal } = {}) {
    const accounts = await this.findAccounts({ providerIndex, identityIndex, gap, signal });
    return accounts.length ? accounts[accounts.length - 1].credNumber + 1 : 0;
  }

  /** See ConcordiumIdentity.recoverAll. */
  async recoverAll({ providerIndexes, identityGap = DEFAULT_GAP, accountGap = DEFAULT_GAP, signal } = {}) {
    if (!Number.isSafeInteger(identityGap) || identityGap < 1) throw new Error('identityGap must be a whole number of at least 1.');
    if (!Number.isSafeInteger(accountGap) || accountGap < 1) throw new Error('accountGap must be a whole number of at least 1.');
    if (providerIndexes !== undefined) {
      if (!Array.isArray(providerIndexes)) throw new Error('providerIndexes must be a list of provider numbers.');
      providerIndexes.forEach((index) => requireIndex(index, 'providerIndexes entry'));
    }
    if (signal?.aborted) throw cancelledRecovery();

    // Download the provider list ONCE for this whole call, and take each provider's details from it.
    // (Nothing is kept after the call: the next recoverAll downloads a fresh list.)
    const published = await this.#providers._allWithDetails();
    // Which providers to ask: the ones given, or every provider that publishes a recovery address.
    const toAsk = providerIndexes ?? published.filter((p) => p.recoveryStart).map((p) => p.index);

    const identities = [];
    const problems = [];
    for (const providerIndex of toAsk) {
      let provider;
      try {
        const found = published.find((p) => p.index === providerIndex);
        if (!found) throw new IdentityProviderError(`No identity provider ${providerIndex} is published on this network.`, providerIndex);
        if (found.mismatch) throw mismatchError(providerIndex, found.mismatch); // its keys do not match the chain
        provider = requireRecoveryAddress(found);
      } catch (error) {
        problems.push({ providerIndex, identityIndex: null, error }); // e.g. not published, no recovery address, not matching the chain
        continue;
      }
      // Identity 0, 1, 2 … with this provider, until `identityGap` numbers in a row have none.
      let missingInARow = 0;
      for (let identityIndex = 0; missingInARow < identityGap; identityIndex++) {
        let summary;
        try {
          summary = await this.#recoverFrom(provider, identityIndex, signal);
        } catch (error) {
          if (error instanceof IdentityRecoveryError && error.reason === 'cancelled') throw error;
          // This provider cannot be asked now (down, refusing, not published …): note it and move on, so
          // the identities found with the other providers are not lost.
          problems.push({ providerIndex, identityIndex, error });
          break;
        }
        if (summary === null) {
          missingInARow++;
          continue;
        }
        missingInARow = 0;
        try {
          const accounts = await this.#findAccountsFrom(provider, identityIndex, accountGap, signal);
          identities.push({ providerIndex, identityIndex, summary, accounts });
        } catch (error) {
          if (error instanceof IdentityRecoveryError && error.reason === 'cancelled') throw error;
          // The identity is back (and held), but its accounts could not be looked up now.
          identities.push({ providerIndex, identityIndex, summary, accounts: null });
          problems.push({ providerIndex, identityIndex, error });
        }
      }
    }
    return { identities, problems };
  }

  /** See ConcordiumIdentity.findAccounts. */
  async findAccounts({ providerIndex, identityIndex, gap = DEFAULT_GAP, signal } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex', IDENTITY_INDEX_HINT);
    if (!Number.isSafeInteger(gap) || gap < 1) throw new Error('gap must be a whole number of at least 1.');
    if (signal?.aborted) throw cancelledRecovery();

    return this.#findAccountsFrom(await this.#providers.get(providerIndex), identityIndex, gap, signal);
  }

  /** findAccounts, for a provider already looked up. */
  async #findAccountsFrom(provider, identityIndex, gap, signal) {
    const providerIndex = provider.index;
    const globalContext = await this.#node.globalContext();
    const hdWallet = this.#hdWallet();
    // An identity held here says how many accounts it allows; there is no point looking beyond that. Never beyond
    // account number 255 either: the largest Concordium supports (past it, the SDK reduces the number to another's).
    const limit = Math.min(MAX_CRED_NUMBER + 1, this.#held.has(providerIndex, identityIndex)
      ? identityContent(this.#held.require(providerIndex, identityIndex), 'The identity held is in an unexpected format.')
        .attributeList.maxAccounts
      : Infinity);

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

  /** Whether an account exists on chain. Brief node failures are tried again, up to ATTEMPTS times. */
  async #exists(address, signal) {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw cancelledRecovery();
      try {
        return await this.#node.accountExists(address);
      } catch (e) {
        if (signal?.aborted) throw cancelledRecovery();
        if (attempt >= ATTEMPTS) {
          throw new IdentityRecoveryError(`The node could not say whether account ${address} exists: ${e.message}`,
            { reason: 'node', detail: e.message });
        }
        await sleep(RETRY_PAUSE_MS, signal, cancelledRecovery);
      }
    }
  }
}
