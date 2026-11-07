/**
 * Live (testnet), read-only: a website checks a wallet's proof against the real Concordium testnet chain. It tells
 * us if the chain ever stops giving what checking needs (the account's sealed details and the identity's validity).
 * Nothing is sent to the chain and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * The wallet holds the recorded identity (public "abandon" test phrase, provider 0, identity 334563111) and answers
 * with its account 0, which is on testnet.
 *
 * Who is who:
 *   SHOP       the website asking (played by the test): version 0 needs no account and no fee
 *   WALLET     identity 334563111 (test person John Doe: born 1970, lives in DK), answering with its account 0,
 *              3Z4Wk…B5t
 *   PROVIDER   Concordium's testnet identity provider (provider 0), which issued the identity
 *
 *   SHOP                          WALLET                               PROVIDER 0 / TESTNET CHAIN
 *   ────                          ──────                               ──────────────────────────
 *                                 1. collects its identity ──────────► provider 0 (waitForIdentity)
 *   2. requestFor: "over 18?
 *      show country of residence"
 *      (a fresh random challenge)
 *      sends the question ──────► 3. prove: answers with account 0
 *                                    (date of birth not shown)
 *   4. checkPresentation ◄─────── the answer
 *      reads account 0's sealed details and validity ────────────────► chain
 *      accepted: account 0, country DK
 *   5. the same answer, checked against another question (another challenge): refused
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { requestFor, checkPresentation, connectToNode } from '@concordium/wdk-identity-concordium/verify';
import { liveTestnetConfig } from '../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t';
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';

// Steps 1-5: the whole story, once. Read-only.
test('checkPresentation: the testnet chain accepts a true "over 18" answer from account 0, and refuses a copy for another request', async () => {
  const wallet = new ConcordiumIdentity(PHRASE, await liveTestnetConfig());
  try {
    // The identity, collected live from the provider as a wallet would (it was issued in Phase 1).
    await wallet.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
    const node = connectToNode('testnet');
    const request = requestFor({ providers: [0, 1, 2], adult: true, reveal: ['countryOfResidence'] });
    const answer = await wallet.prove({ ...RECORDED, credNumber: 0, ...request });

    const result = await checkPresentation(answer, request, { node, network: 'testnet' });
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    assert.equal(result.account, ACCOUNT_0);
    assert.deepEqual(result.revealed, { countryOfResidence: 'DK' });

    const another = requestFor({ providers: [0, 1, 2], adult: true, reveal: ['countryOfResidence'] });
    const copied = await checkPresentation(answer, another, { node, network: 'testnet' });
    assert.deepEqual(copied.reasons.map((r) => r.reason), ['challenge-mismatch']);
  } finally {
    wallet.dispose();
  }
});
