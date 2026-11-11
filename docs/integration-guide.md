# Integration guide: Concordium identities in a WDK wallet

This guide takes a wallet developer from nothing to a wallet that verifies its users' identities, keeps them, creates
their Concordium accounts, gets everything back on a new phone, proves facts about its users to websites, handles
regulated tokens, and does the same for companies. It follows one path, in the order a wallet meets each step. Each
chapter says what happens, shows the code, and says what your wallet must do itself; the packages' READMEs and the
runnable samples have the details.

Everything here runs on Concordium's **testnet** (its test network, with test money). Read
[chapter 11](#11-going-to-mainnet) before using it on mainnet (the real network).

**Contents:** [1. Before you start](#1-before-you-start) · [2. Set up](#2-set-up) ·
[3. Verify an identity](#3-verify-an-identity) · [4. Keep it](#4-keep-it) ·
[5. Create accounts](#5-create-accounts) · [6. A new phone](#6-a-new-phone) · [7. Prove facts](#7-prove-facts) ·
[8. Regulated tokens](#8-regulated-tokens) · [9. Companies](#9-companies-business-id) ·
[10. Errors](#10-errors-in-one-place) · [11. Going to mainnet](#11-going-to-mainnet)

---

## 1. Before you start

### Terms

| Term | Meaning |
| --- | --- |
| **WDK** | Tether's Wallet Development Kit: a set of packages for building wallets, with one module per blockchain |
| **seed phrase** | the user's 12 or 24 secret words; every key the wallet uses is worked out from them |
| **identity provider** | a company that checks a person's documents (or a company's) and issues a Concordium identity |
| **identity** | what a provider issues: the person's verified details, kept by the wallet, never put on chain |
| **account** | an address on Concordium holding CCD and tokens; created from an identity |
| **node** | a computer on the Concordium network; the wallet reads from and sends to the chain through one |
| **wallet-proxy** | a Concordium web service; here it is only where the list of identity providers is fetched from |
| **CCD** | Concordium's coin; amounts are in **microCCD** (a millionth of a CCD) |
| **PLT**, **CIS-2** | tokens: a PLT is built into Concordium itself (named like `UPEU`); a CIS-2 token is run by a smart contract (named `cis2:<contract>:<subindex>:<token id>`) |
| **base units** | token amounts as whole numbers: a token with 6 decimals counts 1 token as `1000000` |
| **path** | the three numbers that name an account: provider / identity / account, e.g. `0/2/0` |
| **final** | a transaction the chain has settled for good (a few seconds on Concordium) |
| **WalletConnect** | a widely used messaging service, not Concordium's, that links a website to a wallet app (usually on a phone) after the user scans a QR code; websites send questions and requests to the wallet through it (chapter 7) |

### Two packages, one seed phrase

| Package | What it does | Where |
| --- | --- | --- |
| `@concordium/wdk-wallet-concordium` | The WDK module for Concordium: accounts by path, CCD and token balances and transfers, fees, sponsored transfers, token rules, transaction status | the repository root ([README](../README.md)) |
| `@concordium/wdk-identity-concordium` | Identities: verifying with a provider, keeping the identity, creating accounts from it, recovery, proofs | [`identity/`](../identity/) ([README](../identity/README.md)) |

Both use the **same seed phrase**. The wallet package works out the account keys from it, the identity package the
identity keys, and both name an account by the same path.

**Why Concordium needs an identity first.** On most blockchains a key is an account. On Concordium, an account exists
only once a verified identity stands behind it: the user verifies once with an identity provider, the wallet keeps the
identity, and every account is created from it. An account shows nothing about the person unless they choose to.

```
seed phrase ──► identity keys ──► verify with a provider ──► the identity (kept by the wallet)
            └─► account keys  ──────────────────────────────► accounts created from the identity ──► CCD, tokens
```

### What your wallet provides

- the **seed phrase**, from wherever your wallet already keeps it safely;
- **secure storage** for each identity, as for the seed phrase: the package gives it to you as plain text (**not
  encrypted**: it holds the person's details) and stores nothing itself;
- a **connection to a Concordium node**: the packages never open one themselves;
- the **list of identity providers**, fetched once: the package never fetches it;
- a **return address**: where the provider's web page sends the user back to, and a way to catch them there.

## 2. Set up

### Install

You need Node.js 18 or later (or a browser or phone runtime: see below), with ES modules (`import`).

```bash
npm install @concordium/wdk-wallet-concordium @concordium/wdk-identity-concordium @concordium/web-sdk
npm install @tetherto/wdk    # only if your wallet runs several chains through WDK (most WDK wallets already have it)
```

`@concordium/web-sdk` is Concordium's own library; you need it for the node connection below.

**Until the identity package is published on npm, install it from a checkout of this repository:
`npm install ./identity`.**

The identity package's main part uses nothing that only works in Node.js, so it is meant for browsers and phones
too (so far it is tested on Node.js). Its optional desktop helper (chapter 3) comes from
`@concordium/wdk-identity-concordium/node`.

On a phone with React Native, plug in Concordium's native cryptography (`{ cryptography }`): the SDK's own is far too
slow there. See [Phones: plugging in faster cryptography](../identity/README.md#phones-plugging-in-faster-cryptography);
the React Native example shows it working.

### Create the two objects

**Use the same network setting in both packages.** Each package has a setting, `useMainnetKeyDerivation`, that picks
which keys the seed phrase gives: `false` for testnet keys, `true` for mainnet keys. The same seed phrase gives
different keys, and so different accounts, on each:

```
                          ┌── useMainnetKeyDerivation: false ──►  testnet keys  ──►  testnet accounts
seed phrase (24 words) ───┤
                          └── useMainnetKeyDerivation: true  ──►  mainnet keys  ──►  mainnet accounts
```

If the two packages use different values, the identity package creates an account the wallet package cannot find
or sign for, and no error says why. The simplest way to get it right is to use the presets in pairs: the two testnet
presets below (`CONCORDIUM_TESTNET_CONFIG` for the wallet package, `CONCORDIUM_TESTNET_IDENTITY_CONFIG` for the
identity package) both set it to `false`; for mainnet, use the two mainnet presets (chapter 11).

```js
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const seedPhrase = await loadSeedPhrase();   // your wallet's own code: read the user's words from secure storage

// 1. The wallet module: accounts, CCD, tokens. It connects to Concordium's public testnet node.
const wallet = new WalletManagerConcordium(seedPhrase, { ...CONCORDIUM_TESTNET_CONFIG });

// 2. The identity package's configuration: the provider list and a node connection.
//    The /v2 list includes every provider, also those for companies (chapter 9). Fetch it from a source you trust:
//    the package checks its keys against the chain, but the addresses of the providers' pages only come from it.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
//    Concordium's public testnet node (port 20000, with TLS). In a browser or a phone app use ConcordiumGRPCWebClient
//    from '@concordium/web-sdk' instead.
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const config = { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node };

// 3. The identity package.
const identity = new ConcordiumIdentity(seedPhrase, config);
```

The rest of this guide uses `seedPhrase`, `wallet`, `config` and `identity` from here.

**If your wallet already uses WDK** (Tether's Wallet Development Kit, which runs several chains from one seed
phrase), add Concordium next to your other chains. WDK creates the wallet module for you, so step 1 above is
skipped; steps 2 and 3 stay, because the identity package is not part of WDK. Do this once, when the user unlocks
the wallet. For example, in a wallet that already has Ethereum (new lines marked `// NEW`):

```js
import WDK from '@tetherto/wdk';
import WalletManagerEvm from '@tetherto/wdk-wallet-evm';                                                    // your existing chain
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';      // NEW
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';  // NEW
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';                          // NEW

const seedPhrase = await loadSeedPhrase();

// The chains, through WDK: Concordium is registered like any other chain
const wdk = new WDK(seedPhrase)
  .registerWallet('ethereum', WalletManagerEvm, { /* your existing config */ })
  .registerWallet('concordium', WalletManagerConcordium, { ...CONCORDIUM_TESTNET_CONFIG });           // NEW

// The identity package, next to WDK (not through it), with the same seed phrase (steps 2 and 3 above)  // NEW
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const config = { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node };
const identity = new ConcordiumIdentity(seedPhrase, config);
```

From here on, the work is split:

- **`identity`** is for what only Concordium has: verifying, keeping the identity, creating accounts, proofs
  (chapters 3 to 7). It is the same with or without WDK.
- **`wdk`** is for what every chain has: accounts, balances, sending. WDK creates the `WalletManagerConcordium` from
  its own copy of the seed phrase and keeps it under the name `'concordium'`: one per `WDK` object (registering the
  same name twice is an error). Where this guide uses `wallet`:

  | This guide says | With WDK, use |
  | --- | --- |
  | `wallet.getAccountByPath(path)` | `wdk.getAccountByPath('concordium', path)` |
  | `wallet.dispose()` | `wdk.dispose()` (disposes every registered chain) |

  The account you get back is the same object either way, so everything you then do with it (balances, transfers,
  token rules) is as this guide shows.

### Dispose when done

When the user locks the wallet or you no longer need them, call `identity.dispose()` and `wallet.dispose()`
(or `wdk.dispose()` if you use WDK). `identity.dispose()` zeroes the identity package's copy of the seed and the
identities it holds; `wallet.dispose()` zeroes the wallet module's copy of the seed and releases its accounts.
JavaScript cannot guarantee every copy in memory is wiped, so keep these objects only as long as needed, and create
them again when the user unlocks the wallet.

More: the [identity configuration](../identity/README.md#configuration), the
[wallet configuration](../README.md#configuration).

## 3. Verify an identity

```
WALLET                                   IDENTITY PROVIDER
──────                                   ─────────────────
1. the user picks a provider
2. createIdentityRequest ──── link ────► 3. the user verifies on the provider's page (documents, selfie)
5. retrieveIdentity     ◄─── return ──── 4. the browser comes back to your return address
   checks it is this seed's identity, and keeps it in memory
```

**1. Show the providers, and let the user pick one.**

```js
import { IdentityProviders } from '@concordium/wdk-identity-concordium';

const providers = (await new IdentityProviders(identityProviders).list())
  .filter((p) => p.kind === 'person' && p.issuanceStart);   // providers for people, that publish a verification page
// → [{ index: 0, name: 'Concordium testnet IP', kind: 'person', issuanceStart: 'https://…', … }, …]
```

Each provider has an `index`, its number on the network: the wallet uses it in every call. On testnet, use
**Concordium's test provider (index 0)** while developing: it shows a form with made-up details instead of asking for
real documents. The other providers ask for real documents, even on testnet.

**2. Build the request, and open the provider's page.**

```js
const providerIndex = 0;                                                   // the user's choice
const identityIndex = await identity.nextIdentityIndex({ providerIndex }); // the next free number: 0 for a new user
const { issuanceUrl } = await identity.createIdentityRequest({
  providerIndex,
  identityIndex,
  redirectUri: 'https://wallet.example/identity/return',   // your return address (see the table below)
});
```

`identityIndex` numbers the user's identities with this provider (0, 1, 2 …). Save it with the provider index: you
need both until the identity is collected, and for every later call about this identity.

Then open `issuanceUrl` for the user: in a phone app, in a web view (a browser view inside the app); in a web
wallet, in a new tab or the same one; on a desktop, in the system browser. Nothing is sent to the provider until it is
opened, and nothing is written to the chain.

**3–4. The user verifies, and the provider sends the browser back.** When the user finishes, the provider sends the
browser to your `redirectUri`, with its reply added after a `#`, for example
`https://wallet.example/identity/return#code_uri=…`. Browsers never send the part after `#` to any server, so your
wallet must read the full address where the browser arrives. How, by kind of wallet:

| Your wallet | `redirectUri` | How it reads the full address |
| --- | --- | --- |
| a phone app | the app's own address, e.g. `mywallet://identity/return` | the web view reports each address it is sent to: when it is your `redirectUri`, take that address and close the web view |
| a web wallet, or a wallet run on your server | a page of your own, e.g. `https://wallet.example/identity/return` | a script on that page reads `location.href` (and, for a wallet run on your server, sends it to your server) |
| a browser extension | the address `chrome.identity.getRedirectURL()` gives you | open the page with `chrome.identity.launchWebAuthFlow`: it returns the full address |
| a desktop app | from the built-in listener | `listenForIdentityCallback()` from `@concordium/wdk-identity-concordium/node` starts a small web server inside your app, reachable only from the user's own computer (`127.0.0.1`), and gives you the address it receives |

**5. Collect the identity.**

```js
const summary = await identity.retrieveIdentity(callbackUrl);   // callbackUrl: the full address, including the '#' part
// → { providerIndex: 0, identityIndex: 0, createdAt: '202611', validTo: '202711', maxAccounts: 200 }
```

`retrieveIdentity` does three things:

- **It waits** until the provider has issued the identity: it asks the provider every 3 seconds, and gives up after
  15 minutes by default. A provider whose staff check documents by hand can take longer; set your own limit with
  `{ timeoutMs }`, for example `retrieveIdentity(callbackUrl, { timeoutMs: 30 * 60 * 1000 })` for 30 minutes. If time
  runs out, it throws `IdentityIssuanceError` with reason `'timeout'`; the provider may still be working on it, so
  you can wait again later (see "If the app may be closed while it waits", below).
- **It checks** the identity was issued to this seed phrase, and that it is genuine (its provider's signature fits it
  exactly as it is); if not, it refuses it. This takes about a second.
- **It holds** the identity in the `identity` object, in memory.

To wait longer, or check more or less often, pass your own values (both in milliseconds):

```js
const summary = await identity.retrieveIdentity(callbackUrl, {
  timeoutMs: 30 * 60 * 1000,   // give up after 30 minutes (default: 15 minutes)
  intervalMs: 5000,            // ask the provider every 5 seconds (default: every 3 seconds)
});
```

**Only a summary comes back:** which identity it is (`providerIndex`, `identityIndex`), when it was issued and when it
expires (`createdAt`, `validTo`, as year and month: `'202711'` = November 2027), and how many accounts it can have
(`maxAccounts`). The person's verified details (name, date of birth, nationality, ID document number…) are never
returned to your code. The package uses them only when you export the identity (as plain text, for your secure storage: chapter 4), when you create
an account (none go on chain unless you name them, chapter 5), and when the user agrees to answer a website's question
(only what it asks is proven or shown, chapter 7). This keeps them out of your logs and screens by accident.

Next, keep the identity (chapter 4).

**If the app may be closed while it waits** (verification can take a while), save the provider's reply before
waiting, and continue after a restart:

```js
// Before waiting: read the reply (no network call) and save it in your app's own storage.
const { codeUri } = identity.parseIdentityCallback(callbackUrl);
await appStorage.set('pendingIdentity', { codeUri, providerIndex, identityIndex });   // appStorage: your app's settings store

// After a restart: a new ConcordiumIdentity from the same seed phrase continues where it was.
const pending = await appStorage.get('pendingIdentity');
const resumed = new ConcordiumIdentity(seedPhrase, config);
await resumed.waitForIdentity(pending.codeUri, { providerIndex: pending.providerIndex, identityIndex: pending.identityIndex });
```

**Keep the saved reply private, like the identity itself.** The `code_uri` is an address where the provider serves the
issued identity, the person's details included, to anyone who opens it, with no login. Keep it in your app's secure
storage, never log it or send it to analytics or crash reports, and delete it once the identity is collected.

Samples (in `identity/`): `npm run example:verify-identity` (a desktop wallet, with the listener), and
`npm run example:resume-after-restart`, then `npm run example:resume-after-restart -- resume`
([`examples/resume-after-restart.mjs`](../identity/examples/resume-after-restart.mjs): verify, save the reply and
stop; a fresh start collects the identity). The demo wallet
(`npm run demo-wallet` in `identity/`) shows the whole flow step by step in a browser.

## 4. Keep it

The package stores nothing. It gives you the identity as text to keep, and takes it back on the next start.

> **The exported identity is NOT encrypted.** It is plain text holding the person's verified details: name, date of
> birth, nationality, ID document number and the other details the provider checked. Anyone who has it can read them.
> **Keep it like any other secret: in the same secure storage as the seed phrase** (on a phone, the Keychain on iOS
> or the Keystore on Android; on a server, an encrypted, access-controlled database or a key vault). Never log it,
> send it to analytics or crash reports, or keep it in plain files or unencrypted backups.

```js
// After collecting: get the identity as text (NOT encrypted), and keep it where you keep the seed phrase.
const exported = await identity.exportIdentity({ providerIndex, identityIndex });
await mySecureStorage.set('concordium-identity', exported);
// mySecureStorage.set / .get stand for your wallet's own secure storage calls (for example react-native-keychain,
// the iOS Keychain, the Android Keystore, an encrypted database); the package does not call them, and the name you
// keep it under is up to you. Not plain storage such as AsyncStorage or localStorage: the text holds personal details.

// On every later start: create the identity object (chapter 2), then give it back the kept text.
const summary = await identity.importIdentity(await mySecureStorage.get('concordium-identity'));
// → { providerIndex: 0, identityIndex: 0, … }: the text itself says which identity it is
```

Keep it under a name your wallet always knows, such as `'concordium-identity'`: after a restart, the wallet does not
yet know which provider and identity numbers it used. A wallet with several identities keeps a list of the exported
texts and imports each one; `importIdentity` needs only the text.

- **It holds no keys.** Every key comes from the seed phrase, so the text alone cannot create accounts or answer
  questions; but its details can be read by anyone who has it.
- **`importIdentity` checks it is this wallet's identity, and genuine:** another seed phrase's identity is refused
  (`not-yours`), and so is a changed or forged one (`not-genuine`: its provider's signature does not fit). This needs
  one call to the node (the network's parameters) and takes about a second.
- **A server with many users** keeps each user's text in that user's own record, protected like the seed phrases;
  another user's seed phrase cannot use it, and deleting a user's record (and seed phrase) erases their identity. Sample: `npm run example:server-keeps-identities` in `identity/`
([`examples/server-keeps-identities.mjs`](../identity/examples/server-keeps-identities.mjs)).

The exact format, with a worked example: [`identity/docs/storage-format.md`](../identity/docs/storage-format.md).

## 5. Create accounts

```js
const credNumber = await identity.nextCredNumber({ providerIndex, identityIndex });   // the next account: 0 at first
const { address, path, created } = await identity.createAccount({ providerIndex, identityIndex, credNumber });
// address: the new account's address; path: e.g. '0/0/0'; created: false if it already existed

const account = await wallet.getAccountByPath(path);   // the account, in the wallet module
await account.getBalance();                            // in microCCD; a new account starts with 0
```

- **Built from the identity.** `providerIndex` and `identityIndex` say which identity to use: `createAccount` uses the
  identity the `identity` object holds for those numbers, so it must have been collected (chapter 3), imported
  (chapter 4) or recovered (chapter 6) first; otherwise it stops before sending anything. It also refuses, before
  sending, an identity that has expired, a `credNumber` beyond its `maxAccounts`, or a detail in `revealAttributes`
  the identity does not have (chapter 10 lists the reasons). From the identity it builds a proof that the new account
  belongs to an identity the provider signed, without putting the person's details on chain. The **chain** checks
  that proof against the provider's public key, which it holds itself: a genuine identity gets its account; a forged
  or altered one is refused (`'rejected'`) and no account is created. Nobody asks the provider at any point: the
  signature is checked with its published key.
- **Free.** Creating an account costs nothing on Concordium. `createAccount` returns once the account is final, so the
  address can be used straight away.
- **Several accounts per identity:** `credNumber` 0, 1, 2 …, up to the identity's `maxAccounts` (in its summary).
  Create them in order: recovery (chapter 6) finds them by counting.
- **Safe to repeat.** If the account already exists (for example the app crashed after creating it), it is returned
  with `created: false` and nothing is sent.
- **Private by default.** Nothing about the user is shown on the account. To show a detail publicly, name it:
  `createAccount({ …, revealAttributes: ['countryOfResidence'] })`.

From here the account works like any WDK account: `account.sendTransaction({ to, value })` sends CCD;
`account.getTokenBalance(token)`, `account.quoteTransfer(...)` and `account.transfer({ token, recipient, amount })`
handle PLT and CIS-2 tokens; and with **sponsored transfers** another account pays the fee, so a new user can move
tokens before holding any CCD ([sponsored transfers](../README.md#sponsored-plt-transfers)).

Samples: `npm run example:create-account`, and the whole story with both packages, `npm run example:wdk-end-to-end`
(both in `identity/`).

## 6. A new phone

The seed phrase is the user's backup. On a new phone, or after the app is reinstalled, the wallet's kept identities
are gone; from the seed phrase alone, the wallet asks the providers for the identities they issued and the chain for
their accounts. The user verifies nothing again, and nothing is sent or paid.

On a new phone, nothing is in storage yet: your wallet's own restore screen asks the user to type their seed phrase,
keeps it in secure storage, and passes it to both packages as in chapter 2. If the words are wrong, both packages
throw "Invalid seed phrase."

```js
// Create the identity and wallet objects from the seed phrase (chapter 2), then:
const { identities, problems } = await identity.recoverAll();
const kept = [];
for (const { providerIndex, identityIndex, summary, accounts } of identities) {
  // keep each identity again, as in chapter 4
  kept.push(await identity.exportIdentity({ providerIndex, identityIndex }));
  // and its accounts, in the wallet module
  for (const { path } of accounts ?? []) await wallet.getAccountByPath(path);
}
// Several identities may come back, so keep them as a list (chapter 4); on later starts, import each one.
await mySecureStorage.set('concordium-identities', JSON.stringify(kept));
```

- `recoverAll` asks each provider for identity 0, 1, 2 …, and the chain for accounts 0, 1, 2 … under each, until
  three numbers in a row are missing. That is why identities and accounts should be numbered in order.
- `problems` lists what could not be done, for example a provider that was down: the others were still asked. Show
  it, and try `recoverAll` again later.
- An identity's `accounts` is `null` if they could not be looked up just now: call `identity.findAccounts(...)` later.
- Expired identities come back too: check `summary.validTo` (year and month, e.g. `'202711'`); an expired identity
  cannot create new accounts, and the user verifies again.

Sample: `npm run example:recover-identity`. More: [recovery](../identity/README.md#getting-the-identity-back-recovery).

## 7. Prove facts

A website can ask the user "are you over 18?", "do you live in the EU?", "you are not a US resident?", and the wallet
answers with a proof **without showing the detail itself**: the website learns "over 18", not the date of birth. Only
details the website explicitly asks to see (for example the nationality) are shown.

```
WEBSITE                                     WALLET
───────                                     ──────
asks a question ──────────────────────────► describes it in plain English (the consent screen)
                                            the user agrees
checks the answer against the chain ◄─────── answers with a proof
```

There are two versions of questions, both Concordium's own formats. **Concordium recommends version 1 for new
integrations**: the answer comes from the identity itself, and the question is recorded on chain (its "anchor").
Version 0 is the earlier format, which existing websites still use; the package answers and checks both.

| | Version 1 (recommended) | Version 0 (earlier) |
| --- | --- | --- |
| The answer comes from | the identity itself | one of the user's accounts |
| The user needs an account | no | yes |
| The website learns which account | no | yes |
| The website pays | about EUR 0.013 per question, to record it on chain (or a sponsor pays) | nothing |
| Supported by | Concordium's browser wallet and SDK | WalletConnect's Concordium request, Concordium's example apps, Concordium's browser wallet |

### The wallet's side

The question comes from the website that wants to know (an online shop, a bank, …). How it reaches your wallet
depends on your wallet: a browser extension receives it from the page directly; a phone wallet usually through
WalletConnect, a messaging service that links a website to a wallet app after the user scans a QR code. Your wallet
passes it to the package as `question` below. Show what it asks, get the user's agreement, then answer:

```js
import { describeProofRequest, describeProofContext } from '@concordium/wdk-identity-concordium';

// 1. The consent screen: what will be proven or shown, in plain English.
describeProofRequest(question);
// → [{ providers: [0, 1, 2], asks: [{ text: 'prove you were born before 9 Nov 2008 (at least 18 years old), without showing your date of birth' }] }]
// For a version 1 question, also: who is asking. Compare `website` with the site the wallet is connected to.
describeProofContext(question);   // → { website: 'shop.example', purpose: 'age check', … }

// 2a. Version 1 (recommended): answer from the identity itself. The package first checks the question's anchor on
//     chain records exactly this question.
const answer = await identity.proveIdentity({ providerIndex, identityIndex, request: question });
// send back: JSON.stringify(answer)

// 2b. Version 0 (earlier format): find an account that can truly answer, and answer from it.
const accounts = await identity.accountsThatCanAnswer({ providerIndex, identityIndex, ...question });
if (accounts.length === 0) { /* this identity cannot answer truthfully: tell the user, and decline */ }
const answerV0 = await identity.prove({ providerIndex, identityIndex, credNumber: accounts[0].credNumber, ...question });
// send back: answerV0.toString() (WalletConnect: { verifiablePresentationJson: answerV0.toString() })
```

The wallet **never makes a false answer**: it refuses before building anything if the identity has expired, the
website does not accept its provider, or its details do not satisfy the question (chapter 10 lists the reasons).

### The website's side

The website (the shop, the bank, …) asks the question and checks the answer, on its own server. It does not use WDK,
a seed phrase or an identity: it uses a separate entry point of the identity package made for websites,
`@concordium/wdk-identity-concordium/verify` (install the identity package as in chapter 2), and its own connection
to a Concordium node. For version 1, the website also needs a Concordium account to record its questions from, and
optionally a sponsor account that pays the fee for it:

```js
import { requestForV1, checkPresentationV1, connectToNode } from '@concordium/wdk-identity-concordium/verify';
import { buildBasicAccountSigner } from '@concordium/web-sdk';

const node = connectToNode('testnet');   // Concordium's public testnet node (or the address of your own node)
const shop = { address: SHOP_ADDRESS, signer: buildBasicAccountSigner(SHOP_SIGNING_KEY) };          // your account
const sponsor = { address: SPONSOR_ADDRESS, signer: buildBasicAccountSigner(SPONSOR_SIGNING_KEY) }; // optional: pays the fee

// 1. Build the question and record it on chain (it waits until the record is final, a few seconds). Keep it on your
//    server, and send it to the wallet (as in "The wallet's side" above).
const question = await requestForV1(
  { network: 'testnet', website: 'shop.example', purpose: 'age check', providers: [0, 1, 2], adult: true },
  { node, sender: shop.address, signer: shop.signer, sponsor },
);

// 2. When the wallet's answer arrives: accept only one answer per question, then check it against the chain.
if (await myDatabase.wasAnswered(question.transactionRef)) throw new Error('This question was already answered.');
const result = await checkPresentationV1(answer, question, { node, network: 'testnet' });
await myDatabase.markAnswered(question.transactionRef, result.auditRecord);   // myDatabase: your server's own storage

if (result.ok) {
  // accepted: result.revealed holds any details the question asked to see; keep result.auditRecord (the question
  // and the answer) as your record of the check
} else {
  // refused: result.reasons says why (for example an answer to another question, or an expired identity)
}
```

`checkPresentationV1` checks that the answer is for this exact question (tied to its record on chain), from a
provider you trust, on the right network, from an identity still valid on chain, and that the proof's maths holds. A
refused answer is not an error: `ok` is `false`, with the reasons. What it cannot do for you:

- **accept one answer per question**: remember the questions answered (by `question.transactionRef`, the reference of
  its record on chain) where all your servers can see them, so a copied answer cannot be used twice;
- **ask a fresh question each time**: call `requestForV1` for every check; each question it builds is unique;
- **keep only what you need** from the result, and keep your account's signing key as a secret.

**Version 0** (the earlier format) works the same way with `requestFor` and `checkPresentation`, and costs nothing: the
question is not recorded on chain, so no account is needed. Use it for wallets that only answer version 0 questions:

```js
import { requestFor, checkPresentation } from '@concordium/wdk-identity-concordium/verify';

const question = requestFor({ providers: [0, 1, 2], adult: true });   // no network call
// … send it, receive the answer; accept one answer per question, by question.challenge …
const result = await checkPresentation(answer, question, { node, network: 'testnet' });
// result.ok; result.account is the account that answered; result.revealed; result.reasons
```

The website can also check answers without this package, with Concordium's own SDK or Concordium's verifier service;
these helpers do it in a few lines, with plain reasons.

Samples: `npm run example:age-check-v1` (version 1: a shop with no CCD whose partner pays the fee) and
`npm run example:age-check` (version 0), in `identity/`. More: [proving facts](../identity/README.md#proving-facts-proofs).

## 8. Regulated tokens

Some tokens restrict who may hold or move them: an **allow list** (only accounts on it may send or receive), a **deny
list** (accounts on it may not), or a **pause** (no transfers at all). The token's issuer manages these rules; the
wallet only reads them, so it can tell the user before offering a transfer, rather than after it fails.

```js
// account: from chapter 5; recipient: the address the user wants to send to.
await account.getTokenRules('UPEU');                    // → { paused: false, allowList: true, denyList: true, … }
await account.getTokenAccountStatus('UPEU', recipient);  // → { exists: true, onAllowList: false, onDenyList: false, … }

// Before showing "Send": would the transfer be refused, and why? Nothing is sent.
const check = await account.checkTransfer({ token: 'UPEU', recipient, amount: 1000000n });   // 1 UPEU (6 decimals)
if (!check.ok) {
  for (const { reason, message } of check.reasons) console.log(reason, message);   // show these to the user
}
```

`check.reasons` lists every problem at once, each with a plain message, for example "The recipient is not on UPEU's
allow list." `account.transfer(...)` runs the same check first, so a transfer that cannot happen is never sent: it
throws `ConcordiumTransferError` (WDK's own `TransferError`) with the reason instead. If the chain refuses a transfer
after all (the issuer changed a rule in that very moment), the error says why, and has the transaction's hash.

**Transaction status, the WDK way.** `account.getTransaction(hash)` returns WDK's standard receipt: `pending`, then
`final` with `success`, `fee` and `block`. So WDK's own `account.waitForTransaction(hash)` works for Concordium as it
does for other chains.

Sample: `npm run example:regulated-token` (read-only, in the repository root). More:
[regulated tokens](../README.md#regulated-tokens).

## 9. Companies (Business ID)

A company can have an identity of its own, a **Business ID**, with its LEI (Legal Entity Identifier, the global
company number banks use), legal name and country of registration. It is issued by Global FinReg (testnet provider 4,
mainnet provider 3) and made with **the same calls** as a person's identity (chapters 3 to 7): only the provider
differs. To offer "verify your company" next to "verify yourself", list the company providers:

```js
const companyProviders = (await new IdentityProviders(identityProviders).list()).filter((p) => p.kind === 'company');
// → [{ index: 4, name: 'Global FinReg Testnet', display: 'Global FinReg (Business ID)', kind: 'company', … }]
```

They are in the `/v2/ip_info` list used in chapter 2 (the older `/v1/ip_info` list leaves them out).

Websites ask companies with the same functions as people, for example
`requestFor({ providers: [4], reveal: ['lei', 'legalName'], registeredIn: ['DK', 'SE', 'DE'] })`, and the consent
screen then reads "show the company's legal name".

Global FinReg has no test mode: its page asks the company to sign in, and completing a Business ID needs a real
company with its documents. So it can be tried up to Global FinReg's company page. Samples:
[`identity/examples/company-identity/`](../identity/examples/company-identity/).

## 10. Errors in one place

Every error the packages throw has a name, and most have a `reason`: a short code your wallet can act on. Its
`message` is plain English, safe to log and to show to the user (it never contains a seed phrase or a key).

```js
import { AccountCreationError } from '@concordium/wdk-identity-concordium';

try {
  await identity.createAccount({ providerIndex, identityIndex, credNumber });
} catch (e) {
  if (e instanceof AccountCreationError && e.reason === 'identity-expired') {
    // tell the user their identity has expired, and offer to verify again
  } else {
    throw e;
  }
}
```

**Identity package**

| Error | `reason` | What to tell the user / do |
| --- | --- | --- |
| `IdentityProviderError` | — | the provider is not in the list, or does not publish the page needed: offer another provider; or its keys in the list differ from the chain's record: fetch the list again from a source you trust |
| `IdentityIssuanceError` | `provider-error`, `rejected` | the provider did not issue the identity: show its message; start a new request |
| | `timeout`, `cancelled` | still being verified, or the wait was stopped: wait again later with the same reply (chapter 3) |
| | `not-genuine` | the identity is not as its provider issued it (never held): report it; start a new request |
| `IdentityStorageError` | `unreadable` | the kept text is not this seed phrase's identity, or was damaged: recover it (chapter 6) |
| | `not-yours` | someone else's identity: do not use it |
| | `not-genuine` | the kept text was changed (or the identity forged): recover it from the provider (chapter 6) |
| `AccountCreationError` | `identity-expired` | the identity has expired: verify again for a new one |
| | `max-accounts`, `unknown-attribute` | a wrong account number or detail name in the call: fix it (nothing was sent) |
| | `expired` | the account was not created in time: try again |
| | `rejected` | the chain refused the account: show its message; trying again does not help if the identity is not genuine |
| | `timeout`, `cancelled`, `node` | not known yet: call `createAccount` again; it returns the account if it was created |
| `IdentityRecoveryError` | `provider-error`, `network`, `node` | a provider or the node could not be asked: try again later |
| | `not-yours`, `not-genuine` | the provider returned an identity that is not this seed phrase's, or not genuine: report it |
| | `cancelled` | stopped by your wallet |
| `ProofError` | `invalid-request`, `unknown-attribute` | the website's question is broken: decline |
| | `not-held` | this identity is not loaded: import it (chapter 4) or recover it (chapter 6) first |
| | `identity-expired` | the identity has expired: verify again |
| | `provider-not-accepted`, `cannot-prove`, `account-only` | this identity cannot truthfully answer: tell the user, and decline |
| | `anchor-not-found` | a version 1 question not recorded on chain yet: try again in a few seconds |
| | `anchor-mismatch` | the question was changed after it was recorded: do not answer |
| | `node`, `anchor-failed` | the node could not be asked, or (on the website) recording the question failed: try again |

**Wallet package**

| Error | `reason` | What to tell the user / do |
| --- | --- | --- |
| `AccountNotCreatedError` | — | no account at this path yet: create it (chapter 5) |
| `ConcordiumTransferError` | `TOKEN_PAUSED`, `SENDER_…`/`RECIPIENT_NOT_ON_ALLOW_LIST`, `…_ON_DENY_LIST` | the token's rules forbid it: tell the user; nothing was sent |
| | `INSUFFICIENT_TOKEN_BALANCE`, `INSUFFICIENT_BALANCE` | not enough of the token, or of CCD for the fee: the message says how much is needed |
| | `RECIPIENT_NOT_FOUND`, `SENDER_NOT_FOUND`, `SPONSOR_NOT_FOUND` | no account at that address |
| | `CONTRACT_REFUSED`, `OPERATION_NOT_PERMITTED`, `REJECTED` | refused for another reason: show the message (if the error has a `hash`, it was sent and the fee was charged) |
| `TransactionError` (WDK's) | `INSUFFICIENT_BALANCE` | too little CCD for a CCD transfer and its fee |
| `TransactionRejectedError` | — | another kind of transaction the chain rejected: `rejectReason` says why; the fee was charged |
| WDK's `InvalidTokenError`, `ValueError`, `NoSuchElementError`, `ProviderError`, `TimeoutError` | — | in order: an unknown token, a wrong argument, an unknown transaction, the node could not be reached, a wait that ran out |

A sample that makes each error of both packages happen and turns it into a message for the user, with one function
a wallet can copy: `npm run example:handle-errors` in `identity/`
([`examples/handle-errors.mjs`](../identity/examples/handle-errors.mjs)).

## 11. Going to mainnet

Everything in this guide is **tested on testnet**: with Concordium's test identity provider, testnet accounts, and
the regulated tokens and Business ID provider published on testnet. Mainnet, with real identities and real money, is a
different bar:

- **An independent security review** of both packages comes first. The [threat model](threat-model.md) says what the
  packages protect and what is left to the wallet: start there.
- **Mainnet configuration:** `CONCORDIUM_MAINNET_CONFIG` and `CONCORDIUM_MAINNET_IDENTITY_CONFIG` (mainnet keys), the
  mainnet provider list (`https://wallet-proxy.mainnet.concordium.software/v2/ip_info`) and a mainnet node
  (Concordium's public one is `grpc.mainnet.concordium.software`, port 20000). The same seed phrase gives different
  keys on mainnet, so testnet identities and accounts do not carry over.
- **Real providers ask for real documents.** Some may require your return address to be registered with them first:
  ask each provider you offer.
- **The identity package is not on npm yet:** it is published once reviewed.
- **Check the providers before each release:** `npm run check:providers` (in `identity/`) reports, for every provider
  on testnet and mainnet, whether it accepts identity requests.
