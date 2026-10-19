import * as sdk from '@concordium/web-sdk';
import { parseIdentityConfig } from './config.js';
import { IdentityProviderError } from './errors.js';
import IdentityProviders from './IdentityProviders.js';

const SEED_BYTES = 64;
const GLOBAL_PATH = '/v0/global';

/** Same rule and wording as the wallet package's identity coordinates. */
function requireIndex(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is required and must be a non-negative safe integer.`);
  }
}

/**
 * The address the provider sends the browser back to. Any absolute URL is
 * accepted (a web address or an app's own scheme); there is no default. It is
 * passed on exactly as given: providers may compare it character for character
 * with the address the wallet registered.
 */
function requireRedirectUri(value) {
  try {
    if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error();
    new URL(value); // throws unless absolute
    return value;
  } catch {
    throw new Error('redirectUri is required and must be an absolute URL.');
  }
}

/**
 * The 64-byte seed as our own copy. A seed phrase is checked and converted by
 * the SDK (BIP-39, as in the WDK base). Raw bytes are checked here, before the
 * SDK sees them: its length error repeats the seed, which must never reach a log.
 */
function toSeedBytes(seed) {
  if (typeof seed === 'string') {
    let hdWallet;
    try {
      hdWallet = sdk.ConcordiumHdWallet.fromSeedPhrase(seed, 'Testnet'); // the network does not affect the seed
    } catch {
      throw new Error('Invalid seed phrase.');
    }
    return Uint8Array.from(Buffer.from(hdWallet.seedAsHex, 'hex'));
  }
  if (seed instanceof Uint8Array && seed.length === SEED_BYTES) {
    return Uint8Array.from(seed);
  }
  throw new Error('The seed must be a BIP-39 seed phrase or a 64-byte seed.');
}

/**
 * A wallet's Concordium identity, derived from the wallet's own seed: requesting
 * an identity from a provider, without the Concordium ID App.
 */
export default class ConcordiumIdentity {
  /**
   * @param {string | Uint8Array} seed  the wallet's BIP-39 seed phrase, or its 64-byte seed
   * @param {{ useMainnetKeyDerivation: boolean, walletProxyUrl: string }} config
   *   e.g. CONCORDIUM_TESTNET_IDENTITY_CONFIG; use the same key derivation as the wallet package
   * @param {{ fetch?: typeof fetch }} [options]  HTTP implementation (defaults to the global fetch)
   */
  constructor(seed, config, { fetch: fetchFn = (url, options) => fetch(url, options) } = {}) {
    this._config = parseIdentityConfig(config); // validated before the seed is touched
    this._fetch = fetchFn;
    this._providers = new IdentityProviders(this._config, { fetch: (url, options) => this._fetch(url, options) });
    this._seed = toSeedBytes(seed);
  }

  /** Key derivation for this identity's seed and network (the same tree as the wallet package). */
  get _hdWallet() {
    return sdk.ConcordiumHdWallet.fromHex(Buffer.from(this._seed).toString('hex'), this._config.derivationNetwork);
  }

  /** The network's cryptographic parameters, as published by the wallet-proxy. */
  async _globalContext() {
    const response = await this._fetch(this._config.walletProxyUrl + GLOBAL_PATH);
    if (!response.ok) {
      throw new Error(`The wallet-proxy answered HTTP ${response.status} for the cryptographic parameters.`);
    }
    const { value } = await response.json();
    if (!value?.onChainCommitmentKey || !value?.bulletproofGenerators || !value?.genesisString) {
      throw new Error('The wallet-proxy returned cryptographic parameters in an unexpected format.');
    }
    return value;
  }

  /**
   * Start identity verification: build the identity request for a provider from
   * this wallet's seed, and the link that opens the provider's verification page.
   * Open `issuanceUrl` in a browser or web view; when verification finishes, the
   * provider sends the browser to `redirectUri`.
   *
   * @param {object} options
   * @param {number} options.providerIndex  the provider's index on this network (see IdentityProviders)
   * @param {number} [options.identityIndex=0]  which of the wallet's identities with this provider
   * @param {string} options.redirectUri  where the provider sends the browser afterwards
   * @returns {Promise<{ issuanceUrl: string, providerIndex: number, identityIndex: number }>}
   * @throws {IdentityProviderError} If the provider is not published, or publishes no issuance address.
   */
  async createIdentityRequest({ providerIndex, identityIndex = 0, redirectUri } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex');
    const returnUrl = requireRedirectUri(redirectUri);

    const provider = await this._providers.get(providerIndex);
    if (!provider.issuanceStart) {
      throw new IdentityProviderError(
        `Identity provider ${providerIndex} publishes no issuance address on this network.`, providerIndex);
    }

    const globalContext = await this._globalContext();
    // Keys are derived with the provider's own index, so the request and the keys always agree.
    const ipIndex = provider.ipInfo.ipIdentity;
    const hdWallet = this._hdWallet;
    const idObjectRequest = sdk.createIdentityRequestWithKeys({
      ipInfo: provider.ipInfo,
      arsInfos: provider.arsInfos,
      // Any arThreshold of the provider's anonymity revokers together can reveal the identity; fewer cannot.
      arThreshold: Math.max(1, Object.keys(provider.arsInfos).length - 1),
      globalContext,
      idCredSec: hdWallet.getIdCredSec(ipIndex, identityIndex).toString('hex'),
      prfKey: hdWallet.getPrfKey(ipIndex, identityIndex).toString('hex'),
      blindingRandomness: hdWallet.getSignatureBlindingRandomness(ipIndex, identityIndex).toString('hex'),
    });

    const query = new URLSearchParams({
      state: JSON.stringify({ idObjectRequest }),
      response_type: 'code',
      scope: 'identity',
      redirect_uri: returnUrl,
    });
    return { issuanceUrl: `${provider.issuanceStart}?${query}`, providerIndex, identityIndex };
  }
}
