/**
 * The website's side of a version 1 proof, second half: check the answer a wallet sent to a question made with
 * requestForV1. Part of the `@concordium/wdk-identity-concordium/verify` entry point (servers, Node.js).
 *
 *   checkPresentationV1 ─► read the answer ─► is it the answer to OUR question? (the same context: nonce, website,
 *        purpose; the same questions; accepted providers; answered from where the question allows; the right
 *        network) ─► the anchor: on chain, final, really our question, and the answer tied to its block?
 *        ─► each credential's public data from the chain (the provider's keys for an identity, the account's
 *        sealed details for an account) ─► still Active? ─► does the maths hold? ─► the result, and an audit record
 *
 * Built from Concordium's own pieces (VerifiablePresentationV1.getPublicData and verify, VerificationRequestV1's
 * anchor check, VerificationAuditRecordV1). Its all-in-one createChecked is not used: in the SDK version this
 * package uses (12.0.2) it does not wait for its own context comparison, so an answer to another question with
 * the same statements is accepted, and the comparison's failure surfaces as an unhandled rejection.
 */
import { randomUUID } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ProofError } from '../shared/errors.js';
import { readProofRequestV1 } from '../proofs/proof-request.js';
import { sameStatements } from './check-presentation.js';

const NODE_METHODS = ['getBlockItemStatus', 'getCryptographicParameters', 'getIdentityProviders', 'getAnonymityRevokers', 'getBlockInfo', 'getAccountInfo'];
const isNotFound = (e) => e?.code === 'NOT_FOUND' || e?.code === 5;
const STATUS_WORDS = {
  [sdk.CIS4.CredentialStatus.Expired]: 'expired',
  [sdk.CIS4.CredentialStatus.NotActivated]: 'not active yet',
  [sdk.CIS4.CredentialStatus.Revoked]: 'revoked',
};

/** The answer as plain JSON, from any form a website may receive it in (object, text, WalletConnect's wrapper); or null. */
function readAnswer(presentation) {
  try {
    let json = presentation;
    if (typeof presentation?.verifiablePresentationJson === 'string') json = JSON.parse(presentation.verifiablePresentationJson);
    else if (typeof presentation === 'string') json = JSON.parse(presentation);
    else json = JSON.parse(JSON.stringify(presentation)); // the SDK's object, or plain JSON
    if (!json?.type?.includes?.('ConcordiumVerifiablePresentationV1') || !Array.isArray(json.verifiableCredential)
      || !Array.isArray(json.presentationContext?.given) || !Array.isArray(json.presentationContext?.requested)) return null;
    return json;
  } catch {
    return null;
  }
}

/** Context items as label → text, for comparing (hex values compared in small letters). */
const contextMap = (items) => new Map(items.map((c) => [c.label, String(c.context).toLowerCase()]));

/** The statements an answer proves, written as they were asked: a shown detail (AttributeValue) as RevealAttribute. */
const asAsked = (statements) => statements.map((s) => (s?.type === 'AttributeValue' ? { type: 'RevealAttribute', attributeTag: s.attributeTag } : s));

/**
 * Check a wallet's answer to a version 1 question made with requestForV1.
 *
 * Refuses an answer that is not for this question (another nonce, website or purpose; other statements; not tied
 * to this question's anchor), from a provider the question does not accept, answered from an identity or account
 * where the question does not allow it, for another network, whose identity is no longer Active, or whose maths
 * does not hold; and a question whose anchor is not on chain and final. A refused answer is a normal outcome: it
 * returns `ok: false` with the reasons, it does not throw.
 *
 * Not done here (the website's job): accept each question's answer only once. Keep the audit record of the answer
 * you accepted, and refuse a second answer to the same question.
 *
 * @param {object | string} presentation  the wallet's answer: the object, its JSON text, or `{ verifiablePresentationJson }`
 * @param {object} request  the question this answer is for, as requestForV1 returned it (kept on the server)
 * @param {{ node: object, network: 'testnet' | 'mainnet', recordId?: string }} options  a node connection
 *   (connectToNode), the network the website works on, and an id for the audit record (default: a random one)
 * @returns {Promise<{ ok: boolean, reasons: Array<{ reason: string, message: string }>, revealed: Record<string, string>,
 *   credentials: Array<{ from: 'identity' | 'account', issuer: number, account?: string, revealed: Record<string, string> }>,
 *   auditRecord?: object }>}  `revealed`: the details the question asked to see; `auditRecord` (accepted only):
 *   Concordium's VerificationAuditRecordV1 as JSON (the question, the answer and the id), to keep
 * @throws {ProofError} reason 'invalid-request' if the question itself is broken; 'node' if the node could not be asked
 */
