import { IdentityProviderError } from '../shared/errors.js';
import { readProviderList } from './provider-list.js';
import { providerKind } from './provider-kind.js';

/**
 * An address a provider publishes for itself, read exactly as published and
 * never constructed. Providers publish these in the entry-level `metadata`;
 * the ipInfo-level `metadata` is accepted too. `null` when not published.
 */
function published(entry, key) {
  return entry?.metadata?.[key] || entry?.ipInfo?.metadata?.[key] || null; // '' counts as not published
}

function summary(entry) {
  return {
    index: entry.ipInfo?.ipIdentity,
    name: entry.ipInfo?.ipDescription?.name,
    display: published(entry, 'display'),          // the provider's display name, e.g. 'Global FinReg (Business ID)'
    kind: providerKind(entry),                      // 'person', or 'company' for a Business ID provider
    issuanceStart: published(entry, 'issuanceStart'),
    recoveryStart: published(entry, 'recoveryStart'),
  };
}

/**
 * The identity providers in the list the wallet passes in (the wallet-proxy's /v2/ip_info, or /v1/ip_info, shape; see
 * provider-list.js). The package does not fetch the list. /v2/ip_info includes the company (Business ID) providers;
 * /v1/ip_info leaves them out. Providers are identified by their index (`ipIdentity`),
 * an identifier assigned per network, never by their position in the list.
 */
export default class IdentityProviders {
  #entries;

  /**
   * @param {object[]} identityProviders  the identity provider list, e.g. the wallet-proxy's /v2/ip_info
   * @throws {Error} If the list is missing, empty, or not in that shape (the message names the field).
   */
  constructor(identityProviders) {
    this.#entries = readProviderList(identityProviders);
  }

  _entries() {
    return this.#entries;
  }

  /**
   * Every identity provider in the list, with the addresses each one publishes for issuing and recovering
   * identities, its display name, and whether it issues identities of people or of companies (Business ID; see
   * provider-kind.js).
   * @returns {Promise<Array<{index: number, name: string, display: string | null, kind: 'person' | 'company',
   *   issuanceStart: string | null, recoveryStart: string | null}>>}
   */
  async list() {
    return (await this._entries()).map(summary);
  }

  /**
   * One identity provider by its index, with the keys (`ipInfo`) and anonymity
   * revokers (`arsInfos`) an identity request is built from.
   * @param {number} index  the provider's index on this network
   * @throws {IdentityProviderError} If no provider with this index is in the list.
   */
  async get(index) {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error('providerIndex is required and must be a non-negative safe integer.');
    }
    const entry = (await this._entries()).find((e) => e.ipInfo?.ipIdentity === index);
    if (!entry) {
      throw new IdentityProviderError(`No identity provider ${index} is in the identity provider list.`, index);
    }
    return withDetails(entry);
  }

  /** Every provider with its details (as get gives for one). Internal: recoverAll works through them. */
  async _allWithDetails() {
    return (await this._entries()).map(withDetails);
  }
}

/** A provider's summary plus the keys (ipInfo) and anonymity revokers (arsInfos) requests are built from. */
function withDetails(entry) {
  return { ...summary(entry), ipInfo: entry.ipInfo, arsInfos: entry.arsInfos };
}
