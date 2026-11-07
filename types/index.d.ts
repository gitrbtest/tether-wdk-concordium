/// <reference lib="es2022.error" />

// Type definitions for @concordium/wdk-wallet-concordium
//
// Built on the Tether base package: the manager extends WalletManager and the
// account extends WalletAccountReadOnly / implements IWalletAccount, plus
// Concordium-specific extras (tokens, sponsored transactions, account recovery).

import WalletManager, {
  WalletAccountReadOnly,
  IWalletAccount,
  WalletConfig,
  TransferError,
} from '@tetherto/wdk-wallet';

export interface WalletManagerConcordiumConfig extends WalletConfig {
  /** Selects Mainnet keys when true, Testnet-compatible keys otherwise. Does not verify the chain. */
  useMainnetKeyDerivation: boolean;
  /** Required gRPC HTTP(S) URL. HTTPS enables TLS; default ports are 443/80. No credentials, path, query, or fragment. */
  grpcUrl: string;
}

/** Public endpoint presets; spread to customize. */
export const CONCORDIUM_MAINNET_CONFIG: {
  useMainnetKeyDerivation: boolean;
  grpcUrl: string;
};
export const CONCORDIUM_TESTNET_CONFIG: {
  useMainnetKeyDerivation: boolean;
  grpcUrl: string;
};

/** Options for recovering accounts under a single identity. */
export interface RecoverAccountsForIdentityOptions {
  providerIndex: number;
  identityIndex: number;
  /** First credential counter to try. Default 0. */
  startIndex?: number;
  /** Stop after this many consecutive empty indexes. Default 3. */
  gapLimit?: number;
  /** Hard cap on how far to scan. Default 50. */
  maxIndex?: number;
}

/** A native CCD transfer request. */
export interface TransactionRequest {
  to: string;
  /** microCCD. */
  value: number | bigint;
}

/** Result of a broadcast transaction/transfer (fee in microCCD). */
export interface TransactionResult {
  hash: string;
  fee: bigint;
}

/** A fee quote (microCCD), returned without broadcasting. */
export interface FeeQuote {
  fee: bigint;
}

/** Options for a token transfer (PLT or CIS-2), amount in base units. */
export interface TransferOptions {
  /** Token identifier: "USDT"/"plt:USDT" (PLT) or "cis2:<index>:<subindex>:<tokenIdHex>". */
  token: string;
  recipient: string;
  amount: number | bigint;
}

/** CIS-2 off-chain metadata: a URL on the contract and the parsed JSON (null if unreachable). */
export interface Cis2Metadata {
  url: string;
  metadata: Record<string, unknown> | null;
}

/**
 * A token's rules, from getTokenRules. For a protocol-level token (PLT): whether it is paused, and whether it keeps an
 * allow list (only accounts on it may send or receive) and a deny list (accounts on it may not). A CIS-2 token has no
 * standard rules (its contract decides when transferring): every rule is null.
 */
export interface TokenRules {
  kind: 'plt' | 'cis2';
  /** The token's identifier, e.g. 'UPEU' (as the chain spells it) or 'cis2:12754:0:01'. */
  token: string;
  name: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  paused: boolean | null;
  allowList: boolean | null;
  denyList: boolean | null;
  mintable: boolean | null;
  burnable: boolean | null;
  /** The account that manages the token (its lists, pausing). */
  governanceAccount: string | null;
  metadataUrl: string | null;
}

/** One account's standing with a token, from getTokenAccountStatus. */
export interface TokenAccountStatus {
  token: string;
  address: string;
  /** false for an address with no account on chain (its balance is then 0). */
  exists: boolean;
  /** In the token's base units. */
  balance: bigint;
  /** null when the token keeps no allow list (and for CIS-2 tokens). */
  onAllowList: boolean | null;
  /** null when the token keeps no deny list (and for CIS-2 tokens). */
  onDenyList: boolean | null;
}

/**
 * A serialized sponsored transaction (Transaction.JSON) passed between the
 * build/sign/submit steps. Treat it as an opaque value.
 */
export type SponsoredTransactionJSON = Record<string, unknown>;

/** Options to build an unsigned sponsorable PLT transfer. */
export interface BuildSponsorableTransferOptions {
  /** PLT token identifier (sponsored transfers currently target PLT). */
  token: string;
  recipient: string;
  amount: number | bigint;
  /** The account that will co-sign and pay the fee. */
  sponsorAddress: string;
}

export class AccountNotCreatedError extends Error {
  constructor(address?: string, options?: { path?: string });
  address?: string;
  /** Present when an explicit derivation path has no on-chain account. */
  path?: string;
}

