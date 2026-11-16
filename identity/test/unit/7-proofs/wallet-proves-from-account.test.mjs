// Proofs, piece 2: the wallet answers an anchored question from one of the identity's accounts (credNumber). No
// network: the identity is the one recorded from testnet, the node is a pretend one that knows the question's anchor
// and which accounts exist, and each answer is checked here with Concordium's own verifier against the recorded
// sealed details ("commitments") of that identity's account 0 on chain.
//
// Who is who:
//   WALLET        holds the recorded identity: a person (provider 0, identity 334563111; the test provider's made-up
//                 John Doe: born 1970, lives in DK, nationality DK). It answers with its account 0 (3Z4Wk…B5t)
//   SHOP          played by the test: it builds the questions with Concordium's SDK (answers from an account)
//   PRETEND NODE  holds the question's anchor; account 0 exists on it
//   CHECKER       Concordium's own verifier, checking each answer against account 0's sealed details
//
//   SHOP (the test)              WALLET: prove (credNumber: 0)                        CHECKER
//   ───────────────              ─────────────────────────────                        ───────
//   the question ──────────────► 1. reads it (any form it arrives in)
//                                2. identity held? not expired? answers from an account accepted? provider accepted?
//                                3. can it TRULY answer? (born 1970: over 18 yes, over 100 no)
//                                   any "no" in 2-3: refused, nothing is built
//                                4. which account answers: account 0 (its id, worked out from the seed)
//                                5. the anchor: on chain, final, this question?
//                                6. builds the answer (the date of birth itself is not in it) ──► 7. does it hold
//                                                                                                    against account 0's
//                                                                                                    sealed details?
//
// The company (Business ID) work adds one test here: a company question reaching this person's identity is refused at
// step 3. A company answering cannot be tested: completing a Business ID needs a real company.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, ProofError } from '@concordium/wdk-identity-concordium';
import { walletProxyFetch, globalFixture, testnetConfig, recordedNode, SIGNATURE_NOT_CHECKED } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));
const ACCOUNT_0 = fixture('account-commitments.testnet.json'); // { address, credId, issuer, commitments }
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
// The recorded identity's details (the test provider's made-up ones): born 1970-01-01, lives in DK, nationality DK.

const ANCHOR_BLOCK = 'b7'.repeat(32);
const ANCHOR_HASH = 'cd'.repeat(32);

/**
 * A website's question, answered from an account, as Concordium's SDK builds it: `build` adds the statements;
 * `providers` the accepted providers; `kind` which builder method (account only, by default, or either).
 */
function question({ build = (b) => b.addMinimumAge(18), providers = [0, 1, 2], kind = 'addAccountClaims', nonce = 9 } = {}) {
  const context = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(nonce), 'connection-1', 'shop.example', 'age check');
  const claims = sdk.VerificationRequestV1.claimsBuilder()[kind](providers.map((i) => new sdk.IdentityProviderDID('Testnet', i)), build).getClaims();
  return sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR_HASH));
}

/** The node's answer about an anchor transaction that is final and records `recorded` (a question). */
function anchoredOnChain(recorded) {
  const data = Buffer.from(sdk.VerificationRequestV1.createAnchor(recorded.context, recorded.subjectClaims)).toString('hex');
  return {
    status: 'finalized',
    outcome: { blockHash: sdk.BlockHash.fromHexString(ANCHOR_BLOCK), summary: { type: 'accountTransaction', transactionType: 'registerData', dataRegistered: { data } } },
  };
}

/** A wallet holding the recorded identity; its pretend node knows `anchor` and the accounts on chain. */
async function walletWithIdentity({ anchor, accountsOnChain = [ACCOUNT_0.address], validTo } = {}) {
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => {
    if (url === CODE_URI) {
      const issued = fixture('identity-done.testnet.json');
      if (validTo) issued.token.identityObject.value.attributeList.validTo = validTo; // e.g. an expired identity
      return { ok: true, status: 200, json: async () => issued };
    }
    return recorded.fetch(url, options);
  };
  const node = recordedNode('testnet', { statuses: anchor ? [anchor] : undefined, accountExists: (address) => accountsOnChain.includes(address) });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node }), { fetch, ...(validTo ? SIGNATURE_NOT_CHECKED : {}) });
  await wallet.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  return wallet;
}

