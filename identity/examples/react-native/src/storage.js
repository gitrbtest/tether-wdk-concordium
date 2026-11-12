/**
 * Where this wallet keeps its secrets: Android's Keystore, through expo-secure-store (each value encrypted with a key
 * that never leaves the phone's secure hardware). Three things are kept, all secrets:
 *
 *   the seed phrase          every key comes from it
 *   the exported identity    NOT encrypted by the identity package: it holds the person's details (name, date of
 *                            birth, ID number…), so it is kept like the seed phrase
 *   a pending provider reply its code_uri serves the identity, details included, to whoever has it: kept privately
 *                            while waiting, deleted once the identity is collected
 *
 * Nothing here ever goes to logs, analytics or plain files.
 */
import * as SecureStore from 'expo-secure-store';

const KEYS = { seedPhrase: 'seed-phrase', identity: 'concordium-identity', pending: 'concordium-pending-identity' };

export const loadSeedPhrase = () => SecureStore.getItemAsync(KEYS.seedPhrase);
export const keepSeedPhrase = (words) => SecureStore.setItemAsync(KEYS.seedPhrase, words);

export const loadIdentity = () => SecureStore.getItemAsync(KEYS.identity);
export const keepIdentity = (exported) => SecureStore.setItemAsync(KEYS.identity, exported);

/** The provider's reply, saved before waiting, so verification survives the app being closed. */
export async function loadPending() {
  const text = await SecureStore.getItemAsync(KEYS.pending);
  return text ? JSON.parse(text) : null;
}
export const keepPending = (pending) => SecureStore.setItemAsync(KEYS.pending, JSON.stringify(pending));
export const forgetPending = () => SecureStore.deleteItemAsync(KEYS.pending);

/** Start again: delete everything this wallet keeps (testnet demo only). */
export async function forgetEverything() {
  await Promise.all(Object.values(KEYS).map((key) => SecureStore.deleteItemAsync(key)));
}
