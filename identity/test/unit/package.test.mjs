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

test('the listener entry point loads separately, and the main entry does not load it', async () => {
  const listener = await import('@concordium/wdk-identity-concordium/listener');
  assert.equal(typeof listener.listenForIdentityCallback, 'function');
  const main = await import('@concordium/wdk-identity-concordium');
  assert.equal(main.listenForIdentityCallback, undefined);
  // Only the listener uses Node's web server, so the main entry stays usable without one.
  const { readdirSync } = await import('node:fs');
  const sources = ['index.js', ...readdirSync(new URL('src/', packageRoot)).map((name) => `src/${name}`)];
  const usingHttp = sources.filter((file) => /from 'node:http'/.test(readFileSync(new URL(file, packageRoot), 'utf8')));
  assert.deepEqual(usingHttp, ['src/callback-listener.js']);
  assert.doesNotMatch(readFileSync(new URL('index.js', packageRoot), 'utf8'), /callback-listener/);
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
