/**
 * The demo wallet: a small local web server that tells the whole story in the browser, one click per step.
 * The page (public/) is only the screen; this server does the work with the two packages, as the samples do.
 *
 *   npm run demo-wallet          (from the identity folder; opens the page in the default browser)
 *
 * Safety: it listens on 127.0.0.1 only and checks the Host header, so other machines (and DNS tricks) cannot
 * reach it; every /api call needs a random token that only the real page has, sent as a custom header, which
 * pages from other sites cannot add, so they cannot drive the demo. The seeds never reach the browser.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Start the demo server.
 * @param {object} [options]
 * @param {ReturnType<typeof readSettings>} [options.settings]  defaults to the environment's
 * @param {number} [options.port]  overrides settings.port (0: any free port, for tests)
 * @returns {Promise<{ url: string, token: string, state: object, close: () => Promise<void> }>}
 */
export async function startDemoServer({ settings = readSettings(), port = settings.port } = {}) {
  const token = randomBytes(16).toString('hex');
  // Everything the page draws. It holds no secrets: no seeds, no keys.
  const state = {
    network: 'testnet',
    funding: settings.funding ? 'funding account' : 'none',
    identityIndex: settings.identityIndex,
    reuseIdentity: settings.reuseIdentity,
    step: 'start',
  };
  let host; // "127.0.0.1:<port>", known once listening

  const server = createServer(async (request, response) => {
    try {
      // Only our own address: other machines and DNS tricks are refused.
      if (request.headers.host !== host && request.headers.host !== host.replace('127.0.0.1', 'localhost')) {
        return send(response, 403, { error: 'This demo only answers on its own local address.' });
      }
      const { pathname } = new URL(request.url, `http://${host}`);
      if (pathname.startsWith('/api/')) {
        if (request.headers['x-demo-token'] !== token) return send(response, 403, { error: 'Missing or wrong demo token.' });
        return await api(request, response, pathname);
      }
      const page = STATIC_FILES[pathname];
      if (!page || request.method !== 'GET') return send(response, 404, { error: 'Not found.' });
      let body = await readFile(new URL(page.file, PUBLIC), 'utf8');
      if (page.file === 'index.html') body = body.replace('__DEMO_TOKEN__', token);
      response.writeHead(200, { 'Content-Type': page.type, ...PAGE_HEADERS });
      response.end(body);
    } catch (e) {
      send(response, 500, { error: e.message });
    }
  });

  /** The JSON API the page calls. More routes arrive with each step. */
  async function api(request, response, pathname) {
    if (request.method === 'GET' && pathname === '/api/state') return send(response, 200, state);
    return send(response, 404, { error: 'Not found.' });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  host = `127.0.0.1:${server.address().port}`;
  return {
    url: `http://${host}/`,
    token,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A JSON answer. */
function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...PAGE_HEADERS });
  response.end(JSON.stringify(body));
}

/** Read a small JSON request body (used by the steps' POST routes). */
export function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) request.destroy(new Error('Request too large.'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('The request is not valid JSON.')); }
    });
    request.on('error', reject);
  });
}

/** Open a URL in the default browser: Windows, macOS or Linux. The address is printed as well, in case it does not open. */
function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch { /* the printed address is enough */ }
}

// ---- Run directly: npm run demo-wallet ----------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const settings = readSettings();
  try {
    const demo = await startDemoServer({ settings });
    console.log('Concordium demo wallet (testnet, public test seed)');
    console.log(`  open: ${demo.url}`);
    console.log(`  funding: ${settings.funding ? 'a funding account is configured' : 'none (receive and send steps will ask for testnet CCD)'}`);
    console.log('  stop: Ctrl+C');
    openBrowser(demo.url);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${settings.port} is already in use. Choose another, e.g. PORT=4322 (macOS / Linux) or $env:PORT=4322 (PowerShell).`);
    } else {
      console.error(`Could not start the demo wallet: ${e.message}`);
    }
    process.exitCode = 1;
  }
}
