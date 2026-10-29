/**
 * The demo wallet's local server (examples/demo-wallet): it serves the page with its token, answers the API only
 * with that token, only on its own address, and never puts a seed in what it sends. On a real socket on 127.0.0.1;
 * skipped when no local socket can be opened (CI's network-off run). No external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { startDemoServer } from '../../examples/demo-wallet/server.mjs';
import { readSettings, DEMO_PHRASE } from '../../examples/demo-wallet/settings.mjs';

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

const FUNDED = { FUNDING_SEED: 'a funding seed for the test', FUNDING_PATH: '0/1/0', IDENTITY_INDEX: '7' };

/** A raw request, so the Host header can be set to anything. */
function get(url, { host, token } = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname } = new URL(url);
    const req = httpRequest({ hostname, port, path: pathname, headers: { ...(host ? { host } : {}), ...(token ? { 'x-demo-token': token } : {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withDemo(env, run) {
  const demo = await startDemoServer({ settings: readSettings(env), port: 0 });
  try { await run(demo); } finally { await demo.close(); }
}

test('settings: a funding account when given; a fresh random identity unless IDENTITY_INDEX', () => {
  const funded = readSettings(FUNDED);
  assert.deepEqual({ ...funded, funding: { ...funded.funding } },
    { port: 4321, seedPhrase: DEMO_PHRASE, identityIndex: 7, reuseIdentity: true, storeFolder: './demo-identities', funding: { seed: FUNDED.FUNDING_SEED, path: '0/1/0' } });
  const fresh = readSettings({ PORT: '4400' });
  assert.equal(fresh.port, 4400);
  assert.equal(fresh.funding, null, 'no funding account: the demo runs in "no funding" mode');
  assert.equal(fresh.reuseIdentity, false);
  assert.ok(Number.isSafeInteger(fresh.identityIndex) && fresh.identityIndex > 0);
});

test('the page is served with its token and safe headers', local, () => withDemo(FUNDED, async (demo) => {
  const page = await get(demo.url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.ok(page.body.includes(`content="${demo.token}"`), 'the token is in the page');
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await get(`${demo.url}app.js`)).status, 200);
  assert.equal((await get(`${demo.url}style.css`)).status, 200);
  assert.equal((await get(`${demo.url}server.mjs`)).status, 404, 'only the page\'s own files are served');
}));

test('the API answers only with the page\'s token', local, () => withDemo(FUNDED, async (demo) => {
  assert.equal((await get(`${demo.url}api/state`)).status, 403);
  assert.equal((await get(`${demo.url}api/state`, { token: 'not-the-token' })).status, 403);
  const state = await get(`${demo.url}api/state`, { token: demo.token });
  assert.equal(state.status, 200);
  assert.deepEqual(JSON.parse(state.body), { network: 'testnet', funding: 'funding account', identityIndex: 7, reuseIdentity: true, step: 'start' });
}));

test('only its own address is answered (other hosts and DNS tricks are refused)', local, () => withDemo(FUNDED, async (demo) => {
  const { port } = new URL(demo.url);
  assert.equal((await get(demo.url, { host: 'evil.example' })).status, 403);
  assert.equal((await get(demo.url, { host: `127.0.0.1:${Number(port) + 1}` })).status, 403);
  assert.equal((await get(demo.url, { host: `localhost:${port}` })).status, 200);
}));

test('no seed ever leaves the server: not in the page, not in the state', local, () => withDemo(FUNDED, async (demo) => {
  const everything = [(await get(demo.url)).body, (await get(`${demo.url}app.js`)).body,
    (await get(`${demo.url}api/state`, { token: demo.token })).body].join('\n');
  assert.ok(!everything.includes(FUNDED.FUNDING_SEED), 'the funding seed');
  assert.ok(!everything.includes('abandon'), 'the test seed phrase');
}));

test('without a funding account the state says so', local, () => withDemo({}, async (demo) => {
  const state = JSON.parse((await get(`${demo.url}api/state`, { token: demo.token })).body);
  assert.equal(state.funding, 'none');
  assert.equal(state.reuseIdentity, false);
}));
