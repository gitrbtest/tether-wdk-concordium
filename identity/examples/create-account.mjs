/**
 * Create a Concordium account on testnet from an identity saved by verify-identity, with no ID App:
 * load the identity, create the account, and print where to see it. Free: creating an account costs no
 * CCD. Without CRED_NUMBER it creates the next new account each run; with it, running again for the same number
 * finds that account instead of creating another.
 *
 *   npm run example:create-account
 *
 * Use the same settings as for verify-identity, plus:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (required: verify-identity prints it)
 *   IDENTITY_STORE   folder with the encrypted identity (default ./demo-identities)
 *   CRED_NUMBER      which account under the identity: 0, 1, 2… (default: the next new one, from nextCredNumber)
 */
import {
  ConcordiumIdentity,
  AccountCreationError,
  IdentityStorageError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { FileIdentityStore } from '@concordium/wdk-identity-concordium/node';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
if (process.env.IDENTITY_INDEX === undefined) {
  console.error('Set IDENTITY_INDEX to the identity number verify-identity printed (npm run example:load-identity lists them).');
  process.exit(1);
}
const identityIndex = Number(process.env.IDENTITY_INDEX);
const storeFolder = process.env.IDENTITY_STORE || './demo-identities';

// The identity package with the wallet's seed phrase and the folder verify-identity saved the identity into.
const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, {
  store: new FileIdentityStore(storeFolder),
});

try {
  // 1. Load the saved identity (as load-identity does): an account can only be made from an identity the
  //    wallet holds. null means nothing is saved for this provider and identity number.
  console.log(`1. Load identity ${identityIndex} (provider ${providerIndex}) from ${storeFolder}`);
  const summary = await identity.loadIdentity({ providerIndex, identityIndex });
  if (summary === null) {
    console.log(`   Nothing saved for it. Run npm run example:verify-identity first (or set IDENTITY_INDEX;`);
    console.log('   npm run example:load-identity lists the saved ones).');
    process.exitCode = 1;
  } else {
    console.log(`   loaded: valid to ${summary.validTo}, up to ${summary.maxAccounts} accounts\n`);

    // 2. Create the account. createAccount first checks the identity is not expired and that the account number
    //    is allowed, and asks the chain whether this account already exists (then it just returns it, sending
    //    nothing). Otherwise it builds the account's "credential" from the identity: the new account's public key
    //    plus mathematical proofs that a provider verified this person. The identity itself and the person's
    //    details are NOT sent. It sends that through the wallet-proxy and waits until the chain has accepted it
    //    for good ("final"). Creating an account is free.
    // Which account: the one given, or the next new one (nextCredNumber asks the chain which accounts this
    // identity already has, so a new account never lands on an existing one).
    const credNumber = process.env.CRED_NUMBER !== undefined
      ? Number(process.env.CRED_NUMBER)
      : await identity.nextCredNumber({ providerIndex, identityIndex });
    console.log(`2. Create account ${credNumber} on testnet (sent through the wallet-proxy; usually a few seconds)`);
    const started = Date.now();
    const account = await identity.createAccount({ providerIndex, identityIndex, credNumber });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(account.created
      ? `   created in ${seconds} s, final on chain (transaction ${account.transactionHash})`
      : '   it already exists on chain: nothing was sent');
    console.log(`   address: ${account.address}`);
    // The path ('provider/identity/account') is how Tether's WDK wallet package finds this account: see
    // wdk-end-to-end for using it to receive and send.
    console.log(`   path:    ${account.path}   (for the wallet package: getAccountByPath('${account.path}'))`);
    console.log(`   see it:  https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${account.address}`);
  }
} catch (e) {
  // AccountCreationError says why no account was made (e.g. identity-expired, rejected by the chain, timeout);
  // IdentityStorageError, why the saved identity could not be loaded.
  if (e instanceof AccountCreationError) {
    console.error(`AccountCreationError (${e.reason}): ${e.message}`);
  } else if (e instanceof IdentityStorageError) {
    console.error(`IdentityStorageError (${e.reason}): ${e.message}`);
  } else {
    console.error('Failed:', e.message);
  }
  process.exitCode = 1;
} finally {
  // Wipe the seed (and the identity held in memory) whatever happened above.
  identity.dispose();
}
