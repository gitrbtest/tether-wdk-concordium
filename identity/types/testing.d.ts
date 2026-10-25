import type { IdentityStore } from './index.js';

/**
 * Check a store against the IdentityStore contract, in any test framework. For tests only: it saves
 * and deletes a few slots named 'concordium-identity-store-check/…' and removes them again, so run it
 * against a test instance. Resolves if the store behaves; throws an Error naming the first check that failed.
 */
export function verifyIdentityStore(store: IdentityStore): Promise<void>;
