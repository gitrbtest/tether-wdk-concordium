/**
 * A server with many users keeps each user's identity in that user's own record.
 *
 * A wallet run on a server (an exchange, a custodial wallet) holds a seed phrase per user, and keeps each user's
 * identity as the text exportIdentity gives, in that user's record. The package does not let one user's identity be
 * used with another user's seed phrase, and deleting a user's record erases their identity from the server.
 *
 * NOT ENCRYPTED: the text holds the person's verified details (name, date of birth, ID number …) in plain JSON, so
 * the server keeps it like any other secret, as it keeps the seed phrases: in an encrypted, access-controlled
 * database or a key vault, never in logs, plain backups or analytics.
 *
 *   npm run example:server-keeps-identities
 *
 *   SERVER                                                        IDENTITY PROVIDER
 *   ──────                                                        ─────────────────
 *   1. Alice's identity arrives (here: got back from the provider) ◄── her issued identity
 *   2. keeps it as text in Alice's record (readable: the table must be protected like the seed phrases)
 *   3. a later request for Alice: a new identity object from her seed phrase takes her text back
 *   4. a mix-up: Alice's text in Bob's record: refused, it is not Bob's seed phrase's identity
 *   5. Alice closes her account: her record and her seed phrase are deleted; nothing of her identity is left
 *
 * Read-only on testnet: step 1 asks the testnet provider for an identity it issued earlier to the public
 * demonstration phrase ("Alice"). In a real server, step 1 is the end of verification (retrieveIdentity, chapter 3
 * of the integration guide).
 */
import {
  ConcordiumIdentity,
  IdentityStorageError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

// Each user's seed phrase. A real server keeps them in a key vault (a hardware security module, a cloud key
// service), apart from the database, so a copy of the database alone is of no use. These two are PUBLIC
// demonstration phrases: never use them for anything of value.
const keyVault = new Map([
  ['alice', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
  ['bob', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
]);

// The server's users table, one record per user. Here a list in memory; a real server uses its database, with the
// identity text in a column of the user's own row (a text column: one identity is about 14,000 characters). That
// column holds personal details in plain text: protect it as the seed phrases are protected (encrypted at rest,
// access-controlled, kept out of logs and plain backups).
const users = new Map([
  ['alice', { name: 'Alice', concordiumIdentity: null }],
  ['bob', { name: 'Bob', concordiumIdentity: null }],
]);

// The configuration all users share: the provider list and one node connection. Only the seed phrase differs.
const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const config = { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node };

/**
 * Do some work for one user with an identity object made from their seed phrase, then wipe it.
 * @template T
 * @param {string} userId
 * @param {(identity: ConcordiumIdentity) => Promise<T>} work  what to do with the user's identity object
 * @returns {Promise<T>}
 */
async function asUser(userId, work) {
  const identity = new ConcordiumIdentity(keyVault.get(userId), config);
  try {
    return await work(identity);
  } finally {
    identity.dispose(); // the seed phrase and the identity leave memory as soon as the request is done
  }
}

try {
  // 1. Alice's identity arrives. Here the provider gives back one it issued earlier (provider 0, identity 334563111).
  console.log('1. Alice\'s identity arrives');
  const which = { providerIndex: 0, identityIndex: 334563111 };
  const exported = await asUser('alice', async (identity) => {
    const summary = await identity.recoverIdentity(which);
    if (!summary) throw new Error('The provider did not return the identity.');
    console.log(`   provider ${summary.providerIndex}, identity ${summary.identityIndex}, valid until ${summary.validTo}`);
    // 2. Export it as text for the server to keep (NOT encrypted: it holds her details).
    return identity.exportIdentity(which);
  });

  // 2. Keep it in Alice's own record.
  users.get('alice').concordiumIdentity = exported;
  console.log('\n2. The server keeps it in Alice\'s record');
  for (const [id, user] of users) {
    const text = user.concordiumIdentity;
    console.log(`   ${id.padEnd(6)} ${text ? `${text.length} characters: ${text.slice(0, 40)}…` : '(no identity)'}`);
  }
  // Her details (on testnet, the test form's "John Doe", born 1970) are readable in it: the package does not encrypt
  // it. The server's own protection of the table (and of the seed phrases) is what keeps them private.
  const shown = /John|Doe|19700101/.test(exported);
  console.log(`   Alice's name or birth date in it? ${shown ? 'yes: it is NOT encrypted, so the table must be protected like the seed phrases' : 'no'}`);

  // 3. A later request for Alice (say, a website asks her to prove her age): read her text back.
  console.log('\n3. A later request for Alice: with her own seed phrase, her text is taken back');
  const summary = await asUser('alice', (identity) => identity.importIdentity(users.get('alice').concordiumIdentity));
  console.log(`   ✔ provider ${summary.providerIndex}, identity ${summary.identityIndex}: ready to use`);

  // 4. A mix-up (a bug, or someone copying records): Alice's text ends up in Bob's record.
  console.log('\n4. A mix-up: Alice\'s text is put in Bob\'s record');
  users.get('bob').concordiumIdentity = users.get('alice').concordiumIdentity;
  try {
    await asUser('bob', (identity) => identity.importIdentity(users.get('bob').concordiumIdentity));
    console.log('   ✖ Bob\'s wallet took it (this should not happen)');
  } catch (e) {
    if (!(e instanceof IdentityStorageError)) throw e;
    console.log(`   ✔ refused (${e.reason}): it is not Bob's seed phrase's identity, so it cannot be used as his`);
  }
  users.get('bob').concordiumIdentity = null; // put it right

  // 5. Alice closes her account: delete her record and her seed phrase. Without either, nothing on the server holds
  //    her identity, or can recover it. (The provider still holds what it issued; Concordium's rules for providers
  //    apply to that.)
  console.log('\n5. Alice closes her account: her record and her seed phrase are deleted');
  users.delete('alice');
  keyVault.delete('alice');
  console.log(`   users: ${[...users.keys()].join(', ')}; Alice's identity is gone from the server`);
} catch (e) {
  console.error('Failed:', e.message);
  process.exitCode = 1;
}
