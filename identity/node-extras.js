/**
 * @concordium/wdk-identity-concordium/node
 * -------------------------------------------------------------------
 * Optional extras for Node.js wallets (desktop apps). A wallet does not
 * need them: the main entry works on its own, everywhere. They are a separate
 * entry point because they use Node-only modules (a web server), so
 * the main entry stays usable where those do not exist (e.g. mobile apps).
 *
 * - listenForIdentityCallback: catches the identity provider's return on
 *   127.0.0.1, for wallets that cannot receive it through an app scheme or
 *   their own web page.
 *
 * (Not named node.js: on Windows, npm scripts that run `node` would open that
 * file instead of starting Node.js.)
 */

export { listenForIdentityCallback } from './src/node/identity-callback-listener.js';
