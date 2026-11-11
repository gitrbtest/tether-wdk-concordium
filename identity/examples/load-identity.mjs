/**
 * Import an identity that verify-identity exported, in a fresh program: the text is read from the folder where the
 * sample kept it, and importIdentity checks it belongs to this seed phrase before holding it (one call to the node
 * for the network's parameters; none to the identity provider).
 *
 * The kept text is NOT encrypted: it holds the person's details. A real wallet reads it from its secure storage, where
 * it keeps the seed phrase; this sample uses a plain file only because it is a command-line demo with test identities.
 *
 *   npm run example:load-identity
 *
 * Use the same settings as for verify-identity:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (required: verify-identity prints it)
 *   IDENTITY_FOLDER  folder where the samples keep exported identities (default ./demo-identities)
 */
import {
  ConcordiumIdentity,
  IdentityStorageError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { keptIdentity, keptIdentityNumbers } from './kept-identities.mjs';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
const folder = process.env.IDENTITY_FOLDER || './demo-identities';

/** Say which identity numbers ARE kept, so the reader can pick one. */
function hint() {
  const kept = keptIdentityNumbers(folder, providerIndex);
  if (kept.length === 0) {
    console.log('Run npm run example:verify-identity first, with the same settings.');
    return;
  }
  console.log(`Identities kept for provider ${providerIndex} in ${folder}: ${kept.join(', ')}`);
  console.log(`To import one, set its number first, e.g. in PowerShell:  $env:IDENTITY_INDEX = ${kept[0]}`);
  console.log(`                                       or in bash:        export IDENTITY_INDEX=${kept[0]}`);
}

if (process.env.IDENTITY_INDEX === undefined) {
  console.log('IDENTITY_INDEX is not set: which identity should be imported?');
  hint();
  process.exit(1);
}
const identityIndex = Number(process.env.IDENTITY_INDEX);

// The identity provider list: the package does not fetch it. The wallet does (here from the wallet-proxy, once)
// and passes it in; only its shape matters.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
// A brand-new ConcordiumIdentity, as when a wallet app starts again: it holds nothing yet, only the seed phrase.
// The wallet's own connection to a Concordium node (here Concordium's public testnet node): the package never
// opens one itself.
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const identity = new ConcordiumIdentity(seedPhrase, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });

try {
  // The wallet's own copy: here, the text file verify-identity kept (a real wallet reads it from wherever it keeps it).
  const exported = keptIdentity(folder, { providerIndex, identityIndex });
  if (exported === null) {
    console.log(`Nothing kept in ${folder} for provider ${providerIndex}, identity ${identityIndex}.`);
    hint();
    process.exitCode = 1;
  } else {
    // Import it. importIdentity checks the identity's public key is the one this seed phrase gives for its provider
    // and identity number, so another wallet's identity is refused. The identity is then held, ready for createAccount.
    const summary = await identity.importIdentity(exported);
    console.log(`Imported from ${folder}:`, summary);
  }
} catch (e) {
  // IdentityStorageError: the text cannot be used (another seed phrase's identity, another network, or not an
  // exported identity at all): the package refuses it rather than use it.
  if (e instanceof IdentityStorageError) {
    console.error(`IdentityStorageError (${e.reason}): ${e.message}`);
  } else {
    console.error('Failed:', e.message);
  }
  process.exitCode = 1;
} finally {
  // Wipe the seed (and the identity held in memory) whatever happened above.
  identity.dispose();
}
