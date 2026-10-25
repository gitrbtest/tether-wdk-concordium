/**
 * @concordium/wdk-identity-concordium/testing
 * -------------------------------------------------------------------
 * Tools for tests only, not for a running wallet. A separate entry point, so the main entry
 * holds only what a wallet uses at run time.
 *
 * - verifyIdentityStore: checks a store an operator wrote (a phone's storage, a backend, a
 *   database) against the identity store contract. Run it against a test instance: it saves and
 *   deletes slots of its own.
 */

export { verifyIdentityStore } from './src/testing/verify-identity-store.js';
