/**
 * WalletManagerConcordium
 * -------------------------------------------------------------------
 * Extends `WalletManager` from `@tetherto/wdk-wallet` with Concordium account
 * lookup and recovery, inheriting seed handling and account bookkeeping.
 *
 * Accounts are selected only by explicit "provider/identity/credentialCounter"
 * paths. Manager configuration does not select an identity.
 */

import WalletManager, { DisposalError, NotImplementedError, ValueError } from '@tetherto/wdk-wallet';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import WalletAccountConcordium, { AccountNotCreatedError } from './WalletAccountConcordium.js';
import { parseConfig } from './config.js';

import { validateIdentityCoordinates, validateCredNumber } from './identity-coordinates.js';

/** Concordium's key derivation takes a 64-byte seed: what a seed phrase becomes. */
const SEED_BYTES = 64;

export default class WalletManagerConcordium extends WalletManager {
  /**
   * @param {string | Uint8Array} seed  BIP-39 mnemonic or raw seed bytes.
   * @param {object} config WDK WalletConfig plus required useMainnetKeyDerivation
   *   and grpcUrl.
   * @throws {ValueError} If the seed phrase is invalid, or raw seed bytes are not 64 bytes long.
   * @throws {Error} If configuration is missing or invalid.
   */
  constructor(seed, config) {
    // The base accepts raw seeds of 16 to 64 bytes, but Concordium's SDK needs exactly 64, and its error
    // for any other length repeats the whole seed. Refuse it here, without the seed in the message.
    if (seed instanceof Uint8Array && seed.length !== SEED_BYTES) {
      throw new ValueError('The seed must be a BIP-39 seed phrase or a 64-byte seed.');
    }
    const parsed = parseConfig(config);
    super(seed, config);                       // base stores the seed + config
    this._ccd = parsed;
    this._client = null;   // shared gRPC client (lazy)
    this._global = null;   // cached cryptographic parameters
  }

  /** The 64-byte BIP-39 seed (inherited from the base) as hex, for ConcordiumHdWallet. */
  get _seedHex() {
    if (!this.seed) throw new DisposalError('The wallet manager has been disposed.');
    return Buffer.from(this.seed).toString('hex');
  }

  async _getClient() {
    if (!this._client) {
      const { host, port, secure } = this._ccd.grpcEndpoint;
      this._client = new ConcordiumGRPCNodeClient(
        host, port, secure ? credentials.createSsl() : credentials.createInsecure()
      );
    }
    return this._client;
  }

  async _getGlobal() {
    if (!this._global) this._global = await (await this._getClient()).getCryptographicParameters();
    return this._global;
  }

