// Type definitions for @concordium/wdk-identity-concordium/verify: the website's side of proofs (servers).
import type { ProofRequest } from './index.js';
export type { ProofRequest, CredentialStatement, ProofStatement, ProofAsk } from './index.js';
export { describeProofRequest, ProofError } from './index.js';

/** Options for requestFor: what to ask, and whose identities to accept. */
export interface RequestForOptions {
  /** The identity providers whose identities you accept (their numbers on the network). Required. */
  providers: number[];
  /** Prove at least 18 years old (same as minAge: 18). */
  adult?: boolean;
  /** Prove at least this many years old. */
  minAge?: number;
  /** Prove the country of residence is one of these (two-letter codes). */
  residentIn?: string[];
  /** Prove the country of residence is none of these. */
  notResidentIn?: string[];
  /** Prove the nationality is one of these. */
  nationalityIn?: string[];
  /** Prove the nationality is none of these. */
  nationalityNotIn?: string[];
  /** Prove the ID document is still valid today (true) or on the given date. */
  documentValid?: boolean | Date;
  /** Attributes to be shown, e.g. ['firstName', 'lastName', 'nationality']. */
  reveal?: string[];
}

/**
 * Build a proof request with a fresh random challenge (Concordium's format, as WalletConnect carries it). Keep it on
 * your server to check the answer against, and accept each challenge's answer once.
 * @throws {ProofError} reason 'invalid-request' (e.g. no providers, an attribute used twice) or 'unknown-attribute'.
 */
export function requestFor(options: RequestForOptions): ProofRequest;
