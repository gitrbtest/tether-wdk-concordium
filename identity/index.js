/**
 * @concordium/wdk-identity-concordium
 * -------------------------------------------------------------------
 * Entry point. Identity companion for @concordium/wdk-wallet-concordium:
 * identity verification with an identity provider, encrypted identity
 * storage, and account creation from a wallet seed.
 *
 * The package is in development; its public API is added here as each
 * capability lands.
 */

export { CONCORDIUM_MAINNET_IDENTITY_CONFIG, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from './src/shared/config.js';
export { default as IdentityProviders } from './src/providers/IdentityProviders.js';
export { IdentityProviderError, IdentityIssuanceError, IdentityStorageError, AccountCreationError } from './src/shared/errors.js';
export { default as ConcordiumIdentity } from './src/ConcordiumIdentity.js';
export { default as MemoryIdentityStore } from './src/storage/MemoryIdentityStore.js';
