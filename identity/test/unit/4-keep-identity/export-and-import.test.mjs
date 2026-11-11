// Keeping identities: the package stores nothing. exportIdentity hands the wallet the identity as plain JSON text to
// keep its own way: NOT ENCRYPTED, it holds the person's details, so the wallet keeps it in its secure storage, like
// the seed phrase. importIdentity holds it again, after checking it is this wallet's. Network answered from recordings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ConcordiumIdentity, IdentityStorageError, CONCORDIUM_TESTNET_IDENTITY_CONFIG, CONCORDIUM_MAINNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { walletProxyFetch, testnetConfig, mainnetConfig, recordedNode } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const fixture = (name) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url));
const issuedIdentity = () => JSON.parse(fixture('identity-done.testnet.json')).token.identityObject;

/** A wallet whose network is answered from recordings (and the recorded identity's code_uri), counting calls. */
function wallet(phrase = PHRASE, config = testnetConfig()) {
  const recorded = walletProxyFetch('testnet');
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(String(url));
    return url === CODE_URI
      ? { ok: true, status: 200, json: async () => JSON.parse(fixture('identity-done.testnet.json')) }
      : recorded.fetch(url, options);
  };
  const w = new ConcordiumIdentity(phrase, config, { fetch });
  w.calls = calls;
  return w;
}

/** A wallet holding the recorded identity (collected from its code_uri, as after verifying). */
async function holding() {
  const w = wallet();
  await w.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  return w;
}

const unreadable = (pattern) => (e) => {
  assert.ok(e instanceof IdentityStorageError, `an IdentityStorageError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, 'unreadable');
  if (pattern) assert.match(e.message, pattern);
  return true;
};

test("export → import in a new wallet object: the identity is held again, after checking it is this seed's", async () => {
  const before = await holding();
  const text = await before.exportIdentity(RECORDED);
  before.dispose();
  const json = JSON.parse(text);
  assert.deepEqual([json.format, json.v, json.network, json.providerIndex, json.identityIndex],
    ['concordium-wdk-identity', 1, 'testnet', 0, 334563111]);
  assert.deepEqual(json.identityObject, issuedIdentity());

  const node = recordedNode('testnet');
  const after = wallet(PHRASE, testnetConfig({ node })); // e.g. after an app restart: only the seed
  const summary = await after.importIdentity(text);
  assert.deepEqual(summary, { ...RECORDED, createdAt: '202609', validTo: '202709', maxAccounts: 200 });
  assert.equal(node.calls, 1, "the ownership check uses the network's parameters, from the node");
  assert.equal(typeof await after.exportIdentity(RECORDED), 'string', 'held: it can be exported again');
  after.dispose();
});

test("the export is NOT encrypted: the person's details are readable in it (so the wallet must keep it secret)", async () => {
  const w = await holding();
  const text = await w.exportIdentity(RECORDED);
  for (const detail of ['John', 'Doe', '19700101', 'N-1234']) assert.ok(text.includes(detail), `${detail} is in the text`);
  assert.equal(await w.exportIdentity(RECORDED), text, 'the same identity always gives the same text');
  w.dispose();
});

test('an export of another seed phrase, another network or another identity number is refused', async () => {
  const w = await holding();
  const text = await w.exportIdentity(RECORDED);
  w.dispose();
  const json = JSON.parse(text);
  await assert.rejects(wallet(OTHER_PHRASE).importIdentity(text), (e) => e instanceof IdentityStorageError && e.reason === 'not-yours');
  await assert.rejects(wallet(PHRASE, mainnetConfig()).importIdentity(text), unreadable(/for testnet, not mainnet/));
  // Claimed for another identity number: not this seed's key for that number.
  await assert.rejects(wallet().importIdentity(JSON.stringify({ ...json, identityIndex: 7 })),
    (e) => e instanceof IdentityStorageError && e.reason === 'not-yours');
  // An unknown format version.
  await assert.rejects(wallet().importIdentity(JSON.stringify({ ...json, v: 2 })), unreadable(/format version 2/));
});

test('anything that is not an exported identity is refused as unreadable, including the earlier encrypted text', async () => {
  const w = wallet();
  for (const junk of ['', 'hello', '{}', '{"format":"other"}', '{not json', 'Q1dJRA==', 'AAAAAAAAAAAAAAAAAAAAAAAA', 42, null,
    new Uint8Array([67, 87, 73, 68])]) {
    await assert.rejects(w.importIdentity(junk), unreadable(), String(junk));
  }
  w.dispose();
});

test('export: no identity held, a missing number, disposed; the old store option is refused', async () => {
  const w = wallet();
  await assert.rejects(w.exportIdentity(RECORDED), /No identity is held/);
  await assert.rejects(w.exportIdentity({ providerIndex: 0 }), /identityIndex is required/);
  const held = await holding();
  held.dispose();
  await assert.rejects(held.exportIdentity(RECORDED), /disposed/);
  await assert.rejects(held.importIdentity('x'), /disposed/);
  assert.throws(() => new ConcordiumIdentity(PHRASE, testnetConfig(), { store: {} }), /exportIdentity.*importIdentity/);
  w.dispose();
});

test('reads identities exported in format version 1 (golden file)', async () => {
  const w = wallet();
  const summary = await w.importIdentity(fixture('golden/identity-plain-v1.json').toString());
  assert.deepEqual(summary, { ...RECORDED, createdAt: '202609', validTo: '202709', maxAccounts: 200 });
  w.dispose();
});
