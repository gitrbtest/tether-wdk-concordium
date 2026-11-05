# Golden files

**Never regenerate or edit these files.**

Each file here is output of an earlier version of this package, kept exactly as it was written. The
tests read them with the current code. A failing golden test means data saved by earlier versions of
the package can no longer be read by the current one.

If a golden test fails:

- **an accidental format change** (the usual case): fix the code. The golden file is right.
- **an intentional format change**: add a new format version with its own golden file, and keep the
  reader for the old version, so every existing golden test still passes.

The `.bin` and `.txt` files are kept binary (see `identity/.gitattributes`), so git never changes a byte.
Name new golden files `<what>-v<version>.bin` (or `.txt`), so the rule covers them too.

| File | Made with | Contents | Checked by |
|---|---|---|---|
| `identity-v1.bin` | storage format version 1 (the earlier, store-based package) | the recorded testnet identity (`../identity-done.testnet.json`), encrypted with the key of the public test phrase `abandon … about` (12 words) on testnet, for slot `concordium-identity/testnet/0/334563111` | `test/unit/identity-export.test.mjs`: *reads identities saved in storage format version 1 (golden file)*; `test/unit/storage-format-spec.test.mjs` |
| `identity-v2.txt` | export format version 2 (`exportIdentity`, encrypted; base64 text, made 5 Nov 2026) | the same recorded testnet identity, exported with the key of the same public test phrase on testnet; its label is `concordium-identity/testnet/0/334563111` | `test/unit/identity-export.test.mjs`: *reads identities exported in format version 2 (golden file)*; `test/unit/storage-format-spec.test.mjs` |
