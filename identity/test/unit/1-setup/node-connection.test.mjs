/**
 * ChainNode (internal): the network's cryptographic parameters, read from the node connection the wallet passes in,
 * and reused within one ConcordiumIdentity. A pretend node answers from recordings; no external services.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcordiumIdentity } from '@concordium/wdk-identity-concordium';
import ChainNode from '../../../src/chain/ChainNode.js';
import { recordedNode, testnetConfig, walletProxyFetch, globalFixture } from '../../helpers.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('the cryptographic parameters come from the node, read only once', async () => {
  const client = recordedNode('testnet');
  const node = new ChainNode(client);
  const first = await node.globalContext();
  assert.equal(await node.globalContext(), first);
  assert.equal(client.calls, 1);
  assert.equal(first.genesisString, globalFixture('testnet').value.genesisString);
});

test('a failed read is not remembered: the next call tries again', async () => {
  const client = recordedNode('testnet', { fail: new Error('the node is unreachable') });
  const node = new ChainNode(client);
  await assert.rejects(() => node.globalContext(), /the node is unreachable/);
  delete client.getCryptographicParameters; // now answer normally
  client.getCryptographicParameters = recordedNode('testnet').getCryptographicParameters;
  assert.ok((await node.globalContext()).genesisString);
});

test('parameters in an unexpected format are refused clearly', async () => {
  for (const parameters of [{}, { genesisString: 'x' }]) {
    await assert.rejects(() => new ChainNode(recordedNode('testnet', { parameters })).globalContext(),
      /node returned cryptographic parameters in an unexpected format/);
  }
});

test('one identity reads the parameters once from its node, however often it needs them; none over HTTP', async () => {
  const node = recordedNode('testnet');
  const { fetch, requests } = walletProxyFetch('testnet');
  const identity = new ConcordiumIdentity(TEST_PHRASE, testnetConfig({ node }), { fetch });
  // The ownership check (used when collecting) needs them; it is much quicker than building a full request.
  await identity._issuance.expectedIdCredPub(0, 0);
  await identity._issuance.expectedIdCredPub(0, 1);
  assert.equal(node.calls, 1);
  assert.deepEqual(requests, [], 'nothing from the wallet-proxy');
  identity.dispose();
});
