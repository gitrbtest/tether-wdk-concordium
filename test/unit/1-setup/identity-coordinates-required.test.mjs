/** Recovery and internal onboarding require explicit identity coordinates before service calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ConcordiumOnboarding from '../../helpers/ConcordiumOnboarding.js';
import { CONFIG, makeManager } from '../../helpers.mjs';

test('recovery and internal onboarding reject missing or invalid coordinates without service calls', async () => {
  const manager = makeManager();
  let serviceCalls = 0;
  const unexpectedService = async () => {
    serviceCalls++;
    throw new Error('Unexpected service call');
  };
  manager._getClient = unexpectedService;
  manager._lookupAccountInfo = unexpectedService;
  const onboarding = new ConcordiumOnboarding(manager);
  onboarding._ctx = unexpectedService;
  try {
    const invalidOptions = [undefined, {}, { providerIndex: 0 }, { identityIndex: 0 }];
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null]) {
      invalidOptions.push({ providerIndex: value, identityIndex: 0 });
      invalidOptions.push({ providerIndex: 0, identityIndex: value });
    }
    for (const options of invalidOptions) {
      await assert.rejects(() => manager.recoverAccountsForIdentity(options), /required.*non-negative safe integer/);
      await assert.rejects(() => onboarding.createIdentityRequest(options), /required.*non-negative safe integer/);
      await assert.rejects(() => onboarding.createAccount(options), /required.*non-negative safe integer/);
    }
    assert.equal(serviceCalls, 0);
  } finally {
    manager.dispose();
  }
});

test('unused identity configuration does not select or override account coordinates', async () => {
  const manager = makeManager({
    ...CONFIG, identityProviderIndex: 123, identityIndex: 456,
  });
  const reference = makeManager();
  try {
    const account = await manager.getAccountByPath('1/2/3');
    const expected = await reference.getAccountByPath('1/2/3');
    assert.equal(account.path, '1/2/3');
    assert.deepEqual(account.keyPair.publicKey, expected.keyPair.publicKey);
    await assert.rejects(() => manager.getAccount(), /getAccountByPath/);
    await assert.rejects(() => manager.recoverAccountsForIdentity(), /providerIndex is required/);
    await assert.rejects(() => new ConcordiumOnboarding(manager).createIdentityRequest(), /providerIndex is required/);
  } finally {
    manager.dispose();
    reference.dispose();
  }
});
