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

/**
 * Thrown when a saved identity cannot be used or saved: the bytes in a storage slot cannot be decrypted
 * with this wallet's seed, are not identity data, or use an unknown format version; or a different
 * identity is already saved where saveIdentity was asked to save.
 */
export class IdentityStorageError extends Error {
  /** unreadable-slot: the saved bytes cannot be decrypted, are not identity data, or use an unknown format version.
   *  slot-in-use: saveIdentity found a different identity already saved there (pass { replace: true } to replace it). */
  reason: 'unreadable-slot' | 'slot-in-use';
  /** The storage slot concerned, e.g. 'concordium-identity/testnet/0/0'. */
  slotName?: string;
}

/**
 * Where encrypted identities are kept: any object with these three methods (a phone's storage,
 * a backend, a database…). It only ever receives encrypted bytes and a slot name such as
 * 'concordium-identity/testnet/0/0', never the identity itself.
 */
export interface IdentityStore {
  /** Save the bytes under the slot name, replacing anything saved there before. */
  save(slotName: string, bytes: Uint8Array): Promise<void>;
  /** The bytes saved under the slot name, or null if there are none. */
  read(slotName: string): Promise<Uint8Array | null>;
  /** Remove what is saved under the slot name. Nothing saved there is not an error. */
  delete(slotName: string): Promise<void>;
}

/** An IdentityStore in memory: for tests and short-lived processes; nothing survives the process. */
export class MemoryIdentityStore implements IdentityStore {
  save(slotName: string, bytes: Uint8Array): Promise<void>;
  read(slotName: string): Promise<Uint8Array | null>;
  delete(slotName: string): Promise<void>;
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
  /** The provider the identity request was made to. Defaults to that of the last createIdentityRequest on this object. */
  providerIndex?: number;
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

/** Which saved identity: the provider and the wallet's identity index. */
export interface IdentitySlot {
  providerIndex: number;
  identityIndex: number;
}

export interface SaveIdentityOptions extends IdentitySlot {
  /** Replace a different identity (or unreadable bytes) already saved there. Ask the user first. */
  replace?: boolean;
}

/** An identity's summary and the slot it was saved in. */
export interface SavedIdentitySummary extends IdentitySummary {
  /** e.g. 'concordium-identity/testnet/0/0' */
  slotName: string;
}

/** A wallet's Concordium identity, derived from the wallet's own seed. */
export class ConcordiumIdentity {
  /**
   * @param seed The wallet's BIP-39 seed phrase, or its 64-byte seed.
   * @param config e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG; use the same key derivation as the wallet package.
   */
  /**
   * @param options.fetch HTTP implementation (defaults to the global fetch).
   * @param options.store Where saveIdentity / loadIdentity keep encrypted identities.
   */
  constructor(seed: string | Uint8Array, config: IdentityConfig, options?: { fetch?: typeof fetch; store?: IdentityStore });
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
   * Save the identity held for a provider and identity index, encrypted, in the configured store. The store
   * receives only encrypted bytes and the slot name. A different identity already saved there is not
   * replaced unless { replace: true }.
   * @throws {IdentityStorageError} reason 'slot-in-use' or 'unreadable-slot' (unless replace).
   * @throws {Error} If no store is configured, no identity is held for the slot, or the identity has been disposed.
   */
  saveIdentity(options: SaveIdentityOptions): Promise<SavedIdentitySummary>;
  /**
   * Load a saved identity from the configured store and hold it inside this object again. No network call.
   * @returns The summary, or null if nothing is saved for that slot.
   * @throws {IdentityStorageError} reason 'unreadable-slot' if the saved bytes cannot be decrypted.
   */
  loadIdentity(slot: IdentitySlot): Promise<IdentitySummary | null>;
  /** Delete the saved identity from the configured store. An identity held in this object is kept. */
  deleteIdentity(slot: IdentitySlot): Promise<void>;
  /** True once dispose() has been called. */
  get disposed(): boolean;
  /** Zero the seed and any collected identities, and drop them; later calls that need the seed throw. */
  dispose(): void;
}
