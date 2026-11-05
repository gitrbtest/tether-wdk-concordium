// Proofs, piece 2: the wallet makes a proof (version 0, account-based) from the identity it holds. No network: the
// identity is the one recorded from testnet, and each proof is checked here with Concordium's own verifier against
// the recorded sealed details ("commitments") of that identity's account 0 on chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, ProofError, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { requestFor } from '@concordium/wdk-identity-concordium/verify';
import { walletProxyFetch, globalFixture } from '../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const ACCOUNT_0 = fixture('account-commitments.testnet.json'); // { address, credId, issuer, commitments }
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
// The recorded identity's details (the test provider's made-up ones): born 1970-01-01, lives in DK, nationality DK.

/** A wallet holding the recorded identity, with the network answered from recorded data, and accounts scripted. */
async function walletWithIdentity({ accountsOnChain = [ACCOUNT_0.address], validTo } = {}) {
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => {
    if (url === CODE_URI) {
      const issued = fixture('identity-done.testnet.json');
      if (validTo) issued.token.identityObject.value.attributeList.validTo = validTo; // e.g. an expired identity
      return { ok: true, status: 200, json: async () => issued };
    }
    if (String(url).includes('/v0/accBalance/')) {
      const address = String(url).split('/v0/accBalance/')[1];
      return { ok: true, status: 200, json: async () => (accountsOnChain.includes(address) ? { finalizedBalance: { accountAmount: '1' } } : {}) };
    }
    return recorded.fetch(url, options);
  };
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch });
  await wallet.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  return wallet;
}

/** The website's check, with Concordium's verifier, against account 0's sealed details as recorded from the chain. */
function websiteChecks(presentation) {
  const publicData = [{ type: 'account', commitments: ACCOUNT_0.commitments }];
  return sdk.verifyPresentation(sdk.VerifiablePresentation.fromString(presentation.toString()), globalFixture('testnet').value, publicData);
}

