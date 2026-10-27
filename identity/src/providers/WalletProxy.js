/**
 * The Concordium wallet-proxy: reading the identity providers and the network's cryptographic parameters,
 * and sending a new account's credential to the chain and following it. Internal: IdentityProviders and
 * ConcordiumIdentity use it.
 */

/** The provider list. v1 is the version that publishes recovery addresses. */
const IP_INFO_PATH = '/v1/ip_info';
/** The network's cryptographic parameters (the same as the node's). */
const GLOBAL_PATH = '/v0/global';
/** Sending a credential that creates an account, and the status of a sent transaction. */
const SUBMIT_CREDENTIAL_PATH = '/v0/submitCredential';
const SUBMISSION_STATUS_PATH = '/v0/submissionStatus/';

/**
 * The wallet-proxy answered with an HTTP error. `errorMessage` is its own explanation, when it gave one
 * (its error replies are `{ error: <code>, errorMessage: <text> }`).
 */
export class WalletProxyHttpError extends Error {
  constructor(message, { status, errorMessage }) {
    super(message);
    this.name = 'WalletProxyHttpError';
    this.status = status;
    this.errorMessage = errorMessage;
  }
}

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

  /**
   * Send a signed credential that creates an account (the body is built by account/submission.js).
   * @returns {Promise<string>} the submission id the wallet-proxy gives back
   * @throws {WalletProxyHttpError} if it refuses (e.g. "Credential rejected by the node")
   */
  async submitCredential(body, { signal } = {}) {
    const response = await this.#fetch(this.#url + SUBMIT_CREDENTIAL_PATH, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    if (!response.ok) {
      const reply = await response.json().catch(() => undefined);
      throw new WalletProxyHttpError(`The wallet-proxy answered HTTP ${response.status} for the account credential.`,
        { status: response.status, errorMessage: typeof reply?.errorMessage === 'string' ? reply.errorMessage : undefined });
    }
    const { submissionId } = await response.json();
    return submissionId;
  }

  /**
   * The status of a sent transaction: `{ status: 'absent' | 'received' | 'committed' | 'finalized', outcome?, rejectReason?, blockHashes? }`.
   * @param {string} transactionHash
   */
  async submissionStatus(transactionHash, { signal } = {}) {
    const response = await this.#fetch(this.#url + SUBMISSION_STATUS_PATH + transactionHash, { signal });
    if (!response.ok) {
      throw new WalletProxyHttpError(`The wallet-proxy answered HTTP ${response.status} for the transaction status.`, { status: response.status });
    }
    return response.json();
  }

  /**
   * The network's cryptographic parameters ("global context" in Concordium's SDK): public values that every
   * wallet and node on the network uses for zero-knowledge proofs, the same for everyone and fixed for the
   * network. Identity requests, ownership checks and account credentials are all built against them.
   *   genesisString          the network's name, mixed into proofs so they cannot be reused on another network
   *   onChainCommitmentKey   the key for commitments ("sealed envelopes" holding attribute values)
   *   bulletproofGenerators  public numbers for range proofs (e.g. "over 18"); about 49 KB of hex
   * Read once, then reused: they never change, and the generators are large. They match the node's.
   */
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
