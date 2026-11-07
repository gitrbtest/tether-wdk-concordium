# Changelog

User-facing changes to `@concordium/wdk-wallet-concordium` are recorded here.

## [Unreleased]

### Added

- Package changelog, included in the npm distribution.
- Token rules for regulated tokens: `getTokenRules(token)` reads a protocol-level token's rules as the chain holds them (paused, allow list, deny list, mintable, burnable, its governance account, name, decimals, supply, metadata URL), and `getTokenAccountStatus(token, address?)` an account's standing with it (on chain, balance, on the allow list, on the deny list), so a wallet can tell before offering a transfer whether it can happen. A CIS-2 token has no standard rules: they read as null. An unknown PLT is reported with WDK's `InvalidTokenError`. Types `TokenRules`, `TokenAccountStatus`. Tests offline over recorded testnet tokens (`test/fixtures/plt.testnet.json`, `capture-plt.mjs`) and live, read-only, on testnet.
- `checkTransfer({ token, recipient, amount, sponsorAddress? })`: checks a token transfer before sending it and lists **every** reason it would be refused (`{ ok, reasons, fee }`), with nothing sent and no fee spent: the amount, a paused token, this account and the recipient on chain, the token balance, the allow list and the deny list for both sides, and whether the account that pays the fee (this one, or the sponsor) holds enough CCD. For a CIS-2 token (no standard rules) it checks the accounts and the balance, and dry-runs the transfer to see whether the contract would refuse it. Reasons are `ConcordiumTransferErrorReason` values (WDK's `TransferErrorReason` plus `INVALID_AMOUNT`, `TOKEN_PAUSED`, `SENDER_NOT_FOUND`, `RECIPIENT_NOT_FOUND`, `SPONSOR_NOT_FOUND`, `SENDER_NOT_ON_ALLOW_LIST`, `RECIPIENT_NOT_ON_ALLOW_LIST`, `SENDER_ON_DENY_LIST`, `RECIPIENT_ON_DENY_LIST`, `CONTRACT_REFUSED`), each with a plain message. Types `CheckTransferOptions`, `TransferCheck`. It applies the same token rules as the SDK's `plt.Token.validateTransfer` (which stops at the first problem); a test checks the two agree on every combination of paused, token balance, allow list and deny list.

## [0.1.0] - 2026-10-16

### Added

- Initial Concordium wallet module for Tether WDK, with TypeScript declarations and Node.js 18+ support.
- Explicit account paths (`provider/identity/credentialCounter`) with on-chain credential verification before returning an account.
- Mainnet and testnet connection presets, custom gRPC URLs, and an explicit key-derivation mode.
- CCD, PLT, and CIS-2 balances, transfers, and transaction-specific fee quotes.
- Message signing and verification, native transaction receipts, and CIS-2 metadata lookup.
- Sponsored PLT transfers with sender-first or sponsor-first signing.
- Account recovery for a single identity using node credential-ID lookup.
