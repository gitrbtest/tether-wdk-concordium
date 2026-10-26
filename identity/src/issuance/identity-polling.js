/**
 * Polling the identity provider's code_uri until it has an answer: patient, careful polling that knows
 * nothing about seeds or ownership (ConcordiumIdentity.waitForIdentity checks the identity afterwards).
 */
import { IdentityIssuanceError } from '../shared/errors.js';

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_INTERVAL_MS = 3000;
const MAX_FAILURES_IN_A_ROW = 3; // network or HTTP failures tolerated in a row

export function cancelledError() {
  return new IdentityIssuanceError('Waiting for the identity was cancelled.', { reason: 'cancelled' });
}

/** Wait `ms`, or reject early with a 'cancelled' error if `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(cancelledError()); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Ask the provider at `url` (the code_uri) every `intervalMs` until it answers 'done' or 'error'.
 * Brief network or HTTP failures are retried; MAX_FAILURES_IN_A_ROW in a row are reported.
 *
 * @param {{ fetch: typeof fetch, url: string, timeoutMs: number, intervalMs: number, signal?: AbortSignal }} options
 * @returns {Promise<{ status: 'done' | 'error', token?: object, detail?: string }>}  the provider's final answer
 * @throws {IdentityIssuanceError} reason 'timeout' or 'cancelled'
 * @throws {Error} after repeated failures, or if the provider answers with an unexpected status
 */
export async function pollIdentityProvider({ fetch, url, timeoutMs, intervalMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  let failuresInARow = 0;

  while (true) {
    if (signal?.aborted) throw cancelledError();
    let reply;
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`The identity provider answered HTTP ${response.status}.`);
      reply = await response.json();
      failuresInARow = 0;
    } catch (e) {
      if (signal?.aborted) throw cancelledError();
      if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) throw e;
    }

    if (reply?.status === 'done' || reply?.status === 'error') return reply;
    if (reply && reply.status !== 'pending') {
      throw new Error(`The identity provider answered with an unexpected status: ${JSON.stringify(reply.status)}.`);
    }

    if (Date.now() + intervalMs > deadline) {
      throw new IdentityIssuanceError(
        `The identity was not issued within ${timeoutMs} ms; the provider may still be verifying. ` +
        'Wait again with the same code_uri later.', { reason: 'timeout' });
    }
    await sleep(intervalMs, signal);
  }
}
