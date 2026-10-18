import * as sdk from '@concordium/web-sdk';
import { parseIdentityConfig } from './config.js';
import IdentityProviders from './IdentityProviders.js';

const SEED_BYTES = 64;

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
}
