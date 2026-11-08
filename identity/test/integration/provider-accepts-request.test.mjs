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
 *
 * The same for a company: Global FinReg (testnet provider 4, a Business ID provider, in the /v2/ip_info list) serves
 * its company verification page. Completing a Business ID needs a real company (Global FinReg has no test mode).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ConcordiumIdentity, IdentityProviders, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { checkProvider } from '../../scripts/lib/provider-check.mjs';
import { liveTestnetConfig } from '../helpers.mjs';

const CONCORDIUM_TESTNET_IP = 0;
const GLOBAL_FINREG_TESTNET = 4; // Business ID

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

// Steps 1-3, for a company.
test('the Global FinReg testnet provider (Business ID) accepts our identity request and opens its company page', async () => {
  const config = await liveTestnetConfig();
  const identity = new ConcordiumIdentity(randomBytes(64), config);
  try {
    const provider = (await new IdentityProviders(config.identityProviders).list()).find((p) => p.index === GLOBAL_FINREG_TESTNET);
    assert.equal(provider?.kind, 'company', 'Global FinReg is recognised as a Business ID provider');
    const result = await checkProvider(identity, GLOBAL_FINREG_TESTNET);
    assert.equal(result.outcome, 'accepted', `${result.outcome}: ${result.detail}`);
  } finally {
    identity.dispose();
  }
});
