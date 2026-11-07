/**
 * An age check with a version 1 question, from start to finish, on testnet: a shop with no CCD asks "are you over
 * 18?", its partner pays the shop's small fee, and a wallet proves it from the identity itself: no account, and no
 * date of birth, is shown to the shop. Both sides run here, one after the other; in real life the question and the
 * answer travel between them (e.g. over WalletConnect).
 *
 *   npm run example:age-check-v1
 *
 * WRITES TO TESTNET AND SPENDS A FEE: each run records the shop's question on chain (its "anchor"), about EUR 0.013
 * (about 5 testnet CCD), paid by the sponsor. Settings (environment variables, all optional):
 *   SEED_PHRASE                               the wallet's seed phrase (default: a public demonstration phrase)
 *   SHOP_ADDRESS, SHOP_SIGNING_KEY            the shop's account and its signing key (hex)
 *   SPONSOR_ADDRESS, SPONSOR_SIGNING_KEY      the sponsor's account and its signing key (hex)
 * By default the shop and the sponsor are accounts 13 and 11 of the public demonstration phrase's test identity
 * (provider 0, identity 334563111): the shop's account has never held CCD, and the sponsor's is kept funded.
 *
 * The wallet is a "new phone": it has only the seed phrase, and gets its identities back from the providers first
 * (recoverAll), so no identity number needs to be known. The default phrase is public and shared, so identities found
 * with it may have been made by other people.
 */
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, ProofError, describeProofRequest, describeProofContext, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { requestForV1, checkPresentationV1, connectToNode } from '@concordium/wdk-identity-concordium/verify';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;

// ─── The shop's side (on its server) ─────────────────────────────────────────────────────────────────────────────

// The shop reads and writes the chain through a Concordium node: here, Concordium's public testnet node.
const node = connectToNode('testnet');

// The shop's account and its partner's (the sponsor's). Both sign the question's anchor; the sponsor pays its fee, so
// the shop's own account needs no CCD. A real shop has its own account (a company gets one with a Business ID) and
// keeps its key on its server; the defaults here are test accounts of the public demonstration phrase.
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

// Each question may be answered once. The shop remembers the questions already answered (by their anchor, the
// question's reference on chain) and refuses a second answer, so a copied answer cannot be used again. Here a list
// in memory; a real shop keeps it where its servers can all see it (its database, Redis, …), with the audit record.
const answeredQuestions = new Map();

/** The shop receives an answer to `question` and decides. */
async function shopReceives(answer, question) {
  if (answeredQuestions.has(question.transactionRef)) {
    return '✖ refused: this question was already answered (a copy of an answer cannot be used twice)';
  }
  const result = await checkPresentationV1(answer, question, { node, network: 'testnet' });
  answeredQuestions.set(question.transactionRef, result.auditRecord ?? null); // one answer per question, whatever the outcome
  if (!result.ok) return `✖ refused: ${result.reasons.map((r) => r.message).join(' ')}`;
  const [from] = result.credentials;
  return `✔ over 18 (an identity from provider ${from.issuer}; no account named); the shop never saw the date of birth.\n`
    + `   The shop keeps the audit record (the question and the answer): ${JSON.stringify(result.auditRecord).length} characters`;
}

// ─── The wallet's side (on the person's phone) ───────────────────────────────────────────────────────────────────

// The identity provider list: the package does not fetch it. The wallet does (here from the wallet-proxy, once)
// and passes it in; only its shape matters.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v1/ip_info')).json();
// The wallet's own connection to a Concordium node (separate from the shop's above, as on two different machines):
// the package never opens one itself. Answering a version 1 question reads its anchor through it.
const walletNode = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const identity = new ConcordiumIdentity(seedPhrase, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node: walletNode });

