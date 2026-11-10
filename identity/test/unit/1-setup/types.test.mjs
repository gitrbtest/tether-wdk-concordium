/** The published type declarations, as a TypeScript wallet uses them; no external services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

test("the configuration's types accept Concordium's real node clients (Node.js and browser)", async () => {
  const tsc = fileURLToPath(new URL('node_modules/typescript/bin/tsc', new URL('../../../', import.meta.url)));
  try {
    await promisify(execFile)(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck',
      '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022',
      'test/fixtures/types/real-node-client.ts'], { cwd: packageRoot, timeout: 120_000 });
  } catch (e) {
    assert.fail(`the types should accept them; TypeScript said:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
});
