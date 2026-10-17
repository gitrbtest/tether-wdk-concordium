/** Package setup: entry point, published files and alignment with the wallet package; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const packageRoot = new URL('../../', import.meta.url);
const repositoryRoot = new URL('../', packageRoot);
const readManifest = (root) => JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const manifest = readManifest(packageRoot);
const walletManifest = readManifest(repositoryRoot);

test('the package entry point loads', async () => {
  const api = await import('@concordium/wdk-identity-concordium');
  assert.equal(typeof api, 'object');
});

test('every file the package would publish exists', () => {
  const entries = [manifest.main, manifest.types, ...manifest.files];
  for (const entry of entries) {
    assert.ok(existsSync(new URL(entry, packageRoot)), `${entry} exists`);
  }
});

test('the package supports the same Node.js versions as the wallet package', () => {
  assert.equal(manifest.engines.node, walletManifest.engines.node,
    'keep engines.node in identity/package.json and the root package.json in line');
});