try {
  // Step 1. The shop writes the question and records it on chain (its anchor), with the sponsor paying the fee.
  // requestForV1 adds a fresh random nonce, waits until the anchor is final, and returns the question to send; the
  // shop keeps it to check the answer against. "providers" says whose identities the shop trusts: testnet 0, 1, 2.
  console.log('1. The shop asks: "are you over 18?", and records the question on chain (its partner pays the fee)');
  const question = await requestForV1(
    { network: 'testnet', website: 'age-check.example', purpose: 'age check', providers: [0, 1, 2], adult: true },
    { node, sender: shop.address, signer: shop.signer, sponsor },
  );
  const anchor = await node.getBlockItemStatus(sdk.TransactionHash.fromHexString(question.transactionRef));
  const fee = anchor.outcome.summary.sponsor?.cost;
  console.log(`   anchor: https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${question.transactionRef}`);
  console.log(`   fee: ${fee ? sdk.CcdAmount.toCcd(fee) : '?'} CCD, paid by the sponsor ${sponsor.address.slice(0, 8)}…; the shop paid nothing\n`);

  // Step 2. The wallet shows the person what is asked, and who is asking, in plain English, before they agree. (In an
  // app this is the consent screen.) The website name is what the shop wrote into its question: a wallet compares it
  // with the site it is actually connected to before showing it as fact.
  console.log('2. The wallet shows the person what is asked, and who asks');
  const asking = describeProofContext(question);
  console.log(`   ${asking.website} (${asking.purpose}) asks:`);
  for (const part of describeProofRequest(question)) {
    for (const ask of part.asks) console.log(`   "${ask.text}"`);
    console.log(`   (identities from providers ${part.providers.join(', ')} accepted; answered from: ${part.answerFrom})\n`);
  }

  // Step 3. A new phone: the wallet gets its identities back from the providers, from the seed phrase alone.
  console.log('3. The wallet gets its identities back from the seed phrase (recoverAll)');
  const { identities } = await identity.recoverAll();
  for (const x of identities) console.log(`   provider ${x.providerIndex}, identity ${x.identityIndex}, valid until ${x.summary.validTo.slice(0, 4)}-${x.summary.validTo.slice(4)}`);
  console.log();

  // Steps 4 and 5. Which identity can truly answer, and the answer. proveIdentity refuses, before building anything
  // or asking the node, an identity that has expired, whose provider the shop does not accept, or whose details do
  // not satisfy the question: the wallet never makes an answer that is not true. This sample takes the first identity
  // that can answer; a real wallet app would let the person choose. The answer is made from the identity itself, so
  // no account is needed or named; it is tied to the question's anchor, so it answers this question only.
  console.log('4. The wallet finds an identity that can truly answer, and 5. answers from it (no account)');
  const CANNOT = new Set(['identity-expired', 'provider-not-accepted', 'cannot-prove', 'account-only']);
  let answer;
  for (const x of identities) {
    try {
      answer = await identity.proveIdentity({ providerIndex: x.providerIndex, identityIndex: x.identityIndex, request: question });
      console.log(`   provider ${x.providerIndex}, identity ${x.identityIndex}: answers`);
      break;
    } catch (e) {
      if (!(e instanceof ProofError && CANNOT.has(e.reason))) throw e;
      console.log(`   provider ${x.providerIndex}, identity ${x.identityIndex}: cannot answer (${e.reason})`);
    }
  }
  if (!answer) throw new Error('No identity of this seed phrase can answer the question.');
  const sent = JSON.stringify(answer); // what travels to the shop
  console.log(`   answer: ${sent.length} characters, sent to the shop\n`);

  // Step 6. The shop checks the answer: for this question? the anchor on chain, and the answer tied to it? an accepted
  // provider? the identity still valid? does the maths hold against the provider's keys on chain?
  console.log('6. The shop checks the answer against the chain');
  console.log(`   ${await shopReceives(sent, question)}\n`);

  // Step 7. Someone sends the very same answer again (a copy, or a replay): refused, it was already used.
  console.log('7. The same answer arrives again');
  console.log(`   ${await shopReceives(sent, question)}`);

  if (seedPhrase === DEMO_PHRASE) {
    console.log('\n(This demonstration phrase is public and shared: some identities found may have been made by other people.)');
  }
} catch (e) {
  console.error(e instanceof ProofError ? `ProofError (${e.reason}): ${e.message}` : `Failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  // Wipe the seed (and the identities held) from memory, whatever happened above.
  identity.dispose();
}
