/**
 * Integration — fee quotes against the live testnet node (read-only; no broadcast).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, ACCOUNT_PATH, KNOWN_ADDRESS, PLT_TOKEN, CIS2_TOKEN } from '../helpers.mjs';

test('quoteSendTransaction returns a positive CCD fee', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const { fee } = await a.quoteSendTransaction({ to: KNOWN_ADDRESS, value: 1n });
  assert.equal(typeof fee, 'bigint');
  assert.ok(fee > 0n, `expected > 0, got ${fee}`);
  m.dispose();
});

test('quoteTransfer returns a positive fee for a PLT transfer', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const { fee } = await a.quoteTransfer({ token: PLT_TOKEN, recipient: KNOWN_ADDRESS, amount: 1n });
  assert.ok(fee > 0n, `expected > 0, got ${fee}`);
  m.dispose();
});

test('quoteTransfer returns a positive fee for a CIS-2 transfer', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const { fee } = await a.quoteTransfer({ token: CIS2_TOKEN, recipient: KNOWN_ADDRESS, amount: 1n });
  assert.ok(fee > 0n, `expected > 0, got ${fee}`);
  m.dispose();
});
