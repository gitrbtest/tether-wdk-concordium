// Proofs, piece 3: the website checks a wallet's answer (checkPresentation, on the /verify entry). No network: the
// wallet holds the identity recorded from testnet, and a pretend node answers with the record of that identity's
// account 0 as recorded from the chain (its sealed details). Each test breaks one thing and expects a refusal.
//
// The scenario (version 0):
//   WEBSITE       asks with requestFor and checks with checkPresentation
//   WALLET        the recorded identity, answering with its account 0
//   PRETEND NODE  holds account 0's record as recorded from testnet: its sealed details and validity
//
//   WEBSITE                         WALLET                     PRETEND NODE
//   ───────                         ──────                     ────────────
//   requestFor ───────────────────► prove (account 0)
//   checkPresentation ◄──────────── the answer
//     1. readable?
//     2. for our question? (challenge, statements, provider, network): checked without asking the chain
//     3. account 0's record ───────────────────────────────────► sealed details, validity (or: not on chain)
//     4. still Active? (not expired, not "not yet valid")
//     5. the maths holds, against the sealed details → accepted: account 0, the details shown
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { requestFor, checkPresentation, connectToNode, ProofError } from '@concordium/wdk-identity-concordium/verify';
import { walletProxyFetch, globalFixture, testnetConfig } from '../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const ACCOUNT_0 = fixture('account-commitments.testnet.json'); // { address, credId, issuer, commitments }
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const NOW = new Date('2026-11-03T12:00:00Z');

/** A wallet holding the recorded identity (born 1970-01-01, lives in DK, nationality DK), network answered from recordings. */
async function wallet() {
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => (url === CODE_URI
    ? { ok: true, status: 200, json: async () => fixture('identity-done.testnet.json') }
    : recorded.fetch(url, options));
  const w = new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch });
  await w.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  return w;
}

/**
 * A pretend Concordium node with account 0's record on it, as recorded from testnet. `validTo` / `createdAt` (YYYYMM)
 * set the identity's validity as the chain holds it; `commitments` replaces the sealed details; `fail` makes every
 * question to the node fail with that gRPC code. Counts the questions asked.
 */
function pretendNode({ validTo = '202709', createdAt = '202609', commitments = ACCOUNT_0.commitments, fail } = {}) {
  const node = {
    asked: 0,
    async getAccountInfo(credId) {
      node.asked++;
      if (fail) throw Object.assign(new Error('the node is unreachable'), { name: 'RpcError', code: fail });
      if (credId.credId !== ACCOUNT_0.credId) {
        throw Object.assign(new Error('account or block not found.'), { name: 'RpcError', code: 'NOT_FOUND' });
      }
      return {
        accountAddress: sdk.AccountAddress.fromBase58(ACCOUNT_0.address),
        accountCredentials: { 0: { v: 0, value: { type: 'normal', contents: {
          credId: ACCOUNT_0.credId, ipIdentity: ACCOUNT_0.issuer, policy: { createdAt, validTo, revealedAttributes: {} },
          commitments: { cmmAttributes: commitments } } } } },
      };
    },
    async getBlockInfo() { return { blockSlotTime: NOW }; },
    async getCryptographicParameters() { return globalFixture('testnet').value; },
  };
  return node;
}

const check = (presentation, request, node = pretendNode()) => checkPresentation(presentation, request, { node, network: 'testnet' });
const refusedFor = (result) => { assert.equal(result.ok, false); return result.reasons.map((r) => r.reason); };

// Steps 1-5: accepted.
test('checkPresentation: a true answer to our question is accepted, naming the account and what was shown', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0, 1, 2], adult: true, reveal: ['nationality'] });
  const answer = await w.prove({ ...RECORDED, credNumber: 0, ...request });
  const result = await check(answer, request);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.account, ACCOUNT_0.address);
  assert.deepEqual(result.revealed, { nationality: 'DK' });
  assert.deepEqual(result.credentials, [{ account: ACCOUNT_0.address, issuer: 0, revealed: { nationality: 'DK' } }]);
  // The same answer as text, and as WalletConnect delivers it.
  assert.equal((await check(answer.toString(), request)).ok, true);
  assert.equal((await check({ verifiablePresentationJson: answer.toString() }, request)).ok, true);
  w.dispose();
});

// Step 2: the challenge.
test('checkPresentation: an answer to another request (another challenge) is refused, without asking the chain', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0], adult: true });
  const answer = await w.prove({ ...RECORDED, credNumber: 0, ...request });
  const node = pretendNode();
  const result = await check(answer, requestFor({ providers: [0], adult: true }), node);
  assert.deepEqual(refusedFor(result), ['challenge-mismatch']);
  assert.equal(node.asked, 0, 'refused from the answer alone');
  w.dispose();
});

