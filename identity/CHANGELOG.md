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
- Example `examples/verify-identity.mjs` (`npm run example:verify-identity`): identity verification end to end on testnet, saving the identity encrypted; `OPEN_BROWSER=1` opens the verification page.
- Encrypted identity storage: `ConcordiumIdentity` takes a `store` and gains `saveIdentity`, `loadIdentity` (no network call) and `deleteIdentity`. The store only receives encrypted bytes and slot names; the key is derived from the seed (HKDF-SHA256), never stored, and wiped after use; AES-256-GCM, bound to the slot. Saving never silently replaces a different saved identity (`{ replace: true }` to do so). Format documented in `docs/storage-format.md`.
- `IdentityStorageError`, with `reason` `'unreadable-slot'` or `'slot-in-use'`.
- Stores: `MemoryIdentityStore` (main entry); `FileIdentityStore` (from `/node`): one file per slot, safe writes, owner-only permissions where supported. Any object with `save`, `read` and `delete` works as a store (`IdentityStore` type).
- `verifyIdentityStore`, from the testing entry point `@concordium/wdk-identity-concordium/testing`: checks a store against the contract, in any test framework.
- Examples `load-identity` (load a saved identity in a new program) and `database-store` (a store on SQLite, built into Node.js 22.13+).

### Changed

- The main entry no longer uses Node.js-only features, so it is meant to run outside Node.js too; a test keeps it that way.
- The network's cryptographic parameters are read once per `ConcordiumIdentity` instead of for every request.