/**
 * Thrown when a transaction finalizes but its on-chain outcome is a rejection.
 * The transaction still has a hash and cost the fee; it just didn't take effect.
 */
/**
 * Why a token transfer cannot happen (checkTransfer's reasons): WDK's own TransferErrorReason values plus
 * Concordium's token rules.
 */
export const ConcordiumTransferErrorReason: {
  /** The account that pays the fee (this one, or the sponsor) holds too little CCD for it. */
  readonly INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE';
  /** This account holds too little of the token. */
  readonly INSUFFICIENT_TOKEN_BALANCE: 'INSUFFICIENT_TOKEN_BALANCE';
  /** The amount is not a whole number of base units above 0. */
  readonly INVALID_AMOUNT: 'INVALID_AMOUNT';
  /** The token is paused: no transfers until its issuer resumes it. */
  readonly TOKEN_PAUSED: 'TOKEN_PAUSED';
  readonly SENDER_NOT_FOUND: 'SENDER_NOT_FOUND';
  readonly RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND';
  readonly SPONSOR_NOT_FOUND: 'SPONSOR_NOT_FOUND';
  readonly SENDER_NOT_ON_ALLOW_LIST: 'SENDER_NOT_ON_ALLOW_LIST';
  readonly RECIPIENT_NOT_ON_ALLOW_LIST: 'RECIPIENT_NOT_ON_ALLOW_LIST';
  readonly SENDER_ON_DENY_LIST: 'SENDER_ON_DENY_LIST';
  readonly RECIPIENT_ON_DENY_LIST: 'RECIPIENT_ON_DENY_LIST';
  /** A CIS-2 token's contract would refuse the transfer (its own rules). */
  readonly CONTRACT_REFUSED: 'CONTRACT_REFUSED';
  /** Only when the chain refused a sent transfer: the token did not permit it, and its rules now do not say why. */
  readonly OPERATION_NOT_PERMITTED: 'OPERATION_NOT_PERMITTED';
  /** Only when the chain refused a sent transfer, for another reason (see rejectReason). */
  readonly REJECTED: 'REJECTED';
};

/**
 * A token transfer that cannot happen (nothing sent), or that the chain refused (`hash` set; the fee was charged):
 * WDK's TransferError with Concordium's reasons.
 */
export class ConcordiumTransferError extends TransferError {
  constructor(message: string, options: { reason: ConcordiumTransferErrorReason; reasons?: TransferCheck['reasons']; hash?: string; rejectReason?: unknown; cause?: unknown });
  /** The first reason. */
  reason: ConcordiumTransferErrorReason;
  /** Every reason found, each with a plain message and the account it concerns. */
  reasons: TransferCheck['reasons'];
  /** The transaction's hash, only when it was sent and the chain refused it. */
  hash: string | null;
  /** The chain's own reject reason, when it refused it. */
  rejectReason: unknown | null;
}
export type ConcordiumTransferErrorReason = typeof ConcordiumTransferErrorReason[keyof typeof ConcordiumTransferErrorReason];

/** Options for checkTransfer: the transfer, and for a sponsored one, who pays the fee. */
export interface CheckTransferOptions {
  token: string;
  recipient: string;
  /** In the token's base units. */
  amount: number | bigint | string;
  /** For a sponsored transfer: the sponsor pays the fee. */
  sponsorAddress?: string;
}

/** What checkTransfer found. */
export interface TransferCheck {
  /** true: nothing found that would refuse the transfer. */
  ok: boolean;
  /** Every problem found, each with a plain message and the account it concerns. */
  reasons: Array<{ reason: ConcordiumTransferErrorReason; message: string; account?: string }>;
  /** The fee in microCCD, when it could be worked out. */
  fee: bigint | null;
}

export class TransactionRejectedError extends Error {
  /** The finalized transaction hash. */
  hash: string;
  /** The SDK reject reason (a tagged object with a `tag`), or null if unavailable. */
  rejectReason: unknown | null;
}

export class WalletAccountConcordium extends WalletAccountReadOnly implements IWalletAccount {
  get disposed(): boolean;
  get path(): string;
  get keyPair(): { publicKey: Uint8Array; privateKey: Uint8Array | null };

  // ---- reads ----
  getAddress(): Promise<string>;
  getBalance(): Promise<bigint>;
  /** Read the CCD balance of an explicit Base58 address (any account). */
  getBalanceForAddress(address: string): Promise<bigint>;
  getTransactionReceipt(hash: string): Promise<unknown | null>;
  /** Normalized receipts are unsupported; rejects with NotImplementedError. */
  getTransaction(hash: string): Promise<never>;
  toReadOnlyAccount(): Promise<WalletAccountReadOnly>;
  dispose(): void;

