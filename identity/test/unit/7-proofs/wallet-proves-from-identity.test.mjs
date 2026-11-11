// Proofs, version 1: the wallet answers an anchored question from the identity itself (no account). No network: the
// identity is the one recorded from testnet, the node is a pretend one that knows the question's anchor, and each
// answer is checked here with Concordium's own verifier against the recorded provider's public keys.
//
// The scenario: the website (played by the test) builds questions with Concordium's SDK; the wallet answers; the
// website checks the answer with Concordium's verifier against provider 0's recorded keys.
//   WALLET        the recorded identity (provider 0, identity 334563111; John Doe: born 1970, lives in DK)
//   PRETEND NODE  holds the question's anchor (made with the SDK; one test uses the real anchor recorded on testnet)
//
//   WEBSITE (the test)              WALLET: proveIdentity                                PRETEND NODE
//   ──────────────────              ─────────────────────                                ────────────
//   the question ─────────────────► 1. reads it (any form it arrives in)
//                                   2. same network? what must the wallet fill in?
//                                   3. identity held? not expired?
//                                   4. answers from the identity accepted? provider accepted? can it truly answer?
//                                      (any "no" in 2-4: refused before the node is asked)
//                                   5. the secret ingredients, from the seed and the identity
//                                   6. the anchor: on chain, final, this question? ────► getBlockItemStatus
//                                   7. builds the answer, tied to the anchor's block
//   8. Concordium's verifier ◄───── the answer
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, ProofError } from '@concordium/wdk-identity-concordium';
import { walletProxyFetch, globalFixture, ipInfoFixture, testnetConfig, recordedNode, nodeStatus, SIGNATURE_NOT_CHECKED } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));
// The recorded identity's details (the test provider's made-up ones): born 1970-01-01, lives in DK, nationality DK.

const ANCHOR_BLOCK = 'b7'.repeat(32);
const ANCHOR_HASH = 'cd'.repeat(32);

/**
 * A website's version 1 question, as Concordium's SDK builds it: `build` adds the statements (e.g. b.addMinimumAge(18));
 * `providers` the accepted providers; `kind` which builder method (identity only, account only, or either);
 * `requested` what the wallet must fill in (default: the anchor's block only).
 */
function question({ build = (b) => b.addMinimumAge(18), providers = [0, 1], kind = 'addIdentityClaims', network = 'Testnet',
  requested } = {}) {
  const simple = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(9), 'connection-1', 'shop.example', 'age check');
  const context = requested ? sdk.VerificationRequestV1.createContext({ given: simple.given.filter((g) => !requested.includes(g.label)), requested }) : simple;
  const claims = sdk.VerificationRequestV1.claimsBuilder()[kind](providers.map((i) => new sdk.IdentityProviderDID(network, i)), build).getClaims();
  return sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR_HASH));
}

/** The node's answer about an anchor transaction that is final and records `recorded` (a question). */
function anchoredOnChain(recorded, { transactionType = 'registerData' } = {}) {
  const data = Buffer.from(sdk.VerificationRequestV1.createAnchor(recorded.context, recorded.subjectClaims)).toString('hex');
  return {
    status: 'finalized',
    outcome: { blockHash: sdk.BlockHash.fromHexString(ANCHOR_BLOCK), summary: { type: 'accountTransaction', transactionType, dataRegistered: { data } } },
  };
}

/** A wallet holding the recorded identity, whose pretend node answers the anchor check with `anchor` (statuses). */
async function walletWithIdentity({ anchor, validTo } = {}) {
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => {
    if (url === CODE_URI) {
      const issued = fixture('identity-done.testnet.json');
      if (validTo) issued.token.identityObject.value.attributeList.validTo = validTo; // e.g. an expired identity
      return { ok: true, status: 200, json: async () => issued };
    }
    return recorded.fetch(url, options);
  };
  const node = recordedNode('testnet', { statuses: [anchor] });
  const wallet = new ConcordiumIdentity(PHRASE, testnetConfig({ node }), { fetch, ...(validTo ? SIGNATURE_NOT_CHECKED : {}) });
  await wallet.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  return { wallet, node };
}

/** The website's check, with Concordium's verifier, against provider 0's public keys (as the node holds them). */
function websiteChecks(proof) {
  const provider = ipInfoFixture('testnet').find((e) => e.ipInfo.ipIdentity === 0);
  const sent = sdk.VerifiablePresentationV1.fromJSON(JSON.parse(JSON.stringify(proof))); // as the website receives it
  const publicData = [{ type: 'identity', ipInfo: provider.ipInfo, arsInfos: provider.arsInfos }];
  return sdk.VerifiablePresentationV1.verify(sent, globalFixture('testnet').value, publicData).result;
}

