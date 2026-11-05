/**
 * The exported identity: what exportIdentity hands the wallet to keep, and importIdentity takes back.
 * The wallet stores it however it stores its seed; the package never stores anything itself.
 *
 * Two forms, both plain text so any storage can hold them:
 *
 * ENCRYPTED (the default): base64 text of these bytes, format version 2:
 *
 *   offset  size  content
 *   0       4     magic "CWID" (Concordium WDK identity)
 *   4       1     format version (2)
 *   5       1     label length L (bytes)
 *   6       L     label, UTF-8: e.g. "concordium-identity/testnet/0/2" (network / provider / identity number)
 *   6+L     12    nonce (random, new for every export)
 *   18+L    …     AES-256-GCM ciphertext + 16-byte authentication tag
 *
 *   Additional authenticated data: bytes 0 to 6+L (magic, version, label): readable, but any change is detected.
 *   Plaintext: UTF-8 JSON { v: 2, providerIndex, identityIndex, identityObject }.
 *   The key: HKDF-SHA256 of the 64-byte seed, salt "concordium-wdk-identity-storage v1", info the network
 *   ("testnet" / "mainnet"), 32 bytes: never stored, made from the seed when needed and wiped after.
 *
 * PLAIN (only when the wallet asks: encrypted: false): JSON text
 *   { "format": "concordium-wdk-identity", "v": 1, "network": "testnet", "providerIndex": 0, "identityIndex": 2,
 *     "identityObject": { … } }
 *   For wallets that already keep everything in an encrypted vault of their own. It holds the person's details in
 *   the clear, so it must be kept as carefully as the seed.
 *
 * Version 1 is what the package wrote while it stored identities itself (before its first release): the same bytes
 * without the label, bound instead to a "slot name" the reader had to know (e.g.
 * 'concordium-identity/testnet/0/334563111', the same text as the label). It is still read (the golden-file rule:
 * saved data stays readable), with the provider and identity number given, since the bytes do not say them.
 */
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { IdentityStorageError } from '../shared/errors.js';

export const EXPORT_FORMAT_VERSION = 2;
const PLAIN_FORMAT = 'concordium-wdk-identity';
const PLAIN_VERSION = 1;

const MAGIC = new TextEncoder().encode('CWID');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LABEL = 'concordium-wdk-identity-storage v1';
const LABEL_PREFIX = 'concordium-identity';

const utf8 = (text) => new TextEncoder().encode(text);
const unreadable = (message) => new IdentityStorageError(message, { reason: 'unreadable' });

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 'Testnet' / 'Mainnet' (the SDK's derivation network) as used in labels and the key. */
export const networkLabel = (derivationNetwork) => String(derivationNetwork).toLowerCase();

/** Which identity an export holds, e.g. 'concordium-identity/testnet/0/2'. Readable, and protected from change. */
export function identityLabel(derivationNetwork, providerIndex, identityIndex) {
  return `${LABEL_PREFIX}/${networkLabel(derivationNetwork)}/${providerIndex}/${identityIndex}`;
}

/**
 * The 32-byte encryption key for exported identities: the same seed and network always give the same key.
 * @param {Uint8Array} seed  the wallet's 64-byte seed
 * @param {string} derivationNetwork  'Testnet' or 'Mainnet'
 */
export function deriveStorageKey(seed, derivationNetwork) {
  return hkdf(sha256, seed, utf8(KEY_LABEL), utf8(networkLabel(derivationNetwork)), 32);
}

// ---- base64 (no Node.js Buffer: the main entry runs in browsers and React Native too) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

function fromBase64(text) {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | (Math.max(0, B64.indexOf(clean[i + 2])) << 6) | Math.max(0, B64.indexOf(clean[i + 3]));
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ---- encrypted form ----

/**
 * Encrypt an identity for export.
 * @param {Uint8Array} key  from deriveStorageKey
 * @param {string} label  from identityLabel
 * @param {{ providerIndex: number, identityIndex: number, identityObject: object }} record
 * @returns {string}  base64 text
 */
export function encryptExport(key, label, { providerIndex, identityIndex, identityObject }) {
  const labelBytes = utf8(label);
  if (labelBytes.length > 255) throw new Error('The identity label is too long.');
  const header = concat(MAGIC, [EXPORT_FORMAT_VERSION, labelBytes.length], labelBytes);
  const nonce = randomBytes(NONCE_LENGTH);
  const plaintext = utf8(JSON.stringify({ v: EXPORT_FORMAT_VERSION, providerIndex, identityIndex, identityObject }));
  try {
    return toBase64(concat(header, nonce, gcm(key, nonce, header).encrypt(plaintext)));
  } finally {
    plaintext.fill(0);
  }
}

/** The format version of encrypted bytes (1 or 2), checking they are an exported identity at all. */
function versionOf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < MAGIC.length + 2 || !MAGIC.every((b, i) => bytes[i] === b)) {
    throw unreadable('This is not an exported identity.');
  }
  return bytes[MAGIC.length];
}

