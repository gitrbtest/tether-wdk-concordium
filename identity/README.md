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
> may change until the first release. Available today: the network configuration
> presets and listing identity providers. Identity verification, encrypted
> storage and account creation are planned.

## Requirements

Node.js 18+, using ES modules, the same as `@concordium/wdk-wallet-concordium`.

## Configuration

```js
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG, // { walletProxyUrl: 'https://wallet-proxy.mainnet.concordium.software' }
  CONCORDIUM_TESTNET_IDENTITY_CONFIG, // { walletProxyUrl: 'https://wallet-proxy.testnet.concordium.com' }
} from '@concordium/wdk-identity-concordium';
```

| Field | Required | Meaning |
|---|---|---|
| `walletProxyUrl` | yes | Absolute HTTP(S) URL of a Concordium wallet-proxy, which publishes the identity providers. A base path is allowed; credentials, query parameters and fragments are not. |

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

## Development

```bash
cd identity
npm ci
npm test          # unit tests, offline
```

## License

Apache-2.0
