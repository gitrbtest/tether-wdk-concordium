/**
 * An age check from start to finish, on testnet: a website (the "shop") asks "are you over 18?", a wallet proves it
 * without showing the date of birth, and the shop checks the proof against the chain. Both sides run here, one after
 * the other; in real life the question and the answer travel between them (e.g. over WalletConnect).
 *
 *   npm run example:age-check
 *
 * Read-only: nothing is sent to the chain and nothing is spent. Settings (environment variables):
 *   SEED_PHRASE   the wallet's seed phrase (default: a public demonstration phrase)
 *
 * The wallet is a "new phone": it has only the seed phrase, and gets its identities back from the providers first
 * (recoverAll), so no identity number needs to be known.
 *
 * The default phrase is public and shared, so identities found with it may have been made by other people.
 */
import { ConcordiumIdentity, ProofError, describeProofRequest, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { requestFor, checkPresentation, connectToNode } from '@concordium/wdk-identity-concordium/verify';

// Public demonstration phrase only. Never use it for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seedPhrase = process.env.SEED_PHRASE || DEMO_PHRASE;

// ─── The shop's side (on its server) ─────────────────────────────────────────────────────────────────────────────

// The shop reads the chain through a Concordium node: here, Concordium's public testnet node.
const node = connectToNode('testnet');

// Each question may be answered once. The shop remembers the questions already answered (by their challenge, the
// question's one-time reference number) and refuses a second answer, so a copied answer cannot be used again.
// Here a list in memory; a real shop keeps it where its servers can all see it (its database, Redis, …).
const answeredQuestions = new Set();

/** The shop receives an answer to `question` and decides. */
async function shopReceives(answer, question) {
  if (answeredQuestions.has(question.challenge)) {
    return '✖ refused: this question was already answered (a copy of an answer cannot be used twice)';
  }
  answeredQuestions.add(question.challenge); // one answer per question, whatever happens next
  const result = await checkPresentation(answer, question, { node, network: 'testnet' });
  if (!result.ok) return `✖ refused: ${result.reasons.map((r) => r.message).join(' ')}`;
  return `✔ over 18 (account ${result.account}); the shop never saw the date of birth`;
}

// ─── The wallet's side (on the person's phone) ───────────────────────────────────────────────────────────────────

// The identity provider list: the package does not fetch it. The wallet does (here from the wallet-proxy, once)
// and passes it in; only its shape matters.
const identityProviders = await (await fetch(`${CONCORDIUM_TESTNET_IDENTITY_CONFIG.walletProxyUrl}/v1/ip_info`)).json();
const identity = new ConcordiumIdentity(seedPhrase, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders });

try {
  // Step 1. The shop writes the question. requestFor adds a fresh random challenge, and the shop keeps the question
  // to check the answer against. "providers" says whose identities the shop trusts: here, testnet providers 0, 1, 2.
  console.log('1. The shop asks: "are you over 18?"');
  const question = requestFor({ providers: [0, 1, 2], adult: true });
  console.log(`   one-time reference number (challenge): ${question.challenge.slice(0, 16)}…\n`);

  // Step 2. The wallet shows the person what is asked, in plain English, before they agree. (In an app this is the
  // consent screen; here we just print it.)
  console.log('2. The wallet shows the person what the shop asks');
  for (const part of describeProofRequest(question)) {
    for (const ask of part.asks) console.log(`   "${ask.text}"`);
    console.log(`   (identities from providers ${part.providers.join(', ')} accepted)\n`);
  }

  // Step 3. A new phone: the wallet gets its identities back from the providers, from the seed phrase alone.
  console.log('3. The wallet gets its identities back from the seed phrase (recoverAll)');
  const { identities } = await identity.recoverAll();
  for (const x of identities) console.log(`   provider ${x.providerIndex}, identity ${x.identityIndex}, valid until ${x.summary.validTo.slice(0, 4)}-${x.summary.validTo.slice(4)}`);
  console.log();

  // Step 4. Which account can truly answer? accountsThatCanAnswer says, for an identity: none if it has expired,
  // if the shop does not accept its provider, or if its details do not satisfy the question; otherwise its
  // accounts on chain. The wallet never makes an answer that is not true.
  //
  // Which account answers: this sample simply takes the first identity that can answer, and the first account in
  // its list (accounts[0]). A real wallet app would show the user the accounts that can answer (from every
  // identity) and let them choose. Whichever is chosen, its credNumber (the account's number under its identity:
  // 0, 1, 2 …) is what step 5 passes to prove, so any of the listed accounts works, not only the first.
  console.log('4. The wallet finds an account that can truly answer');
  let chosen;
  for (const x of identities) {
    const which = { providerIndex: x.providerIndex, identityIndex: x.identityIndex };
    const accounts = await identity.accountsThatCanAnswer({ ...which, ...question });
    console.log(`   provider ${x.providerIndex}, identity ${x.identityIndex}: ${accounts.length ? accounts.map((a) => a.address).join(', ') : 'cannot answer (expired, not accepted, or not true)'}`);
    if (!chosen && accounts.length) chosen = { ...which, credNumber: accounts[0].credNumber, address: accounts[0].address };
  }
  if (!chosen) throw new Error('No identity of this seed phrase can answer the question.');
  console.log(`   chosen: ${chosen.address}\n`);

  // Step 5. The wallet makes the answer: a proof that the date of birth sealed in that account's record on chain is
  // before the date asked, tied to this question's challenge. The date of birth itself is not in it.
  console.log('5. The wallet answers with a proof (the date of birth stays on the phone)');
  const answer = await identity.prove({ ...chosen, ...question });
  console.log(`   answer: ${answer.toString().length} characters, sent to the shop\n`);

  // Step 6. The shop checks the answer: same question? accepted provider? the account on chain and its identity
  // still valid? does the maths hold against the sealed details on chain?
  console.log('6. The shop checks the answer against the chain');
  console.log(`   ${await shopReceives(answer, question)}\n`);

  // Step 7. Someone sends the very same answer again (a copy, or a replay): refused, it was already used.
  console.log('7. The same answer arrives again');
  console.log(`   ${await shopReceives(answer, question)}`);

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
