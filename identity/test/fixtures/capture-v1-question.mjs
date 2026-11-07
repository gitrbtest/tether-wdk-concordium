/**
 * Record one version 1 question on testnet, once, and keep it as a test fixture (v1-question.testnet.json), so the
 * live tests can answer and check a real anchored question without spending anything again.
 *
 * WRITES TO TESTNET AND SPENDS A FEE: one registerData anchor (about EUR 0.013: 4.98 testnet CCD on 7 Nov 2026), paid by the sponsor.
 * Run by hand from identity/, only to replace the recorded question:  node test/fixtures/capture-v1-question.mjs
 *
 * The website is account 13 of the public test phrase's identity 334563111 (it holds no CCD); the sponsor, which
 * pays the fee, is account 11 of the same identity. Keep account 11 funded. The question: over 18, showing the
 * nationality, for identities from testnet providers 0, 1 and 2.
 *
 * Saved: the question exactly as requestForV1 returned it, and what the node says about its anchor (the block it is
 * in and the data it recorded), for the offline tests. All of it is public, on chain.
 */
import { writeFile } from 'node:fs/promises';
import * as sdk from '@concordium/web-sdk';
import { requestForV1, connectToNode, describeProofRequest } from '@concordium/wdk-identity-concordium/verify';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const IDENTITY = { providerIndex: 0, identityIndex: 334563111 };
const WEBSITE = { credNumber: 13, address: '4rEgzrWemrBjxUvkcEkDt9AfB2F7JdS8jkW3M9UWWK1TYaWSX1' };
const SPONSOR = { credNumber: 11, address: '4kJZHvmLwMJjPp58ie7ZZirRkSZL1WLfcKbcrCdBAzweSj9fTU' };

const hdWallet = sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
const signerOf = ({ credNumber }) => sdk.buildBasicAccountSigner(
  hdWallet.getAccountSigningKey(IDENTITY.providerIndex, IDENTITY.identityIndex, credNumber).toString('hex'));
const node = connectToNode('testnet');

const question = await requestForV1(
  { network: 'testnet', website: 'age-check.example', purpose: 'age check (recorded test question)', providers: [0, 1, 2], adult: true, reveal: ['nationality'] },
  { node, sender: WEBSITE.address, signer: signerOf(WEBSITE), sponsor: { address: SPONSOR.address, signer: signerOf(SPONSOR) } },
);
const status = await node.getBlockItemStatus(sdk.TransactionHash.fromHexString(question.transactionRef));
const { summary } = status.outcome;
// A sponsored transaction's fee is on its sponsor part; the sender pays nothing.
const cost = summary.sponsor?.cost ?? summary.cost;
const fee = { microCcdAmount: cost?.microCcdAmount ?? cost }; // a CcdAmount, or (the sender's cost) a plain bigint
const recorded = {
  recorded: new Date().toISOString(),
  question,
  anchor: {
    transactionHash: question.transactionRef,
    blockHash: sdk.BlockHash.toHexString(status.outcome.blockHash),
    transactionType: summary.transactionType,
    data: summary.dataRegistered.data,
    sender: summary.sender.address,
    sponsor: summary.sponsor?.sponsor?.address,
    feeMicroCcd: String(fee.microCcdAmount),
  },
};
await writeFile(new URL('./v1-question.testnet.json', import.meta.url), JSON.stringify(recorded, null, 2) + '\n');
console.log(`Recorded: anchor ${question.transactionRef} in block ${recorded.anchor.blockHash}, fee ${Number(fee.microCcdAmount) / 1e6} CCD`);
console.log(`https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${question.transactionRef}`);
console.log(describeProofRequest(question)[0].asks.map((a) => a.text).join('\n'));
