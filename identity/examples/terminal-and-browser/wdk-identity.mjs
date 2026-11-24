/**
 * Identity inside WDK (a proposal), end to end on testnet: an app registers Concordium's wallet AND its identity
 * manager with WDK, verifies the user's identity, creates an account from it, gets that account through WDK, and
 * proves "over 18" from it to a shop, all through WDK's proposed identity methods.
 *
 *   npm run example:wdk-identity
 *
 * Needs the proposal's forks of Tether's packages (installed as this package's dev dependencies): @tetherto/wdk with
 * registerIdentity / registerIdentityProtocol, and @tetherto/wdk-wallet with the IdentityManager and IdentityProtocol
 * base classes.
 *
 * Who is who:
 *
 *   THE APP (this script)                  WDK                                CONCORDIUM (this package, /wdk entry)
 *   ─────────────────────                  ───                                ─────────────────────────────────────
 *   1. registers the wallet and identity ► builds both with its seed
 *   2. startVerification ───────────────────────────────────────────────────► the provider's link
 *      the user verifies in a browser; the provider sends it back to the local listener
 *      completeVerification ────────────────────────────────────────────────► collects and checks the identity
 *   3. createAccount ───────────────────────────────────────────────────────► a new account on chain (free)
 *   4. getAccountByPath ─────────────────► the Concordium account, with getIdentityProtocol
 *   5. THE SHOP asks "over 18?", recorded on chain (its partner pays the fee)
 *   6. describeRequest ─────────────────────────────────────────────────────► the consent wording
 *   7. prove ───────────────────────────────────────────────────────────────► the answer, naming the account
 *      THE SHOP checks it against the chain
 *
 * WRITES TO TESTNET: a new identity with the test provider (free), a new account (free), and the shop's question
 * (about 5 testnet CCD, paid by the sponsor). Settings (environment variables, all optional):
 *   SEED_PHRASE                            the wallet's seed phrase (default: a public demonstration phrase)
 *   OPEN_BROWSER                           set to 1 to open the verification page in the default browser
 *   SHOP_ADDRESS, SHOP_SIGNING_KEY         the shop's account and its signing key (hex)
 *   SPONSOR_ADDRESS, SPONSOR_SIGNING_KEY   the sponsor's account and its signing key (hex)
 * By default the shop and the sponsor are accounts 13 and 11 of the public demonstration phrase's test identity, as in
 * the age-check example. Concordium's test provider (0) shows a form with made-up details: keep its date of birth
 * (over 18) and leave "Fail identity" unticked.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import WDK from '@tetherto/wdk';
import { IdentityError } from '@tetherto/wdk-wallet/identity';
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';
import { CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { ConcordiumIdentityManager, ConcordiumIdentityProtocol } from '@concordium/wdk-identity-concordium/wdk';
import { listenForIdentityCallback } from '@concordium/wdk-identity-concordium/node';
import { requestFor, checkPresentation, connectToNode } from '@concordium/wdk-identity-concordium/verify';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;

// ─── The shop's side (on its server): its account and its partner's, as in the age-check example ─────────────────
const demoKey = (credNumber) => sdk.ConcordiumHdWallet.fromSeedPhrase(DEMO_PHRASE, 'Testnet')
  .getAccountSigningKey(0, 334563111, credNumber).toString('hex');
const shop = {
  address: process.env.SHOP_ADDRESS || '4rEgzrWemrBjxUvkcEkDt9AfB2F7JdS8jkW3M9UWWK1TYaWSX1', // account 13
  signer: sdk.buildBasicAccountSigner(process.env.SHOP_SIGNING_KEY || demoKey(13)),
};
const sponsor = {
  address: process.env.SPONSOR_ADDRESS || '4kJZHvmLwMJjPp58ie7ZZirRkSZL1WLfcKbcrCdBAzweSj9fTU', // account 11
  signer: sdk.buildBasicAccountSigner(process.env.SPONSOR_SIGNING_KEY || demoKey(11)),
};
const shopNode = connectToNode('testnet');

/** The verification link is too long for the Windows command line: open a short local address that redirects to it. */
async function openInBrowser(link) {
  const server = createServer((request, response) => { response.writeHead(302, { location: link }); response.end(); server.close(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const short = `http://127.0.0.1:${server.address().port}/start`;
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', short]]
    : process.platform === 'darwin' ? ['open', [short]] : ['xdg-open', [short]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

// ─── The app ─────────────────────────────────────────────────────────────────────────────────────────────────────
// What the wallet app passes for the identity manager: the provider list (the app fetches it) and its node connection.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());

// 1. One seed, given once, to WDK. WDK builds the Concordium wallet and the Concordium identity manager with it.
const wdk = new WDK(seedPhrase)
  .registerWallet('concordium', WalletManagerConcordium, { ...CONCORDIUM_TESTNET_CONFIG })
  .registerIdentity('concordium', ConcordiumIdentityManager, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node })
  .registerIdentityProtocol('concordium', 'concordium-id', ConcordiumIdentityProtocol);
const identities = wdk.getIdentity('concordium');
console.log('1. WDK has the Concordium wallet and identity manager, built with one seed.\n');

try {
  // 2. Verify: the provider's link, the user verifies in a browser, the identity is collected.
  const providers = await identities.getProviders();
  console.log(`2. Identity providers: ${providers.map((p) => `${p.id} ${p.name}`).join(', ')}`);
  const listener = await listenForIdentityCallback();
  const { url, identity } = await identities.startVerification({ provider: '0', returnUrl: listener.redirectUri });
  console.log(`   Verifying with provider 0, as identity ${identity.identityIndex}. Open this link (Ctrl+C to stop):\n\n${url}\n`);
  if (process.env.OPEN_BROWSER === '1') await openInBrowser(url);
  const returned = await listener.callback;
  const summary = await identities.completeVerification(identity, returned);
  console.log(`   Identity collected: valid to ${summary.validTo.toISOString().slice(0, 10)} (no personal details in the summary).\n`);

  // 3. An account from the identity (free; final in a few seconds).
  const { path, address } = await identities.createAccount(identity);
  console.log(`3. Account created: ${address} (path ${path})\n   https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${address}\n`);

  // 4. The account, through WDK, like any other chain's account; it now has getIdentityProtocol.
  const account = await wdk.getAccountByPath('concordium', path);
  console.log(`4. Through WDK: ${await account.getAddress()}, balance ${await account.getBalance()} microCCD\n`);

  // 5. The shop asks "over 18?", answered from an account; the question is recorded on chain, its partner pays.
  console.log('5. The shop asks "are you over 18?" (recording the question on chain, a few seconds)...');
  const question = await requestFor(
    { network: 'testnet', website: 'shop.example', purpose: 'age check', providers: [0, 1, 2, 3, 4, 5], adult: true, answerFrom: 'account' },
    { node: shopNode, sender: shop.address, signer: shop.signer, sponsor },
  );
  console.log(`   Recorded: https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${question.transactionRef}\n`);

  // 6. The consent screen: what the wallet shows the user before answering.
  const protocol = account.getIdentityProtocol('concordium-id');
  const described = await protocol.describeRequest(question);
  console.log(`6. ${described.requester} asks (${described.purpose}):`);
  for (const ask of described.asks) console.log(`     - ${ask.text}`);
  console.log('   (the user agrees)\n');

  // 7. The answer, from this account; the shop checks it against the chain.
  const proof = await protocol.prove(question);
  const result = await checkPresentation(proof, question, { node: shopNode, network: 'testnet' });
  const from = result.credentials?.[0]?.account;
  console.log(`7. The shop checks the answer: ${result.ok ? 'accepted' : `refused: ${result.reasons.map((r) => r.message).join(' ')}`}`);
  console.log(`   answered from ${from}${from === address ? ' (the account created in step 3)' : ''}; nothing else was shown.`);
} catch (e) {
  console.error(e instanceof IdentityError ? `\nStopped (${e.reason}): ${e.message}` : `\nFailed: ${e.message}`);
  process.exitCode = 1;
} finally {
  wdk.dispose(); // the wallet and the identity manager erase their seed copies
  shopNode.close?.();
}
