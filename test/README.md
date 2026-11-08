# The wallet package's tests

The tests are grouped by what a wallet does, in order: set up, accounts, tokens, transactions. Each test file starts
with what it tests; files where several parties take part (a wallet, a token's issuer, a sponsor, the chain) have a
"who is who" list and a numbered diagram, and each test says which steps it covers.

```bash
npm test                          # unit tests: offline, no network
npm run test:integration          # live tests on testnet: read-only (needs the TESTNET_ settings)
WRITE=1 npm run test:integration  # also those that send real (testnet) transfers and spend fees
```

## Unit tests (`unit/`): offline

The node is replaced by a fake (`helpers.mjs`), or, for tokens, by a pretend chain replaying recorded testnet tokens
and accounts (`token-chain.mjs`, over `fixtures/plt.testnet.json`, recorded by `fixtures/capture-plt.mjs`).

| Folder | File | What it tests |
| --- | --- | --- |
| `1-setup` | `config` | the configuration and its presets |
| | `key-derivation` | explicit account paths, and the keys and addresses worked out from the seed |
| | `identity-coordinates-required` | recovery and onboarding need the identity's numbers given (no defaults) |
| | `wdk-base-compatibility` | the module fits WDK's base package (its methods, its receipt and wait loop) |
| | `errors` | the module's errors |
| `2-accounts` | `account-lookup` | an account by its path, checked on chain |
| | `account-recovery` | an identity's accounts, found again from the seed |
| | `ccd-balance-reads` | CCD balances, and a missing account reported as such |
| `3-tokens` | `token-names` | how a token is named: a PLT ("UPEU") or a CIS-2 token ("cis2:…") |
| | `token-rules` | a token's rules (paused, allow list, deny list) and an account's standing with it |
| | `check-transfer` | every reason a transfer would be refused, before sending; agreement with the SDK's own check |
| | `transfer-errors` | transfers that cannot happen, or that the chain refuses, say why |
| `4-transactions` | `transaction-status` | a transaction's status as WDK's standard receipt, and WDK's wait loop |

## Live tests (`integration/`): on testnet

| Folder | File | What it tests |
| --- | --- | --- |
| `2-accounts` | `reads` | the address, the CCD balance, token balances |
| | `account-recovery` | an identity's accounts found on chain |
| `3-tokens` | `quotes` | fee quotes |
| | `transfers` | **WRITE=1**: CCD, PLT and CIS-2 transfers |
| | `sponsored` | sponsored transfers (signing in both orders; **WRITE=1**: sent) |
| | `token-rules` | a regulated token's rules, a transfer checked and refused before sending |
| | `regulated-token-sample` | the regulated-token sample, run as a person would |
| `4-transactions` | `transaction-status` | real testnet transactions as WDK receipts |
