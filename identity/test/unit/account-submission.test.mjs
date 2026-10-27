/**
 * Sending an account credential through the wallet-proxy and waiting until it is final
 * (src/account/submission.js), against a fake wallet-proxy: every way it can end. Nothing is sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitAndWait, accountCredentialBody } from '../../src/account/submission.js';
import WalletProxy from '../../src/providers/WalletProxy.js';
import { AccountCreationError } from '../../src/shared/errors.js';

const URL_ = 'https://wallet-proxy.example';

const HASH = 'ab'.repeat(32);

/** A test credential: always the same fake values, with `changes` applied on top (e.g. a past expiry). */
const testCredential = (changes = {}) => ({
  credInfo: { credId: 'c0ffee', proofs: '00' }, transactionHash: HASH, address: '3NewAccount',
  expiryEpochSeconds: Math.floor(Date.now() / 1000) + 600, ...changes,
});

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/**
 * A fake wallet-proxy behind a real WalletProxy. The real WalletProxy is given this fake `fetch` instead
 * of the network, so the code under test runs unchanged and only the answers are scripted.
 *
 * - `submit` answers the PUT (sending the credential). Either a response, e.g. json(400, {...}), or a
 *   function that is called instead, e.g. one that throws to simulate the network being down.
 *   Left out: the wallet-proxy accepts it.
 * - `statuses` answer the status checks, one per check, in order. [received, committed, finalized] plays
 *   the status changing over time; after "finalized" the code stops asking. If the code asks again after
 *   the list runs out (only when the last entry is not final), the last entry repeats: so [committed]
 *   means "committed forever" (used by the timeout and cancel tests). An entry is a body
 *   (sent as HTTP 200), a full response such as json(503), or an Error, which is thrown like a network
 *   failure. Left out: finalized with success at the first check.
 *
 * Returns the WalletProxy to test with, and `requests`: every call made, to check what was sent.
 */
function fakeWalletProxy({ submit = json(200, { submissionId: HASH }), statuses = [{ status: 'finalized', outcome: 'success', blockHashes: ['b1'] }] } = {}) {
  const requests = [];
  let next = 0; // which status answer comes next
  const fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) });
    if (options.method === 'PUT') return typeof submit === 'function' ? submit() : submit;
    // In order, one per check; never past the last entry, which then repeats.
    const answer = statuses[Math.min(next++, statuses.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer.ok === undefined ? json(200, answer) : answer; // a bare body becomes an HTTP 200 response
  };
  return { walletProxy: new WalletProxy({ walletProxyUrl: URL_ }, { fetch }), requests };
}

/** Runs the code under test against `fake`: a test credential (with any `credentialChanges`), checked every 1 ms; other options pass straight through (timeoutMs, intervalMs, signal). */
const run = (fake, { credentialChanges, ...options } = {}) =>
  submitAndWait({ walletProxy: fake.walletProxy, credential: testCredential(credentialChanges), intervalMs: 1, ...options });

const rejectsWith = (promise, reason, check = () => true) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof AccountCreationError, e.message);
  assert.equal(e.reason, reason, e.message);
  assert.equal(e.address, '3NewAccount');
  return check(e) !== false;
});

test('the credential is sent as the wallet-proxy takes it, then followed by its transaction hash', async () => {
  const fake = fakeWalletProxy();
  const cred = testCredential();
  await submitAndWait({ walletProxy: fake.walletProxy, credential: cred, intervalMs: 1 });
  assert.deepEqual(fake.requests[0], {
    url: `${URL_}/v0/submitCredential`, method: 'PUT',
    body: { v: 0, value: { credential: { type: 'normal', contents: cred.credInfo }, messageExpiry: cred.expiryEpochSeconds } },
  });
  assert.deepEqual(fake.requests[0].body, accountCredentialBody(cred.credInfo, cred.expiryEpochSeconds));
  assert.equal(fake.requests[1].url, `${URL_}/v0/submissionStatus/${HASH}`);
});

