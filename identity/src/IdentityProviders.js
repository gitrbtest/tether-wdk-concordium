import { parseIdentityConfig } from './config.js';
import { IdentityProviderError } from './errors.js';
import WalletProxy from './WalletProxy.js';

/**
 * An address a provider publishes for itself, read exactly as published and
 * never constructed. Providers publish these in the entry-level `metadata`;
 * the ipInfo-level `metadata` is accepted too. `null` when not published.
 */
function published(entry, key) {
  return entry?.metadata?.[key] ?? entry?.ipInfo?.metadata?.[key] ?? null;
}

function summary(entry) {
  return {
    index: entry.ipInfo?.ipIdentity,
    name: entry.ipInfo?.ipDescription?.name,
    issuanceStart: published(entry, 'issuanceStart'),
    recoveryStart: published(entry, 'recoveryStart'),
  };
}

/**
 * The identity providers published by a Concordium wallet-proxy. Providers are
 * identified by their index (`ipIdentity`), an identifier assigned per network,
 * never by their position in the list.
 */
export default class IdentityProviders {
  /**
   * @param {{ walletProxyUrl: string }} config  e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG
   * @param {{ fetch?: typeof fetch }} [options]  HTTP implementation (defaults to the global fetch)
   */
  constructor(config, { fetch: fetchFn = (url, options) => fetch(url, options) } = {}) {
    this._walletProxy = new WalletProxy(parseIdentityConfig(config), { fetch: fetchFn });
  }

  _entries() {
    return this._walletProxy.providerEntries();
  }

  /**
   * Every identity provider published on this network, with the addresses each
   * one publishes for issuing and recovering identities.
   * @returns {Promise<Array<{index: number, name: string, issuanceStart: string | null, recoveryStart: string | null}>>}
   */
  async list() {
    return (await this._entries()).map(summary);
  }

  /**
   * One identity provider by its index, with the keys (`ipInfo`) and anonymity
   * revokers (`arsInfos`) an identity request is built from.
   * @param {number} index  the provider's index on this network
   * @throws {IdentityProviderError} If no provider with this index is published.
   */
  async get(index) {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error('providerIndex is required and must be a non-negative safe integer.');
    }
    const entry = (await this._entries()).find((e) => e.ipInfo?.ipIdentity === index);
    if (!entry) {
      throw new IdentityProviderError(`No identity provider ${index} is published on this network.`, index);
    }
    return { ...summary(entry), ipInfo: entry.ipInfo, arsInfos: entry.arsInfos };
  }
}
