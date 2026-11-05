/**
 * How these samples keep identities: one text file per identity in a folder. NOT part of the package.
 *
 * The package stores nothing: exportIdentity gives the identity as text (encrypted by default), and the wallet keeps
 * it however it keeps its seed (a phone's secure storage, a database, a file …). These samples are command-line
 * programs, so they keep it in a file, e.g. ./demo-identities/testnet-0-2.txt (network, provider, identity number).
 * importIdentity takes the text back.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fileName = (providerIndex, identityIndex) => `testnet-${providerIndex}-${identityIndex}.txt`;

/** Keep an exported identity in the folder; returns the file's path. */
export function keepIdentity(folder, { providerIndex, identityIndex }, exported) {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, fileName(providerIndex, identityIndex));
  writeFileSync(file, exported, { mode: 0o600 }); // owner-only where the system supports it
  return file;
}

/** The exported identity kept for these numbers, or null if there is none. */
export function keptIdentity(folder, { providerIndex, identityIndex }) {
  try {
    return readFileSync(join(folder, fileName(providerIndex, identityIndex)), 'utf8');
  } catch {
    return null;
  }
}

/** The identity numbers kept in the folder for a provider (to give a helpful hint). */
export function keptIdentityNumbers(folder, providerIndex) {
  try {
    return readdirSync(folder)
      .map((name) => name.match(new RegExp(`^testnet-${providerIndex}-(\\d+)\\.txt$`))?.[1])
      .filter(Boolean);
  } catch {
    return []; // no folder yet
  }
}
