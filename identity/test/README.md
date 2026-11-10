# The identity package's tests

The tests are grouped by the steps of the story, in order: set up, find a provider, verify an identity, keep it,
create accounts, get everything back on a new phone, prove facts, and the demo. Each test file starts with what it
tests and, where several parties take part (a wallet, a shop, a provider, the chain), a "who is who" list and a
numbered diagram; each test says which steps it covers.

```bash
npm test                          # unit tests: offline, no network
npm run test:integration          # live tests on testnet: read-only
WRITE=1 npm run test:integration  # also those that write to testnet (an account, an anchored question): see each file
```

## Unit tests (`unit/`): offline

The network is replaced by data recorded from testnet and mainnet once (`fixtures/`, see `fixtures/capture.mjs`), and
the chain by a pretend node (`helpers.mjs`).

| Folder | File | What it tests |
| --- | --- | --- |
| `1-setup` | `package` | the package itself: its entry point, published files, and alignment with the wallet package |
| | `config` | the configuration: key derivation, the provider list, the node connection |
| | `types` | the published type declarations accept Concordium's real node clients |
| | `number-ranges` | provider, identity and account numbers within Concordium's ranges |
| | `seed-and-keys` | the seed phrase and the keys worked out from it |
| | `dispose` | wiping the seed and the identities held |
| | `node-connection` | the wallet's node connection: parameters, account lookups, sending, following a transaction |
| `2-providers` | `provider-list` | the identity providers, from the list the wallet passes in; company (Business ID) providers |
| | `recorded-provider-data` | the recorded provider lists and parameters have the shape the package reads |
| | `provider-check-script` | `npm run check:providers`: how each kind of provider answer is reported |
| `3-verify-identity` | `identity-request` | building the identity request a provider verifies |
| | `polling-and-link` | waiting for the provider, and the link a person opens |
| | `callback` | reading the provider's reply from the return address |
| | `callback-listener` | the built-in listener (Node.js desktop apps) |
| | `collecting-the-identity` | collecting the issued identity, and checking it is this seed's |
| `4-keep-identity` | `export-and-import` | the identity as text the wallet keeps (encrypted, or plain), and taking it back |
| | `storage-format-spec` | `docs/storage-format.md` is exact: a reader written from the document alone |
| `5-accounts` | `credential` | building and signing the credential that creates an account |
| | `sending-to-the-chain` | sending it to the node, and every way that can end |
| | `account-creation` | creating an account from the identity: the checks first, "already exists", the result |
| `6-recovery` | `recovery` | a new phone: the identities back from the providers, their accounts from the chain |
| `7-proofs` | `questions` | a website's question: building it, reading it, the consent wording (both versions) |
| | `wallet-proves-from-account` | the wallet answers from an account (version 0) |
| | `wallet-proves-from-identity` | the wallet answers from the identity itself, after checking the anchor (version 1) |
| | `website-checks-account-proof` | the website checks a version 0 answer |
| | `website-asks-and-checks-v1` | the website asks a version 1 question (anchored, optionally sponsored) and checks the answer |
| | `compatibility-with-concordium-apps` | Concordium's own example shops' questions, answered and accepted |
| `8-demo` | `demo-wallet` | the demo wallet's local server and its steps |

## Live tests (`integration/`): on testnet

| Folder | File | What it tests |
| --- | --- | --- |
| `2-providers` | `provider-accepts-request` | Concordium's testnet provider and Global FinReg (Business ID) accept our requests |
| | `company-identity-samples` | the company (Business ID) samples: the providers, the company page opening, company questions |
| `5-accounts` | `create-real-account` | **WRITE=1**: a real account created through the node |
| `3-verify-identity` | `resume-after-restart-sample` | the resume sample, part 2: a fresh start collects the identity from the saved reply |
| `4-keep-identity` | `server-keeps-identities-sample` | the server sample: one record per user, readable only with that user's seed phrase |
| `6-recovery` | `recover-identity` | the recorded identity comes back from the testnet provider |
| `7-proofs` | `website-checks-account-proof` | a version 0 answer checked against the chain |
| | `compatibility-with-concordium-apps` | Concordium's reward shop's question, answered and accepted on chain |
| | `v1-round-trip` | a version 1 question recorded on chain once, answered and checked (**WRITE=1**: a fresh one) |
| | `age-check-sample` | the age-check sample, run as a person would |
| | `age-check-v1-sample` | **WRITE=1**: the version 1 age-check sample |
| `9-errors` | `handle-errors-sample` | the errors sample: every error with its name and reason, refused before anything is sent |
