/**
 * Concordium's identity manager for WDK: this package behind WDK's `IdentityManager` interface (from
 * `@tetherto/wdk-wallet/identity`), so a WDK app registers it with `wdk.registerIdentity` next to the Concordium
 * wallet and gets the seed from WDK.
 *
 *   wdk.registerIdentity('concordium', ConcordiumIdentityManager, identityConfig)
 *     │  WDK passes its seed
 *     ▼
 *   ConcordiumIdentityManager ── each method ──► ConcordiumIdentity (this package, unchanged)
 *     getProviders           IdentityProviders, checked against the chain; each provider's published description
 *     startVerification      nextIdentityIndex, then createIdentityRequest
 *     completeVerification   retrieveIdentity
 *     recover                recoverAll (refused if a provider could not be asked part way)
 *     createAccount          nextCredNumber, then createAccount
 *     exportIdentity / importIdentity, prove (from the identity itself)
 *
 * An identity is referred to as `{ providerIndex, identityIndex }`. The package's errors become WDK's `IdentityError`
 * (the package's own error is its `cause`); a disposed manager throws WDK's `DisposalError`, and invalid options
 * `ValueError`, as the base class documents.
 */
import { DisposalError, ValueError } from '@tetherto/wdk-wallet';
import IdentityManager, { IdentityError, IdentityErrorReason } from '@tetherto/wdk-wallet/identity';
import ConcordiumIdentity from '../ConcordiumIdentity.js';
import IdentityProviders from '../providers/IdentityProviders.js';
import ChainNode from '../chain/ChainNode.js';

const R = IdentityErrorReason;

/** Which `IdentityError` reason each of the package's error reasons becomes (by error name, then reason). */
const REASONS = {
  IdentityProviderError: { '*': R.PROVIDER_ERROR },
  // rejected: the provider refused; not-genuine: what came back is not a genuine identity for this seed.
  IdentityIssuanceError: { rejected: R.VERIFICATION_REJECTED, 'not-genuine': R.VERIFICATION_REJECTED, '*': R.PROVIDER_ERROR },
  IdentityRecoveryError: { 'not-yours': R.IDENTITY_NOT_FOUND, node: R.CHAIN_ERROR, '*': R.PROVIDER_ERROR },
  IdentityStorageError: { '*': R.IDENTITY_NOT_FOUND },
  AccountCreationError: {
    'identity-expired': R.IDENTITY_EXPIRED, 'max-accounts': R.ACCOUNT_LIMIT_REACHED, 'unknown-attribute': R.INVALID_REQUEST,
    '*': R.CHAIN_ERROR, // rejected, expired, timeout, node: the chain refused, did not confirm, or could not be reached
  },
  ProofError: {
    'invalid-request': R.INVALID_REQUEST, 'unknown-attribute': R.INVALID_REQUEST,
    'anchor-not-found': R.INVALID_REQUEST, 'anchor-mismatch': R.INVALID_REQUEST, 'anchor-failed': R.INVALID_REQUEST,
    'not-held': R.IDENTITY_NOT_FOUND, 'identity-expired': R.IDENTITY_EXPIRED, node: R.CHAIN_ERROR,
    '*': R.CANNOT_PROVE, // cannot-prove, provider-not-accepted, account-only, identity-only
  },
};

/**
 * Runs `work`; a package error comes out as WDK's `IdentityError` (the package's error as its `cause`), anything else
 * (e.g. `ValueError`) as it is.
 */
