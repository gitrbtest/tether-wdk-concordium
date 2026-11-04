/**
 * Live (testnet), read-only: runs the age-check sample (examples/age-check.mjs) as a person would, and reads what
 * it prints. It tells us if the whole story stops working: the shop's question, the wallet getting its identities
 * back and answering, the shop's check against the chain, and the shop refusing the same answer a second time.
 * Nothing is sent to the chain and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

test('the age-check sample: accepted once on testnet, then the same answer refused', async () => {
  const env = { ...process.env };
  delete env.SEED_PHRASE; // the sample's public demonstration phrase
  const { stdout } = await promisify(execFile)(process.execPath, ['examples/age-check.mjs'], {
    cwd: packageRoot, env, timeout: 180_000,
  });
  assert.match(stdout, /at least 18 years old/, 'the question, in plain English');
  assert.match(stdout, /identity 0: cannot answer/, 'the expired identity is not used');
  assert.match(stdout, /chosen: 46aPXi34/, "identity 1's account answers");
  assert.match(stdout, /6\. [^\n]*\n\s+✔ over 18 \(account 46aPXi34/, 'the first answer is accepted');
  assert.match(stdout, /7\. [^\n]*\n\s+✖ refused: this question was already answered/, 'the copy is refused');
});
