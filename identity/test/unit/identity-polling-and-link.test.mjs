/**
 * The two helpers ConcordiumIdentity uses: pollIdentityProvider (patient polling of the code_uri) and
 * issuanceLink (the verification link). Tested on their own here; the identity tests cover them through
 * waitForIdentity and createIdentityRequest. No external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityIssuanceError } from '@concordium/wdk-identity-concordium';
import { pollIdentityProvider } from '../../src/identity-polling.js';
import { issuanceLink } from '../../src/identity-request.js';

const URL_ = 'https://id-service.testnet.concordium.com/api/v1/identity/abc';

/** A fetch that answers each poll from `answers` in order (the last repeats); an Error is a network failure. */
function scripted(answers) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, signal: options?.signal });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    if (answer.httpStatus) return { ok: false, status: answer.httpStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  };
  return { fetch, calls };
}
const poll = (fetch, extra = {}) => pollIdentityProvider({ fetch, url: URL_, timeoutMs: 1000, intervalMs: 1, ...extra });

test('returns the provider\'s final answer, done or error, after any pending ones', async () => {
  const done = scripted([{ status: 'pending' }, { status: 'done', token: { identityObject: {} } }]);
  assert.equal((await poll(done.fetch)).status, 'done');
  assert.equal(done.calls.length, 2);
  assert.equal(done.calls[0].url, URL_);

  const refused = scripted([{ status: 'error', detail: 'Identity object has failed' }]);
  assert.deepEqual(await poll(refused.fetch), { status: 'error', detail: 'Identity object has failed' });
});

test('brief failures are retried; three in a row are reported', async () => {
  const brief = scripted([new Error('ECONNRESET'), { httpStatus: 503 }, { status: 'done' }]);
  assert.equal((await poll(brief.fetch)).status, 'done');
  const repeated = scripted([new Error('ECONNRESET'), { httpStatus: 503 }, new Error('ETIMEDOUT')]);
  await assert.rejects(() => poll(repeated.fetch), /ETIMEDOUT/);
});

test('an unexpected status, a timeout and a cancel are reported clearly', async () => {
  await assert.rejects(() => poll(scripted([{ status: 'processing' }]).fetch), /unexpected status: "processing"/);
  await assert.rejects(() => poll(scripted([{ status: 'pending' }]).fetch, { timeoutMs: 20, intervalMs: 5 }),
    (e) => e instanceof IdentityIssuanceError && e.reason === 'timeout');
  const controller = new AbortController();
  const waiting = poll(scripted([{ status: 'pending' }]).fetch, { intervalMs: 50, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => waiting, (e) => e instanceof IdentityIssuanceError && e.reason === 'cancelled');
});

test('the cancel signal is passed on to every request', async () => {
  const { fetch, calls } = scripted([{ status: 'done' }]);
  const signal = new AbortController().signal;
  await poll(fetch, { signal });
  assert.equal(calls[0].signal, signal);
});

test('the verification link carries the request, response_type, scope and the return address exactly', () => {
  const link = new URL(issuanceLink('https://id-service.testnet.concordium.com/api/v1/identity', { v: 0, value: { a: 1 } }, 'myapp://return/x?y=1'));
  assert.equal(link.origin + link.pathname, 'https://id-service.testnet.concordium.com/api/v1/identity');
  assert.deepEqual(JSON.parse(link.searchParams.get('state')), { idObjectRequest: { v: 0, value: { a: 1 } } });
  assert.equal(link.searchParams.get('response_type'), 'code');
  assert.equal(link.searchParams.get('scope'), 'identity');
  assert.equal(link.searchParams.get('redirect_uri'), 'myapp://return/x?y=1');
});
