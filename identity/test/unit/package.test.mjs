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

test('the optional Node.js extras load from their own entry point, and the main entry does not load them', async () => {
  const extras = await import('@concordium/wdk-identity-concordium/node');
  assert.equal(typeof extras.listenForIdentityCallback, 'function');
  const main = await import('@concordium/wdk-identity-concordium');
  assert.equal(main.listenForIdentityCallback, undefined);

  // Node-only code (web server, file system) lives in src/node, so the main entry stays usable without it.
  const { readdirSync } = await import('node:fs');
  const sourcesIn = (dir) => readdirSync(new URL(dir, packageRoot), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? sourcesIn(`${dir}${entry.name}/`) : [`${dir}${entry.name}`]));
  const nodeOnly = ['index.js', ...sourcesIn('src/')]
    .filter((file) => /from 'node:(http|https|net|fs)/.test(readFileSync(new URL(file, packageRoot), 'utf8')));
  assert.ok(nodeOnly.length > 0);
  for (const file of nodeOnly) assert.match(file, /^src\/node\//, `${file} uses Node-only modules outside src/node`);
  for (const file of ['index.js', ...sourcesIn('src/').filter((f) => !f.startsWith('src/node/'))]) {
    assert.doesNotMatch(readFileSync(new URL(file, packageRoot), 'utf8'), /\/node\//, `${file} does not import src/node`);
  }
});

test('the main entry uses no Node.js-only features, so it can run in browsers and mobile runtimes too', async () => {
  const { readdirSync } = await import('node:fs');
  // Everything the main entry loads: index.js and all of src/, except the optional Node extras and the testing tools.
  const sourcesIn = (dir) => readdirSync(new URL(dir, packageRoot), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? sourcesIn(`${dir}${entry.name}/`) : [`${dir}${entry.name}`]));
  const mainEntryFiles = ['index.js', ...sourcesIn('src/')
    .filter((file) => !file.startsWith('src/node/') && !file.startsWith('src/testing/'))];
  assert.ok(mainEntryFiles.includes('src/storage/storage-format.js'), 'the check reaches files in subfolders');
  const nodeOnly = [
    [/\bBuffer\b/, 'Node\'s Buffer (use Uint8Array, and @noble/hashes/utils for hex)'],
    [/\bprocess\.(env|argv|exit|cwd|platform|version|versions|nextTick|on)\b/, 'Node\'s process'],
    [/from ['"](node:[\w/]+|fs|path|os|http|https|net|crypto)['"]/, 'a Node.js built-in module'],
  ];
  for (const file of mainEntryFiles) {
    const code = readFileSync(new URL(file, packageRoot), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // ignore comments: only code counts
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const [pattern, what] of nodeOnly) assert.doesNotMatch(code, pattern, `${file} uses ${what}`);
  }
});

test('testing tools load from their own entry point, and the main entry does not offer them', async () => {
  const testing = await import('@concordium/wdk-identity-concordium/testing');
  assert.equal(typeof testing.verifyIdentityStore, 'function');
  const main = await import('@concordium/wdk-identity-concordium');
  assert.equal(main.verifyIdentityStore, undefined);
  for (const file of ['index.js', 'node-extras.js']) {
    assert.doesNotMatch(readFileSync(new URL(file, packageRoot), 'utf8'), /testing/, `${file} does not load the testing tools`);
  }
});

test('no file at the top of the package is named after a command its scripts run', async () => {
  // On Windows, npm runs scripts through cmd.exe, which looks in the current folder first and runs .js
  // files: a top-level node.js would be opened instead of Node.js itself, and the script does nothing.
  const { readdirSync } = await import('node:fs');
  const commands = new Set(Object.values(manifest.scripts).map((script) => script.trim().split(/\s+/)[0]));
  commands.add('npm').add('npx');
  for (const name of readdirSync(packageRoot)) {
    assert.ok(!commands.has(name.split('.')[0]), `${name} would be run instead of the ${name.split('.')[0]} command`);
  }
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
