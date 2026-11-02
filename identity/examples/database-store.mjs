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

/**
 * An identity store on a SQLite table. In production this would be your own database.
 *
 * A store is any object with three methods, save / read / delete, each working on a "slot name" (a short text
 * saying which identity, e.g. 'concordium-identity/testnet/0/0') and bytes. The identity package calls them; it
 * only ever hands the store encrypted bytes, so the database never sees anything readable. One table with two
 * columns is enough: the slot name as the key, and the bytes.
 */
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

  // read: the bytes saved under that name, or null if there are none (null tells the package "nothing saved").
  async read(slotName) {
    const row = this.#db.prepare('SELECT data FROM identities WHERE slot = ?').get(slotName);
    return row ? new Uint8Array(row.data) : null;
  }

  // delete: remove the row; if there is none, this simply does nothing (no error).
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
// Instead of asking the real wallet-proxy and identity provider, this sample answers from data recorded from
// testnet earlier: the provider list, the network's parameters, and a real identity the test provider issued.
// `offlineFetch` stands in for the internet: the package asks it for a web address and gets the recorded answer.

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
  // 1. Before trusting a store you wrote yourself, check it follows the rules (the "store contract"): save then
  //    read gives the same bytes back, reading an empty slot gives null, deleting works, and so on.
  //    verifyIdentityStore runs those checks and throws if one fails.
  console.log('1. Check the database store against the identity store contract');
  await verifyIdentityStore(store);
  console.log('   passed\n');

  // 2. A wallet using the database store: collect the identity (from the recorded reply), then save it.
  //    saveIdentity encrypts it with a key made from the seed and calls the store's save with the slot name and
  //    the encrypted bytes, which become a row in the table.
  console.log('2. Collect an identity (recorded testnet reply) and save it in the database');
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: offlineFetch, store });
  await wallet.waitForIdentity(CODE_URI, { ...SLOT, intervalMs: 1 });
  const saved = await wallet.saveIdentity(SLOT);
  wallet.dispose();
  console.log(`   saved in slot ${saved.slotName}\n`);

  // 3. Look inside the database directly, as an attacker who stole it would: each row starts with the format
  //    marker "CWID" and a version number, and the rest is encrypted. The sample searches the bytes for the
  //    identity's details (the test name "John Doe", the birth date, field names) and finds none.
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

  // 4. As after an app restart: a new wallet object, the same seed, the same database. loadIdentity reads the
  //    row and decrypts it with a key made from the seed again; nothing else was needed.
  console.log('4. A new wallet object (as after a restart) loads it back from the database');
  const restarted = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: offlineFetch, store });
  console.log('  ', await restarted.loadIdentity(SLOT));
  restarted.dispose();
} finally {
  // Close the database and delete its temporary file: this sample leaves nothing behind.
  db.close();
  rmSync(file, { force: true });
}
