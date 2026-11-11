/**
 * Recovery on a new device, on testnet: everything back from the seed phrase alone, with no new verification,
 * no ID App, and nothing to remember but the seed phrase. The "new phone" has the seed and a folder of its own;
 * it asks every identity provider for the wallet's identities, keeps them (in secure storage, as the seed phrase), finds their accounts on
 * chain, and hands those to Tether's WDK through the wallet package, which reads their balances.
 *
 *   npm run example:recover-identity
 *
 * Read-only: nothing is sent to the chain and nothing is spent. Settings (environment variables):
 *   SEED_PHRASE      the wallet's seed phrase (default: a public demonstration phrase)
 *   IDENTITY_FOLDER  where the new phone keeps exported identities (default ./recovered-identities)
 *
 * How the identities are found: a wallet numbers its identities with each provider 0, 1, 2 …, so recoverAll
 * counts 0, 1, 2 … with every provider (stopping after a few numbers in a row with none). Identities given
 * other numbers, such as the demo wallet's random ones, are not found by counting; recoverIdentity gets one
 * of those back by its number.
 *
 * The default phrase is public and shared, so identities found with it may have been made by other people.
 */
import { ConcordiumIdentity, IdentityRecoveryError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { keepIdentity } from './kept-identities.mjs';
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const folder = process.env.IDENTITY_FOLDER || './recovered-identities';
const PLT = 'TN';
const CIS2 = 'cis2:12754:0:01';

/** A read from the testnet node, tried again a few times if the node is briefly unavailable (reads only). */
async function read(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const brief = /\b50[234]\b|unavailable|ECONNRESET|ETIMEDOUT|timed out/i.test(e?.message ?? '');
      if (!brief || attempt === 5) throw e;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const amount = (base, decimals, unit) => `${(Number(base) / 10 ** decimals).toFixed(decimals === 0 ? 0 : 2)} ${unit}`;
const yearMonth = (yyyymm) => `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}`;
const thisMonth = Number(new Date().toISOString().slice(0, 7).replace('-', ''));

// The two packages, both given the same seed phrase, as a wallet app on the new phone would:
// - `identity` (this package) handles identities: getting them back, exporting them to keep, finding their accounts;
// - `wallet` (the Phase 1 WDK wallet package) uses the accounts: balances, sending, tokens.
// The identity provider list: the package does not fetch it. The wallet does (here from the wallet-proxy, once)
// and passes it in; only its shape matters.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
// The wallet's own connection to a Concordium node (here Concordium's public testnet node): the package never
// opens one itself.
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const identity = new ConcordiumIdentity(seedPhrase, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });
const wallet = new WalletManagerConcordium(seedPhrase, { ...CONCORDIUM_TESTNET_CONFIG });

try {
  console.log(`A new phone: only the seed phrase, and a folder of its own (${folder}).\n`);

  // Step 1. Get every identity back. recoverAll asks each identity provider, "do you have identity 0 for this
  // seed? identity 1? identity 2? …", proving each time (with keys made from the seed) that the wallet owns it.
  // Each provider sends back the identity it issued, and the package checks it really belongs to this seed.
  // Nothing has to be remembered except the seed phrase: no documents, no new verification.
  // `identities` is what came back (each with its accounts, see step 3); `problems` lists any provider that
  // could not be asked (e.g. it was down), so one provider failing does not lose the others.
  console.log('1. Ask every identity provider for this seed\'s identities (no new verification)');
  const { identities, problems } = await identity.recoverAll();
  for (const p of problems) console.log(`   could not ask provider ${p.providerIndex}: ${p.error.message}`);
  if (identities.length === 0) {
    console.log('   none found for this seed phrase');
  }
  for (const x of identities) {
    const expired = Number(x.summary.validTo) < thisMonth;
    console.log(`   provider ${x.providerIndex}, identity ${x.identityIndex}: issued ${yearMonth(x.summary.createdAt)}, `
      + `valid until ${yearMonth(x.summary.validTo)}${expired ? ' (EXPIRED: no new accounts can be created from it)' : ''}`);
  }
  console.log('   each one checked to belong to this seed before it was kept\n');

  // Step 2. Keep them on the new phone. exportIdentity gives each identity as text, which the wallet keeps its own way.
  // NOT ENCRYPTED: the text holds the person's details, so a real wallet keeps it in its secure storage, like the seed
  // phrase (this sample uses a plain file each, for its test identities only). From now on the wallet imports them on
  // every start (importIdentity), with no need to ask the providers again.
  console.log('2. Export them and keep them (plain text with the details: a real wallet keeps it in secure storage)');
  for (const x of identities) {
    const exported = await identity.exportIdentity({ providerIndex: x.providerIndex, identityIndex: x.identityIndex });
    console.log(`   ${keepIdentity(folder, x, exported)}`);
  }
  console.log();

  // Step 3. Which accounts each identity has. recoverAll already looked them up (findAccounts): account
  // addresses are worked out from the seed (account 0, 1, 2 …), and the chain is asked which of them exist.
  // Each account comes with its `path` ('provider/identity/account'), which is how the wallet package asks for it.
  // `accounts` is null if they could not be looked up just now (the identity is still back; try again later).
  console.log('3. Their accounts on chain (addresses from the seed; the chain says which exist)');
  for (const x of identities) {
    const label = `provider ${x.providerIndex}, identity ${x.identityIndex}`;
    if (x.accounts === null) console.log(`   ${label}: accounts could not be looked up just now`);
    else if (x.accounts.length === 0) console.log(`   ${label}: no accounts`);
    else for (const a of x.accounts) console.log(`   ${label}: account #${a.credNumber} ${a.address}   (path ${a.path})`);
  }
  console.log();

  // Step 4. Use the accounts, through Tether's WDK. This is the hand-over from the identity package to the
  // Phase 1 wallet package: getAccountByPath(path) gives an account the wallet can use like any WDK account
  // (balances here; sending and tokens work the same). The balances prove these really are the wallet's
  // accounts, back on a new phone. (`read` just tries again if the testnet node is briefly busy.)
  console.log("4. Hand them to Tether's WDK: the wallet package reads each account by its path");
  for (const x of identities) {
    for (const a of x.accounts ?? []) {
      const account = await read(() => wallet.getAccountByPath(a.path));
      const [ccd, tn, cis2] = await read(() => Promise.all([
        account.getBalance(), account.getTokenBalance(PLT), account.getTokenBalance(CIS2),
      ]));
      console.log(`   ${a.path}: ${amount(ccd, 6, 'CCD')} · ${amount(tn, 6, PLT)} · ${amount(cis2, 0, 'CIS-2 units')}`);
    }
  }
  if (seedPhrase === DEMO_PHRASE) {
    console.log('\n(This demonstration phrase is public and shared: some identities found may have been made by other people.)');
  }
} catch (e) {
  console.error(e instanceof IdentityRecoveryError ? `IdentityRecoveryError (${e.reason}): ${e.message}` : `Failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  // Wipe the seed (and any identities held) from memory, in both packages, whatever happened above.
  identity.dispose();
  wallet.dispose();
}
