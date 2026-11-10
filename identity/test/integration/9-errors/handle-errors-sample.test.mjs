/**
 * Live (testnet), read-only: runs the handle-errors sample (examples/handle-errors.mjs) and reads what it prints.
 * It tells us if an error stops having the name and reason a wallet acts on (the tables in chapter 10 of the
 * integration guide), or stops being refused before anything is sent. Every call in the sample is refused before
 * sending, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * Who is who:
 *   WALLET    the sample, with the public demonstration phrase: its identity 334563111 (valid, account 0 with no
 *             CCD or TN) and identity 0 (someone else's on the shared phrase, expired in 2026-02); and a second
 *             public phrase as "another wallet"
 *   TESTNET   provider 0 (gives the two identities back) and the node (accounts, balances, fees)
 *
 *   WALLET                                                      TESTNET
 *   ──────                                                      ───────
 *   1. gets the two identities back ◄────────────────────────── provider 0
 *   2. makes each error happen (each refused before anything is sent) ◄── reads only
 *   3. turns each into a message for the user (whatToTellTheUser)
 *
 * The steps are the sample's own numbers (it prints them); the test reads what it prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Each error the sample makes happen: its name and reason, as printed.
const EXPECTED = [
  'IdentityProviderError:',
  'IdentityIssuanceError (provider-error)',
  'IdentityIssuanceError (cancelled)',
  'IdentityStorageError (unreadable)',
  'IdentityStorageError (not-yours)',
  'AccountCreationError (max-accounts)',
  'AccountCreationError (unknown-attribute)',
  'AccountCreationError (identity-expired)',
  'ProofError (not-held)',
  'ProofError (cannot-prove)',
  'ProofError (identity-expired)',
  'AccountNotCreatedError:',
  'ConcordiumTransferError (INSUFFICIENT_TOKEN_BALANCE)',
  'TransactionError (INSUFFICIENT_BALANCE)',
];

// Steps 1-3: the sample run as a developer would. Read-only.
test('the handle-errors sample: every error has its name and reason, and a message for the user', async () => {
  let output;
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['examples/handle-errors.mjs'], {
      cwd: packageRoot, timeout: 180_000,
    });
    output = stdout + stderr;
  } catch (e) {
    assert.fail(`the sample should succeed; it printed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  assert.match(output, /identity 0: valid until 2026-02/, 'step 1: the expired identity is back');
  for (const expected of EXPECTED) {
    assert.ok(output.includes(`  ${expected}`), `step 2: ${expected}`);
  }
  const messages = output.match(/→ tell the user: "/g) ?? [];
  assert.equal(messages.length, EXPECTED.length, 'step 3: a message for every error');
  assert.ok(!output.includes('no error: this should not happen'), 'every call is refused');
  assert.ok(!output.includes('Something went wrong. Please try again later.'), 'no error falls through to the generic message');
  assert.match(output, /Nothing was sent\./, 'the refused transfer was not sent');
});
