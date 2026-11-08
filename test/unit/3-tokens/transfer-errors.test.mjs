/**
 * Transfers that fail say why: transfer, buildSponsorableTransfer, submitSponsored and sendTransaction throw WDK's own
 * errors with Concordium's reasons, offline. The pretend node (test/token-chain.mjs) replays recorded testnet tokens
 * and accounts, accepts transfers, and can refuse them as the chain would, or change a rule in the moment between
 * the wallet's check and the transfer (an issuer pausing the token, or changing a list).
 *
 * Who is who:
 *   SENDER        the test account (holds TN and CCD; on no UPEU list), unless a test changes it
 *   RECIPIENT     UPEU's governance account (on UPEU's allow list), or as a test sets it
 *   PRETEND NODE  the recorded tokens and accounts; it records what is sent
 *
 *   WALLET: transfer({ token, recipient, amount })                      PRETEND NODE
 *   ──────────────────────────────────────────────                     ────────────
 *   1. checkTransfer: any problem? → ConcordiumTransferError, every reason; nothing sent, no fee
 *   2. the SDK's own check just before sending: the rules changed? → the same error; nothing sent
 *   3. send ───────────────────────────────────────────────────────────► accepted
 *   4. wait until final ◄─────────────────────────────────────────────── final; or refused:
 *      refused → ConcordiumTransferError, with the hash, in the same reasons
 *        (operationNotPermitted: the token's rules as they are now say why)
 *   5. fine → { hash, fee }
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransferError, TransactionError, TransactionErrorReason } from '@tetherto/wdk-wallet';
import { ConcordiumTransferError, ConcordiumTransferErrorReason as R } from '../../../index.js';
import { tokenChain, testAccount, rejection, TEST_ACCOUNT, UPEU_GOVERNANCE } from '../../token-chain.mjs';

// The test account holding 5 UPEU and on UPEU's allow list.
const ALLOWED_HOLDER = { ccd: '50000000000', tokens: [{ id: 'UPEU', balance: '5000000', moduleState: { allowList: true, denyList: false } }] };
const UPEU_TRANSFER = { token: 'UPEU', recipient: UPEU_GOVERNANCE, amount: 1000000n };
const DENIED = { ccd: '1', tokens: [{ id: 'UPEU', balance: '1', moduleState: { allowList: true, denyList: true } }] };

/** transfer on a pretend node set up by `chain`; resolves to { result } or { error }, with the node. */
async function attempt(transfer, chain = {}, call = (account) => account.transfer(transfer)) {
  const node = tokenChain(chain);
  const { account, dispose } = await testAccount(node);
  try {
    return { result: await call(account), node };
  } catch (error) {
    return { error, node };
  } finally {
    dispose();
  }
}

/** Checks the error is a ConcordiumTransferError (and so WDK's TransferError) with `reason`. */
function isTransferError(error, reason) {
  assert.ok(error instanceof ConcordiumTransferError, `a ConcordiumTransferError, not ${error?.name}: ${error?.message}`);
  assert.ok(error instanceof TransferError, 'and WDK\'s own TransferError');
  assert.equal(error.reason, reason, error.message);
}

// Steps 1, 3-5: all is well.
test('transfer: a transfer that can happen is sent, and returns its hash and fee', async () => {
  const { result, node } = await attempt({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1000000n });
  assert.deepEqual(result, { hash: '5e'.repeat(32), fee: 4647253n });
  assert.equal(node.sent.length, 1);
});

// Step 1.
test('transfer: blocked before sending: every reason is on the error, nothing is sent', async () => {
  const { error, node } = await attempt(UPEU_TRANSFER);
  isTransferError(error, R.INSUFFICIENT_TOKEN_BALANCE);
  assert.deepEqual(error.reasons.map((r) => r.reason), [R.INSUFFICIENT_TOKEN_BALANCE, R.SENDER_NOT_ON_ALLOW_LIST]);
  assert.equal(error.message, 'This account holds 0 UPEU; 1 is needed. (and 1 more: see reasons)');
  assert.equal(error.hash, null, 'not sent');
  assert.equal(node.sent.length, 0);
});

// Step 1: a paused token.
test('transfer: a paused token is refused before sending', async () => {
  const { error, node } = await attempt(UPEU_TRANSFER, { tokens: { UPEU: { paused: true } }, accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER } });
  isTransferError(error, R.TOKEN_PAUSED);
  assert.equal(node.sent.length, 0);
});

// Step 2: the token paused in the moment after our check: the SDK's own check refuses it, nothing is sent.
test('transfer: the rules change right after the check: the SDK\'s own check refuses it, in our reasons', async () => {
  const { error, node } = await attempt(UPEU_TRANSFER, {
    accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    later: { afterTokenReads: 1, tokens: { UPEU: { paused: true } } },
  });
  isTransferError(error, R.TOKEN_PAUSED);
  assert.equal(node.sent.length, 0);
});

// Step 2: the recipient put on the deny list in that moment.
test('transfer: the recipient put on the deny list right after the check: RECIPIENT_ON_DENY_LIST, nothing sent', async () => {
  const { error, node } = await attempt(UPEU_TRANSFER, {
    accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    later: { afterTokenReads: 1, accounts: { [UPEU_GOVERNANCE]: DENIED } },
  });
  isTransferError(error, R.RECIPIENT_ON_DENY_LIST);
  assert.equal(error.reasons[0].account, UPEU_GOVERNANCE);
  assert.equal(node.sent.length, 0);
});

