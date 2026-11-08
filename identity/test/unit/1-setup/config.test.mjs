/** Identity configuration and presets; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
  parseIdentityConfig,
} from '../../../src/shared/config.js';
import { ipInfoFixture, recordedNode } from '../../helpers.mjs';

/** A valid configuration (with the recorded provider list and a pretend node), to vary one field at a time. */
const VALID = { useMainnetKeyDerivation: false, identityProviders: ipInfoFixture('testnet'), node: recordedNode('testnet') };

test('a configuration object is required', () => {
  for (const config of [undefined, null, 'https://wallet-proxy.example', []]) {
    assert.throws(() => parseIdentityConfig(config), /A configuration with useMainnetKeyDerivation, identityProviders and node is required/);
  }
});

test('a boolean key-derivation choice is required', () => {
  for (const useMainnetKeyDerivation of [undefined, 'true', 1, null]) {
    assert.throws(() => parseIdentityConfig({ ...VALID, useMainnetKeyDerivation }), /useMainnetKeyDerivation is required and must be a boolean/);
  }
});

test('the derivation choice selects the SDK derivation network', () => {
  assert.equal(parseIdentityConfig({ ...VALID, useMainnetKeyDerivation: true }).derivationNetwork, 'Mainnet');
  assert.equal(parseIdentityConfig({ ...VALID, useMainnetKeyDerivation: false }).derivationNetwork, 'Testnet');
});

test('the public presets, plus the provider list and the node, make a configuration', () => {
  const complete = (preset, network) => ({ ...preset, identityProviders: ipInfoFixture(network), node: recordedNode(network) });
  assert.equal(parseIdentityConfig(complete(CONCORDIUM_MAINNET_IDENTITY_CONFIG, 'mainnet')).derivationNetwork, 'Mainnet');
  assert.equal(parseIdentityConfig(complete(CONCORDIUM_TESTNET_IDENTITY_CONFIG, 'testnet')).derivationNetwork, 'Testnet');
  for (const preset of [CONCORDIUM_MAINNET_IDENTITY_CONFIG, CONCORDIUM_TESTNET_IDENTITY_CONFIG]) {
    assert.deepEqual(Object.keys(preset), ['useMainnetKeyDerivation'], 'a preset holds only the key derivation choice');
    assert.throws(() => parseIdentityConfig(preset), /identityProviders is required/, 'a preset alone has no provider list');
  }
});

test('walletProxyUrl is refused with a clear pointer: the package talks to the chain only through the node', () => {
  assert.throws(() => parseIdentityConfig({ ...VALID, walletProxyUrl: 'https://wallet-proxy.testnet.concordium.com' }),
    /config\.walletProxyUrl is no longer used: .*config\.node/);
});

test('the node connection is required, and must be a Concordium node client', () => {
  assert.throws(() => parseIdentityConfig({ ...VALID, node: undefined }), /config\.node is required: a connection to a Concordium node/);
  assert.throws(() => parseIdentityConfig({ ...VALID, node: 'https://grpc.testnet.concordium.com:20000' }), /config\.node is required/);
  assert.throws(() => parseIdentityConfig({ ...VALID, node: {} }), /config\.node has no getCryptographicParameters\(\)/);
  const { getBlockItemStatus, ...missingOne } = recordedNode('testnet');
  assert.throws(() => parseIdentityConfig({ ...VALID, node: missingOne }), /config\.node has no getBlockItemStatus\(\)/);
  assert.equal(parseIdentityConfig(VALID).node, VALID.node, 'the wallet\'s own client is used as it is');
});
