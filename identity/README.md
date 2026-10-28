# @concordium/wdk-identity-concordium

Identity companion for [`@concordium/wdk-wallet-concordium`](../README.md).

On Concordium, an account can only exist once a verified identity stands
behind it. This package lets a wallet obtain that identity from the wallet's
own seed, without the Concordium ID App:

- start identity verification with an identity provider and collect the issued identity,
- keep the identity in encrypted storage that the wallet chooses,
- create Concordium accounts from the stored identity.

Accounts created this way are then used through `@concordium/wdk-wallet-concordium`
like any other account.

> **Status: in development.** The package is not published yet, and its API
> may change until the first release. Available today: listing identity
> providers, starting identity verification, collecting the issued identity,
> saving it encrypted, and creating accounts from it (tested on testnet).

## Requirements

Node.js 18+, using ES modules, the same as `@concordium/wdk-wallet-concordium`.

The main entry uses no Node.js-only features (a test enforces this), so it is meant to run in browsers
and mobile runtimes too; so far it is tested on Node.js. Node.js-only extras (the callback listener, the
file store) come from a separate entry point, `@concordium/wdk-identity-concordium/node`.

## Configuration

```js
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG, // { useMainnetKeyDerivation: true,  walletProxyUrl: 'https://wallet-proxy.mainnet.concordium.software' }
  CONCORDIUM_TESTNET_IDENTITY_CONFIG, // { useMainnetKeyDerivation: false, walletProxyUrl: 'https://wallet-proxy.testnet.concordium.com' }
} from '@concordium/wdk-identity-concordium';
```

| Field | Required | Meaning |
|---|---|---|
| `useMainnetKeyDerivation` | yes | Derive keys as on mainnet (`true`) or testnet (`false`). Same meaning as in `@concordium/wdk-wallet-concordium`: **use the same value for both packages**, so identities and accounts come from the same keys. It does not check which network the URL belongs to. |
| `walletProxyUrl` | yes | Absolute HTTP(S) URL of a Concordium wallet-proxy, which publishes the identity providers and the network's cryptographic parameters. A base path is allowed; credentials, query parameters and fragments are not. |

Presets can be overridden field by field, e.g. to use your own wallet-proxy:
`{ ...CONCORDIUM_MAINNET_IDENTITY_CONFIG, walletProxyUrl: 'https://proxy.example.com' }`.

## Identity providers

```js
import { IdentityProviders, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';

const providers = new IdentityProviders(CONCORDIUM_TESTNET_IDENTITY_CONFIG);

await providers.list();
// [ { index: 0, name: 'Concordium testnet IP', issuanceStart: 'https://…', recoveryStart: 'https://…' }, … ]

await providers.get(0); // one provider, with the keys and anonymity revokers a request is built from
```

A provider's `index` is an identifier assigned per network, not a position in
the list, and the same provider can have different indices on testnet and
mainnet. Use the index of the provider the user chooses. `get` throws
`IdentityProviderError` for an index that is not published on the network.
Addresses are returned exactly as each provider publishes them, or `null`.

## Starting identity verification

```js
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';

const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG);

const { issuanceUrl } = await identity.createIdentityRequest({
  providerIndex: 0,                                    // required
  redirectUri: 'https://wallet.example/identity/return', // required
  // identityIndex: 0,                                 // optional; which of the wallet's identities with this provider
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
  Building the request only reads public data from the wallet-proxy (the
  provider list and the cryptographic parameters); the request itself is
  computed locally. Nothing is written to the blockchain.
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
return page (`location.href`), or, on a desktop or server, the optional
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
const resumed = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { store });
const summary = await resumed.waitForIdentity(pending.codeUri,
  { providerIndex: pending.providerIndex, identityIndex: pending.identityIndex });
```

(`appStorage` stands for wherever the app keeps its own small settings.) Without this,
an app closed during the wait loses the reply, and the user has to verify again.

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

## Saving and loading identities

An identity is saved **encrypted**, in a store the wallet chooses: memory, files, a database, a backend.
The store only ever receives encrypted bytes and a slot name such as
`concordium-identity/testnet/0/594450697`; it never sees the identity, and cannot read it without the
wallet's seed.

