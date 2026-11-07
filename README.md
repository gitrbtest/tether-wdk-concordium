# @concordium/wdk-wallet-concordium

A [Tether Wallet Development Kit (WDK)](https://github.com/tetherto/wdk) module for Concordium.
Derive account keys, read balances, sign messages, transfer CCD and tokens, and recover existing accounts from a seed through the WDK interface.

> **Beta:** This package is currently in beta.
> Test thoroughly in development environments before using it in production.

## Features

- Seed-based account key derivation using `ConcordiumHdWallet`.
- Native CCD balances, transfers, and fee quotes.
- Protocol-level token (PLT) and CIS-2 token balances, transfers, and fee quotes.
- Regulated tokens: a token's rules (paused, allow list, deny list) and an account's standing with it, a check of a
  transfer before sending it (every reason it would be refused), and transfer errors that say why.
- Transaction status as WDK's standard receipt, so WDK's `waitForTransaction` works.
- Sponsored PLT transactions with separate sender and sponsor signing.
- Message signing and verification.
- Account recovery through node credential-ID lookup.
- TypeScript declarations.

## Requirements

- **Node.js 18+**, using ES modules. Bare/mobile is not supported.
- Access to a Concordium gRPC node endpoint.
- An existing on-chain account to retrieve an account by path, read balances, or transfer funds.
  Deriving keys does not create an account; see [Account creation](#account-creation).
- Sufficient CCD to pay transaction fees, or a funded sponsor for sponsored transfers.

## Installation

```bash
npm install @concordium/wdk-wallet-concordium@beta
```

For use through WDK, also install the host package:

```bash
npm install @tetherto/wdk
```

## Quick start

The snippets use a public demonstration mnemonic. **Never use it to secure funds.**
In real applications, load your own seed securely; never commit or log it.
The demonstration seed does not guarantee an existing on-chain account.

### With WDK

```js
import WDK from '@tetherto/wdk'
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium'

// Public demonstration seed only. Never use for real funds.
const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const wdk = new WDK(seed)
  .registerWallet('concordium', WalletManagerConcordium, {
    ...CONCORDIUM_TESTNET_CONFIG,
  })

const account = await wdk.getAccountByPath('concordium', '0/0/0')
console.log(await account.getAddress())
console.log(await account.getBalance(), 'microCCD')
```

### Standalone

```js
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium'

// Public demonstration seed only. Never use for real funds.
const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const manager = new WalletManagerConcordium(seed, {
  ...CONCORDIUM_TESTNET_CONFIG,
})

try {
  const account = await manager.getAccountByPath('0/0/0')
  console.log(await account.getAddress())
  console.log(await account.getBalance(), 'microCCD')
} finally {
  manager.dispose()
}
```

The constructor accepts a BIP-39 mnemonic or raw seed bytes (`Uint8Array`).
The seed, key-derivation mode, identity-provider index, identity index, and credential counter must match the account you intend to access.
Account retrieval fetches the network's cryptographic parameters and verifies
the derived credential through the node. The public demonstration seed/path may
not have an on-chain account; in that case, `getAccountByPath` rejects.

## Configuration

| Field | Required | Description |
| --- | --- | --- |
| `useMainnetKeyDerivation` | Yes | Boolean: `true` selects the SDK's Mainnet keys; `false` selects Testnet-compatible keys, including for other chains using that derivation scheme. |
| `grpcUrl` | Yes | Absolute HTTP(S) URL for the gRPC node. HTTPS enables TLS; HTTP disables it. Ports default to 443/80 when omitted. |

`useMainnetKeyDerivation` controls keys only: it does not choose endpoints or
verify the chain served by them. The same seed and coordinates produce different
keys under the two derivation modes. There are no implicit endpoint defaults.

`grpcUrl` selects a native gRPC connection, not a REST API. It cannot contain
credentials, query parameters, fragments, or a path other than `/`. Configuration
is validated locally without connecting to the node. The old `network` and
`endpoint` fields are rejected.

### Public presets and custom endpoints

`CONCORDIUM_MAINNET_CONFIG` and `CONCORDIUM_TESTNET_CONFIG` are exported constants
containing the derivation flag and public service URLs:

| Preset | `useMainnetKeyDerivation` | `grpcUrl` |
| --- | --- | --- |
| `CONCORDIUM_MAINNET_CONFIG` | `true` | `https://grpc.mainnet.concordium.software:20000` |
| `CONCORDIUM_TESTNET_CONFIG` | `false` | `https://grpc.testnet.concordium.com:20000` |

Spread a preset to customize it rather than modifying the shared export:

```js
import { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium'

const config = {
  ...CONCORDIUM_TESTNET_CONFIG,
  grpcUrl: 'http://localhost:20000',
}
```

For a custom configuration, provide `useMainnetKeyDerivation` and `grpcUrl`
directly, without a preset. For production deployments, choose service
endpoints appropriate to your availability and privacy requirements.

### Account paths

Concordium key derivation uses three coordinates: `providerIndex / identityIndex / credentialNumber`.

- `providerIndex`: The network-specific index of the identify provider.
- `identityIndex`: The personal identify issuance index.
- `credentialNumber`: The credential identifier for the issued identity.

Use `manager.getAccountByPath('0/0/3')` or `wdk.getAccountByPath('concordium', '0/0/3')` to select all three coordinates.
Replace the example path with the coordinates associated with your account.

Paths must contain three non-negative safe integers, without leading zeros.
Each `getAccountByPath` call performs a fresh credential-ID lookup at the node's
default last-finalized block. It returns an account only if the credential exists,
using the address returned by the node. Chain cryptographic parameters are cached;
account-info lookups are not. Connectivity is required; there is no offline bypass.

A missing credential raises `AccountNotCreatedError` with `error.path` set and
`error.address` undefined. Connection failures and other node errors propagate
unchanged. No account instance is registered on failure. Credential membership
does not prove that a single derived key satisfies the account's signing threshold.

## Usage

The following snippets assume an initialized `manager` and `account` as above.
Transaction-submission calls spend funds; use a funded testnet account when trying them.

### Transfer CCD

Amounts and fees are in **microCCD**: `1 CCD = 1_000_000 microCCD`. Prefer `bigint`
for amounts to avoid JavaScript number precision loss.

```js
const request = { to: recipientAddress, value: 1_000_000n }
const { fee: estimatedFee } = await account.quoteSendTransaction(request)

// Signs, submits, and waits for finalization.
const { hash, fee } = await account.sendTransaction(request)
```

Use `signTransaction(request)` to sign without broadcasting. Its result can be
passed to `sendTransaction(signedTransaction)` later. Quotes do not submit transactions.

### Work with tokens

Token identifiers distinguish PLTs from CIS-2 smart-contract tokens:

| Format | Meaning |
| --- | --- |
| `'TOKEN'` or `'plt:TOKEN'` | PLT symbol on the selected network. |
| `'cis2:<index>:<subindex>:<tokenIdHex>'` | CIS-2 contract address and hexadecimal token ID. |
| `'cis2:1234:0:'` | CIS-2 token with an empty token ID. |

Amounts are integers in the token's base units, not display units. Replace the
identifiers below with tokens available on your network.

```js
const token = 'plt:TOKEN'
const balance = await account.getTokenBalance(token)
const transfer = { token, recipient: recipientAddress, amount: 1n }
const quote = await account.quoteTransfer(transfer)
const result = await account.transfer(transfer) // Submits a transaction.

const { url, metadata } = await account.getCis2Metadata('cis2:1234:0:01')
if (metadata) console.log(metadata.name, metadata.symbol, metadata.decimals)
```

`getCis2Metadata` returns `metadata: null` if the off-chain metadata document
cannot be retrieved. `manager.listTokens()` lists PLT identifiers from the node.

### Regulated tokens

Some PLTs restrict who may hold or move them: an **allow list** (only accounts on it may send or receive), a
**deny list** (accounts on it may not), and a **pause** (no transfers at all). The token's issuer manages these
rules through its governance account; a wallet reads them, so it can tell the user before offering a transfer,
rather than after it fails.

```js
const rules = await account.getTokenRules('UPEU')
// → { kind: 'plt', token: 'UPEU', name: 'Upwood Test Euro', paused: false, allowList: true, denyList: true,
//     governanceAccount: '4fWT…', decimals: 6, … }
const standing = await account.getTokenAccountStatus('UPEU', recipientAddress)  // default: this account
// → { exists: true, balance: 0n, onAllowList: false, onDenyList: false }       (null: the token keeps no such list)

const check = await account.checkTransfer({ token: 'UPEU', recipient: recipientAddress, amount: 1000000n })
// → { ok: false, fee: 4661487n, reasons: [
//      { reason: 'INSUFFICIENT_TOKEN_BALANCE', message: 'This account holds 0 UPEU; 1 is needed.', account: '3GEm…' },
//      { reason: 'SENDER_NOT_ON_ALLOW_LIST', message: "This account is not on UPEU's allow list.", account: '3GEm…' } ] }
```

`checkTransfer` sends nothing and charges nothing. It lists **every** reason the transfer would be refused: the
amount, a paused token, this account and the recipient (on chain? on the deny list? not on the allow list?), this
account's balance, and whether the account that pays the fee (this one, or `sponsorAddress` for a sponsored transfer)
holds enough CCD. It applies the same rules as the SDK's `plt.Token.validateTransfer`, which stops at the first
problem (a test checks the two agree). A CIS-2 token has no standard rules (its rules read as `null`): for it,
`checkTransfer` checks the accounts and the balance, and dry-runs the transfer to see whether the token's contract
would refuse it.

`transfer` and `buildSponsorableTransfer` run the same check first, so a transfer that cannot happen is never sent:

```js
import { ConcordiumTransferError } from '@concordium/wdk-wallet-concordium'

try {
  await account.transfer({ token: 'UPEU', recipient: recipientAddress, amount: 1000000n })
} catch (e) {
  if (e instanceof ConcordiumTransferError) {     // WDK's TransferError, with Concordium's reasons
    e.reason    // the first problem, e.g. 'RECIPIENT_NOT_ON_ALLOW_LIST'
    e.reasons   // every problem: { reason, message, account }
    e.hash      // null: nothing was sent. Set only if the chain refused it after all (then the fee was charged)
  }
}
```

The rules can change between the check and the transfer (the issuer pauses the token, or changes a list): the SDK's
own last check, or the chain, then refuses it, and the error says why in the same reasons. When the chain says only
that the token "does not permit" it, the reason is worked out from the token's rules as they are then; if they no
longer say why, it is `OPERATION_NOT_PERMITTED`, with the chain's own words.

| `reason` (`ConcordiumTransferErrorReason`) | Meaning |
| --- | --- |
| `INSUFFICIENT_BALANCE` | the account that pays the fee (this one, or the sponsor) holds too little CCD (WDK's own) |
| `INSUFFICIENT_TOKEN_BALANCE` | this account holds too little of the token (WDK's own) |
| `INVALID_AMOUNT` | the amount is not a whole number of base units above 0 |
| `TOKEN_PAUSED` | the token is paused: no transfers until its issuer resumes it |
| `SENDER_NOT_FOUND`, `RECIPIENT_NOT_FOUND`, `SPONSOR_NOT_FOUND` | no account at that address |
| `SENDER_NOT_ON_ALLOW_LIST`, `RECIPIENT_NOT_ON_ALLOW_LIST` | the token keeps an allow list, and the account is not on it |
| `SENDER_ON_DENY_LIST`, `RECIPIENT_ON_DENY_LIST` | the account is on the token's deny list |
| `CONTRACT_REFUSED` | a CIS-2 token's contract refuses it (its own rules; the standard CIS-2 refusals are put in words) |
| `OPERATION_NOT_PERMITTED` | only after sending: the token refused it, and its rules now do not say why |
| `REJECTED` | only after sending: the chain refused it for another reason (`rejectReason` has it) |

Native CCD transfers (`sendTransaction`) with too little CCD for the amount and the fee throw WDK's
`TransactionError` with reason `INSUFFICIENT_BALANCE`, before sending.

### Transaction status

`getTransaction(hash)` returns WDK's standard receipt, the same for every chain, so WDK's own `waitForTransaction`
works:

```js
const receipt = await account.waitForTransaction(hash)        // asks every 2 seconds, for up to 60 seconds
// → { hash, finality: 'final', success: true, fee: 3792510n, block: 50504314, blockHash: 'ae8a…' }
```

| The node says | `finality` | Also |
| --- | --- | --- |
| received; or committed (in a block, not final yet) | `'pending'` | |
| finalized | `'final'` | `success` (false if rejected; the fee is still charged), `fee` (for a sponsored transaction, what the sponsor paid), `block` (its height), `blockHash` |
| not known | throws WDK's `NoSuchElementError` | `waitForTransaction` keeps asking |
| cannot be asked | throws WDK's `ProviderError` | `waitForTransaction` tries again, up to 3 times in a row |

Concordium blocks are final within seconds, so WDK's `'confirmed'` (reversible only in extreme conditions) is not
used: a committed transaction stays `'pending'` until it is final. Concordium also has no `'dropped'`: a transaction
that never reaches a block (it expired) stops being known, and `waitForTransaction` ends with WDK's `TimeoutError`.
`getTransactionReceipt(hash)` still returns the node's own status.

### Sign and verify messages

```js
const message = 'Hello, Concordium'
const signature = await account.sign(message)
const valid = await account.verify(message, signature)
```

Verification reads the account's public keys from the node. Signatures are
JSON-encoded strings.

### Recover accounts for an identity

Recover accounts under a single known identity using only the gRPC node:

```js
const accounts = await manager.recoverAccountsForIdentity({
  providerIndex: 0,
  identityIndex: 0,
  startIndex: 0,
  gapLimit: 3,
  maxIndex: 50,
})

for (const account of accounts) {
  console.log(account.path, await account.getAddress())
  console.log(await account.getBalance(), 'microCCD')
}
```

The method requires explicit non-negative safe integer `providerIndex` and
`identityIndex`. It derives credential registration IDs using the seed and the
node's cryptographic parameters, then looks up each credential through the node.
It does not recover identities or create on-chain accounts.

Results are `WalletAccountConcordium` instances with known addresses, tracked for
manager disposal. Each recovered path has its own instance, even when multiple
paths refer to the same address. Credential membership does not guarantee that
one derived key is sufficient to authorize transactions on that account.

Scanning stops after `gapLimit` consecutive missing credentials (default `3`) or
at the inclusive `maxIndex` (default `50`). Gaps and caps can omit accounts. Only
an explicit node `NOT_FOUND` response counts as a miss. Other errors reject the
operation without returning partial results or registering recovered instances.

### Sponsored PLT transfers

A sponsor pays the CCD fee while the sender transfers PLTs. Both parties sign
the same transaction; either party can sign first. This API does not provide a
sponsor service or choose a sponsor for you.

```js
// sender and sponsor are WalletAccountConcordium instances.
const unsigned = await sender.buildSponsorableTransfer({
  token: 'plt:TOKEN',
  recipient: recipientAddress,
  amount: 1n,
  sponsorAddress: await sponsor.getAddress(),
})

// Sender signs first, then sponsor completes the transaction.
const senderSigned = await sender.signAsAccountToBeSponsored(unsigned)
const complete = await sponsor.signAsSponsorSigned(senderSigned)
const { hash, fee } = await sender.submitSponsored(complete)
```

For sponsor-first signing, use `sponsor.signAsSponsorToBeSigned(unsigned)` followed
by `sender.signAsAccountPreSponsored(sponsorSigned)`. Treat the returned transaction
JSON as opaque. Sponsored transfers support PLTs, not CIS-2 tokens.

## Account creation

Concordium accounts require an identity and an on-chain credential deployment.
This package works with existing accounts; deriving keys does not create an
account. Integrate production onboarding at the host-application layer, then use
the account's derivation path and account recovery API to locate the resulting account.

## API and limitations

See [`types/index.d.ts`](types/index.d.ts) for request, result, and option types.

| API | Notes |
| --- | --- |
| `account.getBalanceForAddress(address)` | Reads any account's CCD balance without deriving its keys. |
| `account.getTransactionReceipt(hash)` | Returns the native node status, or `null` when unavailable. WDK's `getTransaction` is preferred. |
| `account.getTokenRules(token)` / `getTokenAccountStatus(token, address?)` | A token's rules, and an account's standing with it. See [Regulated tokens](#regulated-tokens). |
| `account.checkTransfer(transfer)` | Every reason a token transfer would be refused, with nothing sent. |
| `account.getTransaction(hash)` / `waitForTransaction(hash)` | WDK's standard receipt. See [Transaction status](#transaction-status). |
| `account.keyPair` | Exposes public and private key bytes; treat the private key as secret. |
| `manager.dispose()` | Disposes tracked accounts and clears the manager's seed. |
| `getAccount()` | Unsupported; use `getAccountByPath()` with all three identity coordinates. |
| `getFeeRates()` | Unsupported; use the transaction-specific quote methods. |
| Named signers | Unsupported; use seed-based accounts. |
| `toReadOnlyAccount()` | Returns the same account instance, **not** a signing-isolated view. |

`getAccountByPath()` throws `AccountNotCreatedError` when the credential is not
on-chain. Address-based balance reads also use this error for a missing account,
with `error.address` set.

Token transfers (`transfer`, `buildSponsorableTransfer`, `submitSponsored`) that
cannot happen throw `ConcordiumTransferError`, which extends WDK's `TransferError`:
`reason` is the first problem (a `ConcordiumTransferErrorReason` value, e.g.
`TOKEN_PAUSED` or `RECIPIENT_NOT_ON_ALLOW_LIST`) and `reasons` lists every
problem found. They are checked first, as `checkTransfer` checks them, so nothing
is sent; if the chain refuses a transfer after all (a rule changed in the moment
between), the error has the transaction's `hash` and the chain's `rejectReason`,
and the fee was still charged. Native CCD transfers (`sendTransaction`) with too
little CCD throw WDK's `TransactionError` with reason `INSUFFICIENT_BALANCE`. Other
transactions that finalize rejected throw `TransactionRejectedError`, with its
`hash` and `rejectReason`; a rejected transaction can still incur a fee.

## Security

- Keep seeds and private keys out of source control, logs, errors, and telemetry.
- Never send real funds to the public test mnemonic used in repository fixtures.
- Do not expose `keyPair` or a `toReadOnlyAccount()` result to untrusted code.
- Call `dispose()` when finished. Disposal releases key references; it is not a
  guarantee that every JavaScript or WebAssembly memory copy has been erased.
- Review recipients, token identifiers, amounts, and the selected network before signing.

## Examples

Examples are in [`examples/`](examples/). From a repository checkout:

```bash
npm ci
npm run example            # Address and CCD balance
npm run example:verify     # Message signing and verification
npm run example:send       # CCD transfer
npm run example:token      # Token balances, quotes, and transfers
npm run example:sponsored  # Sponsored transfers
npm run example:regulated-token  # A regulated token: its rules, a blocked transfer, a receipt (read-only)
```

Inspect each script's configuration before running it. Transfer examples submit
transactions; they are not read-only demonstrations (the regulated-token example is: it sends nothing).
Examples are not included in the npm package.

## Development and testing

```bash
npm ci
npm test
npx tsc --noEmit types/index.d.ts
```

Unit tests use local derivation and mocked services. CI runs them on pull
requests and pushes to `main`, including a run without external networking.

Live integration tests require environment-supplied testnet credentials:

| Variable | Purpose |
| --- | --- |
| `TESTNET_SEED` | Required mnemonic for the test account. |
| `TESTNET_ADDRESS` | Required address corresponding to credential counter `0`. |
| `TESTNET_PROVIDER_INDEX` | Provider index; defaults to fixture value `0`. |
| `TESTNET_IDENTITY_INDEX` | Identity index; defaults to fixture value `899424164`. |
| `PLT_TOKEN` | Held PLT identifier; defaults to `TN`. |
| `CIS2_TOKEN` | Held CIS-2 identifier; defaults to `cis2:12754:0:01`. |
| `WALLET_PROXY` | Optional endpoint override used only by internal test utilities for transaction-status checks. |

Configure these securely in your shell, then run:

```bash
npm run test:integration           # Reads, quotes, and signing; no submission
WRITE=1 npm run test:integration   # Also submits transactions and spends testnet funds
```

Write tests cover transfers, sponsored submission, and rejection handling, with
fee comparisons for PLT and CIS-2 transfers. They require a funded account holding
the configured tokens. Live integration tests are not run in CI.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and unreleased changes.

## Support

Report bugs and request help through
[GitHub issues](https://github.com/Concordium/tether-wdk-concordium/issues).

## License

[Apache-2.0](LICENSE).
