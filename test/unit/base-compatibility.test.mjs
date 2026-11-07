/** Compatibility with the WDK base classes; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletAccountReadOnly, NotImplementedError, ValueError } from '@tetherto/wdk-wallet';
import { makeManager } from '../helpers.mjs';
import * as publicApi from '../../index.js';

test('onboarding is not part of the public API', () => {
  assert.equal('ConcordiumOnboarding' in publicApi, false);
  const manager = makeManager();
  try {
    assert.equal('getOnboarding' in manager, false);
  } finally {
    manager.dispose();
  }
});

test('accounts inherit the read-only base and expose their disposal state', async () => {
  const manager = makeManager();
  try {
    const account = await manager.getAccountByPath('0/0/0');
    assert.ok(account instanceof WalletAccountReadOnly);
    assert.equal(account.disposed, false);
    manager.dispose();
    assert.equal(account.disposed, true);
  } finally {
    manager.dispose();
  }
});

test('normalized transaction receipts are supported: getTransaction, and the base package\'s waitForTransaction', async () => {
  const manager = makeManager();
  try {
    const account = await manager.getAccountByPath('0/0/0');
    assert.equal(typeof account.getTransaction, 'function');
    assert.equal(account.waitForTransaction, WalletAccountReadOnly.prototype.waitForTransaction, 'the base package\'s own loop');
    await assert.rejects(() => account.getTransaction('unused'), ValueError, 'not a hash');
  } finally {
    manager.dispose();
  }
});
