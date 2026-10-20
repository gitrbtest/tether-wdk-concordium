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
> providers and starting identity verification. Collecting the issued
> identity, encrypted storage and account creation are planned.

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

identity.dispose(); // zero the seed when the identity is no longer needed
```

- **The seed** is the wallet's BIP-39 seed phrase or its 64-byte seed: the same
  seed the wallet package uses. The identity keeps its own copy;
  `dispose()` zeroes it, after which calls that need the seed throw.
- **`redirectUri`** is any absolute URL, including an app's own scheme. It is
  passed to the provider exactly as given, so it can match an address
  registered with the provider. There is no default.
- **Nothing is sent to the provider** until the wallet opens `issuanceUrl`.
  Building the request only reads public data from the wallet-proxy (the
  provider list and the cryptographic parameters); the request itself is
  computed locally. Nothing is written to the blockchain.
- A provider that is not published, or publishes no issuance address, raises
  `IdentityProviderError` before any cryptographic work is done.

## Development

```bash
cd identity
npm ci
npm test          # unit tests, offline
npm run fixtures  # re-capture the recorded wallet-proxy data used by the tests
```

Unit tests use recorded testnet and mainnet wallet-proxy data from
`test/fixtures`, so they run without network access. Re-capture it when the
published providers or parameters may have changed, and review the diff.

## License

Apache-2.0
