/**
 * Sending a signed account credential to the chain through the wallet's node connection, and waiting until the
 * account is final. Every way it can end is reported as a result or a clear AccountCreationError, so a wallet never
 * gets an address that might not exist.
 *
 *   send ─► received ─► committed ─► finalized ─► account created → { transactionHash, blockHash }
 *     │                                   └───────► no account     → 'rejected'
 *     ├─ refused by the node             → 'rejected' (the node's words)
 *     ├─ the node cannot be asked         → 'node'
 *     ├─ absent after its expiry time     → 'expired'
 *     ├─ still not final at the deadline  → 'timeout' (it may still be created: ask again)
 *     └─ cancelled                        → 'cancelled'
 */
import { AccountCreationError } from '../shared/errors.js';
import { sleep } from '../shared/sleep.js';

export const DEFAULT_ACCOUNT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_ACCOUNT_INTERVAL_MS = 2000;
const MAX_FAILURES_IN_A_ROW = 3; // failed status checks tolerated in a row while waiting
const STATUSES_IN_PROGRESS = ['absent', 'received', 'committed'];

/** gRPC codes with which a node refuses a credential itself (rather than failing to answer). */
const REFUSED = new Set(['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'ALREADY_EXISTS', 3, 9, 6]);

/**
 * Send the credential and wait until the account is final on chain.
 *
 * @param {{
 *   node: import('../chain/ChainNode.js').default,
 *   credential: { payload: Uint8Array, expiry: object, transactionHash: string, address: string, expiryEpochSeconds: number },
 *   timeoutMs?: number, intervalMs?: number, signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ transactionHash: string, blockHash: string }>}
 * @throws {AccountCreationError}
 */
export async function submitAndWait({
  node, credential, timeoutMs = DEFAULT_ACCOUNT_TIMEOUT_MS, intervalMs = DEFAULT_ACCOUNT_INTERVAL_MS, signal,
}) {
  const { address, transactionHash, expiryEpochSeconds } = credential;
  const fail = (message, reason, detail) => new AccountCreationError(message, { reason, address, transactionHash, detail });
  const cancelled = () => fail(
    'Creating the account was cancelled. If the credential was already sent, the account may still be created.', 'cancelled');

  if (signal?.aborted) throw cancelled();
  const deadline = Date.now() + timeoutMs;

  try {
    await node.sendCredential(credential);
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    if (REFUSED.has(e?.code)) {
      throw fail(`The node refused the credential for account ${address}: ${e.message}`, 'rejected', e.message);
    }
    throw fail(`The node could not be asked to send the credential for account ${address}: ${e.message}`, 'node', e.message);
  }

  // Status checks that failed one after another (the node could not be reached). Any check that gets an answer
  // resets it to 0, so occasional blips are simply retried; only MAX_FAILURES_IN_A_ROW failures with no answer in
  // between end the wait (reason 'node').
  let failuresInARow = 0;
  while (true) {
    await sleep(intervalMs, signal, cancelled);

    let reply;
    try {
      reply = await node.transactionStatus(transactionHash);
      failuresInARow = 0;
    } catch (e) {
      if (signal?.aborted) throw cancelled();
      if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        throw fail(`The node failed while following the credential for account ${address}: ${e.message}`, 'node', e.message);
      }
    }

    if (reply?.status === 'finalized') {
      if (reply.created) return { transactionHash, blockHash: reply.blockHash };
      throw fail(`The credential for account ${address} was finalized without creating the account (${reply.detail}).`,
        'rejected', reply.detail);
    }
    if (reply && !STATUSES_IN_PROGRESS.includes(reply.status)) {
      throw fail(`The node answered with an unexpected status: ${JSON.stringify(reply.status)}.`, 'node', JSON.stringify(reply));
    }
    // Absent after its expiry time: the chain dropped it and never will include it.
    if (reply?.status === 'absent' && Date.now() / 1000 > expiryEpochSeconds) {
      throw fail(`The credential for account ${address} was not included on chain before it expired.`, 'expired');
    }
    if (Date.now() + intervalMs > deadline) {
      throw fail(`Account ${address} was not final within ${timeoutMs} ms; it may still be created. ` +
        'Ask again with the same account number to pick it up.', 'timeout');
    }
  }
}
