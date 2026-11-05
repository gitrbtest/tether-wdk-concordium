/**
 * Live (testnet), read-only: Concordium's reward shop's question (compliant-reward-distribution, copied in
 * test/unit/proof-compatibility.test.mjs), answered by a wallet that got its identity back from the provider, and
 * checked against the real testnet chain. Its challenge is made, as the shop makes it, from a recent block.
 * Nothing is sent to the chain and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * The identity is identity 1 of the public "abandon" test phrase (provider 0), made on 2 Nov 2026; its account 0
 * is 46aPXi34….
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { checkPresentation, connectToNode } from '@concordium/wdk-identity-concordium/verify';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const IDENTITY_1 = { providerIndex: 0, identityIndex: 1 };
const ZK_STATEMENTS = [
  { type: 'RevealAttribute', attributeTag: 'nationalIdNo' },
  { type: 'RevealAttribute', attributeTag: 'nationality' },
  { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20060802' },
  { type: 'AttributeNotInSet', attributeTag: 'countryOfResidence', set: ['US', 'KP'] },
];

test("Concordium's reward shop: its question, answered by identity 1's account, accepted against the testnet chain", async () => {
  const wallet = new ConcordiumIdentity(PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG);
  try {
    assert.ok(await wallet.recoverIdentity(IDENTITY_1), 'identity 1 is back from the provider');
    const node = connectToNode('testnet');
    const block = (await node.getConsensusStatus()).lastFinalizedBlock;
    const challenge = createHash('sha256')
      .update(Buffer.concat([Buffer.from(sdk.BlockHash.toHexString(block), 'hex'), Buffer.from('CONCORDIUM_COMPLIANT_REWARD_DISTRIBUTION_DAPP')]))
      .digest('hex');
    const question = { challenge, credentialStatements: [{ idQualifier: { type: 'cred', issuers: [0, 1, 2, 3, 4, 5, 6, 7] }, statement: ZK_STATEMENTS }] };

    const [account] = await wallet.accountsThatCanAnswer({ ...IDENTITY_1, ...question });
    assert.match(account?.address ?? '', /^46aPXi34/, "identity 1's account can answer");
    const answer = await wallet.prove({ ...IDENTITY_1, credNumber: account.credNumber, paramsJson: JSON.stringify(question) });

    const result = await checkPresentation(answer, question, { node, network: 'testnet' });
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    assert.equal(result.account, account.address);
    assert.deepEqual(Object.keys(result.revealed), ['nationalIdNo', 'nationality']);
  } finally {
    wallet.dispose();
  }
});