/** Read the label of encrypted export bytes without decrypting (to check the network first); throws if not an export. */
export function readExportLabel(bytes) {
  const version = versionOf(bytes);
  if (version !== EXPORT_FORMAT_VERSION) {
    throw unreadable(`This exported identity uses format version ${version}, which this version of the package cannot read.`);
  }
  const length = bytes[MAGIC.length + 1];
  const start = MAGIC.length + 2;
  if (bytes.length < start + length + NONCE_LENGTH + TAG_LENGTH) throw unreadable('This exported identity is incomplete.');
  return { label: new TextDecoder().decode(bytes.subarray(start, start + length)), headerLength: start + length };
}

/**
 * Decrypt export bytes.
 * @returns {{ label: string, providerIndex: number, identityIndex: number, identityObject: object }}
 * @throws {IdentityStorageError} reason 'unreadable' (not an export, unknown version, wrong seed, damaged)
 */
export function decryptExport(key, bytes) {
  const { label, headerLength } = readExportLabel(bytes);
  const header = bytes.subarray(0, headerLength);
  const nonce = bytes.subarray(headerLength, headerLength + NONCE_LENGTH);
  let plaintext;
  try {
    plaintext = gcm(key, nonce, header).decrypt(bytes.subarray(headerLength + NONCE_LENGTH));
  } catch {
    throw unreadable('This exported identity cannot be decrypted with this wallet\'s seed (another seed, or damaged data).');
  }
  try {
    const { v, providerIndex, identityIndex, identityObject } = JSON.parse(new TextDecoder().decode(plaintext));
    if (v !== EXPORT_FORMAT_VERSION || !identityObject) throw new Error();
    return { label, providerIndex, identityIndex, identityObject };
  } catch {
    throw unreadable('This exported identity is incomplete.');
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Decrypt version-1 bytes (saved by the earlier, store-based package) for the slot they were saved under.
 * @returns {{ providerIndex: number, identityIndex: number, identityObject: object }}
 * @throws {IdentityStorageError} reason 'unreadable'
 */
export function decryptVersion1(key, slotName, bytes) {
  const header = bytes.subarray(0, MAGIC.length + 1);
  const nonce = bytes.subarray(MAGIC.length + 1, MAGIC.length + 1 + NONCE_LENGTH);
  if (bytes.length < MAGIC.length + 1 + NONCE_LENGTH + TAG_LENGTH) throw unreadable('This saved identity is incomplete.');
  let plaintext;
  try {
    plaintext = gcm(key, nonce, concat(header, utf8(slotName))).decrypt(bytes.subarray(MAGIC.length + 1 + NONCE_LENGTH));
  } catch {
    throw unreadable(`This saved identity cannot be decrypted with this wallet's seed for ${slotName} `
      + '(another seed, another provider or identity number, or damaged data).');
  }
  try {
    const { v, providerIndex, identityIndex, identityObject } = JSON.parse(new TextDecoder().decode(plaintext));
    if (v !== 1 || !identityObject) throw new Error();
    return { providerIndex, identityIndex, identityObject };
  } catch {
    throw unreadable('This saved identity is incomplete.');
  } finally {
    plaintext.fill(0);
  }
}

// ---- plain form ----

/** The plain (unencrypted) export: JSON text. */
export function plainExport(derivationNetwork, { providerIndex, identityIndex, identityObject }) {
  return JSON.stringify({
    format: PLAIN_FORMAT, v: PLAIN_VERSION, network: networkLabel(derivationNetwork), providerIndex, identityIndex, identityObject,
  });
}

/**
 * Tell the two forms apart, and read what can be read without the seed.
 * @param {string | Uint8Array} exported  the text exportIdentity gave (or the raw bytes of an encrypted export)
 * @returns {{ kind: 'encrypted', bytes: Uint8Array, label: string } | { kind: 'version-1', bytes: Uint8Array }
 *   | { kind: 'plain', network: string, providerIndex: number, identityIndex: number, identityObject: object }}
 * @throws {IdentityStorageError} reason 'unreadable'
 */
export function readExport(exported) {
  const encryptedKind = (bytes) => (versionOf(bytes) === 1
    ? { kind: 'version-1', bytes }
    : { kind: 'encrypted', bytes, label: readExportLabel(bytes).label });
  if (exported instanceof Uint8Array) return encryptedKind(exported);
  if (typeof exported !== 'string' || !exported.trim()) throw unreadable('importIdentity needs the text exportIdentity gave.');
  const text = exported.trim();
  if (text.startsWith('{')) {
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      throw unreadable('This exported identity is not valid JSON.');
    }
    if (record?.format !== PLAIN_FORMAT || record.v !== PLAIN_VERSION || !record.identityObject
      || !Number.isSafeInteger(record.providerIndex) || !Number.isSafeInteger(record.identityIndex)) {
      throw unreadable('This is not an exported identity.');
    }
    return { kind: 'plain', ...record };
  }
  const bytes = fromBase64(text);
  if (!bytes) throw unreadable('This is not an exported identity.');
  return encryptedKind(bytes);
}
