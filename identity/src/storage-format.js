/**
 * The encrypted storage format for identities.
 *
 * An identity is saved as encrypted bytes under a "slot name" such as
 * `concordium-identity/testnet/0/594450697` (network / provider index / identity
 * index). Whatever stores the bytes never sees the identity itself.
 *
 * - The encryption key is derived from the wallet seed each time it is needed
 *   (HKDF-SHA256, with a fixed label and the network) and never stored. Signing
 *   and identity keys come from the seed through a different derivation (SLIP-10
 *   paths), so this key is separate from them.
 * - AES-256-GCM, with a fresh random nonce on every save: any change to the bytes
 *   is detected when decrypting.
 * - The bytes are bound to their slot: the slot name is part of the authenticated
 *   data, so bytes copied to another slot (another identity, another network)
 *   cannot be decrypted there.
 *
 * Format version 1, byte by byte:
 *
 *   offset  size  content
 *   0       4     magic "CWID" (Concordium WDK identity)
 *   4       1     format version (1)
 *   5       12    nonce
 *   17      …     ciphertext + 16-byte authentication tag
 *
 * Authenticated but not stored: the first 5 bytes and the slot name.
 * Plaintext: UTF-8 JSON { v: 1, providerIndex, identityIndex, identityObject }.
 *
 * A future format adds a new version number and keeps the version-1 reader, so
 * identities saved by earlier versions stay readable.
 */
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { IdentityStorageError } from './errors.js';

export const STORAGE_FORMAT_VERSION = 1;

const MAGIC = new TextEncoder().encode('CWID');
const HEADER_LENGTH = MAGIC.length + 1; // magic + version
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LABEL = 'concordium-wdk-identity-storage v1';
const SLOT_PREFIX = 'concordium-identity';

const utf8 = (text) => new TextEncoder().encode(text);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 'Testnet' / 'Mainnet' (the SDK's derivation network) as used in slot names and the key. */
const networkLabel = (derivationNetwork) => String(derivationNetwork).toLowerCase();

/** The name a saved identity is filed under, e.g. 'concordium-identity/testnet/0/594450697'. */
export function storageSlotName(derivationNetwork, providerIndex, identityIndex) {
  return `${SLOT_PREFIX}/${networkLabel(derivationNetwork)}/${providerIndex}/${identityIndex}`;
}

/**
 * The 32-byte encryption key for saved identities: the same seed and network always give the same key.
 * @param {Uint8Array} seed  the wallet's 64-byte seed
 * @param {string} derivationNetwork  'Testnet' or 'Mainnet'
 */
export function deriveStorageKey(seed, derivationNetwork) {
  return hkdf(sha256, seed, utf8(KEY_LABEL), utf8(networkLabel(derivationNetwork)), 32);
}

const authenticatedData = (header, slotName) => concat(header, utf8(slotName));

/**
 * Encrypt an identity record for a slot.
 * @param {Uint8Array} key  from deriveStorageKey
 * @param {string} slotName  from storageSlotName
 * @param {{ providerIndex: number, identityIndex: number, identityObject: object }} record
 * @returns {Uint8Array}  the bytes to save
 */
export function encryptIdentity(key, slotName, { providerIndex, identityIndex, identityObject }) {
  const header = concat(MAGIC, [STORAGE_FORMAT_VERSION]);
  const nonce = randomBytes(NONCE_LENGTH);
  const plaintext = utf8(JSON.stringify({ v: STORAGE_FORMAT_VERSION, providerIndex, identityIndex, identityObject }));
  try {
    const sealed = gcm(key, nonce, authenticatedData(header, slotName)).encrypt(plaintext);
    return concat(header, nonce, sealed);
  } finally {
    plaintext.fill(0);
  }
}

function unreadable(message, slotName) {
  return new IdentityStorageError(message, { reason: 'unreadable-slot', slotName });
}

/**
 * Decrypt saved bytes for a slot.
 * @returns {{ providerIndex: number, identityIndex: number, identityObject: object }}
 * @throws {IdentityStorageError} reason 'unreadable-slot' if the bytes are not identity data, use an
 *   unknown format version, or cannot be decrypted with this key for this slot.
 */
export function decryptIdentity(key, slotName, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH
    || !MAGIC.every((byte, i) => bytes[i] === byte)) {
    throw unreadable(`The data saved in ${slotName} is not a saved identity.`, slotName);
  }
  const version = bytes[MAGIC.length];
  if (version !== 1) {
    throw unreadable(`The identity saved in ${slotName} uses storage format version ${version}, `
      + `which this version of the package cannot read.`, slotName);
  }

  const header = bytes.subarray(0, HEADER_LENGTH);
  const nonce = bytes.subarray(HEADER_LENGTH, HEADER_LENGTH + NONCE_LENGTH);
  let plaintext;
  try {
    plaintext = gcm(key, nonce, authenticatedData(header, slotName)).decrypt(bytes.subarray(HEADER_LENGTH + NONCE_LENGTH));
  } catch {
    throw unreadable(`The identity saved in ${slotName} cannot be decrypted with this wallet's seed `
      + `(another seed, another slot, or damaged data).`, slotName);
  }
  try {
    const { v, providerIndex, identityIndex, identityObject } = JSON.parse(new TextDecoder().decode(plaintext));
    if (v !== 1 || !identityObject) throw new Error();
    return { providerIndex, identityIndex, identityObject };
  } catch {
    throw unreadable(`The identity saved in ${slotName} is incomplete.`, slotName);
  } finally {
    plaintext.fill(0);
  }
}
