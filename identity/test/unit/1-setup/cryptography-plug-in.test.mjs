/**
 * The cryptography plug-in point: a wallet may hand in its own heavy cryptography steps (e.g. Concordium's native
 * library on a phone with React Native) instead of Concordium's JavaScript SDK. No external services: the network
 * and the node are answered from recordings.
 *
 * Who is who:
 *   WALLET     the wallet, which plugs in its own steps (here a stand-in that behaves like a native one: every step
 *              answers asynchronously, and keys come back as hex text, not bytes)
 *   PACKAGE    ConcordiumIdentity: its logic unchanged, every heavy step going through the plug-in
 *   SDK        Concordium's JavaScript SDK: what the stand-in calls in the end, so the answers can be compared
 *
 *   WALLET                                PACKAGE                                        STEPS USED
 *   ──────                                ───────                                        ──────────
 *   1. new ConcordiumIdentity(…, { cryptography }) ─► checks the plug-in (known steps, functions)
 *   2. a whole journey ─────────────────► request, collect + check, import, create an account, answer a question
 *                                         every heavy step goes through the plug-in ───► each step at least once
 *   3. the answers are the same as with the SDK alone (the request's key, the account's address)
 *   4. a plug-in may provide only some steps: the others stay with the SDK
 *   5. a phone plug-in that cannot check proofs says so ('unavailable'): the identity signature check is skipped,
 *      as in Concordium's own phone wallets (the chain and websites check it later)
 *
 * Each test says which steps it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConcordiumIdentity, SIGNATURE_CHECK_UNAVAILABLE } from '@concordium/wdk-identity-concordium';
import { requestFor, checkPresentation } from '@concordium/wdk-identity-concordium/verify';
import { CRYPTOGRAPHY_STEPS, sdkCryptography } from '../../../src/shared/cryptography.js';
import { testnetConfig, recordedNode, walletProxyFetch, pretendNode } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t'; // account 0 of the recorded identity, on testnet
const RETURN = 'mywallet://identity/return';
const issued = () => JSON.parse(readFileSync(new URL('../../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
const later = (value) => new Promise((resolve) => { setImmediate(() => resolve(value)); });

/**
 * A plug-in that behaves like a native one: each step answers asynchronously, keys come as hex text. It does the
 * work with the SDK in the end (so the answers can be checked), and notes every step used.
 */
function nativeLikeCryptography() {
  const used = new Set();
  const step = (name) => async (...args) => { used.add(name); return later(await sdkCryptography[name](...args)); };
  const plugIn = Object.fromEntries(CRYPTOGRAPHY_STEPS.filter((name) => name !== 'deriveKeys').map((name) => [name, step(name)]));
  plugIn.deriveKeys = async (seedHex, network) => {
    used.add('deriveKeys');
    const keys = sdkCryptography.deriveKeys(seedHex, network);
    const asText = (fn) => async (...args) => later(Buffer.from(fn(...args)).toString('hex')); // hex text, later
    return later({
      getIdCredSec: asText((...a) => keys.getIdCredSec(...a)),
      getPrfKey: asText((...a) => keys.getPrfKey(...a)),
      getSignatureBlindingRandomness: asText((...a) => keys.getSignatureBlindingRandomness(...a)),
      getAttributeCommitmentRandomness: asText((...a) => keys.getAttributeCommitmentRandomness(...a)),
      getAccountSigningKey: asText((...a) => keys.getAccountSigningKey(...a)),
      getAccountPublicKey: asText((...a) => keys.getAccountPublicKey(...a)),
      getCredentialId: asText((...a) => keys.getCredentialId(...a)),
    });
  };
  return { plugIn, used };
}

/** A wallet with this plug-in, answering the network from recordings; accounts in `onChain` exist. */
function wallet(cryptography, { onChain = [] } = {}) {
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => (url === CODE_URI
    ? { ok: true, status: 200, json: async () => issued() }
    : recorded.fetch(url, options));
  const node = recordedNode('testnet', { accountExists: (address) => onChain.includes(address) });
  return new ConcordiumIdentity(PHRASE, testnetConfig({ node }), { fetch, cryptography });
}

