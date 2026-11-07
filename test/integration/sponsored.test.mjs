/**
 * Integration — sponsored transactions.
 * Construction (build + all four sign methods) always runs; the actual on-chain
 * submission is a WRITE test, gated behind WRITE=1 (it spends a sponsor fee).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, ACCOUNT_PATH, KNOWN_ADDRESS, PLT_TOKEN, RUN_WRITE, submissionStatus } from './helpers.mjs';
import { ConcordiumTransferError } from '../../index.js';

const sponsorable = (a) => a.buildSponsorableTransfer({
  token: PLT_TOKEN, recipient: KNOWN_ADDRESS, amount: 1n, sponsorAddress: KNOWN_ADDRESS,
});

test('build + all four sign methods produce signable JSON, in both orders', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);

  // Order A: sponsor first (3 -> 2)
  let txA = await sponsorable(a);
  txA = await a.signAsSponsorToBeSigned(txA);   // (3)
  txA = await a.signAsAccountPreSponsored(txA);  // (2)
  assert.ok(txA && typeof txA === 'object', 'order A produced a fully-signed signable');

  // Order B: account first (1 -> 4)
  let txB = await sponsorable(a);
  txB = await a.signAsAccountToBeSponsored(txB);  // (1)
  txB = await a.signAsSponsorSigned(txB);         // (4)
  assert.ok(txB && typeof txB === 'object', 'order B produced a fully-signed signable');

  m.dispose();
});

test('sponsored submission finalizes with outcome: success (WRITE=1)', { skip: !RUN_WRITE }, async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  let tx = await sponsorable(a);
  tx = await a.signAsSponsorToBeSigned(tx);
  tx = await a.signAsAccountPreSponsored(tx);
  const { hash } = await a.submitSponsored(tx);
  const status = await submissionStatus(hash);
  assert.equal(status.outcome, 'success', `expected success, got ${status.outcome} (${status.rejectReason || ''})`);
  m.dispose();
});

test('buildSponsorableTransfer refuses a transfer of an unheld token before anything is built (nothing sent, no fee)', async () => {
  const m = makeManager();
  const a = await m.getAccountByPath(ACCOUNT_PATH);
  // USDT exists on testnet but this account holds none: the transfer is refused before it is built, so it is never
  // sent and the sponsor is not charged (it used to be sent and rejected on chain, the sponsor still paying the fee).
  await assert.rejects(
    () => a.buildSponsorableTransfer({ token: 'USDT', recipient: KNOWN_ADDRESS, amount: 1n, sponsorAddress: KNOWN_ADDRESS }),
    (e) => e instanceof ConcordiumTransferError && e.reason === 'INSUFFICIENT_TOKEN_BALANCE' && e.hash === null,
  );
  m.dispose();
});