  /** Derive a credential ID and look it up at the node's default finalized block. */
  async _lookupAccountInfo(providerIndex, identityIndex, credNumber) {
    const global = await this._getGlobal();
    const onChainCommitmentKey = global?.onChainCommitmentKey ?? global?.value?.onChainCommitmentKey;
    const wallet = sdk.ConcordiumHdWallet.fromHex(this._seedHex, this._ccd.derivationNetwork);
    const credentialId = sdk.CredentialRegistrationId.fromHexString(
      wallet.getCredentialId(providerIndex, identityIndex, credNumber, { onChainCommitmentKey }).toString('hex')
    );
    const client = await this._getClient();
    try {
      return await client.getAccountInfo(credentialId);
    } catch (error) {
      if (sdk.isRpcError(error) && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  /** Unsupported: all identity coordinates must be supplied through a path. */
  async getAccount(_index, _options) {
    throw new NotImplementedError('getAccount is not supported. Use getAccountByPath("provider/identity/credentialCounter").');
  }

  /**
   * Get an existing account by explicit Concordium path "provider/identity/cred".
   * Performs a fresh credential-ID lookup before creating or registering it.
   * (Concordium's key space is a 3-tuple, so we use this form rather than a
   * BIP-44 string.)
   */
  async getAccountByPath(path, _options = {}) {
    const value = String(path);
    // Require a canonical "provider/identity/cred" of non-negative integers with
    // no leading zeros and nothing extra — parseInt would accept sloppy input
    // like "1x" or " 1 ", which we reject here.
    if (!/^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/.test(value)) {
      throw new Error(`Invalid Concordium path "${path}". Use "provider/identity/cred", e.g. "0/0/3".`);
    }
    const [p, id, cred] = value.split('/').map(Number);
    if (![p, id, cred].every(Number.isSafeInteger)) {
      throw new Error(`Concordium path "${path}" exceeds the supported integer range.`);
    }
    // Within Concordium's ranges: outside them the SDK would silently reduce the number to another account's.
    try {
      validateIdentityCoordinates(p, id);
      validateCredNumber(cred, 'the account number (the last part)');
    } catch (e) {
      throw new Error(`Concordium path "${path}": ${e.message}`);
    }
    const info = await this._lookupAccountInfo(p, id, cred);
    if (!info) throw new AccountNotCreatedError(undefined, { path: value });
    return this._makeAccount(p, id, cred, info.accountAddress.toString());
  }

  /** Unsupported: Concordium fees are energy-based; use transaction-specific quotes. */
  async getFeeRates() {
    throw new NotImplementedError('getFeeRates is not supported. Concordium uses energy-based fees; use transaction-specific quote methods.');
  }

  /**
   * List the Protocol-Level Token ids available on this network (convenience,
   * beyond the standard WDK interface).
   * @returns {Promise<string[]>}
   */
  async listTokens(limit = 50) {
    const client = await this._getClient();
    const ids = [];
    for await (const t of client.getTokenList()) {
      ids.push(t?.id?.toString?.() ?? t?.tokenId?.toString?.() ?? String(t));
      if (ids.length >= limit) break;
    }
    return ids;
  }

  /**
   * Recover accounts for one identity by deriving credential registration IDs
   * and querying the node. Stops after `gapLimit` consecutive missing credentials.
   * Only NOT_FOUND is a miss; other service failures reject the complete scan.
   *
   * @param {object} opts
   * @param {number} opts.providerIndex Required identity-provider index.
   * @param {number} opts.identityIndex Required identity index.
   * @param {number}  [opts.startIndex=0]   First credential counter to try.
   * @param {number}  [opts.gapLimit=3]     Stop after this many consecutive empty indexes.
   * @param {number}  [opts.maxIndex=50]    Hard cap on how far to scan.
   * @returns {Promise<WalletAccountConcordium[]>} One account per recovered path.
   */
  async recoverAccountsForIdentity({
    providerIndex,
    identityIndex,
    startIndex = 0,
    gapLimit = 3,
    maxIndex = 50,
  } = {}) {
    validateIdentityCoordinates(providerIndex, identityIndex);
    validateCredNumber(startIndex, 'startIndex');
    validateCredNumber(maxIndex, 'maxIndex');
    const found = [];
    let gap = 0;
    for (let i = startIndex; i <= maxIndex && gap < gapLimit; i++) {
      const info = await this._lookupAccountInfo(providerIndex, identityIndex, i);
      if (!info) {
        gap++;
        continue;
      }
      found.push({ credNumber: i, address: info.accountAddress.toString() });
      gap = 0;
    }
    // Do not create or register accounts until every lookup has succeeded.
    return Promise.all(found.map(({ credNumber, address }) =>
      this._makeAccount(providerIndex, identityIndex, credNumber, address)
    ));
  }

  dispose() {
    super.dispose();     // disposes tracked accounts
    // The base keeps the seed after dispose(), so zero the bytes and drop the reference here.
    if (this._seed instanceof Uint8Array) this._seed.fill(0);
    this._seed = undefined;
    this._client = null;
    this._global = null;
  }

  async _makeAccount(providerIndex, identityIndex, credNumber, address) {
    const wallet = sdk.ConcordiumHdWallet.fromHex(this._seedHex, this._ccd.derivationNetwork);
    const account = new WalletAccountConcordium({
      wallet,
      getClient: () => this._getClient(),
      getGlobal: () => this._getGlobal(),
      network: this._ccd.derivationNetwork,
      providerIndex,
      identityIndex,
      credNumber,
      address,
    });
    // Track it so the inherited dispose() cleans it up.
    this._accounts[account.path] = account;
    return account;
  }
}