const rejectsWith = (promise, reason, pattern) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof ProofError, `a ProofError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

test('prove: "over 18" from account 0: Concordium\'s verifier accepts it, tied to the website\'s challenge', async () => {
  const wallet = await walletWithIdentity();
  const request = requestFor({ providers: [0, 1, 2], adult: true });
  const presentation = await wallet.prove({ ...RECORDED, credNumber: 0, ...request });
  const checked = websiteChecks(presentation);
  assert.equal(checked.challenge, request.challenge, 'the proof is for this question only');
  assert.equal(presentation.verifiableCredential.length, 1);
  const subject = presentation.verifiableCredential[0].credentialSubject;
  assert.equal(subject.id, sdk.createAccountDID('Testnet', ACCOUNT_0.credId), 'it names account 0 (by its credential id)');
  assert.doesNotMatch(presentation.toString(), /19700101/, 'the date of birth itself is not in the proof');
  wallet.dispose();
});

test('prove: a detail the question asks to show is revealed; the rest stays hidden', async () => {
  const wallet = await walletWithIdentity();
  const request = requestFor({ providers: [0], residentIn: ['DK', 'SE'], reveal: ['nationality'] });
  const presentation = await wallet.prove({ ...RECORDED, credNumber: 0, ...request });
  websiteChecks(presentation);
  const proofs = presentation.verifiableCredential[0].credentialSubject.proof.proofValue;
  assert.deepEqual(proofs.map((p) => p.type), ['AttributeInSet', 'RevealAttribute']);
  assert.equal(proofs[1].attribute, 'DK', 'nationality shown, as asked');
  wallet.dispose();
});

test('prove: a copy of the proof does not pass for another question (another challenge)', async () => {
  const wallet = await walletWithIdentity();
  const request = requestFor({ providers: [0], adult: true });
  const presentation = await wallet.prove({ ...RECORDED, credNumber: 0, ...request });
  const other = requestFor({ providers: [0], adult: true });
  const copied = sdk.VerifiablePresentation.fromString(presentation.toString().replace(request.challenge, other.challenge));
  assert.throws(() => sdk.verifyPresentation(copied, globalFixture('testnet').value,
    [{ type: 'account', commitments: ACCOUNT_0.commitments }]), 'the maths no longer holds');
  wallet.dispose();
});

test('prove: the question can come as WalletConnect delivers it ({ paramsJson })', async () => {
  const wallet = await walletWithIdentity();
  const request = requestFor({ providers: [0], adult: true });
  const presentation = await wallet.prove({ ...RECORDED, credNumber: 0, paramsJson: JSON.stringify(request) });
  assert.equal(websiteChecks(presentation).challenge, request.challenge);
  wallet.dispose();
});

test('prove: refuses BEFORE building anything when the answer would not be true', async () => {
  const wallet = await walletWithIdentity();
  // Born 1970: not "at least 100".
  await rejectsWith(wallet.prove({ ...RECORDED, credNumber: 0, ...requestFor({ providers: [0], minAge: 100 }) }), 'cannot-prove', /date of birth/);
  // Lives in DK: not one of GB, DE.
  await rejectsWith(wallet.prove({ ...RECORDED, credNumber: 0, ...requestFor({ providers: [0], residentIn: ['GB', 'DE'] }) }), 'cannot-prove', /country of residence/);
  // Provider 0 is not among those accepted.
  await rejectsWith(wallet.prove({ ...RECORDED, credNumber: 0, ...requestFor({ providers: [3, 5], adult: true }) }), 'provider-not-accepted', /not from provider 0/);
  wallet.dispose();
});

test('prove: no identity held for that number: not-held; a bad question: invalid-request', async () => {
  const wallet = await walletWithIdentity();
  await rejectsWith(wallet.prove({ providerIndex: 0, identityIndex: 7, credNumber: 0, ...requestFor({ providers: [0], adult: true }) }), 'not-held');
  await rejectsWith(wallet.prove({ ...RECORDED, credNumber: 0, challenge: 'xyz', credentialStatements: [] }), 'invalid-request');
  await assert.rejects(wallet.prove({ ...requestFor({ providers: [0], adult: true }) }), /providerIndex is required/);
  // No default numbers: the wallet says which identity and which account, every time.
  await assert.rejects(wallet.prove({ providerIndex: 0, credNumber: 0, ...requestFor({ providers: [0], adult: true }) }),
    /identityIndex is required: .*nextIdentityIndex/);
  await assert.rejects(wallet.prove({ ...RECORDED, ...requestFor({ providers: [0], adult: true }) }),
    /credNumber is required: .*accountsThatCanAnswer/);
  await assert.rejects(wallet.accountsThatCanAnswer({ providerIndex: 0, ...requestFor({ providers: [0], adult: true }) }),
    /identityIndex is required/);
  wallet.dispose();
  await assert.rejects(wallet.prove({ ...RECORDED, credNumber: 0, ...requestFor({ providers: [0], adult: true }) }), /disposed/);
});

test('accountsThatCanAnswer: the identity\'s accounts on chain if it can answer; none if it cannot', async () => {
  const wallet = await walletWithIdentity();
  const yes = await wallet.accountsThatCanAnswer({ ...RECORDED, ...requestFor({ providers: [0], adult: true }) });
  assert.deepEqual(yes, [{ credNumber: 0, address: ACCOUNT_0.address, path: `0/${RECORDED.identityIndex}/0` }]);
  assert.deepEqual(await wallet.accountsThatCanAnswer({ ...RECORDED, ...requestFor({ providers: [0], minAge: 100 }) }), [], 'cannot truly answer');
  assert.deepEqual(await wallet.accountsThatCanAnswer({ ...RECORDED, ...requestFor({ providers: [5], adult: true }) }), [], 'provider not accepted');
  await rejectsWith(wallet.accountsThatCanAnswer({ providerIndex: 0, identityIndex: 7, ...requestFor({ providers: [0], adult: true }) }), 'not-held');
  wallet.dispose();
});

test('prove: an expired identity is refused up front (Concordium reports its credential as Expired; websites refuse it)', async () => {
  const wallet = await walletWithIdentity({ validTo: '202601' }); // valid until the end of January 2026: expired
  await rejectsWith(wallet.prove({ ...RECORDED, credNumber: 0, ...requestFor({ providers: [0], adult: true }) }), 'identity-expired', /2026-01.*verify again/);
  assert.deepEqual(await wallet.accountsThatCanAnswer({ ...RECORDED, ...requestFor({ providers: [0], adult: true }) }), []);
  wallet.dispose();
});
