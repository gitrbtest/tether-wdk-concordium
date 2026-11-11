/**
 * Re-capture the chain's own record of the identity providers and anonymity revokers, used as offline test fixtures
 * for the check of the provider list against the chain.
 *
 * Asks Concordium's public testnet and mainnet nodes (getIdentityProviders, getAnonymityRevokers) and saves the
 * answers here, pretty-printed so a change shows up as a readable git diff. The data is public: names and public keys.
 *
 * Run from identity/:  node test/fixtures/capture-chain-providers.mjs
 */
import { writeFile } from 'node:fs/promises';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const NODES = {
  testnet: 'grpc.testnet.concordium.com',
  mainnet: 'grpc.mainnet.concordium.software',
};

for (const [network, host] of Object.entries(NODES)) {
  const node = new ConcordiumGRPCNodeClient(host, 20000, credentials.createSsl());
  const identityProviders = [];
  for await (const ip of node.getIdentityProviders()) identityProviders.push(ip);
  const anonymityRevokers = [];
  for await (const ar of node.getAnonymityRevokers()) anonymityRevokers.push(ar);
  const file = `chain-providers.${network}.json`;
  await writeFile(new URL(file, import.meta.url), JSON.stringify({ identityProviders, anonymityRevokers }, null, 2) + '\n');
  console.log(`${file}: ${identityProviders.length} identity providers, ${anonymityRevokers.length} anonymity revokers (from ${host})`);
}
process.exit(0);
