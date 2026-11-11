# Changelog

User-facing changes to `@concordium/wdk-wallet-concordium` are recorded here.

## [Unreleased]

### Added

- Package changelog, included in the npm distribution.
- Token rules for regulated tokens: `getTokenRules(token)` reads a protocol-level token's rules as the chain holds them (paused, allow list, deny list, mintable, burnable, its governance account, name, decimals, supply, metadata URL), and `getTokenAccountStatus(token, address?)` an account's standing with it (on chain, balance, on the allow list, on the deny list), so a wallet can tell before offering a transfer whether it can happen. A CIS-2 token has no standard rules: they read as null. An unknown PLT is reported with WDK's `InvalidTokenError`. Types `TokenRules`, `TokenAccountStatus`. Tests offline over recorded testnet tokens (`test/fixtures/plt.testnet.json`, `capture-plt.mjs`) and live, read-only, on testnet.
- `checkTransfer({ token, recipient, amount, sponsorAddress? })`: checks a token transfer before sending it and lists **every** reason it would be refused (`{ ok, reasons, fee }`), with nothing sent and no fee spent: the amount, a paused token, this account and the recipient on chain, the token balance, the allow list and the deny list for both sides, and whether the account that pays the fee (this one, or the sponsor) holds enough CCD. For a CIS-2 token (no standard rules) it checks the accounts and the balance, and dry-runs the transfer to see whether the contract would refuse it. Reasons are `ConcordiumTransferErrorReason` values (WDK's `TransferErrorReason` plus `INVALID_AMOUNT`, `TOKEN_PAUSED`, `SENDER_NOT_FOUND`, `RECIPIENT_NOT_FOUND`, `SPONSOR_NOT_FOUND`, `SENDER_NOT_ON_ALLOW_LIST`, `RECIPIENT_NOT_ON_ALLOW_LIST`, `SENDER_ON_DENY_LIST`, `RECIPIENT_ON_DENY_LIST`, `CONTRACT_REFUSED`), each with a plain message. Types `CheckTransferOptions`, `TransferCheck`. It applies the same token rules as the SDK's `plt.Token.validateTransfer` (which stops at the first problem); a test checks the two agree on every combination of paused, token balance, allow list and deny list.
- `ConcordiumTransferError` (extends WDK's `TransferError`): token transfers that cannot happen, or that the chain refused, say why in `checkTransfer`'s reasons: `reason` (the first), `reasons` (every problem, each with its message and account), and, when the chain refused a sent transfer, its `hash` and `rejectReason`. The chain's refusals are put in the same reasons: `tokenBalanceInsufficient`, `addressNotFound`, and `operationNotPermitted` (explained from the token's rules as they are now: paused, or the named account on the deny list or not on the allow list; otherwise `OPERATION_NOT_PERMITTED` with the chain's words); a CIS-2 contract's refusal is `CONTRACT_REFUSED`; anything else is `REJECTED`. New reasons `OPERATION_NOT_PERMITTED` and `REJECTED`.
- `getTransaction(hash)` returns WDK's standard receipt, so WDK's own `waitForTransaction` works for Concordium: `finality` `'pending'` (received, or in a block not yet final) or `'final'`, with `success` (false if rejected), `fee` (for a sponsored transaction, what the sponsor paid), `block` (the height) and Concordium's `blockHash`. An unknown hash throws WDK's `NoSuchElementError`, a node that cannot be asked `ProviderError` (which `waitForTransaction` retries). Concordium has no `'dropped'`: a transaction that never lands stops being known, and `waitForTransaction` ends with `TimeoutError`. `defaultWaitInterval` is 2 seconds (a Concordium block). Type `ConcordiumTransactionReceipt`.
- Example `example-regulated-token` (`npm run example:regulated-token`), read-only on testnet: a regulated token's rules (UPEU: an allow list and a deny list), this account's and the recipient's standing with it, a transfer checked and refused with every reason, a token without lists that can go, the blocked transfer tried anyway and refused before sending (no fee), and a transaction's status as WDK's receipt. Its live test reads what it prints.
- README: "Regulated tokens" and "Transaction status" sections (the rules, `checkTransfer`, the transfer errors and every reason, WDK's receipt and how Concordium's states map onto it).

### Changed

- `getTransaction` no longer throws `NotImplementedError` (see Added). `getTransactionReceipt` (the node's own status) is kept.
- `transfer` and `buildSponsorableTransfer` check the transfer first, as `checkTransfer` does, and throw `ConcordiumTransferError` with every reason, before anything is sent or built (no fee is charged, also not to a sponsor). Changes in the moment between the check and sending (the SDK's own check refusing it) are reported the same way.
- `transfer` and `submitSponsored`: a transfer the chain refuses now throws `ConcordiumTransferError` (with `hash` and `rejectReason`) instead of `TransactionRejectedError`.
- `sendTransaction` (native CCD): too little CCD for the amount and the fee throws WDK's `TransactionError` with reason `INSUFFICIENT_BALANCE`, before sending (for a `{ to, value }` request), and when the chain refuses it for that (`AmountTooLarge`; then with `hash`).

### Fixed

- `dispose()` now zeroes and drops the seed; previously it remained readable through `manager.seed`. Requesting an account afterwards throws `DisposalError`.
- Reading `account.keyPair` after disposal no longer throws; it returns the public key with `privateKey: null`.
- `getAccountByPath` refuses numbers outside Concordium's ranges (an account number above 255; a provider or identity number above 2147483647), and `recoverAccountsForIdentity` refuses a `startIndex` or `maxIndex` above 255. Previously such a path was accepted, and Concordium's SDK silently reduced the number: `0/0/9999` gave account `0/0/15`'s address, with a signing key that is not that account's.
- Raw seed bytes that are not 64 bytes long are refused at construction with a `ValueError` that does not contain the seed; previously the first account request failed with an error from Concordium's SDK that repeated the whole seed.

## [0.1.0] - 2026-10-16

### Added

- Initial Concordium wallet module for Tether WDK, with TypeScript declarations and Node.js 18+ support.
- Explicit account paths (`provider/identity/credentialCounter`) with on-chain credential verification before returning an account.
- Mainnet and testnet connection presets, custom gRPC URLs, and an explicit key-derivation mode.
- CCD, PLT, and CIS-2 balances, transfers, and transaction-specific fee quotes.
- Message signing and verification, native transaction receipts, and CIS-2 metadata lookup.
- Sponsored PLT transfers with sender-first or sponsor-first signing.
- Account recovery for a single identity using node credential-ID lookup.
