/** ConcordiumIdentity disposal removes the seed; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { walletProxyFetch } from '../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('dispose zeroes the seed bytes and drops them', () => {
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  const seed = identity._seed;
  assert.ok(seed.some((byte) => byte !== 0), 'the seed starts out non-zero');

  identity.dispose();
  assert.equal(identity._seed, undefined);
  assert.ok(seed.every((byte) => byte === 0), 'the bytes that held the seed are now zero');
});

test('disposed reports whether dispose has been called', () => {
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  assert.equal(identity.disposed, false);
  identity.dispose();
  assert.equal(identity.disposed, true);
});

test('a disposed identity refuses to start verification, before any request', async () => {
  const { fetch, requests } = walletProxyFetch('testnet');
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch });
  identity.dispose();
  await assert.rejects(
    () => identity.createIdentityRequest({ providerIndex: 0, redirectUri: 'https://wallet.example/return' }),
    /This identity has been disposed/,
  );
  assert.deepEqual(requests, []);
});

test('keys cannot be derived after dispose', () => {
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  identity.dispose();
  assert.throws(() => identity._hdWallet, /This identity has been disposed/);
});

test('disposing twice is harmless', () => {
  const identity = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  identity.dispose();
  identity.dispose();
  assert.equal(identity.disposed, true);
});
