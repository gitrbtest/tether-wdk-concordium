/**
 * Live (testnet): version 1 proofs against the real Concordium testnet chain. The wallet answers a real anchored
 * question from its identity, and the website checks the answer, with our checkPresentationV1 and, as a second
 * opinion, with Concordium's own verifyWithNode.
 *
 * Read-only by default: the question was recorded on testnet once (test/fixtures/v1-question.testnet.json, made by
 * capture-v1-question.mjs) and answers are never sent to the chain, so nothing is spent:
 *
 *   npm run test:integration
 *
 * With WRITE=1, one more test records a fresh sponsored question each run (one anchor fee, about EUR 0.013, paid by
 * account 11 of the public test phrase's identity 334563111; keep it funded), then answers and checks it:
 *
 *   WRITE=1 npm run test:integration            (PowerShell: $env:WRITE="1"; npm run test:integration)
 *
 * The scenario: a shop asks "over 18? show your nationality"; its partner pays the shop's fee; a person's wallet
 * answers from the identity. Who is who (all from the public "abandon" test phrase, identity 334563111, provider 0;
 * in real life each would have its own seed, here they share one so existing accounts can be used):
 *
 *   SHOP      account 13  4rEgz…WSX1  holds 0 CCD: it asks, and sends the anchor (the question recorded on chain)
 *   SPONSOR   account 11  4kJZH…9fTU  pays the anchor's fee (keep it funded)
 *   WALLET    the identity itself (test person John Doe: born 1970, lives in DK, nationality DK): answers with no
 *             account, so none is named
 *
 *   SPONSOR (11)            SHOP (13, 0 CCD)                  TESTNET CHAIN                 WALLET (identity)
 *   ────────────            ────────────────                  ─────────────                 ─────────────────
 *                           1. requestForV1: builds the
 *                              question, signs the anchor
 *   2. signs too: ◄──────── (the same transaction)
 *      "I pay the fee"
 *                           3. sends the anchor ────────────► recorded, final; the fee
 *                                                             comes from account 11
 *                           4. sends the question ──────────────────────────────────────► 5. reads it
 *                                                                                            (describeProofRequest)
 *                                                             is the anchor on chain, ◄── 6. proveIdentity asks;
 *                                                             final, this question? ────►    then builds the answer:
 *                                                                                            over 18, nationality DK,
 *                                                                                            no account named
 *                           8. checkPresentationV1 ◄─────────────────────────────────── 7. sends the answer
 *                              (+ Concordium's verifyWithNode): accepted
 *
 * Steps 1-3 for the recorded question were done once, by test/fixtures/capture-v1-question.mjs. Each test below
 * says which steps it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity } from '@concordium/wdk-identity-concordium';
import { requestForV1, checkPresentationV1, connectToNode } from '@concordium/wdk-identity-concordium/verify';
import { liveTestnetConfig } from '../helpers.mjs';

const WRITE = process.env.WRITE === '1';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const { question: RECORDED_QUESTION, anchor } = JSON.parse(readFileSync(new URL('../fixtures/v1-question.testnet.json', import.meta.url), 'utf8'));

/** A wallet holding the recorded identity, collected live from the provider, with a real testnet node. */
async function liveWallet() {
  const wallet = new ConcordiumIdentity(PHRASE, await liveTestnetConfig());
  await wallet.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  return wallet;
}

