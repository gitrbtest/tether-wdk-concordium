/**
 * Thrown when an identity provider cannot be used: it is not published on the
 * connected network, or its published data is incomplete. Carries the index.
 */
export class IdentityProviderError extends Error {
  /**
   * @param {string} message
   * @param {number} [providerIndex]
   */
  constructor(message, providerIndex) {
    super(message);
    this.name = 'IdentityProviderError';
    this.providerIndex = providerIndex;
  }
}

/**
 * Thrown when an identity is not issued: the provider reported an error,
 * rejected the verification, or the wait timed out or was cancelled.
 * `reason` says which; `code` and `detail` carry what the provider said, if anything.
 */
export class IdentityIssuanceError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'provider-error' | 'rejected' | 'timeout' | 'cancelled', code?: string, detail?: string }} info
   */
  constructor(message, { reason, code, detail } = {}) {
    super(message);
    this.name = 'IdentityIssuanceError';
    this.reason = reason;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Thrown when an identity cannot be recovered from its provider. If the provider has no such identity,
 * recovery returns null instead of throwing. `reason` says what went wrong:
 * - provider-error: the provider answered with an error, or with something that is not an identity
 *   (`status` and `detail` carry what it said)
 * - not-yours: the provider returned an identity that does not belong to this wallet's seed
 * - network: the provider could not be reached (after a few tries)
 * - node: finding accounts, the Concordium node could not be asked (`detail` has what it said)
 * - cancelled: the wallet cancelled it (its AbortSignal)
 */
export class IdentityRecoveryError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'provider-error' | 'not-yours' | 'network' | 'node' | 'cancelled', status?: number, detail?: string }} info
   */
  constructor(message, { reason, status, detail } = {}) {
    super(message);
    this.name = 'IdentityRecoveryError';
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Thrown when a proof cannot be asked for or made. `reason` says why:
 * - invalid-request: the website's request is not one the package understands (it says what is wrong)
 * - unknown-attribute: the request names an attribute an identity does not have
 * - not-held: no identity is held for that provider and identity number (verify, load or recover it first)
 * - identity-expired: the identity has expired; websites refuse its proofs (Concordium reports them as expired):
 *   the person verifies again for a new identity
 * - provider-not-accepted: the request does not accept identities from this account's provider
 * - cannot-prove: the identity's details do not satisfy the request (e.g. under the age asked for); nothing is
 *   built, so a wallet never produces a false proof
 * - node: the Concordium node could not be asked (`detail` has what it said): checking an answer (checkPresentation),
 *   or answering a version 1 question (its anchor and the network's parameters are read from the node). A refused
 *   answer is not an error: checkPresentation returns ok: false with the reasons
 * - account-only (version 1): the question accepts answers from an account only, not from the identity itself; ask
 *   the website for a version 0 question, or one that accepts the identity
 * - anchor-not-found (version 1): the question's anchor is not on chain, or not final yet (`detail`: 'absent',
 *   'received' or 'committed'); just after the website sent it, try again in a few seconds
 * - anchor-mismatch (version 1): the anchor is on chain but does not record this question (it was changed after
 *   the website recorded it, or the anchor is another transaction); do not answer
 * - anchor-failed (version 1, the website's side): recording the question on chain failed: the node refused the
 *   anchor, or it was rejected on chain (e.g. not enough CCD for the fee; `detail` says)
 */
export class ProofError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'invalid-request' | 'unknown-attribute' | 'not-held' | 'identity-expired' | 'provider-not-accepted'
   *   | 'cannot-prove' | 'node' | 'account-only' | 'anchor-not-found' | 'anchor-mismatch' | 'anchor-failed',
   *   detail?: string }} info
   */
  constructor(message, { reason, detail } = {}) {
    super(message);
    this.name = 'ProofError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Thrown when an account is not created from an identity. `reason` says why. Found before anything is sent:
 * - 'identity-expired': the identity's validTo month has passed (verify again for a new identity)
 * - 'max-accounts': the account number is not below the identity's maxAccounts
 * - 'unknown-attribute': an attribute to reveal is not one the identity holds (`detail` names it)
 * While sending and waiting:
 * - rejected: the node refused the credential, or it was finalized without creating the account (`detail` says)
 * - expired: the credential was not included on chain before its expiry time
 * - timeout: the wait ended before the account was final; it may still be created (ask again)
 * - cancelled: the wait was cancelled; if the credential was sent, the account may still be created
 * - node: the Concordium node could not be asked, or answered unexpectedly (`detail` has what it said)
 * Carries the new account's `address` and the `transactionHash` when they are known.
 */
export class AccountCreationError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'identity-expired' | 'max-accounts' | 'unknown-attribute'
   *   | 'rejected' | 'expired' | 'timeout' | 'cancelled' | 'node',
   *   address?: string, transactionHash?: string, detail?: string }} info
   */
  constructor(message, { reason, address, transactionHash, detail } = {}) {
    super(message);
    this.name = 'AccountCreationError';
    this.reason = reason;
    this.address = address;
    this.transactionHash = transactionHash;
    this.detail = detail;
  }
}

/**
 * Thrown when importIdentity cannot take an exported identity back. `reason` says why:
 * - unreadable: not an exported identity, for another network, changed or damaged, or an unknown format version
 * - not-yours: an exported identity that does not belong to this wallet's seed phrase
 */
export class IdentityStorageError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'unreadable' | 'not-yours' }} info
   */
  constructor(message, { reason } = {}) {
    super(message);
    this.name = 'IdentityStorageError';
    this.reason = reason;
  }
}
