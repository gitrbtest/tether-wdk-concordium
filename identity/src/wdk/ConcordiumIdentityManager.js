/**
 * Concordium's identity manager for WDK: this package behind WDK's `IdentityManager` interface (from
 * `@tetherto/wdk-wallet/identity`), so a WDK app registers it with `wdk.registerIdentity` next to the Concordium
 * wallet and gets the seed from WDK.
 *
 *   wdk.registerIdentity('concordium', ConcordiumIdentityManager, identityConfig)
 *     │  WDK passes its seed
 *     ▼
 *   ConcordiumIdentityManager ── each method ──► ConcordiumIdentity (this package, unchanged)
 *     getProviders           IdentityProviders, checked against the chain
 *     startVerification      nextIdentityIndex, then createIdentityRequest
 *     completeVerification   retrieveIdentity
 *     recover                recoverAll
 *     createAccount          nextCredNumber, then createAccount
 *     exportIdentity / importIdentity, prove (from the identity itself)
 *
 * An identity is referred to as `{ providerIndex, identityIndex }`. The package's errors become WDK's `IdentityError`
 * (the package's own error is its `cause`).
 */
import IdentityManager, { IdentityError, IdentityErrorReason } from '@tetherto/wdk-wallet/identity';
import ConcordiumIdentity from '../ConcordiumIdentity.js';
import IdentityProviders from '../providers/IdentityProviders.js';
import ChainNode from '../chain/ChainNode.js';

/** Which `IdentityError` reason each of the package's error reasons becomes (by error name, then reason). */
const REASONS = {
  IdentityProviderError: { '*': IdentityErrorReason.PROVIDER_ERROR },
  IdentityIssuanceError: { rejected: IdentityErrorReason.VERIFICATION_REJECTED, '*': IdentityErrorReason.PROVIDER_ERROR },
  IdentityRecoveryError: { 'not-yours': IdentityErrorReason.IDENTITY_NOT_FOUND, '*': IdentityErrorReason.PROVIDER_ERROR },
  IdentityStorageError: { '*': IdentityErrorReason.IDENTITY_NOT_FOUND },
  AccountCreationError: {
    'identity-expired': IdentityErrorReason.IDENTITY_EXPIRED, 'max-accounts': IdentityErrorReason.ACCOUNT_LIMIT_REACHED,
    'unknown-attribute': IdentityErrorReason.INVALID_REQUEST, '*': IdentityErrorReason.PROVIDER_ERROR,
  },
  ProofError: {
    'invalid-request': IdentityErrorReason.INVALID_REQUEST, 'unknown-attribute': IdentityErrorReason.INVALID_REQUEST,
    'not-held': IdentityErrorReason.IDENTITY_NOT_FOUND, 'identity-expired': IdentityErrorReason.IDENTITY_EXPIRED,
    '*': IdentityErrorReason.CANNOT_PROVE,
  },
};

/**
 * Runs `work`; a package error comes out as WDK's `IdentityError` (the package's error as its `cause`), anything else
 * (e.g. `ValueError`, `DisposalError`) as it is.
 */
export async function asIdentityError(work) {
  try {
    return await work();
  } catch (error) {
    // The package says "no identity held" with a plain Error (HeldIdentities.require): for WDK, IDENTITY_NOT_FOUND.
    if (error?.name === 'Error' && /^No identity is held/.test(error.message)) {
      throw new IdentityError(error.message, { reason: IdentityErrorReason.IDENTITY_NOT_FOUND, cause: error });
    }
    const reasons = REASONS[error?.name];
    if (!reasons) throw error;
    throw new IdentityError(error.message, { reason: reasons[error.reason] ?? reasons['*'], cause: error });
  }
}

/** An identity reference: `{ providerIndex, identityIndex }`, both whole numbers. */
function readIdentity(identity) {
  const { providerIndex, identityIndex } = identity ?? {};
  if (!Number.isSafeInteger(providerIndex) || !Number.isSafeInteger(identityIndex)) {
    throw new IdentityError('An identity is referred to as { providerIndex, identityIndex }.',
      { reason: IdentityErrorReason.IDENTITY_NOT_FOUND });
  }
  return { providerIndex, identityIndex };
}

/** '202609' (YYYYMM, as Concordium identities give months) → the first moment, or the last, of that month (UTC). */
function monthDate(yyyymm, end = false) {
  if (typeof yyyymm !== 'string' || !/^\d{6}$/.test(yyyymm)) return undefined;
  const year = Number(yyyymm.slice(0, 4));
  const month = Number(yyyymm.slice(4, 6));
  return end ? new Date(Date.UTC(year, month, 1) - 1) : new Date(Date.UTC(year, month - 1, 1));
}

