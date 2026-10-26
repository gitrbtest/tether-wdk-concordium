# Saved identity format (version 1)

This describes exactly how `@concordium/wdk-identity-concordium` encrypts an identity before handing it to
a store, so the format can be reviewed, and read by other implementations (for example a native mobile
wallet sharing the same data). The code is in [`src/storage/storage-format.js`](../src/storage/storage-format.js).

## Overview

```
 identity (held by ConcordiumIdentity)
      │  encrypt with a key derived from the wallet seed, bound to the slot name
      ▼
 "CWID" | version 1 | nonce | ciphertext + tag          → store.save(slotName, bytes)
```

- The **encryption key is never stored**. It is derived from the wallet seed each time it is needed and
  wiped after use. Whoever holds the store cannot read it without the seed.
- The **slot name** says which identity it is, e.g. `concordium-identity/testnet/0/594450697`. It is not
  secret, and it is part of the authentication, so bytes copied to another slot cannot be decrypted there.
- Any change to the bytes is detected when decrypting.

## Slot names

```
concordium-identity/<network>/<providerIndex>/<identityIndex>
```

| Part | Value |
|---|---|
| `<network>` | `testnet` or `mainnet`: the key derivation network (`useMainnetKeyDerivation`) |
| `<providerIndex>` | the identity provider's index on that network |
| `<identityIndex>` | the wallet's identity number with that provider |

## The encryption key

HKDF with SHA-256 (RFC 5869):

| Input | Value |
|---|---|
| input keying material | the wallet's **64-byte seed** (the BIP-39 seed of the seed phrase, as used for Concordium key derivation) |
| salt | the UTF-8 bytes of `concordium-wdk-identity-storage v1` |
| info | the UTF-8 bytes of the network: `testnet` or `mainnet` |
| output length | 32 bytes |

The account and identity keys come from the same seed through SLIP-10 derivation paths, a different
derivation, so the storage key is separate from them.

## The saved bytes

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | magic `CWID` (`43 57 49 44`): "Concordium WDK identity", says what the bytes are |
| 4 | 1 | format version: `1` |
| 5 | 12 | nonce: random, new for every save |
| 17 | rest | AES-256-GCM ciphertext, followed by its 16-byte authentication tag |

**Additional authenticated data** (part of the tag, not stored): bytes 0–4 (magic and version) followed
by the UTF-8 bytes of the slot name.

**Plaintext:** the UTF-8 JSON text of

```json
{ "v": 1, "providerIndex": 0, "identityIndex": 594450697, "identityObject": { "v": 0, "value": { "…": "…" } } }
```

where `identityObject` is the identity exactly as the provider issued it.

## Reading

1. Check the first 4 bytes are `CWID`; otherwise the bytes are not a saved identity.
2. Read the version byte and use the reader for that version; an unknown version is refused with a clear
   error, never guessed.
3. Derive the key (above), decrypt with the nonce and the additional data for **the slot being read**.
   A wrong seed, another slot, or any changed byte makes the tag check fail.
4. Parse the JSON; check `v`, and that `providerIndex` and `identityIndex` match the slot.

## Versions

Version 1 is the only version. A future change (a different cipher, new fields) gets a new version number
and its own reader; the version-1 reader stays, so identities saved earlier remain readable. A golden-file
test ([`test/fixtures/golden`](../test/fixtures/golden)) checks on every run that version-1 data written by
the first release still decrypts.

## Test vector

`test/fixtures/golden/identity-v1.bin` (13,909 bytes) is a version-1 identity:

| | |
|---|---|
| seed | the BIP-39 seed of the public test phrase `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about` (no passphrase) |
| network | `testnet` |
| slot name | `concordium-identity/testnet/0/334563111` |
| decrypts to | `{ "v": 1, "providerIndex": 0, "identityIndex": 334563111, "identityObject": … }`, where `identityObject` is `token.identityObject` in `test/fixtures/identity-done.testnet.json` |

## Threat model

| Protects against | Does not protect against |
|---|---|
| the store (a database, a backend, a phone's storage) being read: it only ever holds encrypted bytes and slot names | someone with the seed phrase: they can derive the key, and could also get the identity again from the provider |
| a leaked backup or database dump | malware on the device while the wallet runs with the seed in memory |
| bytes swapped between identities or networks in the store | the store deleting or withholding the bytes (availability is the store's job) |
| changed or damaged bytes (detected, refused) | |

Limits worth knowing:

- While in use, the identity is held in memory as bytes, and the seed and held identities are zeroed by
  `dispose()`. JavaScript strings cannot be wiped, so while the identity's JSON is read or written, short-lived
  string copies exist until garbage collection.
- `FileIdentityStore` creates its files readable by the owner only on macOS and Linux. On Windows, access
  follows the folder's permissions: keep the folder where only the user can reach it.
