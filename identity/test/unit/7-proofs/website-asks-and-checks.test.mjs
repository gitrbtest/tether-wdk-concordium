// Proofs, version 1, the website's side: requestFor records a question on chain (its anchor, paid by the website
// or by a sponsor) and checkPresentation checks the wallet's answer. No network: one pretend chain plays the
// node for both the website and the wallet, holding the anchors the website sends; the wallet holds the identity
// recorded from testnet, and the providers' keys are the recorded ones.
//
// The scenario, as in test/integration/7-proofs/round-trip.test.mjs but on one pretend chain (the node for both sides):
//   SHOP      account 13 (its keys only): asks, and sends the anchor
//   SPONSOR   account 11 (its keys only): pays the anchor's fee, when used
//   WALLET    the recorded identity: answers from the identity (or, in one test, an account answer built with the SDK)
//
//   SPONSOR (11)          SHOP (13)                         PRETEND CHAIN                WALLET
//   ────────────          ─────────                         ─────────────                ──────
//                         1. requestFor: checks the
//                            options, builds the question
//   2. signs too ◄─────── (with a sponsor only)
//                         3. sends the anchor ────────────► kept as an anchor, final
//                                                           (or: refused / rejected)
//                         4. sends the question ───────────────────────────────────────► 5. reads it
//                                                           anchor on chain? ◄────────── 6. answers
//                         8. checkPresentation ◄────────────────────────────────────── 7. the answer
//                            8a. for our question? (context, statements, providers, where from, network)
//                            8b. the anchor: on chain, final, this question; the answer tied to its block
//                            8c. the chain's public data; the identity still Active
//                            8d. the maths holds → accepted, with an audit record
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { ProofError, describeProofRequest, describeProofContext } from '@concordium/wdk-identity-concordium';
import { requestFor, checkPresentation, connectToNode } from '@concordium/wdk-identity-concordium/verify';
import { walletWithRecordedIdentity, RECORDED_IDENTITY, pretendChain, ANCHOR_BLOCK, globalFixture, recordedAccount0, notFoundError } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hdWallet = sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
// The website's account and its sponsor: accounts 13 and 11 of the recorded identity (only their keys are used here).
const signerOf = (credNumber) => sdk.buildBasicAccountSigner(hdWallet.getAccountSigningKey(0, RECORDED_IDENTITY.identityIndex, credNumber).toString('hex'));
const SHOP = { sender: '4rEgzrWemrBjxUvkcEkDt9AfB2F7JdS8jkW3M9UWWK1TYaWSX1', signer: signerOf(13) };
const SPONSOR = { address: '4kJZHvmLwMJjPp58ie7ZZirRkSZL1WLfcKbcrCdBAzweSj9fTU', signer: signerOf(11) };
const AGE_CHECK = { network: 'testnet', website: 'shop.example', purpose: 'age check', providers: [0, 1], adult: true };

/** The website asks (records the question on `chain`), the wallet answers from the identity: { question, answer, wallet }. */
async function askAndAnswer(chain, options = AGE_CHECK, anchoring = SHOP) {
  const question = await requestFor(options, { node: chain, ...anchoring });
  const wallet = await walletWithRecordedIdentity({ node: chain });
  const answer = JSON.parse(JSON.stringify(await wallet.prove({ ...RECORDED_IDENTITY, request: question })));
  wallet.dispose();
  return { question, answer };
}

