/**
 * checkTransfer: every reason a token transfer would be refused, before anything is sent, offline. The pretend node
 * (test/token-chain.mjs) replays recorded testnet tokens and accounts; each test changes one thing on it.
 *
 * Who is who:
 *   SENDER        the test account (holds TN and CCD; on no UPEU list), unless a test changes it
 *   RECIPIENT     UPEU's governance account (on UPEU's allow list), or one a test adds
 *   SPONSOR       for sponsored transfers: an account that pays the fee instead
 *   PRETEND NODE  the recorded tokens (UPEU: allow + deny list; EURQ: deny list; TN: none) and the fee rates
 *
 *   WALLET: checkTransfer({ token, recipient, amount, sponsorAddress? })        PRETEND NODE
 *   ──────────────────────────────────────────────────────────────────          ────────────
 *   1. the amount: a whole number of base units, above 0?
 *   2. the token: paused? ─────────────────────────────────────────────────────► token state
 *   3. the sender: on chain? holds enough? on the deny list? not on the allow list? ► account state
 *   4. the recipient: on chain? on the deny list? not on the allow list? ──────► account state
 *      (CIS-2 tokens: no lists; a dry run shows whether the token's contract would refuse)
 *   5. the fee, and whether the payer (the sender, or the sponsor) holds enough CCD ► fee rates, CCD balance
 *   → { ok, reasons: every problem found, each with a plain message, fee }; nothing is sent
 *
 * The last test checks that steps 2-4 agree with Concordium's own validateTransfer, on every combination.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@concordium/web-sdk';
import * as plt from '@concordium/web-sdk/plt';
import { InvalidTokenError, ValueError } from '@tetherto/wdk-wallet';
import { ConcordiumTransferErrorReason as R } from '../../../index.js';
import { tokenChain, testAccount, RECORDED, TEST_ACCOUNT, UPEU_GOVERNANCE, NOT_ON_CHAIN } from '../../token-chain.mjs';

const reasonsOf = (result) => result.reasons.map((r) => r.reason);
/** Run checkTransfer with the test account on a pretend node set up by `chain` options. */
async function check(transfer, chain = {}) {
  const node = tokenChain(chain);
  const { account, dispose } = await testAccount(node);
  try {
    return { result: await account.checkTransfer(transfer), node };
  } finally {
    dispose();
  }
}
// The test account holding 5 UPEU and on UPEU's allow list (CBOR of { allowList: true, denyList: false }).
const ALLOWED_HOLDER = { ccd: '50000000', tokens: [{ id: 'UPEU', balance: '5000000', moduleState: { allowList: true, denyList: false } }] };

// Steps 1-5: all is well.
test('checkTransfer: a transfer that can happen: ok, no reasons, the fee; nothing is sent', async () => {
  const { result, node } = await check({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1000000n });
  assert.deepEqual([result.ok, result.reasons], [true, []]);
  assert.ok(result.fee > 0n, 'the fee, from the recorded fee rates');
  assert.ok(node.asked.every((m) => m.startsWith('get')), 'only reads');
});

// Steps 3-4: several problems at once are all listed.
test('checkTransfer: every problem is listed, not only the first (UPEU from the test account)', async () => {
  const { result } = await check({ token: 'UPEU', recipient: UPEU_GOVERNANCE, amount: 1000000n });
  assert.equal(result.ok, false);
  assert.deepEqual(reasonsOf(result), [R.INSUFFICIENT_TOKEN_BALANCE, R.SENDER_NOT_ON_ALLOW_LIST]);
  assert.deepEqual(result.reasons.map((r) => r.message), [
    'This account holds 0 UPEU; 1 is needed.', 'This account is not on UPEU\'s allow list.']);
  assert.deepEqual(result.reasons.map((r) => r.account), [TEST_ACCOUNT, TEST_ACCOUNT]);
});

// Step 4: the recipient.
test('checkTransfer: a recipient not on the allow list, or with no account at all', async () => {
  const outsider = { ccd: '0', tokens: [] };
  const NEWCOMER = '4kJZHvmLwMJjPp58ie7ZZirRkSZL1WLfcKbcrCdBAzweSj9fTU';
  const notListed = await check({ token: 'UPEU', recipient: NEWCOMER, amount: 1000000n },
    { accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER, [NEWCOMER]: outsider } });
  assert.deepEqual(reasonsOf(notListed.result), [R.RECIPIENT_NOT_ON_ALLOW_LIST]);
  assert.equal(notListed.result.reasons[0].account, NEWCOMER);
  const nobody = await check({ token: 'UPEU', recipient: NOT_ON_CHAIN, amount: 1000000n }, { accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER } });
  assert.deepEqual(reasonsOf(nobody.result), [R.RECIPIENT_NOT_FOUND]);
  assert.equal(nobody.result.fee, null, 'no fee is worked out for a transfer to nobody');
});

