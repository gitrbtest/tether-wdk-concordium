/**
 * Creating an account on chain from an identity: the checks made before anything is sent, "does it exist
 * already?", building the credential and sending it until the account is final.
 * Internal: ConcordiumIdentity.createAccount hands each call on to this.
 *
 *   checks ─► address ─► exists? ──yes──► { created: false }  (nothing sent)
 *                           └─no──► build credential ─► send + wait ─► { created: true }
 */
import { AccountCreationError } from '../shared/errors.js';
import { requireIndex, requirePositive } from '../shared/inputs.js';
import { identityContent, hasExpired } from '../issuance/identity-object.js';
import { buildAccountCredential, accountAddressOf, ATTRIBUTE_NAMES } from './credential.js';
import { submitAndWait, DEFAULT_ACCOUNT_TIMEOUT_MS, DEFAULT_ACCOUNT_INTERVAL_MS } from './submission.js';

/**
 * The credential stays valid for the whole wait plus this margin, so it cannot expire while createAccount
 * is still waiting for it.
 */
const ACCOUNT_CREDENTIAL_MARGIN_MS = 2 * 60 * 1000;

/**
 * createAccount's options, checked, with their defaults filled in. Throws a plain Error for invalid input.
 * @returns {{ providerIndex: number, identityIndex: number, credNumber: number, revealAttributes: string[],
 *   timeoutMs: number, intervalMs: number, signal?: AbortSignal }}
 */
export function readAccountOptions({
  providerIndex, identityIndex, credNumber = 0, revealAttributes = [],
  timeoutMs = DEFAULT_ACCOUNT_TIMEOUT_MS, intervalMs = DEFAULT_ACCOUNT_INTERVAL_MS, signal,
} = {}) {
  requireIndex(providerIndex, 'providerIndex');
  requireIndex(identityIndex, 'identityIndex');
  requireIndex(credNumber, 'credNumber');
  requirePositive(timeoutMs, 'timeoutMs');
  requirePositive(intervalMs, 'intervalMs');
  if (!Array.isArray(revealAttributes) || !revealAttributes.every((name) => typeof name === 'string')) {
    throw new Error('revealAttributes must be an array of attribute names.');
  }
  return { providerIndex, identityIndex, credNumber, revealAttributes: [...new Set(revealAttributes)], timeoutMs, intervalMs, signal };
}

export default class AccountCreator {
  #providers;
  #walletProxy;
  #hdWallet;

  /**
   * @param {{ providers: object, walletProxy: object, hdWallet: () => object }} collaborators
   *   hdWallet: returns the key derivation for the wallet's seed (throws once the seed is disposed)
   */
  constructor({ providers, walletProxy, hdWallet }) {
    this.#providers = providers;
    this.#walletProxy = walletProxy;
    this.#hdWallet = hdWallet;
  }

  /**
   * Create account `request.credNumber` from `identityObject`. See ConcordiumIdentity.createAccount.
   * @param {object} identityObject  the issued identity (as held)
   * @param {ReturnType<typeof readAccountOptions>} request
   */
  async create(identityObject, request) {
    const { providerIndex, identityIndex, credNumber, revealAttributes, timeoutMs, intervalMs, signal } = request;
    const identity = identityContent(identityObject, 'The identity held is in an unexpected format.');
    checkBeforeSending(identity, request);

    const provider = await this.#providers.get(providerIndex);
    const globalContext = await this.#walletProxy.globalContext();
    const hdWallet = this.#hdWallet();
    const address = accountAddressOf({ provider, globalContext, hdWallet, identityIndex, credNumber });
    // path: how the wallet package asks for this account, getAccountByPath('provider/identity/credNumber').
    const result = { providerIndex, identityIndex, credNumber, path: `${providerIndex}/${identityIndex}/${credNumber}`, address };

    // Already on chain (e.g. created before a restart): return it, send nothing.
    if (await this.#exists(address, signal)) return { ...result, created: false };

    const credential = await buildAccountCredential({
      provider, globalContext, hdWallet, idObject: identity, identityIndex, credNumber, revealAttributes,
      expiry: new Date(Date.now() + timeoutMs + ACCOUNT_CREDENTIAL_MARGIN_MS),
    });
    const { transactionHash, blockHash } = await submitAndWait({
      walletProxy: this.#walletProxy, credential, timeoutMs, intervalMs, signal,
    });
    return { ...result, created: true, transactionHash, blockHash };
  }

  /** Whether the account exists on chain; a wallet-proxy failure is an AccountCreationError. */
  async #exists(address, signal) {
    try {
      return await this.#walletProxy.accountExists(address, { signal });
    } catch (e) {
      if (signal?.aborted) {
        throw new AccountCreationError('Creating the account was cancelled before anything was sent.', { reason: 'cancelled', address });
      }
      throw new AccountCreationError(`The wallet-proxy could not say whether account ${address} exists: ${e.message}`,
        { reason: 'wallet-proxy', address, detail: e.message });
    }
  }
}

/** The checks made before anything is sent: each gives its own reason. */
function checkBeforeSending(identity, { credNumber, revealAttributes }) {
  const { validTo, maxAccounts, chosenAttributes } = identity.attributeList;
  if (hasExpired(identity)) {
    throw new AccountCreationError(`The identity expired at the end of ${validTo.slice(0, 4)}-${validTo.slice(4)}: `
      + 'verify again for a new identity to create accounts.', { reason: 'identity-expired' });
  }
  if (credNumber >= maxAccounts) {
    throw new AccountCreationError(`This identity allows ${maxAccounts} accounts (credNumber 0 to ${maxAccounts - 1}); `
      + `credNumber ${credNumber} is not one of them.`, { reason: 'max-accounts' });
  }
  const unknown = revealAttributes.find((name) => !ATTRIBUTE_NAMES.includes(name) || !(name in chosenAttributes));
  if (unknown !== undefined) {
    throw new AccountCreationError(`"${unknown}" is not an attribute this identity holds, so it cannot be revealed.`,
      { reason: 'unknown-attribute', detail: unknown });
  }
}
