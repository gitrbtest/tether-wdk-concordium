# Golden files

**Never regenerate or edit these files.**

Each file here is output of an earlier version of this package, kept exactly as it was written. The
tests read them with the current code. A failing golden test means data saved by earlier versions of
the package can no longer be read by the current one.

If a golden test fails:

- **an accidental format change** (the usual case): fix the code. The golden file is right.
- **an intentional format change**: add a new format version with its own golden file, and keep the
  reader for the old version, so every existing golden test still passes.

The `.bin`, `.txt` and `.json` files are kept binary (see `identity/.gitattributes`), so git never changes a byte.
Name new golden files `<what>-v<version>.bin` (or `.txt`), so the rule covers them too.

| File | Made with | Contents | Checked by |
|---|---|---|---|
| `identity-plain-v1.json` | export format version 1 (`exportIdentity`, plain JSON, made 11 Nov 2026) | the recorded testnet identity (`../identity-done.testnet.json`) of the public test phrase `abandon … about` (12 words), provider 0, identity 334563111. **Not encrypted:** it holds the test form's made-up details in the clear, as every export does | `test/unit/4-keep-identity/export-and-import.test.mjs`: *reads identities exported in format version 1 (golden file)*; `test/unit/4-keep-identity/storage-format-spec.test.mjs` |

The earlier encrypted formats were removed before the first release, with their golden files: the package no longer
encrypts the exported identity, and does not read encrypted text.
