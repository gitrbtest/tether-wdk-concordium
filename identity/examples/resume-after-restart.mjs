/**
 * Verification survives the app being closed: save the provider's reply, then collect the identity after a restart.
 *
 * Verifying can take a while (a real provider may check documents by hand), and the user may close the app while
 * it waits. The provider sends its reply only once, in the address it sends the browser back to, so the wallet
 * saves that reply first, and a fresh start continues from it. This sample runs in two parts, as two separate runs
 * of a program, like an app closed and opened again:
 *
 *   npm run example:resume-after-restart            part 1: verify, save the provider's reply, then stop
 *   npm run example:resume-after-restart -- resume  part 2 (a fresh start): collect the identity and keep it
 *
 *   USER / BROWSER               WALLET (this sample)                     IDENTITY PROVIDER
 *   ──────────────               ────────────────────                     ─────────────────
 *                                part 1
 *                                1. builds the request ─────────────────► provider's page
 *   2. verifies on the page ◄────────────────────────────────────────────
 *      the browser comes back ─► 3. reads the reply (its code_uri) and saves it, with the provider and identity
 *                                   numbers, then stops: the app is closed
 *                                part 2 (a fresh start: a new object from the same seed phrase)
 *                                4. reads what was saved
 *                                5. collects the identity ──────────────► the code_uri: the issued identity
 *                                   and checks it is this seed's
 *                                6. keeps it (exported, encrypted), and forgets the saved reply
 *
 * Testnet, with Concordium's test provider (index 0): its page shows a form with made-up details instead of asking
 * for documents. Settings:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (default: the next free one)
 *   IDENTITY_FOLDER  folder where the sample keeps the saved reply and the exported identity (default ./demo-identities)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
const folder = process.env.IDENTITY_FOLDER || './demo-identities';
const resuming = process.argv[2] === 'resume';

// Where this sample saves the provider's reply between the two parts. A real app uses its own storage (a phone's
// secure storage, its settings, a database): any place that survives a restart.
const pendingFile = join(folder, 'pending-identity.json');

// The same set-up in both parts: the provider list, the wallet's node connection, and the identity object from the
// seed phrase. In part 2 it is a NEW object, as after a restart: it knows nothing about part 1.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const config = { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node };
const identity = new ConcordiumIdentity(seedPhrase, config);

const cancel = new AbortController();
process.once('SIGINT', () => cancel.abort()); // Ctrl+C stops a wait cleanly

try {
  if (!resuming) {
    // ─── Part 1: verify, save the reply, stop ──────────────────────────────────────────────────────────────────
    const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
    const identityIndex = process.env.IDENTITY_INDEX !== undefined
      ? Number(process.env.IDENTITY_INDEX)
      : await identity.nextIdentityIndex({ providerIndex });

    // 1. Build the request, with the built-in listener as the return address (a desktop app; a phone app would
    //    use its own address, see the integration guide, chapter 3).
    const listener = await listenForIdentityCallback({ signal: cancel.signal });
    const { issuanceUrl } = await identity.createIdentityRequest({ providerIndex, identityIndex, redirectUri: listener.redirectUri });
    console.log(`Part 1. Identity number ${identityIndex} with provider ${providerIndex}.`);
    console.log('1. Open this link in a browser to verify (Ctrl+C to cancel):\n');
    console.log(issuanceUrl, '\n');

    // 2. The user verifies on the provider's page; the browser comes back to the listener.
    console.log('2. Waiting for the provider to send the browser back...');
    const callbackUrl = await listener.callback;

    // 3. Read the provider's reply (no network call) and save it, with the numbers the request was made for: a
    //    fresh start needs all three. Keep it private, like the identity: whoever has the code_uri can read the
    //    person's details from the provider. Here it is a file readable only by its owner.
    const { codeUri } = identity.parseIdentityCallback(callbackUrl);
    mkdirSync(folder, { recursive: true });
    writeFileSync(pendingFile, JSON.stringify({ codeUri, providerIndex, identityIndex }), { mode: 0o600 });
    console.log(`3. Back from the provider. Its reply is saved in ${pendingFile}.`);
    console.log('\nThe app now stops before collecting the identity, as if the user had closed it.');
    console.log('Start it again with: npm run example:resume-after-restart -- resume');
  } else {
    // ─── Part 2: a fresh start, continue from what was saved ───────────────────────────────────────────────────
    // 4. Read what part 1 saved. Nothing saved means no verification is waiting.
    let pending;
    try {
      pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
    } catch {
      throw new Error(`Nothing saved in ${pendingFile}: run part 1 first (npm run example:resume-after-restart).`);
    }
    const { codeUri, providerIndex, identityIndex } = pending;
    console.log(`Part 2, a fresh start. A verification is waiting: provider ${providerIndex}, identity ${identityIndex}.`);

    // 5. Collect the identity. This object did not make the request, so it is told which identity the request was
    //    for; it works the keys out again from the seed phrase and checks the identity was issued to them. If the
    //    provider is still checking, it waits (up to 15 minutes by default; set timeoutMs to change it).
    console.log('5. Collecting the identity from the provider...');
    const summary = await identity.waitForIdentity(codeUri, { providerIndex, identityIndex, signal: cancel.signal });
    console.log('   Identity issued:', summary);

    // 6. Keep the identity (exported, encrypted), then forget the saved reply: it is no longer needed.
    const exported = await identity.exportIdentity({ providerIndex, identityIndex });
    const file = keepIdentity(folder, { providerIndex, identityIndex }, exported);
    rmSync(pendingFile);
    console.log(`6. Kept (encrypted) in ${file}; the saved reply is deleted.`);
  }
} catch (e) {
  if (e instanceof IdentityIssuanceError && (e.reason === 'timeout' || e.reason === 'cancelled')) {
    // Not a failure of the verification: the saved reply is kept, so a later start can wait again.
    console.error(`\nStopped waiting (${e.reason}). The saved reply is kept: run part 2 again later.`);
  } else if (e instanceof IdentityIssuanceError) {
    console.error(`\nNo identity (${e.reason}): ${e.message}`);
  } else {
    console.error('\nFailed:', e.message);
  }
  process.exitCode = 1;
} finally {
  identity.dispose(); // wipe the seed and the identity held in memory
}
