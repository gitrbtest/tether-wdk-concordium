// Type definitions for @concordium/wdk-identity-concordium
//
// Identity companion for @concordium/wdk-wallet-concordium. The public API is
// declared here as each capability lands.

/** Configuration for the identity package. */
export interface IdentityConfig {
  /**
   * Derive keys as on mainnet (true) or testnet (false). Same meaning as in
   * @concordium/wdk-wallet-concordium; use the same value for both packages.
   */
  useMainnetKeyDerivation: boolean;
  /** Absolute HTTP(S) URL of a Concordium wallet-proxy; it serves the network's cryptographic parameters. */
  walletProxyUrl: string;
  /**
   * The identity provider list, which the wallet passes in (the package does not fetch it): the wallet-proxy's
   * /v1/ip_info shape, e.g. `await (await fetch(`${walletProxyUrl}/v1/ip_info`)).json()`. Checked when the
   * ConcordiumIdentity is created; a list in the wrong shape is refused, naming the field.
   */
  identityProviders: IdentityProviderEntry[];
}

/** One provider in the identity provider list, in the wallet-proxy's /v1/ip_info shape (the fields the package reads). */
export interface IdentityProviderEntry {
  ipInfo: {
    /** The provider's number on the network. */
    ipIdentity: number;
    ipDescription: { name: string; url?: string; description?: string };
    /** Its public keys (hex). */
    ipVerifyKey: string;
    ipCdiVerifyKey: string;
  };
  /** Its anonymity revokers, by number. */
  arsInfos: Record<string, { arIdentity: number; arPublicKey: string; arDescription?: object }>;
  /** The provider's own addresses; an address it does not publish may be missing or empty. */
  metadata?: { issuanceStart?: string; recoveryStart?: string; icon?: string; support?: string };
}

/** A preset without the provider list: add it, e.g. { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders }. */
export type IdentityConfigPreset = Omit<IdentityConfig, 'identityProviders'>;

/** Public mainnet preset (add identityProviders). */
export const CONCORDIUM_MAINNET_IDENTITY_CONFIG: Readonly<IdentityConfigPreset>;
/** Public testnet preset (add identityProviders). */
export const CONCORDIUM_TESTNET_IDENTITY_CONFIG: Readonly<IdentityConfigPreset>;

/** An identity provider as published by the wallet-proxy. */
export interface IdentityProviderSummary {
  /** The provider's index (ipIdentity): an identifier assigned per network, not a list position. */
  index: number;
  name: string;
  /** Where identity verification starts, exactly as published; null if not published. */
  issuanceStart: string | null;
  /** Where an issued identity is recovered from the seed, exactly as published; null if not published. */
  recoveryStart: string | null;
}

/** A provider with the keys and anonymity revokers an identity request is built from. */
export interface IdentityProvider extends IdentityProviderSummary {
  ipInfo: unknown;
  arsInfos: Record<string, unknown>;
}

/** Thrown when an identity provider is not published on the network, or its published data is incomplete. */
export class IdentityProviderError extends Error {
  providerIndex?: number;
}

/** Thrown when an identity is not issued: the provider reported an error, rejected it, or the wait timed out or was cancelled. */
export class IdentityIssuanceError extends Error {
  reason: 'provider-error' | 'rejected' | 'timeout' | 'cancelled';
  /** The provider's error code, if it gave one. */
  code?: string;
  /** The provider's explanation, if it gave one. */
  detail?: string;
}

/**
 * Thrown when an identity cannot be recovered from its provider. If the provider has no such identity, recovery returns null instead of throwing.
 */
export class IdentityRecoveryError extends Error {
  /** provider-error: the provider answered with an error or not an identity; not-yours: the identity does not belong
 *  to this seed; network: the provider could not be reached; wallet-proxy: finding accounts, the wallet-proxy failed;
 *  cancelled: the AbortSignal fired. */
  reason: 'provider-error' | 'not-yours' | 'network' | 'wallet-proxy' | 'cancelled';
  /** The provider's HTTP status, for provider-error. */
  status?: number;
  /** The provider's explanation, if it gave one. */
  detail?: string;
}

/**
 * Thrown when importIdentity cannot take an exported identity back.
 */