export async function checkPresentationV1(presentation, request, { node, network, recordId = randomUUID() } = {}) {
  const question = readProofRequestV1(request);
  if (!node || NODE_METHODS.some((m) => typeof node[m] !== 'function')) {
    throw new Error("checkPresentationV1 needs a node connection: { node: connectToNode('testnet') }.");
  }
  const net = String(network).toLowerCase();
  if (net !== 'testnet' && net !== 'mainnet') throw new Error("checkPresentationV1 needs the network: 'testnet' or 'mainnet'.");
  const Network = net === 'testnet' ? 'Testnet' : 'Mainnet';

  const refused = (reasons) => ({ ok: false, reasons, revealed: {}, credentials: [] });
  const answer = readAnswer(presentation);
  if (!answer) return refused([{ reason: 'unreadable', message: 'The answer is not a version 1 verifiable presentation.' }]);
  if (question.network !== Network) {
    return refused([{ reason: 'wrong-network', message: `The question is for ${question.network}, not ${net}.` }]);
  }

  // 1. Is it the answer to OUR question? All checked from the answer itself, before asking the chain anything.
  const reasons = [];
  const asked = contextMap(question.request.toJSON().context.given);
  const given = contextMap(answer.presentationContext.given);
  if (asked.size !== given.size || [...asked].some(([label, text]) => given.get(label) !== text)) {
    reasons.push({ reason: 'context-mismatch', message: 'The answer is for another question (its nonce, website or purpose differs).' });
  }
  const filled = contextMap(answer.presentationContext.requested);
  if (filled.size !== question.requested.length || question.requested.some((label) => !filled.has(label))) {
    reasons.push({ reason: 'context-mismatch', message: 'The answer does not fill in what the question asked the wallet for.' });
  }
  if (answer.verifiableCredential.length !== question.claims.length) {
    reasons.push({ reason: 'statements-mismatch', message: 'The answer does not answer the questions asked (a different number of parts).' });
  }
  const parts = answer.verifiableCredential.map((vc, n) => {
    const claim = question.claims[n];
    const from = vc?.type?.includes?.('ConcordiumIdBasedCredential') ? 'identity'
      : vc?.type?.includes?.('ConcordiumAccountBasedCredential') ? 'account' : null;
    const issuer = String(vc?.issuer ?? '').match(/^did:ccd:([a-z]+):idp:(\d+)$/i);
    if (!from || !issuer || !Array.isArray(vc?.credentialSubject?.statement)) {
      reasons.push({ reason: 'not-an-identity', message: `Part ${n + 1} of the answer is not about a Concordium identity.` });
      return null;
    }
    if (issuer[1].toLowerCase() !== net) reasons.push({ reason: 'wrong-network', message: `The answer is from ${issuer[1]}, not ${net}.` });
    if (claim && !claim.source.includes(from === 'identity' ? 'identityCredential' : 'accountCredential')) {
      reasons.push({ reason: 'source-not-accepted', message: `Part ${n + 1} is answered from ${from === 'identity' ? 'the identity itself' : 'an account'}, which the question does not accept.` });
    }
    if (claim && !claim.providers.includes(Number(issuer[2]))) {
      reasons.push({ reason: 'provider-not-accepted', message: `The identity is from provider ${issuer[2]}, which the question does not accept.` });
    }
    // Without this, a wallet could answer an easier question ("over 5" for "over 18") and the maths would still hold.
    if (claim && !sameStatements(claim.statements, asAsked(vc.credentialSubject.statement))) {
      reasons.push({ reason: 'statements-mismatch', message: `Part ${n + 1} of the answer proves something other than what was asked.` });
    }
    return { from, issuer: Number(issuer[2]) };
  });
  if (reasons.length) return refused(reasons);

  // 2. The anchor: on chain, final, really this question, and the answer tied to its block.
  let anchorStatus;
  try {
    anchorStatus = await node.getBlockItemStatus(question.request.transactionRef);
  } catch (e) {
    if (isNotFound(e)) return refused([{ reason: 'anchor-not-found', message: `The question's anchor (${question.anchor}) is not on chain.` }]);
    throw new ProofError(`The node could not be asked: ${e?.message ?? e}`, { reason: 'node', detail: e?.message ?? String(e) });
  }
  if (anchorStatus?.status !== 'finalized') {
    return refused([{ reason: 'anchor-not-found', message: `The question's anchor is not final (${anchorStatus?.status}).` }]);
  }
  try {
    await sdk.VerificationRequestV1.verifyAnchor(question.request, { getBlockItemStatus: async () => anchorStatus });
  } catch (e) {
    return refused([{ reason: 'anchor-mismatch', message: `The question's anchor does not record this question: ${e.message}` }]);
  }
  const anchorBlock = sdk.BlockHash.toHexString(anchorStatus.outcome.blockHash);
  if (question.requested.includes('BlockHash') && filled.get('BlockHash') !== anchorBlock) {
    return refused([{ reason: 'block-mismatch', message: 'The answer is not tied to the block the question was recorded in.' }]);
  }

  // 3. Each credential's public data from the chain, and whether its identity is still valid. Concordium's
  // getPublicData does the reading; we note each account's address and provider on the way.
  const accounts = new Map();
  const reader = {
    getIdentityProviders: (...a) => node.getIdentityProviders(...a),
    getAnonymityRevokers: (...a) => node.getAnonymityRevokers(...a),
    getBlockInfo: (...a) => node.getBlockInfo(...a),
    getAccountInfo: async (credId, block) => {
      const info = await node.getAccountInfo(credId, block);
      accounts.set(credId.credId, info.accountAddress?.address);
      return info;
    },
  };
  let sent;
  let publicData;
  let globalContext;
  try {
    sent = sdk.VerifiablePresentationV1.fromJSON(answer);
    publicData = await sdk.VerifiablePresentationV1.getPublicData(sent, reader, Network);
    globalContext = await node.getCryptographicParameters();
  } catch (e) {
    if (isNotFound(e)) return refused([{ reason: 'not-on-chain', message: 'The account the answer names is not on the chain.' }]);
    if (e?.name === 'RpcError' || e?.code) throw new ProofError(`The node could not be asked: ${e.message}`, { reason: 'node', detail: e.message });
    return refused([{ reason: 'credential-mismatch', message: `The chain does not match the answer: ${e?.message ?? e}` }]);
  }
  publicData.forEach(({ status, inputs }, n) => {
    if (status !== sdk.CIS4.CredentialStatus.Active) {
      reasons.push({ reason: 'not-active', message: `The identity behind part ${n + 1} of the answer is ${STATUS_WORDS[status] ?? 'not active'}.` });
    }
    // An account's provider is read from the chain: the answer could claim another one.
    if (inputs.type === 'account' && (inputs.issuer !== parts[n].issuer || !question.claims[n].providers.includes(inputs.issuer))) {
      reasons.push({ reason: 'provider-not-accepted', message: `The account behind part ${n + 1} has an identity from provider ${inputs.issuer}, which the question does not accept.` });
    }
  });
  if (reasons.length) return refused(reasons);

  // 4. Does the maths hold? (Concordium's own verifier.)
  try {
    sdk.VerifiablePresentationV1.verify(sent, globalContext, publicData.map((d) => d.inputs));
  } catch (e) {
    return refused([{ reason: 'proof-invalid', message: `The proof does not hold: ${e?.message ?? e}` }]);
  }

  // Accepted: who answered (provider, and the account if from one), the details shown, and the audit record.
  const credentials = answer.verifiableCredential.map((vc, n) => {
    const revealed = Object.fromEntries(vc.credentialSubject.statement.filter((s) => s.type === 'AttributeValue')
      .map((s) => [s.attributeTag, String(s.attributeValue)]));
    const account = parts[n].from === 'account' ? accounts.get(vc.credentialSubject.id.split(':cred:')[1]) : undefined;
    return { from: parts[n].from, issuer: parts[n].issuer, ...(account ? { account } : {}), revealed };
  });
  return {
    ok: true,
    reasons: [],
    revealed: Object.assign({}, ...credentials.map((c) => c.revealed)),
    credentials,
    auditRecord: JSON.parse(JSON.stringify(sdk.VerificationAuditRecordV1.create(recordId, question.request, sent))),
  };
}
