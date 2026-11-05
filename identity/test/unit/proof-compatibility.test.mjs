// Proofs, piece 5: compatibility with Concordium's own apps. Do our wallet's answers work at the shops Concordium
// built, and does our check accept answers to their questions? Their two questions are copied exactly from
// github.com/Concordium/concordium-dapp-examples at commit 2ea79d96cf4fb98201c7f5ccf38fcb5ef63bff25 (30 Oct 2026):
//
// - the beer store, simpleAgeVerification/src/components/BeerStore.tsx: "over 18" built with Concordium's
//   Web3StatementBuilder, providers 0–5, a fixed challenge 'BBBB…' (capital letters). It never checks the answer.
// - the reward shop, compliant-reward-distribution: the four statements of indexer-and-server/src/constants.rs
//   (ZK_STATEMENTS), providers 0–7 (frontend/src/apiReqeuests.ts), a challenge made from a recent block hash and a
//   fixed text (frontend/src/components/proof/Proof.tsx), sent over WalletConnect as { paramsJson }
//   (frontend/src/wallet-connection.tsx). Its server checks the answer with Concordium's rules (in Rust), then uses
//   the revealed national ID number and nationality so each person gets one reward.
//
// Each answer is checked with Concordium's own checker (verifyPresentation, the SDK's version of the rules their
// server uses) and with ours (checkPresentation). No network: recorded identity, pretend node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ProofError, describeProofRequest } from '@concordium/wdk-identity-concordium';
import { checkPresentation } from '@concordium/wdk-identity-concordium/verify';
import { RECORDED_IDENTITY, recordedAccount0, walletWithRecordedIdentity, pretendNode, globalFixture } from '../helpers.mjs';

