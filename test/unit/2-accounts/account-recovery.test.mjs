/** Single-identity recovery through mocked node credential-ID lookup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@concordium/web-sdk';
import WalletManagerConcordium, { WalletAccountConcordium } from '../../../index.js';
import { TEST_SEED, KNOWN_ADDRESS } from '../../helpers.mjs';

const options = { providerIndex: 2, identityIndex: 7 };
const notFound = () => new sdk.RpcError('Account not found', 'NOT_FOUND');

function setup(t, lookup) {
  const manager = new WalletManagerConcordium(TEST_SEED, {
    useMainnetKeyDerivation: false, grpcUrl: 'http://localhost:20000',
  });
  t.after(() => manager.dispose());
  const global = { onChainCommitmentKey: 'mock commitment key' };
  const counters = [];
  let globalCalls = 0;
  t.mock.method(sdk.ConcordiumHdWallet.prototype, 'getCredentialId', (provider, identity, counter, parameters) => {
    assert.equal(provider, options.providerIndex);
    assert.equal(identity, options.identityIndex);
    assert.deepEqual(parameters, global);
    const bytes = Buffer.alloc(48);
    bytes[0] = 0x80; // SDK credential-ID encoding requires the compressed-point marker.
    bytes.writeUInt32BE(counter, 44);
    return bytes;
  });
  manager._getClient = async () => ({
    getCryptographicParameters: async () => { globalCalls++; return global; },
    getAccountInfo: async (credentialId) => {
      assert.ok(sdk.CredentialRegistrationId.instanceOf(credentialId), 'node lookup uses a typed credential ID');
      const counter = Buffer.from(credentialId.toString(), 'hex').readUInt32BE(44);
      counters.push(counter);
      return lookup(counter, manager);
    },
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Recovery must use only the gRPC node'); });
  return { manager, counters, globalCalls: () => globalCalls };
}

const accountInfo = () => ({ accountAddress: sdk.AccountAddress.fromBase58(KNOWN_ADDRESS) });

test('recovery returns tracked account instances per path, resets gaps, and caches addresses without a proxy', async (t) => {
  const { manager, counters, globalCalls } = setup(t, (counter, manager) => {
    assert.equal(Object.keys(manager._accounts).length, 0, 'no account instances during the scan');
    if (counter === 0 || counter === 2) return accountInfo();
    throw notFound();
  });
  const accounts = await manager.recoverAccountsForIdentity(options);
  assert.deepEqual(counters, [0, 1, 2, 3, 4, 5]);
  assert.equal(globalCalls(), 1);
  assert.deepEqual(accounts.map(a => a.path), ['2/7/0', '2/7/2']);
  assert.equal(accounts.length, 2, 'same address at distinct paths is not deduplicated');
  for (const account of accounts) {
    assert.ok(account instanceof WalletAccountConcordium);
    assert.equal(manager._accounts[account.path], account);
    assert.equal('credentialId' in account, false);
    assert.equal('index' in account, false);
  }
  manager._getGlobal = async () => { throw new Error('Known addresses must not be derived again'); };
  assert.deepEqual(await Promise.all(accounts.map(a => a.getAddress())), [KNOWN_ADDRESS, KNOWN_ADDRESS]);
  manager.dispose();
  assert.ok(accounts.every(a => a.disposed));
});

test('recovery applies custom start, inclusive maximum counter, and gap limit', async (t) => {
  const { manager, counters } = setup(t, () => { throw notFound(); });
  assert.deepEqual(await manager.recoverAccountsForIdentity({ ...options, startIndex: 4, maxIndex: 5, gapLimit: 10 }), []);
  assert.deepEqual(counters, [4, 5]);
});

test('default maximum counter is 50 inclusive even when every lookup succeeds', async (t) => {
  const { manager, counters } = setup(t, accountInfo);
  const accounts = await manager.recoverAccountsForIdentity(options);
  assert.equal(accounts.length, 51);
  assert.equal(counters.at(-1), 50);
});

test('a NOT_FOUND-only scan stops at the default gap of three', async (t) => {
  const { manager, counters } = setup(t, () => { throw notFound(); });
  assert.deepEqual(await manager.recoverAccountsForIdentity(options), []);
  assert.deepEqual(counters, [0, 1, 2]);
});

for (const error of [
  new sdk.RpcError('Connection unavailable', 'UNAVAILABLE'),
  new sdk.RpcError('Request timed out', 'DEADLINE_EXCEEDED'),
  new Error('not found in a generic error'),
  Object.assign(new Error('not an SDK RPC error'), { code: 'NOT_FOUND' }),
]) {
  test(`recovery propagates ${error.code || error.message} without partial account registration`, async (t) => {
    const { manager } = setup(t, (counter) => {
      if (counter === 0 || counter === 9) return accountInfo();
      throw error;
    });
    const existing = await manager.getAccountByPath('2/7/9');
    const before = { ...manager._accounts };
    await assert.rejects(() => manager.recoverAccountsForIdentity(options), e => e === error);
    assert.deepEqual(manager._accounts, before);
    assert.equal(existing.disposed, false);
    assert.equal('recoverAccounts' in manager, false);
  });
}
