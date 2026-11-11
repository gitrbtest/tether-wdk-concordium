/**
 * @concordium/wdk-identity-concordium
 * -------------------------------------------------------------------
 * Entry point. Identity companion for @concordium/wdk-wallet-concordium:
 * identity verification with an identity provider, the identity exported as
 * text for the wallet to keep (NOT encrypted: keep it in secure storage, like
 * the seed phrase), account creation and recovery from a wallet seed, and
 * proofs to websites.
 *
 * The package is in development; its public API is added here as each
 * capability lands.
 */

export { CONCORDIUM_MAINNET_IDENTITY_CONFIG, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from './src/shared/config.js';
export { default as IdentityProviders } from './src/providers/IdentityProviders.js';
export { IdentityProviderError, IdentityIssuanceError, IdentityRecoveryError, IdentityStorageError, AccountCreationError, ProofError } from './src/shared/errors.js';
export { default as ConcordiumIdentity } from './src/ConcordiumIdentity.js';
export { describeProofRequest, describeProofContext } from './src/proofs/proof-request.js';
