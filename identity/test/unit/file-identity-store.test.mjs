/**
 * FileIdentityStore (the optional /node entry): encrypted identities kept in files. Each test works in its
 * own temporary folder, removed afterwards. Uses the disk, not the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileIdentityStore } from '@concordium/wdk-identity-concordium/node';
import { verifyIdentityStore } from '@concordium/wdk-identity-concordium/testing';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { walletProxyFetch } from '../helpers.mjs';

const SLOT = 'concordium-identity/testnet/0/594450697';

/** Run `use(folder)` with a fresh temporary folder, and remove it afterwards. */
async function inTemporaryFolder(use) {
  const folder = await mkdtemp(join(tmpdir(), 'identity-store-'));
  try {
    return await use(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Every file under a folder, as paths relative to it. */
async function filesUnder(folder) {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name).slice(folder.length + 1).split('\\').join('/'));
}

test('FileIdentityStore passes the store contract check', () => inTemporaryFolder(async (folder) => {
  await verifyIdentityStore(new FileIdentityStore(folder));
}));

test('one file per slot, in sub-folders mirroring the slot name; the folder is created when missing', () =>
  inTemporaryFolder(async (folder) => {
    const store = new FileIdentityStore(join(folder, 'not', 'yet', 'there'));
    const bytes = Uint8Array.from([0x43, 0x57, 0x49, 0x44, 1, 2, 3]);
    await store.save(SLOT, bytes);
    assert.deepEqual(await filesUnder(folder), [`not/yet/there/${SLOT}.bin`]);
    assert.deepEqual(new Uint8Array(await readFile(join(folder, 'not', 'yet', 'there', `${SLOT}.bin`))), bytes);
  }));

test('saved identities survive a restart: a new store object on the same folder reads them', () =>
  inTemporaryFolder(async (folder) => {
    await new FileIdentityStore(folder).save(SLOT, Uint8Array.from([1, 2, 3]));
    const afterRestart = new FileIdentityStore(folder);
    const read = await afterRestart.read(SLOT);
    assert.deepEqual(read, Uint8Array.from([1, 2, 3]));
    assert.ok(!Buffer.isBuffer(read), 'a plain Uint8Array, as the contract says');
  }));

test('saving again replaces the file in one step, and leaves no temporary files behind', () =>
  inTemporaryFolder(async (folder) => {
    const store = new FileIdentityStore(folder);
    for (let i = 0; i < 5; i++) await store.save(SLOT, Uint8Array.from([i]));
    assert.deepEqual(await store.read(SLOT), Uint8Array.from([4]));
    assert.deepEqual(await filesUnder(folder), [`${SLOT}.bin`]);
  }));

test('nothing saved: read gives null and delete is not an error', () => inTemporaryFolder(async (folder) => {
  const store = new FileIdentityStore(folder);
  assert.equal(await store.read(SLOT), null);
  await store.delete(SLOT);
}));

test('a slot name can never point outside the folder', () => inTemporaryFolder(async (folder) => {
  const store = new FileIdentityStore(folder);
  for (const unsafe of ['../outside', 'a/../../outside', '/absolute', 'a//b', 'a\\b', 'C:/x', 'a/./b', '..', '', 'a b', 'a/']) {
    await assert.rejects(() => store.save(unsafe, Uint8Array.from([1])), /is not a slot name this store can keep as a file/, unsafe);
    await assert.rejects(() => store.read(unsafe), TypeError, unsafe);
  }
  assert.deepEqual(await filesUnder(folder), []);
}));

test('refuses bytes that are not a Uint8Array, and a missing folder name', () => inTemporaryFolder(async (folder) => {
  await assert.rejects(() => new FileIdentityStore(folder).save(SLOT, 'text'), /bytes must be a Uint8Array/);
  assert.throws(() => new FileIdentityStore(''), /folder must be a path/);
}));

test('files are readable by the owner only (macOS / Linux)', { skip: process.platform === 'win32' && 'Windows uses its own access rules' },
  () => inTemporaryFolder(async (folder) => {
    await new FileIdentityStore(folder).save(SLOT, Uint8Array.from([1]));
    assert.equal((await stat(join(folder, `${SLOT}.bin`))).mode & 0o777, 0o600);
  }));

test('end to end: an identity saved through ConcordiumIdentity is a CWID file, and loads back after a restart', () =>
  inTemporaryFolder(async (folder) => {
    const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const done = JSON.parse(await readFile(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
    const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
    const newIdentity = () => {
      const { fetch: fakeWalletProxy } = walletProxyFetch('testnet');
      const fetch = async (url, o) => (url === CODE_URI ? { ok: true, status: 200, json: async () => done } : fakeWalletProxy(url, o));
      return new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch, store: new FileIdentityStore(folder) });
    };
    const slot = { providerIndex: 0, identityIndex: 334563111 };

    const first = newIdentity();
    await first.waitForIdentity(CODE_URI, { ...slot, intervalMs: 5 });
    const saved = await first.saveIdentity(slot);
    first.dispose();

    const file = join(folder, `${saved.slotName}.bin`);
    assert.equal(new TextDecoder().decode((await readFile(file)).subarray(0, 4)), 'CWID');
    assert.doesNotMatch(new TextDecoder('latin1').decode(await readFile(file)), /John|19700101|preIdentityObject/);

    const restarted = newIdentity();
    assert.equal((await restarted.loadIdentity(slot)).validTo, '202709');
  }));
