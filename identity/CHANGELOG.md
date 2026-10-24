# Changelog

User-facing changes to `@concordium/wdk-identity-concordium` are recorded here.

## [Unreleased]

### Added

- Package scaffold: entry point, type declarations, unit-test setup and CI validation.
- Configuration presets `CONCORDIUM_MAINNET_IDENTITY_CONFIG` and `CONCORDIUM_TESTNET_IDENTITY_CONFIG` (`useMainnetKeyDerivation`, `walletProxyUrl`).
- `IdentityProviders`: list the identity providers a wallet-proxy publishes, and get one by its index, with issuance and recovery addresses exactly as published. `IdentityProviderError` for unpublished providers.
- `ConcordiumIdentity`: start identity verification with `createIdentityRequest`, which builds the identity request from the wallet seed and returns the link to the provider's verification page. `dispose()` zeroes the seed.
- `ConcordiumIdentity`: collect the issued identity with `retrieveIdentity`, which reads the provider's reply from the callback address and polls until the identity is issued or refused; after `createIdentityRequest` on the same object, the callback address is all it needs. `parseIdentityCallback` and `waitForIdentity` do the same in two steps, to resume after an app restart. The identity is checked to belong to the wallet's seed and kept inside the object; only a summary is returned, and `dispose()` zeroes it too.
- `IdentityIssuanceError`, with `reason` `'provider-error'`, `'rejected'`, `'timeout'` or `'cancelled'`, and the provider's `detail` (and `code`, if given).
- Optional built-in callback listener for Node.js desktop and server wallets, from the separate entry point for Node.js extras `@concordium/wdk-identity-concordium/node`: `listenForIdentityCallback` receives the provider's return on 127.0.0.1 at a random secret path, with a timeout and cancellation.