test('received, committed, then finalized with success: the account exists', async () => {
  const fake = fakeWalletProxy({ statuses: [
    { status: 'received' }, { status: 'committed', outcome: 'success' },
    { status: 'finalized', outcome: 'success', blockHashes: ['b9'] },
  ] });
  assert.deepEqual(await run(fake), { transactionHash: HASH, blockHash: 'b9' });
  assert.equal(fake.requests.length, 4);
});

test('the node refusing the credential is reported as rejected, with its words', async () => {
  const fake = fakeWalletProxy({ submit: json(400, { error: 1, errorMessage: 'Credential rejected by the node' }) });
  await rejectsWith(run(fake), 'rejected', (e) => e.detail === 'Credential rejected by the node');
  assert.equal(fake.requests.length, 1, 'nothing is followed after a refusal');
});

test('a credential finalized as rejected is reported with the chain\'s reason', async () => {
  const fake = fakeWalletProxy({ statuses: [{ status: 'finalized', outcome: 'reject', rejectReason: 'DuplicateCredIDs' }] });
  await rejectsWith(run(fake), 'rejected', (e) => e.detail === 'DuplicateCredIDs' && e.transactionHash === HASH);
});

test('a wallet-proxy failure when sending is reported as such', async () => {
  await rejectsWith(run(fakeWalletProxy({ submit: json(502, undefined) })), 'wallet-proxy', (e) => /502/.test(e.message));
  await rejectsWith(run(fakeWalletProxy({ submit: json(400, { error: 1, errorMessage: 'Parsing input failed' }) })),
    'wallet-proxy', (e) => e.detail === 'Parsing input failed');
  await rejectsWith(run(fakeWalletProxy({ submit: () => { throw new TypeError('fetch failed'); } })), 'wallet-proxy');
});

test('brief failures while waiting are retried; three in a row are reported', async () => {
  const blip = new TypeError('fetch failed');
  const done = { status: 'finalized', outcome: 'success', blockHashes: ['b1'] };
  assert.equal((await run(fakeWalletProxy({ statuses: [blip, json(503), done] }))).blockHash, 'b1');
  await rejectsWith(run(fakeWalletProxy({ statuses: [blip, json(503), blip] })), 'wallet-proxy');
});

test('an unexpected status is reported, not waited on', async () => {
  await rejectsWith(run(fakeWalletProxy({ statuses: [{ status: 'lost' }] })), 'wallet-proxy', (e) => /lost/.test(e.message));
});

test('absent before its expiry time is waited on; absent after it is reported as expired', async () => {
  const done = { status: 'finalized', outcome: 'success', blockHashes: ['b1'] };
  assert.equal((await run(fakeWalletProxy({ statuses: [{ status: 'absent' }, done] }))).blockHash, 'b1');
  const past = Math.floor(Date.now() / 1000) - 1;
  await rejectsWith(run(fakeWalletProxy({ statuses: [{ status: 'absent' }] }), { credentialChanges: { expiryEpochSeconds: past } }), 'expired');
});

test('still not final at the deadline: a timeout that says to ask again', async () => {
  // [committed] repeats forever, so the account never becomes final: checked every 5 ms, given up after 20 ms.
  await rejectsWith(run(fakeWalletProxy({ statuses: [{ status: 'committed', outcome: 'success' }] }), { timeoutMs: 20, intervalMs: 5 }),
    'timeout', (e) => /ask again/i.test(e.message));
});

test('cancelling stops the wait; cancelled before sending, nothing is sent', async () => {
  const before = fakeWalletProxy();
  await rejectsWith(run(before, { signal: AbortSignal.abort() }), 'cancelled');
  assert.equal(before.requests.length, 0);

  // [received] repeats forever, so the wait would never end by itself; cancelled after 30 ms instead,
  // like a user pressing Cancel (AbortController is the standard way to cancel in JavaScript).
  const during = fakeWalletProxy({ statuses: [{ status: 'received' }] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await rejectsWith(run(during, { signal: controller.signal, intervalMs: 5 }), 'cancelled', (e) => /may still be created/.test(e.message));
});
