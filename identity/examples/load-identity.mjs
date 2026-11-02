/**
 * Load an identity saved by verify-identity, in a fresh program: the encryption key is calculated
 * again from the seed, the encrypted bytes are read from the folder and decrypted. No call to the identity
 * provider, the wallet-proxy or the chain (the store here is a local folder).
 *
 *   npm run example:load-identity
 *
 * Use the same settings as for verify-identity:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (default 0)
 *   IDENTITY_STORE   folder with the encrypted identity (default ./demo-identities)
 */
import {
  ConcordiumIdentity,
  IdentityStorageError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { FileIdentityStore } from '@concordium/wdk-identity-concordium/node';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
const identityIndex = Number(process.env.IDENTITY_INDEX ?? 0);
const storeFolder = process.env.IDENTITY_STORE || './demo-identities';

/**
 * The identity numbers saved in the folder for this provider (testnet): one file per identity, named by its
 * number. Used only to give a helpful hint when the identity asked for is not there. (The package's stores do
 * not list their contents; this sample looks at the folder itself because it knows how FileIdentityStore names
 * its files.)
 */
function savedIdentityNumbers() {
  try {
    return readdirSync(join(storeFolder, 'concordium-identity', 'testnet', String(providerIndex)))
      .filter((name) => /^\d+\.bin$/.test(name))
      .map((name) => name.slice(0, -'.bin'.length));
  } catch {
    return []; // no folder yet: nothing saved
  }
}

// A brand-new ConcordiumIdentity, as when a wallet app starts again: it holds nothing yet. It is given the same
// seed phrase and the same store (the folder) that verify-identity saved into.
const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, {
  store: new FileIdentityStore(storeFolder),
});

try {
  // Load the saved identity. The package works out the slot name from the provider and identity number, asks the
  // store for those bytes, rebuilds the encryption key from the seed, and decrypts. Decrypting only works with
  // the right seed and the right slot, so a successful load also proves the identity is this wallet's and was
  // not swapped or damaged. The identity is then held, ready for createAccount. null means nothing is saved there.
  const summary = await identity.loadIdentity({ providerIndex, identityIndex });
  if (summary === null) {
    // Nothing saved under this number: say which numbers ARE saved, so the reader can pick one.
    const from = process.env.IDENTITY_INDEX === undefined ? 'IDENTITY_INDEX is not set, so the default' : 'from IDENTITY_INDEX';
    console.log(`Nothing saved in ${storeFolder} for provider ${providerIndex}, identity ${identityIndex} (${from}).`);
    const saved = savedIdentityNumbers();
    if (saved.length > 0) {
      console.log(`Saved identities for provider ${providerIndex} in this folder: ${saved.join(', ')}`);
      console.log(`To load one, set its number first, e.g. in PowerShell:  $env:IDENTITY_INDEX = ${saved[0]}`);
      console.log(`                                     or in bash:        export IDENTITY_INDEX=${saved[0]}`);
    } else {
      console.log('Run npm run example:verify-identity first, with the same settings.');
    }
    process.exitCode = 1;
  } else {
    console.log(`Loaded from ${storeFolder}:`, summary);
  }
} catch (e) {
  // IdentityStorageError: something is saved there but it cannot be used (another seed, another slot, or damaged
  // bytes): the package refuses it rather than use it.
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
