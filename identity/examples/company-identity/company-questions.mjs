/**
 * A bank asks a company to prove facts about itself: "show your LEI and legal name, and prove you are registered in
 * the EU". The consent screen a company's wallet would show, and what happens if the question reaches a person's
 * identity instead. On testnet; read-only: the question is not recorded on chain (recording costs a small fee), as
 * everything shown here happens before a wallet looks at a question's anchor.
 *
 *   npm run example:company-questions
 *
 * Only an identity from a Business ID provider holds a company's details (LEI, legal name, country of registration,
 * business number, registration authority). A company answering needs a real Business ID (Global FinReg has no test
 * mode), so the answer itself is not shown here; it is made exactly as a person's answer is (see ../terminal/age-check.mjs).
 *
 * Settings (optional): SEED_PHRASE, the person wallet's seed phrase (default: a public demonstration phrase; its
 * identity 1, with provider 0, is a person's).
 */
import { ConcordiumIdentity, IdentityProviders, ProofError, describeProofRequest, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { randomBytes } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

/**
 * The bank's question, built as requestFor builds it (answers from the company's identity or one of its accounts),
 * but not recorded on chain.
 */
function unrecordedQuestion(providers, build) {
  const context = sdk.VerificationRequestV1.createSimpleContext(randomBytes(32), 'sample', 'bank.example', 'company onboarding');
  const claims = sdk.VerificationRequestV1.claimsBuilder()
    .addAccountOrIdentityClaims(providers.map((i) => new sdk.IdentityProviderDID('Testnet', i)), build).getClaims();
  return sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString('00'.repeat(32))).toJSON();
}

const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();

// 1. The bank's question: whose identities it accepts (the Business ID providers), and what it asks.
const companyProviders = (await new IdentityProviders(identityProviders).list()).filter((p) => p.kind === 'company').map((p) => p.index);
console.log('1. The bank asks, of identities from provider(s)', companyProviders.join(', '), '(Business ID):');
const question = unrecordedQuestion(companyProviders, (b) => b.addMembership('legalCountry', EU).revealAttribute('lei').revealAttribute('legalName'));

// 2. What a company's wallet shows before it answers.
console.log('\n2. The consent screen a company\'s wallet shows:');
for (const ask of describeProofRequest(question)[0].asks) console.log(`   "${ask.text.replace(EU.join(', '), 'the 27 EU countries')}"`);

// 3. The same question reaching a person's wallet: it is refused before anything is built, saying what is missing.
console.log('\n3. The same question, sent to a person\'s wallet:');
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const person = new ConcordiumIdentity(process.env.SEED_PHRASE || DEMO_PHRASE, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });
try {
  const which = { providerIndex: 0, identityIndex: 1 };
  await person.recoverIdentity(which);
  const accounts = await person.accountsThatCanAnswer({ ...which, request: question });
  console.log(`   accounts that can answer: ${accounts.length}`);
  try {
    // A person's identity, and a question that only accepts Business ID providers: the provider is refused first.
    await person.prove({ ...which, request: question });
  } catch (e) {
    if (!(e instanceof ProofError)) throw e;
    console.log(`   ✖ refused (${e.reason}): ${e.message}`);
  }
  // Even a question accepting this person's provider is refused: the identity has no company details.
  try {
    await person.prove({ ...which, request: unrecordedQuestion([0], (b) => b.revealAttribute('lei')) });
  } catch (e) {
    if (!(e instanceof ProofError)) throw e;
    console.log(`   ✖ refused (${e.reason}): ${e.message}`);
  }
} finally {
  person.dispose();
}
