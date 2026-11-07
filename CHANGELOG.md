# Changelog

User-facing changes to `@concordium/wdk-wallet-concordium` are recorded here.

## [Unreleased]

### Added

- Package changelog, included in the npm distribution.
- Token rules for regulated tokens: `getTokenRules(token)` reads a protocol-level token's rules as the chain holds them (paused, allow list, deny list, mintable, burnable, its governance account, name, decimals, supply, metadata URL), and `getTokenAccountStatus(token, address?)` an account's standing with it (on chain, balance, on the allow list, on the deny list), so a wallet can tell before offering a transfer whether it can happen. A CIS-2 token has no standard rules: they read as null. An unknown PLT is reported with WDK's `InvalidTokenError`. Types `TokenRules`, `TokenAccountStatus`. Tests offline over recorded testnet tokens (`test/fixtures/plt.testnet.json`, `capture-plt.mjs`) and live, read-only, on testnet.

## [0.1.0] - 2026-10-16

### Added

- Initial Concordium wallet module for Tether WDK, with TypeScript declarations and Node.js 18+ support.
- Explicit account paths (`provider/identity/credentialCounter`) with on-chain credential verification before returning an account.
- Mainnet and testnet connection presets, custom gRPC URLs, and an explicit key-derivation mode.
- CCD, PLT, and CIS-2 balances, transfers, and transaction-specific fee quotes.
- Message signing and verification, native transaction receipts, and CIS-2 metadata lookup.
- Sponsored PLT transfers with sender-first or sponsor-first signing.
- Account recovery for a single identity using node credential-ID lookup.
