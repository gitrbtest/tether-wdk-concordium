/**
 * The website's side of a version 1 proof (identity-based), first half: build the question and record it on chain.
 * Part of the `@concordium/wdk-identity-concordium/verify` entry point (servers, Node.js).
 *
 *   requestForV1 ─► what to ask (the same options as requestFor) ─► the context (a fresh random nonce, the
 *                   website, the purpose) ─► Concordium's statement builder ─► the anchor: a hash of the question,
 *                   sent on chain in a registerData transaction (fee paid by the website, or by a sponsor) ─► wait
 *                   until it is final ─► the question, ready to send to the wallet (and to keep, to check the answer)
 *
 * Built from Concordium's own pieces (VerificationRequestV1, Transaction), so the question is exactly what
 * Concordium's wallets read. The anchor costs a small fee (about EUR 0.013); with `sponsor`, another account pays
 * it, so the website's own account can hold no CCD at all.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ProofError } from '../shared/errors.js';
import { readProofRequestV1 } from '../proofs/proof-request.js';
import { readAsks, ASK_OPTIONS } from './request-for.js';

const invalid = (message) => new ProofError(message, { reason: 'invalid-request' });
/** The node's answers that mean "refused" (it will not take this transaction), not "could not be asked". */
const REFUSED = new Set(['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'ALREADY_EXISTS', 3, 9, 6]);
/** Where the answer may come from, as the option says it, and the builder method that asks for it. */
const ANSWER_FROM = { identity: 'addIdentityClaims', account: 'addAccountClaims', either: 'addAccountOrIdentityClaims' };
const NODE_METHODS = ['getNextAccountNonce', 'sendTransaction', 'waitForTransactionFinalization'];

function address(value, what) {
  try {
    return sdk.AccountAddress.fromBase58(value);
  } catch {
    throw new Error(`${what} must be an account address (base58).`);
  }
}

function requireSigner(signer, what) {
  if (!signer || typeof signer.sign !== 'function' || typeof signer.getSignatureCount !== 'function') {
    throw new Error(`${what} must be an account signer, e.g. buildBasicAccountSigner(signingKey) from @concordium/web-sdk.`);
  }
  return signer;
}

/**
 * Build a version 1 question and record it on chain (its anchor), waiting until the anchor is final. Returns the
 * question as Concordium's VerificationRequestV1 JSON: send it to the wallet, and keep it on your server
 * (checkPresentationV1 compares the answer with it).
 *
 * @param {object} options  what to ask: the same options as requestFor (providers, adult, minAge, residentIn,
 *   notResidentIn, nationalityIn, nationalityNotIn, documentValid, reveal), plus:
 * @param {'testnet' | 'mainnet'} options.network  the network the identities and the anchor are on
 * @param {string} options.website  who is asking, e.g. 'shop.example': wallets show it, and should compare it with
 *   the site they are connected to (the question's ResourceID)
 * @param {string} [options.purpose]  why, in a few words, e.g. 'age check' (its ContextString)
 * @param {string} [options.connection]  your id for this conversation with the wallet (its ConnectionID; default:
 *   a random one)
 * @param {'identity' | 'account' | 'either'} [options.answerFrom='identity']  where the answer may come from:
 *   the identity itself (no account named), an account, or either
 * @param {object} anchoring  who records the question on chain
 * @param {object} anchoring.node  a node connection (connectToNode)
 * @param {string} anchoring.sender  the website's account address: it sends the anchor
 * @param {object} anchoring.signer  the website account's signer (buildBasicAccountSigner(key))
 * @param {{ address: string, signer: object }} [anchoring.sponsor]  an account that pays the fee instead (both
 *   accounts sign); the website's account then needs no CCD
 * @param {number} [anchoring.timeoutMs=120000]  how long to wait for the anchor to be final
 * @returns {Promise<object>}  the question (VerificationRequestV1 JSON)
 * @throws {ProofError} reason 'invalid-request' or 'unknown-attribute' (nothing sent); 'anchor-failed' (the node
 *   refused the anchor, or it was rejected on chain, e.g. not enough CCD for the fee: `detail` says); 'node' (the
 *   node could not be asked, or the anchor was not final in time)
 */
export async function requestForV1(options = {}, { node, sender, signer, sponsor, timeoutMs = 120_000 } = {}) {
  const { network, website, purpose, connection = randomUUID(), answerFrom = 'identity', ...asked } = options ?? {};
  const unknown = Object.keys(asked).filter((k) => !ASK_OPTIONS.includes(k));
  if (unknown.length) throw invalid(`Unknown option: ${unknown.join(', ')}.`);
  const net = String(network).toLowerCase();
  if (net !== 'testnet' && net !== 'mainnet') throw invalid("network is required: 'testnet' or 'mainnet'.");
  if (typeof website !== 'string' || website.trim() === '') {
    throw invalid("website is required: who is asking, e.g. 'shop.example' (wallets show it and compare it with where they are connected).");
  }
  if (purpose !== undefined && typeof purpose !== 'string') throw invalid('purpose must be text, e.g. \'age check\'.');
  if (typeof connection !== 'string' || connection === '') throw invalid('connection must be text.');
  if (!(answerFrom in ANSWER_FROM)) throw invalid("answerFrom must be 'identity', 'account' or 'either'.");
  const { providers, ask } = readAsks(asked);

  if (!node || NODE_METHODS.some((m) => typeof node[m] !== 'function')) {
    throw new Error("requestForV1 needs a node connection to record the question: { node: connectToNode('testnet'), sender, signer }.");
  }
  const senderAddress = address(sender, 'sender');
  requireSigner(signer, 'signer');
  const sponsorAddress = sponsor === undefined ? undefined : address(sponsor?.address, 'sponsor.address');
  if (sponsor !== undefined) requireSigner(sponsor.signer, 'sponsor.signer');

  // The question: a fresh random nonce makes each one unique, so an answer to it cannot be reused for another.
  const Network = net === 'testnet' ? 'Testnet' : 'Mainnet';
  const context = sdk.VerificationRequestV1.createSimpleContext(randomBytes(32), connection, website, purpose);
  const claims = sdk.VerificationRequestV1.claimsBuilder()[ANSWER_FROM[answerFrom]](
    providers.map((index) => new sdk.IdentityProviderDID(Network, index)), ask).getClaims();

  // The anchor: a registerData transaction holding the question's hash, sent by the website (and paid by the sponsor).
  let hash;
  try {
    const { nonce } = await node.getNextAccountNonce(senderAddress);
    let transaction = sdk.Transaction.registerData({ data: new sdk.DataBlob(sdk.VerificationRequestV1.createAnchor(context, claims)) })
      .addMetadata({ sender: senderAddress, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) });
    if (sponsorAddress) transaction = transaction.addSponsor(sponsorAddress);
    let signed = await sdk.Transaction.sign(transaction.build(), signer);
    if (sponsorAddress) signed = await sdk.Transaction.sponsor(signed, sponsor.signer);
    hash = await node.sendTransaction(sdk.Transaction.finalize(signed));
  } catch (e) {
    if (REFUSED.has(e?.code)) {
      throw new ProofError(`The node refused the anchor: ${e.message}`, { reason: 'anchor-failed', detail: e.message });
    }
    throw new ProofError(`The node could not be asked to record the question: ${e?.message ?? e}`, { reason: 'node', detail: e?.message ?? String(e) });
  }

  // Wait until it is final: a wallet refuses a question whose anchor is not final yet.
  let outcome;
  try {
    outcome = await node.waitForTransactionFinalization(hash, timeoutMs);
  } catch (e) {
    throw new ProofError(`The anchor (${sdk.TransactionHash.toHexString(hash)}) was not seen final: ${e?.message ?? e}. It may still `
      + 'become final; the question cannot be answered until it does.', { reason: 'node', detail: e?.message ?? String(e) });
  }
  const summary = outcome?.summary;
  if (summary?.type !== 'accountTransaction' || summary.transactionType !== 'registerData') {
    const why = summary?.rejectReason?.tag ?? summary?.transactionType ?? 'unknown';
    throw new ProofError(`The anchor was rejected on chain (${why}).`, { reason: 'anchor-failed', detail: String(why) });
  }
  return readProofRequestV1(sdk.VerificationRequestV1.create(context, claims, hash)).request.toJSON();
}