const rejectsWith = (promise, reason, pattern) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof ProofError, `a ProofError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

// Steps 1-8: accepted; no account named; nationality shown.
test('proveIdentity: "over 18" from the identity: Concordium\'s verifier accepts it, tied to the anchor\'s block', async () => {
  const asked = question({ build: (b) => b.addMinimumAge(18).revealAttribute('nationality') });
  const { wallet, node } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  const proof = await wallet.proveIdentity({ ...RECORDED, request: asked.toJSON() });
  const checked = websiteChecks(proof);
  assert.deepEqual(checked.context.requested.map((c) => [c.label, sdk.BlockHash.toHexString(c.context)]), [['BlockHash', ANCHOR_BLOCK]],
    'the proof is tied to the block the question was recorded in');
  assert.deepEqual(checked.context.given.find((c) => c.label === 'ResourceID').context, 'shop.example', 'and to this question');
  const [claim] = checked.subjectClaims;
  assert.equal(claim.issuer, 'did:ccd:testnet:idp:0', 'it shows which provider issued the identity');
  assert.deepEqual(claim.statement.map((s) => s.type), ['AttributeInRange', 'AttributeValue']);
  assert.equal(claim.statement[1].attributeValue, 'DK', 'the nationality asked to be shown');
  const sent = JSON.stringify(proof);
  assert.doesNotMatch(sent, /:cred:|:acc:/, 'no account is named');
  assert.doesNotMatch(sent, /19700101/, 'the date of birth itself is not in the proof');
  assert.equal(node.statusCalls, 1, 'the anchor was checked on the node');
  wallet.dispose();
});

// Step 1: the forms a question arrives in.
test('proveIdentity: the question as JSON text, as the SDK\'s object, or in WalletConnect\'s wrapper', async () => {
  const asked = question();
  const { wallet } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  for (const request of [JSON.stringify(asked), asked, { paramsJson: JSON.stringify(asked) }]) {
    assert.equal(websiteChecks(await wallet.proveIdentity({ ...RECORDED, request })).subjectClaims.length, 1);
  }
  wallet.dispose();
});

// Step 4: "either" is answered from the identity.
test('proveIdentity: a question accepting identity or account is answered from the identity', async () => {
  const asked = question({ kind: 'addAccountOrIdentityClaims', build: (b) => b.addMembership('countryOfResidence', ['DK', 'SE']) });
  const { wallet } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  const [claim] = websiteChecks(await wallet.proveIdentity({ ...RECORDED, request: asked })).subjectClaims;
  assert.ok(claim.type.includes('ConcordiumIdBasedSubjectClaims'));
  wallet.dispose();
});

// Steps 2 and 4: each refusal, before step 6.
test('proveIdentity: refused before anything is asked of the node when the answer would not be true or acceptable', async () => {
  const cases = [
    [question({ kind: 'addAccountClaims' }), 'account-only', /account only/],
    [question({ providers: [1, 2] }), 'provider-not-accepted', /providers 1, 2, not from provider 0/],
    [question({ build: (b) => b.addMinimumAge(60) }), 'cannot-prove', /date of birth/],
    [question({ build: (b) => b.addMembership('countryOfResidence', ['SE']) }), 'cannot-prove', /country of residence/],
    [question({ network: 'Mainnet' }), 'invalid-request', /Mainnet identities; this wallet's are on Testnet/],
    [question({ requested: ['BlockHash', 'Nonce'] }), 'invalid-request', /Nonce, which this package cannot fill in/],
  ];
  for (const [asked, reason, pattern] of cases) {
    const { wallet, node } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
    await rejectsWith(wallet.proveIdentity({ ...RECORDED, request: asked }), reason, pattern);
    assert.equal(node.statusCalls, 0, `${reason}: nothing asked of the node`);
    wallet.dispose();
  }
});

// Step 3.
test('proveIdentity: an identity not held, or expired, is refused', async () => {
  const asked = question();
  const { wallet } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  await rejectsWith(wallet.proveIdentity({ providerIndex: 0, identityIndex: 7, request: asked }), 'not-held');
  wallet.dispose();
  const expired = await walletWithIdentity({ anchor: anchoredOnChain(asked), validTo: '202510' });
  await rejectsWith(expired.wallet.proveIdentity({ ...RECORDED, request: asked }), 'identity-expired', /2025-10/);
  expired.wallet.dispose();
});

// Step 6: anchor-not-found.
test('proveIdentity: an anchor that is not on chain, or not final yet, is refused as anchor-not-found', async () => {
  const asked = question();
  for (const [anchor, detail, pattern] of [
    ['absent', 'absent', /not on chain/],
    [nodeStatus.received(), 'received', /not final yet .*try again/],
    [nodeStatus.committed(), 'committed', /not final yet/],
  ]) {
    const { wallet } = await walletWithIdentity({ anchor });
    await assert.rejects(wallet.proveIdentity({ ...RECORDED, request: asked }), (e) => e.reason === 'anchor-not-found' && e.detail === detail && pattern.test(e.message));
    wallet.dispose();
  }
});

// Step 6: anchor-mismatch.
test('proveIdentity: an anchor that does not record this question is refused as anchor-mismatch', async () => {
  const asked = question();
  const another = question({ build: (b) => b.addMinimumAge(21) }); // the website recorded a different question
  for (const anchor of [anchoredOnChain(another), anchoredOnChain(asked, { transactionType: 'transfer' })]) {
    const { wallet } = await walletWithIdentity({ anchor });
    await rejectsWith(wallet.proveIdentity({ ...RECORDED, request: asked }), 'anchor-mismatch', /does not record this question/);
    wallet.dispose();
  }
});

// Step 6: the node down.
test('proveIdentity: a node that cannot be asked is reported as reason node', async () => {
  const unreachable = Object.assign(new Error('connection refused'), { name: 'RpcError', code: 'UNAVAILABLE' });
  const { wallet } = await walletWithIdentity({ anchor: unreachable });
  await assert.rejects(wallet.proveIdentity({ ...RECORDED, request: question() }), (e) => e.reason === 'node' && /connection refused/.test(e.detail));
  wallet.dispose();
});

// Steps 2 and 7: what the wallet fills in.
test('proveIdentity: what the question asks the wallet to fill in (e.g. the site it is connected to) is put in the proof', async () => {
  const asked = question({ requested: ['BlockHash', 'ResourceID'] });
  const { wallet } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  await assert.rejects(wallet.proveIdentity({ ...RECORDED, request: asked }), /asks the wallet for its ResourceID: pass context/);
  await assert.rejects(wallet.proveIdentity({ ...RECORDED, request: asked, context: { ResourceID: 'shop.example', Mood: 'x' } }),
    /context\.Mood is not asked for/);
  const proof = await wallet.proveIdentity({ ...RECORDED, request: asked, context: { ResourceID: 'shop.example' } });
  const filled = websiteChecks(proof).context.requested;
  assert.deepEqual(filled.map((c) => c.label).sort(), ['BlockHash', 'ResourceID']);
  assert.equal(filled.find((c) => c.label === 'ResourceID').context, 'shop.example');
  wallet.dispose();
});

// Step 8: a changed answer.
test('proveIdentity: a changed answer is refused by the website\'s verifier', async () => {
  const asked = question();
  const { wallet } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  const changed = JSON.parse(JSON.stringify(await wallet.proveIdentity({ ...RECORDED, request: asked })));
  changed.presentationContext.given.find((c) => c.label === 'ResourceID').context = 'another-shop.example';
  assert.throws(() => websiteChecks(changed), /not valid/);
  wallet.dispose();
});

// Steps 1-8 on the real recorded question and anchor.
test('proveIdentity: the question recorded on testnet, with its real anchor as the node gave it, is answered and verified', async () => {
  // Recorded once by test/fixtures/capture-v1-question.mjs (a sponsored anchor on testnet).
  const { question: recordedQuestion, anchor } = fixture('v1-question.testnet.json');
  const onChain = {
    status: 'finalized',
    outcome: { blockHash: sdk.BlockHash.fromHexString(anchor.blockHash), summary: { type: 'accountTransaction', transactionType: anchor.transactionType, dataRegistered: { data: anchor.data } } },
  };
  const { wallet } = await walletWithIdentity({ anchor: onChain });
  const checked = websiteChecks(await wallet.proveIdentity({ ...RECORDED, request: recordedQuestion }));
  assert.equal(sdk.BlockHash.toHexString(checked.context.requested[0].context), anchor.blockHash);
  assert.equal(checked.subjectClaims[0].statement.find((s) => s.type === 'AttributeValue').attributeValue, 'DK');
  wallet.dispose();
});

// Step 4: a company question asked of a person's identity.
test('proveIdentity: a person\'s identity asked a company question (an LEI) is refused before the node is asked', async () => {
  const asked = question({ build: (b) => b.revealAttribute('lei') });
  const { wallet, node } = await walletWithIdentity({ anchor: anchoredOnChain(asked) });
  await rejectsWith(wallet.proveIdentity({ ...RECORDED, request: asked }), 'cannot-prove', /no legal entity identifier \(LEI\)/);
  assert.equal(node.statusCalls, 0);
  wallet.dispose();
});
