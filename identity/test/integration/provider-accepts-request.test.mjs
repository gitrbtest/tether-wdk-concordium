/**
 * Live (testnet): the Concordium testnet identity provider accepts an identity
 * request built by this package and serves its verification page. Uses a fresh
 * random seed; nothing is filled in and no identity is issued.
 *
 * Run with `npm run test:integration`; not part of `npm test` or CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { checkProvider } from '../../scripts/lib/provider-check.mjs';

const CONCORDIUM_TESTNET_IP = 0;

test('the Concordium testnet identity provider accepts our identity request', async () => {
  const identity = new ConcordiumIdentity(randomBytes(64), CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  try {
    const result = await checkProvider(identity, CONCORDIUM_TESTNET_IP);
    assert.equal(result.outcome, 'accepted', `${result.outcome}: ${result.detail}`);
  } finally {
    identity.dispose();
  }
});