// Steps 3-4: deny lists.
test('checkTransfer: a sender or a recipient on the deny list (EURQ)', async () => {
  const onDenyList = { ccd: '50000000', tokens: [{ id: 'EURQ', balance: '5000000', moduleState: { denyList: true } }] };
  const sender = await check({ token: 'EURQ', recipient: UPEU_GOVERNANCE, amount: 1n }, { accounts: { [TEST_ACCOUNT]: onDenyList } });
  assert.deepEqual(reasonsOf(sender.result), [R.SENDER_ON_DENY_LIST]);
  const holder = { ccd: '50000000', tokens: [{ id: 'EURQ', balance: '5000000', moduleState: {} }] };
  const recipient = await check({ token: 'EURQ', recipient: UPEU_GOVERNANCE, amount: 1n },
    { accounts: { [TEST_ACCOUNT]: holder, [UPEU_GOVERNANCE]: onDenyList } });
  assert.deepEqual(reasonsOf(recipient.result), [R.RECIPIENT_ON_DENY_LIST]);
  assert.match(recipient.result.reasons[0].message, /The recipient is on EURQ's deny list/);
});

// Step 2.
test('checkTransfer: a paused token says so, alongside anything else wrong', async () => {
  const { result } = await check({ token: 'UPEU', recipient: UPEU_GOVERNANCE, amount: 1000000n },
    { tokens: { UPEU: { paused: true } }, accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER } });
  assert.deepEqual(reasonsOf(result), [R.TOKEN_PAUSED]);
  assert.match(result.reasons[0].message, /UPEU is paused: no transfers are possible until its issuer resumes it/);
});

// Step 1.
test('checkTransfer: an amount that is not a whole number of base units above 0', async () => {
  for (const amount of [0, -1n, '1.5', 'ten', undefined]) {
    const { result } = await check({ token: 'TN', recipient: UPEU_GOVERNANCE, amount });
    assert.deepEqual(reasonsOf(result), [R.INVALID_AMOUNT], String(amount));
    assert.equal(result.fee, null);
  }
});

// Step 3: the sender not on chain.
test('checkTransfer: this account not on chain yet', async () => {
  const { result } = await check({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n }, { accounts: { [TEST_ACCOUNT]: null } });
  assert.deepEqual(reasonsOf(result), [R.SENDER_NOT_FOUND]);
});

// Step 5: the fee.
test('checkTransfer: too little CCD for the fee (INSUFFICIENT_BALANCE); a sponsor pays it instead', async () => {
  const poor = { ...structuredClone(RECORDED.accounts[TEST_ACCOUNT]), ccd: '1' }; // 1 microCCD
  const alone = await check({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n }, { accounts: { [TEST_ACCOUNT]: poor } });
  assert.deepEqual(reasonsOf(alone.result), [R.INSUFFICIENT_BALANCE]);
  assert.match(alone.result.reasons[0].message, /^This account pays the fee of [\d.]+ CCD but holds 0\.000001 CCD\.$/);

  const sponsored = await check({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n, sponsorAddress: UPEU_GOVERNANCE },
    { accounts: { [TEST_ACCOUNT]: poor } });
  assert.deepEqual(reasonsOf(sponsored.result), [], 'the sponsor (UPEU\'s governance account) holds enough CCD');

  const poorSponsor = await check({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n, sponsorAddress: NOT_ON_CHAIN });
  assert.deepEqual(reasonsOf(poorSponsor.result), [R.SPONSOR_NOT_FOUND]);
});

// Bad inputs.
test('checkTransfer: an unknown token is InvalidTokenError; a recipient or sponsor that is not an address, ValueError', async () => {
  await assert.rejects(check({ token: 'NOPE42', recipient: UPEU_GOVERNANCE, amount: 1n }), InvalidTokenError);
  await assert.rejects(check({ token: 'TN', recipient: 'bob', amount: 1n }), (e) => e instanceof ValueError && /recipient must be an account address/.test(e.message));
  await assert.rejects(check({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n, sponsorAddress: 'x' }), /sponsorAddress must be an account address/);
});