// Step 2: the statements.
test('checkPresentation: an answer to an easier question ("over 5" for "over 18") is refused, though its maths holds', async () => {
  const w = await wallet();
  const asked = requestFor({ providers: [0], adult: true });
  const easier = { ...requestFor({ providers: [0], minAge: 5 }), challenge: asked.challenge };
  const answer = await w.prove({ ...RECORDED, credNumber: 0, ...easier });
  assert.equal((await check(answer, easier)).ok, true, 'a true answer to the easier question');
  assert.deepEqual(refusedFor(await check(answer, asked)), ['statements-mismatch']);
  w.dispose();
});

// Step 2: the provider.
test('checkPresentation: an identity from a provider the request does not accept is refused', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0, 1], adult: true });
  const answer = await w.prove({ ...RECORDED, credNumber: 0, ...request });
  const onlyOthers = structuredClone(request);
  onlyOthers.credentialStatements[0].idQualifier.issuers = [1, 2];
  assert.deepEqual(refusedFor(await check(answer, onlyOthers)), ['provider-not-accepted']);
  w.dispose();
});

// Step 2: the network.
test('checkPresentation: a testnet answer is refused by a mainnet website', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0], adult: true });
  const answer = await w.prove({ ...RECORDED, credNumber: 0, ...request });
  const result = await checkPresentation(answer, request, { node: pretendNode(), network: 'mainnet' });
  assert.deepEqual(refusedFor(result), ['wrong-network']);
  w.dispose();
});

// Step 4.
test('checkPresentation: an identity no longer valid (expired) or not yet valid is refused, though its maths holds', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0], adult: true });
  const answer = await w.prove({ ...RECORDED, credNumber: 0, ...request });
  const expired = await check(answer, request, pretendNode({ validTo: '202601' }));
  assert.deepEqual(refusedFor(expired), ['not-active']);
  assert.match(expired.reasons[0].message, /expired/);
  const notYet = await check(answer, request, pretendNode({ createdAt: '202712' }));
  assert.deepEqual(refusedFor(notYet), ['not-active']);
  assert.match(notYet.reasons[0].message, /not active yet/);
  w.dispose();
});

// Step 3.
test('checkPresentation: an account not on chain is refused', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0], adult: true });
  const answer = JSON.parse((await w.prove({ ...RECORDED, credNumber: 0, ...request })).toString());
  // Point the answer at another record (a different, valid credential id: account 0's with the first byte changed).
  answer.verifiableCredential[0].credentialSubject.id = answer.verifiableCredential[0].credentialSubject.id.replace(':cred:aa', ':cred:8a');
  assert.deepEqual(refusedFor(await check(answer, request)), ['not-on-chain']);
  w.dispose();
});

// Step 5.
test('checkPresentation: a proof whose maths does not hold is refused (tampered, or other sealed details)', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0], adult: true });
  const answer = JSON.parse((await w.prove({ ...RECORDED, credNumber: 0, ...request })).toString());
  // The chain's sealed date of birth is another one (the nationality's seal in its place).
  const swapped = { ...ACCOUNT_0.commitments, dob: ACCOUNT_0.commitments.nationality };
  assert.deepEqual(refusedFor(await check(answer, request, pretendNode({ commitments: swapped }))), ['proof-invalid']);
  // The proof itself altered.
  const proof = answer.verifiableCredential[0].credentialSubject.proof.proofValue[0];
  proof.proof = proof.proof.slice(0, 200) + (proof.proof[200] === '0' ? '1' : '0') + proof.proof.slice(201);
  assert.deepEqual(refusedFor(await check(answer, request)), ['proof-invalid']);
  w.dispose();
});

// Step 1.
test('checkPresentation: something that is not an answer is refused as unreadable', async () => {
  const request = requestFor({ providers: [0], adult: true });
  for (const junk of ['hello', {}, null, { verifiablePresentationJson: '{' }]) {
    assert.deepEqual(refusedFor(await check(junk, request)), ['unreadable'], JSON.stringify(junk));
  }
});

// Step 3: the node down; and missing options.
test('checkPresentation: the node cannot be asked: ProofError node (not a refusal); missing options: an error', async () => {
  const w = await wallet();
  const request = requestFor({ providers: [0], adult: true });
  const answer = await w.prove({ ...RECORDED, credNumber: 0, ...request });
  await assert.rejects(check(answer, request, pretendNode({ fail: 'UNAVAILABLE' })), (e) => {
    assert.ok(e instanceof ProofError);
    assert.equal(e.reason, 'node');
    return true;
  });
  await assert.rejects(checkPresentation(answer, request, { network: 'testnet' }), /node connection/);
  await assert.rejects(checkPresentation(answer, request, { node: pretendNode() }), /network/);
  await assert.rejects(check(answer, { challenge: 'xyz' }), (e) => e instanceof ProofError && e.reason === 'invalid-request');
  w.dispose();
});

// The website's node connection, used in step 3.
test('connectToNode: Concordium\'s public node by network name, or your own node\'s address', () => {
  for (const where of ['testnet', 'mainnet', 'https://my-node.example.com:20000', 'http://localhost:20000']) {
    assert.equal(typeof connectToNode(where).getAccountInfo, 'function', where);
  }
  for (const bad of ['', 'devnet', 'ftp://node:1', undefined]) assert.throws(() => connectToNode(bad), /testnet/);
});
