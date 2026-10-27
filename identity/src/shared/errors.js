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
 * Thrown when an account is not created from an identity. `reason` says why:
 * - rejected: the chain refused the credential (`detail` has the reason, if the chain gave one)
 * - expired: the credential was not included on chain before its expiry time
 * - timeout: the wait ended before the account was final; it may still be created (ask again)
 * - cancelled: the wait was cancelled; if the credential was sent, the account may still be created
 * - wallet-proxy: the wallet-proxy failed or answered unexpectedly (`detail` has what it said)
 * Carries the new account's `address` and the `transactionHash` when they are known.
 */
export class AccountCreationError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'rejected' | 'expired' | 'timeout' | 'cancelled' | 'wallet-proxy',
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
 * Thrown when a saved identity cannot be used or saved: the bytes in a storage slot cannot be
 * decrypted with this wallet's seed, are not identity data, or use an unknown format version
 * (reason 'unreadable-slot'); or a different identity is already saved where saveIdentity was asked
 * to save (reason 'slot-in-use'). Carries the slot name.
 */
export class IdentityStorageError extends Error {
  /**
   * @param {string} message
   * @param {{ reason: 'unreadable-slot' | 'slot-in-use', slotName?: string }} info
   */
  constructor(message, { reason, slotName } = {}) {
    super(message);
    this.name = 'IdentityStorageError';
    this.reason = reason;
    this.slotName = slotName;
  }
}