export async function asIdentityError(work) {
  try {
    return await work();
  } catch (error) {
    // The package says "no identity held" with a plain Error (HeldIdentities.require): for WDK, IDENTITY_NOT_FOUND.
    if (error?.name === 'Error' && /^No identity is held/.test(error.message)) {
      throw new IdentityError(error.message, { reason: R.IDENTITY_NOT_FOUND, cause: error });
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
    throw new IdentityError('An identity is referred to as { providerIndex, identityIndex }.', { reason: R.IDENTITY_NOT_FOUND });
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
    /** @private Each provider's description and website as it publishes them, by its number. */
    this._published = new Map(identityConfig.identityProviders.map((entry) => [entry.ipInfo?.ipIdentity, entry.ipInfo?.ipDescription ?? {}]));
  }

  /** @private A disposed manager throws DisposalError, as the base class documents. */
  _requireNotDisposed() {
    if (this.disposed) throw new DisposalError('The identity manager has been disposed.');
  }

  /** The identity providers, checked against the chain's record (those not matching are left out). */
  async getProviders() {
    this._requireNotDisposed();
    return asIdentityError(async () => (await this._providers.list()).map((p) => {
      const { description, url } = this._published.get(p.index) ?? {};
      return { id: String(p.index), name: p.display ?? p.name, ...(description ? { description } : {}), ...(url ? { url } : {}) };
    }));
  }

  /**
   * @param {{ provider: string, returnUrl: string, identityIndex?: number }} options  `provider`: one of getProviders()'
   *   ids; `identityIndex`: Concordium's identity number to use (default: the next free one with this provider)
   */
  async startVerification({ provider, returnUrl, identityIndex } = {}) {
    this._requireNotDisposed();
    if (!/^\d+$/.test(String(provider ?? ''))) {
      throw new ValueError(`The provider must be one of getProviders()' ids, e.g. '0' (got ${JSON.stringify(provider)}).`);
    }
    if (typeof returnUrl !== 'string' || !returnUrl) {
      throw new ValueError('A returnUrl is required: where the provider sends the user back to.');
    }
    return asIdentityError(async () => {
      const providerIndex = Number(provider);
      const index = identityIndex ?? await this._concordium.nextIdentityIndex({ providerIndex });
      const { issuanceUrl } = await this._concordium.createIdentityRequest({ providerIndex, identityIndex: index, redirectUri: returnUrl });
      return { url: issuanceUrl, identity: { providerIndex, identityIndex: index } };
    });
  }

  /** @param {string} reply  the address the provider sent the user back to (with its reply after #) */
  async completeVerification(identity, reply) {
    this._requireNotDisposed();
    return asIdentityError(async () => summaryOf(await this._concordium.retrieveIdentity(reply, readIdentity(identity))));
  }

  /**
   * Every identity of the seed, with its accounts. If a provider could not be asked part way (e.g. it was down), the
   * list would be incomplete without saying so: that is refused instead (PROVIDER_ERROR, worth trying again). A
   * provider that publishes no recovery address is skipped; an identity that is not genuine is never kept; an identity
   * whose accounts could not be looked up comes back without `accounts`.
   */
  async recover() {
    this._requireNotDisposed();
    return asIdentityError(async () => {
      const { identities, problems } = await this._concordium.recoverAll();
      const found = new Set(identities.map((x) => `${x.providerIndex}/${x.identityIndex}`));
      const notAsked = problems.filter((p) => p.identityIndex !== null && p.error?.reason !== 'not-genuine'
        && !found.has(`${p.providerIndex}/${p.identityIndex}`));
      if (notAsked.length) {
        const which = notAsked.map((p) => `provider ${p.providerIndex} (${p.error?.message ?? p.error})`).join('; ');
        throw new IdentityError(`Not every identity could be looked for: ${which}. Try again.`,
          { reason: R.PROVIDER_ERROR, cause: notAsked[0].error });
      }
      return identities.map(({ summary, accounts }) => summaryOf(summary, accounts ?? undefined));
    });
  }

  /** @param {{ index?: number }} [options]  `index`: the account number (default: the next free one) */
  async createAccount(identity, { index } = {}) {
    this._requireNotDisposed();
    return asIdentityError(async () => {
      const ref = readIdentity(identity);
      const credNumber = index ?? await this._concordium.nextCredNumber(ref);
      const { path, address } = await this._concordium.createAccount({ ...ref, credNumber });
      return { path, address };
    });
  }

  async exportIdentity(identity) {
    this._requireNotDisposed();
    return asIdentityError(() => this._concordium.exportIdentity(readIdentity(identity)));
  }

  async importIdentity(exported) {
    this._requireNotDisposed();
    return asIdentityError(async () => summaryOf(await this._concordium.importIdentity(exported)));
  }

  /** Proves from the identity itself, naming no account (Concordium's version 1 questions allow it). */
  async prove(identity, request) {
    this._requireNotDisposed();
    return asIdentityError(() => this._concordium.prove({ ...readIdentity(identity), request }));
  }

  /**
   * Proves from one of the identity's accounts (the answer names it). Used by `ConcordiumIdentityProtocol`.
   * @param {{ providerIndex: number, identityIndex: number }} identity
   * @param {object | string} request  the website's question
   * @param {number} credNumber  the account's number under the identity
   */
  async proveFromAccount(identity, request, credNumber) {
    this._requireNotDisposed();
    return asIdentityError(() => this._concordium.prove({ ...readIdentity(identity), request, credNumber }));
  }

  /** Erases the seed copies and the identities held. */
  dispose() {
    if (this.disposed) return;
    this._concordium.dispose();
    super.dispose();
  }
}
