/**
 * Identity verification end to end, as a desktop wallet would do it:
 * start the built-in listener, build the request, let the user verify in a
 * browser, collect the issued identity, and export it for the sample to keep in a file (NOT encrypted: a real wallet
 * keeps it in its secure storage, like the seed phrase).
 *
 *   npm run example:verify-identity
 *
 * Testnet by default, with Concordium's test provider (index 0), which shows a
 * form with test details instead of asking for documents. Settings:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (default: the next free one, from
 *                    nextIdentityIndex: one after the highest this seed already has with the provider)
 *   IDENTITY_FOLDER  folder where the sample keeps the exported identity (default ./demo-identities)
 *   OPEN_BROWSER     set to 1 to open the verification page in the default browser
 *
 * Load the saved identity again later with: npm run example:load-identity
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  ConcordiumIdentity,
  IdentityIssuanceError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { listenForIdentityCallback } from '@concordium/wdk-identity-concordium/node';
import { keepIdentity } from './kept-identities.mjs';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
const folder = process.env.IDENTITY_FOLDER || './demo-identities';

// The identity package, given the wallet's seed phrase. Every key it needs (for the identity request, and later
// for accounts and proofs) is worked out from the seed; the package itself stores nothing: it hands the identity to
// the wallet (here, this sample) to keep.
// The identity provider list: the package does not fetch it. The wallet does (here from the wallet-proxy, once)
// and passes it in; only its shape matters.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
// The wallet's own connection to a Concordium node (here Concordium's public testnet node): the package never
// opens one itself.
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const identity = new ConcordiumIdentity(seedPhrase, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });

// A "cancel switch" (a standard AbortController): pressing Ctrl+C flips it, and the waits below stop cleanly.
const cancel = new AbortController();
process.once('SIGINT', () => cancel.abort()); // Ctrl+C cancels the wait

/**
 * Open a link in the default browser. The verification link is very long (over 13,000 characters,
 * more than the Windows command line takes), so the browser is pointed at a short local address that
 * redirects to it once.
 */
async function openInBrowser(link) {
  const server = createServer((request, response) => {
    response.writeHead(302, { location: link });
    response.end();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const short = `http://127.0.0.1:${server.address().port}/start`;
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', short]]
    : process.platform === 'darwin' ? ['open', [short]] : ['xdg-open', [short]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

try {
  // 1. Get ready to be called back. When the user finishes on the provider's page, the provider sends their
  //    browser to a "return address" with its reply in it. The built-in listener is a tiny local web server on
  //    this machine that waits for exactly that visit. (A phone app or web wallet would catch it its own way.)
  const listener = await listenForIdentityCallback({ signal: cancel.signal });

  // Which identity number: the one given, or the next free one with this provider. nextIdentityIndex asks the
  // provider (as recovery does) which numbers this seed already has, so a new identity never reuses one.
  const identityIndex = process.env.IDENTITY_INDEX !== undefined
    ? Number(process.env.IDENTITY_INDEX)
    : await identity.nextIdentityIndex({ providerIndex });
  console.log(`Identity number ${identityIndex} with provider ${providerIndex}`
    + `${process.env.IDENTITY_INDEX === undefined ? ' (the next free one); later samples: set IDENTITY_INDEX to it' : ''}\n`);

  // 2. Build the identity request. It is made from the seed's keys for this provider and identity number, and
  //    proves to the provider that the wallet holds them, without revealing them. The result is one long link
  //    to the provider's verification page, carrying the request and the listener's return address.
  const { issuanceUrl } = await identity.createIdentityRequest({
    providerIndex, identityIndex, redirectUri: listener.redirectUri,
  });

  // 3. The person verifies, in a browser, on the provider's own page: documents and selfie with a real
  //    provider; on testnet, Concordium's test provider shows a form with made-up details instead.
  console.log('Open this link in a browser to verify (Ctrl+C to cancel):\n');
  console.log(issuanceUrl, '\n');
  if (process.env.OPEN_BROWSER === '1') {
    await openInBrowser(issuanceUrl);
    console.log('(Opened in your default browser.)');
  }
  console.log('Waiting for the provider to send the browser back...');

  // 4. The browser comes back to the listener, carrying the provider's reply (where to collect the identity).
  //    retrieveIdentity collects it, waiting if the provider is still checking, then makes sure it really was
  //    issued to this seed's keys before keeping it. Only a summary is returned (dates, number of accounts
  //    allowed): the person's details stay inside the package.
  const callbackUrl = await listener.callback;
  console.log('Back from the provider. Collecting the identity...');
  const summary = await identity.retrieveIdentity(callbackUrl, { signal: cancel.signal });
  console.log('\nIdentity issued:', summary);

  // 5. Keep it, so it survives a restart. exportIdentity gives it as text; next time importIdentity takes it back
  //    (see load-identity). NOT ENCRYPTED: the text holds the person's details, so a real wallet keeps it in its
  //    secure storage, like the seed phrase. This sample keeps it in a plain file, for test identities only.
  const exported = await identity.exportIdentity({ providerIndex, identityIndex });
  const file = keepIdentity(folder, { providerIndex, identityIndex }, exported);
  console.log(`\nExported and kept in ${file} (plain text with the details: a real wallet uses secure storage). Next: set IDENTITY_INDEX=${identityIndex} for load-identity and create-account.`);
} catch (e) {
  if (e instanceof IdentityIssuanceError) {
    console.error(`\nNo identity (${e.reason}): ${e.message}`);
  } else {
    console.error('\nFailed:', e.message);
  }
  process.exitCode = 1;
} finally {
  // Wipe the seed (and the identity held in memory) whatever happened above.
  identity.dispose();
}
