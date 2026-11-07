// Type definitions for @concordium/wdk-identity-concordium/verify: the website's side of proofs (servers).
import type { ProofRequest, ProofRequestV1 } from './index.js';
export type { ProofRequest, ProofRequestV1, AnyProofRequest, ProofRequestPart, ProofContext, CredentialStatement, ProofStatement, ProofAsk } from './index.js';
export { describeProofRequest, describeProofContext, ProofError } from './index.js';

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

/** What to ask in a version 1 question: requestFor's options, plus who is asking and where answers may come from. */
export interface RequestForV1Options extends RequestForOptions {
  /** The network the identities and the anchor are on. */
  network: 'testnet' | 'mainnet';
  /** Who is asking, e.g. 'shop.example' (its ResourceID): wallets show it and compare it with where they are connected. */
  website: string;
  /** Why, in a few words, e.g. 'age check' (its ContextString). */
  purpose?: string;
  /** Your id for this conversation with the wallet (its ConnectionID); default: a random one. */
  connection?: string;
  /** Where the answer may come from: the identity itself (default; no account named), an account, or either. */
  answerFrom?: 'identity' | 'account' | 'either';
}

/** Who records a version 1 question on chain (its anchor), and who pays the fee. */
export interface AnchoringOptions {
  /** A node connection (connectToNode). */
  node: object;
  /** The website's account address: it sends the anchor. */
  sender: string;
  /** The website account's signer, e.g. buildBasicAccountSigner(key) from @concordium/web-sdk. */
  signer: object;
  /** An account that pays the fee instead (both accounts sign); the website's account then needs no CCD. */
  sponsor?: { address: string; signer: object };
  /** How long to wait for the anchor to be final (default 120000 ms). */
  timeoutMs?: number;
}

/**
 * Build a version 1 question and record it on chain (its anchor: a small fee, about EUR 0.013, paid by the website
 * or its sponsor), waiting until the anchor is final. Send the question to the wallet and keep it on your server.
 * @returns The question (Concordium's VerificationRequestV1 as JSON).
 * @throws {ProofError} reason 'invalid-request' or 'unknown-attribute' (nothing sent); 'anchor-failed' (refused or
 *   rejected, e.g. not enough CCD for the fee); 'node' (the node could not be asked, or the anchor was not final in time).
 */
export function requestForV1(options: RequestForV1Options, anchoring: AnchoringOptions): Promise<ProofRequestV1>;

/** Why checkPresentationV1 refused an answer. */
export interface RefusalReasonV1 {
  /**
   * As for checkPresentation, plus: context-mismatch: the answer is for another question (nonce, website or purpose
   * differ). source-not-accepted: answered from the identity or an account where the question does not allow it.
   * anchor-not-found: the question's anchor is not on chain, or not final. anchor-mismatch: the anchor does not
   * record this question. block-mismatch: the answer is not tied to the anchor's block.
   */
  reason: 'unreadable' | 'context-mismatch' | 'statements-mismatch' | 'not-an-identity' | 'wrong-network' | 'source-not-accepted'
    | 'provider-not-accepted' | 'anchor-not-found' | 'anchor-mismatch' | 'block-mismatch' | 'not-on-chain' | 'credential-mismatch'
    | 'not-active' | 'proof-invalid';
  /** Plain English. */
  message: string;
}

/** What checkPresentationV1 found. */
export interface PresentationCheckV1 {
  /** true: the answer is accepted. */
  ok: boolean;
  /** Why it was refused (empty when ok). */
  reasons: RefusalReasonV1[];
  /** The details the question asked to see, e.g. { nationality: 'DK' }; empty unless ok. */
  revealed: Record<string, string>;
  /** Each part of the answer: from the identity or an account (then its address), its provider, the details shown. */
  credentials: Array<{ from: 'identity' | 'account'; issuer: number; account?: string; revealed: Record<string, string> }>;
  /** Only when ok: Concordium's VerificationAuditRecordV1 as JSON (the id, the question and the answer), to keep. */
  auditRecord?: { id: string; request: ProofRequestV1; presentation: object };
}

/**
 * Check a wallet's answer to a question made with requestForV1: the same context and questions, accepted providers
 * and sources, the right network, the anchor on chain, final and this question, the answer tied to its block, each
 * identity still Active, and the maths holding. A refused answer returns ok: false with reasons; it does not throw.
 * Accepting each question's answer only once is the website's job.
 * @throws {ProofError} reason 'invalid-request' (the question is broken) or 'node' (the node could not be asked).
 */
export function checkPresentationV1(
  presentation: object | string,
  request: ProofRequestV1,
  options: { node: object; network: 'testnet' | 'mainnet'; recordId?: string },
): Promise<PresentationCheckV1>;
