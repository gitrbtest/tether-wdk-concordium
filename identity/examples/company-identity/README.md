# Company identities (Business ID)

A company can have a Concordium identity of its own, a **Business ID**: it holds the company's Legal Entity
Identifier (LEI), legal name, country of registration, business number and registration authority, checked by an
identity provider from the company's documents. With it, the company's wallet can create accounts for the company and
prove facts about it (for example to a bank: "here is our LEI, and we are registered in the EU"), the same way a
person's wallet does for a person.

Business IDs are issued by **Global FinReg** (testnet provider 4, mainnet provider 3). A company identity is made with
exactly the same package calls as a person's; only the provider differs.

## The samples

All three run on testnet and read only: nothing is written to the chain and nothing is spent.

| Sample | What it shows |
| --- | --- |
| `npm run example:company-providers` | which identity providers issue company identities, on testnet and mainnet |
| `npm run example:company-verify` | a company starting its verification: the Business ID provider chosen, the request built from the company's seed, the provider's company page opened, where it asks the company to sign in (`CHECK_ONLY=1` stops once the page has opened) |
| `npm run example:company-questions` | a bank asking a company for its LEI and legal name, and to prove it is registered in the EU; the consent screen a company's wallet shows; the same question refused by a person's wallet |

## The provider list: use `/v2/ip_info`

The wallet passes the identity provider list to the package. The wallet-proxy's `/v2/ip_info` lists every provider,
including the company ones; `/v1/ip_info` leaves the company ones out. The package says which providers issue
company identities (`kind: 'company'`) and gives each one's display name ("Global FinReg (Business ID)").

```js
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const companies = (await new IdentityProviders(identityProviders).list()).filter((p) => p.kind === 'company');
// → [{ index: 4, name: 'Global FinReg Testnet', display: 'Global FinReg (Business ID)', kind: 'company', … }]
```

Concordium documents no field that marks a Business ID provider, so the package infers it: the provider's display
name mentions "Business ID", or its issuance address ends with `/company` (see `src/providers/provider-kind.js`).

## What works in testing, and what needs a real company

```
COMPANY'S WALLET                           GLOBAL FINREG                          BANK
────────────────                           ─────────────                          ────
list the providers: "Global FinReg (Business ID)"                      ✔ tested live
build the request, open the link ─────────► the company verification page   ✔ tested live
                                            LEI, company documents, the ID of the person signing for it
                                            → the company's identity is issued        needs a real company
collect it, keep it, create accounts                                          same calls as for a person
answer the bank's question  ◄──────────────────────────────────────────────── "show your LEI …"   ✔ the question,
                                                                                                    its wording
```

Global FinReg has no test mode: completing a Business ID needs a real company with an LEI and its documents. Its
page asks the company to **sign in or register**; without a real company, stop there (Ctrl+C in the terminal), or run
`CHECK_ONLY=1 npm run example:company-verify`, which stops by itself once the page has opened. Please do not register
a made-up company: it is Global FinReg's real onboarding service, also on testnet. So the
samples show everything up to the provider's company page, the questions a company is asked, and what a person's
identity does with them (refuses: it has no company details). Collecting, keeping, creating accounts and answering are
the same calls as for a person's identity, which the other samples show working on testnet (`verify-identity`,
`create-account`, `age-check`).
