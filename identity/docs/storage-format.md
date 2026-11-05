# Exported identity format

This describes exactly how `@concordium/wdk-identity-concordium` turns an identity into the text `exportIdentity`
gives the wallet to keep, and how `importIdentity` reads it back, so the format can be reviewed, and read by other
implementations (for example a native mobile wallet sharing the same data). The code is in
[`src/storage/identity-export.js`](../src/storage/identity-export.js).

The package stores nothing itself: the wallet keeps the text its own way, as it keeps the seed.

## Overview

```
 identity (held by ConcordiumIdentity)
      │  exportIdentity()                         (default: encrypted)
      ▼
 base64 of:  "CWID" | version 2 | label | nonce | ciphertext + tag      → the wallet keeps this text
      │  importIdentity(text)
      ▼
 identity held again, after checking it is this seed's
```

- The **encryption key is never stored**. It is derived from the wallet seed each time it is needed and wiped after
  use. Whoever holds the text cannot read it without the seed.
- The **label** says which identity it is, e.g. `concordium-identity/testnet/0/2` (network / provider / identity
  number). It is not secret and stays readable, but it is part of the authentication, so it cannot be changed.
- Any change to the text is detected when decrypting.
- A **plain** form (`encrypted: false`) also exists: JSON text, described at the end.

## The encryption key

HKDF with SHA-256 (RFC 5869):

| Input | Value |
|---|---|
| input keying material | the wallet's **64-byte seed** (the BIP-39 seed of the seed phrase, as used for Concordium key derivation) |
| salt | the UTF-8 bytes of `concordium-wdk-identity-storage v1` |
| info | the UTF-8 bytes of the network: `testnet` or `mainnet` |
| output length | 32 bytes |

The account and identity keys come from the same seed through SLIP-10 derivation paths, a different derivation, so
this key is separate from them. (The salt keeps its original name, from version 1, so both versions use the same key.)

## Version 2: the encrypted export

The text is the **standard base64** encoding (with `=` padding) of these bytes:

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | magic `CWID` (`43 57 49 44`): "Concordium WDK identity", says what the bytes are |
| 4 | 1 | format version: `2` |
| 5 | 1 | label length L, in bytes |
| 6 | L | the label, UTF-8: `concordium-identity/<network>/<providerIndex>/<identityIndex>` |
| 6+L | 12 | nonce: random, new for every export |
| 18+L | rest | AES-256-GCM ciphertext, followed by its 16-byte authentication tag |

**Additional authenticated data** (part of the tag): bytes 0 to 6+L, i.e. the magic, the version, the label length and
the label.

**Plaintext:** the UTF-8 JSON text of

```json
{ "v": 2, "providerIndex": 0, "identityIndex": 2, "identityObject": { "v": 0, "value": { "…": "…" } } }
```

where `identityObject` is the identity exactly as the provider issued it.

### Reading version 2

1. Decode the base64. Check the first 4 bytes are `CWID`; otherwise it is not an exported identity.
2. Read the version byte and use the reader for that version; an unknown version is refused with a clear error, never
   guessed.
3. Read the label. Its network must be this wallet's network.
4. Derive the key (above) and decrypt, with the nonce and the header (bytes 0 to 6+L) as additional data. A wrong seed,
   a changed label or any changed byte makes the tag check fail.
5. Parse the JSON; check `v` is 2, and that `providerIndex` and `identityIndex` match the label.

## Version 1: saved by the earlier, store-based package (still read)

Before `exportIdentity`, the package saved identities itself, in a store the wallet chose, under a **slot name**. The
bytes do not contain the slot name: the reader must know it, so `importIdentity` needs the identity's numbers for
version 1: `importIdentity(bytes, { providerIndex, identityIndex })`. The slot name is the same text as the version-2
label.

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | magic `CWID` |
| 4 | 1 | format version: `1` |
| 5 | 12 | nonce |
| 17 | rest | AES-256-GCM ciphertext, followed by its 16-byte authentication tag |

**Additional authenticated data** (not stored): bytes 0–4 followed by the UTF-8 bytes of the slot name.
**Plaintext:** `{ "v": 1, "providerIndex": …, "identityIndex": …, "identityObject": … }`.

Version-1 data may be given as raw bytes or as base64 text.

## The plain export (`encrypted: false`)

JSON text:

```json
{ "format": "concordium-wdk-identity", "v": 1, "network": "testnet", "providerIndex": 0, "identityIndex": 2,
  "identityObject": { … } }
```

It holds the person's details in the clear: keep it as carefully as the seed. Since nothing is decrypted, importing it
checks ownership another way: the identity's `preIdentityObject.idCredPub` must equal the public key this wallet's
seed gives for that provider and identity number (the same check as when the identity is collected from the
provider); this needs the network's cryptographic parameters.

## Versions

A future change (a different cipher, new fields) gets a new version number and its own reader; the earlier readers
stay, so identities kept earlier remain readable. Golden-file tests ([`test/fixtures/golden`](../test/fixtures/golden))
check on every run that version-1 and version-2 data still decrypt, and an independent reader written from this
document alone (using Node's own crypto, not the package's) checks this document is exact.

## Test vectors

Both hold the recorded testnet identity (`token.identityObject` in `test/fixtures/identity-done.testnet.json`),
encrypted with the key of the public test phrase `abandon abandon abandon abandon abandon abandon abandon abandon
abandon abandon abandon about` (no passphrase) on `testnet`:

| File | Version | Label / slot name | Decrypts to |
|---|---|---|---|
| `test/fixtures/golden/identity-v2.txt` (base64 text, 18,600 characters) | 2 | `concordium-identity/testnet/0/334563111` | `{ "v": 2, "providerIndex": 0, "identityIndex": 334563111, "identityObject": … }` |
| `test/fixtures/golden/identity-v1.bin` (13,909 bytes) | 1 | `concordium-identity/testnet/0/334563111` | `{ "v": 1, "providerIndex": 0, "identityIndex": 334563111, "identityObject": … }` |

## Threat model

| Protects against | Does not protect against |
|---|---|
| wherever the wallet keeps the encrypted text (a database, a backend, a phone's storage, a backup) being read | someone with the seed phrase: they can derive the key, and could also get the identity again from the provider |
| a leaked backup or database dump | malware on the device while the wallet runs with the seed in memory |
| text swapped between identities or networks (the label is authenticated and checked) | the wallet losing or deleting its copy (recovery gets the identity back from the provider with the seed) |
| changed or damaged text (detected, refused) | the plain form being read: it is not encrypted |

Limits worth knowing:

- While in use, the identity is held in memory as bytes, and the seed and held identities are zeroed by `dispose()`.
  JavaScript strings cannot be wiped, so while the identity's JSON is read or written, short-lived string copies exist
  until garbage collection. The exported text itself is a string the wallet holds.