```js
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { FileIdentityStore } from '@concordium/wdk-identity-concordium/node';

const store = new FileIdentityStore('./identities');
const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { store });

await identity.retrieveIdentity(callbackUrl);                          // collect, as above
await identity.saveIdentity({ providerIndex: 0, identityIndex: 0 });   // → { …summary, slotName }

// Later, e.g. after an app restart, in a new object with the same seed and store:
const summary = await identity.loadIdentity({ providerIndex: 0, identityIndex: 0 }); // summary, or null
await identity.deleteIdentity({ providerIndex: 0, identityIndex: 0 });               // removes the saved copy
```

- **The encryption key comes from the seed** each time it is needed and is wiped after use; it is never
  stored. No password, nothing extra for the user to remember.
- **Loading needs no network call.** Decrypting proves the identity was saved with this seed for this slot.
- **Saved and held are separate.** `saveIdentity` saves the identity this object holds (collected or
  loaded); `loadIdentity` holds a saved one again, ready for the next steps. `deleteIdentity` removes
  the saved copy only; `dispose()` zeroes everything the object holds.

### Saving over an existing identity

`saveIdentity` never silently replaces a different identity:

| Already saved in the slot | `saveIdentity` |
|---|---|
| nothing | saves |
| the same identity | saves again (harmless) |
| a different identity (e.g. an earlier one, before the user verified again) | `IdentityStorageError` reason `'slot-in-use'`, unless `{ replace: true }` |
| bytes this seed cannot decrypt | `IdentityStorageError` reason `'unreadable-slot'`, unless `{ replace: true }` |

Replacing a verified identity costs the user a new verification, so **ask the user before passing
`{ replace: true }`**. `loadIdentity` reports bytes it cannot decrypt (another seed, damaged data, an
unknown format version) as `IdentityStorageError` reason `'unreadable-slot'`.

### Stores

| Store | From | For |
|---|---|---|
| `MemoryIdentityStore` | main entry | tests and short-lived processes; nothing survives the process |
| `FileIdentityStore(folder)` | `/node` | desktop and server wallets: one file per slot, written safely (a temporary file, then one replacing step), owner-only permissions on macOS and Linux. On Windows, access follows the folder's permissions: keep it where only the user can reach it (e.g. inside their user profile). |
| your own | — | anything else: a database, your backend, a phone's storage |

### Writing your own store

A store is any object with three async methods:

```js
const store = {
  async save(slotName, bytes) { … },  // save the bytes (Uint8Array), replacing anything saved under that name
  async read(slotName) { … },         // the bytes saved under that name, or null
  async delete(slotName) { … },       // remove them; nothing saved there is not an error
};
```

For example, on PostgreSQL:

```js
// CREATE TABLE identities (slot TEXT PRIMARY KEY, data BYTEA NOT NULL)
const databaseStore = {
  async save(slotName, bytes) {
    await pool.query('INSERT INTO identities (slot, data) VALUES ($1, $2) '
      + 'ON CONFLICT (slot) DO UPDATE SET data = EXCLUDED.data', [slotName, Buffer.from(bytes)]);
  },
  async read(slotName) {
    const { rows } = await pool.query('SELECT data FROM identities WHERE slot = $1', [slotName]);
    return rows.length ? new Uint8Array(rows[0].data) : null;
  },
  async delete(slotName) {
    await pool.query('DELETE FROM identities WHERE slot = $1', [slotName]);
  },
};
```

Check your store against the contract in your own tests, with any test framework. It saves and deletes
a few slots of its own (`concordium-identity-store-check/…`), so run it against a test instance:

```js
import { verifyIdentityStore } from '@concordium/wdk-identity-concordium/testing';

test('our identity store meets the contract', async () => {
  await verifyIdentityStore(databaseStore); // throws naming the first check that failed
});
```

A runnable example on a real SQL database (SQLite, built into Node.js 22.13+), showing that the table
only holds slot names and encrypted bytes: `npm run example:database-store`
(`examples/database-store.mjs`).

