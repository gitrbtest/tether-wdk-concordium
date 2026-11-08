/**
 * Live (testnet), WRITE=1 only: creates a real account on testnet from the recorded test identity, through
 * the wallet's node connection (Concordium's public testnet node), and checks independently, with the testnet
 * wallet-proxy, that it exists on chain. Creating an account is free (no CCD is spent), but the account is
 * permanent, so this runs only when asked:
 *
 *   WRITE=1 npm run test:integration            (PowerShell: $env:WRITE="1"; npm run test:integration)
 *
 * The identity is the one recorded in test/fixtures: the public "abandon" test phrase, provider 0, identity
 * index 334563111, issued by the Concordium testnet identity provider.
 *
 * Which accounts this test creates: account numbers 100–199 of that identity are reserved for it. Each run
 * creates the first unused one (100, then 101, …), so the test's accounts are easy to recognise; 0–99 are
 * left for samples and demos. When all 100 are used, the test fails and says so: then record a new identity.
 * (The very first run, on 28 Oct 2026, created account 51, before this range was set.)
 *
 * Who is who:
 *   WALLET        holds the recorded identity (provider 0, identity 334563111) and the seed
 *   NODE          Concordium's public testnet node: the package's only way to the chain
 *   WALLET-PROXY  Concordium's testnet wallet-proxy, asked directly by the test as a second opinion (the package
 *                 never uses it)
 *
 *   WALLET                                  NODE / TESTNET CHAIN                  WALLET-PROXY (second opinion)
 *   ──────                                  ────────────────────                  ─────────────────────────────
 *   1. holds the identity (waitForIdentity, from the recorded reply)
 *   2. createAccount, account 100, 101, …:
 *      does it exist? ────────────────────► yes: returned as it is, nothing sent
 *                                           no:  the first unused number is created ↓
 *   3. builds and signs the credential (keys from the seed; nothing about the person shown)
 *   4. sends it ───────────────────────────► received
 *   5. follows it until final ─────────────► committed → finalized: the account is created (0 CCD, free)
 *   6. the test asks the wallet-proxy directly ───────────────────────────────► the account exists, 0 CCD ✔
 *   7. createAccount again, same number ───► it exists: returned, nothing sent
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { liveTestnetConfig } from '../../helpers.mjs';

const WRITE = process.env.WRITE === '1';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ISSUED_FOR = { providerIndex: 0, identityIndex: 334563111 };
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const recordedReply = () => JSON.parse(readFileSync(new URL('../../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
// A second opinion, independent of the package (which only talks to the node): the wallet-proxy's own view.
const WALLET_PROXY = 'https://wallet-proxy.testnet.concordium.com';
/** The account numbers reserved for this test (the identity allows 0–199). */
const TEST_ACCOUNTS = { first: 100, last: 199 };

/** The account's balances from the wallet-proxy: `{}` when it does not exist. Asked directly, not through the package. */
async function balancesOf(address) {
  const response = await fetch(`${WALLET_PROXY}/v0/accBalance/${address}`);
  assert.ok(response.ok, `wallet-proxy answered HTTP ${response.status}`);
  return response.json();
}

// Steps 1-7: one new account each run (WRITE=1 only; free, but permanent).
test('a real account is created on testnet from the identity, and exists on chain', { skip: !WRITE && 'set WRITE=1 to create a testnet account' }, async () => {
  // The recorded identity is collected through the real waitForIdentity path; everything else goes to testnet.
  const fetchVia = async (url, options) => (url === CODE_URI
    ? { ok: true, status: 200, json: async () => recordedReply() }
    : fetch(url, options));
  const identity = new ConcordiumIdentity(PHRASE, await liveTestnetConfig(), { fetch: fetchVia });
  try {
    await identity.waitForIdentity(CODE_URI, { ...ISSUED_FOR, intervalMs: 10 });

    // The first unused test account number. createAccount itself finds the used ones: for an account that
    // already exists it returns created: false and sends nothing, so this also exercises that path.
    let account;
    const started = Date.now();
    for (let credNumber = TEST_ACCOUNTS.first; credNumber <= TEST_ACCOUNTS.last; credNumber++) {
      account = await identity.createAccount({ ...ISSUED_FOR, credNumber });
      if (account.created) break;
    }
    assert.ok(account.created, `All test accounts (${TEST_ACCOUNTS.first}–${TEST_ACCOUNTS.last}) of identity `
      + `${ISSUED_FOR.identityIndex} are used: record a new test identity to keep creating accounts.`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  account ${account.credNumber}: ${account.address} (created in ${seconds} s, transaction ${account.transactionHash})`);
    console.log(`  https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${account.address}`);

    assert.equal(account.path, `0/334563111/${account.credNumber}`);
    assert.match(account.transactionHash, /^[0-9a-f]{64}$/);
    assert.match(account.blockHash, /^[0-9a-f]{64}$/);
    const balances = await balancesOf(account.address);
    assert.ok(balances.finalizedBalance, 'the account exists on chain (the wallet-proxy has its balance)');
    assert.equal(balances.finalizedBalance.accountAmount, '0', 'a new account starts with 0 CCD');

    // Asking again for the same account: it is found, nothing is sent.
    const again = await identity.createAccount({ ...ISSUED_FOR, credNumber: account.credNumber });
    assert.deepEqual({ created: again.created, address: again.address }, { created: false, address: account.address });
  } finally {
    identity.dispose();
  }
});
