# Changelog

User-facing changes to `@concordium/wdk-identity-concordium` are recorded here.

## [Unreleased]

### Added

- Package scaffold: entry point, type declarations, unit-test setup and CI validation.
- Configuration presets `CONCORDIUM_MAINNET_IDENTITY_CONFIG` and `CONCORDIUM_TESTNET_IDENTITY_CONFIG` (`useMainnetKeyDerivation`, `walletProxyUrl`).
- `IdentityProviders`: list the identity providers a wallet-proxy publishes, and get one by its index, with issuance and recovery addresses exactly as published. `IdentityProviderError` for unpublished providers.
- `ConcordiumIdentity`: start identity verification with `createIdentityRequest`, which builds the identity request from the wallet seed and returns the link to the provider's verification page. `dispose()` zeroes the seed.
