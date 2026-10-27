/**
 * A custom identity store on a real SQL database: SQLite, built into Node.js 22.13 and later
 * (nothing to install). It shows that the store contract is small enough for a database store
 * in a few lines, and that the database only ever holds slot names and encrypted bytes.
 *
 *   npm run example:database-store
 *
 * Runs offline: it uses the recorded testnet provider data and a real identity issued on testnet
 * (from the package's test data) instead of asking the provider.
 */
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { verifyIdentityStore } from '@concordium/wdk-identity-concordium/testing';

// ---- The store: any object with save / read / delete works ----------------------------------

/** An identity store on a SQLite table. In production this would be your own database. */
class SqliteIdentityStore {
  #db;

  constructor(db) {
    this.#db = db;
    db.exec('CREATE TABLE IF NOT EXISTS identities (slot TEXT PRIMARY KEY, data BLOB NOT NULL)');
  }

  async save(slotName, bytes) {
    // "save replaces whatever is saved under that name": an upsert.
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

// ---- Open a database ---------------------------------------------------------------------

let DatabaseSync;
try {
  // node:sqlite prints an "experimental" warning when loaded; keep the output readable.
  process.removeAllListeners('warning');
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(`This example needs Node.js 22.13 or later (built-in SQLite); this is ${process.version}.`);
  process.exit(1);
}
const file = join(tmpdir(), `identity-store-example-${Date.now()}.sqlite`);
const db = new DatabaseSync(file);
const store = new SqliteIdentityStore(db);

// ---- Recorded testnet data, so the example runs offline -----------------------------------

const fixture = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const recorded = {
  '/v1/ip_info': fixture('ip_info.testnet.v1.json'),
  '/v0/global': fixture('global.testnet.json'),
  [CODE_URI]: fixture('identity-done.testnet.json'),
};
const offlineFetch = async (url) => {
  const key = Object.keys(recorded).find((k) => String(url) === k || String(url).endsWith(k));
  return { ok: true, status: 200, json: async () => recorded[key] };
};
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SLOT = { providerIndex: 0, identityIndex: 334563111 }; // the identity the recorded one was issued for

try {
  console.log('1. Check the database store against the identity store contract');
  await verifyIdentityStore(store);
  console.log('   passed\n');

  console.log('2. Collect an identity (recorded testnet reply) and save it in the database');
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: offlineFetch, store });
  await wallet.waitForIdentity(CODE_URI, { ...SLOT, intervalMs: 1 });
  const saved = await wallet.saveIdentity(SLOT);
  wallet.dispose();
  console.log(`   saved in slot ${saved.slotName}\n`);

  console.log('3. What the database holds');
  for (const { slot, data } of db.prepare('SELECT slot, data FROM identities').all()) {
    const bytes = new Uint8Array(data);
    const asText = new TextDecoder('latin1').decode(bytes);
    const head = [...bytes.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`   ${slot}`);
    console.log(`     ${bytes.length} bytes: ${head} …  ("${asText.slice(0, 4)}" + format version ${bytes[4]}, then encrypted)`);
    const personal = ['John', 'Doe', '19700101', 'preIdentityObject', 'firstName'].filter((s) => asText.includes(s));
    console.log(`     personal data visible: ${personal.length ? personal.join(', ') : 'none'}`);
  }
  console.log();

  console.log('4. A new wallet object (as after a restart) loads it back from the database');
  const restarted = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: offlineFetch, store });
  console.log('  ', await restarted.loadIdentity(SLOT));
  restarted.dispose();
} finally {
  db.close();
  rmSync(file, { force: true });
}
