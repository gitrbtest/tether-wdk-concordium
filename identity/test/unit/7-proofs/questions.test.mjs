// Proofs, piece 1: a website's proof request — building it (requestFor, the website's side), reading and checking
// it, and describing it in plain English for the consent screen (the wallet's side), for both versions. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@concordium/web-sdk';
import { describeProofRequest, describeProofContext, ProofError } from '@concordium/wdk-identity-concordium';
import { requestFor } from '@concordium/wdk-identity-concordium/verify';
import { readProofRequest, readProofRequestV1, isProofRequestV1 } from '../../../src/proofs/proof-request.js';

const NOW = new Date(Date.UTC(2026, 10, 3, 12)); // 3 Nov 2026, for the plain-English dates
const rejectsWith = (fn, reason, pattern) => assert.throws(fn, (e) => {
  assert.ok(e instanceof ProofError, `a ProofError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

// Concordium's own requests, exactly as its example apps send them (concordium-dapp-examples):
// compliant-reward-distribution (its server really verifies the answer), and simpleAgeVerification's age check.
const REWARD_DISTRIBUTION = {
  challenge: 'ab'.repeat(32),
  credentialStatements: [{
    idQualifier: { type: 'cred', issuers: [0, 1, 2, 3, 4, 5] },
    statement: [
      { type: 'RevealAttribute', attributeTag: 'nationalIdNo' },
      { type: 'RevealAttribute', attributeTag: 'nationality' },
      { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20060802' },
      { type: 'AttributeNotInSet', attributeTag: 'countryOfResidence', set: ['US', 'KP'] },
    ],
  }],
};
const BEER_STORE = {
  challenge: 'BB'.repeat(32),
  credentialStatements: [{
    idQualifier: { type: 'cred', issuers: [0, 1, 2, 3, 4, 5] },
    statement: [{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20081104' }],
  }],
};

// ---- requestFor: the website's side --------------------------------------------------------------------------

test('requestFor: "adult" becomes Concordium\'s date-of-birth range, with a fresh 32-byte challenge each time', () => {
  const request = requestFor({ providers: [0, 1], adult: true });
  assert.match(request.challenge, /^[0-9a-f]{64}$/);
  assert.notEqual(requestFor({ providers: [0, 1], adult: true }).challenge, request.challenge, 'a new challenge every time');
  assert.equal(request.credentialStatements.length, 1);
  const [{ idQualifier, statement }] = request.credentialStatements;
  assert.deepEqual(idQualifier, { type: 'cred', issuers: [0, 1] });
  assert.equal(statement.length, 1);
  assert.equal(statement[0].type, 'AttributeInRange');
  assert.equal(statement[0].attributeTag, 'dob');
  assert.equal(statement[0].lower, '18000101');
  assert.match(statement[0].upper, /^\d{8}$/);
});

test('requestFor: every option becomes one statement, in Concordium\'s format', () => {
  const { credentialStatements: [{ statement }] } = requestFor({
    providers: [0], minAge: 21, residentIn: ['GB', 'DE'], nationalityNotIn: ['KP'], documentValid: new Date(Date.UTC(2026, 10, 3)),
    reveal: ['firstName', 'lastName'],
  });
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

test('requestFor: bad options are refused with a plain explanation', () => {
  rejectsWith(() => requestFor({ adult: true }), 'invalid-request', /providers is required/);
  rejectsWith(() => requestFor({ providers: [0] }), 'invalid-request', /asks for nothing/);
  rejectsWith(() => requestFor({ providers: [0], adult: true, minAge: 21 }), 'invalid-request', /adult or minAge, not both/);
  rejectsWith(() => requestFor({ providers: [0], nationalityNotIn: ['KP'], reveal: ['nationality'] }), 'invalid-request',
    /nationality is used twice \(by nationalityNotIn and reveal\)/);
  rejectsWith(() => requestFor({ providers: [0], residentIn: ['gb'] }), 'invalid-request', /two-letter country codes/);
  rejectsWith(() => requestFor({ providers: [0], reveal: ['favouriteColour'] }), 'unknown-attribute', /favouriteColour/);
});

// ---- readProofRequest: the wallet checks what it received ------------------------------------------------------

test('readProofRequest: Concordium\'s own requests are read as they are', () => {
  assert.deepEqual(readProofRequest(REWARD_DISTRIBUTION), REWARD_DISTRIBUTION);
  assert.deepEqual(readProofRequest(BEER_STORE), BEER_STORE);
});

test('readProofRequest: WalletConnect\'s { paramsJson } wrapper is accepted too', () => {
  assert.deepEqual(readProofRequest({ paramsJson: JSON.stringify(REWARD_DISTRIBUTION) }), REWARD_DISTRIBUTION);
  rejectsWith(() => readProofRequest({ paramsJson: '{not json' }), 'invalid-request', /not valid JSON/);
});

test('readProofRequest: a request it cannot answer correctly is refused, saying what is wrong', () => {
  const one = (statement, qualifier = { type: 'cred', issuers: [0] }) => ({ challenge: 'aa', credentialStatements: [{ idQualifier: qualifier, statement }] });
  rejectsWith(() => readProofRequest({ challenge: 'not hex', credentialStatements: BEER_STORE.credentialStatements }), 'invalid-request', /challenge/);
  rejectsWith(() => readProofRequest({ challenge: 'aa', credentialStatements: [] }), 'invalid-request', /asks for nothing/);
  rejectsWith(() => readProofRequest(one([{ type: 'RevealAttribute', attributeTag: 'degree' }], { type: 'sci', issuers: [] })), 'invalid-request', /smart contract/);
  rejectsWith(() => readProofRequest(one([{ type: 'Guess', attributeTag: 'dob' }])), 'invalid-request', /unknown type/);
  rejectsWith(() => readProofRequest(one([{ type: 'RevealAttribute', attributeTag: 'favouriteColour' }])), 'unknown-attribute');
  rejectsWith(() => readProofRequest(one([{ type: 'RevealAttribute', attributeTag: 'dob' }, { type: 'AttributeInRange', attributeTag: 'dob', lower: '1', upper: '2' }])),
    'invalid-request', /asked about twice/);
  rejectsWith(() => readProofRequest(one([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '2', upper: '1' }])), 'invalid-request', /lower first/);
  rejectsWith(() => readProofRequest(one([{ type: 'AttributeInSet', attributeTag: 'nationality', set: [] }])), 'invalid-request', /non-empty set/);
});

// ---- describeProofRequest: the consent screen -------------------------------------------------------------------

test('describeProofRequest: Concordium\'s reward-distribution request, in plain English', () => {
  assert.deepEqual(describeProofRequest(REWARD_DISTRIBUTION, { now: NOW }), [{
    providers: [0, 1, 2, 3, 4, 5],
    asks: [
      { kind: 'reveal', attribute: 'nationalIdNo', text: 'show your national ID number' },
      { kind: 'reveal', attribute: 'nationality', text: 'show your nationality' },
      { kind: 'range', attribute: 'dob', text: 'prove you were born before 2 Aug 2006 (at least 20 years old), without showing your date of birth' },
      { kind: 'not-in-set', attribute: 'countryOfResidence', text: 'prove your country of residence is none of: US, KP (without showing it)' },
    ],
  }]);
});

test('describeProofRequest: an age check made today says "at least 18"; set and document wording', () => {
  assert.equal(describeProofRequest(BEER_STORE, { now: NOW })[0].asks[0].text,
    'prove you were born before 4 Nov 2008 (at least 18 years old), without showing your date of birth');
  // requestFor counts the 18 years back from today, so describe it as of today too (not the fixed NOW).
  const asks = describeProofRequest(requestFor({ providers: [0], adult: true, residentIn: ['GB', 'DE'], documentValid: NOW }), { now: new Date() })[0].asks;
  assert.match(asks[0].text, /at least 18 years old/);
  assert.equal(asks[1].text, 'prove your country of residence is one of: GB, DE (without showing which)');
  assert.equal(asks[2].text, 'prove your ID document is still valid on 3 Nov 2026, without showing its dates');
});

test('describeProofRequest: a bad request is refused, as when reading it', () => {
  rejectsWith(() => describeProofRequest({ challenge: 'aa', credentialStatements: [] }), 'invalid-request');
});

test('describeProofRequest: "at least N years old" is right on the edges (the day before a birthday; 29 February)', () => {
  const minAge = (upper, now) => Number(describeProofRequest({ challenge: 'aa', credentialStatements: [{
    idQualifier: { type: 'cred', issuers: [0] }, statement: [{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper }],
  }] }, { now: new Date(now) })[0].asks[0].text.match(/at least (\d+) years old/)[1]);
  // "born before 4 Nov 2008": the latest birth date allowed is 3 Nov 2008.
  assert.equal(minAge('20081104', '2026-11-03T12:00Z'), 18, 'on their 18th birthday');
  assert.equal(minAge('20081104', '2026-11-02T12:00Z'), 17, 'the day before, they are still 17');
  assert.equal(minAge('20060802', '2026-08-01T12:00Z'), 20);
  assert.equal(minAge('20060802', '2026-07-31T12:00Z'), 19);
  // Born 29 Feb 2000 (the latest allowed by "before 1 Mar 2000"): in 2026 (no 29 Feb) the birthday counts from 1 Mar.
  assert.equal(minAge('20000301', '2026-02-28T12:00Z'), 25);
  assert.equal(minAge('20000301', '2026-03-01T12:00Z'), 26);
});

// ---- Version 1: an identity-based question, anchored on chain -------------------------------------------------

// A version 1 question as a wallet receives it: Concordium's VerificationRequestV1 as JSON, written out by hand
// (the format, not our code, decides what it looks like). Reading does not check the anchor on chain.
const ANCHOR = '2d84d189a6ec7cee7714ed4cbe4e9c428da250406a76eb8d143d3b11fa44e47f';
const V1_AGE_CHECK = {
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
/** A copy of V1_AGE_CHECK with `change` applied to it (to break one thing at a time). */
const v1With = (change) => { const q = structuredClone(V1_AGE_CHECK); change(q); return q; };

test('readProofRequestV1: a version 1 question is read, with its network, providers, context and anchor', () => {
  const read = readProofRequestV1(V1_AGE_CHECK);
  assert.equal(read.version, 1);
  assert.equal(read.network, 'Testnet');
  assert.deepEqual(read.claims, [{ providers: [0, 3], source: ['identityCredential'], statements: V1_AGE_CHECK.subjectClaims[0].statements }]);
  assert.deepEqual(read.given, { Nonce: '07'.repeat(32), ConnectionID: 'connection-1', ResourceID: 'shop.example', ContextString: 'age check at the till' });
  assert.deepEqual(read.requested, ['BlockHash']);
  assert.equal(read.anchor, ANCHOR);
  assert.deepEqual(read.request.toJSON(), V1_AGE_CHECK, 'the SDK\'s own object, ready for answering, says the same');
});

test('readProofRequestV1: the same question as JSON text, as the SDK\'s object, or in WalletConnect\'s wrapper', () => {
  const sdkObject = sdk.VerificationRequestV1.fromJSON(V1_AGE_CHECK);
  for (const form of [JSON.stringify(V1_AGE_CHECK), sdkObject, { paramsJson: JSON.stringify(V1_AGE_CHECK) }]) {
    assert.equal(isProofRequestV1(form), true);
    assert.deepEqual(readProofRequestV1(form).claims[0].providers, [0, 3]);
  }
  assert.equal(isProofRequestV1(BEER_STORE), false, 'a version 0 request is not one');
  assert.equal(isProofRequestV1('{not json'), false);
});

test('readProofRequestV1: a question made with Concordium\'s own builder is read as it is', () => {
  const context = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(1), 'c-1', 'bar.example', 'entry');
  const claims = sdk.VerificationRequestV1.claimsBuilder()
    .addIdentityClaims([new sdk.IdentityProviderDID('Mainnet', 1)], (b) => b.addMinimumAge(18).revealAttribute('nationality'))
    .addAccountOrIdentityClaims([new sdk.IdentityProviderDID('Mainnet', 2)], (b) => b.addNonMembership('countryOfResidence', ['US']))
    .getClaims();
  const read = readProofRequestV1(sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR)));
  assert.equal(read.network, 'Mainnet');
  assert.deepEqual(read.claims.map((c) => [c.providers, c.source]), [[[1], ['identityCredential']], [[2], ['accountCredential', 'identityCredential']]]);
  assert.deepEqual(read.requested, ['BlockHash']);
});

test('readProofRequestV1: a question it cannot answer correctly is refused, saying what is wrong', () => {
  const broken = (change, reason, pattern) => rejectsWith(() => readProofRequestV1(v1With(change)), reason, pattern);
  rejectsWith(() => readProofRequestV1(BEER_STORE), 'invalid-request', /Not a version 1 question/);
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
});

test('readProofRequest (version 0) refuses a version 1 question instead of misreading it', () => {
  rejectsWith(() => readProofRequest(V1_AGE_CHECK), 'invalid-request', /version 1 question/);
});

test('describeProofRequest: a version 1 question, in plain English, with its network and where the answer comes from', () => {
  assert.deepEqual(describeProofRequest(V1_AGE_CHECK, { now: NOW }), [{
    providers: [0, 3],
    network: 'testnet',
    answerFrom: 'identity',
    asks: [{ kind: 'range', attribute: 'dob', text: 'prove you were born before 4 Nov 2008 (at least 18 years old), without showing your date of birth' }],
  }]);
  const either = v1With((q) => { q.subjectClaims[0].source = ['accountCredential', 'identityCredential']; });
  assert.equal(describeProofRequest(either)[0].answerFrom, 'identity or account');
  const account = v1With((q) => { q.subjectClaims[0].source = ['accountCredential']; });
  assert.equal(describeProofRequest(account)[0].answerFrom, 'account');
  rejectsWith(() => describeProofRequest(v1With((q) => { q.subjectClaims = []; })), 'invalid-request');
});

test('describeProofContext: who is asking a version 1 question, as the website wrote it', () => {
  assert.deepEqual(describeProofContext(V1_AGE_CHECK), {
    network: 'testnet', website: 'shop.example', purpose: 'age check at the till', connection: 'connection-1', anchor: ANCHOR,
  });
  const bare = v1With((q) => { q.context.given = [{ label: 'Nonce', context: 'aa' }]; });
  assert.deepEqual(describeProofContext(bare), { network: 'testnet', anchor: ANCHOR }, 'only what the website gave');
  rejectsWith(() => describeProofContext(BEER_STORE), 'invalid-request', /Only a version 1 question/);
});

// ---- Company identities (Business ID): questions about a company -------------------------------------------------

test('requestFor: a company question: show its LEI and legal name, prove it is registered in one of some countries', () => {
  const { credentialStatements: [{ idQualifier, statement }] } = requestFor({
    providers: [4], reveal: ['lei', 'legalName'], registeredIn: ['DK', 'SE', 'DE'],
  });
  assert.deepEqual(idQualifier.issuers, [4], 'Global FinReg (testnet), a Business ID provider');
  assert.deepEqual(statement.map((s) => [s.type, s.attributeTag]), [
    ['AttributeInSet', 'legalCountry'], ['RevealAttribute', 'lei'], ['RevealAttribute', 'legalName']]);
  assert.deepEqual(statement[0].set, ['DK', 'SE', 'DE']);
  const [{ statement: [notIn] }] = requestFor({ providers: [4], notRegisteredIn: ['KP', 'IR'] }).credentialStatements;
  assert.deepEqual([notIn.type, notIn.attributeTag, notIn.set], ['AttributeNotInSet', 'legalCountry', ['KP', 'IR']]);
});

test('requestFor: the company options are checked like the others', () => {
  rejectsWith(() => requestFor({ providers: [4], registeredIn: ['dk'] }), 'invalid-request', /registeredIn must be a list of two-letter country codes/);
  rejectsWith(() => requestFor({ providers: [4], registeredIn: ['DK'], notRegisteredIn: ['KP'] }), 'invalid-request',
    /legalCountry is used twice \(by registeredIn and notRegisteredIn\)/);
  rejectsWith(() => requestFor({ providers: [4], registeredIn: ['DK'], reveal: ['legalCountry'] }), 'invalid-request', /legalCountry is used twice/);
});

test('describeProofRequest: a company question says "the company", not "your"', () => {
  const asks = describeProofRequest(requestFor({ providers: [4], reveal: ['lei', 'legalName', 'businessNumber'], registeredIn: ['DK', 'SE'] }))[0].asks;
  assert.deepEqual(asks.map((a) => a.text), [
    'prove the company is registered in one of: DK, SE (without showing which)',
    'show the company\'s legal entity identifier (LEI)',
    'show the company\'s legal name',
    'show the company\'s business number',
  ]);
  assert.equal(describeProofRequest(requestFor({ providers: [4], notRegisteredIn: ['KP'] }))[0].asks[0].text,
    'prove the company is registered in none of: KP (without showing where)');
  assert.equal(describeProofRequest(requestFor({ providers: [0], reveal: ['nationality'] }))[0].asks[0].text,
    'show your nationality', 'a person\'s details still say "your"');
});

test('describeProofRequest: a version 1 company question reads the same', () => {
  const claims = sdk.VerificationRequestV1.claimsBuilder()
    .addIdentityClaims([new sdk.IdentityProviderDID('Testnet', 4)], (b) => b.revealAttribute('lei').addMembership('legalCountry', ['DK']))
    .getClaims();
  const context = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(3), 'c', 'bank.example', 'onboarding');
  const question = sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR));
  assert.deepEqual(describeProofRequest(question)[0].asks.map((a) => a.text), [
    'show the company\'s legal entity identifier (LEI)', 'prove the company is registered in one of: DK (without showing which)']);
});
