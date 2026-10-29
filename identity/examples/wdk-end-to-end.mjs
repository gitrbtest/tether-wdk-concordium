/**
 * The whole story on testnet, with no ID App: an identity saved by verify-identity → new accounts created from it
 * (this package) → used through Tether's WDK with @concordium/wdk-wallet-concordium (the wallet package):
 * receive CCD, a protocol-level token (PLT) and a CIS-2 token, send some back, and have a second new account,
 * holding no CCD at all, send a PLT to the first, its fee paid by a sponsor.
 *
 *   npm run example:wdk-end-to-end
 *
 * Spends a little testnet CCD and tokens from a funding account (yours: never printed, never sent anywhere but
 * the testnet node). Settings (environment variables):
 *   SEED_PHRASE, PROVIDER_INDEX, IDENTITY_INDEX, IDENTITY_STORE   as for verify-identity and create-account
 *   FUNDING_SEED, FUNDING_PATH  the funding account: its seed phrase and "provider/identity/cred" path. If not
 *                               set, TESTNET_SEED and TESTNET_PROVIDER_INDEX / TESTNET_IDENTITY_INDEX (cred 0)
 *                               are used, read from ../.env.testnet when that file exists (the wallet package's
 *                               integration-test account).
 *   PLT_TOKEN                   default "TN";  CIS2_TOKEN  default "cis2:12754:0:01"
 *
 * Account numbers 10–99 of the identity are used by this example (the first unused ones), separate from the
 * live test's 100–199.
 *
 * The testnet node the wallet package talks to can be briefly unavailable (e.g. "HTTP status code 502"): reads
 * are retried; a transfer is never sent twice. Each transfer's fee is quoted first and checked against the
 * sender's CCD.
 */
import { existsSync } from 'node:fs';
import { ConcordiumIdentity, AccountCreationError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { FileIdentityStore } from '@concordium/wdk-identity-concordium/node';
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG, AccountNotCreatedError } from '@concordium/wdk-wallet-concordium';

// ---- Settings ---------------------------------------------------------------------------------------------

// The funding account's settings, from ../.env.testnet when not given (Node.js 20.12+ reads .env files itself).
const envFile = new URL('../../.env.testnet', import.meta.url);
if (!process.env.FUNDING_SEED && !process.env.TESTNET_SEED && existsSync(envFile) && process.loadEnvFile) {
  process.loadEnvFile(envFile);
}

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;
const providerIndex = Number(process.env.PROVIDER_INDEX ?? 0);
const identityIndex = Number(process.env.IDENTITY_INDEX ?? 0);
const storeFolder = process.env.IDENTITY_STORE || './demo-identities';
const FUNDING_SEED = process.env.FUNDING_SEED || process.env.TESTNET_SEED;
const FUNDING_PATH = process.env.FUNDING_PATH
  || (process.env.TESTNET_PROVIDER_INDEX && `${process.env.TESTNET_PROVIDER_INDEX}/${process.env.TESTNET_IDENTITY_INDEX}/0`);
const PLT = process.env.PLT_TOKEN || 'TN';
const CIS2 = process.env.CIS2_TOKEN || 'cis2:12754:0:01';
const EXAMPLE_ACCOUNTS = { first: 10, last: 99 };

// In base units: CCD and TN have 6 decimals, this CIS-2 token none. Fees are pegged to a euro value, so in CCD
// they are several CCD per transfer on testnet (seen 28–29 Oct: about 3.6 for CCD, 4.7 for TN, 11.5 for this
// CIS-2 token): the new account gets enough CCD for its three sends, with room to spare.
const AMOUNTS = {
  fund: { ccd: 40_000_000n, plt: 5_000_000n, cis2: 500n },
  back: { ccd: 1_000_000n, plt: 1_000_000n, cis2: 100n },
  sponsored: { give: 2_000_000n, send: 1_000_000n },
};

// ---- Helpers: output ----------------------------------------------------------------------------------------

const ccd = (micro) => `${(Number(micro) / 1e6).toFixed(6)} CCD`;
const plt = (base) => `${(Number(base) / 1e6).toFixed(6)} ${PLT}`;
const tokenName = (token) => (token === PLT ? PLT : 'CIS-2');
const accountLink = (address) => `https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${address}`;
const txLink = (hash) => `https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${hash}`;
const step = (n, text) => console.log(`\n${n}. ${text}`);
const done = (text) => console.log(`   ✔ ${text}`);
const waiting = (text) => console.log(`   … ${text}`);
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

// ---- Helpers: a node that can be briefly unavailable --------------------------------------------------------

