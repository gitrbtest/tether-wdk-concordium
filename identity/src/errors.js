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