// Step 1.
test('the plug-in is checked: an unknown step, or a step that is not a function, is refused', () => {
  assert.throws(() => wallet({ makeCoffee: () => {} }), /cryptography has an unknown step "makeCoffee"/);
  assert.throws(() => wallet({ createIdentityRequestWithKeys: 'fast' }), /cryptography\.createIdentityRequestWithKeys must be a function/);
  assert.throws(() => wallet('native'), /cryptography must be an object/);
  assert.deepEqual(CRYPTOGRAPHY_STEPS.toSorted(), Object.keys(sdkCryptography).toSorted(), 'the SDK provides every step');
});

// Steps 2 and 3.
test('a whole journey goes through the plug-in, every step, and gives the same answers as the SDK alone', async () => {
  const { plugIn, used } = nativeLikeCryptography();
  const viaPlugIn = wallet(plugIn, { onChain: [] });
  const withSdk = wallet(undefined);

  // The identity request: built through the plug-in, the same key as with the SDK.
  const { issuanceUrl } = await viaPlugIn.createIdentityRequest({ providerIndex: 0, identityIndex: 7, redirectUri: RETURN });
  const { issuanceUrl: sdkUrl } = await withSdk.createIdentityRequest({ providerIndex: 0, identityIndex: 7, redirectUri: RETURN });
  const keyIn = (url) => JSON.parse(new URL(url).searchParams.get('state')).idObjectRequest.value.idCredPub;
  assert.equal(keyIn(issuanceUrl), keyIn(sdkUrl), 'the same public key in the request');

  // Collect (ownership + genuine), export, import (ownership + genuine again).
  await viaPlugIn.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  const kept = await viaPlugIn.exportIdentity(RECORDED);
  const restarted = wallet(plugIn, { onChain: [ACCOUNT_0] });
  assert.equal((await restarted.importIdentity(kept)).validTo, '202709');

  // An account: its credential built, signed and serialized through the plug-in.
  const account = await viaPlugIn.createAccount({ ...RECORDED, credNumber: 0 });
  assert.equal(account.address, ACCOUNT_0, 'the same address as the real testnet account');
  assert.equal(account.created, true);

  // A version 0 answer, from that account: accepted by a website's check against the account's record on chain.
  const question = requestFor({ providers: [0], adult: true });
  const answer = await restarted.prove({ ...RECORDED, credNumber: 0, ...question });
  const result = await checkPresentation(answer, question, { node: await pretendNode(), network: 'testnet' });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));

  assert.deepEqual([...used].toSorted(), CRYPTOGRAPHY_STEPS.toSorted(), 'every heavy step went through the plug-in');
  for (const w of [viaPlugIn, withSdk, restarted]) w.dispose();
});

// Step 4.
test('a plug-in may provide only some steps: the others stay with the SDK', async () => {
  let requests = 0;
  const onlyRequests = {
    createIdentityRequestWithKeys: async (input) => { requests++; return sdkCryptography.createIdentityRequestWithKeys(input); },
  };
  const w = wallet(onlyRequests);
  await w.createIdentityRequest({ providerIndex: 0, identityIndex: 7, redirectUri: RETURN });
  assert.equal(requests, 1, 'the plugged-in step was used');
  await w.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 }); // the other steps: the SDK's
  w.dispose();
});

// Step 5.
test("a phone plug-in that cannot check proofs says so: the signature check is skipped, and only that step may say it", async () => {
  assert.equal(SIGNATURE_CHECK_UNAVAILABLE, 'unavailable');
  assert.throws(() => wallet({ createPresentationV1: SIGNATURE_CHECK_UNAVAILABLE }), /cryptography\.createPresentationV1 must be a function/);

  let proofsBuilt = 0;
  const phone = {
    verifyPresentationV1: SIGNATURE_CHECK_UNAVAILABLE,
    createPresentationV1: async (...args) => { proofsBuilt++; return sdkCryptography.createPresentationV1(...args); },
  };
  const holder = wallet(phone);
  await holder.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 }); // a genuine identity: held
  const kept = await holder.exportIdentity(RECORDED);
  holder.dispose();

  // A changed detail is NOT refused on import here (the documented gap on phones): the chain and websites refuse it later.
  const changed = kept.replace('"firstName":"John"', '"firstName":"Jane"');
  const restarted = wallet(phone);
  assert.equal((await restarted.importIdentity(changed)).validTo, '202709');
  assert.equal(proofsBuilt, 0, 'no check proof was even built');
  restarted.dispose();
});
