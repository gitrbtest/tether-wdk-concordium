/**
 * Sending an account credential through the wallet's node connection and waiting until it is final
 * (src/account/submission.js, through src/chain/ChainNode.js), against a pretend node: every way it can end.
 * Nothing is sent.
 *
 * Every way sending can end:
 *
 *   1. send the credential to the node ──► refused (e.g. invalid credential) ......... rejected, nothing followed
 *                                      ──► the node cannot be asked ................... node
 *                                      ──► accepted: its transaction hash ↓
 *   2. follow it (ask the node's status, again and again):
 *        unknown to the node ............. before its expiry time: wait; after it: expired
 *        received → committed ............ wait
 *        finalized, account created ...... done: the account exists
 *        finalized, no account created ... rejected
 *        an answer not known ............. node (reported, not waited on)
 *        a check fails ................... tried again; 3 in a row: node
 *   3. at any time: the deadline passes .. timeout ("ask again"); cancelled .......... cancelled
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitAndWait } from '../../../src/account/submission.js';
import ChainNode from '../../../src/chain/ChainNode.js';
import { AccountCreationError } from '../../../src/shared/errors.js';
import { recordedNode, nodeStatus } from '../../helpers.mjs';

const HASH = 'ab'.repeat(32);

/** A test credential: always the same fake values, with `changes` applied on top (e.g. a past expiry). */
const testCredential = (changes = {}) => ({
  payload: new Uint8Array([1, 2, 3]), expiry: { expiryEpochSeconds: 0n }, transactionHash: HASH, address: '3NewAccount',
  expiryEpochSeconds: Math.floor(Date.now() / 1000) + 600, ...changes,
});

/** A gRPC error as the SDK's node client throws it, e.g. a refusal (INVALID_ARGUMENT) or the node down (UNAVAILABLE). */
const rpcError = (code, message) => Object.assign(new Error(message), { name: 'RpcError', code });

/**
 * A pretend node (see recordedNode in helpers.mjs: `send` scripts the sending, `statuses` the status checks, in order,
 * the last repeating) behind the real ChainNode, so the code under test runs unchanged and only the answers are scripted.
 */
function pretend(options) {
  const client = recordedNode('testnet', options);
  return { client, node: new ChainNode(client) };
}

/** Runs the code under test: a test credential (with any `credentialChanges`), checked every 1 ms. */
const run = (fake, { credentialChanges, ...options } = {}) =>
  submitAndWait({ node: fake.node, credential: testCredential(credentialChanges), intervalMs: 1, ...options });

const rejectsWith = (promise, reason, check = () => true) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof AccountCreationError, e.message);
  assert.equal(e.reason, reason, e.message);
  assert.equal(e.address, '3NewAccount');
  return check(e) !== false;
});

// Steps 1-2: what is sent, and followed.
test('the credential is sent to the node as its bytes and expiry, then followed by its transaction hash', async () => {
  const fake = pretend();
  const cred = testCredential();
  assert.deepEqual(await submitAndWait({ node: fake.node, credential: cred, intervalMs: 1 }),
    { transactionHash: HASH, blockHash: 'b1'.repeat(32) });
  assert.equal(fake.client.sent.length, 1);
  assert.equal(fake.client.sent[0].payload, cred.payload);
  assert.equal(fake.client.sent[0].expiry, cred.expiry);
  assert.equal(fake.client.statusCalls, 1);
});

// Step 2: the usual path, to "done".
test('received, committed, then finalized with the account created: the account exists', async () => {
  const fake = pretend({ statuses: [nodeStatus.received(), nodeStatus.committed(), nodeStatus.finalized('b9'.repeat(32))] });
  assert.deepEqual(await run(fake), { transactionHash: HASH, blockHash: 'b9'.repeat(32) });
  assert.equal(fake.client.statusCalls, 3);
});

// Step 1: refused.
test('the node refusing the credential is reported as rejected, with its words; nothing is followed', async () => {
  const fake = pretend({ send: rpcError('INVALID_ARGUMENT', 'Credential deployment rejected: duplicate credential id') });
  await rejectsWith(run(fake), 'rejected', (e) => /duplicate credential id/.test(e.detail));
  assert.equal(fake.client.statusCalls, 0, 'nothing is followed after a refusal');
});

// Step 2: finalized, no account.
test('finalized without creating an account is reported as rejected', async () => {
  const fake = pretend({ statuses: [nodeStatus.finalized('b1'.repeat(32), 'update')] });
  await rejectsWith(run(fake), 'rejected', (e) => /finalized as update/.test(e.detail) && e.transactionHash === HASH);
});

// Step 1: the node down.
test('a node that cannot be asked when sending is reported as reason node', async () => {
  await rejectsWith(run(pretend({ send: rpcError('UNAVAILABLE', 'connection refused') })), 'node', (e) => /connection refused/.test(e.message));
  await rejectsWith(run(pretend({ send: new TypeError('fetch failed') })), 'node');
});

// Step 2: a check fails.
test('brief failures while waiting are retried; three in a row are reported', async () => {
  const blip = rpcError('UNAVAILABLE', 'connection reset');
  assert.equal((await run(pretend({ statuses: [blip, blip, nodeStatus.finalized()] }))).blockHash, 'b1'.repeat(32));
  await rejectsWith(run(pretend({ statuses: [blip, blip, blip] })), 'node', (e) => /connection reset/.test(e.message));
});

// Step 2: an answer not known.
test('an unexpected status is reported, not waited on', async () => {
  await rejectsWith(run(pretend({ statuses: [{ status: 'lost' }, nodeStatus.finalized()] })), 'node');
});

// Step 2: unknown to the node.
test('unknown to the node before its expiry time is waited on; after it, reported as expired', async () => {
  assert.equal((await run(pretend({ statuses: ['absent', nodeStatus.finalized()] }))).blockHash, 'b1'.repeat(32));
  const past = Math.floor(Date.now() / 1000) - 1;
  await rejectsWith(run(pretend({ statuses: ['absent'] }), { credentialChanges: { expiryEpochSeconds: past } }), 'expired');
});

// Step 3: the deadline.
test('still not final at the deadline: a timeout that says to ask again', async () => {
  // [committed] repeats forever, so the account never becomes final: checked every 5 ms, given up after 20 ms.
  await rejectsWith(run(pretend({ statuses: [nodeStatus.committed()] }), { timeoutMs: 20, intervalMs: 5 }),
    'timeout', (e) => /ask again/i.test(e.message));
});

// Step 3: cancelled.
test('cancelling stops the wait; cancelled before sending, nothing is sent', async () => {
  const before = pretend();
  await rejectsWith(run(before, { signal: AbortSignal.abort() }), 'cancelled');
  assert.equal(before.client.sent.length, 0);

  // [received] repeats forever, so the wait would never end by itself; cancelled after 30 ms instead.
  const during = pretend({ statuses: [nodeStatus.received()] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await rejectsWith(run(during, { signal: controller.signal, intervalMs: 5 }), 'cancelled', (e) => /may still be created/.test(e.message));
});