export class IdentityStorageError extends Error {
  /** unreadable: not an exported identity, for another network, another seed, changed or damaged, or an unknown format
   *  version. not-yours: a plain (unencrypted) export whose identity does not belong to this wallet's seed. */
  reason: 'unreadable' | 'not-yours';
}

/**
 * Thrown when an account is not created from an identity. The first three reasons are found before
 * anything is sent; the others while sending the credential and waiting for the account.
 */
export class AccountCreationError extends Error {
  /**
   * identity-expired: the identity's validTo month has passed (verify again for a new identity).
   * max-accounts: credNumber is not below the identity's maxAccounts.
   * unknown-attribute: an attribute to reveal is not one the identity holds (`detail` names it).
   * rejected: the chain refused the credential (`detail` has its reason, if it gave one).
   * expired: the credential was not included on chain before its expiry time.
   * timeout: the wait ended before the account was final; it may still be created (call createAccount again).
   * cancelled: the wait was cancelled; if the credential was already sent, the account may still be created.
   * wallet-proxy: the wallet-proxy failed or answered unexpectedly (`detail` has what it said).
   */
  reason: 'identity-expired' | 'max-accounts' | 'unknown-attribute'
    | 'rejected' | 'expired' | 'timeout' | 'cancelled' | 'wallet-proxy';
  /** The account concerned, when known. */
  address?: string;
  /** The credential's transaction hash, once built. */
  transactionHash?: string;
  /** More about the reason, e.g. the chain's or the wallet-proxy's words, or the unknown attribute's name. */
  detail?: string;
}

/** The identity providers published by a Concordium wallet-proxy. */
export class IdentityProviders {
  /**
   * The providers in the list the wallet passes in (the package does not fetch it).
   * @throws {Error} If the list is missing, empty, or not in the /v1/ip_info shape (the message names the field).
   */
  constructor(identityProviders: IdentityProviderEntry[]);
  /** Every identity provider in the list. */
  list(): Promise<IdentityProviderSummary[]>;
  /**
   * One identity provider by its index.
   * @throws {IdentityProviderError} If no provider with this index is in the list.
   */
  get(index: number): Promise<IdentityProvider>;
}

/** Options for starting identity verification with a provider. */
export interface CreateIdentityRequestOptions {
  /** The provider's index on this network (see IdentityProviders). */
  providerIndex: number;
  /** Which of the wallet's identities with this provider (0, 1, 2 …; no default: nextIdentityIndex gives a new one). */
  identityIndex: number;
  /** Absolute URL the provider sends the browser to when verification finishes; passed on exactly as given. */
  redirectUri: string;
}

/** The link that opens the provider's verification page, and the identity it is for. */
export interface IdentityRequest {
  issuanceUrl: string;
  providerIndex: number;
  identityIndex: number;
}

/** Options for collecting an issued identity. */
export interface WaitForIdentityOptions {
  /** The provider the identity request was made to. Defaults to that of the last createIdentityRequest on this object. */
  providerIndex?: number;
  /** The identity index the request was made for. Required with providerIndex; both default to the last createIdentityRequest on this object. */
  identityIndex?: number;
  /** Give up after this many milliseconds. Defaults to 15 minutes. */
  timeoutMs?: number;
  /** Milliseconds between polls of the provider. Defaults to 3000. */
  intervalMs?: number;
  /** Cancels the wait. */
  signal?: AbortSignal;
}

/** What is returned about a collected identity: no personal data. */
export interface IdentitySummary {
  providerIndex: number;
  identityIndex: number;
  /** When the provider issued the identity (YYYYMM). */
  createdAt: string;
  /** When the identity expires (YYYYMM). */
  validTo: string;
  /** How many accounts may be created from this identity. */
  maxAccounts: number;
}

/** Which identity: the provider and the wallet's identity number with it. */
export interface IdentityRef {
  providerIndex: number;
  identityIndex: number;
}

/** Options for exportIdentity. */
export interface ExportIdentityOptions extends IdentityRef {
  /** true (the default): encrypted with a key made from the seed, safe to keep anywhere. false: plain JSON text with the
   *  person's details in the clear, for a wallet that keeps everything in an encrypted vault of its own. */
  encrypted?: boolean;
}

/** Options for ConcordiumIdentity.recoverIdentity. */
export interface RecoverIdentityOptions {
  /** The provider that issued the identity. */
  providerIndex: number;
  /** Which of the wallet's identities with this provider (no default). */
  identityIndex: number;
  /** Cancels the request. */
  signal?: AbortSignal;
}

