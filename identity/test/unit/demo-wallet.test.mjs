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
  const last = await state(demo);
  throw new Error(`the demo state never got there (step ${last.step}, busy ${last.busy}, error: ${last.error})`);
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

// ---- Steps 4–5: create the account, receive (a fake wallet package; no network) -----------------------------

const ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t'; // account 0 of the recorded identity
const FUNDING_ADDRESS = '3GEmZc57STNxVqWykUceXAeCVsDzaogq6wNZhDLAV8bRNYzUYd';

/** A fake wallet package: one account per path; balances it is told; every transfer recorded. */
function fakeWalletPackage() {
  const transfers = [];
  const balances = { ccd: 0n, plt: 0n, cis2: 0n };
  const accountFor = (path) => ({
    getAddress: async () => (path === '0/1/0' ? FUNDING_ADDRESS : ACCOUNT_0),
    getBalance: async () => balances.ccd,
    getTokenBalance: async (token) => (token === 'TN' ? balances.plt : balances.cis2),
    sendTransaction: async ({ to, value }) => { transfers.push({ token: 'CCD', to, amount: value }); balances.ccd += value; return { hash: 'a1'.repeat(32) }; },
    transfer: async ({ token, recipient, amount }) => { transfers.push({ token, to: recipient, amount }); balances[token === 'TN' ? 'plt' : 'cis2'] += amount; return { hash: 'b2'.repeat(32) }; },
    quoteSendTransaction: async () => ({ fee: 3_634_187n }),
    quoteTransfer: async ({ token }) => ({ fee: token === 'TN' ? 4_736_775n : 11_519_139n }),
    buildSponsorableTransfer: async (request) => ({ request, signedBy: [] }),
    signAsAccountToBeSponsored: async (tx) => ({ ...tx, signedBy: [...tx.signedBy, `account ${path}`] }),
    signAsSponsorSigned: async (tx) => ({ ...tx, signedBy: [...tx.signedBy, `sponsor ${path}`] }),
    submitSponsored: async (tx) => { transfers.push({ sponsored: tx.request, signedBy: tx.signedBy }); return { hash: 'c3'.repeat(32) }; },
  });
  return { transfers, balances, makeWallet: () => ({ getAccountByPath: async (path) => accountFor(path), dispose() {} }) };
}

/** A demo with an identity verified (recorded data), a scripted wallet-proxy for accounts, and a fake wallet package. */
async function withIdentityReady(env, run) {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { walletProxyFetch } = await import('../helpers.mjs');
  const issued = () => JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
  const { fetch: recorded } = walletProxyFetch('testnet');
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetch = async (url, options) => {
    if (url === CODE_URI) return json(issued());
    if (url.includes('/v0/accBalance/')) return json({});
    if (url.includes('/v0/submitCredential')) return json({ submissionId: 'x' });
    if (url.includes('/v0/submissionStatus/')) return json({ status: 'finalized', outcome: 'success', blockHashes: ['b1'] });
    return recorded(url, options);
  };
  const storeFolder = mkdtempSync(join(tmpdir(), 'demo-wallet-test-'));
  const wallet = fakeWalletPackage();
  // A fresh identity (verified below), whatever the env says about reusing one.
  const settings = { ...readSettings(env), identityIndex: RECORDED_IDENTITY, reuseIdentity: false, storeFolder };
  const demo = await startDemoServer({ settings, port: 0, fetch, checkProviders: false, makeWallet: wallet.makeWallet, pauseMs: 5 });
  try {
    await post(demo, '/api/start');
    await post(demo, '/api/verify', { providerIndex: 0 });
    await post(demo, '/api/callback', { url: `${demo.url}return#code_uri=${encodeURIComponent(CODE_URI)}` });
    await until(demo, (s) => s.step === 'identity');
    await run(demo, wallet);
  } finally {
    await demo.close();
    rmSync(storeFolder, { recursive: true, force: true });
  }
}

test('step 4: Create account makes account 0 of the identity, with its CCDScan link', local, () => withIdentityReady(FUNDED, async (demo) => {
  assert.equal((await post(demo, '/api/create-account')).status, 202);
  const s = await until(demo, (x) => x.step === 'account');
  assert.equal(s.fundingAddress, FUNDING_ADDRESS, 'the Receive card can name the sender before the click');
  assert.equal(s.account.address, ACCOUNT_0);
  assert.equal(s.account.path, `0/${RECORDED_IDENTITY}/0`);
  assert.equal(s.account.created, true);
  assert.match(s.account.link, /testnet\.ccdscan\.io.*daddress=3Z4WkEMb/);
  assert.equal(s.activity.at(-1).status, 'done');
  assert.equal(s.busy, null);
}));