/** The package's identity summary → WDK's `IdentitySummary` (no personal data either way). */
function summaryOf(summary, accounts) {
  const identity = { providerIndex: summary.providerIndex, identityIndex: summary.identityIndex };
  return {
    identity,
    provider: String(summary.providerIndex),
    createdAt: monthDate(summary.createdAt),
    validTo: monthDate(summary.validTo, true),
    ...(accounts ? { accounts: accounts.map(({ path, address }) => ({ path, address })) } : {}),
  };
}

export default class ConcordiumIdentityManager extends IdentityManager {
  /**
   * @param {string | Uint8Array} seed  the wallet's seed phrase or seed (WDK passes its own)
   * @param {{ useMainnetKeyDerivation: boolean, identityProviders: object[], node: object, fetch?: typeof fetch,
   *   cryptography?: object }} config  as `ConcordiumIdentity` takes it (e.g. `{ ...CONCORDIUM_TESTNET_IDENTITY_CONFIG,
   *   identityProviders, node }`), plus its options `fetch` and `cryptography`
   */
  constructor(seed, config = {}) {
    super(seed, config);
    // `_signatureCheck` is ConcordiumIdentity's internal option for the package's own tests (never pass it).
    const { fetch, cryptography, _signatureCheck, ...identityConfig } = config;
    /** @private */
    this._concordium = new ConcordiumIdentity(this._seed, identityConfig, {
      ...(fetch ? { fetch } : {}), ...(cryptography ? { cryptography } : {}), ...(_signatureCheck ? { _signatureCheck } : {}),
    });
    // The same provider list and node as ConcordiumIdentity (which has checked them), for getProviders.
    /** @private */
    this._providers = new IdentityProviders(identityConfig.identityProviders, { node: new ChainNode(identityConfig.node) });
  }

  /** The identity providers, checked against the chain's record (those not matching are left out). */
  async getProviders() {
    return asIdentityError(async () => (await this._providers.list()).map((p) => ({
      id: String(p.index), name: p.display ?? p.name, description: p.kind === 'company' ? 'Company identities (Business ID)' : 'Identities of people',
      ...(p.issuanceStart ? { url: new URL(p.issuanceStart).origin } : {}),
    })));
  }

  /**
   * @param {{ provider: string, returnUrl: string, identityIndex?: number }} options  `identityIndex`: Concordium's
   *   identity number to use (default: the next free one with this provider, found by asking it)
   */
  async startVerification({ provider, returnUrl, identityIndex } = {}) {
    return asIdentityError(async () => {
      const providerIndex = Number(provider);
      const index = identityIndex ?? await this._concordium.nextIdentityIndex({ providerIndex });
      const { issuanceUrl } = await this._concordium.createIdentityRequest({ providerIndex, identityIndex: index, redirectUri: returnUrl });
      return { url: issuanceUrl, identity: { providerIndex, identityIndex: index } };
    });
  }

  /** @param {string} reply  the address the provider sent the user back to (with its reply after #) */
  async completeVerification(identity, reply) {
    return asIdentityError(async () => summaryOf(await this._concordium.retrieveIdentity(reply, readIdentity(identity))));
  }

  async recover() {
    return asIdentityError(async () => {
      const { identities } = await this._concordium.recoverAll();
      return identities.map(({ summary, accounts }) => summaryOf(summary, accounts ?? undefined));
    });
  }

  /** @param {{ index?: number }} [options]  `index`: the account number (default: the next free one) */
  async createAccount(identity, { index } = {}) {
    return asIdentityError(async () => {
      const ref = readIdentity(identity);
      const credNumber = index ?? await this._concordium.nextCredNumber(ref);
      const { path, address } = await this._concordium.createAccount({ ...ref, credNumber });
      return { path, address };
    });
  }

  async exportIdentity(identity) {
    return asIdentityError(() => this._concordium.exportIdentity(readIdentity(identity)));
  }

  async importIdentity(exported) {
    return asIdentityError(async () => summaryOf(await this._concordium.importIdentity(exported)));
  }

  /** Proves from the identity itself, naming no account (Concordium's version 1 questions allow it). */
  async prove(identity, request) {
    return asIdentityError(() => this._concordium.prove({ ...readIdentity(identity), request }));
  }

  /**
   * Proves from one of the identity's accounts (the answer names it). Used by `ConcordiumIdentityProtocol`.
   * @param {{ providerIndex: number, identityIndex: number }} identity
   * @param {object | string} request  the website's question
   * @param {number} credNumber  the account's number under the identity
   */
  async proveFromAccount(identity, request, credNumber) {
    return asIdentityError(() => this._concordium.prove({ ...readIdentity(identity), request, credNumber }));
  }

  /** Erases the seed copies and the identities held. */
  dispose() {
    if (this.disposed) return;
    this._concordium.dispose();
    super.dispose();
  }
}
