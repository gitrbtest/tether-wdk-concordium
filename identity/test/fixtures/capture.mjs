/**
 * Re-capture the network data used as offline test fixtures.
 *
 * Downloads, from the testnet and mainnet wallet-proxies:
 *   /v1/ip_info  the identity providers, with their published issuance and recovery addresses
 *   /v0/global   the network's cryptographic parameters an identity request is built against
 * and saves each one here, pretty-printed so a change shows up as a readable git diff.
 * The data is public: provider names, public keys, URLs, support addresses, chain parameters.
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

async function capture(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const body = await response.json();
  await writeFile(new URL(file, here), JSON.stringify(body, null, 2) + '\n');
  sources[file] = url;
  return body;
}

for (const [network, proxy] of Object.entries(NETWORKS)) {
  const list = await capture(`${proxy}/v1/ip_info`, `ip_info.${network}.v1.json`);
  console.log(`ip_info.${network}.v1.json: ${list.length} providers (${list.map((e) => e.ipInfo?.ipIdentity).join(', ')})`);
  const global = await capture(`${proxy}/v0/global`, `global.${network}.json`);
  console.log(`global.${network}.json: ${global.value?.genesisString}`);
}

await writeFile(new URL('ip_info.captured.json', here),
  JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), sources }, null, 2) + '\n');
