/**
 * npm run check:providers [-- testnet|mainnet]
 *
 * Live check of every identity provider the testnet and mainnet wallet-proxies
 * publish: does each provider accept a well-formed identity request and open its
 * verification page? Reports one line per provider. Stops before verification:
 * nothing is filled in, no identity is issued and no personal data is involved.
 * Each request comes from a fresh random seed that is never stored.
 */
import {
  CONCORDIUM_MAINNET_IDENTITY_CONFIG,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '../index.js';
import { checkNetwork } from './lib/provider-check.mjs';

import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

// Each network's preset, plus a connection to Concordium's public node there (the package never opens one itself).
const nodeAt = (host) => new ConcordiumGRPCNodeClient(host, 20000, credentials.createSsl());
const NETWORKS = {
  testnet: { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, node: nodeAt('grpc.testnet.concordium.com') },
  mainnet: { ...CONCORDIUM_MAINNET_IDENTITY_CONFIG, node: nodeAt('grpc.mainnet.concordium.software') },
};
// Where each network's identity provider list is published today: the wallet-proxy's /v1/ip_info.
const LIST_URLS = {
  testnet: 'https://wallet-proxy.testnet.concordium.com/v1/ip_info',
  mainnet: 'https://wallet-proxy.mainnet.concordium.software/v1/ip_info',
};
const MARK = { accepted: '✔', 'provider-error': '✖', 'http-error': '✖', unreachable: '✖', 'no-issuance-address': '–' };
const SAYS = {
  accepted: 'request accepted, verification page opens at',
  'provider-error': 'provider error:',
  'http-error': 'refused:',
  unreachable: 'unreachable:',
  'no-issuance-address': 'not checked:',
};

const chosen = process.argv.slice(2);
const unknown = chosen.filter((name) => !NETWORKS[name]);
if (unknown.length) {
  console.error(`Unknown network: ${unknown.join(', ')}. Use testnet and/or mainnet.`);
  process.exit(2);
}

let failed = false;
for (const network of chosen.length ? chosen : Object.keys(NETWORKS)) {
  let results;
  try {
    results = await checkNetwork(NETWORKS[network], { listUrl: LIST_URLS[network] });
  } catch (e) {
    console.log(`${network.padEnd(8)} the wallet-proxy could not be read: ${e.message}`);
    failed = true;
    continue;
  }
  const width = Math.max(...results.map((r) => r.name.length));
  for (const { index, name, outcome, detail } of results) {
    console.log(`${network.padEnd(8)} ${String(index).padStart(2)}  ${name.padEnd(width)}  ${MARK[outcome]} ${SAYS[outcome]} ${detail}`);
  }
}
console.log(`\nChecked ${new Date().toISOString()}. A provider error is reported, not treated as a failure of this check.`);
process.exit(failed ? 1 : 0);
