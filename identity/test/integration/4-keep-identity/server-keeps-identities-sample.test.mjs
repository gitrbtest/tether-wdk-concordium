/**
 * Live (testnet), read-only: runs the server-keeps-identities sample (examples/server-keeps-identities.mjs) as a
 * server operator would, and reads what it prints. It gets one identity back from the testnet provider; nothing is
 * sent to the chain and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * Who is who:
 *   SERVER    a wallet run on a server, with a users table and a key vault holding each user's seed phrase
 *   ALICE     a user whose seed phrase is the public "abandon" phrase; her identity: provider 0, identity 334563111
 *   BOB       a second user, with another public phrase and no identity
 *   PROVIDER  Concordium's testnet identity provider (index 0)
 *
 *   SERVER                                                          PROVIDER
 *   ──────                                                          ────────
 *   1. Alice's identity arrives ◄────────────────────────────────── her issued identity
 *   2. kept as text in Alice's record (none of her details readable in it)
 *   3. later: Alice's seed phrase reads it back
 *   4. Alice's text in Bob's record: Bob's seed phrase cannot read it
 *   5. Alice's record and seed phrase deleted: only Bob is left
 *
 * The steps are the sample's own numbers (it prints them); the test reads what it prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Steps 1-5: the sample run as an operator would. Read-only.
test('the server-keeps-identities sample: one record per user, readable only with that user\'s seed phrase', async () => {
  let output;
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['examples/server-keeps-identities.mjs'], {
      cwd: packageRoot, timeout: 180_000,
    });
    output = stdout + stderr;
  } catch (e) {
    assert.fail(`the sample should succeed; it printed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  assert.match(output, /provider 0, identity 334563111, valid until 202709/, 'step 1: the identity arrives');
  assert.match(output, /alice\s+\d+ characters/, "step 2: kept in Alice's record");
  assert.match(output, /name or birth date in it\? no: it is encrypted/, 'step 2: none of her details are readable');
  assert.match(output, /3\. [^\n]*\n\s+✔ provider 0, identity 334563111: ready to use/, 'step 3: read back with her seed phrase');
  assert.match(output, /✔ refused \(unreadable\): Bob's seed phrase cannot read Alice's identity/, "step 4: Bob cannot read it");
  assert.match(output, /users: bob; Alice's identity is gone from the server/, 'step 5: her record is deleted');
});