// CIS-2: no lists; the contract decides (its dry run).
test('checkTransfer: a CIS-2 token: its balance, and whether its contract would refuse (dry run)', async () => {
  const node = tokenChain();
  const { account, dispose } = await testAccount(node);
  const contract = (dryRun, balance = 100n) => async () => ({
    balanceOf: async () => balance,
    dryRun: { transfer: async () => dryRun },
  });
  account._cis2QuoteTransfer = async () => ({ fee: 12077164n }); // the quote itself is covered by the live tests
  try {
    account._cis2Contract = contract({ tag: 'success', usedEnergy: { value: 1000n } });
    assert.deepEqual(await account.checkTransfer({ token: 'cis2:12754:0:01', recipient: UPEU_GOVERNANCE, amount: 5n }),
      { ok: true, reasons: [], fee: 12077164n });

    account._cis2Contract = contract({ tag: 'failure', reason: { tag: 'RejectedReceive', rejectReason: -42000003 } });
    const refused = await account.checkTransfer({ token: 'cis2:12754:0:01', recipient: UPEU_GOVERNANCE, amount: 5n });
    assert.deepEqual(reasonsOf(refused), [R.CONTRACT_REFUSED]);
    assert.match(refused.reasons[0].message, /The token's contract would refuse this transfer: not authorised\./);

    account._cis2Contract = contract({ tag: 'success' }, 2n);
    assert.deepEqual(reasonsOf(await account.checkTransfer({ token: 'cis2:12754:0:01', recipient: UPEU_GOVERNANCE, amount: 5n })),
      [R.INSUFFICIENT_TOKEN_BALANCE]);
  } finally {
    dispose();
  }
});

// ---- Agreement with Concordium's SDK ---------------------------------------------------------------------------
//
// checkTransfer applies the same token rules as the SDK's own plt.Token.validateTransfer (which stops at the first
// problem, and throws). If the SDK's rules ever change, this test fails, so ours cannot quietly fall behind: for every
// combination below, both run on the same pretend data, and
//   - the SDK refuses  ⇔  checkTransfer finds a token-rule reason (paused, token balance, allow list, deny list);
//   - the SDK's reason (its first problem) is checkTransfer's first reason (both check in the same order).
// Only the SDK's rules are compared: checkTransfer's own extra checks (missing accounts, the fee) are left out here.

const RULE_REASONS = new Set([R.TOKEN_PAUSED, R.INSUFFICIENT_TOKEN_BALANCE, R.SENDER_NOT_ON_ALLOW_LIST,
  R.RECIPIENT_NOT_ON_ALLOW_LIST, R.SENDER_ON_DENY_LIST, R.RECIPIENT_ON_DENY_LIST]);

/** The SDK's verdict on the transfer, as one of our reasons (or null: it would let it through). */
async function sdkVerdict(node, { token, recipient, amount }, onDenyList) {
  const tok = await plt.Token.fromId(node, plt.TokenId.fromString(token));
  try {
    await plt.Token.validateTransfer(tok, sdk.AccountAddress.fromBase58(TEST_ACCOUNT), {
      recipient: plt.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(recipient)),
      amount: plt.TokenAmount.create(BigInt(amount), tok.info.state.decimals),
    });
    return null;
  } catch (e) {
    if (e instanceof plt.Token.PausedError) return R.TOKEN_PAUSED;
    if (e instanceof plt.Token.InsufficientFundsError) return R.INSUFFICIENT_TOKEN_BALANCE;
    if (e instanceof plt.Token.NotAllowedError) {
      const who = e.receiver.address === TEST_ACCOUNT ? 'SENDER' : 'RECIPIENT';
      return onDenyList[who] ? R[`${who}_ON_DENY_LIST`] : R[`${who}_NOT_ON_ALLOW_LIST`];
    }
    throw e;
  }
}

test('checkTransfer agrees with the SDK\'s validateTransfer on every combination of the token\'s rules', async () => {
  const RECIPIENT = UPEU_GOVERNANCE;
  const standing = {
    allowed: { allowList: true, denyList: false },
    'not listed': { allowList: false, denyList: false },
    'deny-listed': { allowList: true, denyList: true },
  };
  const holding = (balance, state) => ({ ccd: '50000000000', tokens: [{ id: 'UPEU', balance, moduleState: state }] });
  let compared = 0;
  for (const paused of [false, true]) {
    for (const [senderName, senderState] of Object.entries(standing)) {
      for (const balance of ['5000000', '0']) {
        for (const [recipientName, recipientState] of Object.entries(standing)) {
          const chain = { tokens: { UPEU: { paused } },
            accounts: { [TEST_ACCOUNT]: holding(balance, senderState), [RECIPIENT]: holding('1', recipientState) } };
          const transfer = { token: 'UPEU', recipient: RECIPIENT, amount: 1000000n };
          const case_ = `paused ${paused}, sender ${senderName} holding ${balance}, recipient ${recipientName}`;
          const sdkSays = await sdkVerdict(tokenChain(chain), transfer, { SENDER: senderState.denyList, RECIPIENT: recipientState.denyList });
          const ours = reasonsOf((await check(transfer, chain)).result).filter((r) => RULE_REASONS.has(r));
          assert.equal(ours.length > 0, sdkSays !== null, `${case_}: the SDK says ${sdkSays ?? 'ok'}, we say ${ours.join(', ') || 'ok'}`);
          // Both check in the same order (paused, the balance, the sender's lists, the recipient's), so the SDK's one
          // reason (its first problem) must be our first: this also catches the SDK changing which problem it reports.
          if (sdkSays) assert.equal(ours[0], sdkSays, `${case_}: the SDK reports ${sdkSays} first, we report ${ours.join(', ')}`);
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 36);
});
