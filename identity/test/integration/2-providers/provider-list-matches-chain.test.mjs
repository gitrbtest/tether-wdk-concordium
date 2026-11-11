/**
 * Live (testnet and mainnet), read-only: the provider lists the wallet-proxies publish today (/v2/ip_info) match the
 * chain's own record of the identity providers and anonymity revokers, so the check of the list against the chain
 * accepts every provider in them. If a provider's keys ever change on one side only, this shows it.
 *
 *   npm run test:integration
 *
 * Who is who:
 *   WALLET-PROXY   publishes the provider list (with the addresses of the providers' pages)
 *   NODE           Concordium's public node: the chain's record of the providers and anonymity revokers
 *   PACKAGE        compares the two, as ConcordiumIdentity does on first use
 *
 *   WALLET-PROXY ── the list ──► PACKAGE ◄── the chain's record ── NODE
 *                                   └─ every provider in the list matches: none is left out
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import IdentityProviders from '../../../src/providers/IdentityProviders.js';
import ChainNode from '../../../src/chain/ChainNode.js';

const NETWORKS = {
  testnet: { proxy: 'https://wallet-proxy.testnet.concordium.com', node: 'grpc.testnet.concordium.com' },
  mainnet: { proxy: 'https://wallet-proxy.mainnet.concordium.software', node: 'grpc.mainnet.concordium.software' },
};

for (const [network, { proxy, node }] of Object.entries(NETWORKS)) {
  test(`${network}: every provider in the published list matches the chain's record`, async () => {
    const list = await (await fetch(`${proxy}/v2/ip_info`)).json();
    const chain = new ChainNode(new ConcordiumGRPCNodeClient(node, 20000, credentials.createSsl()));
    const providers = new IdentityProviders(list, { node: chain });
    const checked = await providers.list();
    assert.deepEqual(checked.map((p) => p.index), list.map((e) => e.ipInfo.ipIdentity), 'none left out');
    for (const { index } of checked) assert.equal((await providers.get(index)).index, index);
  });
}
