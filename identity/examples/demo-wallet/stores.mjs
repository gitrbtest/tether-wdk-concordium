/**
 * The identity stores the Storage panel (step 3b) offers: memory, files and a SQLite database. Each is just an
 * object with save / read / delete, which is all the identity package asks of a store.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** An identity store on a SQLite table (the same few lines as examples/database-store.mjs). */
export class SqliteIdentityStore {
  #db;

  constructor(db) {
    this.#db = db;
    db.exec('CREATE TABLE IF NOT EXISTS identities (slot TEXT PRIMARY KEY, data BLOB NOT NULL)');
  }

  async save(slotName, bytes) {
    this.#db.prepare('INSERT INTO identities (slot, data) VALUES (?, ?) '
      + 'ON CONFLICT (slot) DO UPDATE SET data = excluded.data').run(slotName, bytes);
  }

  async read(slotName) {
    const row = this.#db.prepare('SELECT data FROM identities WHERE slot = ?').get(slotName);
    return row ? new Uint8Array(row.data) : null;
  }

  async delete(slotName) {
    this.#db.prepare('DELETE FROM identities WHERE slot = ?').run(slotName);
  }
}

/**
 * Open the demo's SQLite database (a file in the store folder), or say why it cannot be used: SQLite is built into
 * Node.js 22.13 and later.
 * @returns {Promise<{ store: SqliteIdentityStore, file: string, close: () => void } | { unavailable: string }>}
 */
export async function openDatabaseStore(folder) {
  let DatabaseSync;
  try {
    // node:sqlite prints an "experimental" warning when first loaded; keep the server's output readable by
    // passing every other warning on as before.
    const listeners = process.listeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', (w) => {
      if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
      for (const listener of listeners) listener(w);
    });
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { unavailable: `needs Node.js 22.13 or newer (built-in SQLite); this is ${process.version}` };
  }
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'identities.sqlite');
  const db = new DatabaseSync(file);
  return { store: new SqliteIdentityStore(db), file, close: () => db.close() };
}

/**
 * The store the demo's wallet uses: whichever one is chosen in the Storage panel (files to begin with). Only the
 * demo needs this switch; a real wallet passes its one store to ConcordiumIdentity.
 */
export class ChosenStore {
  constructor(store) {
    this.current = store;
  }

  save(slotName, bytes) { return this.current.save(slotName, bytes); }

  read(slotName) { return this.current.read(slotName); }

  delete(slotName) { return this.current.delete(slotName); }
}
