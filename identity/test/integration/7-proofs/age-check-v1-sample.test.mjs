/**
 * Live (testnet), WRITE=1 only: runs the version 1 age-check sample (examples/age-check-v1.mjs) as a person would,
 * and reads what it prints. It tells us if the whole story stops working. Each run records a question on chain
 * (one anchor fee, about EUR 0.013, paid by the sponsor, account 11 of the public test phrase's identity 334563111;
 * keep it funded), so it runs only when asked:
 *
 *   WRITE=1 npm run test:integration            (PowerShell: $env:WRITE="1"; npm run test:integration)
 *
 * Who is who:
 *   SHOP       account 13  4rEgz…WSX1  holds 0 CCD: asks, and sends the anchor
 *   SPONSOR    account 11  4kJZH…9fTU  pays the anchor's fee
 *   WALLET     a "new phone": only the sample's public demonstration seed phrase. Its identity 0 has expired;
 *              identity 1 answers, from the identity itself (no account)
 *
 *   SHOP (13) + SPONSOR (11)                  TESTNET CHAIN                  WALLET (new phone)
 *   ────────────────────────                  ─────────────                  ──────────────────
 *   1. asks, records the question ──────────► anchor; the fee from 11
 *      sends the question ──────────────────────────────────────────────────► 2. shows it, and who asks
 *                                                                             3. gets its identities back
 *                                                                             4. identity 0 cannot (expired),
 *                                             anchor final? ◄──────────────── 5. identity 1 answers (no account)
 *   6. checks the answer ◄─────────────────────────────────────────────────── the answer
 *      accepted; keeps the audit record
 *   7. the same answer arrives again: refused ("already answered")
 *
 * The steps are the sample's own numbers (it prints them); the test reads what it prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const WRITE = process.env.WRITE === '1';
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Steps 1-7: the sample run as a person would (WRITE=1 only: spends one anchor fee).
test('the V1 age-check sample: a sponsored question, answered from the identity once, then the copy refused', { skip: !WRITE && 'set WRITE=1 to record a question on testnet' }, async () => {
  const env = { ...process.env };
  for (const name of ['SEED_PHRASE', 'SHOP_ADDRESS', 'SHOP_SIGNING_KEY', 'SPONSOR_ADDRESS', 'SPONSOR_SIGNING_KEY']) delete env[name];
  const { stdout } = await promisify(execFile)(process.execPath, ['examples/age-check-v1.mjs'], {
    cwd: packageRoot, env, timeout: 240_000,
  });
  assert.match(stdout, /fee: [\d.]+ CCD, paid by the sponsor 4kJZHvmL…; the shop paid nothing/, 'the sponsor paid');
  assert.match(stdout, /age-check\.example \(age check\) asks:/, 'who is asking');
  assert.match(stdout, /at least 18 years old/, 'the question, in plain English');
  assert.match(stdout, /identity 0: cannot answer \(identity-expired\)/, 'the expired identity is not used');
  assert.match(stdout, /identity 1: answers/);
  assert.match(stdout, /6\. [^\n]*\n\s+✔ over 18 \(an identity from provider 0; no account named\)/, 'the answer is accepted');
  assert.match(stdout, /7\. [^\n]*\n\s+✖ refused: this question was already answered/, 'the copy is refused');
});
