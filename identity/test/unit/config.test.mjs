/** Identity configuration and presets; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
  parseIdentityConfig,
} from '../../src/shared/config.js';
import { ipInfoFixture } from '../helpers.mjs';

/** A valid custom configuration, to vary one field at a time (with the recorded provider list the wallet passes in). */
const VALID = { useMainnetKeyDerivation: false, walletProxyUrl: 'https://wallet-proxy.example', identityProviders: ipInfoFixture('testnet') };

test('a configuration object is required', () => {
  for (const config of [undefined, null, 'https://wallet-proxy.example', []]) {
    assert.throws(() => parseIdentityConfig(config), /A configuration with useMainnetKeyDerivation, walletProxyUrl and identityProviders is required/);
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

test('wallet-proxy URLs must be absolute HTTP(S) URLs', () => {
  for (const walletProxyUrl of [undefined, '', '   ', 'wallet-proxy.example', 'ftp://wallet-proxy.example', 42]) {
    assert.throws(() => parseIdentityConfig({ ...VALID, walletProxyUrl }), /must be an absolute HTTP\(S\) URL/);
  }
});

test('wallet-proxy URLs carry no credentials, query parameters or fragments', () => {
  for (const walletProxyUrl of [
    'https://user:secret@wallet-proxy.example',
    'https://wallet-proxy.example/?token=abc',
    'https://wallet-proxy.example/#section',
  ]) {
    assert.throws(() => parseIdentityConfig({ ...VALID, walletProxyUrl }), /must not contain credentials/);
  }
});

test('error messages never repeat the configured URL', () => {
  try {
    parseIdentityConfig({ ...VALID, walletProxyUrl: 'https://user:secret@wallet-proxy.example' });
    assert.fail('expected an error');
  } catch (e) {
    assert.doesNotMatch(e.message, /secret/);
  }
});

test('a base path is kept and trailing slashes are removed', () => {
  assert.equal(parseIdentityConfig({ ...VALID, walletProxyUrl: 'https://wallet-proxy.example/' }).walletProxyUrl,
    'https://wallet-proxy.example');
  assert.equal(parseIdentityConfig({ ...VALID, walletProxyUrl: 'https://proxy.example/concordium//' }).walletProxyUrl,
    'https://proxy.example/concordium');
});

test('the public presets plus the provider list make a configuration, and can be overridden', () => {
  const withList = (preset, network) => ({ ...preset, identityProviders: ipInfoFixture(network) });
  assert.equal(parseIdentityConfig(withList(CONCORDIUM_MAINNET_IDENTITY_CONFIG, 'mainnet')).derivationNetwork, 'Mainnet');
  assert.equal(parseIdentityConfig(withList(CONCORDIUM_TESTNET_IDENTITY_CONFIG, 'testnet')).derivationNetwork, 'Testnet');
  for (const preset of [CONCORDIUM_MAINNET_IDENTITY_CONFIG, CONCORDIUM_TESTNET_IDENTITY_CONFIG]) {
    assert.equal(parseIdentityConfig(withList(preset, 'testnet')).walletProxyUrl, preset.walletProxyUrl);
    assert.throws(() => parseIdentityConfig(preset), /identityProviders is required/, 'a preset alone has no provider list');
  }
  const custom = parseIdentityConfig({ ...withList(CONCORDIUM_TESTNET_IDENTITY_CONFIG, 'testnet'), walletProxyUrl: 'https://my-proxy.example' });
  assert.equal(custom.walletProxyUrl, 'https://my-proxy.example');
  assert.equal(custom.derivationNetwork, 'Testnet');
});
