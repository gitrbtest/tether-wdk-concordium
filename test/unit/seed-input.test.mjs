/** A wrong seed is refused without being repeated in the error; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValueError } from '@tetherto/wdk-wallet';
import WalletManagerConcordium from '../../index.js';
import { CONFIG, TEST_SEED } from '../helpers.mjs';

test('raw seed bytes of the wrong length are refused without the seed in the message', () => {
  for (const length of [16, 32, 63]) {
    const seed = new Uint8Array(length).fill(0xab);
    assert.throws(() => new WalletManagerConcordium(seed, CONFIG), (error) => {
      assert.ok(error instanceof ValueError);
      assert.equal(error.message, 'The seed must be a BIP-39 seed phrase or a 64-byte seed.');
      assert.ok(!error.message.includes('abab'), 'the seed is not repeated');
      return true;
    });
  }
});

test('a 64-byte raw seed is accepted', async () => {
  const manager = new WalletManagerConcordium(new Uint8Array(64).fill(0xab), CONFIG);
  manager._lookupAccountInfo = async () => ({ accountAddress: 'unused' });
  await manager.getAccountByPath('0/0/0');
  manager.dispose();
});

test('a mistyped seed phrase is refused without the words in the message', () => {
  const mistyped = TEST_SEED.replace(/about$/, 'abuot');
  assert.throws(() => new WalletManagerConcordium(mistyped, CONFIG), (error) => {
    assert.equal(error.message, 'Invalid seed phrase.');
    return true;
  });
});
