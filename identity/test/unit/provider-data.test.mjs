/**
 * The recorded wallet-proxy data (provider lists and cryptographic parameters)
 * has the shape this package relies on; no external services. If a re-capture
 * (`npm run fixtures`) breaks one of these, the published data has changed
 * shape: review it before changing the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipInfoFixture, globalFixture } from '../helpers.mjs';

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: every provider has a unique index, revokers and published https addresses`, () => {
    const list = ipInfoFixture(network);
    assert.ok(list.length > 0, 'providers are published');
    const indices = list.map((entry) => entry.ipInfo.ipIdentity);
    assert.equal(new Set(indices).size, indices.length, 'indices are unique');
    for (const entry of list) {
      const where = `${network} provider ${entry.ipInfo.ipIdentity}`;
      assert.ok(Number.isSafeInteger(entry.ipInfo.ipIdentity) && entry.ipInfo.ipIdentity >= 0, `${where} index`);
      assert.equal(typeof entry.ipInfo.ipDescription.name, 'string', `${where} name`);
      assert.ok(Object.keys(entry.arsInfos).length > 0, `${where} anonymity revokers`);
      assert.match(entry.metadata.issuanceStart, /^https:\/\//, `${where} issuanceStart`);
      assert.match(entry.metadata.recoveryStart, /^https:\/\//, `${where} recoveryStart`);
    }
  });
}

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: the cryptographic parameters carry what an identity request is built against`, () => {
    const { v, value } = globalFixture(network);
    assert.equal(typeof v, 'number', 'versioned response');
    for (const field of ['onChainCommitmentKey', 'bulletproofGenerators', 'genesisString']) {
      assert.equal(typeof value[field], 'string', `${network} ${field}`);
      assert.ok(value[field].length > 0, `${network} ${field} is not empty`);
    }
  });
}
