/**
 * Wait `ms`, or stop early when `signal` aborts: then reject with the error `cancelled()` returns.
 * Used while polling (the identity provider, the wallet-proxy) so a wallet can cancel a wait at any time.
 *
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @param {() => Error} cancelled
 * @returns {Promise<void>}
 */
export function sleep(ms, signal, cancelled) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(cancelled()); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
