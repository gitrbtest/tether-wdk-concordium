/**
 * The website's side of a proof, second half (scope part E, version 0: account-based): check the answer a wallet sent.
 *
 *   checkPresentation ─► read the answer ─► is it the answer to OUR question? (same challenge, same questions,
 *                        an accepted provider, the right network) ─► read the account's sealed details and status
 *                        from the chain (a Concordium node) ─► still Active? ─► does the maths hold? ─► the result
 *
 * The picture: the wallet's answer points at a record on the chain (its DID). The record holds the person's details,
 * sealed ("commitments"), and the dates the identity is valid for. The maths proves something about what is inside
 * the seals, without opening them. Anything the website asked to see ("reveal") is in the answer itself.
 *
 * Part of the `@concordium/wdk-identity-concordium/verify` entry point (servers, Node.js).
 */
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { ProofError } from '../shared/errors.js';
import { readProofRequest } from '../proofs/proof-request.js';

/** Concordium's public nodes, by network name. */
const PUBLIC_NODES = {
  testnet: 'https://grpc.testnet.concordium.com:20000',
  mainnet: 'https://grpc.mainnet.concordium.software:20000',
};

/**
 * A connection to a Concordium node, for checkPresentation. Give 'testnet' or 'mainnet' for Concordium's public node,
 * or the address of your own node, e.g. 'https://my-node.example.com:20000' ('http://…' for a node without TLS).
 *
 * @param {'testnet' | 'mainnet' | string} where
 * @returns {object} the node connection (Concordium's ConcordiumGRPCNodeClient)
 */
export function connectToNode(where) {
  const address = PUBLIC_NODES[String(where).toLowerCase()] ?? where;
  let url;
  try {
    url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new Error("connectToNode needs 'testnet', 'mainnet', or a node address like 'https://my-node.example.com:20000'.");
  }
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  return new ConcordiumGRPCNodeClient(url.hostname, port, secure ? credentials.createSsl() : credentials.createInsecure());
}

const STATUS_WORDS = {
  [sdk.CIS4.CredentialStatus.Revoked]: 'revoked',
  [sdk.CIS4.CredentialStatus.Expired]: 'expired',
  [sdk.CIS4.CredentialStatus.NotActivated]: 'not active yet',
};

/**
 * The same questions, compared by meaning: whatever order their keys are in, and whatever order the countries (or
 * other values) of a "one of" / "none of" list are in. Concordium's proof writes such a list back sorted (asked
 * ['US', 'KP'], answered ['KP', 'US']): the same list, so it must not count as a different question.
 */
export function sameStatements(asked, answered) {
  const plain = (v) => (Array.isArray(v) ? v.map(plain)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k,
      k === 'set' && Array.isArray(v[k]) ? [...v[k]].map(String).sort() : plain(v[k])])) : v);
  return JSON.stringify(plain(asked)) === JSON.stringify(plain(answered));
}

/** The same challenge: it is a hex number, so capital and small letters mean the same ('BB' = 'bb'). */
const sameChallenge = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** The answer as Concordium's VerifiablePresentation, from any of the forms a website may receive it in; or null. */
function readAnswer(presentation) {
  try {
    let text = presentation;
    if (typeof presentation?.verifiablePresentationJson === 'string') text = presentation.verifiablePresentationJson; // WalletConnect
    else if (typeof presentation !== 'string') text = JSON.stringify(presentation); // the object itself
    const answer = sdk.VerifiablePresentation.fromString(text);
    return Array.isArray(answer?.verifiableCredential) ? answer : null;
  } catch {
    return null;
  }
}

/**
 * Check a wallet's answer (a verifiable presentation) to a proof request made with requestFor.
 *
 * Refuses an answer that is not for this request (another challenge, other questions), from a provider the request
 * does not accept, for another network, whose account is not on chain, whose identity is no longer Active (expired,
 * revoked, or not yet valid: such a proof can still add up mathematically, so this matters), or whose maths does not
 * hold. A refused answer is a normal outcome: it returns `ok: false` with the reasons, it does not throw.
 *
 * Not done here (the website's job): accept each challenge's answer only once. Remember the challenges answered and
 * refuse a second answer to the same one; otherwise a copied answer could be replayed.
 *
 * @param {object | string} presentation  the wallet's answer: the presentation object, its JSON text, or WalletConnect's
 *   `{ verifiablePresentationJson }`
 * @param {object} request  the request this answer is for, as requestFor returned it (kept on the server)
 * @param {{ node: object, network: 'testnet' | 'mainnet' }} options  a node connection (connectToNode) and the network
 *   the website works on
 * @returns {Promise<{ ok: boolean, reasons: Array<{ reason: string, message: string }>, account?: string,
 *   revealed: Record<string, string>, credentials: Array<{ account: string, issuer: number, revealed: Record<string, string> }> }>}
 *   `account`: the account that answered (the first, if several); `revealed`: the details the request asked to see
 * @throws {ProofError} reason 'invalid-request' if the request itself is broken; 'node' if the node could not be asked
 */
