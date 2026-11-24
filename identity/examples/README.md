# Examples

Runnable examples of the identity package, all on Concordium **testnet**. They are grouped by how you use them: in a
terminal only, in a terminal with one step in a browser, as a web page, or as a phone app.

Run the terminal examples from the `identity` folder, after `npm ci` there (see the package README). Most of them use a
public test seed phrase: it is shared with everyone, so never use it for anything of value.

## `terminal/`: everything prints in the terminal

| Command (in `identity`) | What it shows | On chain |
|---|---|---|
| `npm run example:load-identity` | an identity kept by `verify-identity`, loaded again in a fresh program, checked to belong to this seed phrase | reads only |
| `npm run example:create-account` | an account created on chain from a kept identity | creates an account (free) |
| `npm run example:wdk-end-to-end` | the whole story through Tether's WDK: accounts from the identity, then receiving and sending CCD and tokens with the wallet package | sends test CCD and tokens from a funding account |
| `npm run example:recover-identity` | a "new phone": every identity and account back from the seed phrase alone | reads only |
| `npm run example:server-keeps-identities` | a server keeping each user's identity in that user's own record | reads only |
| `npm run example:handle-errors` | turning every error of both packages into a message for the user | reads only |
| `npm run example:age-check` | "are you over 18?": both the website and the wallet, in one run; the question recorded on chain, its fee paid by a partner, answered from the identity | records the question (a small fee) |

`terminal/kept-identities.mjs` is not run on its own: it is how these samples keep identities in a folder (as plain
files, for test identities only; a real wallet keeps them in its secure storage).

## `terminal-and-browser/`: in the terminal, with one step on the provider's page

| Command (in `identity`) | What it shows | The browser step |
|---|---|---|
| `npm run example:verify-identity` | verifying an identity end to end, as a desktop wallet does: the request, the provider's page, the identity collected, checked and kept | the sample prints the provider's link (or opens it with `OPEN_BROWSER=1`); fill in the test form, and the sample carries on |
| `npm run example:wdk-identity` | identity inside WDK (a proposal): one seed given to WDK, which builds the Concordium wallet and identity manager; verify, create an account, get it through WDK, prove "over 18" from it to a shop | writes to testnet: an identity and an account (free), the shop's question (about 5 testnet CCD, paid by a sponsor); fill in the test form, and the sample carries on |
| `npm run example:resume-after-restart` (then `… -- resume`) | verification that survives the app being closed: the provider's reply is saved, and a fresh start collects the identity | open the printed link and verify; part 2 runs later, in the terminal only |

## `company-identity/`: company identities (Business ID)

Its own README explains company identities. Three samples:

| Command (in `identity`) | What it shows | How |
|---|---|---|
| `npm run example:company-providers` | which providers issue company identities, on testnet and mainnet | terminal only |
| `npm run example:company-questions` | a bank asking a company for its LEI and legal name, and to prove it is registered in the EU | terminal only |
| `npm run example:company-verify` | a company starting its verification, up to the provider's company page | terminal, plus the provider's page in a browser (it stops at the provider's sign-in) |

## `identity-walkthrough/`: a web page in the browser

`npm run identity-walkthrough` (in `identity`) opens a step-by-step page that tells the whole story: choose a
provider, verify, keep the identity, create an account, receive and send. Each step can show the package calls it
makes. See the comments at the top of its `server.mjs` for its settings.

## `react-native/`: a phone app

A small Android wallet: create a wallet, verify an identity in the provider's page inside the app (a WebView), keep it
in the phone's secure storage, and create an account, with Concordium's Android library doing the heavy cryptography.
See its own README for setting it up and running it on an emulator or a phone.
