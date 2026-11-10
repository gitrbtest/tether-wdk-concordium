/**
 * Checking what callers pass in: indices, the return address, timeouts, URLs and the seed.
 * Each check either returns the value in the form the package uses, or throws a clear Error
 * (never repeating a secret, such as the seed, in the message).
 */
import * as sdk from '@concordium/web-sdk';
import { hexToBytes } from '@noble/hashes/utils';

const SEED_BYTES = 64;

/**
 * The ranges Concordium's key derivation supports, as in the wallet package. Outside them, Concordium's SDK does not
 * refuse every number: it silently reduces some (identity 4294967297 gives identity 1's keys), so they are checked here.
 */
/** Provider and identity numbers: hardened steps of the key path. */
export const MAX_KEY_INDEX = 2 ** 31 - 1;
/** Account numbers under an identity (the credential counter): one byte. */
export const MAX_CRED_NUMBER = 255;

/**
 * A provider, identity or account number. Same rule and wording as the wallet package's identity coordinates.
 * There is never a default: a missing number is an error, so the package never quietly picks the wrong identity or
 * account. `hint`, if given, is added when the number is missing, to say how to find it. `max`: the largest allowed
 * (MAX_KEY_INDEX for provider and identity numbers, MAX_CRED_NUMBER for account numbers).
 */
export function requireIndex(value, name, hint, max = MAX_KEY_INDEX) {
  if (value === undefined && hint) throw new Error(`${name} is required: ${hint}`);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is required and must be a non-negative safe integer.`);
  }
  if (value > max) {
    throw new Error(max === MAX_CRED_NUMBER
      ? `${name} must be at most ${MAX_CRED_NUMBER} (Concordium's account numbers under an identity).`
      : `${name} must be at most ${max} (the largest Concordium's key derivation supports).`);
  }
}

/** How to find an identity number, for the error when it is missing. */
export const IDENTITY_INDEX_HINT = 'say which of the wallet\'s identities with this provider (nextIdentityIndex gives the '
  + 'number for a new one; recoverAll finds the existing ones).';

/** How to find an account number, for the error when it is missing. */
export const CRED_NUMBER_HINT = 'say which account under the identity (nextCredNumber gives the number for a new one; '
  + 'findAccounts lists the existing ones).';

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
    return hexToBytes(hdWallet.seedAsHex);
  }
  if (seed instanceof Uint8Array && seed.length === SEED_BYTES) {
    return Uint8Array.from(seed);
  }
  throw new Error('The seed must be a BIP-39 seed phrase or a 64-byte seed.');
}