export async function checkPresentation(presentation, request, { node, network } = {}) {
  const { challenge, credentialStatements } = readProofRequest(request);
  if (!node || typeof node.getAccountInfo !== 'function') {
    throw new Error("checkPresentation needs a node connection: { node: connectToNode('testnet') }.");
  }
  const net = String(network).toLowerCase();
  if (net !== 'testnet' && net !== 'mainnet') throw new Error("checkPresentation needs the network: 'testnet' or 'mainnet'.");

  const refused = (reasons) => ({ ok: false, reasons, revealed: {}, credentials: [] });
  const answer = readAnswer(presentation);
  if (!answer) return refused([{ reason: 'unreadable', message: 'The answer is not a verifiable presentation.' }]);

  // 1. Is it the answer to OUR question? All checked from the answer itself, before asking the chain anything.
  const reasons = [];
  if (!sameChallenge(answer.presentationContext, challenge)) {
    reasons.push({ reason: 'challenge-mismatch', message: 'The answer is for another request (its challenge differs).' });
  }
  if (answer.verifiableCredential.length !== credentialStatements.length) {
    reasons.push({ reason: 'statements-mismatch', message: 'The answer does not answer the questions asked (a different number of parts).' });
  }
  answer.verifiableCredential.forEach((vc, n) => {
    const asked = credentialStatements[n];
    const id = String(vc?.credentialSubject?.id ?? '');
    const accountDid = id.match(/^did:ccd:([a-z]+):cred:([0-9a-f]+)$/i);
    const issuer = String(vc?.issuer ?? '').match(/^did:ccd:([a-z]+):idp:(\d+)$/i);
    if (!accountDid || !issuer) {
      reasons.push({ reason: 'not-an-identity', message: `Part ${n + 1} of the answer is not about a Concordium identity's account.` });
      return;
    }
    if (accountDid[1].toLowerCase() !== net) {
      reasons.push({ reason: 'wrong-network', message: `The answer is from ${accountDid[1]}, not ${net}.` });
    }
    if (asked && !asked.idQualifier.issuers.includes(Number(issuer[2]))) {
      reasons.push({ reason: 'provider-not-accepted', message: `The identity is from provider ${issuer[2]}, which the request does not accept.` });
    }
    // Without this, a wallet could answer an easier question ("over 5" for "over 18") and the maths would still hold.
    if (asked && !sameStatements(asked.statement, vc.credentialSubject.statement)) {
      reasons.push({ reason: 'statements-mismatch', message: `Part ${n + 1} of the answer proves something other than what was asked.` });
    }
  });
  if (reasons.length) return refused(reasons);

  // 2. Read each account's record from the chain: its sealed details, and whether its identity is still valid.
  // Concordium's getPublicData does the reading (and checks the record's provider matches the answer); we note each
  // account address on the way, to tell the website which account answered.
  const accountOf = new Map();
  const reader = {
    getAccountInfo: async (credId, block) => {
      const info = await node.getAccountInfo(credId, block);
      accountOf.set(credId.credId, info.accountAddress.address);
      return info;
    },
    getBlockInfo: (block) => node.getBlockInfo(block),
  };
  let publicData;
  let globalContext;
  try {
    publicData = await sdk.getPublicData(reader, net === 'testnet' ? 'Testnet' : 'Mainnet', answer);
    globalContext = await node.getCryptographicParameters();
  } catch (e) {
    if (e?.code === 'NOT_FOUND' || /could not find credential/i.test(e?.message)) {
      return refused([{ reason: 'not-on-chain', message: 'The account the answer names is not on the chain.' }]);
    }
    if (e?.name === 'RpcError' || e?.code) {
      throw new ProofError(`The node could not be asked: ${e.message}`, { reason: 'node', detail: e.message });
    }
    return refused([{ reason: 'credential-mismatch', message: `The account on the chain does not match the answer: ${e.message}` }]);
  }

  // 3. Still valid? Only Active is accepted.
  publicData.forEach(({ status }, n) => {
    if (status !== sdk.CIS4.CredentialStatus.Active) {
      reasons.push({ reason: 'not-active', message: `The identity behind part ${n + 1} of the answer is ${STATUS_WORDS[status] ?? 'not active'}.` });
    }
  });
  if (reasons.length) return refused(reasons);

  // 4. Does the maths hold, against the sealed details on the chain? (Concordium's own verifier.)
  try {
    sdk.verifyPresentation(answer, globalContext, publicData.map((d) => d.inputs));
  } catch (e) {
    return refused([{ reason: 'proof-invalid', message: `The proof does not hold: ${e?.message ?? e}` }]);
  }

  // Accepted: which account answered, and any details the request asked to see.
  const answered = answer.verifiableCredential.map((vc) => {
    const revealed = {};
    vc.credentialSubject.statement.forEach((s, m) => {
      if (s.type === 'RevealAttribute') revealed[s.attributeTag] = vc.credentialSubject.proof.proofValue[m].attribute;
    });
    const credId = vc.credentialSubject.id.split(':cred:')[1];
    return { account: accountOf.get(credId), issuer: Number(vc.issuer.split(':idp:')[1]), revealed };
  });
  return {
    ok: true,
    reasons: [],
    account: answered[0]?.account,
    revealed: Object.assign({}, ...answered.map((a) => a.revealed)),
    credentials: answered,
  };
}
