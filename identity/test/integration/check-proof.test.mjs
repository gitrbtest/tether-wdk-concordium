/**
 * Live (testnet), read-only: a website checks a wallet's proof against the real Concordium testnet chain. It tells
 * us if the chain ever stops giving what checking needs (the account's sealed details and the identity's validity).
 * Nothing is sent to the chain and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * The wallet holds the recorded identity (public "abandon" test phrase, provider 0, identity 334563111) and answers
 * with its account 0, which is on testnet.
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
