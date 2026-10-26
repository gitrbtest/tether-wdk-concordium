/**
 * FileIdentityStore: an identity store that keeps the encrypted bytes in files, for Node.js wallets on
 * a desktop or server. One file per slot, in sub-folders that mirror the slot name:
 *
 *   <folder>/concordium-identity/testnet/0/594450697.bin
 *
 * - The folder (and sub-folders) is created when needed.
 * - Writes are safe: the bytes go to a temporary file first, which then replaces the old file in one
 *   step, so a crash or power cut never leaves a half-written identity.
 * - Files and folders are created readable by the owner only, where the operating system supports it
 *   (macOS, Linux; Windows uses its own access rules).
 * - A slot name can never point outside the folder: only letters, digits and . _ @ - in each part,
 *   parts separated by '/', and no '.' or '..' parts.
 *
 * It only ever receives encrypted bytes and slot names (see the identity store contract).
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

const SAFE_SLOT_NAME = /^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/;

export default class FileIdentityStore {
  #folder;

  /** @param {string} folder  where to keep the files; created when needed */
  constructor(folder) {
    if (typeof folder !== 'string' || folder === '') throw new TypeError('folder must be a path to a folder.');
    this.#folder = resolve(folder);
  }

  /** The file for a slot, checked to stay inside the folder. */
  #fileFor(slotName) {
    if (typeof slotName !== 'string' || !SAFE_SLOT_NAME.test(slotName)
      || slotName.split('/').some((part) => part === '.' || part === '..')) {
      throw new TypeError(`"${slotName}" is not a slot name this store can keep as a file `
        + '(letters, digits and . _ @ - only, parts separated by /, no . or .. parts).');
    }
    const file = join(this.#folder, ...slotName.split('/')) + '.bin';
    if (!file.startsWith(this.#folder + sep)) throw new TypeError(`"${slotName}" would be outside the store's folder.`);
    return file;
  }

  /** Save the bytes under the slot name, replacing anything saved there before. */
  async save(slotName, bytes) {
    const file = this.#fileFor(slotName);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array.');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file); // replaces the old file in one step
    } catch (e) {
      await rm(temporary, { force: true });
      throw e;
    }
  }

  /** The bytes saved under the slot name, or null if there are none. */
  async read(slotName) {
    const file = this.#fileFor(slotName);
    try {
      return new Uint8Array(await readFile(file)); // a plain Uint8Array copy, not a Node Buffer
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Remove what is saved under the slot name. Nothing saved there is not an error. */
  async delete(slotName) {
    await rm(this.#fileFor(slotName), { force: true });
  }
}