/** Options for ConcordiumIdentity.findAccounts. */
export interface FindAccountsOptions {
  /** The provider that issued the identity. */
  providerIndex: number;
  /** Which of the wallet's identities with this provider (no default). */
  identityIndex: number;
  /** Stop after this many missing account numbers in a row (default 3). */
  gap?: number;
  /** Cancels the search. */
  signal?: AbortSignal;
}

/** An account found on chain by ConcordiumIdentity.findAccounts. */
export interface FoundAccount {
  /** The account number under the identity (0, 1, 2 …). */
  credNumber: number;
  /** The account address. */
  address: string;
  /** What the wallet package's getAccountByPath takes: 'provider/identity/credNumber'. */
  path: string;
}

/** Options for ConcordiumIdentity.recoverAll. */
export interface RecoverAllOptions {
  /** Only these providers (default: every provider that publishes a recovery address). */
  providerIndexes?: number[];
  /** Stop after this many missing identity numbers in a row, per provider (default 3). */
  identityGap?: number;
  /** Stop after this many missing account numbers in a row, per identity (default 3). */
  accountGap?: number;
  /** Cancels it. */
  signal?: AbortSignal;
}

/** What ConcordiumIdentity.recoverAll found. */
export interface RecoverAllResult {
  /** Every identity got back (held, ready for exportIdentity), with its accounts; accounts is null if they could not be looked up. */
  identities: Array<{ providerIndex: number; identityIndex: number; summary: IdentitySummary; accounts: FoundAccount[] | null }>;
  /** What could not be done; identityIndex is null when the provider itself could not be used. */
  problems: Array<{ providerIndex: number; identityIndex: number | null; error: Error }>;
}

/** Options for creating an account from a held identity. */
export interface CreateAccountOptions extends IdentityRef {
  /** Which account under this identity: 0, 1, 2… below the identity's maxAccounts. No default: nextCredNumber gives the number for a new account. */
  credNumber: number;
  /**
   * Attribute names to show publicly on the account, e.g. ['countryOfResidence']. Defaults to none:
   * nothing about the person is revealed. Revealed values are public on chain.
   */
  revealAttributes?: string[];
  /** Stop waiting after this many milliseconds; the account may still be created. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Milliseconds between status checks. Defaults to 2000. */
  intervalMs?: number;
  /** Cancels the wait. */
  signal?: AbortSignal;
}

/** An account created (or found existing) for an identity. */
export interface CreatedAccount extends IdentityRef {
  credNumber: number;
  /**
   * 'provider/identity/credNumber', e.g. '0/0/0': what @concordium/wdk-wallet-concordium's
   * getAccountByPath takes, to use the account.
   */
  path: string;
  /** The account address. It exists on chain. */
  address: string;
  /** false if the account already existed: then nothing was sent and there is no transaction. */
  created: boolean;
  /** The transaction that created the account (when created). */
  transactionHash?: string;
  /** The finalized block it is in (when created). */
  blockHash?: string;
}