test('step 5: the funding account sends CCD, TN and CIS-2 to the new account, then the balances show', local, () => withIdentityReady(FUNDED, async (demo, wallet) => {
  await post(demo, '/api/create-account');
  await until(demo, (x) => x.step === 'account');
  assert.equal((await post(demo, '/api/receive')).status, 202);
  const s = await until(demo, (x) => x.step === 'funded');
  assert.deepEqual(wallet.transfers, [
    { token: 'CCD', to: ACCOUNT_0, amount: 40_000_000n },
    { token: 'TN', to: ACCOUNT_0, amount: 5_000_000n },
    { token: 'cis2:12754:0:01', to: ACCOUNT_0, amount: 500n },
  ]);
  assert.deepEqual(s.balances.text, { ccd: '40.000000 CCD', plt: '5.000000 TN', cis2: '500 units' });
  assert.equal(s.activity.filter((l) => l.status === 'done' && l.link).length, 4, 'the account and three transfers, each with a link');
}));

test('with no funding account, the page waits for CCD to arrive, then shows the balances', local, () => withIdentityReady({}, async (demo, wallet) => {
  await post(demo, '/api/create-account');
  await until(demo, (x) => x.step === 'account');
  assert.equal((await post(demo, '/api/receive')).status, 400, 'nothing to receive from');
  assert.equal((await state(demo)).activity.at(-1).status, 'running', 'waiting for CCD');
  wallet.balances.ccd = 12_000_000n; // someone sends 12 CCD from another wallet
  const s = await until(demo, (x) => x.step === 'funded');
  assert.equal(s.balances.text.ccd, '12.000000 CCD');
}));

test('steps happen in order, one at a time', local, () => withIdentityReady(FUNDED, async (demo) => {
  assert.equal((await post(demo, '/api/receive')).status, 400, 'no account yet');
  await post(demo, '/api/create-account');
  assert.equal((await post(demo, '/api/create-account')).status, 400, 'already running (or done)');
}));

// ---- Step 6: send, and the sponsored send (the fake wallet package; no network) ---------------------------------

async function funded(demo) {
  await post(demo, '/api/create-account');
  await until(demo, (x) => x.step === 'account');
  await post(demo, '/api/receive');
  return until(demo, (x) => x.step === 'funded');
}

test('step 6: the fee is quoted first; the inputs are checked', local, () => withIdentityReady(FUNDED, async (demo) => {
  const s = await funded(demo);
  assert.equal(s.fundingAddress, FUNDING_ADDRESS, 'the page can offer the funding account as recipient');
  const quote = await post(demo, '/api/quote', { token: 'CCD', recipient: FUNDING_ADDRESS, amount: '1' });
  assert.deepEqual(quote.body, { fee: '3634187', feeText: '3.634187 CCD', enough: true, amountText: '1.000000 CCD', neededText: '4.634187 CCD' });
  assert.equal((await post(demo, '/api/quote', { token: 'CIS-2', recipient: FUNDING_ADDRESS, amount: '100' })).body.feeText, '11.519139 CCD');
  for (const [body, why] of [
    [{ token: 'CCD', recipient: 'not-an-address', amount: '1' }, /not a valid Concordium address/],
    [{ token: 'CCD', recipient: ACCOUNT_0, amount: '1' }, /own address/],
    [{ token: 'CCD', recipient: FUNDING_ADDRESS, amount: 'abc' }, /as a number/],
    [{ token: 'CIS-2', recipient: FUNDING_ADDRESS, amount: '1.5' }, /whole units/],
    [{ token: 'BTC', recipient: FUNDING_ADDRESS, amount: '1' }, /CCD, TN or CIS-2/],
  ]) {
    const refused = await post(demo, '/api/quote', body);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, why);
  }
}));

