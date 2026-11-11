import { IdentityProviderError } from '../shared/errors.js';
import { readProviderList } from './provider-list.js';
import { providerKind } from './provider-kind.js';
import { compareWithChain } from './check-against-chain.js';

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
 *
 * Checked against the chain (when a node is given, as ConcordiumIdentity always does): each provider's keys, and its
 * anonymity revokers' keys, must match the chain's own record (see check-against-chain.js). The first use reads that
 * record from the node once; a provider that does not match is refused by get, left out of list, and reported by
 * recoverAll. Without a node (`new IdentityProviders(list)` on its own, e.g. to show the list), nothing is checked.
 */
export default class IdentityProviders {
  #entries;
  #node;
  #verdicts; // provider number → null (matches the chain) or why not; worked out once

  /**
   * @param {object[]} identityProviders  the identity provider list, e.g. the wallet-proxy's /v2/ip_info
   * @param {{ node?: { providerRecord: () => Promise<object> } }} [options]  the chain to check the list against
   *   (internal: ConcordiumIdentity passes its ChainNode)
   * @throws {Error} If the list is missing, empty, or not in that shape (the message names the field).
   */
  constructor(identityProviders, { node } = {}) {
    this.#entries = readProviderList(identityProviders);
    this.#node = node;
  }

  /** Why a provider does not match the chain (null if it does, or if there is no node to check with). */
  async _mismatch(index) {
    if (!this.#node) return null;
    if (!this.#verdicts) this.#verdicts = compareWithChain(this.#entries, await this.#node.providerRecord());
    return this.#verdicts.get(index) ?? null;
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
    const entries = [];
    for (const entry of this._entries()) {
      if (!(await this._mismatch(entry.ipInfo.ipIdentity))) entries.push(entry); // a provider not matching the chain is left out
    }
    return entries.map(summary);
  }

  /**
   * One identity provider by its index, with the keys (`ipInfo`) and anonymity
   * revokers (`arsInfos`) an identity request is built from.
   * @param {number} index  the provider's index on this network
   * @throws {IdentityProviderError} If no provider with this index is in the list, or its keys (or its anonymity
   *   revokers' keys) do not match the chain's record.
   */
  async get(index) {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error('providerIndex is required and must be a non-negative safe integer.');
    }
    const entry = (await this._entries()).find((e) => e.ipInfo?.ipIdentity === index);
    if (!entry) {
      throw new IdentityProviderError(`No identity provider ${index} is in the identity provider list.`, index);
    }
    const mismatch = await this._mismatch(index);
    if (mismatch) throw mismatchError(index, mismatch);
    return withDetails(entry);
  }

  /**
   * Every provider with its details (as get gives for one), and `mismatch`: why it does not match the chain, or null.
   * Internal: recoverAll works through them, and reports a provider that does not match.
   */
  async _allWithDetails() {
    const all = [];
    for (const entry of this._entries()) all.push({ ...withDetails(entry), mismatch: await this._mismatch(entry.ipInfo.ipIdentity) });
    return all;
  }
}

/** The error for a provider whose keys in the list do not match the chain. */
export function mismatchError(index, why) {
  return new IdentityProviderError(`Identity provider ${index} is refused: ${why}. The identity provider list may be `
    + 'tampered with or out of date: fetch it again from a source you trust.', index);
}

/** A provider's summary plus the keys (ipInfo) and anonymity revokers (arsInfos) requests are built from. */
function withDetails(entry) {
  return { ...summary(entry), ipInfo: entry.ipInfo, arsInfos: entry.arsInfos };
}
