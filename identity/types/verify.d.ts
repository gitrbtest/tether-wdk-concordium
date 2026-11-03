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

/** Why checkPresentation refused an answer. */
export interface RefusalReason {
  /**
   * unreadable: not a verifiable presentation. challenge-mismatch: the answer is for another request.
   * statements-mismatch: it proves something other than what was asked. not-an-identity: it is not about a Concordium
   * identity's account. wrong-network: it is from another network. provider-not-accepted: the identity's provider is
   * not one the request accepts. not-on-chain: the account it names is not on chain. credential-mismatch: the account
   * on chain does not match the answer. not-active: the identity has expired, been revoked, or is not valid yet.
   * proof-invalid: the maths does not hold.
   */
  reason: 'unreadable' | 'challenge-mismatch' | 'statements-mismatch' | 'not-an-identity' | 'wrong-network'
    | 'provider-not-accepted' | 'not-on-chain' | 'credential-mismatch' | 'not-active' | 'proof-invalid';
  /** Plain English. */
  message: string;
}

/** What checkPresentation found. */
export interface PresentationCheck {
  /** true: the answer is accepted. */
  ok: boolean;
  /** Why it was refused (empty when ok). */
  reasons: RefusalReason[];
  /** The account that answered (the first, if several); only when ok. */
  account?: string;
  /** The details the request asked to see, e.g. { nationality: 'DK' }; empty unless ok. */
  revealed: Record<string, string>;
  /** Each part of the answer: its account, provider and revealed details; empty unless ok. */
  credentials: Array<{ account: string; issuer: number; revealed: Record<string, string> }>;
}

/**
 * Check a wallet's answer to a request made with requestFor: same challenge and questions, an accepted provider, the
 * right network, the account on chain, its identity still Active, and the maths holding. A refused answer returns
 * ok: false with reasons; it does not throw. Accepting each challenge's answer only once is the website's job.
 * @param presentation the answer: the presentation, its JSON text, or WalletConnect's { verifiablePresentationJson }
 * @param request the request it answers, as requestFor returned it
 * @throws {ProofError} reason 'invalid-request' (the request is broken) or 'node' (the node could not be asked).
 */
export function checkPresentation(
  presentation: object | string,
  request: ProofRequest,
  options: { node: object; network: 'testnet' | 'mainnet' },
): Promise<PresentationCheck>;

/** A connection to a Concordium node: 'testnet' or 'mainnet' for Concordium's public node, or your node's address. */
export function connectToNode(where: 'testnet' | 'mainnet' | string): object;
