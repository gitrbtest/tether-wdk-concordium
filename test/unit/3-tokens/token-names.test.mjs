/**
 * Unit — token-identifier routing (pure string logic, no network).
 * Proves the generic token API classifies a ref as PLT vs CIS-2 correctly,
 * which is what makes getTokenBalance / transfer / quoteTransfer dispatch to the
 * right backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenRef } from '../../../src/WalletAccountConcordium.js';

test('a bare symbol and the plt: prefix classify as PLT', () => {
  assert.deepEqual(parseTokenRef('USDT'), { kind: 'plt', symbol: 'USDT' });
  assert.deepEqual(parseTokenRef('plt:USDT'), { kind: 'plt', symbol: 'USDT' });
  assert.deepEqual(parseTokenRef('TN'), { kind: 'plt', symbol: 'TN' });
});

test('the cis2: prefix classifies as CIS-2 with parsed coordinates', () => {
  const r = parseTokenRef('cis2:12754:0:01');
  assert.equal(r.kind, 'cis2');
  assert.equal(r.index, 12754n);
  assert.equal(r.subindex, 0n);
  assert.equal(r.tokenId, '01');
});

test('a CIS-2 ref with an empty token id (single-token contract) parses', () => {
  const r = parseTokenRef('cis2:1234:0:');
  assert.equal(r.kind, 'cis2');
  assert.equal(r.index, 1234n);
  assert.equal(r.subindex, 0n);
  assert.equal(r.tokenId, '');
});

test('prefix matching is case-insensitive', () => {
  assert.equal(parseTokenRef('PLT:USDT').kind, 'plt');
  assert.equal(parseTokenRef('CIS2:1:0:aa').kind, 'cis2');
});