  // ---- messages ----
  sign(message: string): Promise<string>;
  verify(message: string, signature: string): Promise<boolean>;

  // ---- native CCD ----
  /** Sign a native CCD transfer, returning the finalized (unbroadcast) transaction. */
  signTransaction(tx: TransactionRequest): Promise<unknown>;
  /** Send native CCD. Accepts a { to, value } request or an already-signed transaction. */
  sendTransaction(tx: TransactionRequest | unknown): Promise<TransactionResult>;
  quoteSendTransaction(tx: TransactionRequest): Promise<FeeQuote>;

  // ---- tokens (generic over PLT and CIS-2) ----
  getTokenBalance(tokenAddress: string): Promise<bigint>;
  transfer(options: TransferOptions): Promise<TransactionResult>;
  quoteTransfer(options: TransferOptions): Promise<FeeQuote>;
  /** Resolve a CIS-2 token's off-chain metadata (name/symbol/decimals) via its URL. */
  getCis2Metadata(tokenAddress: string): Promise<Cis2Metadata>;

  // ---- token rules (regulated tokens) ----
  /**
   * A token's rules as the chain holds them now: paused? an allow list? a deny list? (CIS-2: all null).
   * @throws {InvalidTokenError} If there is no such PLT on this network.
   */
  getTokenRules(tokenAddress: string): Promise<TokenRules>;
  /**
   * An account's standing with a token: on chain? its balance; on the allow list? on the deny list?
   * @param address The account (Base58); default: this account.
   * @throws {InvalidTokenError} If there is no such PLT on this network.
   */
  getTokenAccountStatus(tokenAddress: string, address?: string): Promise<TokenAccountStatus>;
  /**
   * Check a token transfer before sending: every reason it would be refused (the token, this account, the recipient,
   * the fee and who pays it), with nothing sent. CIS-2: a dry run shows whether the contract would refuse.
   * @throws {InvalidTokenError} If there is no such PLT on this network.
   * @throws {ValueError} If the recipient (or the sponsor) is not an account address.
   */
  checkTransfer(options: CheckTransferOptions): Promise<TransferCheck>;

  // ---- sponsored transactions (Concordium extension) ----
  /** SENDER builds the unsigned sponsorable PLT transfer (sets sender metadata + sponsor). */
  buildSponsorableTransfer(options: BuildSponsorableTransferOptions): Promise<SponsoredTransactionJSON>;
  /** (1) account signs first — result still awaits the sponsor. */
  signAsAccountToBeSponsored(tx: SponsoredTransactionJSON): Promise<SponsoredTransactionJSON>;
  /** (2) account signs a sponsor-signed transaction — result is complete. */
  signAsAccountPreSponsored(tx: SponsoredTransactionJSON): Promise<SponsoredTransactionJSON>;
  /** (3) sponsor signs first — result still awaits the account. */
  signAsSponsorToBeSigned(tx: SponsoredTransactionJSON): Promise<SponsoredTransactionJSON>;
  /** (4) sponsor signs an account-signed transaction — result is complete. */
  signAsSponsorSigned(tx: SponsoredTransactionJSON): Promise<SponsoredTransactionJSON>;
  /** Broadcast a fully-signed sponsored transaction (both signatures present). */
  submitSponsored(tx: SponsoredTransactionJSON): Promise<TransactionResult>;
}

export default class WalletManagerConcordium extends WalletManager {
  constructor(seed: string | Uint8Array, config: WalletManagerConcordiumConfig);
  /** Unsupported; use getAccountByPath with all three identity coordinates. */
  getAccount(index?: number, options?: { signerName?: string }): Promise<never>;
  getAccount(signerName: string): Promise<never>;
  /** Verifies the credential through a fresh node lookup; rejects with AccountNotCreatedError on NOT_FOUND. */
  getAccountByPath(path: string): Promise<WalletAccountConcordium>;
  /** Not applicable on Concordium (energy-based fees) — throws. Use the quote methods. */
  getFeeRates(): Promise<never>;
  /** List Protocol-Level Token ids available on this network. */
  listTokens(limit?: number): Promise<string[]>;

  // ---- account recovery ----
  /**
   * Recover accounts for one explicit identity through node credential-ID lookup.
   * Returns one instance per path after the scan succeeds. NOT_FOUND counts as a
   * miss; other lookup errors reject recovery.
   */
  recoverAccountsForIdentity(options: RecoverAccountsForIdentityOptions): Promise<WalletAccountConcordium[]>;

  dispose(): void;
}

export { WalletManagerConcordium };
