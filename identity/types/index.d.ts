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
  /** Absolute HTTP(S) URL of a Concordium wallet-proxy; it publishes the identity providers and cryptographic parameters. */
  walletProxyUrl: string;
}

/** Public mainnet wallet-proxy preset. */
export const CONCORDIUM_MAINNET_IDENTITY_CONFIG: Readonly<IdentityConfig>;
/** Public testnet wallet-proxy preset. */
export const CONCORDIUM_TESTNET_IDENTITY_CONFIG: Readonly<IdentityConfig>;

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

/** The identity providers published by a Concordium wallet-proxy. */
export class IdentityProviders {
  constructor(config: IdentityConfig, options?: { fetch?: typeof fetch });
  /** Every identity provider published on this network. */
  list(): Promise<IdentityProviderSummary[]>;
  /**
   * One identity provider by its index.
   * @throws {IdentityProviderError} If no provider with this index is published.
   */
  get(index: number): Promise<IdentityProvider>;
}

/** Options for starting identity verification with a provider. */
export interface CreateIdentityRequestOptions {
  /** The provider's index on this network (see IdentityProviders). */
  providerIndex: number;
  /** Which of the wallet's identities with this provider. Defaults to 0. */
  identityIndex?: number;
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
  /** The provider the identity request was made to. */
  providerIndex: number;
  /** The identity index the request was made for. Defaults to 0. */
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

/** A wallet's Concordium identity, derived from the wallet's own seed. */
export class ConcordiumIdentity {
  /**
   * @param seed The wallet's BIP-39 seed phrase, or its 64-byte seed.
   * @param config e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG; use the same key derivation as the wallet package.
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
  waitForIdentity(codeUri: string, options: WaitForIdentityOptions): Promise<IdentitySummary>;
  /**
   * parseIdentityCallback followed by waitForIdentity.
   * @throws {IdentityIssuanceError} reason 'provider-error', 'rejected', 'timeout' or 'cancelled'.
   */
  retrieveIdentity(callbackUrl: string, options: WaitForIdentityOptions): Promise<IdentitySummary>;
  /** True once dispose() has been called. */
  get disposed(): boolean;
  /** Zero the seed and any collected identities, and drop them; later calls that need the seed throw. */
  dispose(): void;
}
