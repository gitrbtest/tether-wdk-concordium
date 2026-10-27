/**
 * Building and signing the credential that creates an account (src/account/credential.js), offline, from
 * the recorded testnet identity and network data. Nothing is sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { buildAccountCredential } from '../../src/account/credential.js';
import { ipInfoFixture, globalFixture } from '../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const IDENTITY_INDEX = 334563111; // the identity the recorded one was issued for, with provider 0
const idObject = JSON.parse(readFileSync(new URL('../fixtures/identity-done.testnet.json', import.meta.url), 'utf8')).token.identityObject.value;
const provider = ipInfoFixture('testnet').find((entry) => entry.ipInfo.ipIdentity === 0);
const globalContext = globalFixture('testnet').value;
const hdWallet = () => sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
const inAnHour = () => new Date(Date.now() + 3600_000);

const build = (options = {}) => buildAccountCredential({
  provider, globalContext, hdWallet: hdWallet(), idObject, identityIndex: IDENTITY_INDEX, credNumber: 0, expiry: inAnHour(), ...options,
});

test('the address is the one the SDK gives when it is handed the seed itself', async () => {
  const { address } = await build();
  const withSeed = sdk.createCredentialPayload({
    ipInfo: provider.ipInfo, globalContext, arsInfos: provider.arsInfos, idObject, revealedAttributes: [],
    seedAsHex: hdWallet().seedAsHex, net: 'Testnet', identityIndex: IDENTITY_INDEX, credNumber: 0,
  }, sdk.TransactionExpiry.fromDate(inAnHour()));
  assert.equal(address, sdk.getAccountAddress(withSeed.unsignedCdi.credId).toString());
  assert.equal(address, '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t'); // account 0 of this identity, exists on testnet
});

test('the signed credential has the form the wallet-proxy takes, with the account key and nothing revealed', async () => {
  const expiry = inAnHour();
  const { credInfo, transactionHash, expiryEpochSeconds } = await build({ expiry });
  assert.deepEqual(Object.keys(credInfo).sort(),
    ['arData', 'credId', 'credentialPublicKeys', 'ipIdentity', 'policy', 'proofs', 'revocationThreshold']);
  assert.equal(credInfo.ipIdentity, 0);
  assert.deepEqual(credInfo.credentialPublicKeys, {
    keys: { 0: { schemeId: 'Ed25519', verifyKey: hdWallet().getAccountPublicKey(0, IDENTITY_INDEX, 0).toString('hex') } },
    threshold: 1,
  });
  assert.deepEqual(credInfo.policy.revealedAttributes, {});
  assert.equal(credInfo.policy.createdAt, idObject.attributeList.createdAt);
  assert.equal(credInfo.policy.validTo, idObject.attributeList.validTo);
  assert.match(credInfo.proofs, /^[0-9a-f]+$/);
  assert.match(transactionHash, /^[0-9a-f]{64}$/);
  assert.equal(expiryEpochSeconds, Math.floor(expiry.getTime() / 1000));
});

test('chosen attributes are revealed on the account, with the identity\'s values; no others', async () => {
  const { credInfo } = await build({ revealAttributes: ['countryOfResidence'] });
  assert.deepEqual(credInfo.policy.revealedAttributes, {
    countryOfResidence: idObject.attributeList.chosenAttributes.countryOfResidence,
  });
});

test('each account number under the identity is a different account', async () => {
  const [first, second] = [await build({ credNumber: 0 }), await build({ credNumber: 1 })];
  assert.notEqual(first.address, second.address);
  assert.notEqual(first.credInfo.credId, second.credInfo.credId);
  assert.deepEqual(second.credInfo.credentialPublicKeys.keys[0].verifyKey, hdWallet().getAccountPublicKey(0, IDENTITY_INDEX, 1).toString('hex'));
});

test('the signing key is zeroed after use', async () => {
  const wallet = hdWallet();
  const handedOut = [];
  const spy = new Proxy(wallet, {
    get(target, name) {
      if (name !== 'getAccountSigningKey') return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
      return (...args) => { const key = target.getAccountSigningKey(...args); handedOut.push(key); return key; };
    },
  });
  await build({ hdWallet: spy });
  assert.equal(handedOut.length, 1);
  assert.ok(handedOut[0].every((byte) => byte === 0));
});
