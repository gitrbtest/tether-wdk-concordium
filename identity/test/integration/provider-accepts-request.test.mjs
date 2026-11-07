/**
 * Live (testnet): the Concordium testnet identity provider accepts an identity
 * request built by this package and serves its verification page. Uses a fresh
 * random seed; nothing is filled in and no identity is issued.
 *
 * Run with `npm run test:integration`; not part of `npm test` or CI.
 *
 * Who is who:
 *   WALLET     a brand-new person: a fresh random seed, no identity yet
 *   PROVIDER   Concordium's testnet identity provider (provider 0)
 *
 *   WALLET (new person)                     PROVIDER 0
 *   ───────────────────                     ──────────
 *   1. createIdentityRequest: the request
 *      for identity 0, from the seed
 *   2. opens the provider's issuance address
 *      with the request ───────────────────► checks the request (follows its redirects)
 *   3.                    ◄───────────────── serves its verification page: accepted
 *      (a person would now verify there; nothing is filled in, no identity is issued)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { checkProvider } from '../../scripts/lib/provider-check.mjs';
import { liveTestnetConfig } from '../helpers.mjs';

const CONCORDIUM_TESTNET_IP = 0;

// Steps 1-3 (by scripts/lib/provider-check.mjs, which `npm run check:providers` also uses).
test('the Concordium testnet identity provider accepts our identity request', async () => {
  const identity = new ConcordiumIdentity(randomBytes(64), await liveTestnetConfig());
  try {
    const result = await checkProvider(identity, CONCORDIUM_TESTNET_IP);
    assert.equal(result.outcome, 'accepted', `${result.outcome}: ${result.detail}`);
  } finally {
    identity.dispose();
  }
});
