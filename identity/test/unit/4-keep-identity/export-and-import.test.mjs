// Keeping identities: the package stores nothing. exportIdentity hands the wallet the
// identity as text to keep its own way (encrypted by default, plain on request); importIdentity holds it again, after
// checking it is this wallet's. No network, except the plain import's ownership check (answered from recordings).
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

test('export (encrypted, the default) → import in a new wallet object: the identity is held again, with no network call', async () => {
  const before = await holding();
  const text = await before.exportIdentity(RECORDED);
  before.dispose();
  assert.equal(typeof text, 'string');
  assert.match(text, /^Q1dJRA/, 'base64 of "CWID"…');

  const after = wallet(); // e.g. after an app restart: only the seed
  const summary = await after.importIdentity(text);
  assert.deepEqual(summary, { ...RECORDED, createdAt: '202609', validTo: '202709', maxAccounts: 200 });
  assert.deepEqual(after.calls, [], 'an encrypted import needs no network');
  assert.equal(typeof await after.exportIdentity(RECORDED), 'string', 'held: it can be exported again');
  after.dispose();
});

test('the encrypted text reveals nothing personal; which identity it is stays readable; every export differs', async () => {
  const w = await holding();
  const one = await w.exportIdentity(RECORDED);
  const two = await w.exportIdentity(RECORDED);
  assert.notEqual(one, two, 'a fresh nonce every time');
  const bytes = Buffer.from(one, 'base64');
  const text = bytes.toString('latin1');
  for (const personal of ['John', 'Doe', '19700101', 'N-1234', 'T-1234']) assert.ok(!text.includes(personal), `${personal} is not readable`);
  assert.ok(text.includes('concordium-identity/testnet/0/334563111'), 'the label is readable');
  assert.deepEqual((await wallet().importIdentity(two)).identityIndex, RECORDED.identityIndex);
  w.dispose();
});

test('an encrypted export cannot be imported with another seed, on another network, or once changed', async () => {
  const w = await holding();
  const text = await w.exportIdentity(RECORDED);
  w.dispose();
  await assert.rejects(wallet(OTHER_PHRASE).importIdentity(text), unreadable(/cannot be decrypted with this wallet's seed/));
  await assert.rejects(wallet(PHRASE, mainnetConfig()).importIdentity(text), unreadable(/for testnet, not mainnet/));

  // One character changed in the encrypted part: detected.
  const i = text.length - 40;
  const changed = text.slice(0, i) + (text[i] === 'A' ? 'B' : 'A') + text.slice(i + 1);
  await assert.rejects(wallet().importIdentity(changed), unreadable(/cannot be decrypted/));

  // The readable label changed to another identity number: detected too (it is part of what is checked).
  const bytes = Buffer.from(text, 'base64');
  const at = bytes.indexOf('334563111');
  bytes.write('334563112', at, 'latin1');
  await assert.rejects(wallet().importIdentity(bytes.toString('base64')), unreadable(/cannot be decrypted/));
});

test('plain export (encrypted: false): JSON with the identity in the clear, imported after checking it is this seed\'s', async () => {
  const w = await holding();
  const text = await w.exportIdentity({ ...RECORDED, encrypted: false });
  w.dispose();
  const json = JSON.parse(text);
  assert.deepEqual([json.format, json.v, json.network, json.providerIndex, json.identityIndex],
    ['concordium-wdk-identity', 1, 'testnet', 0, 334563111]);
  assert.deepEqual(json.identityObject, issuedIdentity());

  const node = recordedNode('testnet');
  const after = wallet(PHRASE, testnetConfig({ node }));
  assert.equal((await after.importIdentity(text)).validTo, '202709');
  assert.equal(node.calls, 1, 'the ownership check uses the network\'s parameters, from the node');
  after.dispose();

  await assert.rejects(wallet(OTHER_PHRASE).importIdentity(text), (e) => e instanceof IdentityStorageError && e.reason === 'not-yours');
  await assert.rejects(wallet(PHRASE, mainnetConfig()).importIdentity(text), unreadable(/for testnet, not mainnet/));
  // Claimed for another identity number: not this seed's key for that number.
  await assert.rejects(wallet().importIdentity(JSON.stringify({ ...json, identityIndex: 7 })),
    (e) => e instanceof IdentityStorageError && e.reason === 'not-yours');
});

test('anything that is not an exported identity is refused as unreadable', async () => {
  const w = wallet();
  for (const junk of ['', 'hello', '{}', '{"format":"other"}', '{not json', 'Q1dJRA==', 'AAAAAAAAAAAAAAAAAAAAAAAA', 42, null]) {
    await assert.rejects(w.importIdentity(junk), unreadable(), JSON.stringify(junk));
  }
  w.dispose();
});

test('export: no identity held, bad options, disposed; the old store option is refused with a pointer to export/import', async () => {
  const w = wallet();
  await assert.rejects(w.exportIdentity(RECORDED), /No identity is held/);
  await assert.rejects(w.exportIdentity({ providerIndex: 0 }), /identityIndex is required/);
  const held = await holding();
  await assert.rejects(held.exportIdentity({ ...RECORDED, encrypted: 'yes' }), /encrypted must be true or false/);
  held.dispose();
  await assert.rejects(held.exportIdentity(RECORDED), /disposed/);
  await assert.rejects(held.importIdentity('x'), /disposed/);
  assert.throws(() => new ConcordiumIdentity(PHRASE, testnetConfig(), { store: {} }), /exportIdentity.*importIdentity/);
  w.dispose();
});

test('reads identities exported in format version 2 (golden file)', async () => {
  const w = wallet();
  const summary = await w.importIdentity(fixture('golden/identity-v2.txt').toString());
  assert.deepEqual(summary, { ...RECORDED, createdAt: '202609', validTo: '202709', maxAccounts: 200 });
  w.dispose();
});

test('reads identities saved in storage format version 1 (golden file), given which identity they are', async () => {
  const bytes = new Uint8Array(fixture('golden/identity-v1.bin'));
  const w = wallet();
  await assert.rejects(w.importIdentity(bytes), /providerIndex is required: version-1 data/);
  await assert.rejects(w.importIdentity(bytes, { providerIndex: 0, identityIndex: 7 }), unreadable(/cannot be decrypted/));
  assert.equal((await w.importIdentity(bytes, RECORDED)).identityIndex, RECORDED.identityIndex);
  // Also as base64 text, as a wallet may have kept it.
  assert.equal((await wallet().importIdentity(Buffer.from(bytes).toString('base64'), RECORDED)).validTo, '202709');
  w.dispose();
});
