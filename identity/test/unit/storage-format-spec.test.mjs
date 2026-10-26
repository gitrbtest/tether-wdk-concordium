/**
 * docs/storage-format.md is exact: an independent reader written from the document alone, using
 * Node's own crypto (not the package's), decrypts the version-1 test vector (the golden file).
 * If the code or the document changes and they disagree, this fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SLOT = 'concordium-identity/testnet/0/334563111';
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

/** The documented reader: key by HKDF-SHA256, AES-256-GCM with the header and slot name as additional data. */
function readAsDocumented(bytes, seed, network, slotName) {
  const key = Buffer.from(hkdfSync('sha256', seed, Buffer.from('concordium-wdk-identity-storage v1'), Buffer.from(network), 32));
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(5, 17));
  decipher.setAAD(Buffer.concat([bytes.subarray(0, 5), Buffer.from(slotName)]));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(17, bytes.length - 16)), decipher.final()]).toString('utf8'));
}

test('the documented format decrypts the test vector to the recorded identity', () => {
  const seed = Buffer.from(sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet').seedAsHex, 'hex');
  const bytes = fixture('golden/identity-v1.bin');
  assert.equal(bytes.subarray(0, 4).toString(), 'CWID');
  assert.equal(bytes[4], 1);

  const record = readAsDocumented(bytes, seed, 'testnet', SLOT);
  assert.equal(record.v, 1);
  assert.equal(record.providerIndex, 0);
  assert.equal(record.identityIndex, 334563111);
  assert.deepEqual(record.identityObject, JSON.parse(fixture('identity-done.testnet.json')).token.identityObject);
});

test('as documented, another slot name or network cannot decrypt it', () => {
  const seed = Buffer.from(sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet').seedAsHex, 'hex');
  const bytes = fixture('golden/identity-v1.bin');
  assert.throws(() => readAsDocumented(bytes, seed, 'testnet', 'concordium-identity/testnet/0/7'));
  assert.throws(() => readAsDocumented(bytes, seed, 'mainnet', SLOT));
});
