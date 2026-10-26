/**
 * Checking what callers pass in: indices, the return address, timeouts, URLs and the seed.
 * Each check either returns the value in the form the package uses, or throws a clear Error
 * (never repeating a secret, such as the seed, in the message).
 */
import * as sdk from '@concordium/web-sdk';

const SEED_BYTES = 64;

/** A provider or identity index. Same rule and wording as the wallet package's identity coordinates. */
export function requireIndex(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is required and must be a non-negative safe integer.`);
  }
}

/** A timeout or interval in milliseconds. */
export function requirePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
}

/**
 * The address the provider sends the browser back to. Any absolute URL is
 * accepted (a web address or an app's own scheme); there is no default. It is
 * passed on exactly as given: providers may compare it character for character
 * with the address the wallet registered.
 */
export function requireRedirectUri(value) {
  try {
    if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error();
    new URL(value); // throws unless absolute
  } catch {
    throw new Error('redirectUri is required and must be an absolute URL.');
  }
}

/** An absolute http(s) URL, or null. */
export function httpUrlOrNull(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The 64-byte seed as our own copy. A seed phrase is checked and converted by
 * the SDK (BIP-39, as in the WDK base). Raw bytes are checked here, before the
 * SDK sees them: its length error repeats the seed, which must never reach a log.
 */
export function toSeedBytes(seed) {
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
