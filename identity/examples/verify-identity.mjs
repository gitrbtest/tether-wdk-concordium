/**
 * Identity verification end to end, as a desktop or server wallet would do it:
 * start the built-in listener, build the request, let the user verify in a
 * browser, collect the issued identity, and save it encrypted to disk.
 *
 *   npm run example:verify-identity
 *
 * Testnet by default, with Concordium's test provider (index 0), which shows a
 * form with test details instead of asking for documents. Settings:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (default 0)
 *   IDENTITY_STORE   folder for the encrypted identity (default ./demo-identities)
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
import { listenForIdentityCallback, FileIdentityStore } from '@concordium/wdk-identity-concordium/node';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
const identityIndex = Number(process.env.IDENTITY_INDEX ?? 0);
const storeFolder = process.env.IDENTITY_STORE || './demo-identities';

// The identity package, given the wallet's seed phrase. Every key it needs (for the identity request, and later
// to encrypt the saved identity) is worked out from the seed; nothing secret is stored. The store is where the
// identity will be saved: here, a folder of encrypted files.
const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, {
  store: new FileIdentityStore(storeFolder),
});

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

  // 5. Save it, encrypted, so it survives a restart. The encryption key is made from the seed and never stored;
  //    the store only ever receives a slot name and encrypted bytes. Next time: loadIdentity (see load-identity).
  const { slotName } = await identity.saveIdentity({ providerIndex, identityIndex });
  console.log(`\nSaved encrypted to ${storeFolder} (slot ${slotName}).`);
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
