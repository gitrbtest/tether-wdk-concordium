/**
 * Identity callback listener: an optional helper for Node.js wallets on a
 * desktop or server. Mobile and web wallets do not need it (see below).
 *
 * The problem it solves
 * ---------------------
 * The user verifies their identity in a web browser. When they have finished,
 * the identity provider sends the browser back to the wallet: to the return
 * address the wallet chose (the redirectUri given to createIdentityRequest),
 * with the provider's reply added after a `#`. This return is the "identity
 * callback". For example:
 *
 *   http://127.0.0.1:53817/identity-callback/9f2c…#code_uri=https://id-service…
 *
 * The wallet needs that whole address, including the part after `#`, to collect
 * the identity (retrieveIdentity). But browsers never send the part after `#` to
 * the server they visit; it stays inside the browser. A plain web server at the
 * return address would see only `/identity-callback/9f2c…` and lose the reply.
 * (A mobile app avoids this because it controls its own web view and sees the
 * full address; a web wallet's own page can read it directly.)
 *
 * How it works
 * ------------
 * 1. listenForIdentityCallback starts a small web server on this computer
 *    (127.0.0.1) at a random, unguessable path, and returns that address for the
 *    wallet to use as redirectUri.
 * 2. When the browser arrives there, the server answers with a small page. A
 *    script on that page reads the page's own full address (location.href,
 *    which does include the part after `#`) and posts it back to the server.
 * 3. The server hands that full address to the wallet (the `callback` promise),
 *    the page tells the user they can close the tab, and the server shuts down.
 *
 * Safety
 * ------
 * - Reachable only from this computer (127.0.0.1), and only at the random path.
 * - Waits for exactly one return. As soon as one arrives, or the wait times out
 *   or is cancelled, it stops listening; anything after that is refused.
 * - Takes only an address that starts with its own return address, up to a
 *   limited size. Anything else is refused, and it keeps waiting for the real one.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { IdentityIssuanceError } from '../errors.js';

const HOST = '127.0.0.1';
const PATH_PREFIX = '/identity-callback/';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Identity verification</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head>
<body>
<p id="message">Finishing identity verification…</p>
<script>
fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: location.href })
  .then(function (r) { if (!r.ok) throw new Error(); return 'Done. You can close this tab and return to the wallet.'; })
  .catch(function () { return 'The wallet could not be reached. Return to the wallet and try again.'; })
  .then(function (text) { document.getElementById('message').textContent = text; });
</script>
</body>
</html>
`;

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
};

function cancelledError() {
  return new IdentityIssuanceError('Waiting for the identity callback was cancelled.', { reason: 'cancelled' });
}

function requireOptions({ port, timeoutMs }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('port must be an integer from 0 to 65535 (0 picks a free port).');
  }
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
    throw new Error('timeoutMs must be a positive number.');
  }
}

/**
 * Start listening for the provider's callback on this machine.
 *
 * @param {object} [options]
 * @param {number} [options.port=0]  port on 127.0.0.1; 0 picks a free one
 * @param {number} [options.timeoutMs=900000]  stop waiting after this long (default 15 minutes)
 * @param {AbortSignal} [options.signal]  cancels the wait (e.g. a Cancel button)
 * @returns {Promise<{ redirectUri: string, callback: Promise<string>, close: () => void }>}
 *   `redirectUri` goes to createIdentityRequest; `callback` resolves with the full address
 *   the browser arrived at (pass it to retrieveIdentity) and rejects with IdentityIssuanceError
 *   reason 'timeout' or 'cancelled'; `close()` stops listening early.
 */
export async function listenForIdentityCallback({ port = 0, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  requireOptions({ port, timeoutMs });
  if (signal?.aborted) throw cancelledError();

  const path = PATH_PREFIX + randomBytes(16).toString('hex');
  let redirectUri;
  let settled = false;
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  callback.catch(() => {}); // a wallet that never awaits the callback gets no unhandled rejection

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://placeholder');
    // Only our own address (also guards against other sites reaching it through DNS tricks).
    if (request.headers.host !== new URL(redirectUri).host) return reply(response, 403);
    if (pathname !== path) return reply(response, 404);
    if (settled) return reply(response, 410);

    if (request.method === 'GET') {
      response.writeHead(200, PAGE_HEADERS);
      return response.end(PAGE);
    }
    if (request.method !== 'POST') return reply(response, 405);

    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        tooLarge = true;
        request.destroy();
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      if (!isOurAddress(body)) return reply(response, 400);
      reply(response, 204);
      finish(() => resolveCallback(body));
    });
    request.on('close', () => { if (tooLarge && !response.headersSent) reply(response, 413); });
  });

  function isOurAddress(text) {
    try {
      const url = new URL(text);
      return url.origin + url.pathname === redirectUri;
    } catch {
      return false;
    }
  }

  let timer;
  const onAbort = () => finish(() => rejectCallback(cancelledError()));

  function finish(settle) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    settle();
    server.close();
    server.closeAllConnections?.();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => { server.off('error', reject); resolve(); });
  });
  redirectUri = `http://${HOST}:${server.address().port}${path}`;

  timer = setTimeout(() => finish(() => rejectCallback(new IdentityIssuanceError(
    `No identity callback arrived within ${timeoutMs} ms.`, { reason: 'timeout' }))), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  return {
    redirectUri,
    callback,
    close: () => finish(() => rejectCallback(cancelledError())),
  };
}

function reply(response, status) {
  response.writeHead(status, { 'cache-control': 'no-store' });
  response.end();
}
