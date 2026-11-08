/**
 * Live (testnet), read-only: recovery against the real Concordium testnet identity provider and testnet node.
 * It tells us if the provider ever changes how recovery works. Nothing is sent to the chain and nothing is
 * spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * The identity is the one recorded in test/fixtures: the public "abandon" test phrase, provider 0, identity
 * index 334563111, issued by the Concordium testnet identity provider in Phase 1. Its account 0 was created
 * on testnet and is known.
 *
 * Who is who:
 *   WALLET     a "new phone": only the seed phrase
 *   PROVIDER   Concordium's testnet identity provider (provider 0), which keeps the identities it issued
 *   NODE       Concordium's public testnet node, for finding the identity's accounts
 *
 *   WALLET (new phone)                      PROVIDER 0                            NODE / TESTNET CHAIN
 *   ──────────────────                      ──────────                            ────────────────────
 *   1. recoverIdentity(334563111) ─────────► "here is the identity issued
 *      (a request only these keys can make)  to these keys"
 *      the same identity as recorded ✔
 *   2. exportIdentity; a new wallet object imports it back (an app restart)
 *   3. findAccounts: account 0? 1? … ───────────────────────────────────────────► account 0 exists: 3Z4Wk…B5t
 *   4. recoverIdentity(334563110), never issued ─► "none" → null
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { liveTestnetConfig } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t';
const recorded = () => JSON.parse(readFileSync(new URL('../../fixtures/identity-done.testnet.json', import.meta.url), 'utf8')).token.identityObject;

// Steps 1-3. Read-only.
test('recovery: the recorded identity comes back from the testnet provider, with its account 0', async () => {
  const identity = new ConcordiumIdentity(PHRASE, await liveTestnetConfig()); // a new phone: only the seed
  try {
    const summary = await identity.recoverIdentity(RECORDED);
    assert.ok(summary, 'the provider returned the identity');
    const issued = recorded().value.attributeList;
    assert.deepEqual(summary, {
      ...RECORDED, createdAt: issued.createdAt, validTo: issued.validTo, maxAccounts: issued.maxAccounts,
    }, 'the same identity as the one recorded when it was issued');

    // Held, so it can be exported, and a new wallet object imports it back.
    const kept = await identity.exportIdentity(RECORDED);
    const restarted = new ConcordiumIdentity(PHRASE, await liveTestnetConfig());
    assert.deepEqual(await restarted.importIdentity(kept), summary);
    restarted.dispose();

    const accounts = await identity.findAccounts(RECORDED);
    assert.deepEqual(accounts[0], { credNumber: 0, address: ACCOUNT_0, path: '0/334563111/0' });
  } finally {
    identity.dispose();
  }
});

// Step 4. Read-only.
test('recovery: an identity number never issued for this seed comes back as null', async () => {
  const identity = new ConcordiumIdentity(PHRASE, await liveTestnetConfig());
  try {
    // 334563110: one below the recorded identity; never issued for this phrase (checked 2 Nov 2026).
    assert.equal(await identity.recoverIdentity({ providerIndex: 0, identityIndex: 334563110 }), null);
  } finally {
    identity.dispose();
  }
});
