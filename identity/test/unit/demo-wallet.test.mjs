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
  const demo = await startDemoServer({ settings: readSettings(env), port: 0, checkProviders: false });
  try { await run(demo); } finally { await demo.close(); }
}

test('settings: a funding account when given; a fresh random identity unless IDENTITY_INDEX', () => {
  const funded = readSettings(FUNDED);
  assert.deepEqual({ ...funded, funding: { ...funded.funding } },
    { port: 4321, seedPhrase: DEMO_PHRASE, identityIndex: 7, reuseIdentity: true, providerIndex: 0, storeFolder: './demo-identities', funding: { seed: FUNDED.FUNDING_SEED, path: '0/1/0' } });
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
  const { network, funding, identityIndex, reuseIdentity, step } = JSON.parse(state.body);
  assert.deepEqual({ network, funding, identityIndex, reuseIdentity, step }, { network: 'testnet', funding: 'funding account', identityIndex: 7, reuseIdentity: true, step: 'start' });
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

// ---- Steps 1–3: providers, verification and the identity card (recorded testnet data, no network) ----------

const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const RECORDED_IDENTITY = 334563111; // the identity index the recorded identity was issued for (provider 0)

/** A demo server whose packages talk to recorded wallet-proxy data and a scripted provider; a fresh store folder. */
async function withRecordedDemo(changes, run) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readFileSync } = await import('node:fs');
  const { walletProxyFetch } = await import('../helpers.mjs');
  const issued = () => JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
  const { fetch: recorded } = walletProxyFetch('testnet');
  const fetch = async (url, options) => (url === CODE_URI ? { ok: true, status: 200, json: async () => issued() } : recorded(url, options));
  const storeFolder = mkdtempSync(join(tmpdir(), 'demo-wallet-test-'));
  const settings = { ...readSettings({}), identityIndex: RECORDED_IDENTITY, storeFolder, ...changes };
  const demo = await startDemoServer({ settings, port: 0, fetch, checkProviders: false });
  try { await run(demo, storeFolder); } finally { await demo.close(); rmSync(storeFolder, { recursive: true, force: true }); }
}

/** POST to the demo's API with its token. */
async function post(demo, path, body = {}) {
  const response = await fetch(`${demo.url}${path.slice(1)}`, {
    method: 'POST', headers: { 'x-demo-token': demo.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const state = async (demo) => (await fetch(`${demo.url}api/state`, { headers: { 'x-demo-token': demo.token } })).json();
async function until(demo, check) {
  for (let i = 0; i < 100; i++) { const s = await state(demo); if (check(s)) return s; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('the demo state never got there');
}

test('step 1: Start lists the providers that publish an issuance address', local, () => withRecordedDemo({}, async (demo) => {
  const started = await post(demo, '/api/start');
  assert.equal(started.status, 200);
  assert.equal(started.body.step, 'choose-provider');
  assert.ok(started.body.providers.length >= 1);
  assert.deepEqual(Object.keys(started.body.providers[0]).sort(), ['index', 'name', 'online']);
  assert.equal(started.body.providers.find((p) => p.index === 0).name, 'Concordium testnet IP');
}));

test('step 2: verify gives the provider link, which comes back to the demo\'s own /return page', local, () => withRecordedDemo({}, async (demo) => {
  await post(demo, '/api/start');
  const { status, body } = await post(demo, '/api/verify', { providerIndex: 0 });
  assert.equal(status, 200);
  const link = new URL(body.issuanceUrl);
  assert.equal(link.searchParams.get('redirect_uri'), `${demo.url}return`);
  assert.equal((await state(demo)).step, 'verifying');
  const page = await get(`${demo.url}return`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(`content="${demo.token}"`), 'the return page carries the token too');
}));

test('the reply is collected, checked and saved encrypted; the identity card has no personal data', local, () => withRecordedDemo({}, async (demo, storeFolder) => {
  await post(demo, '/api/start');
  await post(demo, '/api/verify', { providerIndex: 0 });
  const accepted = await post(demo, '/api/callback', { url: `${demo.url}return#code_uri=${encodeURIComponent(CODE_URI)}` });
  assert.equal(accepted.status, 202);
  const done = await until(demo, (s) => s.step === 'identity');
  assert.deepEqual({ ...done.identity }, {
    providerIndex: 0, identityIndex: RECORDED_IDENTITY, createdAt: '202609', validTo: '202709', maxAccounts: 200,
    providerName: 'Concordium testnet IP', slotName: `concordium-identity/testnet/0/${RECORDED_IDENTITY}`, storeFolder,
  });
  assert.equal(done.verification.stage, 5, 'all stages done');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(`${storeFolder}/concordium-identity/testnet/0/${RECORDED_IDENTITY}.bin`), 'saved in the store');
  assert.doesNotMatch(JSON.stringify(done), /John|Doe|19700101/, 'no personal data in the state');
}));

test('a reply that is not for the demo\'s request, or with no request started, is refused', local, () => withRecordedDemo({}, async (demo) => {
  await post(demo, '/api/start');
  assert.equal((await post(demo, '/api/callback', { url: `${demo.url}return#code_uri=x` })).status, 400, 'no request started');
  await post(demo, '/api/verify', { providerIndex: 0 });
  assert.equal((await post(demo, '/api/callback', { url: 'https://elsewhere.example/return#code_uri=x' })).status, 400);
}));

test('with IDENTITY_INDEX, Start loads the saved identity instead of verifying', local, () => withRecordedDemo({}, async (demo, storeFolder) => {
  await post(demo, '/api/start');
  await post(demo, '/api/verify', { providerIndex: 0 });
  await post(demo, '/api/callback', { url: `${demo.url}return#code_uri=${encodeURIComponent(CODE_URI)}` });
  await until(demo, (s) => s.step === 'identity');
  await withRecordedDemo({ storeFolder, reuseIdentity: true }, async (again) => {
    const started = await post(again, '/api/start');
    assert.equal(started.body.step, 'identity');
    assert.equal(started.body.identity.loaded, true);
    assert.equal(started.body.identity.validTo, '202709');
  });
}));

test('a provider can only be chosen once its check says it is ready', local, () => withRecordedDemo({}, async (demo) => {
  await post(demo, '/api/start');
  const s = await state(demo);
  // Pretend the live check is still running for provider 0, and found provider 3 not available.
  demo.state.providers.find((p) => p.index === 0).online = 'checking';
  demo.state.providers.find((p) => p.index === s.providers[1].index).online = 'not available (HTTP 503)';
  assert.equal((await post(demo, '/api/verify', { providerIndex: 0 })).status, 400);
  assert.equal((await post(demo, '/api/verify', { providerIndex: s.providers[1].index })).status, 400);
  assert.equal((await post(demo, '/api/verify', { providerIndex: 999 })).status, 400, 'not in the list');
  demo.state.providers.find((p) => p.index === 0).online = 'online';
  assert.equal((await post(demo, '/api/verify', { providerIndex: 0 })).status, 200);
}));