/** Errors that mean "the node or the network failed for a moment", not "the request is wrong". */
const isTransient = (e) => e?.code === 14 /* gRPC UNAVAILABLE */ || e?.code === 4 /* DEADLINE_EXCEEDED */
  || /\b50[234]\b|unavailable|ECONNRESET|ETIMEDOUT|socket hang up|timed out/i.test(e?.message ?? '');

/**
 * Run a READ (balances, finding an account): on a transient failure, wait and try again, up to 5 times.
 * Never used for sending, which must not happen twice.
 */
async function read(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt === 5) throw e;
      waiting(`the testnet node did not answer (${e.message}); reading ${what} again`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Send once and wait until final. If the node fails after the transfer was submitted, it may still have gone
 * through: say so instead of sending again.
 */
async function sendOnce(description, send) {
  try {
    return await send();
  } catch (e) {
    if (isTransient(e)) {
      throw new Error(`The testnet node failed during "${description}" (${e.message}). The transfer may have gone `
        + 'through: check the accounts on CCDScan before running again.');
    }
    throw e;
  }
}

/** The CCD a sender needs: the quoted fee, plus the amount when sending CCD. Stops clearly if it is short. */
async function checkEnoughCcd(sender, address, fee, amount = 0n) {
  const balance = await read('the CCD balance', () => sender.getBalance());
  if (balance < fee + amount) {
    throw new Error(`Account ${address} has ${ccd(balance)}, but this transfer needs ${ccd(fee + amount)} `
      + `(fee ${ccd(fee)}${amount ? ` + ${ccd(amount)} sent` : ''}).`);
  }
}

// ---- Helpers: accounts ---------------------------------------------------------------------------------------

/** Create the first unused account in the example's range (an existing one is found, nothing sent). */
async function nextNewAccount(identity) {
  for (let credNumber = EXAMPLE_ACCOUNTS.first; credNumber <= EXAMPLE_ACCOUNTS.last; credNumber++) {
    const account = await identity.createAccount({ providerIndex, identityIndex, credNumber });
    if (account.created) return account;
  }
  throw new Error(`All example accounts (${EXAMPLE_ACCOUNTS.first}–${EXAMPLE_ACCOUNTS.last}) of this identity are used.`);
}

/** The wallet package's account for a path. A brand-new account can take a moment to reach the node it asks. */
async function walletAccount(manager, path) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(`account ${path}`, () => manager.getAccountByPath(path));
    } catch (e) {
      if (!(e instanceof AccountNotCreatedError) || attempt === 10) throw e;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function balances(account) {
  return read('the balances', async () => ({
    ccd: await account.getBalance(), plt: await account.getTokenBalance(PLT), cis2: await account.getTokenBalance(CIS2),
  }));
}
const showBalances = (b) => console.log(`   balances: ${ccd(b.ccd)} · ${plt(b.plt)} · ${b.cis2} units of ${CIS2}`);

// ---- The story ----------------------------------------------------------------------------------------------

if (!FUNDING_SEED || !FUNDING_PATH) {
  console.error('A funding account is needed (FUNDING_SEED and FUNDING_PATH, or ../.env.testnet). See the header of this file.');
  process.exit(1);
}

const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { store: new FileIdentityStore(storeFolder) });
const wallet = new WalletManagerConcordium(seedPhrase, { ...CONCORDIUM_TESTNET_CONFIG });   // the new accounts, through WDK
const funder = new WalletManagerConcordium(FUNDING_SEED, { ...CONCORDIUM_TESTNET_CONFIG }); // the funding account

