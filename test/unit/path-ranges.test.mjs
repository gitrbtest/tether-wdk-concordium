/**
 * Account paths within Concordium's ranges; no external services. Outside them, Concordium's SDK silently reduces
 * some numbers (an account number of 9999 gives account 15's address, but a different signing key), so the
 * manager refuses them before deriving anything or asking the node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, KNOWN_ADDRESS } from '../helpers.mjs';

/** A manager whose node lookups are counted (and answered with a known account). */
function countingManager() {
  const manager = makeManager();
  const lookups = [];
  manager._lookupAccountInfo = async (...path) => {
    lookups.push(path.join('/'));
    return { accountAddress: KNOWN_ADDRESS };
  };
  return { manager, lookups };
}

test('account numbers above 255 are refused, not reduced to another account', async () => {
  const { manager, lookups } = countingManager();
  for (const path of ['0/0/256', '0/334563111/9999']) {
    await assert.rejects(() => manager.getAccountByPath(path), /account number \(the last part\) must be an integer from 0 to 255/);
  }
  assert.deepEqual(lookups, [], 'nothing was looked up');
  manager.dispose();
});

test('provider and identity numbers above 2147483647 are refused', async () => {
  const { manager, lookups } = countingManager();
  await assert.rejects(() => manager.getAccountByPath('2147483648/0/0'), /providerIndex must be at most 2147483647/);
  await assert.rejects(() => manager.getAccountByPath('0/4294967297/0'), /identityIndex must be at most 2147483647/);
  assert.deepEqual(lookups, []);
  manager.dispose();
});

test('the largest numbers in range are accepted', async () => {
  const { manager, lookups } = countingManager();
  await manager.getAccountByPath('0/0/255');
  await manager.getAccountByPath('2147483647/2147483647/0');
  assert.deepEqual(lookups, ['0/0/255', '2147483647/2147483647/0']);
  manager.dispose();
});

test('account recovery does not scan beyond account number 255', async () => {
  const { manager, lookups } = countingManager();
  await assert.rejects(() => manager.recoverAccountsForIdentity({ providerIndex: 0, identityIndex: 0, maxIndex: 256 }), /maxIndex must be an integer from 0 to 255/);
  assert.deepEqual(lookups, []);
  manager.dispose();
});
