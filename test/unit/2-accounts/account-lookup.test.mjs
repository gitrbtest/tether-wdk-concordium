/** Path-based retrieval verifies credential membership before exposing an account. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@concordium/web-sdk';
import WalletManagerConcordium, { AccountNotCreatedError, WalletAccountConcordium } from '../../../index.js';
import { CONFIG, TEST_SEED, KNOWN_ADDRESS } from '../../helpers.mjs';

function setup(t, lookup) {
  const manager = new WalletManagerConcordium(TEST_SEED, CONFIG);
  t.after(() => manager.dispose());
  const parameters = { onChainCommitmentKey: 'mock commitment key' };
  const counters = [];
  let globalCalls = 0;
  t.mock.method(sdk.ConcordiumHdWallet.prototype, 'getCredentialId', (provider, identity, counter, global) => {
    assert.equal(provider, 1);
    assert.equal(identity, 2);
    assert.deepEqual(global, parameters);
    const bytes = Buffer.alloc(48);
    bytes[0] = 0x80;
    bytes.writeUInt32BE(counter, 44);
    return bytes;
  });
  manager._getClient = async () => ({
    getCryptographicParameters: async () => { globalCalls++; return parameters; },
    getAccountInfo: async (...args) => {
      assert.equal(args.length, 1, 'use the default finalized block');
      assert.ok(sdk.CredentialRegistrationId.instanceOf(args[0]));
      const counter = Buffer.from(args[0].toString(), 'hex').readUInt32BE(44);
      counters.push(counter);
      return lookup(counter, manager);
    },
  });
  return { manager, counters, globalCalls: () => globalCalls };
}

const info = () => ({ accountAddress: sdk.AccountAddress.fromBase58(KNOWN_ADDRESS) });

test('path retrieval verifies on every call, uses the node address, and caches only chain parameters', async (t) => {
  const { manager, counters, globalCalls } = setup(t, info);
  const first = await manager.getAccountByPath('1/2/3');
  const second = await manager.getAccountByPath('1/2/3');
  assert.ok(first instanceof WalletAccountConcordium);
  assert.notEqual(first, second);
  assert.deepEqual(counters, [3, 3]);
  assert.equal(globalCalls(), 1);
  assert.equal(second.path, '1/2/3');
  assert.equal(manager._accounts[second.path], second);
  manager._getGlobal = async () => { throw new Error('Address should already be known'); };
  assert.equal(await second.getAddress(), KNOWN_ADDRESS);
  // Only the latest instance is tracked per path; dispose the superseded reference.
  first.dispose();
});

test('a missing credential rejects with path context, without an invented address or registered instance', async (t) => {
  const { manager } = setup(t, () => { throw new sdk.RpcError('Missing', 'NOT_FOUND'); });
  await assert.rejects(() => manager.getAccountByPath('1/2/3'), error => {
    assert.ok(error instanceof AccountNotCreatedError);
    assert.equal(error.path, '1/2/3');
    assert.equal(error.address, undefined);
    assert.match(error.message, /1\/2\/3.*does not exist on-chain/);
    return true;
  });
  assert.deepEqual(manager._accounts, {});
});

for (const error of [
  new sdk.RpcError('Unavailable', 'UNAVAILABLE'),
  new sdk.RpcError('Timeout', 'DEADLINE_EXCEEDED'),
  new Error('not found'),
]) {
  test(`path lookup propagates ${error.code || error.message} and leaves existing accounts unchanged`, async (t) => {
    let fail = false;
    const { manager } = setup(t, () => {
      if (fail) throw error;
      return info();
    });
    const existing = await manager.getAccountByPath('1/2/3');
    fail = true;
    await assert.rejects(() => manager.getAccountByPath('1/2/3'), actual => actual === error);
    assert.equal(manager._accounts[existing.path], existing);
    assert.equal(existing.disposed, false);
  });
}

test('cryptographic-parameter NOT_FOUND errors are not mistaken for a missing account', async (t) => {
  const { manager } = setup(t, info);
  const error = new sdk.RpcError('Parameters unavailable', 'NOT_FOUND');
  manager._getGlobal = async () => { throw error; };
  await assert.rejects(() => manager.getAccountByPath('1/2/3'), actual => actual === error);
  assert.deepEqual(manager._accounts, {});
});