try {
  step(1, `Load the saved identity ${identityIndex} (provider ${providerIndex})          [this package]`);
  const summary = await identity.loadIdentity({ providerIndex, identityIndex });
  if (summary === null) throw new Error(`Nothing saved in ${storeFolder}: run npm run example:verify-identity first, or set IDENTITY_INDEX.`);
  done(`valid to ${summary.validTo}, up to ${summary.maxAccounts} accounts`);

  step(2, 'Create a new account from it: no ID App, no fee                       [this package]');
  waiting('sending the account\'s credential and waiting until it is final');
  let started = Date.now();
  const created = await nextNewAccount(identity);
  done(`account ${created.credNumber}: ${created.address}  (final in ${seconds(started)})`);
  console.log(`   ${accountLink(created.address)}`);

  step(3, `Hand it to Tether's WDK: getAccountByPath('${created.path}')        [wallet package]`);
  const account = await walletAccount(wallet, created.path);
  const funding = await walletAccount(funder, FUNDING_PATH);
  const fundingAddress = await read('the funding address', () => funding.getAddress());
  done(`the wallet package sees ${await read('the address', () => account.getAddress())}`);
  showBalances(await balances(account));

  step(4, `Receive: the funding account sends ${ccd(AMOUNTS.fund.ccd)}, ${plt(AMOUNTS.fund.plt)} and ${AMOUNTS.fund.cis2} CIS-2 units`);
  for (const [token, amount] of [['CCD', AMOUNTS.fund.ccd], [PLT, AMOUNTS.fund.plt], [CIS2, AMOUNTS.fund.cis2]]) {
    const name = token === 'CCD' ? 'CCD' : tokenName(token);
    waiting(`sending ${name}, waiting until final`);
    started = Date.now();
    const { hash } = await sendOnce(`funding sends ${name}`, () => (token === 'CCD'
      ? funding.sendTransaction({ to: created.address, value: amount })
      : funding.transfer({ token, recipient: created.address, amount })));
    done(`${name.padEnd(5)} final in ${seconds(started)}: ${txLink(hash)}`);
  }
  showBalances(await balances(account));

  step(5, 'Send from the new account: some of each back, the fee quoted first   [wallet package]');
  for (const [token, amount] of [['CCD', AMOUNTS.back.ccd], [PLT, AMOUNTS.back.plt], [CIS2, AMOUNTS.back.cis2]]) {
    const name = token === 'CCD' ? 'CCD' : tokenName(token);
    const { fee } = await read(`the ${name} fee`, () => (token === 'CCD'
      ? account.quoteSendTransaction({ to: fundingAddress, value: amount })
      : account.quoteTransfer({ token, recipient: fundingAddress, amount })));
    await checkEnoughCcd(account, created.address, fee, token === 'CCD' ? amount : 0n);
    waiting(`sending ${name} (fee ${ccd(fee)}), waiting until final`);
    started = Date.now();
    const { hash } = await sendOnce(`the new account sends ${name}`, () => (token === 'CCD'
      ? account.sendTransaction({ to: fundingAddress, value: amount })
      : account.transfer({ token, recipient: fundingAddress, amount })));
    done(`${name.padEnd(5)} final in ${seconds(started)}: ${txLink(hash)}`);
  }
  showBalances(await balances(account));

  // Three roles, three accounts: the SENDER (a second new account, with TN but no CCD), the RECIPIENT (the
  // first new account) and the SPONSOR (the funding account, standing in for the wallet operator).
  step(6, `Sponsored: a second new account holding ${PLT} but NO CCD sends ${plt(AMOUNTS.sponsored.send)} to the first; a sponsor pays the fee`);
  waiting('creating a second account and giving it some TN (no CCD)');
  const second = await nextNewAccount(identity);
  const sender = await walletAccount(wallet, second.path);
  await sendOnce(`funding sends ${PLT} to the second account`,
    () => funding.transfer({ token: PLT, recipient: second.address, amount: AMOUNTS.sponsored.give }));
  const senderBefore = await balances(sender);
  const recipientBefore = await balances(account);
  done(`sender    account ${second.credNumber}: ${second.address}  holds ${plt(senderBefore.plt)} and ${ccd(senderBefore.ccd)}`);
  done(`recipient account ${created.credNumber}: ${created.address}  holds ${plt(recipientBefore.plt)}`);
  done(`sponsor   the funding account: ${fundingAddress}`);
  waiting('the sender signs its transfer, the sponsor signs to pay the fee; waiting until final');
  started = Date.now();
  let tx = await sender.buildSponsorableTransfer({ token: PLT, recipient: created.address, amount: AMOUNTS.sponsored.send, sponsorAddress: fundingAddress });
  tx = await sender.signAsAccountToBeSponsored(tx);   // the sender signs its transfer
  tx = await funding.signAsSponsorSigned(tx);          // the sponsor signs to pay the fee
  const { hash } = await sendOnce('the sponsored transfer', () => sender.submitSponsored(tx));
  const [senderAfter, recipientAfter] = [await balances(sender), await balances(account)];
  done(`final in ${seconds(started)}: ${txLink(hash)}`);
  done(`sender    now holds ${plt(senderAfter.plt)} and still ${ccd(senderAfter.ccd)}: the sponsor paid the fee`);
  done(`recipient now holds ${plt(recipientAfter.plt)}`);

  console.log('\nDone. Everything above is on testnet; the links open it on CCDScan, Concordium\'s explorer.');
} catch (e) {
  if (e instanceof AccountCreationError) console.error(`\nAccountCreationError (${e.reason}): ${e.message}`);
  else console.error(`\nStopped: ${e.message}`);
  process.exitCode = 1;
} finally {
  identity.dispose();
  wallet.dispose();
  funder.dispose();
}
