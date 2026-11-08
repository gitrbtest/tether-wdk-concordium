/** Explicit account paths and deterministic offline key derivation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager } from '../../helpers.mjs';

test('getAccount is unsupported for default, numeric, and named accounts', async () => {
  const manager = makeManager();
  try {
    for (const argument of [undefined, 0, 3, 'signer']) {
      await assert.rejects(() => manager.getAccount(argument), /not supported.*getAccountByPath/);
    }
  } finally {
    manager.dispose();
  }
});

test('getAccountByPath selects all coordinates and accounts have no index property', async () => {
  const manager = makeManager();
  try {
    for (const path of ['0/0/5', '1/2/3', '0/899424164/0']) {
      const account = await manager.getAccountByPath(path);
      assert.equal(account.path, path);
      assert.equal('index' in account, false);
    }
  } finally {
    manager.dispose();
  }
});

test('keys are deterministic for each path and vary with each coordinate', async () => {
  const first = makeManager();
  const second = makeManager();
  const publicKey = async (manager, path) =>
    Buffer.from((await manager.getAccountByPath(path)).keyPair.publicKey).toString('hex');
  try {
    const baseline = await publicKey(first, '0/0/0');
    assert.equal(baseline, await publicKey(second, '0/0/0'));
    for (const path of ['1/0/0', '0/1/0', '0/0/1']) {
      assert.notEqual(baseline, await publicKey(first, path));
    }
  } finally {
    first.dispose();
    second.dispose();
  }
});
