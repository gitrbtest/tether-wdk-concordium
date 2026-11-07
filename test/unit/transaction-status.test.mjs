/**
 * Transaction status the WDK way: getTransaction translates the Concordium node's status into WDK's standard receipt,
 * and WDK's own waitForTransaction (from the base package) builds on it. Offline: a pretend node answers the status
 * questions from a script.
 *
 *   Concordium node says                WDK receipt
 *   ────────────────────                ───────────
 *   received                       ───► finality 'pending'
 *   committed (in a block, not final) ► finality 'pending'
 *   finalized, outcome ok          ───► finality 'final', success true,  fee, block, blockHash
 *   finalized, outcome rejected    ───► finality 'final', success false, fee (still charged)
 *   not known                      ───► NoSuchElementError (WDK: waitForTransaction keeps asking, then TimeoutError)
 *   cannot be asked                ───► ProviderError      (WDK: waitForTransaction tries again, up to 3 in a row)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@concordium/web-sdk';
import { NoSuchElementError, ProviderError, TimeoutError, ValueError } from '@tetherto/wdk-wallet';
import { testAccount } from '../token-chain.mjs';

const HASH = '5e'.repeat(32);
const BLOCK = 'b5'.repeat(32);
const notFound = () => Object.assign(new Error('transaction not found'), { name: 'RpcError', code: 'NOT_FOUND' });
const down = () => Object.assign(new Error('connection refused'), { name: 'RpcError', code: 'UNAVAILABLE' });
const finalized = (summary) => ({ status: 'finalized', outcome: { blockHash: sdk.BlockHash.fromHexString(BLOCK), summary } });
const ok = { type: 'accountTransaction', transactionType: 'transfer', cost: sdk.CcdAmount.fromMicroCcd(3792510n) };

/** A pretend node answering getBlockItemStatus with `statuses`, one per question (the last repeats). */
function statusNode(statuses) {
  const node = {
    asked: 0,
    async getBlockItemStatus() {
      const answer = statuses[Math.min(node.asked++, statuses.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async getBlockInfo() { return { blockHeight: 50504314n }; },
  };
  return node;
}

async function receipt(statuses) {
  const { account, dispose } = await testAccount(statusNode(statuses));
  try { return await account.getTransaction(HASH); } finally { dispose(); }
}

test('getTransaction: received and committed are pending; final has success, fee, block and blockHash', async () => {
  assert.deepEqual(await receipt([{ status: 'received' }]), { hash: HASH, finality: 'pending' });
  assert.deepEqual(await receipt([{ status: 'committed', outcomes: [] }]), { hash: HASH, finality: 'pending' });
  assert.deepEqual(await receipt([finalized(ok)]), {
    hash: HASH, finality: 'final', success: true, block: 50504314, fee: 3792510n, blockHash: BLOCK,
  });
});

test('getTransaction: a rejected transaction is final with success false, and its fee (still charged)', async () => {
  const rejected = { type: 'accountTransaction', transactionType: 'failed', rejectReason: { tag: 'OutOfEnergy' }, cost: sdk.CcdAmount.fromMicroCcd(1200n) };
  const r = await receipt([finalized(rejected)]);
  assert.deepEqual([r.finality, r.success, r.fee], ['final', false, 1200n]);
});

test('getTransaction: a sponsored transaction\'s fee is what the sponsor paid', async () => {
  const sponsored = { ...ok, cost: 0n, sponsor: { cost: sdk.CcdAmount.fromMicroCcd(4980981n), sponsor: 'x' } };
  assert.equal((await receipt([finalized(sponsored)])).fee, 4980981n);
});

test('getTransaction: unknown: NoSuchElementError; the node down: ProviderError; not a hash: ValueError', async () => {
  await assert.rejects(receipt([notFound()]), NoSuchElementError);
  await assert.rejects(receipt([down()]), (e) => e instanceof ProviderError && /connection refused/.test(e.message));
  const { account, dispose } = await testAccount(statusNode([]));
  await assert.rejects(account.getTransaction('abc'), ValueError);
  dispose();
});

test('waitForTransaction (WDK\'s own): pending, pending, then final; a brief node failure is tried again', async () => {
  const node = statusNode([{ status: 'received' }, down(), { status: 'committed', outcomes: [] }, finalized(ok)]);
  const { account, dispose } = await testAccount(node);
  try {
    const r = await account.waitForTransaction(HASH, { interval: 1 });
    assert.deepEqual([r.finality, r.success], ['final', true]);
    assert.equal(node.asked, 4);
    assert.equal(account.defaultWaitInterval, 2000, 'asks every 2 seconds by default (a Concordium block)');
  } finally {
    dispose();
  }
});

test('waitForTransaction: a transaction that never lands (unknown to the node) ends with TimeoutError', async () => {
  const { account, dispose } = await testAccount(statusNode([notFound()]));
  try {
    await assert.rejects(account.waitForTransaction(HASH, { interval: 1, timeout: 30 }), TimeoutError);
  } finally {
    dispose();
  }
});