// Steps 4-8, on the recorded question (steps 1-3 were done once): the wallet answers on the real node, and both
// checks accept it; a changed answer is refused. Read-only.
test('V1 on testnet: the wallet answers the recorded question from its identity; both checks accept it', async () => {
  const node = connectToNode('testnet');
  const wallet = await liveWallet();
  try {
    const answer = JSON.parse(JSON.stringify(await wallet.proveIdentity({ ...RECORDED, request: RECORDED_QUESTION })));
    assert.equal(answer.presentationContext.requested[0].context, anchor.blockHash, 'tied to the block the question was recorded in');
    assert.doesNotMatch(JSON.stringify(answer), /:cred:/, 'no account is named');

    const result = await checkPresentationV1(answer, RECORDED_QUESTION, { node, network: 'testnet' });
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    assert.deepEqual(result.revealed, { nationality: 'DK' });
    assert.deepEqual(result.credentials, [{ from: 'identity', issuer: 0, revealed: { nationality: 'DK' } }]);

    // Concordium's own check of the proof against the chain, as a second opinion (not its createChecked: see
    // src/verify/check-presentation-v1.js).
    const second = await sdk.VerifiablePresentationV1.verifyWithNode(sdk.VerifiablePresentationV1.fromJSON(answer), node, 'Testnet');
    assert.equal(second.type, 'success', String(second.error?.message ?? ''));
    assert.deepEqual(second.result.credentialsStatus, [sdk.CIS4.CredentialStatus.Active]);

    // A changed answer is refused by the chain's data.
    const changed = structuredClone(answer);
    changed.verifiableCredential[0].credentialSubject.statement[1].attributeValue = 'SE';
    assert.deepEqual((await checkPresentationV1(changed, RECORDED_QUESTION, { node, network: 'testnet' })).reasons.map((r) => r.reason), ['proof-invalid']);
  } finally {
    wallet.dispose();
  }
});

// The result of step 3, as the chain holds it: the anchor is final, records exactly this question, the sponsor
// (account 11) paid the fee and the shop (account 13) paid nothing. Read-only.
test('V1 on testnet: the recorded anchor is on chain, sponsored, and records exactly this question', async () => {
  const node = connectToNode('testnet');
  const status = await node.getBlockItemStatus(sdk.TransactionHash.fromHexString(anchor.transactionHash));
  assert.equal(status.status, 'finalized');
  assert.equal(sdk.BlockHash.toHexString(status.outcome.blockHash), anchor.blockHash);
  assert.equal(status.outcome.summary.sponsor?.sponsor?.address, anchor.sponsor, 'the sponsor paid');
  const { cost } = status.outcome.summary; // the SDK gives the sender's cost here as a plain number (bigint)
  assert.equal(String(cost?.microCcdAmount ?? cost), '0', 'the website paid nothing');
  await sdk.VerificationRequestV1.verifyAnchor(sdk.VerificationRequestV1.fromJSON(RECORDED_QUESTION), node);
});

// The whole diagram, steps 1-8, with a fresh question each run (spends one anchor fee from account 11; WRITE=1 only),
// plus: the answer to this question is refused for the recorded one.
test('V1 on testnet, WRITE=1: a fresh sponsored question is recorded, answered and checked', { skip: !WRITE && 'set WRITE=1 to record a question on testnet' }, async () => {
  const hdWallet = sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
  const signerOf = (credNumber) => sdk.buildBasicAccountSigner(hdWallet.getAccountSigningKey(0, RECORDED.identityIndex, credNumber).toString('hex'));
  const node = connectToNode('testnet');
  const question = await requestForV1(
    { network: 'testnet', website: 'age-check.example', purpose: 'live test', providers: [0, 1, 2], minAge: 21, residentIn: ['DK', 'SE'] },
    { node, sender: anchor.sender, signer: signerOf(13), sponsor: { address: anchor.sponsor, signer: signerOf(11) } },
  );
  console.log(`  question recorded: https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${question.transactionRef}`);
  const wallet = await liveWallet();
  try {
    const answer = await wallet.proveIdentity({ ...RECORDED, request: question });
    const result = await checkPresentationV1(answer, question, { node, network: 'testnet' });
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    const copied = await checkPresentationV1(answer, RECORDED_QUESTION, { node, network: 'testnet' });
    assert.equal(copied.ok, false, 'an answer to one question does not answer another');
  } finally {
    wallet.dispose();
  }
});