const check = (chain, answer, question) => checkPresentation(answer, question, { node: chain, network: 'testnet', recordId: 'order-1' });
const reasonsOf = (result) => result.reasons.map((r) => r.reason);
const rejectsWith = (promise, reason, pattern) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof ProofError, `a ProofError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

// ---- requestFor ---------------------------------------------------------------------------------------------

// Steps 1 and 3, without a sponsor: the website pays.
test('requestFor: the question is recorded on chain by the website, and is what wallets read', async () => {
  const chain = pretendChain();
  const question = await requestFor({ ...AGE_CHECK, reveal: ['nationality'] }, { node: chain, ...SHOP });
  assert.equal(chain.sent.length, 1, 'one anchor sent');
  const [anchor] = chain.sent;
  assert.equal(anchor.header.sender.address, SHOP.sender);
  assert.equal(anchor.header.sponsor, undefined, 'no sponsor: the website pays');
  assert.equal(question.type, 'ConcordiumVerificationRequestV1');
  assert.ok(chain.anchors.has(question.transactionRef), 'the question names the anchor it was recorded in');
  assert.deepEqual(describeProofContext(question), {
    network: 'testnet', website: 'shop.example', purpose: 'age check', connection: question.context.given.find((g) => g.label === 'ConnectionID').context,
    anchor: question.transactionRef,
  });
  const [part] = describeProofRequest(question);
  assert.deepEqual([part.providers, part.answerFrom, part.asks.map((a) => a.kind)], [[0, 1], 'identity', ['range', 'reveal']]);
  assert.deepEqual(question.context.requested, ['BlockHash']);
});

// Steps 1-3, with the sponsor.
test('requestFor: with a sponsor, the sponsor pays the fee: both accounts sign, the website needs no CCD', async () => {
  const chain = pretendChain();
  await requestFor(AGE_CHECK, { node: chain, ...SHOP, sponsor: SPONSOR });
  const [anchor] = chain.sent;
  assert.equal(anchor.header.sponsor.address, SPONSOR.address);
  assert.ok(anchor.signatures.sender && anchor.signatures.sponsor, 'signed by the website and by the sponsor');
});

// Step 1: a fresh nonce each time; answerFrom; connection.
test('requestFor: every question is new (a fresh nonce), and answerFrom chooses where answers may come from', async () => {
  const chain = pretendChain();
  const a = await requestFor(AGE_CHECK, { node: chain, ...SHOP });
  const b = await requestFor({ ...AGE_CHECK, answerFrom: 'either', connection: 'till-3' }, { node: chain, ...SHOP });
  const nonce = (q) => q.context.given.find((g) => g.label === 'Nonce').context;
  assert.notEqual(nonce(a), nonce(b));
  assert.notEqual(a.transactionRef, b.transactionRef);
  assert.equal(describeProofRequest(b)[0].answerFrom, 'identity or account');
  assert.equal(describeProofContext(b).connection, 'till-3');
});

// Step 1: refused before step 3 (nothing sent).
test('requestFor: bad options are refused before anything is sent', async () => {
  const chain = pretendChain();
  const tries = [
    [{ ...AGE_CHECK, network: undefined }, 'invalid-request', /network is required/],
    [{ ...AGE_CHECK, website: '' }, 'invalid-request', /website is required/],
    [{ ...AGE_CHECK, answerFrom: 'phone' }, 'invalid-request', /answerFrom must be/],
    [{ ...AGE_CHECK, colour: 'red' }, 'invalid-request', /Unknown option: colour/],
    [{ ...AGE_CHECK, providers: [] }, 'invalid-request', /providers is required/],
    [{ ...AGE_CHECK, residentIn: ['gb'] }, 'invalid-request', /two-letter country codes/],
    [{ ...AGE_CHECK, reveal: ['shoeSize'] }, 'unknown-attribute'],
  ];
  for (const [options, reason, pattern] of tries) await rejectsWith(requestFor(options, { node: chain, ...SHOP }), reason, pattern);
  await assert.rejects(requestFor(AGE_CHECK, { node: chain, ...SHOP, sender: 'nobody' }), /sender must be an account address/);
  await assert.rejects(requestFor(AGE_CHECK, { node: chain, ...SHOP, signer: 'key' }), /signer must be an account signer/);
  await assert.rejects(requestFor(AGE_CHECK, { node: {}, ...SHOP }), /needs a node connection/);
  assert.equal(chain.sent.length, 0, 'nothing sent');
});

// Step 3: refused, rejected on chain, or the node unreachable.
test('requestFor: an anchor the node refuses or the chain rejects is anchor-failed; an unreachable node is node', async () => {
  const refused = Object.assign(new Error('insufficient funds for the transaction fee'), { name: 'RpcError', code: 'INVALID_ARGUMENT' });
  await rejectsWith(requestFor(AGE_CHECK, { node: pretendChain({ refuse: refused }), ...SHOP }), 'anchor-failed', /insufficient funds/);
  await rejectsWith(requestFor(AGE_CHECK, { node: pretendChain({ reject: 'InsufficientBalanceForSponsor' }), ...SHOP, sponsor: SPONSOR }),
    'anchor-failed', /rejected on chain \(InsufficientBalanceForSponsor\)/);
  const down = Object.assign(new Error('connection refused'), { name: 'RpcError', code: 'UNAVAILABLE' });
  await rejectsWith(requestFor(AGE_CHECK, { node: pretendChain({ refuse: down }), ...SHOP }), 'node', /connection refused/);
});

// Step 3: the node's wait drops out (e.g. an HTTP 502) while the anchor becomes final anyway.
test("requestFor: when the node's wait drops out, it asks for the anchor's status and still returns the question", async () => {
  const dropped = Object.assign(new Error('Received HTTP status code 502'), { name: 'RpcError', code: 'UNKNOWN' });
  const chain = pretendChain({ waitDrops: dropped });
  const question = await requestFor(AGE_CHECK, { node: chain, ...SHOP });
  assert.equal(chain.sent.length, 1, 'one anchor sent, not two');
  assert.equal(question.transactionRef, [...chain.anchors.keys()][0], 'the question names the anchor sent');

  // Never final within the time: node, saying the anchor may still become final.
  const pending = pretendChain({ waitDrops: dropped, anchorStatus: () => ({ status: 'committed', outcomes: {} }) });
  await rejectsWith(requestFor(AGE_CHECK, { node: pending, ...SHOP, timeoutMs: 50 }), 'node', /502.*may still become final/s);
  // Final but rejected on chain: anchor-failed, as with the node's own wait.
  await rejectsWith(requestFor(AGE_CHECK, { node: pretendChain({ waitDrops: dropped, reject: 'OutOfEnergy' }), ...SHOP }),
    'anchor-failed', /rejected on chain \(OutOfEnergy\)/);
});

// ---- checkPresentation ----------------------------------------------------------------------------------------

// Steps 1-8: the whole story, accepted.
test('checkPresentation: the wallet\'s answer from its identity is accepted, with what was shown and an audit record', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain, { ...AGE_CHECK, reveal: ['nationality'] });
  const result = await check(chain, answer, question);
  assert.deepEqual(reasonsOf(result), []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.revealed, { nationality: 'DK' });
  assert.deepEqual(result.credentials, [{ from: 'identity', issuer: 0, revealed: { nationality: 'DK' } }], 'no account: none was named');
  assert.equal(result.auditRecord.id, 'order-1');
  assert.deepEqual(result.auditRecord.request, question, 'the record keeps the question');
  assert.deepEqual(JSON.parse(JSON.stringify(result.auditRecord.presentation)), answer, 'and the answer');
  // The forms a website may receive the answer in.
  for (const form of [JSON.stringify(answer), { verifiablePresentationJson: JSON.stringify(answer) }]) {
    assert.equal((await check(chain, form, question)).ok, true);
  }
});

// Steps 1-8, with the sponsor.
test('checkPresentation: a sponsored question is answered and checked the same way', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain, AGE_CHECK, { ...SHOP, sponsor: SPONSOR });
  assert.equal((await check(chain, answer, question)).ok, true);
});

// Step 8a: the context (the case Concordium's createChecked misses).
test('checkPresentation: an answer to another question with the same statements is refused (context-mismatch)', async () => {
  // Concordium's createChecked (SDK 12.0.2) accepts this one: it does not wait for its own context comparison.
  const chain = pretendChain();
  const first = await askAndAnswer(chain);
  const second = await requestFor(AGE_CHECK, { node: chain, ...SHOP });
  const result = await check(chain, first.answer, second);
  assert.equal(result.ok, false);
  assert.ok(reasonsOf(result).includes('context-mismatch'));
});

// Steps 8a-8b: each part of "is it for our question?".
test('checkPresentation: an answer that proves something easier, or comes from elsewhere, is refused', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain);
  const changed = (change) => { const a = structuredClone(answer); change(a); return a; };
  const cases = [
    [changed((a) => { a.verifiableCredential[0].credentialSubject.statement[0].upper = '20210101'; }), 'statements-mismatch'],
    [changed((a) => { a.verifiableCredential[0].issuer = 'did:ccd:testnet:idp:4'; }), 'provider-not-accepted'],
    [changed((a) => { a.verifiableCredential[0].issuer = 'did:ccd:mainnet:idp:0'; }), 'wrong-network'],
    [changed((a) => { a.verifiableCredential.push(a.verifiableCredential[0]); }), 'statements-mismatch'],
    [changed((a) => { a.presentationContext.given.find((g) => g.label === 'ResourceID').context = 'other-shop.example'; }), 'context-mismatch'],
    [changed((a) => { a.presentationContext.requested[0].context = 'c3'.repeat(32); }), 'block-mismatch'],
    ['{not json', 'unreadable'],
  ];
  for (const [bad, reason] of cases) {
    const result = await check(chain, bad, question);
    assert.equal(result.ok, false, reason);
    assert.ok(reasonsOf(result).includes(reason), `${reason}: got ${reasonsOf(result)}`);
  }
});

// Step 8a: where the answer comes from.
test('checkPresentation: an answer from the identity where the question accepts accounts only is refused', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain, { ...AGE_CHECK, answerFrom: 'either' });
  const accountOnly = structuredClone(question);
  accountOnly.subjectClaims[0].source = ['accountCredential'];
  // (Its anchor no longer matches either; the answer's source is found first.)
  assert.deepEqual(reasonsOf(await check(chain, answer, accountOnly)), ['source-not-accepted']);
});

// Step 8b: the anchor.
test('checkPresentation: the anchor must be on chain, final and really this question', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain);
  const gone = pretendChain({ anchorStatus: () => { throw notFoundError(); } });
  assert.deepEqual(reasonsOf(await check(gone, answer, question)), ['anchor-not-found']);
  const committed = pretendChain({ anchorStatus: () => ({ status: 'committed', outcomes: [] }) });
  assert.deepEqual(reasonsOf(await check(committed, answer, question)), ['anchor-not-found']);
  const other = pretendChain({ anchorStatus: (hash, c) => ({ status: 'finalized', outcome: { blockHash: sdk.BlockHash.fromHexString(ANCHOR_BLOCK),
    summary: { type: 'accountTransaction', transactionType: 'registerData', dataRegistered: { data: chain.anchors.values().next().value.replace(/..$/, '00') } } } }) });
  assert.deepEqual(reasonsOf(await check(other, answer, question)), ['anchor-mismatch']);
});

// Step 8c: still Active.
test('checkPresentation: an identity that is no longer valid when checked is refused (not-active)', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain);
  const later = pretendChain({ anchorStatus: (hash) => ({ status: 'finalized', outcome: chain.outcome(hash) }), now: new Date('2027-10-01T00:00:00Z') });
  later.anchors = chain.anchors;
  assert.deepEqual(reasonsOf(await check(later, answer, question)), ['not-active']);
});

// Step 8b (the node down), and the question checked first.
test('checkPresentation: a node that cannot be asked throws ProofError node; a broken question is refused', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain);
  const down = pretendChain({ anchorStatus: () => { throw Object.assign(new Error('connection refused'), { name: 'RpcError', code: 'UNAVAILABLE' }); } });
  await rejectsWith(check(down, answer, question), 'node', /connection refused/);
  await rejectsWith(check(chain, answer, { ...question, subjectClaims: [] }), 'invalid-request');
  await assert.rejects(checkPresentation(answer, question, { node: chain, network: 'devnet' }), /needs the network/);
});

/**
 * An answer from an account, as another wallet may send for a question that accepts accounts (ours answers from the
 * identity): built with Concordium's SDK from the recorded identity's account 0 and the anchor's block.
 */
async function accountAnswer(chain, question) {
  const issued = JSON.parse(readFileSync(new URL('../../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
  const { attributeList } = issued.token.identityObject.value;
  const request = sdk.VerificationRequestV1.fromJSON(question);
  const [claim] = request.subjectClaims;
  const credId = hdWallet.getCredentialId(0, RECORDED_IDENTITY.identityIndex, 0, globalFixture('testnet').value).toString('hex');
  const subject = sdk.VerifiablePresentationV1.createAccountClaims('Testnet', sdk.CredentialRegistrationId.fromHexString(credId), 0,
    sdk.VerifiablePresentationV1.revealRequestedStatements(claim.statements, attributeList.chosenAttributes));
  const input = sdk.createAccountCommitmentInputWithHdWallet(claim.statements, 0, attributeList, hdWallet, RECORDED_IDENTITY.identityIndex, 0);
  const context = sdk.VerifiablePresentationV1.createContext(request.context, [{ label: 'BlockHash', context: sdk.BlockHash.fromHexString(ANCHOR_BLOCK) }]);
  return JSON.parse(JSON.stringify(sdk.VerifiablePresentationV1.create({ context, subjectClaims: [subject] }, [input], globalFixture('testnet').value)));
}

// Steps 6-8 with an account answer: 8a where from, 8c its provider read from the chain.
test('checkPresentation: an answer from an account is accepted where the question allows it, naming the account', async () => {
  const chain = pretendChain();
  const either = await requestFor({ ...AGE_CHECK, answerFrom: 'either', reveal: ['countryOfResidence'] }, { node: chain, ...SHOP });
  const answer = await accountAnswer(chain, either);
  const result = await check(chain, answer, either);
  assert.deepEqual(reasonsOf(result), []);
  assert.deepEqual(result.credentials, [{ from: 'account', issuer: 0, account: recordedAccount0().address, revealed: { countryOfResidence: 'DK' } }]);

  const identityOnly = await requestFor({ ...AGE_CHECK, reveal: ['countryOfResidence'] }, { node: chain, ...SHOP });
  assert.deepEqual(reasonsOf(await check(chain, await accountAnswer(chain, identityOnly), identityOnly)), ['source-not-accepted']);

  // The account's provider is read from the chain: an answer claiming another accepted provider is refused.
  const claimsProvider1 = structuredClone(answer);
  claimsProvider1.verifiableCredential[0].issuer = 'did:ccd:testnet:idp:1';
  assert.equal((await check(chain, claimsProvider1, either)).ok, false);
});

// Step 1, for a company: the website asks a company question (Business ID providers only).
test('requestFor: a company question: registered in some countries, showing its LEI; the consent wording says "the company"', async () => {
  const chain = pretendChain();
  const question = await requestFor({ network: 'testnet', website: 'bank.example', purpose: 'company onboarding',
    providers: [4], registeredIn: ['DK', 'SE'], reveal: ['lei'] }, { node: chain, ...SHOP });
  const [part] = describeProofRequest(question);
  assert.deepEqual(part.providers, [4], 'Global FinReg (testnet)');
  assert.deepEqual(part.asks.map((a) => a.text), [
    'prove the company is registered in one of: DK, SE (without showing which)', 'show the company\'s legal entity identifier (LEI)']);
});

// ---- answers from an account (version 1) ---------------------------------------------------------------------
//
//   WEBSITE (exchange)                            WALLET (the recorded identity, account 0)
//   1. asks, from an ACCOUNT: over 18, show the name ──► 2. answers from account 0 (credNumber: 0)
//   3. checks: genuine, from which account, revealed ◄──┘
//   (an account question answered without an account, or an identity-only question answered from one: refused)

const FROM_ACCOUNT = { ...AGE_CHECK, providers: [0], reveal: ['firstName', 'lastName'], answerFrom: 'account' };

// Steps 1-3: "this account is mine, and here is who I am", in version 1.
test('an account question, answered from account 0: the website learns which account answered, and the name', async () => {
  const chain = pretendChain();
  const question = await requestFor(FROM_ACCOUNT, { node: chain, ...SHOP });
  assert.equal(describeProofRequest(question)[0].answerFrom, 'account');
  const wallet = await walletWithRecordedIdentity({ node: chain });
  const answer = JSON.parse(JSON.stringify(await wallet.prove({ ...RECORDED_IDENTITY, request: question, credNumber: 0 })));
  wallet.dispose();
  const result = await check(chain, answer, question);
  assert.ok(result.ok, JSON.stringify(result.reasons));
  const [from] = result.credentials;
  assert.deepEqual([from.from, from.account, from.issuer], ['account', recordedAccount0().address, 0]);
  assert.deepEqual(result.revealed, { firstName: 'John', lastName: 'Doe' });
});

// Step 2: the wallet answers from where the question allows, and says so plainly otherwise.
test('an account question answered from the identity, or an identity question answered from an account: refused', async () => {
  const chain = pretendChain();
  const wallet = await walletWithRecordedIdentity({ node: chain });
  const accountQuestion = await requestFor(FROM_ACCOUNT, { node: chain, ...SHOP });
  await rejectsWith(wallet.prove({ ...RECORDED_IDENTITY, request: accountQuestion }), 'account-only', /pass its credNumber/);
  const identityQuestion = await requestFor(AGE_CHECK, { node: chain, ...SHOP });
  await rejectsWith(wallet.prove({ ...RECORDED_IDENTITY, request: identityQuestion, credNumber: 0 }), 'identity-only', /without a credNumber/);
  await assert.rejects(wallet.prove({ ...RECORDED_IDENTITY, request: accountQuestion, credNumber: -1 }), /credNumber/);
  wallet.dispose();
});

// Steps 1-3 with "either": the wallet chooses; from an account, the website sees which.
test('a question accepting identity or account, answered from account 0', async () => {
  const chain = pretendChain();
  const question = await requestFor({ ...FROM_ACCOUNT, answerFrom: 'either' }, { node: chain, ...SHOP });
  const wallet = await walletWithRecordedIdentity({ node: chain });
  const answer = JSON.parse(JSON.stringify(await wallet.prove({ ...RECORDED_IDENTITY, request: question, credNumber: 0 })));
  wallet.dispose();
  const result = await check(chain, answer, question);
  assert.ok(result.ok, JSON.stringify(result.reasons));
  assert.equal(result.credentials[0].account, recordedAccount0().address);
});

// Step 8a: a "one of" list the proof writes back in another order is the same question.
test('checkPresentation: the same questions in another order of letters or list: the check compares meaning, not spelling', async () => {
  const chain = pretendChain();
  const { question, answer } = await askAndAnswer(chain, { ...AGE_CHECK, adult: undefined, providers: [0], nationalityIn: ['SE', 'DK', 'NO'] });
  assert.equal((await check(chain, answer, question)).ok, true);
  // A different list is still a different question.
  const other = structuredClone(question);
  other.subjectClaims[0].statements[0].set = ['SE', 'DK'];
  assert.ok(reasonsOf(await check(chain, answer, other)).includes('statements-mismatch'));
});

// The website's node connection, used in steps 3 and 8.
test('connectToNode: Concordium\'s public node by network name, or your own node\'s address', () => {
  for (const where of ['testnet', 'mainnet', 'https://my-node.example.com:20000', 'http://localhost:20000']) {
    assert.equal(typeof connectToNode(where).getAccountInfo, 'function', where);
  }
  for (const bad of ['', 'devnet', 'ftp://node:1', undefined]) assert.throws(() => connectToNode(bad), /testnet/);
});
