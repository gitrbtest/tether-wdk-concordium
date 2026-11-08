/**
 * Integration — money-moving transfers (WRITE tests). All gated behind WRITE=1
 * since each broadcasts a real transaction and spends testnet fees. Transfers
 * are to self, so token balances are unchanged.
 * Run with:  WRITE=1 npm run test:integration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, ACCOUNT_PATH, KNOWN_ADDRESS, PLT_TOKEN, CIS2_TOKEN, RUN_WRITE } from '../helpers.mjs';

test('native CCD transfer to self returns a hash and fee (WRITE=1)', { skip: !RUN_WRITE }, async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const r = await a.sendTransaction({ to: KNOWN_ADDRESS, value: 1n });
  assert.match(r.hash, /^[0-9a-f]{64}$/i, 'expected a 64-hex transaction hash');
  assert.ok(r.fee > 0n, `expected a positive fee, got ${r.fee}`);
  m.dispose();
});

test('PLT transfer: quote equals the actual fee (WRITE=1)', { skip: !RUN_WRITE }, async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const q = await a.quoteTransfer({ token: PLT_TOKEN, recipient: KNOWN_ADDRESS, amount: 1n });
  const r = await a.transfer({ token: PLT_TOKEN, recipient: KNOWN_ADDRESS, amount: 1n });
  assert.match(r.hash, /^[0-9a-f]{64}$/i);
  assert.equal(q.fee, r.fee, 'PLT quote should equal the actual fee');
  m.dispose();
});

test('CIS-2 transfer: quote equals the actual fee (WRITE=1)', { skip: !RUN_WRITE }, async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  const q = await a.quoteTransfer({ token: CIS2_TOKEN, recipient: KNOWN_ADDRESS, amount: 1n });
  const r = await a.transfer({ token: CIS2_TOKEN, recipient: KNOWN_ADDRESS, amount: 1n });
  assert.match(r.hash, /^[0-9a-f]{64}$/i);
  assert.equal(q.fee, r.fee, 'CIS-2 quote should equal the actual fee');
  m.dispose();
});
