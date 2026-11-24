// Type definitions for @concordium/wdk-identity-concordium/wdk: the package inside a WDK app, behind the identity
// interfaces proposed for WDK (@tetherto/wdk-wallet's IdentityManager and IdentityProtocol, a peer dependency).
import IdentityManager, {
  type IdentityProvider, type IdentitySummary, type IdentityAccount, type VerificationStart, type Presentation,
} from '@tetherto/wdk-wallet/identity';
import { IdentityProtocol, type ProofRequestDescription } from '@tetherto/wdk-wallet/protocols';
import type { IdentityConfig, ConcordiumCryptography, AnyProofRequest } from './index.js';

/** How the identity manager refers to a Concordium identity. */
export interface ConcordiumIdentityReference {
  providerIndex: number;
  identityIndex: number;
}

/** The configuration `wdk.registerIdentity` passes on: ConcordiumIdentity's configuration plus its options. */
export type ConcordiumIdentityManagerConfig = IdentityConfig & { fetch?: typeof fetch; cryptography?: Partial<ConcordiumCryptography> };

/** Concordium's identity manager for WDK: `wdk.registerIdentity('concordium', ConcordiumIdentityManager, config)`. */
export class ConcordiumIdentityManager extends IdentityManager {
  constructor(seed: string | Uint8Array, config: ConcordiumIdentityManagerConfig);
  getProviders(): Promise<IdentityProvider[]>;
  /** `identityIndex`: Concordium's identity number to use (default: the next free one with this provider). */
  startVerification(options: { provider: string; returnUrl: string; identityIndex?: number }): Promise<VerificationStart>;
  /** `reply`: the address the provider sent the user back to (with its reply after #). */
  completeVerification(identity: ConcordiumIdentityReference, reply: string): Promise<IdentitySummary>;
  recover(): Promise<IdentitySummary[]>;
  /** `index`: the account number under the identity (default: the next free one). */
  createAccount(identity: ConcordiumIdentityReference, options?: { index?: number }): Promise<IdentityAccount>;
  exportIdentity(identity: ConcordiumIdentityReference): Promise<string>;
  importIdentity(exported: string): Promise<IdentitySummary>;
  /** Proves from the identity itself, naming no account. */
  prove(identity: ConcordiumIdentityReference, request: AnyProofRequest): Promise<Presentation>;
  /** Proves from one of the identity's accounts (the answer names it); used by ConcordiumIdentityProtocol. */
  proveFromAccount(identity: ConcordiumIdentityReference, request: AnyProofRequest, credNumber: number): Promise<Presentation>;
  dispose(): void;
}

/** Concordium's identity protocol for WDK: `wdk.registerIdentityProtocol('concordium', label, ConcordiumIdentityProtocol)`. */
export class ConcordiumIdentityProtocol extends IdentityProtocol {
  describeRequest(request: AnyProofRequest): Promise<ProofRequestDescription>;
  /** Proves from this account (its path is '<provider>/<identity>/<account>'). */
  prove(request: AnyProofRequest): Promise<Presentation>;
}
