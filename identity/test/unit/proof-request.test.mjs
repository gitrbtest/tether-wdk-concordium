// Proofs, piece 1: a website's proof request — building it (requestFor, the website's side), reading and checking
// it, and describing it in plain English for the consent screen (the wallet's side). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProofRequest, ProofError } from '@concordium/wdk-identity-concordium';
import { requestFor } from '@concordium/wdk-identity-concordium/verify';
import { readProofRequest } from '../../src/proofs/proof-request.js';

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
  const asks = describeProofRequest(requestFor({ providers: [0], adult: true, residentIn: ['GB', 'DE'], documentValid: NOW }), { now: NOW })[0].asks;
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
