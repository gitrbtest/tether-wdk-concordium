/**
 * listenForIdentityCallback: the built-in callback listener, on a real socket on
 * 127.0.0.1. Skipped when no local socket can be opened (CI's network-off run).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { listenForIdentityCallback } from '@concordium/wdk-identity-concordium/node';
import {
  ConcordiumIdentity,
  IdentityIssuanceError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';

const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';

/** Whether a socket can be opened on 127.0.0.1 here, and reached. */
const canListen = await new Promise((resolve) => {
  const probe = createServer((req, res) => res.end('ok'));
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.1', () => {
    const connection = httpRequest(`http://127.0.0.1:${probe.address().port}/`, (res) => {
      res.resume();
      res.on('end', () => probe.close(() => resolve(true)));
    });
    connection.setTimeout(2000, () => connection.destroy(new Error('timeout')));
    connection.on('error', () => probe.close(() => resolve(false)));
    connection.end();
  });
});
const local = { skip: canListen ? false : 'no local socket available (network off)' };

/** What the provider's redirect and the listener's page do in a browser: GET the page, then POST location.href. */
async function browserArrivesAt(address) {
  const page = await fetch(address); // fetch, like a browser, never sends the part after #
  assert.equal(page.status, 200);
  return fetch(address.split('#')[0], { method: 'POST', headers: { 'content-type': 'text/plain' }, body: address });
}

/** A raw request, to set headers fetch will not (e.g. Host). */
function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

const isReason = (reason) => (e) => e instanceof IdentityIssuanceError && e.reason === reason;

test('the return address is on 127.0.0.1, at a random secret path, different for each listener', local, async () => {
  const first = await listenForIdentityCallback();
  const second = await listenForIdentityCallback();
  try {
    assert.match(first.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/identity-callback\/[0-9a-f]{32}$/);
    assert.notEqual(new URL(first.redirectUri).pathname, new URL(second.redirectUri).pathname);
  } finally {
    first.close();
    second.close();
  }
});

test('the full address, including the part after #, arrives as the callback, and retrieveIdentity can read it', local, async () => {
  const listener = await listenForIdentityCallback();
  const arrival = `${listener.redirectUri}#code_uri=${encodeURIComponent(CODE_URI)}`;
  const posted = await browserArrivesAt(arrival);
  assert.equal(posted.status, 204);
  assert.equal(await listener.callback, arrival);

  const identity = new ConcordiumIdentity(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  assert.deepEqual(identity.parseIdentityCallback(await listener.callback), { codeUri: CODE_URI });
  identity.dispose();
});

test("a provider's error return arrives the same way", local, async () => {
  const listener = await listenForIdentityCallback();
  const arrival = `${listener.redirectUri}#error=Invalid%20proofs`;
  await browserArrivesAt(arrival);
  assert.equal(await listener.callback, arrival);
});

test('the page is not cached, sends no referrer, and runs only its own script', local, async () => {
  const listener = await listenForIdentityCallback();
  try {
    const page = await fetch(listener.redirectUri);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*connect-src 'self'/);
    assert.match(await page.text(), /method: 'POST'.*body: location\.href/s);
  } finally {
    listener.close();
  }
});

test('only one callback is accepted; the listener then closes', local, async () => {
  const listener = await listenForIdentityCallback();
  await browserArrivesAt(`${listener.redirectUri}#code_uri=${encodeURIComponent(CODE_URI)}`);
  await listener.callback;
  await assert.rejects(() => fetch(listener.redirectUri), 'nothing listens any more');
});

test('other paths, other hosts and other methods are refused, and the wait goes on', local, async () => {
  const listener = await listenForIdentityCallback();
  try {
    const { origin, host } = new URL(listener.redirectUri);
    assert.equal((await fetch(`${origin}/identity-callback/${'0'.repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${origin}/`)).status, 404);
    assert.equal(await rawRequest(listener.redirectUri, { headers: { host: `evil.example:${new URL(origin).port}` } }), 403);
    assert.equal((await fetch(listener.redirectUri, { method: 'PUT', body: 'x' })).status, 405);
    assert.equal(await rawRequest(listener.redirectUri, { headers: { host } }), 200, 'the right host is served');

    const late = await browserArrivesAt(`${listener.redirectUri}#code_uri=${encodeURIComponent(CODE_URI)}`);
    assert.equal(late.status, 204, 'still waiting after the refused requests');
  } finally {
    listener.close();
  }
});

test('a posted address that is not the return address, or too large, is refused', local, async () => {
  const listener = await listenForIdentityCallback();
  try {
    const post = (body) => fetch(listener.redirectUri, { method: 'POST', body });
    assert.equal((await post('https://evil.example/identity-callback#code_uri=x')).status, 400);
    assert.equal((await post('not a url')).status, 400);
    const large = await post(`${listener.redirectUri}#code_uri=${'a'.repeat(20000)}`).catch(() => null);
    assert.ok(large === null || large.status === 413, 'refused or cut off');
  } finally {
    listener.close();
  }
  await assert.rejects(() => listener.callback, isReason('cancelled'));
});

test('waiting stops with a timeout', local, async () => {
  const listener = await listenForIdentityCallback({ timeoutMs: 30 });
  await assert.rejects(() => listener.callback,
    (e) => isReason('timeout')(e) && /No identity callback arrived within 30 ms/.test(e.message));
});

test('waiting can be cancelled with a signal, or before it starts', local, async () => {
  const controller = new AbortController();
  const listener = await listenForIdentityCallback({ signal: controller.signal });
  controller.abort();
  await assert.rejects(() => listener.callback, isReason('cancelled'));
  await assert.rejects(() => fetch(listener.redirectUri), 'closed after cancelling');

  await assert.rejects(() => listenForIdentityCallback({ signal: AbortSignal.abort() }), isReason('cancelled'));
});

test('close stops listening, the callback rejects as cancelled, and a second close does nothing', local, async () => {
  const listener = await listenForIdentityCallback();
  listener.close();
  listener.close();
  await assert.rejects(() => listener.callback, isReason('cancelled'));
});

test('a fixed port can be chosen; a port in use is reported', local, async () => {
  const first = await listenForIdentityCallback();
  const port = Number(new URL(first.redirectUri).port);
  try {
    await assert.rejects(() => listenForIdentityCallback({ port }), /EADDRINUSE/);
  } finally {
    first.close();
  }
  const fixed = await listenForIdentityCallback({ port });
  assert.equal(Number(new URL(fixed.redirectUri).port), port);
  fixed.close();
});

test('invalid options are rejected before listening', async () => {
  for (const [options, expected] of [
    [{ port: -1 }, /port must be an integer from 0 to 65535/],
    [{ port: 70000 }, /port must be an integer/],
    [{ port: '4000' }, /port must be an integer/],
    [{ timeoutMs: 0 }, /timeoutMs must be a positive number/],
  ]) {
    await assert.rejects(() => listenForIdentityCallback(options), expected);
  }
});
