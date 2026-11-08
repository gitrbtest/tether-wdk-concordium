/**
 * Integration — transaction status, the WDK way, from the live testnet node. Read-only.
 * Run with:  npm run test:integration   (needs network and the TESTNET_ settings, as the other live tests)
 *
 * Two real testnet transactions (recorded in the internal testnet ledger, 7 Nov 2026):
 *   TOP_UP   a CCD transfer of 100 CCD to account 11 of the public test phrase's identity 334563111 (fee 3.79251 CCD)
 *   ANCHOR   the version 1 question kept in identity/test/fixtures/v1-question.testnet.json: a sponsored registerData
 *            (the sponsor paid 4.980981 CCD; the sender paid nothing)
 *
 *   WALLET                                  TESTNET NODE
 *   ──────                                  ────────────
 *   getTransaction(TOP_UP) ────────────────► finalized → { finality: 'final', success: true, fee, block, blockHash }
 *   getTransaction(ANCHOR) ────────────────► finalized, sponsored → fee: what the sponsor paid
 *   waitForTransaction(ANCHOR) (WDK's own) ► already final → returns at once
 *   getTransaction(unknown) ───────────────► not found → NoSuchElementError
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoSuchElementError } from '@tetherto/wdk-wallet';
import { makeManager, ACCOUNT_PATH } from '../helpers.mjs';

const TOP_UP = 'd5e402bd149f56d9340b916b31156878bb671e289688c342f638adabce77173d';
const ANCHOR = 'e567f76ce49a0a214009e56f7378d5bf2341a939529c8bef45bdd75c84f5bfb9';

test('transaction status on testnet: final receipts in WDK\'s words; an unknown hash is NoSuchElementError', async () => {
  const m = makeManager();
  try {
    const a = await m.getAccountByPath(ACCOUNT_PATH);
    const topUp = await a.getTransaction(TOP_UP);
    assert.deepEqual([topUp.finality, topUp.success, topUp.fee], ['final', true, 3792510n]);
    assert.ok(topUp.block > 50_000_000, 'the block height');
    assert.match(topUp.blockHash, /^[0-9a-f]{64}$/);

    const anchor = await a.waitForTransaction(ANCHOR);
    assert.deepEqual([anchor.finality, anchor.success, anchor.fee], ['final', true, 4980981n], 'the sponsor\'s fee');

    await assert.rejects(a.getTransaction('ab'.repeat(32)), NoSuchElementError);
  } finally {
    m.dispose();
  }
});
