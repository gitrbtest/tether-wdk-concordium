/**
 * Sending a signed account credential to the chain through the wallet-proxy, and waiting until the
 * account is final. Every way it can end is reported as a result or a clear AccountCreationError, so a
 * wallet never gets an address that might not exist.
 *
 *   send ─► received ─► committed ─► finalized ─► success → { transactionHash, blockHash }
 *     │                                   └───────► reject  → 'rejected' (the chain's reason)
 *     ├─ refused by the node             → 'rejected'
 *     ├─ wallet-proxy failure             → 'wallet-proxy'
 *     ├─ absent after its expiry time     → 'expired'
 *     ├─ still not final at the deadline  → 'timeout' (it may still be created: ask again)
 *     └─ cancelled                        → 'cancelled'
 */
import { AccountCreationError } from '../shared/errors.js';
import { sleep } from '../shared/sleep.js';
import { WalletProxyHttpError } from '../providers/WalletProxy.js';

export const DEFAULT_ACCOUNT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_ACCOUNT_INTERVAL_MS = 2000;
const MAX_FAILURES_IN_A_ROW = 3; // network or HTTP failures tolerated in a row while waiting
const STATUSES_IN_PROGRESS = ['absent', 'received', 'committed'];

/** The request body the wallet-proxy takes for a credential that creates an account. */
export function accountCredentialBody(credInfo, expiryEpochSeconds) {
  return { v: 0, value: { credential: { type: 'normal', contents: credInfo }, messageExpiry: expiryEpochSeconds } };
}

/**
 * Send the credential and wait until the account is final on chain.
 *
 * @param {{
 *   walletProxy: import('../providers/WalletProxy.js').default,
 *   credential: { credInfo: object, transactionHash: string, address: string, expiryEpochSeconds: number },
 *   timeoutMs?: number, intervalMs?: number, signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ transactionHash: string, blockHash: string }>}
 * @throws {AccountCreationError}
 */
export async function submitAndWait({
  walletProxy, credential, timeoutMs = DEFAULT_ACCOUNT_TIMEOUT_MS, intervalMs = DEFAULT_ACCOUNT_INTERVAL_MS, signal,
}) {
  const { address, transactionHash, expiryEpochSeconds } = credential;
  const fail = (message, reason, detail) => new AccountCreationError(message, { reason, address, transactionHash, detail });
  const cancelled = () => fail(
    'Creating the account was cancelled. If the credential was already sent, the account may still be created.', 'cancelled');

  if (signal?.aborted) throw cancelled();
  const deadline = Date.now() + timeoutMs;

  try {
    await walletProxy.submitCredential(accountCredentialBody(credential.credInfo, expiryEpochSeconds), { signal });
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    if (e instanceof WalletProxyHttpError && /rejected/i.test(e.errorMessage ?? '')) {
      throw fail(`The chain refused the credential for account ${address}: ${e.errorMessage}.`, 'rejected', e.errorMessage);
    }
    throw fail(`The wallet-proxy did not accept the credential for account ${address}: ${e.errorMessage ?? e.message}`,
      'wallet-proxy', e.errorMessage ?? e.message);
  }

  // Status checks that failed one after another: the network failed, or the wallet-proxy answered with an
  // HTTP error. Any check that gets an answer resets it to 0, so occasional blips are simply retried; only
  // MAX_FAILURES_IN_A_ROW failures with no answer in between end the wait (reason 'wallet-proxy').
  let failuresInARow = 0;
  while (true) {
    await sleep(intervalMs, signal, cancelled);

    let reply;
    try {
      reply = await walletProxy.submissionStatus(transactionHash, { signal });
      failuresInARow = 0;
    } catch (e) {
      if (signal?.aborted) throw cancelled();
      if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        throw fail(`The wallet-proxy failed while following the credential for account ${address}: ${e.message}`,
          'wallet-proxy', e.message);
      }
    }

    if (reply?.status === 'finalized') {
      if (reply.outcome === 'success') return { transactionHash, blockHash: reply.blockHashes?.[0] };
      throw fail(`The chain rejected the credential for account ${address}: ${reply.rejectReason ?? reply.outcome}.`,
        'rejected', reply.rejectReason ?? reply.outcome);
    }
    if (reply && !STATUSES_IN_PROGRESS.includes(reply.status)) {
      throw fail(`The wallet-proxy answered with an unexpected status: ${JSON.stringify(reply.status)}.`,
        'wallet-proxy', JSON.stringify(reply));
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
