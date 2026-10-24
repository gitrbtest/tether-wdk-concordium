/**
 * @concordium/wdk-identity-concordium/listener
 * -------------------------------------------------------------------
 * Built-in callback listener for desktop and server wallets. Node.js only: it
 * starts a small web server on 127.0.0.1, so it is a separate entry point and
 * the main entry stays usable where there is no web server (e.g. mobile apps,
 * which receive the callback through their own app scheme).
 */

export { listenForIdentityCallback } from './src/callback-listener.js';