### The format

The exact format (key derivation, encryption, byte layout, a test vector) and the threat model are in
[`docs/storage-format.md`](docs/storage-format.md).

## Creating accounts

Once an identity is held (collected, or loaded from the store), `createAccount` creates an account on
chain from it, with no ID App. It returns once the account is final, so the address always exists.

```js
import { ConcordiumIdentity, AccountCreationError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';

const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { store });
await identity.loadIdentity({ providerIndex: 0, identityIndex: 0 });   // or collected just now

const { address, path, created } = await identity.createAccount({ providerIndex: 0, identityIndex: 0 });
// address: the new account; path: '0/0/0'; created: false if it already existed

// Use it like any other account, through the wallet package:
const wallet = new WalletManagerConcordium(seedPhrase, CONCORDIUM_TESTNET_CONFIG);
const account = await wallet.getAccountByPath(path);
```

- **Several accounts per identity:** `credNumber` 0, 1, 2… (default 0), below the identity's
  `maxAccounts` (200 on testnet). They are the same numbers as the wallet package's paths
  (`provider/identity/credNumber`), and `path` in the result is exactly what `getAccountByPath` takes.
- **Nothing about the person is revealed** on the account by default. To show attributes publicly, name
  them: `revealAttributes: ['countryOfResidence']`. Revealed values are public on chain.
- **Already exists:** if the account is already on chain (for example, created before an app restart), it
  is returned with `created: false` and nothing is sent. So calling again after a timeout or a crash is safe.
- **No fee:** creating an account is free on Concordium; the new account starts with a balance of 0.

What is sent is the account's *credential*: its public key, the identity provider's number, the identity's
dates, commitments to the attributes and zero-knowledge proofs that a verified identity stands behind it.
The identity itself and the person's details are not sent. It goes through the configured wallet-proxy
(`/v0/submitCredential`), which passes it to the chain; no node connection is needed.

### When it fails

`AccountCreationError` with a `reason`:

| `reason` | Meaning | Sent? |
|---|---|---|
| `identity-expired` | the identity's `validTo` month has passed: the user verifies again for a new identity | no |
| `max-accounts` | `credNumber` is not below the identity's `maxAccounts` | no |
| `unknown-attribute` | an attribute to reveal is not one the identity holds (`detail` names it) | no |
| `rejected` | the chain refused the credential (`detail` has its reason, if it gave one) | yes |
| `expired` | the credential was not included on chain before its expiry time | yes |
| `timeout` | still not final after `timeoutMs` (default 5 minutes); it may still be created: call again | yes |
| `cancelled` | the wait was cancelled through `signal`; if already sent, it may still be created | maybe |
| `wallet-proxy` | the wallet-proxy failed or answered unexpectedly (`detail` has what it said) | maybe |

`address` (and `transactionHash`, once built) are on the error when known. For `timeout`, `cancelled` and
`wallet-proxy`, calling `createAccount` again is the way to find out: it returns the account if it was
created, and otherwise tries again.

### Keys

The account's keys come from the wallet's seed, as for the identity request; the seed itself is never handed
to Concordium's SDK. The SDK takes the derived keys as hex text, which JavaScript cannot wipe; the signing
key is held as bytes and zeroed straight after use, and short-lived text copies of the other keys exist until
garbage collection, as noted in the [storage threat model](docs/storage-format.md#threat-model).

## Optional: built-in callback listener (Node.js desktop and server wallets)

Wallets that catch the provider's return themselves (a mobile app's own scheme,
or a page of a web wallet) do not need this. For Node.js wallets on a desktop or
server, the package can catch the return itself. It comes from a separate entry
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

A runnable example of the whole flow on testnet, saving the identity encrypted in
`./demo-identities`: `npm run example:verify-identity` (`examples/verify-identity.mjs`; set
`OPEN_BROWSER=1` to open the verification page for you). Load it again in a new program with
`npm run example:load-identity`.

## Development

```bash
cd identity
npm ci
npm test                  # unit tests, offline
npm run test:integration  # live: the testnet identity provider accepts our request
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
