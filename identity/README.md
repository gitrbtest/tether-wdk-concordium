# @concordium/wdk-identity-concordium

Identity companion for [`@concordium/wdk-wallet-concordium`](../README.md).

On Concordium, an account can only exist once a verified identity stands
behind it. This package lets a wallet obtain that identity from the wallet's
own seed, without the Concordium ID App:

- start identity verification with an identity provider and collect the issued identity,
- hand the identity to the wallet to keep its own way (exported as plain text: **not encrypted**, so the wallet keeps
  it in its secure storage, like the seed phrase),
- create Concordium accounts from the identity,
- get the identity and its accounts back from the seed phrase alone, e.g. on a new phone,
- prove facts such as "over 18" to a website without revealing the detail itself (and, for websites,
  check those proofs).

Accounts created this way are then used through `@concordium/wdk-wallet-concordium`
like any other account.

> **Status: in development.** The package is not published yet, and its API
> may change until the first release. Available today: listing identity
> providers, starting identity verification, collecting the issued identity,
> exporting it for the wallet to keep, creating accounts from it, recovering it from the
> seed, and proving facts to websites, with the websites' check (tested on testnet).

## What you can build

Short stories of what a wallet, or a business working with wallets, can do with this package. Each one has
a demo you can run on testnet. (All names are made up; everything runs on Concordium's testnet.)

**Add Concordium to a multi-chain wallet, without sending users elsewhere.** A wallet built with Tether's
WDK already holds stablecoins on several chains. With this package, a new user who taps "Add Concordium"
chooses an identity provider, verifies once on the provider's page, and comes back to a verified identity
and a new Concordium account, inside the same wallet. No second app, no fee for the account; and a sponsor
can pay their first transaction fees, so they can move tokens before owning any CCD.
Try it: `npm run demo-wallet` (a step-by-step page in your browser; see [the demo wallet](examples/demo-wallet/)).

**A new phone, and nothing lost.** A user drops their phone in the sea. On the new one, they type their seed
phrase, and the wallet asks the identity providers for their identities and the chain for their accounts:
everything comes back, with no documents, no new verification and nothing else to remember.
Try it: `npm run example:recover-identity`.

**"Over 18?", without showing a date of birth.** A website selling age-restricted goods asks the wallet a
question. The wallet shows the user what is asked, and answers with a proof that the date of birth sealed
in their account's record on chain is before the date asked. The website checks the proof against the
chain and lets them in. It never sees the date of birth, and the same answer cannot be used twice.
Try it: `npm run example:age-check` (both sides, the website and the wallet, in one run; see
[Proving facts](#proving-facts-proofs)).

**A shop with no crypto, and a partner who pays.** A shop wants to ask "over 18?" without its customers
needing an account, and without learning which account they hold. It asks a version 1 question: the question
is recorded on chain, and its payment partner pays the fee (about 1.3 euro cents), so the shop holds no CCD at
all. The customer's wallet answers from the identity itself; the shop learns "over 18", and nothing else.
Try it: `npm run example:age-check-v1` (spends one small testnet fee per run; see
[Version 1](#version-1-from-the-identity-with-an-anchor)).

**A company opens an account with a bank, from its own wallet.** A fund wants to open an account with a bank
that only deals with EU-registered companies. Its wallet gets the company a Business ID once (the company verifies
with its LEI and documents at Global FinReg), and from then on answers the bank's question in seconds: "here is our
LEI and legal name, and we are registered in the EU", without sending a single document again.
Try it: `npm run example:company-questions` (the bank's question and the consent screen; see
[Company identities](#company-identities-business-id)).

More stories will follow as the package grows (tokens that only verified people may hold).

## Requirements

Node.js 18+, using ES modules, the same as `@concordium/wdk-wallet-concordium`.

The main entry uses no Node.js-only features (a test enforces this), so it is meant to run in browsers
and mobile runtimes too; so far it is tested on Node.js. The Node.js-only extra (the callback listener) comes
from a separate entry point, `@concordium/wdk-identity-concordium/node`.

## Configuration

```js
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG, // { useMainnetKeyDerivation: true }
  CONCORDIUM_TESTNET_IDENTITY_CONFIG, // { useMainnetKeyDerivation: false }
} from '@concordium/wdk-identity-concordium';

import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs'; // or ConcordiumGRPCWebClient

// The identity provider list: the package does not fetch it. Get it once, from wherever you like (today, the
// wallet-proxy), and pass it in:
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
// Your connection to a Concordium node: the package never opens one itself.
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());

const config = { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node };
```

| Field | Required | Meaning |
|---|---|---|
| `useMainnetKeyDerivation` | yes | Derive keys as on mainnet (`true`) or testnet (`false`). Same meaning as in `@concordium/wdk-wallet-concordium`: **use the same value for both packages**, so identities and accounts come from the same keys. It does not check which network the list or the node belongs to. |
| `identityProviders` | yes | The identity provider list, in the shape of the wallet-proxy's `/v2/ip_info` (below; `/v2` lists every provider, including the company (Business ID) ones, and `/v1/ip_info` leaves those out). The package never fetches it, so if the wallet-proxy is replaced, any source giving the same shape works. It is checked when the `ConcordiumIdentity` is created: a list in the wrong shape is refused, naming the field. To use a newer list, create a new object. |
| `node` | yes | Your connection to a Concordium node: any Concordium node client from `@concordium/web-sdk`, such as `ConcordiumGRPCNodeClient` (Node.js) or `ConcordiumGRPCWebClient` (browsers and phones), or the one your wallet already has. The package never opens a connection itself, so it runs wherever your client does. **Everything the package needs from the chain goes through it**: the network's cryptographic parameters (read once), whether an account exists, and sending a new account. |

The presets hold only the key derivation choice; the wallet adds its provider list and its node. The package talks to
nothing else: the identity providers (verification and recovery pages) and your node. (A `walletProxyUrl`, used by
earlier versions, is refused with a message saying so.)

### The provider list's shape

One entry per provider; these are the fields the package reads (others are ignored):

```js
{
  ipInfo: {
    ipIdentity: 0,                                        // the provider's number on the network
    ipDescription: { name: 'Concordium testnet IP', … },
    ipVerifyKey: '…', ipCdiVerifyKey: '…',                // its public keys
  },
  arsInfos: { '1': { arIdentity: 1, arPublicKey: '…', … }, … },   // its anonymity revokers
  metadata: { issuanceStart: 'https://…', recoveryStart: 'https://…', display: '…' },   // optional: its addresses, display name
}
```

A Concordium node also knows the providers, but only their keys: the addresses where a person verifies
(`issuanceStart`) and where a wallet asks for an identity back (`recoveryStart`) are only in this list.

## Identity providers

```js
import { IdentityProviders } from '@concordium/wdk-identity-concordium';

const providers = new IdentityProviders(identityProviders);   // the list, as above

await providers.list();
// [ { index: 0, name: 'Concordium testnet IP', display: null, kind: 'person', issuanceStart: 'https://…', recoveryStart: 'https://…' },
//   { index: 4, name: 'Global FinReg Testnet', display: 'Global FinReg (Business ID)', kind: 'company', … }, … ]

await providers.get(0); // one provider, with the keys and anonymity revokers a request is built from
```

A provider's `index` is an identifier assigned per network, not a position in
the list, and the same provider can have different indices on testnet and
mainnet. Use the index of the provider the user chooses. `get` throws
`IdentityProviderError` for an index that is not in the list.
Addresses are returned exactly as each provider publishes them, or `null`.
`kind` says whether a provider issues identities of people (`'person'`) or of companies (`'company'`: a
Business ID provider; see [Company identities](#company-identities-business-id)), so a wallet can offer
"verify yourself" and "verify your company" apart.

## Starting identity verification

```js
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';

const identity = new ConcordiumIdentity(seedPhrase, config);

const identityIndex = await identity.nextIdentityIndex({ providerIndex: 0 }); // the next free identity number
const { issuanceUrl } = await identity.createIdentityRequest({
  providerIndex: 0,                                      // required
  identityIndex,                                         // required: which of the wallet's identities with this provider
  redirectUri: 'https://wallet.example/identity/return', // required
});

// Open issuanceUrl in a browser or web view. The user verifies with the
// provider, which then sends the browser to redirectUri.
```

- **The seed** is the wallet's BIP-39 seed phrase or its 64-byte seed: the same
  seed the wallet package uses. The identity keeps its own copy;
  `dispose()` zeroes it, after which calls that need the seed throw.
- **`identityIndex`** numbers the wallet's identities with a provider. The
  wallet chooses it; it selects which keys are derived from the seed and is
  never sent to the provider. Use 0 for the first identity and count up
  (1, 2, …) without gaps, so the identities can be found again from the seed.
  The wallet must remember it until the identity is collected.
- **`redirectUri`** is any absolute URL, including an app's own scheme. It is
  passed to the provider exactly as given, so it can match an address
  registered with the provider. There is no default.
- **Nothing is sent to the provider** until the wallet opens `issuanceUrl`.
  Building the request only reads public data: the provider list you passed in
  and the network's cryptographic parameters (from your node); the request
  itself is computed locally. Nothing is written to the blockchain.
- A provider that is not published, or publishes no issuance address, raises
  `IdentityProviderError` before any cryptographic work is done.

## Collecting the issued identity

When verification ends, the provider sends the browser to `redirectUri` with
its reply after `#`: on success a `code_uri` where the identity can be
collected, otherwise an error. Pass the **full address** the browser arrived at,
including everything after `#`:

```js
// e.g. 'https://wallet.example/identity/return#code_uri=https%3A%2F%2Fid-service…'
const summary = await identity.retrieveIdentity(callbackUrl);
// { providerIndex: 0, identityIndex: 0, createdAt: '202610', validTo: '202710', maxAccounts: 200 }

identity.dispose(); // zero the seed and the collected identity when no longer needed
```

`retrieveIdentity` reads the reply, then polls the provider until the identity
is issued or refused (by default every 3 seconds, for up to 15 minutes). It
checks that the issued identity belongs to this seed, provider and identity
index, and keeps it inside the object for the steps that follow. Only a summary,
with no personal data, is returned.

After `createIdentityRequest` on the same object, the callback address is all
that is needed. Browsers never send the part after `#` to a server, so read the
address where the browser arrives: an app's own scheme, a script on the
return page (`location.href`), or, in a desktop app, the optional
built-in listener below.

**Resuming after a restart.** Verification can take a while, and the app may be
closed while it waits. The provider sends its reply only once, in the address the
browser arrives at, and a new `ConcordiumIdentity` after a restart does not know
which request it was. So use the two steps instead of `retrieveIdentity`: read the
reply first and save the `code_uri` with the provider and identity index; after a
restart, continue in a new object from the same seed:

```js
// Before: read the reply and save what is needed to continue (no network call)
const { codeUri } = identity.parseIdentityCallback(callbackUrl);
await appStorage.set('pendingIdentity', { codeUri, providerIndex: 0, identityIndex: 0 });

// After a restart: a new object from the same seed, told which request it is continuing
const pending = await appStorage.get('pendingIdentity');
const resumed = new ConcordiumIdentity(seedPhrase, config);
const summary = await resumed.waitForIdentity(pending.codeUri,
  { providerIndex: pending.providerIndex, identityIndex: pending.identityIndex });
```

(`appStorage` stands for wherever the app keeps its own small settings.) Without this,
an app closed during the wait loses the reply, and the user has to verify again.
Keep the saved reply private, like the identity: whoever has the `code_uri` can read
the person's details from the provider. Delete it once the identity is collected.

Try it: `npm run example:resume-after-restart` (verify, save the reply, stop), then
`npm run example:resume-after-restart -- resume` (a fresh start collects the identity).

Options for both `retrieveIdentity` and `waitForIdentity`:

| Option | Default | Meaning |
|---|---|---|
| `providerIndex`, `identityIndex` | those of the last `createIdentityRequest` | which request the identity was requested with; required in a new object |
| `timeoutMs` | 900000 (15 minutes) | stop waiting after this long |
| `intervalMs` | 3000 | time between polls |
| `signal` | none | an `AbortSignal` to cancel the wait |

**Errors.** When no identity results, an `IdentityIssuanceError` is thrown.
Its `reason` says why, and its `message` includes the provider's own words:

| `reason` | When | What the wallet can do |
|---|---|---|
| `'provider-error'` | the provider sent the browser back with an error (`detail`, and `code` if given) | show the message; start a new request |
| `'rejected'` | the provider did not issue the identity (`detail`) | show the message; start a new request |
| `'timeout'` | not issued within `timeoutMs`; the provider may still be verifying | wait again later with the same `code_uri` |
| `'cancelled'` | the `signal` was aborted | wait again later with the same `code_uri` |

A rejected or refused request is finished: a new request may use the same
identity index. An identity that does not belong to this wallet is refused with
an `Error` and not kept. Brief network failures while polling are retried;
repeated ones are reported.

## Keeping identities: export and import

The package stores nothing. The wallet keeps the identity **its own way**: `exportIdentity` gives the identity as
text, and `importIdentity` takes it back.

> **The exported identity is NOT encrypted.** It is plain JSON text holding the person's verified details: name, date
> of birth, nationality, ID document number and the other details the provider checked. Anyone who has the text can
> read them. **Keep it like any other secret: in the same secure storage as the seed phrase** (a phone's Keychain or
> Keystore, an encrypted database, a key vault). Never log it, send it to analytics or crash reports, or keep it in
> plain files or unencrypted backups.

```js
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';

const identity = new ConcordiumIdentity(seedPhrase, config);
await identity.retrieveIdentity(callbackUrl);                                  // collect, as above

const exported = await identity.exportIdentity({ providerIndex: 0, identityIndex: 2 }); // plain text: NOT encrypted
await mySecureStorage.set('concordium-identity', exported);       // where the wallet keeps its seed phrase

// Later, e.g. after an app restart, in a new object with the same seed:
const summary = await identity.importIdentity(await mySecureStorage.get('concordium-identity'));
```

- **It holds no keys.** Every key comes from the seed phrase, so the text alone cannot create accounts or answer
  questions; but its details can be read by anyone who has it.
- **`importIdentity` checks the identity is this wallet's** before holding it: it must carry the public key this seed
  phrase gives for that provider and identity number (one call to the node for the network's parameters, as when the
  identity was collected). It does not check the provider's signature: the chain does, when an account is created.
- **Exported and held are separate.** `exportIdentity` exports the identity this object holds (collected, recovered or
  imported); `importIdentity` holds an exported one again, ready for the next steps. Deleting the wallet's copy is
  the wallet's own business; `dispose()` zeroes everything this object holds.
- **A server with many users** keeps each user's text in that user's own record, protected like the seed phrases
  (encrypted at rest, access-controlled). Another user's seed phrase cannot use it, and deleting the record (and the
  seed phrase) erases the identity from the server. Try it: `npm run example:server-keeps-identities` (read-only on
  testnet).

`importIdentity` refuses text it cannot use with `IdentityStorageError`:

| `reason` | Meaning |
|---|---|
| `unreadable` | not an exported identity; for another network; damaged; an unknown format version |
| `not-yours` | an identity that does not belong to this wallet's seed phrase |

### The format

The exact format (its fields, how ownership is checked, a test vector) is in
[`docs/storage-format.md`](docs/storage-format.md).

## Creating accounts

Once an identity is held (collected, recovered or imported), `createAccount` creates an account on
chain from it, with no ID App. It returns once the account is final, so the address always exists.

```js
import { ConcordiumIdentity, AccountCreationError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';

const identity = new ConcordiumIdentity(seedPhrase, config);
await identity.importIdentity(exported);   // the wallet's kept copy, or collected just now

const credNumber = await identity.nextCredNumber({ providerIndex: 0, identityIndex: 0 }); // the next new account
const { address, path, created } = await identity.createAccount({ providerIndex: 0, identityIndex: 0, credNumber });
// address: the new account; path: e.g. '0/0/0'; created: false if it already existed

// Use it like any other account, through the wallet package:
const wallet = new WalletManagerConcordium(seedPhrase, CONCORDIUM_TESTNET_CONFIG);
const account = await wallet.getAccountByPath(path);
```

- **Several accounts per identity:** `credNumber` 0, 1, 2…, below the identity's `maxAccounts` (200 on
  testnet). There is no default: say which account every time. `nextCredNumber` gives the number for a new
  account (one after the highest the identity has on chain), and `findAccounts` lists the existing ones. They are the same numbers as the wallet package's paths
  (`provider/identity/credNumber`), and `path` in the result is exactly what `getAccountByPath` takes.
- **Nothing about the person is revealed** on the account by default. To show attributes publicly, name
  them: `revealAttributes: ['countryOfResidence']`. Revealed values are public on chain.
- **Already exists:** if the account is already on chain (for example, created before an app restart), it
  is returned with `created: false` and nothing is sent. So calling again after a timeout or a crash is safe.
- **No fee:** creating an account is free on Concordium; the new account starts with a balance of 0.

A runnable example on testnet, using an identity exported by `npm run example:verify-identity`:
`npm run example:create-account` (`examples/create-account.mjs`; `IDENTITY_INDEX` and `CRED_NUMBER` choose the
identity and the account). It prints the address, the `path`, and a link to the account on CCDScan,
Concordium's testnet explorer.

The whole story with the wallet package, on testnet: `npm run example:wdk-end-to-end`
(`examples/wdk-end-to-end.mjs`). It creates an account from the exported identity, hands it to
`@concordium/wdk-wallet-concordium` with `getAccountByPath(path)`, receives CCD, a protocol-level token (TN) and a
CIS-2 token from a funding account, sends some of each back with the fee quoted first, and has a second new
account, holding no CCD, send a token to the first, its fee paid by a sponsor (three roles: sender,
recipient, sponsor). It needs a funded testnet account of your
own (see the file's header) and the wallet package installed in the repository root (`npm ci` there too).

What is sent is the account's *credential*: its public key, the identity provider's number, the identity's
dates, commitments to the attributes and zero-knowledge proofs that a verified identity stands behind it.
The identity itself and the person's details are not sent. It goes to the chain through your node connection
(`config.node`), and the package follows it there until it is final.

### When it fails

`AccountCreationError` with a `reason`:

| `reason` | Meaning | Sent? |
|---|---|---|
| `identity-expired` | the identity's `validTo` month has passed: the user verifies again for a new identity | no |
| `max-accounts` | `credNumber` is not below the identity's `maxAccounts` | no |
| `unknown-attribute` | an attribute to reveal is not one the identity holds (`detail` names it) | no |
| `rejected` | the node refused the credential, or it was finalized without creating the account (`detail` says) | yes |
| `expired` | the credential was not included on chain before its expiry time | yes |
| `timeout` | still not final after `timeoutMs` (default 5 minutes); it may still be created: call again | yes |
| `cancelled` | the wait was cancelled through `signal`; if already sent, it may still be created | maybe |
| `node` | the node could not be asked, or answered unexpectedly (`detail` has what it said) | maybe |

`address` (and `transactionHash`, once built) are on the error when known. For `timeout`, `cancelled` and
`node`, calling `createAccount` again is the way to find out: it returns the account if it was
created, and otherwise tries again.

### Keys

The account's keys come from the wallet's seed, as for the identity request; the seed itself is never handed
to Concordium's SDK. The SDK takes the derived keys as hex text, which JavaScript cannot wipe; the signing
key is held as bytes and zeroed straight after use, and short-lived text copies of the other keys exist until
garbage collection, as noted in the [storage threat model](docs/storage-format.md#threat-model).

## Getting the identity back (recovery)

The seed phrase is the user's backup. The wallet's exported copy of the identity is the everyday one, imported on
every app start; recovery is for when that copy is gone, for example on a new phone or after the app was reinstalled.
From the seed alone, the wallet asks the identity provider for the identity it issued, and the chain for the
identity's accounts. The user verifies nothing again.

How it works, briefly: the seed gives the same keys every time, so the wallet can rebuild the request for
"identity N with provider P" and prove it holds that identity's key, without sending the key. The provider
answers with the identity it issued for that key (or "none"), and the package checks it really belongs to
this seed before keeping it. Account addresses also come from the seed (account 0, 1, 2 …), so the wallet
works each one out and asks the chain whether it exists. Recovery only reads: it sends no transaction and
costs nothing.

### Everything at once: `recoverAll`

What a wallet calls on a new device:

```js
const identity = new ConcordiumIdentity(seedPhrase, config);
const wallet = new WalletManagerConcordium(seedPhrase, CONCORDIUM_TESTNET_CONFIG);   // the same seed

const { identities, problems } = await identity.recoverAll();
for (const { providerIndex, identityIndex, summary, accounts } of identities) {
  const exported = await identity.exportIdentity({ providerIndex, identityIndex }); // keep it in secure storage
  for (const { path } of accounts ?? []) {
    const account = await wallet.getAccountByPath(path);           // @concordium/wdk-wallet-concordium
  }
}
```

For each identity provider that publishes a recovery address, it asks for identity 0, 1, 2 … until three
numbers in a row have none, and finds each identity's accounts. Every identity found is held, exactly as
after verifying: keep it with `exportIdentity`, and, only if the user later wants another account,
`createAccount` can make one. The accounts it already has are in `accounts`.

- **`identities`**: each with its `summary` (dates, `maxAccounts`) and `accounts` (`credNumber`, `address`,
  `path`). `accounts` is `null` if the identity came back but its accounts could not be looked up just now:
  call `findAccounts` later.
- **`problems`**: anything that could not be done, as `{ providerIndex, identityIndex, error }`. A provider
  that is down is noted here and the others are still asked, so one failure never loses the rest.
  (`identityIndex` is `null` when the provider itself could not be used.)
- **Expired identities come back too.** Check `summary.validTo`: `createAccount` refuses an expired identity
  (`identity-expired`), and the user verifies again for a new one.
- Options: `providerIndexes` (only these providers), `identityGap` and `accountGap` (how many missing numbers
  in a row end the search; default 3 each), and `signal` (cancel).

### One identity, or its accounts: `recoverIdentity`, `findAccounts`

```js
const summary = await identity.recoverIdentity({ providerIndex: 0, identityIndex: 0 });
// → { providerIndex, identityIndex, createdAt, validTo, maxAccounts }, held; or null if the provider has none

const accounts = await identity.findAccounts({ providerIndex: 0, identityIndex: 0 });
// → [{ credNumber: 0, address: '4qXq…', path: '0/0/0' }, …]   (options: gap, signal)
```

`findAccounts` does not need the identity itself (addresses come from the seed and the provider's public
details), so it also works before or without recovering the identity. When the identity is held, it never
looks beyond the identity's `maxAccounts`.

### Number identities 0, 1, 2 …

The package never picks an identity or account number for you: `identityIndex` and `credNumber` are always
passed explicitly, so it never quietly uses the wrong identity or account. Two helpers give the number for a
new one: `nextIdentityIndex({ providerIndex })` (one after the highest identity this seed has with the provider,
found by asking its recovery address as `recoverAll` does) and `nextCredNumber({ providerIndex, identityIndex })`
(one after the highest account the identity has on chain).

Recovery finds identities by counting, so give each provider's identities the numbers 0, 1, 2 … in order,
and accounts 0, 1, 2 … under each identity (the two helpers do exactly that). A wallet that does so gets everything back with `recoverAll`
alone. An identity given a number far from the others (for example a random one, as the demo wallet does
on its shared test phrase) is not found by counting; `recoverIdentity` with its number still gets it back.
If your app leaves bigger gaps (an identity started but never finished, accounts skipped), raise
`identityGap` or `accountGap`. Keep your own list of the numbers you use.

Numbers must be within Concordium's ranges: provider and identity numbers up to 2147483647, account numbers up to
255 (an identity allows fewer: its `maxAccounts`). Bigger numbers are refused with a clear error; Concordium's SDK
would otherwise silently reduce some of them to another identity's or account's keys.

### When it fails

`IdentityRecoveryError` with a `reason`. "Not found" is not an error: `recoverIdentity` returns `null`.

| `reason` | Meaning | What a wallet does |
|---|---|---|
| `provider-error` | the provider answered with an error, or with something that is not an identity (`status`, `detail`) | show it; try again later |
| `network` | the provider could not be reached (after three tries) | check the connection; try again |
| `node` | finding accounts: the node could not be asked (`detail`) | try `findAccounts` again later |
| `not-yours` | the provider returned an identity that does not belong to this seed; it is never kept | should not happen: report it |
| `cancelled` | cancelled through `signal` | nothing |

`IdentityProviderError` if the provider is not published, or publishes no recovery address.

### Try it

`npm run example:recover-identity` (`examples/recover-identity.mjs`), read-only on testnet: a "new phone"
with only the public test phrase recovers its identities with `recoverAll`, saves them, finds their
accounts and reads their balances through the wallet package. Because that phrase is public and shared,
it may also find identities other people made with it (one is shown as expired).

## Proving facts (proofs)

A website can ask the wallet to prove a fact about the user, such as "over 18", "lives in the EU" or "not a
US resident", and the wallet answers **without revealing the detail itself**: the website learns "over 18",
not the date of birth. Only details the website explicitly asks to see (for example the nationality) are
shown.

How it works, briefly: when an account is created, the identity's details are pinned to it on chain,
sealed (as "commitments"): fixed, but unreadable without a secret that only the wallet's seed can work
out. The wallet's answer (a "verifiable presentation") is a proof about what is inside those seals, tied to
the website's question. The website checks it against the seals on chain. The identity itself never
leaves the wallet.

```
WEBSITE (its server)                         WALLET (the user's device)
requestFor ──── the question ──────────────► describeProofRequest  (the consent screen)
  keeps it                                   accountsThatCanAnswer (which account can truly answer)
                                             prove
checkPresentation ◄── the answer ───────────
  ├─ same question? accepted provider? right network?
  ├─ reads the account's record from the chain (a Concordium node)
  ├─ identity still valid? does the maths hold?
  ▼
{ ok, reasons, account, revealed }
```

The question and the answer are in Concordium's own format (account-based, sometimes called "version 0"),
exactly as WalletConnect's `request_verifiable_presentation` carries them, so the wallet side also answers
questions from other apps built for Concordium.

Concordium's newer **version 1** questions are supported too: the website records its question on chain first,
and the wallet answers from the identity itself, with no account. See
[Version 1: from the identity, with an anchor](#version-1-from-the-identity-with-an-anchor) below, and
[Which version?](#which-version) to choose.

### The wallet's side

```js
// The question, as it arrives: { challenge, credentialStatements }, or WalletConnect's { paramsJson }.
const asks = describeProofRequest(question);
// → [{ providers: [0, 1, 2], asks: [{ kind: 'range', attribute: 'dob',
//      text: 'prove you were born before 5 Nov 2008 (at least 18 years old), without showing your date of birth' }] }]

const accounts = await identity.accountsThatCanAnswer({ providerIndex: 0, identityIndex: 0, ...question });
// → [{ credNumber: 0, address: '46aP…', path: '0/0/0' }]   (empty if the identity cannot truly answer)
if (accounts.length === 0) { /* tell the user this identity cannot answer; decline */ }

const chosen = accounts[0];   // or let the user pick one of them
const answer = await identity.prove({ providerIndex: 0, identityIndex: 0, credNumber: chosen.credNumber, ...question });
// → the answer to send back (WalletConnect: { verifiablePresentationJson: answer.toString() })
```

- **Show `describeProofRequest` to the user before answering.** It reads and checks the question (no network,
  no secrets) and says, in plain English, what will be proven and what will be shown.
- **The wallet never makes a false answer.** `prove` refuses before building anything if the identity has
  expired, if the website does not accept the identity's provider, or if the identity's details do not
  satisfy the question. `accountsThatCanAnswer` returns no accounts in those cases, so an app can offer only
  accounts that can answer.
- The identity must be held (verified, imported, or recovered), and the account must exist on
  chain: the website checks the answer against it.

### The website's side: `@concordium/wdk-identity-concordium/verify`

A separate entry point, for servers (Node.js): checking needs a connection to a Concordium node, which
wallets never need.

```js
import { requestFor, checkPresentation, connectToNode } from '@concordium/wdk-identity-concordium/verify';

const node = connectToNode('testnet');   // Concordium's public node; or 'mainnet', or your node's address

// 1. Ask. Keep the question on your server: the answer is checked against it.
const question = requestFor({ providers: [0, 1, 2], adult: true });
// other options: minAge, residentIn, notResidentIn, nationalityIn, nationalityNotIn, documentValid, reveal;
// for a company (Business ID): registeredIn, notRegisteredIn, and reveal of lei, legalName, legalCountry, businessNumber,
// registrationAuth

// 2. Check the answer.
const result = await checkPresentation(answer, question, { node, network: 'testnet' });
// → { ok: true, account: '46aP…', revealed: {}, reasons: [] }
// or { ok: false, reasons: [{ reason: 'not-active', message: 'The identity behind part 1 of the answer is expired.' }] }
```

`checkPresentation` accepts the answer as an object, as JSON text, or as WalletConnect's
`{ verifiablePresentationJson }`. It accepts an answer only if all of these hold:

1. it answers **this** question: the same challenge, and exactly the statements asked (so an answer to an
   easier question, such as "over 5" for "over 18", is refused even though its maths holds);
2. the identity comes from a provider the question accepts, on the website's network;
3. the account is on chain, and its identity is **still valid** (not expired, and not before its start date);
4. the proof holds against the account's sealed details on chain (Concordium's own verifier).

A refused answer is a normal outcome: `ok: false` with the `reasons`. It throws (`ProofError`, reason
`node`) only when the node cannot be asked, so a website can tell "try again" from "not accepted".

### The website's own job

- **Accept one answer per question.** Keep each open question on your server, keyed by its challenge, with
  an expiry (a few minutes is typical; a database or Redis, which removes expired keys by itself, both
  work). When an answer arrives, take the question out and check the answer against it. A second answer to
  the same question then finds nothing and is refused. Without this, a copied answer could be used again:
  its maths still holds.
- **Keep the outcome, not the whole answer**, unless a regulation asks for it: for example "account 46aP…
  proved over 18 at 10:42 for question afd0…". Revealed details (a nationality, a name) are personal data:
  keep only what you need.
- **Use a fresh random challenge for every question.** `requestFor` makes one (32 random bytes). A fixed
  challenge lets an answer given to one website pass at any other website that uses the same one.
- **Work dates out on the day.** "Over 18" means "born before this date, 18 years ago". `requestFor` counts
  it from today each time; a date written once into code quietly turns "over 18" into "over 19" a year
  later.
- **Refuse identities that are not valid (Active).** An expired identity's proof still adds up
  mathematically; only its status on chain shows it has expired. `checkPresentation` refuses it; a website
  that checks proofs some other way must check the status itself.

### When it fails

`ProofError` with a `reason`, thrown when a question cannot be read, an answer cannot be made, or a check
cannot be done:

| `reason` | Meaning | What to do |
|---|---|---|
| `invalid-request` | the question is not one the package understands (the message says what is wrong) | the website fixes its question |
| `unknown-attribute` | the question names a detail an identity does not have | the website fixes its question |
| `not-held` | wallet: no identity held for that provider and number | verify, load or recover it first |
| `identity-expired` | wallet: the identity has expired; websites refuse its answers | the user verifies again for a new identity |
| `provider-not-accepted` | wallet: the website does not accept identities from this provider | answer with another identity, or decline |
| `cannot-prove` | wallet: the identity's details do not satisfy the question (e.g. under the age asked); nothing was made | tell the user; decline |
| `node` | the Concordium node could not be asked (`detail`): checking an answer, or (version 1) answering or asking | try again |
| `account-only` | wallet, version 1: the question accepts answers from an account only, not from the identity | ask the website for a question that accepts the identity, or a version 0 one |
| `anchor-not-found` | wallet, version 1: the question's anchor is not on chain, or not final yet (`detail`: `absent`, `received`, `committed`) | just after the website sent it: try again in a few seconds; `absent`: decline |
| `anchor-mismatch` | wallet, version 1: the anchor does not record this question (it was changed after it was recorded) | do not answer |
| `anchor-failed` | website, version 1: recording the question failed: the node refused the anchor, or it was rejected on chain (e.g. not enough CCD for the fee; `detail`) | fund the account that pays, or fix the keys; ask again |

Reasons `checkPresentation` returns for a refused answer (in `result.reasons`, each with a plain `message`):
`unreadable`, `challenge-mismatch`, `statements-mismatch`, `not-an-identity`, `wrong-network`,
`provider-not-accepted`, `not-on-chain`, `credential-mismatch`, `not-active`, `proof-invalid`.

### Try it

`npm run example:age-check` (`examples/age-check.mjs`), read-only on testnet: both sides in one run. A
shop asks "over 18?"; a "new phone" with only the public test phrase recovers its identities, skips an
expired one, and answers with an account that can; the shop checks the answer against the chain, then
refuses the same answer sent a second time.

### Version 1: from the identity, with an anchor

In Concordium's newer proofs, the website first **records its question on chain**: a small `registerData`
transaction holding a fingerprint (hash) of the question, called the **anchor**. It says, publicly and for
good: "this website asked this question, at this time". The wallet then answers **from the identity itself**:
no account is needed, and none is named, so the website learns "someone with an identity from provider 0 is over
18", not which account. The answer is tied to the anchor's block, so it answers that one question only.

```
WEBSITE (its server)                               CHAIN                  WALLET (the user's device)
requestForV1 ── records the question ────────────► the anchor (a fee)
  keeps the question; sends it ────────────────────────────────────────► describeProofRequest, describeProofContext
                                                   anchor on chain, ◄──── proveIdentity (from the identity)
                                                   final, this one?
checkPresentationV1 ◄── the answer ──────────────────────────────────────
  ├─ for this question? (context, statements, providers, where from, network)
  ├─ the anchor on chain and final; the answer tied to its block
  ├─ the identity still valid? does the maths hold?
  ▼
{ ok, reasons, revealed, credentials, auditRecord }
```

**The cost, and who pays.** Each question costs one transaction fee, about **EUR 0.013** (fees are set in euros;
on 7 Nov 2026 about 5 CCD on testnet). The website needs an account to send the anchor (a company gets one with
a Concordium Business ID). With a **sponsor**, another account pays the fee and signs too, so the website's own
account can hold **no CCD at all**: for example a payment partner paying for its shops' questions.

#### Which version?

| | Version 0 (account-based) | Version 1 (identity-based, anchored) |
|---|---|---|
| The website pays | nothing | one fee per question, about EUR 0.013 (or its sponsor does) |
| The website needs an account | no | yes (to send the anchor) |
| The user needs an account | yes, on chain | no |
| The website learns which account answered | yes | no (only the provider) |
| A public record that the question was asked | no | yes, the anchor |
| The wallet checks the question on chain | no | yes (its anchor, through the wallet's node) |
| Who uses it today | Concordium's apps and wallets, WalletConnect's `request_verifiable_presentation` | Concordium's newer tools (its verifier service) |

Both are in Concordium's own formats; a wallet can support both, and this package does.

#### The wallet's side

```js
// The question, as it arrives: Concordium's VerificationRequestV1 as JSON (an object or text), or { paramsJson }.
const asks = describeProofRequest(question);
// → [{ providers: [0, 1, 2], network: 'testnet', answerFrom: 'identity', asks: [{ kind: 'range', attribute: 'dob',
//      text: 'prove you were born before 8 Nov 2008 (at least 18 years old), without showing your date of birth' }] }]
const asking = describeProofContext(question);
// → { network: 'testnet', website: 'age-check.example', purpose: 'age check', connection: '…', anchor: 'c921…' }

const answer = await identity.proveIdentity({ providerIndex: 0, identityIndex: 1, request: question });
// → the answer to send back: JSON.stringify(answer)
```

- **Show both descriptions before answering.** `describeProofContext` gives who is asking, as the website wrote it
  into its question. The anchor makes it unchangeable, but the website chose it: **compare `website` with the site
  the wallet is actually connected to** before showing it as fact.
- **The wallet never makes a false answer**, as in version 0: `proveIdentity` refuses before building anything, or
  asking the node, if the identity has expired, if its provider is not accepted, if its details do not satisfy the
  question, or if the question accepts answers from an account only (`account-only`).
- **It checks the anchor** through the wallet's node (`config.node`): not on chain or not final yet
  (`anchor-not-found`; just after the website sent it, try again in a few seconds), or not this question
  (`anchor-mismatch`: do not answer).
- If the question asks the wallet to fill something in besides the anchor's block (rare), pass it as `context`,
  e.g. `{ ResourceID: 'shop.example' }`, the site the wallet is connected to.

#### The website's side

```js
import { requestForV1, checkPresentationV1, connectToNode } from '@concordium/wdk-identity-concordium/verify';
import { buildBasicAccountSigner } from '@concordium/web-sdk';

const node = connectToNode('testnet');

// 1. Ask: build the question and record it on chain (waits until the anchor is final). Keep the question.
const question = await requestForV1(
  { network: 'testnet', website: 'age-check.example', purpose: 'age check', providers: [0, 1, 2], adult: true },
  {
    node,
    sender: shopAddress, signer: buildBasicAccountSigner(shopKey),                       // the website's account
    sponsor: { address: partnerAddress, signer: buildBasicAccountSigner(partnerKey) },   // optional: pays the fee
  },
);
// the same options as requestFor, plus website, purpose, connection, and answerFrom: 'identity' (default),
// 'account' or 'either'

// 2. Check the answer.
const result = await checkPresentationV1(answer, question, { node, network: 'testnet' });
// → { ok: true, revealed: {}, credentials: [{ from: 'identity', issuer: 0, revealed: {} }], auditRecord: {…}, reasons: [] }
```

`checkPresentationV1` accepts an answer only if it answers **this** question (the same nonce, website and purpose,
exactly the statements asked, from where the question allows), comes from an accepted provider on the website's
network, is tied to the block of the question's anchor (which must be on chain, final, and record this
question), comes from an identity that is still valid, and holds mathematically (Concordium's own verifier).
Answers from an account, which other wallets may send where the question allows it, are checked too, with the
account's provider read from the chain. Refused answers return `ok: false` with the `reasons`: `unreadable`,
`context-mismatch`, `statements-mismatch`, `not-an-identity`, `wrong-network`, `source-not-accepted`,
`provider-not-accepted`, `anchor-not-found`, `anchor-mismatch`, `block-mismatch`, `not-on-chain`,
`credential-mismatch`, `not-active`, `proof-invalid`.

It does these checks itself, with Concordium's lower-level functions, rather than calling the SDK's all-in-one
`VerificationAuditRecordV1.createChecked`: in SDK 12.0.2 that function does not wait for its own context
comparison, so an answer to another question with the same statements is accepted.

#### The website's own job (version 1)

- **Accept one answer per question**, as in version 0, keyed by the question's anchor (`transactionRef`).
- **Keep the audit record** of an accepted answer (`result.auditRecord`: the question and the answer), if you need
  to show later that the check was done; it holds any details shown, so keep only what you need.
- **Keep the paying account funded.** A question cannot be asked without its fee (`anchor-failed`).
- The anchor is public: it shows that your account asked a question, and when, but not what or of whom (only a
  fingerprint of the question is on chain).

#### Try it (version 1)

`npm run example:age-check-v1` (`examples/age-check-v1.mjs`) on testnet: both sides in one run. A shop whose
account has never held CCD asks "over 18?", and its sponsor pays the fee (**each run spends one anchor fee**, about
5 testnet CCD, from the sample's sponsor account); a "new phone" with only the public test phrase recovers its
identities, skips the expired one, and answers from the other identity, with no account; the shop checks the
answer and keeps the audit record, then refuses the same answer sent a second time.

### Limits, for now

- Proofs about Concordium identities only, not about Web3 ID credentials issued by smart contracts.
- Version 1: the wallet answers from the identity; a question that accepts answers from an account only is
  declined (`account-only`), since such a question can be asked as version 0 at no cost.
- Tested on testnet. Compatibility with other Concordium apps was tested by answering the exact questions
  of Concordium's published example apps and checking the answers with Concordium's verifier, not by
  running those apps.

## Company identities (Business ID)

A company can have a Concordium identity of its own, a **Business ID**: it holds the company's Legal Entity
Identifier (LEI), legal name, country of registration, business number and registration authority, checked by an
identity provider from the company's documents and the ID of the person signing for it. With it, the company's
wallet creates accounts for the company and proves facts about it, as a person's wallet does for a person: for
example to a bank, "here is our LEI, and we are registered in the EU".

Business IDs are issued by **Global FinReg** (testnet provider 4, mainnet provider 3). A company identity is made,
kept, recovered and used with **exactly the same calls** as a person's; only the provider differs.

**1. Pass the full provider list.** The wallet-proxy's `/v2/ip_info` lists every provider, including the company
ones; `/v1/ip_info` leaves the company ones out.

```js
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const companies = (await new IdentityProviders(identityProviders).list()).filter((p) => p.kind === 'company');
// → [{ index: 4, name: 'Global FinReg Testnet', display: 'Global FinReg (Business ID)', kind: 'company', … }]
```

Concordium documents no field that marks a Business ID provider, so the package infers `kind` from what the provider
publishes: its display name mentions "Business ID", or its issuance address ends with `/company`
(`src/providers/provider-kind.js`, one function, with its sources).

**2. Verify the company**, as for a person ([Starting identity verification](#starting-identity-verification)):

```js
const { issuanceUrl } = await identity.createIdentityRequest({ providerIndex: 4, identityIndex, redirectUri });
// → Global FinReg's company verification page: the company signs in or registers, and gives its LEI, its company
//   documents and the ID of the person signing for it. Then, as for a person: waitForIdentity / retrieveIdentity,
//   exportIdentity, createAccount.
```

**3. Ask a company to prove facts about itself**, with the same functions as for a person
([Proving facts](#proving-facts-proofs)), naming the Business ID providers:

```js
const question = requestFor({ providers: [4], reveal: ['lei', 'legalName'], registeredIn: ['DK', 'SE', 'DE'] });
describeProofRequest(question)[0].asks.map((a) => a.text);
// → [ 'prove the company is registered in one of: DK, SE, DE (without showing which)',
//     "show the company's legal entity identifier (LEI)", "show the company's legal name" ]
```

| Option (`requestFor`, `requestForV1`) | Asks |
| --- | --- |
| `reveal: ['lei', 'legalName', 'legalCountry', 'businessNumber', 'registrationAuth']` | to show these company details |
| `registeredIn: [countries]` | to prove the country of registration is one of these, without showing it |
| `notRegisteredIn: [countries]` | to prove it is none of these |

The consent wording says "the company's …" for company details, and "your …" for a person's. A person's identity
asked a company question refuses it before building anything: `provider-not-accepted` if the question accepts only
Business ID providers, or `cannot-prove` ("The identity has no legal entity identifier (LEI) …").

**What can be tested, and what needs a real company.** Global FinReg has no test mode: its page asks the company to
sign in or register, and completing a Business ID needs a real company with an LEI and its documents. So the package
is tested live up to Global FinReg's company verification page (which accepts its requests on testnet and mainnet),
and for the questions a company is asked and how they read. Collecting, keeping, creating accounts and answering use
the same code as for a person's identity, which is tested live on testnet. Please do not register a made-up company
with Global FinReg: it is its real onboarding service, also on testnet.

**Try it:** [`examples/company-identity/`](examples/company-identity/): `npm run example:company-providers`,
`npm run example:company-verify` (`CHECK_ONLY=1` stops once the company page has opened) and
`npm run example:company-questions`. All read-only on testnet.

## Handling errors

Every error the package throws has a name, and most have a `reason`: a short code the wallet acts on; its `message`
is plain English, safe to log and to show (it never contains a seed phrase or a key). Each section above lists its
errors. `npm run example:handle-errors` (read-only on testnet) makes each error of both packages happen and turns it
into a message for the user, with one function a wallet can copy.

## Optional: built-in callback listener (Node.js desktop apps)

Wallets that catch the provider's return themselves (a mobile app's own scheme,
or a page of a web wallet) do not need this. For a Node.js wallet app on the
user's own computer (a desktop app), the package can catch the return itself, on
`127.0.0.1`. A wallet run on a server cannot use it: the user's browser is on
another computer, so it uses its own return page, as a web wallet does. It comes from a separate entry
point, `@concordium/wdk-identity-concordium/node`, for optional Node.js extras,
so the main entry stays usable where there is no web server.

```js
import { listenForIdentityCallback } from '@concordium/wdk-identity-concordium/node';

const listener = await listenForIdentityCallback();
// listener.redirectUri: 'http://127.0.0.1:53817/identity-callback/9f2c…'

const { issuanceUrl } = await identity.createIdentityRequest({
  providerIndex: 0, redirectUri: listener.redirectUri,
});
// open issuanceUrl in the user's browser …

const summary = await identity.retrieveIdentity(await listener.callback);
```

When the browser arrives, the listener serves a small page whose script posts the
full address back (browsers never send the part after `#` to a server), shows
"You can close this tab", and closes. It listens on 127.0.0.1 only, at a random
secret path, and accepts a single callback; other requests are refused.

| Option | Default | Meaning |
|---|---|---|
| `port` | 0 (any free port) | port on 127.0.0.1; set one if the return address must be fixed |
| `timeoutMs` | 900000 (15 minutes) | stop waiting if the browser never comes back |
| `signal` | none | an `AbortSignal`, e.g. from a Cancel button |

`listener.callback` rejects with `IdentityIssuanceError` reason `'timeout'` or
`'cancelled'`; `listener.close()` stops listening early. A provider that cannot
read the request shows an error page and never sends the browser back, so give
the user a way to cancel.

A runnable example of the whole flow on testnet, saving the identity in `./demo-identities` (a plain file, for its
test identities only: a real wallet keeps it in secure storage): `npm run example:verify-identity` (`examples/verify-identity.mjs`; set
`OPEN_BROWSER=1` to open the verification page for you). Load it again in a new program with
`npm run example:load-identity`.

## Development

```bash
cd identity
npm ci
npm test                  # unit tests, offline
npm run test:integration  # live: the testnet provider accepts our request, and recovery works (read-only)
WRITE=1 npm run test:integration   # also creates a real account on testnet (free, but permanent; see below)
npm run check:providers   # live: report on every provider, testnet and mainnet
npm run fixtures          # re-capture the recorded wallet-proxy data used by the tests
```

Unit tests use recorded testnet and mainnet wallet-proxy data from
`test/fixtures`, so they run without network access. Re-capture it when the
published providers or parameters may have changed, and review the diff.

`check:providers` builds a request for every provider the testnet and mainnet
wallet-proxies publish (pass `testnet` or `mainnet` to check one network) and
reports, per provider, whether it serves its verification page or answers with
an error. It stops there: nothing is filled in and no identity is issued. Each
request comes from a fresh random seed that is never stored. A provider error
is reported, not treated as a failure; the integration test, by contrast, fails
if the Concordium testnet provider does not accept the request.

The `WRITE=1` live test creates accounts under the public "abandon" test phrase's recorded identity
(provider 0, identity index 334563111), using account numbers 100–199, which are reserved for it: each run
creates the first unused one, so the test's accounts are easy to recognise. When all are used, it fails and
says so. Concordium's CI never runs it.

## License

Apache-2.0
