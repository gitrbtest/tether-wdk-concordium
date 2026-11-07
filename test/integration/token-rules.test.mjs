/**
 * Integration — token rules (regulated tokens) read from the live testnet node. Read-only: nothing is sent.
 * Run with:  npm run test:integration   (needs network and the TESTNET_ settings, as the other live tests)
 *
 * Who is who:
 *   WALLET   the test account (TESTNET_SEED): holds TN, is on no UPEU list
 *   TOKENS   real testnet tokens, managed by others: UPEU "Upwood Test Euro" (an allow list and a deny list),
 *            TN (no lists)
 *
 *   WALLET                                      TESTNET NODE
 *   ──────                                      ────────────
 *   1. getTokenRules('UPEU') ──────────────────► allow list ✔, deny list ✔, not paused; its governance account
 *   2. getTokenAccountStatus('UPEU') ──────────► the test account: on neither list (it may not send or receive UPEU)
 *      getTokenAccountStatus('UPEU', governance) the governance account: on the allow list
 *   3. getTokenRules('TN'), its status ────────► no lists: null; the test account's TN balance
 *
 * The tokens' rules belong to their owners and may change; the test says which token to look at if one does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, ACCOUNT_PATH, KNOWN_ADDRESS, PLT_TOKEN } from './helpers.mjs';

const ALLOW_LISTED = process.env.ALLOW_LISTED_TOKEN || 'UPEU';

// Steps 1-2. Read-only.
test(`token rules on testnet: ${ALLOW_LISTED} keeps an allow list; this account is not on it, its governance account is`, async () => {
  const m = makeManager();
  try {
    const a = await m.getAccountByPath(ACCOUNT_PATH);
    const rules = await a.getTokenRules(ALLOW_LISTED);
    assert.equal(rules.kind, 'plt');
    assert.equal(rules.allowList, true, `${ALLOW_LISTED} no longer keeps an allow list: set ALLOW_LISTED_TOKEN to one that does`);
    assert.match(rules.governanceAccount ?? '', /^[1-9A-HJ-NP-Za-km-z]{50}$/);

    const mine = await a.getTokenAccountStatus(ALLOW_LISTED);
    assert.deepEqual([mine.address, mine.exists, mine.onAllowList], [KNOWN_ADDRESS, true, false]);
    const governance = await a.getTokenAccountStatus(ALLOW_LISTED, rules.governanceAccount);
    assert.equal(governance.onAllowList, true, 'the governance account is on its own allow list');
  } finally {
    m.dispose();
  }
});

// Step 3. Read-only.
test(`token rules on testnet: ${PLT_TOKEN} keeps no lists; this account holds some`, async () => {
  const m = makeManager();
  try {
    const a = await m.getAccountByPath(ACCOUNT_PATH);
    const rules = await a.getTokenRules(PLT_TOKEN);
    assert.deepEqual([rules.allowList, rules.denyList], [false, false]);
    const mine = await a.getTokenAccountStatus(PLT_TOKEN);
    assert.ok(mine.balance > 0n, `expected to hold some ${PLT_TOKEN}`);
    assert.deepEqual([mine.onAllowList, mine.onDenyList], [null, null]);
  } finally {
    m.dispose();
  }
});
