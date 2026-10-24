/**
 * Identity verification end to end, as a desktop or server wallet would do it:
 * start the built-in listener, build the request, let the user verify in a
 * browser, then collect the issued identity.
 *
 *   npm run example:verify-identity
 *
 * Testnet by default, with Concordium's test provider (index 0), which shows a
 * form with test details instead of asking for documents. Settings:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (default 0)
 */
import {
  ConcordiumIdentity,
  IdentityIssuanceError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { listenForIdentityCallback } from '@concordium/wdk-identity-concordium/node';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
const identityIndex = Number(process.env.IDENTITY_INDEX ?? 0);

const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
const cancel = new AbortController();
process.once('SIGINT', () => cancel.abort()); // Ctrl+C cancels the wait

try {
  // 1. Listen on this machine for the provider's return.
  const listener = await listenForIdentityCallback({ signal: cancel.signal });

  // 2. Build the request from the seed, with the listener as the return address.
  const { issuanceUrl } = await identity.createIdentityRequest({
    providerIndex, identityIndex, redirectUri: listener.redirectUri,
  });

  // 3. The user verifies in a browser.
  console.log('Open this link in a browser to verify (Ctrl+C to cancel):\n');
  console.log(issuanceUrl, '\n');
  console.log('Waiting for the provider to send the browser back...');

  // 4. The browser comes back; collect the identity.
  const callbackUrl = await listener.callback;
  console.log('Back from the provider. Collecting the identity...');
  const summary = await identity.retrieveIdentity(callbackUrl, { signal: cancel.signal });

  console.log('\nIdentity issued:', summary);
} catch (e) {
  if (e instanceof IdentityIssuanceError) {
    console.error(`\nNo identity (${e.reason}): ${e.message}`);
  } else {
    console.error('\nFailed:', e.message);
  }
  process.exitCode = 1;
} finally {
  identity.dispose();
}
