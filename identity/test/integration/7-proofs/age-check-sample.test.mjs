/**
 * Live (testnet), read-only: runs the age-check sample (examples/age-check.mjs) as a person would, and reads what
 * it prints. It tells us if the whole story stops working: the shop's question, the wallet getting its identities
 * back and answering, the shop's check against the chain, and the shop refusing the same answer a second time.
 * Nothing is sent to the chain and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * Who is who:
 *   SHOP       the website asking "are you over 18?" (version 0: no account, no fee), on its server
 *   WALLET     a "new phone": only the sample's public demonstration seed phrase. Its identity 0 has expired;
 *              identity 1's account 46aPXi34… answers
 *   PROVIDERS  the testnet identity providers, which give the identities back (recovery)
 *
 *   SHOP                          WALLET (new phone)                   PROVIDERS / TESTNET CHAIN
 *   ────                          ──────────────────                   ─────────────────────────
 *   1. asks "over 18?" ─────────► 2. shows the person the question
 *                                 3. gets its identities back ───────► providers (recoverAll)
 *                                    from the seed phrase only
 *                                 4. finds an account that can truly answer: identity 0 cannot (expired),
 *                                    identity 1's account 46aPXi34… can
 *   6. checks the answer ◄─────── 5. answers with a proof
 *      against the chain ────────────────────────────────────────────► chain: accepted
 *   7. the same answer arrives again: refused ("already answered")
 *
 * The steps are the sample's own numbers (examples/age-check.mjs prints them); the test reads what it prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Steps 1-7: the sample run as a person would. Read-only.
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
