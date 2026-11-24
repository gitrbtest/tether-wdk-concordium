# The identity package inside WDK (a proposal)

A short guide to `@concordium/wdk-identity-concordium/wdk`: what it is, how it maps onto the package, and how it was
tested. The WDK side of the proposal is explained in
[the WDK fork's proposal document](https://github.com/gitrbtest/wdk/blob/feature/identity/docs/proposals/identity.md).

## Why

WDK's `registerProtocol` accepts six kinds of protocol (swap, bridge, lending, fiat, swidge, SDA) and ignores anything
else, and its protocols act on an existing account. On Concordium the identity comes first and accounts are created
from it. So the proposal adds a place for identity to WDK, and this entry is Concordium's implementation of it:

```
WDK (proposal fork)                         this package's /wdk entry           this package (unchanged)
──────────────────                          ─────────────────────────           ────────────────────────
abstract IdentityManager   ◄── extends ──   ConcordiumIdentityManager   ──►     ConcordiumIdentity
abstract IdentityProtocol  ◄── extends ──   ConcordiumIdentityProtocol  ──►     describeProofRequest, prove
registerIdentity, registerIdentityProtocol, getIdentity, getIdentityProtocol: WDK builds both, with its seed
```

## Using it

```js
import WDK from '@tetherto/wdk';
import { ConcordiumIdentityManager, ConcordiumIdentityProtocol } from '@concordium/wdk-identity-concordium/wdk';

const wdk = new WDK(seedPhrase)
  .registerWallet('concordium', WalletManagerConcordium, { ...CONCORDIUM_TESTNET_CONFIG })
  .registerIdentity('concordium', ConcordiumIdentityManager, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node })
  .registerIdentityProtocol('concordium', 'concordium-id', ConcordiumIdentityProtocol);

const identities = wdk.getIdentity('concordium');
const { url, identity } = await identities.startVerification({ provider: '0', returnUrl });
await identities.completeVerification(identity, returnedUrl);   // returnedUrl: where the provider sent the user back
const { path } = await identities.createAccount(identity);

const account = await wdk.getAccountByPath('concordium', path);
const proof = await account.getIdentityProtocol('concordium-id').prove(question);
```

The configuration is `ConcordiumIdentity`'s, plus its options `fetch` and `cryptography`. An identity is referred to
as `{ providerIndex, identityIndex }`. `@tetherto/wdk-wallet` is an optional peer dependency: the app's single copy
must be the one WDK uses, so that WDK recognises the identity protocol class.

## How it maps onto the package

| WDK method | Calls | Notes |
|---|---|---|
| `getProviders()` | `IdentityProviders.list()` | checked against the chain; each provider's published description and website |
| `startVerification({ provider, returnUrl, identityIndex? })` | `nextIdentityIndex`, `createIdentityRequest` | `provider` is an id from `getProviders()` (`ValueError` otherwise) |
| `completeVerification(identity, reply)` | `retrieveIdentity` | |
| `recover()` | `recoverAll` | refused (`PROVIDER_ERROR`, try again) if a provider could not be asked part way, rather than a silently shorter list |
| `createAccount(identity, { index? })` | `nextCredNumber`, `createAccount` | returns `{ path, address }` for `wdk.getAccountByPath` |
| `exportIdentity` / `importIdentity` | the same | |
| `prove(identity, request)` | `prove` | from the identity itself, naming no account |
| protocol `describeRequest(request)` | `describeProofRequest`, `describeProofContext` | the consent wording |
| protocol `prove(request)` | `prove` with the account's number | read from the account's path `'<provider>/<identity>/<account>'` |

## Errors

The package's errors come out as WDK's `IdentityError`, with the package's own error as its `cause`:

| `reason` | From |
|---|---|
| `PROVIDER_ERROR` | the provider failed, or could not be asked or used |
| `VERIFICATION_REJECTED` | the provider refused, or what came back is not a genuine identity for this seed |
| `IDENTITY_NOT_FOUND` | the identity is not held, or not this seed's |
| `IDENTITY_EXPIRED` | the identity is no longer valid |
| `ACCOUNT_LIMIT_REACHED` | the identity has no accounts left |
| `INVALID_REQUEST` | the website's question is not valid (or not anchored, or not final yet) |
| `CANNOT_PROVE` | the identity cannot truly answer it (e.g. younger than asked), or the question does not accept it |
| `CHAIN_ERROR` | the chain refused or did not confirm (e.g. creating an account), or could not be reached |

A disposed manager throws `DisposalError`, and invalid options `ValueError`, as WDK's wallets do.

## Tested

- `test/unit/9-wdk/wdk-identity.test.mjs`, 18 tests through the proposal's WDK, offline: registering, the providers,
  verification, export and import, recovery on a new phone (including a provider failing part way), the consent
  wording, a proof from an account checked with Concordium's own verifier, every error reason, disposal. Also on
  Node.js 18.
- `npm run example:wdk-identity`: the whole journey live on testnet (verify with the test provider, create an account,
  get it through WDK, prove "over 18" from it); the shop's check accepted it.

## Try it

```bash
git clone https://github.com/gitrbtest/tether-wdk-concordium.git
cd tether-wdk-concordium
git checkout p2/21-wdk-identity
npm install                      # the repository root: the Concordium wallet module, which the demo uses too
cd identity
npm install                      # this package, with the WDK forks
npm run example:wdk-identity     # OPEN_BROWSER=1 opens the provider's page for you
```

Concordium's test provider shows a form with made-up details: keep them and press Submit. The demo writes to testnet:
an identity and an account (free), and the shop's question (about 5 testnet CCD, paid by a sponsor account). Tests:
`npm test` in `identity/` (offline).

## Status

A proposal: it depends on the WDK forks
([wdk](https://github.com/gitrbtest/wdk/tree/feature/identity),
[wdk-wallet](https://github.com/gitrbtest/wdk-wallet/tree/feature/identity)), installed as this package's dev
dependencies. Nothing changes in the package's main entry. If Tether accepts the WDK changes, the dependency lines move
to Tether's published versions; names and shapes may change with their review.
