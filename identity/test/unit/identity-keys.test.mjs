/** ConcordiumIdentity: seed, configuration and key derivation; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@concordium/web-sdk';
import ConcordiumIdentity from '../../src/ConcordiumIdentity.js';
import { CONCORDIUM_MAINNET_IDENTITY_CONFIG, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '../../src/shared/config.js';

/** The public all-"abandon" BIP-39 test phrase (no value is ever held under it on mainnet). */
const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Its 64-byte BIP-39 seed. */
const TEST_SEED_BYTES = Buffer.from(sdk.ConcordiumHdWallet.fromSeedPhrase(TEST_PHRASE, 'Testnet').seedAsHex, 'hex');

test('a seed phrase and its 64-byte seed give the same identity keys', () => {
  const fromPhrase = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  const fromBytes = new ConcordiumIdentity(Uint8Array.from(TEST_SEED_BYTES), CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  assert.equal(fromPhrase._hdWallet.getIdCredSec(0, 0).toString('hex'), fromBytes._hdWallet.getIdCredSec(0, 0).toString('hex'));
});

test('keys follow the configured derivation network', () => {
  const testnet = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  const mainnet = new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_MAINNET_IDENTITY_CONFIG);
  assert.equal(testnet._hdWallet.getIdCredSec(0, 0).toString('hex'),
    sdk.ConcordiumHdWallet.fromSeedPhrase(TEST_PHRASE, 'Testnet').getIdCredSec(0, 0).toString('hex'));
  assert.notEqual(testnet._hdWallet.getIdCredSec(0, 0).toString('hex'), mainnet._hdWallet.getIdCredSec(0, 0).toString('hex'));
});

test('an invalid seed phrase is rejected', () => {
  for (const phrase of ['hello world', 'abandon '.repeat(12).trim(), '']) {
    assert.throws(() => new ConcordiumIdentity(phrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG), /^Error: Invalid seed phrase\.$/);
  }
});

test('a raw seed must be exactly 64 bytes, and the error never repeats it', () => {
  for (const seed of [new Uint8Array(32).fill(7), new Uint8Array(65).fill(7), [1, 2, 3], 42, undefined]) {
    assert.throws(() => new ConcordiumIdentity(seed, CONCORDIUM_TESTNET_IDENTITY_CONFIG), (e) => {
      assert.equal(e.message, 'The seed must be a BIP-39 seed phrase or a 64-byte seed.');
      assert.doesNotMatch(e.message, /0707/);
      return true;
    });
  }
});

test('the configuration is checked before the seed', () => {
  assert.throws(() => new ConcordiumIdentity('not a valid phrase', { walletProxyUrl: 'https://wallet-proxy.example' }),
    /useMainnetKeyDerivation is required/);
});

test('the identity keeps its own copy of a raw seed', () => {
  const seed = Uint8Array.from(TEST_SEED_BYTES);
  const identity = new ConcordiumIdentity(seed, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  const before = identity._hdWallet.getIdCredSec(0, 0).toString('hex');
  seed.fill(0); // the caller reuses or wipes its own array
  assert.equal(identity._hdWallet.getIdCredSec(0, 0).toString('hex'), before);
});
