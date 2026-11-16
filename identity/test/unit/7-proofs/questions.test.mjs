// Proofs, piece 1: a website's question — building it (requestFor, the website's side), reading and checking it,
// and describing it in plain English for the consent screen (the wallet's side). No network: building a question
// records it on chain, so a tiny pretend chain takes the anchor here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { describeProofRequest, describeProofContext, ProofError } from '@concordium/wdk-identity-concordium';
import { requestFor } from '@concordium/wdk-identity-concordium/verify';
import { readProofRequest } from '../../../src/proofs/proof-request.js';

const NOW = new Date(Date.UTC(2026, 10, 3, 12)); // 3 Nov 2026, for the plain-English dates
const rejectsWith = (fn, reason, pattern) => assert.throws(fn, (e) => {
  assert.ok(e instanceof ProofError, `a ProofError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  if (pattern) assert.match(e.message, pattern);
  return true;
});
const rejectsLaterWith = (promise, reason, pattern) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof ProofError, `a ProofError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

// ---- requestFor: the website's side --------------------------------------------------------------------------

/** A pretend chain that takes any anchor and says it is final (the anchor itself is tested in website-asks-and-checks). */
const ANCHORING = {
  node: {
    async getNextAccountNonce() { return { nonce: sdk.SequenceNumber.create(1) }; },
    async sendTransaction() { return sdk.TransactionHash.fromHexString(randomBytes(32).toString('hex')); },
    async waitForTransactionFinalization() { return { summary: { type: 'accountTransaction', transactionType: 'registerData' } }; },
  },
  sender: '4rEgzrWemrBjxUvkcEkDt9AfB2F7JdS8jkW3M9UWWK1TYaWSX1',
  signer: sdk.buildBasicAccountSigner('11'.repeat(32)),
};
/** requestFor with the network and website filled in, recorded on the pretend chain. */
const ask = (options) => requestFor({ network: 'testnet', website: 'shop.example', ...options }, ANCHORING);
/** The statements of a question's first part. */
const statementsOf = (question) => question.subjectClaims[0].statements;

test('requestFor: "adult" becomes Concordium\'s date-of-birth range, with a fresh nonce each time', async () => {
  const question = await ask({ providers: [0, 1], adult: true });
  const nonce = (q) => q.context.given.find((g) => g.label === 'Nonce').context;
  assert.match(nonce(question), /^[0-9a-f]{64}$/);
  assert.notEqual(nonce(await ask({ providers: [0, 1], adult: true })), nonce(question), 'a new nonce every time');
  assert.equal(question.subjectClaims.length, 1);
  assert.deepEqual(question.subjectClaims[0].issuers, ['did:ccd:testnet:idp:0', 'did:ccd:testnet:idp:1']);
  const [statement] = statementsOf(question);
  assert.equal(statementsOf(question).length, 1);
  assert.equal(statement.type, 'AttributeInRange');
  assert.equal(statement.attributeTag, 'dob');
  assert.equal(statement.lower, '18000101');
  assert.match(statement.upper, /^\d{8}$/);
});

test('requestFor: every option becomes one statement, in Concordium\'s format', async () => {
  const statement = statementsOf(await ask({
    providers: [0], minAge: 21, residentIn: ['GB', 'DE'], nationalityNotIn: ['KP'], documentValid: new Date(Date.UTC(2026, 10, 3)),
    reveal: ['firstName', 'lastName'],
  }));
  assert.deepEqual(statement.map((s) => [s.type, s.attributeTag]), [
    ['AttributeInRange', 'dob'],
    ['AttributeInSet', 'countryOfResidence'],
    ['AttributeNotInSet', 'nationality'],
    ['AttributeInRange', 'idDocExpiresAt'],
    ['RevealAttribute', 'firstName'],
    ['RevealAttribute', 'lastName'],
  ]);
  assert.deepEqual(statement[1].set, ['GB', 'DE']);
  assert.equal(statement[3].lower, '20261103', 'document still valid on the given day');
});

test('requestFor: bad options are refused with a plain explanation', async () => {
  await rejectsLaterWith(ask({ adult: true }), 'invalid-request', /providers is required/);
  await rejectsLaterWith(ask({ providers: [0] }), 'invalid-request', /asks for nothing/);
  await rejectsLaterWith(ask({ providers: [0], adult: true, minAge: 21 }), 'invalid-request', /adult or minAge, not both/);
  await rejectsLaterWith(ask({ providers: [0], nationalityNotIn: ['KP'], reveal: ['nationality'] }), 'invalid-request',
    /nationality is used twice \(by nationalityNotIn and reveal\)/);
  await rejectsLaterWith(ask({ providers: [0], residentIn: ['gb'] }), 'invalid-request', /two-letter country codes/);
  await rejectsLaterWith(ask({ providers: [0], reveal: ['favouriteColour'] }), 'unknown-attribute', /favouriteColour/);
});

// ---- readProofRequest: the wallet checks what it received ------------------------------------------------------

// A question as a wallet receives it: Concordium's VerificationRequestV1 as JSON, written out by hand (the format,
// not our code, decides what it looks like). Reading does not check the anchor on chain.
const ANCHOR = '2d84d189a6ec7cee7714ed4cbe4e9c428da250406a76eb8d143d3b11fa44e47f';
const AGE_CHECK = {
  type: 'ConcordiumVerificationRequestV1',
  context: {
    type: 'ConcordiumUnfilledContextInformationV1',
    given: [
      { label: 'Nonce', context: '07'.repeat(32) },
      { label: 'ConnectionID', context: 'connection-1' },
      { label: 'ResourceID', context: 'shop.example' },
      { label: 'ContextString', context: 'age check at the till' },
    ],
    requested: ['BlockHash'],
  },
  subjectClaims: [{
    type: 'identity',
    source: ['identityCredential'],
    statements: [{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20081104' }],
    issuers: ['did:ccd:testnet:idp:0', 'did:ccd:testnet:idp:3'],
  }],
  transactionRef: ANCHOR,
};
/** A copy of AGE_CHECK with `change` applied to it (to break one thing at a time). */
const questionWith = (change) => { const q = structuredClone(AGE_CHECK); change(q); return q; };
/** AGE_CHECK asking these statements instead. */
const asking = (statements) => questionWith((q) => { q.subjectClaims[0].statements = statements; });

test('readProofRequest: a question is read, with its network, providers, context and anchor', () => {
  const read = readProofRequest(AGE_CHECK);
  assert.equal(read.network, 'Testnet');
  assert.deepEqual(read.claims, [{ providers: [0, 3], source: ['identityCredential'], statements: AGE_CHECK.subjectClaims[0].statements }]);
  assert.deepEqual(read.given, { Nonce: '07'.repeat(32), ConnectionID: 'connection-1', ResourceID: 'shop.example', ContextString: 'age check at the till' });
  assert.deepEqual(read.requested, ['BlockHash']);
  assert.equal(read.anchor, ANCHOR);
  assert.deepEqual(read.request.toJSON(), AGE_CHECK, 'the SDK\'s own object, ready for answering, says the same');
});

test('readProofRequest: the same question as JSON text, as the SDK\'s object, or in WalletConnect\'s wrapper', () => {
  const sdkObject = sdk.VerificationRequestV1.fromJSON(AGE_CHECK);
  for (const form of [JSON.stringify(AGE_CHECK), sdkObject, { paramsJson: JSON.stringify(AGE_CHECK) }]) {
    assert.deepEqual(readProofRequest(form).claims[0].providers, [0, 3]);
  }
  rejectsWith(() => readProofRequest('{not json'), 'invalid-request', /not valid JSON/);
  rejectsWith(() => readProofRequest({ paramsJson: '{not json' }), 'invalid-request', /not valid JSON/);
});

test('readProofRequest: a question made with Concordium\'s own builder is read as it is', () => {
  const context = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(1), 'c-1', 'bar.example', 'entry');
  const claims = sdk.VerificationRequestV1.claimsBuilder()
    .addIdentityClaims([new sdk.IdentityProviderDID('Mainnet', 1)], (b) => b.addMinimumAge(18).revealAttribute('nationality'))
    .addAccountOrIdentityClaims([new sdk.IdentityProviderDID('Mainnet', 2)], (b) => b.addNonMembership('countryOfResidence', ['US']))
    .getClaims();
  const read = readProofRequest(sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR)));
  assert.equal(read.network, 'Mainnet');
  assert.deepEqual(read.claims.map((c) => [c.providers, c.source]), [[[1], ['identityCredential']], [[2], ['accountCredential', 'identityCredential']]]);
  assert.deepEqual(read.requested, ['BlockHash']);
});

test('readProofRequest: a question it cannot answer correctly is refused, saying what is wrong', () => {
  const broken = (change, reason, pattern) => rejectsWith(() => readProofRequest(questionWith(change)), reason, pattern);
  broken((q) => { q.type = 'SomethingElse'; }, 'invalid-request', /Not a Concordium question/);
  broken((q) => { q.context.type = 'Filled'; }, 'invalid-request', /context must be/);
  broken((q) => { q.context.given.push({ label: 'Mood', context: 'x' }); }, 'invalid-request', /known label/);
  broken((q) => { q.context.given.push({ label: 'Nonce', context: 'aa' }); }, 'invalid-request', /Nonce is given twice/);
  broken((q) => { q.context.requested.push('Nonce'); }, 'invalid-request', /both given and requested/);
  broken((q) => { delete q.transactionRef; }, 'invalid-request', /needs its anchor/);
  broken((q) => { q.subjectClaims = []; }, 'invalid-request', /asks for nothing/);
  broken((q) => { q.subjectClaims[0].type = 'web3id'; }, 'invalid-request', /only 'identity'/);
  broken((q) => { q.subjectClaims[0].source = ['passport']; }, 'invalid-request', /source must list/);
  broken((q) => { q.subjectClaims[0].issuers = ['did:ccd:testnet:sci:1:0']; }, 'invalid-request', /not an identity provider/);
  broken((q) => { q.subjectClaims[0].issuers.push('did:ccd:mainnet:idp:1'); }, 'invalid-request', /mixes networks/);
  broken((q) => { q.subjectClaims[0].statements[0].attributeTag = 'shoeSize'; }, 'unknown-attribute');
  broken((q) => { q.subjectClaims[0].statements = []; }, 'invalid-request', /statements must be a non-empty list/);
  const one = (statements, reason, pattern) => rejectsWith(() => readProofRequest(asking(statements)), reason, pattern);
  one([{ type: 'Guess', attributeTag: 'dob' }], 'invalid-request', /unknown type/);
  one([{ type: 'RevealAttribute', attributeTag: 'dob' }, { type: 'AttributeInRange', attributeTag: 'dob', lower: '1', upper: '2' }],
    'invalid-request', /asked about twice/);
  one([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '2', upper: '1' }], 'invalid-request', /lower first/);
  one([{ type: 'AttributeInSet', attributeTag: 'nationality', set: [] }], 'invalid-request', /non-empty set/);
});

test('readProofRequest: an older version 0 request (a challenge and credentialStatements) is refused, saying so', () => {
  const versionZero = { challenge: 'bb'.repeat(32), credentialStatements: [{ idQualifier: { type: 'cred', issuers: [0] },
    statement: [{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20081104' }] }] };
  rejectsWith(() => readProofRequest(versionZero), 'invalid-request', /version 0 request.*only version 1 questions/);
  rejectsWith(() => describeProofRequest({ paramsJson: JSON.stringify(versionZero) }), 'invalid-request', /version 0 request/);
});

// ---- describeProofRequest and describeProofContext: the consent screen ------------------------------------------

test('describeProofRequest: a question in plain English, with its network and where the answer comes from', () => {
  assert.deepEqual(describeProofRequest(AGE_CHECK, { now: NOW }), [{
    providers: [0, 3],
    network: 'testnet',
    answerFrom: 'identity',
    asks: [{ kind: 'range', attribute: 'dob', text: 'prove you were born before 4 Nov 2008 (at least 18 years old), without showing your date of birth' }],
  }]);
  const either = questionWith((q) => { q.subjectClaims[0].source = ['accountCredential', 'identityCredential']; });
  assert.equal(describeProofRequest(either)[0].answerFrom, 'identity or account');
  const account = questionWith((q) => { q.subjectClaims[0].source = ['accountCredential']; });
  assert.equal(describeProofRequest(account)[0].answerFrom, 'account');
  rejectsWith(() => describeProofRequest(questionWith((q) => { q.subjectClaims = []; })), 'invalid-request');
});

test('describeProofRequest: shown details, ranges, sets and dates, in plain English', () => {
  const asks = describeProofRequest(asking([
    { type: 'RevealAttribute', attributeTag: 'nationalIdNo' },
    { type: 'RevealAttribute', attributeTag: 'nationality' },
    { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20060802' },
    { type: 'AttributeNotInSet', attributeTag: 'countryOfResidence', set: ['US', 'KP'] },
  ]), { now: NOW })[0].asks;
  assert.deepEqual(asks, [
    { kind: 'reveal', attribute: 'nationalIdNo', text: 'show your national ID number' },
    { kind: 'reveal', attribute: 'nationality', text: 'show your nationality' },
    { kind: 'range', attribute: 'dob', text: 'prove you were born before 2 Aug 2006 (at least 20 years old), without showing your date of birth' },
    { kind: 'not-in-set', attribute: 'countryOfResidence', text: 'prove your country of residence is none of: US, KP (without showing it)' },
  ]);
});

test('describeProofRequest: an age check made today says "at least 18"; set and document wording', async () => {
  // requestFor counts the 18 years back from today, so describe it as of today too (not the fixed NOW).
  const asks = describeProofRequest(await ask({ providers: [0], adult: true, residentIn: ['GB', 'DE'], documentValid: NOW }), { now: new Date() })[0].asks;
  assert.match(asks[0].text, /at least 18 years old/);
  assert.equal(asks[1].text, 'prove your country of residence is one of: GB, DE (without showing which)');
  assert.equal(asks[2].text, 'prove your ID document is still valid on 3 Nov 2026, without showing its dates');
});

test('describeProofRequest: "at least N years old" is right on the edges (the day before a birthday; 29 February)', () => {
  const minAge = (upper, now) => Number(describeProofRequest(asking([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper }]),
    { now: new Date(now) })[0].asks[0].text.match(/at least (\d+) years old/)[1]);
  // "born before 4 Nov 2008": the latest birth date allowed is 3 Nov 2008.
  assert.equal(minAge('20081104', '2026-11-03T12:00Z'), 18, 'on their 18th birthday');
  assert.equal(minAge('20081104', '2026-11-02T12:00Z'), 17, 'the day before, they are still 17');
  assert.equal(minAge('20060802', '2026-08-01T12:00Z'), 20);
  assert.equal(minAge('20060802', '2026-07-31T12:00Z'), 19);
  // Born 29 Feb 2000 (the latest allowed by "before 1 Mar 2000"): in 2026 (no 29 Feb) the birthday counts from 1 Mar.
  assert.equal(minAge('20000301', '2026-02-28T12:00Z'), 25);
  assert.equal(minAge('20000301', '2026-03-01T12:00Z'), 26);
});

test('describeProofContext: who is asking, as the website wrote it into the question', () => {
  assert.deepEqual(describeProofContext(AGE_CHECK), {
    network: 'testnet', website: 'shop.example', purpose: 'age check at the till', connection: 'connection-1', anchor: ANCHOR,
  });
  const bare = questionWith((q) => { q.context.given = [{ label: 'Nonce', context: 'aa' }]; });
  assert.deepEqual(describeProofContext(bare), { network: 'testnet', anchor: ANCHOR }, 'only what the website gave');
  rejectsWith(() => describeProofContext({ challenge: 'aa', credentialStatements: [] }), 'invalid-request', /version 0 request/);
});

// ---- Company identities (Business ID): questions about a company -------------------------------------------------

test('requestFor: a company question: show its LEI and legal name, prove it is registered in one of some countries', async () => {
  const question = await ask({ providers: [4], reveal: ['lei', 'legalName'], registeredIn: ['DK', 'SE', 'DE'] });
  assert.deepEqual(question.subjectClaims[0].issuers, ['did:ccd:testnet:idp:4'], 'Global FinReg (testnet), a Business ID provider');
  const statement = statementsOf(question);
  assert.deepEqual(statement.map((s) => [s.type, s.attributeTag]), [
    ['AttributeInSet', 'legalCountry'], ['RevealAttribute', 'lei'], ['RevealAttribute', 'legalName']]);
  assert.deepEqual(statement[0].set, ['DK', 'SE', 'DE']);
  const [notIn] = statementsOf(await ask({ providers: [4], notRegisteredIn: ['KP', 'IR'] }));
  assert.deepEqual([notIn.type, notIn.attributeTag, notIn.set], ['AttributeNotInSet', 'legalCountry', ['KP', 'IR']]);
});

test('requestFor: the company options are checked like the others', async () => {
  await rejectsLaterWith(ask({ providers: [4], registeredIn: ['dk'] }), 'invalid-request', /registeredIn must be a list of two-letter country codes/);
  await rejectsLaterWith(ask({ providers: [4], registeredIn: ['DK'], notRegisteredIn: ['KP'] }), 'invalid-request',
    /legalCountry is used twice \(by registeredIn and notRegisteredIn\)/);
  await rejectsLaterWith(ask({ providers: [4], registeredIn: ['DK'], reveal: ['legalCountry'] }), 'invalid-request', /legalCountry is used twice/);
});

test('describeProofRequest: a company question says "the company", not "your"', async () => {
  const asks = describeProofRequest(await ask({ providers: [4], reveal: ['lei', 'legalName', 'businessNumber'], registeredIn: ['DK', 'SE'] }))[0].asks;
  assert.deepEqual(asks.map((a) => a.text), [
    'prove the company is registered in one of: DK, SE (without showing which)',
    'show the company\'s legal entity identifier (LEI)',
    'show the company\'s legal name',
    'show the company\'s business number',
  ]);
  assert.equal(describeProofRequest(await ask({ providers: [4], notRegisteredIn: ['KP'] }))[0].asks[0].text,
    'prove the company is registered in none of: KP (without showing where)');
  assert.equal(describeProofRequest(await ask({ providers: [0], reveal: ['nationality'] }))[0].asks[0].text,
    'show your nationality', 'a person\'s details still say "your"');
});

test('describeProofRequest: a company question made with Concordium\'s own builder reads the same', () => {
  const claims = sdk.VerificationRequestV1.claimsBuilder()
    .addIdentityClaims([new sdk.IdentityProviderDID('Testnet', 4)], (b) => b.revealAttribute('lei').addMembership('legalCountry', ['DK']))
    .getClaims();
  const context = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(3), 'c', 'bank.example', 'onboarding');
  const question = sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR));
  assert.deepEqual(describeProofRequest(question)[0].asks.map((a) => a.text), [
    'show the company\'s legal entity identifier (LEI)', 'prove the company is registered in one of: DK (without showing which)']);
});
