/**
 * The exported identity: what exportIdentity hands the wallet to keep, and importIdentity takes back.
 * The wallet stores it however it stores its seed phrase; the package never stores anything itself.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ NOT ENCRYPTED. The exported identity is plain JSON text holding the person's verified details (name, date of  │
 * │ birth, nationality, ID document number, …), readable by anyone who has it. Keep it like any other secret: in  │
 * │ the same secure storage as the seed phrase (a phone's Keychain / Keystore, an encrypted database, a key       │
 * │ vault). Never log it, put it in analytics or crash reports, or keep it in plain files or unencrypted backups. │
 * └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The format, JSON text:
 *
 *   { "format": "concordium-wdk-identity", "v": 1, "network": "testnet", "providerIndex": 0, "identityIndex": 2,
 *     "identityObject": { … the identity as the provider issued it … } }
 *
 * It holds no keys: every key comes from the seed phrase. importIdentity checks the identity belongs to the wallet's
 * seed phrase before holding it.
 */
import { IdentityStorageError } from '../shared/errors.js';

const FORMAT = 'concordium-wdk-identity';
export const EXPORT_FORMAT_VERSION = 1;

const unreadable = (message) => new IdentityStorageError(message, { reason: 'unreadable' });

/** 'Testnet' / 'Mainnet' (the SDK's derivation network) as written in the export. */
export const networkLabel = (derivationNetwork) => String(derivationNetwork).toLowerCase();

/**
 * The exported identity, as JSON text. NOT ENCRYPTED: it holds the person's details (see the note at the top).
 * @param {string} derivationNetwork  'Testnet' or 'Mainnet'
 * @param {{ providerIndex: number, identityIndex: number, identityObject: object }} record
 * @returns {string}
 */
export function exportText(derivationNetwork, { providerIndex, identityIndex, identityObject }) {
  return JSON.stringify({
    format: FORMAT, v: EXPORT_FORMAT_VERSION, network: networkLabel(derivationNetwork), providerIndex, identityIndex, identityObject,
  });
}

/**
 * Read an exported identity, checking it is one (not yet that it is this wallet's: importIdentity does that).
 * @param {string} exported  the text exportIdentity gave
 * @returns {{ network: string, providerIndex: number, identityIndex: number, identityObject: object }}
 * @throws {IdentityStorageError} reason 'unreadable'
 */
export function readExport(exported) {
  if (typeof exported !== 'string' || !exported.trim()) throw unreadable('importIdentity needs the text exportIdentity gave.');
  let record;
  try {
    record = JSON.parse(exported);
  } catch {
    throw unreadable('This is not an exported identity (not valid JSON).');
  }
  if (record?.format !== FORMAT || !record.identityObject
    || !Number.isSafeInteger(record.providerIndex) || !Number.isSafeInteger(record.identityIndex)) {
    throw unreadable('This is not an exported identity.');
  }
  if (record.v !== EXPORT_FORMAT_VERSION) {
    throw unreadable(`This exported identity uses format version ${record.v}, which this version of the package cannot read.`);
  }
  return record;
}
