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
> providers, starting identity verification and collecting the issued
> identity. Encrypted storage and account creation are planned.

## Requirements

Node.js 18+, using ES modules, the same as `@concordium/wdk-wallet-concordium`.

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

**Resuming after a restart.** Verification can take a while. To survive an app
restart, read the reply first and save the `code_uri` with the provider and
identity index, then wait in a new object:

```js
const { codeUri } = identity.parseIdentityCallback(callbackUrl); // no network call
// … save codeUri, providerIndex and identityIndex; after a restart:
const summary = await identity.waitForIdentity(codeUri, { providerIndex: 0, identityIndex: 0 });
```

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

## Development

```bash
cd identity
npm ci
npm test                  # unit tests, offline
npm run test:integration  # live: the testnet identity provider accepts our request
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

## License

Apache-2.0