// Step 4: the chain refuses (operationNotPermitted), and the rules as they are now say why.
test('transfer: refused on chain (operationNotPermitted for the recipient): the reason, with the hash', async () => {
  const { error, node } = await attempt(UPEU_TRANSFER, {
    accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    later: { afterSend: true, accounts: { [UPEU_GOVERNANCE]: DENIED } },
    outcome: rejection('UPEU', 'operationNotPermitted', { address: UPEU_GOVERNANCE, reason: 'recipient in deny list' }),
  });
  isTransferError(error, R.RECIPIENT_ON_DENY_LIST);
  assert.equal(error.hash, '5e'.repeat(32), 'it was sent: its fee was charged');
  assert.equal(error.message, 'The chain refused the transfer: the recipient is on UPEU\'s deny list.');
  assert.equal(error.rejectReason.tag, 'TokenUpdateTransactionFailed', 'the chain\'s own reason is kept');
  assert.equal(node.sent.length, 1);
});

// Step 4: paused on chain.
test('transfer: refused on chain because the token was paused in that moment', async () => {
  const { error } = await attempt(UPEU_TRANSFER, {
    accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    later: { afterSend: true, tokens: { UPEU: { paused: true } } },
    outcome: rejection('UPEU', 'operationNotPermitted', { reason: 'token operations paused' }),
  });
  isTransferError(error, R.TOKEN_PAUSED);
  assert.ok(error.hash);
});

// Step 4: the chain's other token refusals.
test('transfer: refused on chain for the balance, or a missing account', async () => {
  const balance = await attempt(UPEU_TRANSFER, { accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    outcome: rejection('UPEU', 'tokenBalanceInsufficient', { availableBalance: 1, requiredBalance: 1000000 }) });
  isTransferError(balance.error, R.INSUFFICIENT_TOKEN_BALANCE);
  const missing = await attempt(UPEU_TRANSFER, { accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    outcome: rejection('UPEU', 'addressNotFound', { address: UPEU_GOVERNANCE }) });
  isTransferError(missing.error, R.RECIPIENT_NOT_FOUND);
});

// Step 4: the rules as they are now do not say why: the chain's own words.
test('transfer: refused on chain, and the rules now do not say why: OPERATION_NOT_PERMITTED with the chain\'s words', async () => {
  const { error } = await attempt(UPEU_TRANSFER, { accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    outcome: rejection('UPEU', 'operationNotPermitted', { address: UPEU_GOVERNANCE, reason: 'recipient in deny list' }) });
  isTransferError(error, R.OPERATION_NOT_PERMITTED);
  assert.match(error.message, /UPEU does not permit it for .* \("recipient in deny list"\)/);
});

// Step 4: anything else the chain says.
test('transfer: refused on chain for another reason: REJECTED, with the chain\'s reason kept', async () => {
  const { error } = await attempt({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n }, { outcome: { tag: 'OutOfEnergy' } });
  isTransferError(error, R.REJECTED);
  assert.match(error.message, /OutOfEnergy/);
  assert.deepEqual(error.rejectReason, { tag: 'OutOfEnergy' });
});

// Sponsored transfers: step 1 when building, step 4 when submitting.
test('buildSponsorableTransfer: checked first, with the sponsor paying the fee', async () => {
  const poorSponsor = { ccd: '1', tokens: [] };
  const SPONSOR = '4kJZHvmLwMJjPp58ie7ZZirRkSZL1WLfcKbcrCdBAzweSj9fTU';
  const { error } = await attempt({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n, sponsorAddress: SPONSOR },
    { accounts: { [SPONSOR]: poorSponsor } }, (account) => account.buildSponsorableTransfer({ token: 'TN', recipient: UPEU_GOVERNANCE, amount: 1n, sponsorAddress: SPONSOR }));
  isTransferError(error, R.INSUFFICIENT_BALANCE);
  assert.equal(error.reasons[0].account, SPONSOR);
  assert.match(error.message, /^The sponsor pays the fee/);
});

test('submitSponsored: refused on chain: the reason, for the transaction\'s own sender', async () => {
  const SPONSOR = UPEU_GOVERNANCE;
  const transfer = { token: 'UPEU', recipient: UPEU_GOVERNANCE, amount: 1000000n, sponsorAddress: SPONSOR };
  const { error, node } = await attempt(transfer, {
    accounts: { [TEST_ACCOUNT]: ALLOWED_HOLDER },
    later: { afterSend: true, accounts: { [TEST_ACCOUNT]: { ...ALLOWED_HOLDER, tokens: [{ ...ALLOWED_HOLDER.tokens[0], moduleState: { allowList: false, denyList: false } }] } } },
    outcome: rejection('UPEU', 'operationNotPermitted', { address: TEST_ACCOUNT }),
  }, async (account) => {
    const built = await account.buildSponsorableTransfer(transfer);
    const signed = await account.signAsSponsorSigned(await account.signAsAccountToBeSponsored(built)); // this test signs both
    return account.submitSponsored(signed);
  });
  isTransferError(error, R.SENDER_NOT_ON_ALLOW_LIST);
  assert.equal(error.reasons[0].account, TEST_ACCOUNT);
  assert.equal(node.sent.length, 1);
});

// Native CCD: WDK's TransactionError with INSUFFICIENT_BALANCE.
test('sendTransaction: too little CCD for the amount and the fee: WDK\'s INSUFFICIENT_BALANCE, before sending', async () => {
  const poor = { ccd: '1000000', tokens: [] };
  const { error, node } = await attempt(null, { accounts: { [TEST_ACCOUNT]: poor } },
    (account) => account.sendTransaction({ to: UPEU_GOVERNANCE, value: 1000000n }));
  assert.ok(error instanceof TransactionError, `${error?.name}: ${error?.message}`);
  assert.equal(error.reason, TransactionErrorReason.INSUFFICIENT_BALANCE);
  assert.match(error.message, /^This account holds 1 CCD; the transfer needs [\d.]+ CCD \(1 plus a fee of [\d.]+\)\.$/);
  assert.equal(node.sent.length, 0);
});
