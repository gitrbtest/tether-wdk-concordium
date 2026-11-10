/**
 * Provider, identity and account numbers within Concordium's ranges; no external services. Outside them,
 * Concordium's SDK does not refuse every number: it silently reduces some (identity 4294967297 gives identity 1's
 * keys), so the package refuses them first, with a clear message, before building anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ConcordiumIdentity from '../../../src/ConcordiumIdentity.js';
import { requireIndex, MAX_KEY_INDEX, MAX_CRED_NUMBER } from '../../../src/shared/inputs.js';
import { testnetConfig, walletWithRecordedIdentity, RECORDED_IDENTITY } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RETURN = 'https://wallet.example/identity/return';

test('the limits: provider and identity numbers up to 2147483647, account numbers up to 255', () => {
  assert.equal(MAX_KEY_INDEX, 2147483647);
  assert.equal(MAX_CRED_NUMBER, 255);
  requireIndex(MAX_KEY_INDEX, 'identityIndex');
  requireIndex(MAX_CRED_NUMBER, 'credNumber', undefined, MAX_CRED_NUMBER);
  assert.throws(() => requireIndex(MAX_KEY_INDEX + 1, 'identityIndex'), /identityIndex must be at most 2147483647/);
  assert.throws(() => requireIndex(MAX_CRED_NUMBER + 1, 'credNumber', undefined, MAX_CRED_NUMBER), /credNumber must be at most 255/);
});

test('an identity request for a number the SDK would reduce is refused, not built with another identity\'s keys', async () => {
  const identity = new ConcordiumIdentity(PHRASE, testnetConfig());
  for (const identityIndex of [2 ** 31, 2 ** 32 + 1]) {
    await assert.rejects(() => identity.createIdentityRequest({ providerIndex: 0, identityIndex, redirectUri: RETURN }),
      /identityIndex must be at most 2147483647/);
  }
  await assert.rejects(() => identity.createIdentityRequest({ providerIndex: 2 ** 31, identityIndex: 0, redirectUri: RETURN }),
    /providerIndex must be at most 2147483647/);
  identity.dispose();
});

test('an account or a proof for an account number above 255 is refused before anything is built or sent', async () => {
  const wallet = await walletWithRecordedIdentity();
  await assert.rejects(() => wallet.createAccount({ ...RECORDED_IDENTITY, credNumber: 256 }), /credNumber must be at most 255/);
  await assert.rejects(() => wallet.prove({ ...RECORDED_IDENTITY, credNumber: 271, challenge: 'ab'.repeat(32), credentialStatements: [] }),
    /credNumber must be at most 255/);
  wallet.dispose();
});