/** A wallet's Concordium identity, derived from the wallet's own seed. */
export class ConcordiumIdentity {
  /**
   * @param seed The wallet's BIP-39 seed phrase, or its 64-byte seed.
   * @param config e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG; use the same key derivation as the wallet package.
   */
  /**
   * @param options.fetch HTTP implementation (defaults to the global fetch).
   */
  constructor(seed: string | Uint8Array, config: IdentityConfig, options?: { fetch?: typeof fetch });
  /**
   * Start identity verification: build the identity request for a provider and the link to its verification page.
   * @throws {IdentityProviderError} If the provider is not published, or publishes no issuance address.
   * @throws {Error} If the identity has been disposed.
   */
  createIdentityRequest(options: CreateIdentityRequestOptions): Promise<IdentityRequest>;
  /**
   * Read the address the provider sent the browser back to. No network call.
   * @returns The code_uri where the issued identity can be collected.
   * @throws {IdentityIssuanceError} If the provider reported an error.
   */
  parseIdentityCallback(callbackUrl: string): { codeUri: string };
  /**
   * Collect the identity the provider issued, by polling the code_uri. The identity is checked to be
   * this wallet's and kept inside this object; only a summary is returned.
   * @throws {IdentityIssuanceError} reason 'rejected', 'timeout' or 'cancelled'.
   */
  waitForIdentity(codeUri: string, options?: WaitForIdentityOptions): Promise<IdentitySummary>;
  /**
   * parseIdentityCallback followed by waitForIdentity.
   * @throws {IdentityIssuanceError} reason 'provider-error', 'rejected', 'timeout' or 'cancelled'.
   */
  retrieveIdentity(callbackUrl: string, options?: WaitForIdentityOptions): Promise<IdentitySummary>;
  /**
   * Get an identity back from its provider with the seed alone (e.g. on a new device): no verification, no browser.
   * Checked to be this wallet's and held, as after retrieveIdentity. null if the provider has none for it.
   * @throws {IdentityProviderError} If the provider is not published, or publishes no recovery address.
   * @throws {IdentityRecoveryError} reason 'provider-error', 'not-yours', 'network' or 'cancelled'.
   */
  recoverIdentity(options: RecoverIdentityOptions): Promise<IdentitySummary | null>;
  /**
   * Find the accounts an identity has on chain (account 0, 1, 2 … from the seed; stops after `gap` missing in a row,
   * or at the identity's maxAccounts if it is held). Read-only: asks whether each address exists; sends no transaction.
   * @throws {IdentityProviderError} If the provider is not published.
   * @throws {IdentityRecoveryError} reason 'wallet-proxy' or 'cancelled'.
   */
  findAccounts(options: FindAccountsOptions): Promise<FoundAccount[]>;
  /**
   * The identity number for a NEW identity with a provider: one after the highest this wallet has with it (asking the
   * provider's recovery address for 0, 1, 2 … until `gap` in a row have none), or 0. Nothing is kept or changed.
   * @throws {IdentityProviderError} If the provider is not published, or publishes no recovery address.
   * @throws {IdentityRecoveryError} reason 'provider-error', 'not-yours', 'network' or 'cancelled'.
   */
  nextIdentityIndex(options: { providerIndex: number; gap?: number; signal?: AbortSignal }): Promise<number>;
  /**
   * The account number for a NEW account under an identity: one after the highest it has on chain (as findAccounts
   * finds them), or 0. Read-only.
   * @throws {IdentityProviderError} If the provider is not published.
   * @throws {IdentityRecoveryError} reason 'wallet-proxy' or 'cancelled'.
   */
  nextCredNumber(options: FindAccountsOptions): Promise<number>;
  /**
   * Get everything back from the seed alone (a new device): for each provider, identity 0, 1, 2 … until
   * `identityGap` missing in a row, each with its accounts. Every identity found is held, ready for exportIdentity.
   * A provider that cannot be asked is noted in `problems`; the others are still asked.
   * @throws {IdentityRecoveryError} reason 'cancelled'.
   */
  recoverAll(options?: RecoverAllOptions): Promise<RecoverAllResult>;
  /**
   * The identity held for a provider and identity number, as text for the wallet to keep its own way. Encrypted by
   * default (key made from the seed, never stored; reveals nothing personal); plain JSON with encrypted: false.
   * No network call.
   * @throws {Error} If no identity is held for these numbers, or the identity has been disposed.
   */
  exportIdentity(options: ExportIdentityOptions): Promise<string>;
  /**
   * Hold an identity again from exportIdentity's text (either form), checked to be this wallet's: an encrypted export by
   * decrypting it (no network call), a plain one by its public key (one call for the network's parameters). Also reads
   * version-1 data saved by the earlier, store-based package: give its numbers as the second argument.
   * @throws {IdentityStorageError} reason 'unreadable' or 'not-yours'.
   */
  importIdentity(exported: string | Uint8Array, version1?: Partial<IdentityRef>): Promise<IdentitySummary>;
  /**
   * Create an account on chain from the identity held for a provider and identity index (collected, or
   * imported with importIdentity), with no ID App. Returns once the account is final, so the address exists.
   * An account that already exists is returned with created: false, and nothing is sent.
   * @throws {AccountCreationError} See its reasons.
   * @throws {Error} If no identity is held for these numbers, an option is invalid, or the identity has been disposed.
   */
  createAccount(options: CreateAccountOptions): Promise<CreatedAccount>;
  /**
   * Answer a website's question with a proof from one of the identity's accounts (account-based). Only what the
   * question asks is proven or shown; the identity never leaves the wallet. Show describeProofRequest's wording and
   * get the person's agreement first. Refuses before building anything if the answer would not be true.
   * @returns The proof; its toString() is the JSON to send back (WalletConnect's verifiablePresentationJson).
   * @throws {ProofError} reason 'invalid-request', 'unknown-attribute', 'not-held', 'identity-expired',
   *   'provider-not-accepted' or 'cannot-prove'.
   */
  prove(options: ProveOptions): Promise<ProofAnswer>;
  /**
   * The identity's accounts on chain that can answer a website's question: none if the identity cannot truly
   * answer (expired, provider not accepted, or its details do not satisfy it). Read-only.
   * @throws {ProofError} reason 'invalid-request', 'unknown-attribute' or 'not-held'.
   */
  accountsThatCanAnswer(options: AccountsThatCanAnswerOptions): Promise<FoundAccount[]>;
  /** True once dispose() has been called. */
  get disposed(): boolean;
  /** Zero the seed and any collected identities, and drop them; later calls that need the seed throw. */
  dispose(): void;
}

