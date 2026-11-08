/**
 * Live (testnet), read-only: runs the company identity samples (examples/company-identity/) as a person would, and
 * reads what they print. It tells us if the company path stops working: Global FinReg no longer listed as a Business ID
 * provider, its company page no longer opening for our requests, or company questions no longer read and refused as
 * they should. Nothing is written to the chain and nothing is spent.
 *
 *   npm run test:integration
 *
 * Who is who:
 *   COMPANY'S WALLET  the public demonstration phrase, asking Global FinReg (testnet provider 4) for a Business ID
 *   PERSON'S WALLET   the same phrase's identity 1 with provider 0 (a person's identity)
 *   BANK              played by the sample: asks a company question
 *
 *   COMPANY'S WALLET                       GLOBAL FINREG / TESTNET           BANK
 *   ────────────────                       ───────────────────────           ────
 *   1. list the providers ───────────────► the /v2 lists: Global FinReg is the company provider (testnet 4, mainnet 3)
 *   2. build the request, open the link ─► its company verification page opens (CHECK_ONLY: stop)
 *   3. the consent screen ◄──────────────────────────────────────────────── "show your LEI, legal name; registered in
 *      "show the company's LEI" …                                            the EU"
 *   4. PERSON'S WALLET, the same question: refused (not an accepted provider; no LEI)
 *
 * Steps 1-2: Global FinReg can stop working on its side; the test then says so, and npm run check:providers shows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
/** Run a sample as a person would, without the settings that change it; returns what it printed. */
async function run(sample, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ['SEED_PHRASE', 'PROVIDER_INDEX', 'IDENTITY_INDEX']) delete env[name];
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [`examples/company-identity/${sample}`], { cwd: packageRoot, env, timeout: 180_000 });
    return stdout;
  } catch (e) {
    // Say what the sample printed: a provider that is briefly down shows up here, in its own words.
    throw new Error(`${sample} failed (exit ${e.code}):\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
}

// Step 1.
test('company sample: Global FinReg is listed as the company (Business ID) provider on testnet and mainnet', async () => {
  const out = await run('list-business-id-providers.mjs');
  assert.match(out, /testnet:[\s\S]*\n\s+4\s+Global FinReg Testnet\s+company \(Business ID\)/);
  assert.match(out, /mainnet:[\s\S]*\n\s+3\s+Global FinReg\s+company \(Business ID\)/);
  assert.match(out, /Concordium testnet IP\s+person/);
});

// Step 2.
test('company sample: the company\'s request opens Global FinReg\'s company verification page', async () => {
  const out = await run('verify-company-identity.mjs', { CHECK_ONLY: '1' });
  assert.match(out, /1\. The company's provider: 4 Global FinReg Testnet/);
  assert.match(out, /3\. The company verification page opens at \S+/);
  assert.match(out, /CHECK_ONLY: stopping here/);
});

// Steps 3-4.
test('company sample: the bank\'s question reads "the company"; a person\'s wallet refuses it', async () => {
  const out = await run('company-questions.mjs');
  assert.match(out, /"prove the company is registered in one of: the 27 EU countries \(without showing which\)"/);
  assert.match(out, /"show the company's legal entity identifier \(LEI\)"/);
  assert.match(out, /accounts that can answer: 0/);
  assert.match(out, /refused \(provider-not-accepted\)/);
  assert.match(out, /refused \(cannot-prove\): The identity has no legal entity identifier \(LEI\)/);
});
