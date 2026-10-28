/**
 * Create a Concordium account on testnet from an identity saved by verify-identity, with no ID App:
 * load the identity, create the account, and print where to see it. Free: creating an account costs no
 * CCD. Running it again for the same account number finds the account instead of creating another.
 *
 *   npm run example:create-account
 *
 * Use the same settings as for verify-identity, plus:
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   PROVIDER_INDEX   identity provider index on the network (default 0)
 *   IDENTITY_INDEX   the wallet's identity number with that provider (default 0)
 *   IDENTITY_STORE   folder with the encrypted identity (default ./demo-identities)
 *   CRED_NUMBER      which account under the identity: 0, 1, 2… (default 0)
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
const identityIndex = Number(process.env.IDENTITY_INDEX ?? 0);
const credNumber = Number(process.env.CRED_NUMBER ?? 0);
const storeFolder = process.env.IDENTITY_STORE || './demo-identities';

const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, {
  store: new FileIdentityStore(storeFolder),
});

try {
  console.log(`1. Load identity ${identityIndex} (provider ${providerIndex}) from ${storeFolder}`);
  const summary = await identity.loadIdentity({ providerIndex, identityIndex });
  if (summary === null) {
    console.log(`   Nothing saved for it. Run npm run example:verify-identity first (or set IDENTITY_INDEX;`);
    console.log('   npm run example:load-identity lists the saved ones).');
    process.exitCode = 1;
  } else {
    console.log(`   loaded: valid to ${summary.validTo}, up to ${summary.maxAccounts} accounts\n`);

    console.log(`2. Create account ${credNumber} on testnet (sent through the wallet-proxy; usually a few seconds)`);
    const started = Date.now();
    const account = await identity.createAccount({ providerIndex, identityIndex, credNumber });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(account.created
      ? `   created in ${seconds} s, final on chain (transaction ${account.transactionHash})`
      : '   it already exists on chain: nothing was sent');
    console.log(`   address: ${account.address}`);
    console.log(`   path:    ${account.path}   (for the wallet package: getAccountByPath('${account.path}'))`);
    console.log(`   see it:  https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${account.address}`);
  }
} catch (e) {
  if (e instanceof AccountCreationError) {
    console.error(`AccountCreationError (${e.reason}): ${e.message}`);
  } else if (e instanceof IdentityStorageError) {
    console.error(`IdentityStorageError (${e.reason}): ${e.message}`);
  } else {
    console.error('Failed:', e.message);
  }
  process.exitCode = 1;
} finally {
  identity.dispose();
}
