# Threat model

What the two packages (`@concordium/wdk-wallet-concordium` and `@concordium/wdk-identity-concordium`) protect, what
could go wrong, how each part is defended, and what is left to the wallet that uses them. It describes the code as it
is, tested on testnet; it is a starting point for the independent review that comes before mainnet, not a substitute
for it. The [integration guide](integration-guide.md) explains each step referred to here.

## What is worth protecting

| What | Why it matters | Where it lives |
| --- | --- | --- |
| **The seed phrase** | every key comes from it: the identities' and the accounts'. Whoever has it controls the accounts and can recover the identities | the wallet's own storage; a copy inside each package object while in use |
| **The identity** | it holds the person's (or company's) verified details: name, date of birth, nationality, ID numbers, LEI | inside the identity package while in use; kept by the wallet as exported text |
| **The accounts and their funds** | CCD and tokens | on chain, controlled by keys from the seed |
| **What a website learns** | proofs should show only what the user agreed to | in each answer the wallet sends |
| **The return from the provider** | its reply leads to the issued identity | the address the browser arrives at |

## Who or what could cause harm

- someone who **steals the device**, or copies the wallet's stored data (a phone backup, a server database);
- a **malicious or careless website** asking questions, or trying to reuse answers;
- **another program** on the same computer;
- someone **between the wallet and the network** (a hostile Wi-Fi, a tampered proxy);
- a **wrong provider list** (from an untrusted source, or tampered with);
- **mistakes in a dependency** (Concordium's SDK, the cryptography libraries), or in the wallet's own code;
- **a token's issuer** changing its rules at any moment.

## How each part is defended

### The seed phrase

| Threat | Defence | Left to the wallet |
| --- | --- | --- |
| it is stolen from storage | the packages never store it | keep it in the device's secure storage, or encrypted |
| it ends up in a log or crash report through an error message (for example, when the user mistypes a word while restoring) | a wrong seed phrase is refused with only "Invalid seed phrase.", without the words (tested in both packages); both packages also check a seed given as raw bytes before Concordium's SDK sees it, because the SDK's error for a seed of the wrong length repeats the whole seed; the packages' own error messages contain no seed or key. Once a seed phrase has leaked, nothing can protect the accounts: whoever has it controls them | never log or report the seed phrase, the config objects or `keyPair` yourself |
| it stays in memory longer than needed | `identity.dispose()` and `wallet.dispose()` zero each package's copy of the seed and what it holds; the identity package zeroes the signing keys it derives straight after use | dispose objects when done |

**Known limit (both).** JavaScript cannot guarantee that every copy of a value in memory is erased: Concordium's SDK
takes keys as text, which cannot be wiped. Zeroing reduces how long secrets are held; it is not a guarantee.

### The identity

| Threat | Defence | Left to the wallet |
| --- | --- | --- |
| the kept copy is stolen (a phone backup, a server database) | `exportIdentity` encrypts it (AES-256-GCM, a key derived from the seed with HKDF-SHA256, never stored): the text reveals nothing personal, and only this seed can read it | choosing where to keep it; the **plain** export (`encrypted: false`) is readable by anyone who has it: keep it like the seed |
| the kept copy is changed, swapped or damaged | any change to the encrypted text is detected and refused (`unreadable`); its label (network, provider, identity number) is authenticated too | recover it (chapter 6) if it was damaged |
| someone else's identity is slipped in (a wrong `code_uri`, a tampered reply, a plain export) | every identity is checked to belong to **this seed** (its public key, worked out from the seed) before it is held, when collected, recovered or imported; one that is not is refused (`not-yours`) and never kept | — |
| a forged identity (not really issued by the provider) | the wallet does not check the provider's signature on the identity itself; **the chain does**, when an account is created from it, and websites do when they check a proof against the provider's keys. A forged identity can therefore never create an account or pass a check | — |
| too much is shown on chain | nothing about the person is put on an account unless the wallet names it in `revealAttributes` | ask the user before revealing anything |

### Answering websites (proofs)

| Threat | Defence | Left to the wallet / website |
| --- | --- | --- |
| the wallet answers something untrue | the wallet refuses, before building anything, if the identity has expired, its provider is not accepted, or its details do not satisfy the question (`cannot-prove`, `provider-not-accepted`, `identity-expired`) | — |
| the website learns more than agreed | only what the question asks is proven or shown; a version 1 answer does not even name the account | show `describeProofRequest` (and, for version 1, `describeProofContext`) and get the user's agreement first |
| a copied answer is reused, at the same or another website | each answer is tied to its question: a fresh random challenge (version 0), or the question's anchor on chain and its nonce (version 1); the website's check refuses an answer to another question | the website accepts **one answer per question** and uses a fresh question every time |
| an answer to an easier question is passed off ("over 5" for "over 18") | the website's check compares exactly the statements asked | — |
| an expired or revoked identity still answers | the website's check refuses an identity that is no longer Active on chain | a website checking answers another way must check the status itself |
| a version 1 question is changed after it was recorded | the wallet checks the anchor on chain records exactly this question (`anchor-mismatch`) | do not answer |
| a website pretends to be another one (version 1) | the website's name in the question is the website's own claim, fixed by the anchor but not verified | compare it with the site the wallet is actually connected to |
| Concordium's SDK accepts an answer it should not | `checkPresentationV1` does its own context check: in SDK 12.0.2, `VerificationAuditRecordV1.createChecked` does not wait for its context comparison and accepts an answer to another question with the same statements; the package does not use it | websites using `createChecked` directly should not rely on it until it is fixed |

### The return from the provider

| Threat | Defence | Left to the wallet |
| --- | --- | --- |
| another program on the computer catches the return | the built-in listener answers only this computer (127.0.0.1), at a random, unguessable path, takes one return only, accepts only an address that starts with its own return address (and of limited size), and stops after it, a timeout, or cancelling | phone and web wallets catch the return their own way: an app link or own scheme, or their own page |
| the reply is lost when the app closes | `parseIdentityCallback` + `waitForIdentity` let the wallet save the reply and continue after a restart | save the reply before waiting |
| the provider's reply (its `code_uri`) is copied: a log, a crash report, a backup | the `code_uri` is an address where the provider serves the issued identity, with the person's details, to anyone who has it, with no login (checked on testnet: it still works months later); its long random part makes it impossible to guess, but not safe to leak. It does not give the power to use the identity (creating accounts or answering questions needs the seed phrase). The packages never put it in an error message | keep a saved reply in secure storage, never log it, delete it once the identity is collected |

### The network and the provider list

| Threat | Defence | Left to the wallet |
| --- | --- | --- |
| someone between the wallet and the network | everything goes over HTTPS (the providers) and TLS (the node) | use `https://` endpoints and a TLS node connection |
| a wrong provider list (an untrusted source, tampered with) | the package checks the list's shape, with clear errors; it does **not** check that the list is genuine. A list with a fake provider could send the user to a fake verification page; a list with wrong keys produces requests and identities the chain would refuse | fetch the list over HTTPS from a source you trust (the wallet-proxy, or your own copy); see "Possible additions" |
| a wrong node | everything the packages read from the chain comes through the wallet's node connection | connect to a node you trust (Concordium's public node, or your own) |

