/** Identity configuration and presets; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
  parseIdentityConfig,
} from '../../src/config.js';

test('a configuration with a wallet-proxy URL is required', () => {
  for (const config of [undefined, null, 'https://wallet-proxy.example', [], {}]) {
    assert.throws(() => parseIdentityConfig(config), /walletProxyUrl/);
  }
});

test('wallet-proxy URLs must be absolute HTTP(S) URLs', () => {
  for (const walletProxyUrl of ['', '   ', 'wallet-proxy.example', 'ftp://wallet-proxy.example', 42]) {
    assert.throws(() => parseIdentityConfig({ walletProxyUrl }), /must be an absolute HTTP\(S\) URL/);
  }
});

test('wallet-proxy URLs carry no credentials, query parameters or fragments', () => {
  for (const walletProxyUrl of [
    'https://user:secret@wallet-proxy.example',
    'https://wallet-proxy.example/?token=abc',
    'https://wallet-proxy.example/#section',
  ]) {
    assert.throws(() => parseIdentityConfig({ walletProxyUrl }), /must not contain credentials/);
  }
});

test('error messages never repeat the configured URL', () => {
  try {
    parseIdentityConfig({ walletProxyUrl: 'https://user:secret@wallet-proxy.example' });
    assert.fail('expected an error');
  } catch (e) {
    assert.doesNotMatch(e.message, /secret/);
  }
});

test('a base path is kept and trailing slashes are removed', () => {
  assert.equal(parseIdentityConfig({ walletProxyUrl: 'https://wallet-proxy.example/' }).walletProxyUrl,
    'https://wallet-proxy.example');
  assert.equal(parseIdentityConfig({ walletProxyUrl: 'https://proxy.example/concordium//' }).walletProxyUrl,
    'https://proxy.example/concordium');
});

test('the public presets are valid and can be overridden', () => {
  for (const preset of [CONCORDIUM_MAINNET_IDENTITY_CONFIG, CONCORDIUM_TESTNET_IDENTITY_CONFIG]) {
    assert.equal(parseIdentityConfig(preset).walletProxyUrl, preset.walletProxyUrl);
  }
  const custom = parseIdentityConfig({ ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, walletProxyUrl: 'https://my-proxy.example' });
  assert.equal(custom.walletProxyUrl, 'https://my-proxy.example');
});