// ---- Proofs (scope part E) ----

/** One fact asked about an attribute, in Concordium's request format (version 0). Range: lower ≤ value < upper. */
export type ProofStatement =
  | { type: 'RevealAttribute'; attributeTag: string }
  | { type: 'AttributeInRange'; attributeTag: string; lower: string; upper: string }
  | { type: 'AttributeInSet'; attributeTag: string; set: string[] }
  | { type: 'AttributeNotInSet'; attributeTag: string; set: string[] };

/** What a website asks: facts about an identity from one of the accepted providers. */
export interface CredentialStatement {
  idQualifier: { type: 'cred'; issuers: number[] };
  statement: ProofStatement[];
}

/** A website's proof request: as a WalletConnect `request_verifiable_presentation` carries it. */
export interface ProofRequest {
  /** Hex chosen by the website: the answer is tied to it, so it cannot be reused for another request. */
  challenge: string;
  credentialStatements: CredentialStatement[];
}

/** Which identity answers, plus the website's question as it arrived (or WalletConnect's { paramsJson }). */
export type ProveOptions = {
  /** The identity's provider. */
  providerIndex: number;
  /** Which of the wallet's identities with that provider (no default). */
  identityIndex: number;
  /** Which of the identity's accounts answers (accountsThatCanAnswer lists the ones that can; no default). */
  credNumber: number;
} & (ProofRequest | { paramsJson: string });

/** The identity, plus the website's question; gap and signal as for findAccounts. */
export type AccountsThatCanAnswerOptions = {
  providerIndex: number;
  identityIndex: number;
  gap?: number;
  signal?: AbortSignal;
} & (ProofRequest | { paramsJson: string });

/** A proof made by prove (Concordium's VerifiablePresentation). */
export interface ProofAnswer {
  /** The challenge it answers. */
  presentationContext: string;
  /** One part per credential statement asked. */
  verifiableCredential: object[];
  /** The JSON to send back to the website. */
  toString(): string;
}

/** One item for a consent screen, from describeProofRequest. */
export interface ProofAsk {
  kind: 'reveal' | 'range' | 'in-set' | 'not-in-set';
  attribute: string;
  /** Plain English, e.g. "prove you were born before 4 Nov 2008 (at least 18 years old), without showing your date of birth". */
  text: string;
}

/**
 * Describe a website's proof request in plain English, for the person's consent screen (no network, no secrets).
 * Accepts the request, or WalletConnect's `{ paramsJson }` wrapper. One entry per credential statement.
 * @throws {ProofError} reason 'invalid-request' or 'unknown-attribute'.
 */
export function describeProofRequest(request: ProofRequest | { paramsJson: string }, options?: { now?: Date }): Array<{ providers: number[]; asks: ProofAsk[] }>;

/**
 * Thrown when a proof cannot be asked for, made or checked. cannot-prove: the identity's details do not satisfy the
 * request (nothing is built, so a wallet never produces a false proof). node: checking an answer, the node could not
 * be asked (a refused answer does not throw: checkPresentation returns ok: false).
 */
export class ProofError extends Error {
  reason: 'invalid-request' | 'unknown-attribute' | 'not-held' | 'identity-expired' | 'provider-not-accepted' | 'cannot-prove'
    | 'node';
  /** More detail, e.g. the attribute named. */
  detail?: string;
}