### Accounts, transfers and tokens

| Threat | Defence | Left to the wallet |
| --- | --- | --- |
| a transfer that will be refused wastes a fee | `checkTransfer` checks first (balance, CCD for the fee, a paused token, allow and deny lists); `transfer` and `buildSponsorableTransfer` run the same check and send nothing if it fails | — |
| a token's rules change between the check and the transfer | the SDK's own last check, or the chain, refuses it; the error says why, with the hash if it was sent | tell the user; the fee of a sent, refused transfer is charged |
| a recipient address is wrong | an address that is not an account address is refused; one with no account is reported (`RECIPIENT_NOT_FOUND`) | show the address and the amount before the user confirms |
| creating an account twice | an account that already exists is returned (`created: false`), nothing sent | — |
| a CIS-2 token's metadata address points somewhere harmful | `getCis2Metadata` reads the address the token's contract gives; the reply is only parsed as JSON, never run | treat the metadata (names, images) as untrusted text |
| `keyPair` exposes the private key | it is there for wallets that need it | never expose it, or a `toReadOnlyAccount()` result (the same object, still able to sign), to untrusted code |

### Dependencies

The packages depend on Concordium's SDK (`@concordium/web-sdk`), Tether's base package (`@tetherto/wdk-wallet`) and
small audited cryptography libraries (`@noble/hashes`, `@noble/ciphers`). Where the packages re-apply the SDK's rules
(`checkTransfer`), a test checks they agree with the SDK's own check on every combination, so an SDK change is
noticed. Versions are pinned in each package's lock file; `npm audit` reports advisories in dependencies (at the
time of writing, two moderate ones in `uuid`, used by the SDK).

## Trusted by design

Some things the packages rely on, by Concordium's design:

- **The identity providers** check people's and companies' documents properly, keep the identities they issued
  (recovery asks them), and keep each issued identity's `code_uri` from leaking on their side; they serve the
  identity to whoever has that address.
- **The anonymity revokers** named by each provider can, together and under a legal process, find out who stands
  behind an account; that is how Concordium combines privacy with accountability.
- **The chain** checks every account's credential against the provider's keys it holds, and every proof is checked
  against the chain.

## Not protected (no library can)

- A device controlled by malware, or a compromised operating system: it can read the seed as the wallet uses it.
- A user who agrees to share more than they meant to: the consent screen must be clear (the packages give the wording).
- A website that keeps or misuses details the user chose to show.

## Possible additions

Found while writing this; none is needed for testnet, each would make mainnet use safer:

1. **Check the provider list against the chain.** The node knows the providers' and anonymity revokers' keys
   (`getIdentityProviders`, `getAnonymityRevokers`). Comparing the list's keys with them, once when the
   `ConcordiumIdentity` is created, would catch a tampered or out-of-date list before a request is built. (The
   addresses of the providers' pages are only in the list, so those still depend on fetching it from a trusted source.)
2. **Check the provider's signature on a collected identity**, so a forged identity is refused at once instead of when
   an account is created.

## Status

Tested on testnet only. Before mainnet: an independent security review of both packages, starting from this document.
