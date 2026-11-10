/**
 * Live (testnet), read-only: runs part 2 of the resume-after-restart sample (examples/resume-after-restart.mjs) as
 * a fresh start would, and reads what it prints. Part 1 needs a person to fill in the provider's page, so the test
 * gives part 2 what part 1 would have saved: the reply for the recorded identity (the public "abandon" phrase,
 * provider 0, identity 334563111), whose code_uri the testnet provider still answers. Nothing is sent to the chain
 * and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * Who is who:
 *   WALLET    the sample, started fresh: a new identity object from the public demonstration phrase
 *   PROVIDER  Concordium's testnet identity provider (index 0), which serves the issued identity at its code_uri
 *
 *   WALLET (fresh start)                                    PROVIDER
 *   ────────────────────                                    ────────
 *   4. reads the reply saved before the restart
 *   5. collects the identity from its code_uri ───────────► the issued identity
 *      and checks it is this seed's
 *   6. keeps it (exported, encrypted), deletes the saved reply
 *   then, started again with nothing saved: says to run part 1 first
 *
 * The steps are the sample's own numbers (it prints them); the test reads what it prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);

// What part 1 saves for the recorded identity: its code_uri and the numbers the request was made for.
const SAVED_REPLY = {
  codeUri: 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a',
  providerIndex: 0,
  identityIndex: 334563111,
};

/** Run part 2 of the sample with this folder; returns what it printed and how it ended. */
async function resume(folder) {
  const env = { ...process.env, IDENTITY_FOLDER: folder };
  delete env.SEED_PHRASE; // the sample's public demonstration phrase
  try {
    const { stdout, stderr } = await run(process.execPath, ['examples/resume-after-restart.mjs', 'resume'], {
      cwd: packageRoot, env, timeout: 180_000,
    });
    return { ok: true, output: stdout + stderr };
  } catch (e) {
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Steps 4-6, then a second start with nothing saved. Read-only.
test('the resume-after-restart sample: a fresh start collects the identity from the saved reply', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'resume-sample-'));
  try {
    const pendingFile = join(folder, 'pending-identity.json');
    writeFileSync(pendingFile, JSON.stringify(SAVED_REPLY));

    const first = await resume(folder);
    assert.ok(first.ok, `the sample should succeed; it printed:\n${first.output}`);
    assert.match(first.output, /A verification is waiting: provider 0, identity 334563111/, 'step 4: the saved reply is read');
    assert.match(first.output, /validTo: '202709'/, 'step 5: the identity is collected');
    assert.match(first.output, /6\. Kept \(encrypted\)/, 'step 6: it is kept');

    const kept = join(folder, 'testnet-0-334563111.txt');
    assert.ok(existsSync(kept), 'the exported identity is kept in the folder');
    const text = readFileSync(kept, 'utf8');
    const details = /John|Doe|19700101/; // the test form's details, which a plain export would show
    assert.ok(!details.test(text) && !details.test(Buffer.from(text, 'base64').toString('latin1')),
      'the kept text reveals none of the details, even decoded');
    assert.ok(!existsSync(pendingFile), 'the saved reply is deleted once the identity is kept');

    const second = await resume(folder);
    assert.equal(second.ok, false, 'with nothing saved, there is nothing to continue');
    assert.match(second.output, /run part 1 first/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
