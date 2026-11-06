/**
 * The Concordium wallet-proxy: sending a new account's credential to the chain and following it, and asking whether
 * an account exists. Internal: ConcordiumIdentity uses it. (The identity provider list is passed in by the
 * wallet: the package does not fetch it.)
 */

/** Sending a credential that creates an account, and the status of a sent transaction. */
const SUBMIT_CREDENTIAL_PATH = '/v0/submitCredential';
const SUBMISSION_STATUS_PATH = '/v0/submissionStatus/';
/** An account's balances: an empty object when the account does not exist. */
const ACCOUNT_BALANCE_PATH = '/v0/accBalance/';

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

  /**
   * @param {{ walletProxyUrl: string }} config  a parsed identity configuration
   * @param {{ fetch: typeof fetch }} options
   */
  constructor({ walletProxyUrl }, { fetch: fetchFn }) {
    this.#url = walletProxyUrl;
    this.#fetch = fetchFn;
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

  /** Whether an account exists on chain: the wallet-proxy answers `{}` for an address with no account. */
  async accountExists(address, { signal } = {}) {
    const response = await this.#fetch(this.#url + ACCOUNT_BALANCE_PATH + address, { signal });
    if (!response.ok) {
      throw new WalletProxyHttpError(`The wallet-proxy answered HTTP ${response.status} for account ${address}.`, { status: response.status });
    }
    const balances = await response.json();
    return Boolean(balances?.currentBalance ?? balances?.finalizedBalance);
  }
}
