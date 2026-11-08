/**
 * Integration — runs the regulated-token sample (examples/example-regulated-token.mjs) as a person would, and reads
 * what it prints. Read-only: the sample never sends anything. It tells us if the whole story stops working.
 * Run with:  npm run test:integration
 *
 * Who is who:
 *   WALLET     the sample's account (public test phrase, identity 899424164, account 0): holds TN, on no UPEU list
 *   TOKEN      UPEU on testnet (an allow list and a deny list), managed by others
 *   RECIPIENT  UPEU's governance account (on its allow list)
 *
 *   WALLET                                          TESTNET NODE
 *   ──────                                          ────────────
 *   1. getTokenRules(UPEU) ────────────────────────► allow list, deny list, not paused
 *   2. getTokenAccountStatus (this account, recipient) ► this account: on no list; the recipient: on the allow list
 *   3. checkTransfer UPEU ─────────────────────────► refused: no UPEU held, not on the allow list (nothing sent)
 *   4. checkTransfer TN ───────────────────────────► ok, with the fee
 *   5. transfer UPEU ──────────────────────────────► refused before sending (ConcordiumTransferError), no fee
 *   6. getTransaction (a real transfer) ───────────► final, success, fee, block
 *
 * The steps are the sample's own numbers (it prints them). UPEU's rules belong to its issuer and may change: then
 * run the sample with REGULATED_TOKEN set to another token with an allow list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Steps 1-6. Read-only.
test('the regulated-token sample: rules read, a blocked transfer refused before sending, a receipt in WDK\'s words', async () => {
  const env = { ...process.env };
  for (const name of ['REGULATED_TOKEN', 'PLAIN_TOKEN', 'RECIPIENT']) delete env[name];
  const { stdout } = await promisify(execFile)(process.execPath, ['examples/example-regulated-token.mjs'], {
    cwd: packageRoot, env, timeout: 120_000,
  });
  assert.match(stdout, /Upwood Test Euro: paused no, allow list yes, deny list yes/, 'step 1');
  assert.match(stdout, /this account: holds 0 base units; on the allow list no/, 'step 2');
  assert.match(stdout, /the recipient: .*on the allow list yes/, 'step 2');
  assert.match(stdout, /3\. [^\n]*\n\s+✖ no\n\s+INSUFFICIENT_TOKEN_BALANCE: [^\n]*\n\s+SENDER_NOT_ON_ALLOW_LIST: /, 'step 3: every reason');
  assert.match(stdout, /4\. [^\n]*\n\s+✔ yes, fee [\d.]+ CCD/, 'step 4');
  assert.match(stdout, /✖ refused before sending \(INSUFFICIENT_TOKEN_BALANCE\)/, 'step 5');
  assert.match(stdout, /sent: no, and no fee was charged/, 'step 5: nothing sent');
  assert.match(stdout, /final, success true, fee 3\.79251 CCD, block \d+/, 'step 6');
});
