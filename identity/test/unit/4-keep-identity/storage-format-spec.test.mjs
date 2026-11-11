/**
 * docs/storage-format.md is exact: an independent reader written from the document alone (not the package's code)
 * reads the test vector (the golden file), and checks its ownership the way the document says, with Concordium's SDK.
 * If the code or the document changes and they disagree, this fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import { ipInfoFixture, globalFixture } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const fixture = (name) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url));

test('the test vector reads as documented: the fields, and the identity as the provider issued it', () => {
  const text = fixture('golden/identity-plain-v1.json').toString('utf8');
  assert.equal(text.length, 13931, 'the documented size');
  const record = JSON.parse(text);
  assert.deepEqual(Object.keys(record), ['format', 'v', 'network', 'providerIndex', 'identityIndex', 'identityObject']);
  assert.deepEqual([record.format, record.v, record.network, record.providerIndex, record.identityIndex],
    ['concordium-wdk-identity', 1, 'testnet', 0, 334563111]);
  assert.deepEqual(record.identityObject, JSON.parse(fixture('identity-done.testnet.json')).token.identityObject);
});

test('as documented, it is not encrypted: the person\'s details are readable in the text', () => {
  const text = fixture('golden/identity-plain-v1.json').toString('utf8');
  for (const detail of ['"firstName":"John"', '"lastName":"Doe"', '"dob":"19700101"']) assert.ok(text.includes(detail), detail);
});

test('the documented ownership check: idCredPub is the public key the seed phrase gives for the provider and identity', () => {
  const record = JSON.parse(fixture('golden/identity-plain-v1.json').toString('utf8'));
  const hdWallet = sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
  const provider = ipInfoFixture('testnet').find((p) => p.ipInfo.ipIdentity === record.providerIndex);
  const idCredSec = hdWallet.getIdCredSec(record.providerIndex, record.identityIndex).toString('hex');
  const ours = sdk.createIdentityRecoveryRequestWithKeys({
    ipInfo: provider.ipInfo, globalContext: globalFixture('testnet').value, idCredSec, timestamp: 0,
  }).value.idCredPub;
  assert.equal(record.identityObject.value.preIdentityObject.idCredPub, ours, 'this seed phrase\'s identity');

  const other = sdk.ConcordiumHdWallet.fromSeedPhrase('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'Testnet');
  const theirs = sdk.createIdentityRecoveryRequestWithKeys({
    ipInfo: provider.ipInfo, globalContext: globalFixture('testnet').value,
    idCredSec: other.getIdCredSec(record.providerIndex, record.identityIndex).toString('hex'), timestamp: 0,
  }).value.idCredPub;
  assert.notEqual(record.identityObject.value.preIdentityObject.idCredPub, theirs, 'not another seed phrase\'s');
});