/** The website's check, with Concordium's verifier, against account 0's sealed details as recorded from the chain. */
function websiteChecks(proof) {
  const sent = sdk.VerifiablePresentationV1.fromJSON(JSON.parse(JSON.stringify(proof))); // as the website receives it
  const publicData = [{ type: 'account', issuer: ACCOUNT_0.issuer, commitments: ACCOUNT_0.commitments }];
  return sdk.VerifiablePresentationV1.verify(sent, globalFixture('testnet').value, publicData).result;
}

const rejectsWith = (promise, reason, pattern) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof ProofError, `a ProofError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  if (pattern) assert.match(e.message, pattern);
  return true;
});
const fromAccount0 = (request) => ({ ...RECORDED, credNumber: 0, request });

// Steps 1-7: accepted, tied to this question, naming account 0.
test('prove from account 0: "over 18": Concordium\'s verifier accepts it, naming account 0, tied to the anchor\'s block', async () => {
  const asked = question();
  const wallet = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  const proof = await wallet.prove(fromAccount0(asked.toJSON()));
  const checked = websiteChecks(proof);
  assert.deepEqual(checked.context.requested.map((c) => [c.label, sdk.BlockHash.toHexString(c.context)]), [['BlockHash', ANCHOR_BLOCK]]);
  const [credential] = JSON.parse(JSON.stringify(proof)).verifiableCredential;
  assert.ok(credential.type.includes('ConcordiumAccountBasedCredential'), 'answered from an account');
  assert.match(credential.credentialSubject.id, new RegExp(`:cred:${ACCOUNT_0.credId}$`), 'it names account 0 (by its credential id)');
  assert.doesNotMatch(JSON.stringify(proof), /19700101/, 'the date of birth itself is not in the proof');
  wallet.dispose();
});

// Steps 6-7: the detail asked to be shown is in the proof; nothing else.
test('prove from account 0: a detail the question asks to show is revealed; the rest stays hidden', async () => {
  const asked = question({ build: (b) => b.addMembership('countryOfResidence', ['DK', 'SE']).revealAttribute('nationality'), providers: [0] });
  const wallet = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  const [claim] = websiteChecks(await wallet.prove(fromAccount0(asked))).subjectClaims;
  assert.deepEqual(claim.statement.map((s) => s.type), ['AttributeInSet', 'AttributeValue']);
  assert.equal(claim.statement[1].attributeValue, 'DK', 'nationality shown, as asked');
  wallet.dispose();
});

// Step 7: a copy of the answer, checked for another question.
test('prove from account 0: a copy of the answer does not pass for another question (another nonce)', async () => {
  const asked = question();
  const wallet = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  const answer = JSON.parse(JSON.stringify(await wallet.prove(fromAccount0(asked))));
  const otherNonce = question({ nonce: 5 }).toJSON().context.given.find((g) => g.label === 'Nonce').context;
  answer.presentationContext.given.find((g) => g.label === 'Nonce').context = otherNonce;
  assert.throws(() => sdk.VerifiablePresentationV1.verify(sdk.VerifiablePresentationV1.fromJSON(answer), globalFixture('testnet').value,
    [{ type: 'account', issuer: ACCOUNT_0.issuer, commitments: ACCOUNT_0.commitments }]), 'the maths no longer holds');
  wallet.dispose();
});

// Step 1: the question as WalletConnect delivers it.
test('prove from account 0: the question can come as WalletConnect delivers it ({ paramsJson })', async () => {
  const asked = question();
  const wallet = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  assert.equal(websiteChecks(await wallet.prove(fromAccount0({ paramsJson: JSON.stringify(asked) }))).subjectClaims.length, 1);
  wallet.dispose();
});

// Steps 2-3: each refusal, before anything is built.
test('prove from account 0: refuses BEFORE building anything when the answer would not be true or acceptable', async () => {
  const wallet = await walletWithIdentity();
  // Born 1970: not "at least 100".
  await rejectsWith(wallet.prove(fromAccount0(question({ build: (b) => b.addMinimumAge(100) }))), 'cannot-prove', /date of birth/);
  // Lives in DK: not one of GB, DE.
  await rejectsWith(wallet.prove(fromAccount0(question({ build: (b) => b.addMembership('countryOfResidence', ['GB', 'DE']) }))),
    'cannot-prove', /country of residence/);
  // Provider 0 is not among those accepted.
  await rejectsWith(wallet.prove(fromAccount0(question({ providers: [3, 5] }))), 'provider-not-accepted', /not from provider 0/);
  // The question accepts the identity itself only.
  await rejectsWith(wallet.prove(fromAccount0(question({ kind: 'addIdentityClaims' }))), 'identity-only', /without a credNumber/);
  wallet.dispose();
});

// Step 3: a company question (Business ID) asked of a person's identity.
test('prove from account 0: a person\'s identity asked a company question (an LEI) is refused, saying what it lacks', async () => {
  const wallet = await walletWithIdentity();
  await rejectsWith(wallet.prove(fromAccount0(question({ build: (b) => b.revealAttribute('lei') }))),
    'cannot-prove', /The identity has no legal entity identifier \(LEI\), which the website asks about/);
  await rejectsWith(wallet.prove(fromAccount0(question({ build: (b) => b.addMembership('legalCountry', ['DK']) }))),
    'cannot-prove', /country of registration/);
  wallet.dispose();
});

// Steps 1-2: a bad question, or an identity not held.
test('prove: no identity held for that number: not-held; a bad question: invalid-request; no default numbers', async () => {
  const wallet = await walletWithIdentity();
  await rejectsWith(wallet.prove({ providerIndex: 0, identityIndex: 7, credNumber: 0, request: question() }), 'not-held');
  await rejectsWith(wallet.prove(fromAccount0({ challenge: 'xyz', credentialStatements: [] })), 'invalid-request', /version 0/);
  await assert.rejects(wallet.prove({ request: question() }), /providerIndex is required/);
  // No default numbers: the wallet says which identity (and which account, if one answers), every time.
  await assert.rejects(wallet.prove({ providerIndex: 0, credNumber: 0, request: question() }), /identityIndex is required: .*nextIdentityIndex/);
  await assert.rejects(wallet.prove({ ...RECORDED, credNumber: -1, request: question() }), /credNumber/);
  await assert.rejects(wallet.accountsThatCanAnswer({ providerIndex: 0, request: question() }), /identityIndex is required/);
  wallet.dispose();
  await assert.rejects(wallet.prove(fromAccount0(question())), /disposed/);
});

// Steps 2-4: which accounts can answer (none if the identity cannot, or the question does not accept accounts).
test('accountsThatCanAnswer: the identity\'s accounts on chain if it can answer from one; none if it cannot', async () => {
  const wallet = await walletWithIdentity();
  const can = (request) => wallet.accountsThatCanAnswer({ ...RECORDED, request });
  assert.deepEqual(await can(question()), [{ credNumber: 0, address: ACCOUNT_0.address, path: `0/${RECORDED.identityIndex}/0` }]);
  assert.deepEqual(await can(question({ kind: 'addAccountOrIdentityClaims' })), [{ credNumber: 0, address: ACCOUNT_0.address, path: `0/${RECORDED.identityIndex}/0` }]);
  assert.deepEqual(await can(question({ build: (b) => b.addMinimumAge(100) })), [], 'cannot truly answer');
  assert.deepEqual(await can(question({ providers: [5] })), [], 'provider not accepted');
  assert.deepEqual(await can(question({ kind: 'addIdentityClaims' })), [], 'answers from the identity only');
  await rejectsWith(wallet.accountsThatCanAnswer({ providerIndex: 0, identityIndex: 7, request: question() }), 'not-held');
  wallet.dispose();
});

// Step 2: an expired identity.
test('prove from account 0: an expired identity is refused up front (Concordium reports its credential as Expired; websites refuse it)', async () => {
  const wallet = await walletWithIdentity({ validTo: '202601' }); // valid until the end of January 2026: expired
  await rejectsWith(wallet.prove(fromAccount0(question())), 'identity-expired', /2026-01.*verify again/);
  assert.deepEqual(await wallet.accountsThatCanAnswer({ ...RECORDED, request: question() }), []);
  wallet.dispose();
});