/** The beer store's question, built exactly as BeerStore.tsx builds it. */
function beerStoreQuestion() {
  const statement = new sdk.Web3StatementBuilder().addForIdentityCredentials([0, 1, 2, 3, 4, 5], (b) =>
    b.addRange('dob', sdk.MIN_DATE, sdk.getPastDate(18, 1)));
  return { challenge: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', credentialStatements: statement.getStatements() };
}

/** The reward shop's four statements, exactly as constants.rs has them. */
const ZK_STATEMENTS = [
  { type: 'RevealAttribute', attributeTag: 'nationalIdNo' },
  { type: 'RevealAttribute', attributeTag: 'nationality' },
  { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20060802' },
  { type: 'AttributeNotInSet', attributeTag: 'countryOfResidence', set: ['US', 'KP'] },
];
const CONTEXT_STRING = 'CONCORDIUM_COMPLIANT_REWARD_DISTRIBUTION_DAPP';

/** The reward shop's question: its challenge is sha256(a recent block hash, then the context string), as in Proof.tsx. */
function rewardShopQuestion(blockHash = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796') {
  const challenge = createHash('sha256').update(Buffer.concat([Buffer.from(blockHash, 'hex'), Buffer.from(CONTEXT_STRING)])).digest('hex');
  return { challenge, credentialStatements: [{ idQualifier: { type: 'cred', issuers: [0, 1, 2, 3, 4, 5, 6, 7] }, statement: ZK_STATEMENTS }] };
}

/** Concordium's own checker, against account 0's sealed details: throws if the answer does not hold. */
const concordiumChecks = (answer) => sdk.verifyPresentation(sdk.VerifiablePresentation.fromString(answer.toString()),
  globalFixture('testnet').value, [{ type: 'account', commitments: recordedAccount0().commitments }]);

test('the beer store: our wallet reads its question, answers it, and both checkers accept (its challenge in capitals)', async () => {
  const wallet = await walletWithRecordedIdentity();
  const question = beerStoreQuestion();
  const [part] = describeProofRequest(question);
  assert.match(part.asks[0].text, /at least 18 years old/);
  assert.deepEqual(part.providers, [0, 1, 2, 3, 4, 5]);

  const answer = await wallet.prove({ ...RECORDED_IDENTITY, credNumber: 0, ...question });
  assert.equal(concordiumChecks(answer).challenge, question.challenge.toLowerCase(), 'Concordium writes the challenge back in small letters');
  const ours = await checkPresentation(answer, question, { node: await pretendNode(), network: 'testnet' });
  assert.equal(ours.ok, true, JSON.stringify(ours.reasons));
  wallet.dispose();
});

test('the reward shop: our wallet answers its four statements over WalletConnect; both checkers accept; it gets what it needs', async () => {
  const wallet = await walletWithRecordedIdentity();
  const question = rewardShopQuestion();
  assert.deepEqual(describeProofRequest(question)[0].asks.map((a) => a.kind), ['reveal', 'reveal', 'range', 'not-in-set']);

  // As WalletConnect delivers it: the question as JSON text in paramsJson.
  const answer = await wallet.prove({ ...RECORDED_IDENTITY, credNumber: 0, paramsJson: JSON.stringify(question) });
  assert.equal(concordiumChecks(answer).challenge, question.challenge);
  const ours = await checkPresentation(answer, question, { node: await pretendNode(), network: 'testnet' });
  assert.equal(ours.ok, true, JSON.stringify(ours.reasons));
  assert.deepEqual(ours.revealed, { nationalIdNo: 'N-1234', nationality: 'DK' });

  // What its server reads: the national ID number and nationality as the first two proofs, in that order, which it
  // joins and hashes so each person gets one reward.
  const proofs = answer.verifiableCredential[0].credentialSubject.proof.proofValue;
  assert.deepEqual([proofs[0].attribute, proofs[1].attribute], ['N-1234', 'DK']);
  assert.equal(createHash('sha256').update(`${proofs[0].attribute}${proofs[1].attribute}`).digest('hex').length, 64);
  // Its "none of US, KP" comes back as ['KP', 'US'] (sorted): the same list, so ours must still accept (it does above).
  assert.deepEqual(answer.verifiableCredential[0].credentialSubject.statement[3].set, ['KP', 'US']);
  wallet.dispose();
});

test('the reward shop: a resident of the US cannot answer, and the wallet says so before making anything', async () => {
  const wallet = await walletWithRecordedIdentity({ details: { countryOfResidence: 'US' } });
  await assert.rejects(wallet.prove({ ...RECORDED_IDENTITY, credNumber: 0, ...rewardShopQuestion() }), (e) => {
    assert.ok(e instanceof ProofError);
    assert.equal(e.reason, 'cannot-prove');
    assert.match(e.message, /country of residence/);
    return true;
  });
  assert.deepEqual(await wallet.accountsThatCanAnswer({ ...RECORDED_IDENTITY, ...rewardShopQuestion() }), []);
  wallet.dispose();
});

test('an answer for one shop does not pass at the other', async () => {
  const wallet = await walletWithRecordedIdentity();
  const beer = beerStoreQuestion();
  const reward = rewardShopQuestion();
  const forBeer = await wallet.prove({ ...RECORDED_IDENTITY, credNumber: 0, ...beer });
  const forReward = await wallet.prove({ ...RECORDED_IDENTITY, credNumber: 0, ...reward });
  const node = await pretendNode();
  const reasons = async (answer, question) => (await checkPresentation(answer, question, { node, network: 'testnet' })).reasons.map((r) => r.reason);
  assert.deepEqual(await reasons(forBeer, reward), ['challenge-mismatch', 'statements-mismatch']);
  assert.deepEqual(await reasons(forReward, beer), ['challenge-mismatch', 'statements-mismatch']);
  // The reward shop's challenge ties the answer to a block: the same answer with a later block's challenge fails.
  const later = rewardShopQuestion('ab'.repeat(32));
  assert.deepEqual(await reasons(forReward, later), ['challenge-mismatch']);
  wallet.dispose();
});

test('the same questions in another order of letters or list: the check compares meaning, not spelling', async () => {
  const wallet = await walletWithRecordedIdentity();
  const question = { challenge: 'AB'.repeat(32), credentialStatements: [{ idQualifier: { type: 'cred', issuers: [0] },
    statement: [{ type: 'AttributeInSet', attributeTag: 'nationality', set: ['SE', 'DK', 'NO'] }] }] };
  const answer = await wallet.prove({ ...RECORDED_IDENTITY, credNumber: 0, ...question });
  const node = await pretendNode();
  assert.equal((await checkPresentation(answer, question, { node, network: 'testnet' })).ok, true);
  // A different list is still a different question.
  const other = structuredClone(question);
  other.credentialStatements[0].statement[0].set = ['SE', 'DK'];
  assert.deepEqual((await checkPresentation(answer, other, { node, network: 'testnet' })).reasons.map((r) => r.reason), ['statements-mismatch']);
  wallet.dispose();
});
