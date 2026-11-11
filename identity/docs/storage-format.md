# Exported identity format

This describes exactly what `exportIdentity` of `@concordium/wdk-identity-concordium` gives the wallet to keep, and
how `importIdentity` reads it back, so the format can be reviewed, and read by other implementations (for example a
native mobile wallet sharing the same data). The code is in
[`src/storage/identity-export.js`](../src/storage/identity-export.js).

> **The exported identity is NOT encrypted.** It is plain JSON text holding the person's verified details: name,
> date of birth, nationality, ID document number and the other details the provider checked. Anyone who has the text
> can read them. **Keep it like any other secret: in the same secure storage as the seed phrase** (a phone's Keychain
> or Keystore, an encrypted database, a key vault). Never log it, send it to analytics or crash reports, or keep it in
> plain files or unencrypted backups.

The package stores nothing itself: the wallet keeps the text its own way, as it keeps the seed phrase.

## Overview

```
 identity (held by ConcordiumIdentity)
      │  exportIdentity()
      ▼
 JSON text (NOT encrypted)        → the wallet keeps it in its secure storage, next to the seed phrase
      │  importIdentity(text)
      ▼
 identity held again, after checking it belongs to this seed phrase
```

## The format (version 1)

```json
{
  "format": "concordium-wdk-identity",
  "v": 1,
  "network": "testnet",
  "providerIndex": 0,
  "identityIndex": 2,
  "identityObject": { "v": 0, "value": { … } }
}
```

| Field | Meaning |
|---|---|
| `format` | always `"concordium-wdk-identity"` |
| `v` | the format version: `1` |
| `network` | `"testnet"` or `"mainnet"`: which keys the seed phrase gives (`useMainnetKeyDerivation`) |
| `providerIndex` | the identity provider's index on that network |
| `identityIndex` | the wallet's identity number with that provider |
| `identityObject` | the identity exactly as the provider issued it (Concordium's versioned identity object): the person's details (`value.attributeList.chosenAttributes`), its validity (`validTo`, `createdAt`), `maxAccounts`, the public key it was issued to (`value.preIdentityObject.idCredPub`) and the provider's signature |

It holds **no keys**: every key (for accounts and proofs) comes from the seed phrase. Without the seed phrase, the
text cannot be used to create accounts or answer questions, but its details can be read.

## Reading it back

`importIdentity` checks, in order:

1. it is JSON with `format` `"concordium-wdk-identity"`, a known `v`, the two numbers and an `identityObject`;
   otherwise `IdentityStorageError` with reason `unreadable`;
2. `network` is the wallet's network; otherwise `unreadable`;
3. the identity belongs to this seed phrase: `identityObject.value.preIdentityObject.idCredPub` must equal the public
   key this seed phrase gives for `providerIndex` and `identityIndex` (the same check as when the identity was
   collected from the provider; it needs the network's cryptographic parameters, one call to the node); otherwise
   reason `not-yours`.

It does not check the provider's signature: the chain checks it when an account is created, and websites when they
check a proof.

## Versions

A future change (new fields) gets a new version number, and the reader for version 1 stays, so identities kept
earlier remain readable. A golden-file test ([`test/fixtures/golden`](../test/fixtures/golden)) checks on every run
that version-1 text is still read, and an independent reader written from this document alone checks this document
is exact.

## Test vector

`test/fixtures/golden/identity-plain-v1.json` (13,931 characters): the recorded testnet identity
(`token.identityObject` in `test/fixtures/identity-done.testnet.json`) of the public test phrase `abandon abandon
abandon abandon abandon abandon abandon abandon abandon abandon abandon about` (no passphrase), `testnet`, provider 0,
identity 334563111. Its details are the test provider's made-up ones (John Doe, born 1970-01-01).

## Threat model

| Protected | Not protected (the wallet's job) |
|---|---|
| an identity of another seed phrase, or another network, is refused on import (`not-yours`, `unreadable`) | **the text being read**: it is not encrypted; keep it in secure storage |
| the text holds no keys: on its own it cannot create accounts or answer questions | the wallet losing or deleting its copy (recovery gets the identity back from the provider with the seed phrase) |
| | a changed detail in the text: not detected on import; the chain refuses an account from it, and a website refuses a proof from it, because the provider's signature no longer matches |

While in use, the identity is held in memory as bytes, and the seed and held identities are zeroed by `dispose()`.
JavaScript strings cannot be wiped, so while the identity's JSON is read or written, short-lived string copies exist
until garbage collection. The exported text itself is a string the wallet holds.
