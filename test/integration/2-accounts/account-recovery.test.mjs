/**
 * Integration — single-identity credential-based recovery through the node
 * (read-only; no broadcast).
 * Run with:  npm run test:integration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, IDENTITY_COORDINATES, KNOWN_ADDRESS } from '../helpers.mjs';

test('recoverAccountsForIdentity finds the known account through credential-ID lookup', async () => {
  const m = makeManager();
  const found = await m.recoverAccountsForIdentity({ ...IDENTITY_COORDINATES, gapLimit: 3, maxIndex: 10 });
  const addresses = await Promise.all(found.map((account) => account.getAddress()));
  assert.ok(
    addresses.includes(KNOWN_ADDRESS),
    `expected ${KNOWN_ADDRESS} among recovered ${JSON.stringify(addresses)}`
  );
  m.dispose();
});
