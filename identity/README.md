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
> may change until the first release.

## Requirements

Node.js 18+, using ES modules, the same as `@concordium/wdk-wallet-concordium`.

## Development

```bash
cd identity
npm ci
npm test          # unit tests, offline
```

## License

Apache-2.0
