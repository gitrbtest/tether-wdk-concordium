/**
 * Reading public data from a Concordium wallet-proxy: the identity providers and the network's
 * cryptographic parameters. Internal: IdentityProviders and ConcordiumIdentity use it.
 */

/** The provider list. v1 is the version that publishes recovery addresses. */
const IP_INFO_PATH = '/v1/ip_info';
/** The network's cryptographic parameters (the same as the node's). */
const GLOBAL_PATH = '/v0/global';

export default class WalletProxy {
  #url;
  #fetch;
  #globalContext; // fetched once: the parameters do not change

  /**
   * @param {{ walletProxyUrl: string }} config  a parsed identity configuration
   * @param {{ fetch: typeof fetch }} options
   */
  constructor({ walletProxyUrl }, { fetch: fetchFn }) {
    this.#url = walletProxyUrl;
    this.#fetch = fetchFn;
  }

  async #getJson(path, what) {
    const response = await this.#fetch(this.#url + path);
    if (!response.ok) throw new Error(`The wallet-proxy answered HTTP ${response.status} for ${what}.`);
    return response.json();
  }

  /** The raw provider entries (each with ipInfo, arsInfos and metadata). Read fresh every time. */
  async providerEntries() {
    const list = await this.#getJson(IP_INFO_PATH, 'the identity provider list');
    if (!Array.isArray(list)) {
      throw new Error('The wallet-proxy returned an identity provider list in an unexpected format.');
    }
    return list;
  }

  /** The network's cryptographic parameters. Read once, then reused. */
  async globalContext() {
    if (!this.#globalContext) {
      const { value } = await this.#getJson(GLOBAL_PATH, 'the cryptographic parameters');
      if (!value?.onChainCommitmentKey || !value?.bulletproofGenerators || !value?.genesisString) {
        throw new Error('The wallet-proxy returned cryptographic parameters in an unexpected format.');
      }
      this.#globalContext = value;
    }
    return this.#globalContext;
  }
}
