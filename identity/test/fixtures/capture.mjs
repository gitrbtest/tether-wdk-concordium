/**
 * Re-capture the network data used as offline test fixtures.
 *
 * Downloads /v1/ip_info (the identity providers, with their published issuance
 * and recovery addresses) from the testnet and mainnet wallet-proxies and saves
 * each one here, pretty-printed so a change shows up as a readable git diff.
 * The data is public: provider names, public keys, URLs, support addresses.
 *
 * Run from identity/:  npm run fixtures
 * Review the diff after re-capturing: a changed provider list or address is
 * exactly what these fixtures exist to surface.
 */
import { writeFile } from 'node:fs/promises';
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '../../src/config.js';

const NETWORKS = {
  testnet: CONCORDIUM_TESTNET_IDENTITY_CONFIG.walletProxyUrl,
  mainnet: CONCORDIUM_MAINNET_IDENTITY_CONFIG.walletProxyUrl,
};

const here = new URL('./', import.meta.url);
const sources = {};

for (const [network, proxy] of Object.entries(NETWORKS)) {
  const url = `${proxy}/v1/ip_info`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const list = await response.json();
  const file = `ip_info.${network}.v1.json`;
  await writeFile(new URL(file, here), JSON.stringify(list, null, 2) + '\n');
  sources[file] = url;
  console.log(`${file}: ${list.length} providers (${list.map((e) => e.ipInfo?.ipIdentity).join(', ')})`);
}

await writeFile(new URL('ip_info.captured.json', here),
  JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), sources }, null, 2) + '\n');
