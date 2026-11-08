/**
 * A company gets its identity (Business ID) from its wallet: pick the Business ID provider, build the identity
 * request from the company's seed, and open the provider's company verification page. On testnet.
 *
 *   npm run example:company-verify
 *
 * A company identity is made exactly like a person's (the same package calls; see ../verify-identity.mjs for the
 * person's version): only the provider differs. At the provider's page the company verifies with its Legal Entity
 * Identifier (LEI), its company documents, and the ID of the person signing for it. Global FinReg has no test mode, so
 * finishing needs a real company; without one, this sample shows everything up to that page. Global FinReg's page asks
 * the company to sign in or register: without a real company, stop there (Ctrl+C), or run with CHECK_ONLY=1, which
 * stops by itself once the page has opened. Do not register a made-up company: it is Global FinReg's real service.
 *
 * Settings (environment variables, optional):
 *   SEED_PHRASE      the company wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   a Business ID provider (default: the first one in the list, Global FinReg, testnet provider 4)
 *   IDENTITY_INDEX   the company's identity number with that provider (default: the next free one)
 *   IDENTITY_FOLDER  where the sample keeps the identity, once issued (default ./demo-identities)
 *   CHECK_ONLY       set to 1 to stop as soon as the company verification page has opened (no waiting)
 */
import {
  ConcordiumIdentity, IdentityProviders, IdentityIssuanceError, CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { listenForIdentityCallback } from '@concordium/wdk-identity-concordium/node';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { keepIdentity } from '../kept-identities.mjs';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const checkOnly = process.env.CHECK_ONLY === '1';
const folder = process.env.IDENTITY_FOLDER || './demo-identities';

// The /v2 list: it includes the company providers (the /v1 list leaves them out).
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const identity = new ConcordiumIdentity(seedPhrase, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });
const cancel = new AbortController();
process.once('SIGINT', () => cancel.abort()); // Ctrl+C cancels the wait

/** Follow the provider's redirects until it serves a page; returns that page's host (or throws what went wrong). */
async function pageOpens(url) {
  for (let hop = 0; hop < 10; hop++) {
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) { url = new URL(response.headers.get('location'), url).href; continue; }
    if (!response.ok) throw new Error(`the provider answered HTTP ${response.status}`);
    return new URL(url).host;
  }
  throw new Error('too many redirects');
}

try {
  // 1. Which provider: a Business ID one. The package says which ones issue company identities.
  const companies = (await new IdentityProviders(identityProviders).list()).filter((p) => p.kind === 'company');
  const providerIndex = process.env.PROVIDER_INDEX !== undefined ? Number(process.env.PROVIDER_INDEX) : companies[0]?.index;
  const provider = companies.find((p) => p.index === providerIndex);
  if (!provider) {
    throw new Error(`Provider ${providerIndex} does not issue company identities. Business ID providers: ${companies.map((p) => p.index).join(', ') || 'none'}.`);
  }
  console.log(`1. The company's provider: ${provider.index} ${provider.name} ("${provider.display}")\n`);

  // 2. Which identity number: the next free one with this provider (it asks the provider, as recovery does).
  const identityIndex = process.env.IDENTITY_INDEX !== undefined
    ? Number(process.env.IDENTITY_INDEX)
    : await identity.nextIdentityIndex({ providerIndex });
  console.log(`2. Identity number ${identityIndex} with provider ${providerIndex}\n`);

  // 3. The identity request, from the company's seed, and the link to the provider's company page. From here on it is
  //    the same as for a person: the same calls, the same checks.
  const listener = checkOnly ? null : await listenForIdentityCallback({ signal: cancel.signal });
  const { issuanceUrl } = await identity.createIdentityRequest({
    providerIndex, identityIndex, redirectUri: listener?.redirectUri ?? 'http://localhost:4000/callback',
  });
  console.log(`3. The company verification page opens at ${await pageOpens(issuanceUrl)}`);
  console.log('   There the company gives its LEI, its company documents, and the ID of the person signing for it.\n');
  if (checkOnly) {
    console.log('(CHECK_ONLY: stopping here. Finishing needs a real company: Global FinReg has no test mode.)');
  } else {
    console.log('Open this link in a browser to verify the company (Ctrl+C to cancel).');
    console.log('Global FinReg\'s page asks the company to sign in or register: without a real company, stop here with');
    console.log('Ctrl+C (or run with CHECK_ONLY=1). Do not register a made-up company: it is Global FinReg\'s real service.\n');
    console.log(issuanceUrl, '\n');
    console.log('Waiting for the provider to send the browser back...');

    // 4-5. As for a person: collect the issued identity (checked to be this seed's), and keep it, encrypted.
    const summary = await identity.retrieveIdentity(await listener.callback, { signal: cancel.signal });
    console.log('\n4. The company\'s identity is issued:', summary);
    const file = keepIdentity(folder, { providerIndex, identityIndex }, await identity.exportIdentity({ providerIndex, identityIndex }));
    console.log(`5. Exported (encrypted) and kept in ${file}. Accounts are created from it as for a person (create-account).`);
  }
} catch (e) {
  console.error(e instanceof IdentityIssuanceError ? `\nNo identity (${e.reason}): ${e.message}` : `\nFailed: ${e.message}`);
  process.exitCode = 1;
} finally {
  identity.dispose();
}