test('step 6: Send sends once through the wallet module, then the balances refresh', local, () => withIdentityReady(FUNDED, async (demo, wallet) => {
  await funded(demo);
  const before = wallet.transfers.length;
  assert.equal((await post(demo, '/api/send', { token: 'TN', recipient: FUNDING_ADDRESS, amount: '1.5' })).status, 202);
  const s = await until(demo, (x) => x.busy === null && x.activity.at(-1).text.startsWith('Sent'));
  assert.deepEqual(wallet.transfers.slice(before), [{ token: 'TN', to: FUNDING_ADDRESS, amount: 1_500_000n }]);
  assert.match(s.activity.at(-1).text, /^Sent 1.500000 TN to 3GEmZc57…, final in/);
  assert.match(s.activity.at(-1).link, /dhash=b2/);
  assert.equal(s.lastSend.status, 'sent', 'the Send card shows the result in place');
  assert.match(s.lastSend.what, /^1.500000 TN to 3GEmZc57…$/);
  assert.ok(s.lastSend.balances.plt, 'with the new balance');
}));

test('step 6: a send the account cannot pay the fee for is refused, nothing sent', local, () => withIdentityReady(FUNDED, async (demo, wallet) => {
  await funded(demo);
  wallet.balances.ccd = 2_000_000n; // 2 CCD left: not enough for a 3.63 CCD fee
  assert.equal((await post(demo, '/api/quote', { token: 'CCD', recipient: FUNDING_ADDRESS, amount: '1' })).body.enough, false);
  const before = wallet.transfers.length;
  await post(demo, '/api/send', { token: 'CCD', recipient: FUNDING_ADDRESS, amount: '1' });
  const s = await until(demo, (x) => x.busy === null && x.error);
  assert.match(s.error, /Not enough CCD/);
  assert.equal(s.lastSend, null, 'refused before sending: no result panel');
  assert.equal(wallet.transfers.length, before);
}));

test('step 6b: the sponsored send: account 1 (TN, no CCD) sends to account 0, the sponsor signs and pays', local, () => withIdentityReady(FUNDED, async (demo, wallet) => {
  await funded(demo);
  const before = wallet.transfers.length;
  assert.equal((await post(demo, '/api/sponsored')).status, 202);
  const s = await until(demo, (x) => x.busy === null && x.sponsored?.link);
  const [give, sponsored] = wallet.transfers.slice(before);
  assert.equal(give.token, 'TN');
  assert.equal(give.amount, 2_000_000n, 'the sender is given TN only');
  assert.deepEqual(sponsored.sponsored, { token: 'TN', recipient: ACCOUNT_0, amount: 1_000_000n, sponsorAddress: FUNDING_ADDRESS });
  assert.deepEqual(sponsored.signedBy, [`account 0/${RECORDED_IDENTITY}/1`, 'sponsor 0/1/0'], 'the sender signs, then the sponsor');
  assert.equal(s.sponsored.sender.path, `0/${RECORDED_IDENTITY}/1`);
  assert.equal(s.sponsored.recipient.address, ACCOUNT_0);
  assert.equal(s.sponsored.sponsor.address, FUNDING_ADDRESS);
  assert.ok(s.sponsored.sponsor.before && s.sponsored.sponsor.after, "the sponsor's balances before and after");
  assert.match(s.sponsored.sponsor.feeText, / CCD$/, 'the fee it paid');
  assert.ok(s.sponsored.sender.before && s.sponsored.sender.after);
}));

test('step 6b: with no funding account there is no sponsor', local, () => withIdentityReady({}, async (demo, wallet) => {
  await post(demo, '/api/create-account');
  await until(demo, (x) => x.step === 'account');
  wallet.balances.ccd = 5_000_000n;
  await until(demo, (x) => x.step === 'funded');
  assert.equal((await post(demo, '/api/sponsored')).status, 400);
}));

test('step 6b: the sponsored send can be run again; account 1 is reused, the boxes start afresh', local, () => withIdentityReady(FUNDED, async (demo, wallet) => {
  await funded(demo);
  await post(demo, '/api/sponsored');
  await until(demo, (x) => x.busy === null && x.sponsored?.link);
  const before = wallet.transfers.length;
  assert.equal((await post(demo, '/api/sponsored')).status, 202);
  assert.equal((await state(demo)).sponsored, null, 'the previous run\'s boxes are cleared');
  const s = await until(demo, (x) => x.busy === null && x.sponsored?.link);
  assert.equal(wallet.transfers.length - before, 2, 'again: TN given, then the sponsored send');
  // (On the real chain account 1 is found the second time; this fake wallet-proxy reports every account as new.)
  assert.equal(s.activity.filter((l) => /^Account 1 /.test(l.text)).length, 2, 'account 1 is used by both runs');
}));
