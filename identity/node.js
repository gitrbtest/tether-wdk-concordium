/**
 * @concordium/wdk-identity-concordium/node
 * -------------------------------------------------------------------
 * Optional extras for Node.js wallets (desktop and server). A wallet does not
 * need them: the main entry works on its own, everywhere. They are a separate
 * entry point because they use Node-only modules (a web server, the file system), so
 * the main entry stays usable where those do not exist (e.g. mobile apps).
 *
 * - listenForIdentityCallback: catches the identity provider's return on
 *   127.0.0.1, for wallets that cannot receive it through an app scheme or
 *   their own web page.
 * - FileIdentityStore: keeps encrypted identities in files on disk.
 */

export { listenForIdentityCallback } from './src/node/identity-callback-listener.js';
export { default as FileIdentityStore } from './src/node/FileIdentityStore.js';
