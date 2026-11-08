/**
 * Live (testnet), read-only: Concordium's reward shop's question (compliant-reward-distribution, copied in
 * test/unit/7-proofs/compatibility-with-concordium-apps.test.mjs), answered by a wallet that got its identity back from the provider, and
 * checked against the real testnet chain. Its challenge is made, as the shop makes it, from a recent block.
 * Nothing is sent to the chain and nothing is spent, so it runs with the other live tests:
 *
 *   npm run test:integration
 *
 * The identity is identity 1 of the public "abandon" test phrase (provider 0), made on 2 Nov 2026; its account 0
 * is 46aPXi34….
 *
 * Who is who:
 *   SHOP       Concordium's own reward shop (compliant-reward-distribution): its question, made as it makes it
 *   WALLET     identity 1 of the public test phrase, answering with its account 0, 46aPXi34…
 *   PROVIDER   provider 0, which gives the identity back (recovery)
 *
 *   SHOP (Concordium's)           WALLET                               PROVIDER 0 / TESTNET CHAIN
 *   ───────────────────           ──────                               ──────────────────────────
 *                                 1. gets identity 1 back ───────────► provider 0 (recoverIdentity)
 *   2. its challenge, from the latest finalized block ◄──────────────── chain
 *      its question: show national ID number and nationality,
 *      born before 2 Aug 2006, not living in US or KP
 *      sends it ────────────────► 3. finds the account that can answer: 46aPXi34…
 *                                 4. answers (prove, as WalletConnect carries it)
 *   5. checkPresentation ◄─────── the answer
 *      against the chain ────────────────────────────────────────────► chain
 *      accepted: account 46aPXi34…, national ID number and nationality shown
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { checkPresentation, connectToNode } from '@concordium/wdk-identity-concordium/verify';
import { liveTestnetConfig } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const IDENTITY_1 = { providerIndex: 0, identityIndex: 1 };
const ZK_STATEMENTS = [
  { type: 'RevealAttribute', attributeTag: 'nationalIdNo' },
  { type: 'RevealAttribute', attributeTag: 'nationality' },
  { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20060802' },
  { type: 'AttributeNotInSet', attributeTag: 'countryOfResidence', set: ['US', 'KP'] },
];

// Steps 1-5: the whole story, once. Read-only.
test("Concordium's reward shop: its question, answered by identity 1's account, accepted against the testnet chain", async () => {
  const wallet = new ConcordiumIdentity(PHRASE, await liveTestnetConfig());
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
