/**
 * Re-capture the network data used as offline test fixtures.
 *
 * Downloads, from the testnet and mainnet wallet-proxies:
 *   /v1/ip_info  the identity providers, with their published issuance and recovery addresses
 *   /v2/ip_info  the same, plus the company (Business ID) providers
 *   /v0/global   the network's cryptographic parameters an identity request is built against
 * and saves each one here, pretty-printed so a change shows up as a readable git diff.
 * The data is public: provider names, public keys, URLs, support addresses, chain parameters.
 *
 * Run from identity/:  npm run fixtures
 * Review the diff after re-capturing: a changed provider list or address is
 * exactly what these fixtures exist to surface.
 */
import { writeFile } from 'node:fs/promises';

const NETWORKS = {
  testnet: 'https://wallet-proxy.testnet.concordium.com',
  mainnet: 'https://wallet-proxy.mainnet.concordium.software',
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
  // /v2/ip_info: the full list, including the company (Business ID) providers that /v1 leaves out.
  const all = await capture(`${proxy}/v2/ip_info`, `ip_info.${network}.v2.json`);
  console.log(`ip_info.${network}.v2.json: ${all.length} providers (${all.map((e) => e.ipInfo?.ipIdentity).join(', ')})`);
  const global = await capture(`${proxy}/v0/global`, `global.${network}.json`);
  console.log(`global.${network}.json: ${global.value?.genesisString}`);
}

// A real identity issued by the testnet identity provider (provider 0) for the public
// "abandon … about" test seed at identity index 334563111, with the test form's made-up
// attributes. Collected from its code_uri, the reference the provider returned after issuance.
export const ISSUED_TESTNET_IDENTITY = {
  providerIndex: 0,
  identityIndex: 334563111,
  codeUri: 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a',
};
await capture(ISSUED_TESTNET_IDENTITY.codeUri, 'identity-done.testnet.json');
console.log('identity-done.testnet.json: issued identity collected from its code_uri');

// The sealed details ("commitments") of that identity's account 0, as stored on chain when the account was created:
// what a website checks a V0 proof against. Read from a testnet node (the wallet-proxy does not serve them).
// Lets the proof tests check presentations offline.
const { ConcordiumGRPCNodeClient } = await import('@concordium/web-sdk/nodejs');
const { credentials } = await import('@grpc/grpc-js');
const { AccountAddress } = await import('@concordium/web-sdk');
export const RECORDED_ACCOUNT_0 = '3Z4WkEMb5msvBRPAZyneFcntHWqceHf7Q9JitSjBAegvQXSB5t';
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const info = await node.getAccountInfo(AccountAddress.fromBase58(RECORDED_ACCOUNT_0));
const credential = info.accountCredentials[0].value.contents;
await writeFile(new URL('account-commitments.testnet.json', here), JSON.stringify({
  address: RECORDED_ACCOUNT_0,
  identity: { providerIndex: ISSUED_TESTNET_IDENTITY.providerIndex, identityIndex: ISSUED_TESTNET_IDENTITY.identityIndex, credNumber: 0 },
  credId: credential.credId,
  issuer: credential.ipIdentity,
  commitments: credential.commitments.cmmAttributes,
}, null, 2) + '\n');
sources['account-commitments.testnet.json'] = `grpc.testnet.concordium.com: getAccountInfo(${RECORDED_ACCOUNT_0})`;
console.log(`account-commitments.testnet.json: ${Object.keys(credential.commitments.cmmAttributes).length} sealed attributes of account 0`);

// Last: where each file came from, and when.
await writeFile(new URL('ip_info.captured.json', here),
  JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), sources }, null, 2) + '\n');
