/**
 * A website's proof request, as a wallet receives it (scope part E): read it, check it, and describe it in plain
 * English for the person's consent screen. No network, no secrets: safe to call before asking the person anything.
 *
 * The request is Concordium's own format (version 0, account-based), exactly as it arrives in a WalletConnect
 * `request_verifiable_presentation` call or a browser wallet's `requestVerifiablePresentation`:
 *
 *   { challenge: '<hex chosen by the website>',
 *     credentialStatements: [
 *       { idQualifier: { type: 'cred', issuers: [0, 1] },          ← identities from these providers are accepted
 *         statement: [ { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20081104' },
 *                      { type: 'RevealAttribute', attributeTag: 'nationality' } ] } ] }
 *
 * WalletConnect wraps it as { paramsJson: '<that object as JSON text>' }; both forms are accepted.
 *
 * Version 1 (identity-based) questions are read here too (readProofRequestV1). The website first records the
 * question on chain (the "anchor": a hash of it in a registerData transaction), then sends it as Concordium's
 * VerificationRequestV1, as JSON:
 *
 *   { type: 'ConcordiumVerificationRequestV1',
 *     context: { type: 'ConcordiumUnfilledContextInformationV1',
 *                given: [ { label: 'Nonce', context: '<hex>' }, { label: 'ResourceID', context: 'shop.example' }, … ],
 *                requested: [ 'BlockHash' ] },                     ← filled in by the wallet when it answers
 *     subjectClaims: [
 *       { type: 'identity', source: ['identityCredential'],       ← answer from the identity itself (no account)
 *         issuers: ['did:ccd:testnet:idp:0', 'did:ccd:testnet:idp:1'],
 *         statements: [ { type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20081107' } ] } ],
 *     transactionRef: '<hex>' }                                    ← the anchor transaction
 */
import * as sdk from '@concordium/web-sdk';
import { ProofError } from '../shared/errors.js';

/** The attribute names an identity can hold, e.g. 'firstName', 'dob', 'countryOfResidence'. */
export const ATTRIBUTE_NAMES = Object.keys(sdk.AttributesKeys).filter((name) => Number.isNaN(Number(name)));

/** Plain-English names for the attributes, as a consent screen would show them. */
const LABELS = {
  firstName: 'first name',
  lastName: 'last name',
  sex: 'sex',
  dob: 'date of birth',
  countryOfResidence: 'country of residence',
  nationality: 'nationality',
  idDocType: 'ID document type',
  idDocNo: 'ID document number',
  idDocIssuer: 'ID document issuer',
  idDocIssuedAt: 'ID document issue date',
  idDocExpiresAt: 'ID document expiry date',
  nationalIdNo: 'national ID number',
  taxIdNo: 'tax ID number',
  lei: 'legal entity identifier (LEI)',
  legalName: 'legal name',
  legalCountry: 'country of registration',
  businessNumber: 'business number',
  registrationAuth: 'registration authority',
};
export const attributeLabel = (name) => LABELS[name] ?? name;

const STATEMENT_TYPES = ['RevealAttribute', 'AttributeInRange', 'AttributeInSet', 'AttributeNotInSet'];
const DATE_ATTRIBUTES = new Set(['dob', 'idDocIssuedAt', 'idDocExpiresAt']);
const invalid = (message) => new ProofError(message, { reason: 'invalid-request' });

/** Unwrap WalletConnect's { paramsJson } and turn SDK objects (VerificationRequestV1) or JSON text into plain JSON. */
function plainRequest(input) {
  if (typeof input === 'string' || typeof input?.paramsJson === 'string') {
    try {
      return JSON.parse(typeof input === 'string' ? input : input.paramsJson);
    } catch {
      throw invalid(typeof input === 'string' ? 'The request is not valid JSON.' : 'The request\'s paramsJson is not valid JSON.');
    }
  }
  if (typeof input?.toJSON === 'function') return JSON.parse(JSON.stringify(input));
  return input;
}

/** Whether a request is a version 1 question (Concordium's VerificationRequestV1, as JSON or as the SDK's object). */
export function isProofRequestV1(input) {
  try {
    return plainRequest(input)?.type === 'ConcordiumVerificationRequestV1';
  } catch {
    return false;
  }
}

/**
 * Read and check a website's proof request. Accepts the request itself, or WalletConnect's
 * `{ paramsJson }` wrapper. Returns `{ challenge, credentialStatements }`.
 *
 * @throws {ProofError} reason 'invalid-request' (with what is wrong) or 'unknown-attribute'
 */
export function readProofRequest(input) {
  const request = plainRequest(input);
  if (request?.type === 'ConcordiumVerificationRequestV1') {
    throw invalid('This is a version 1 question (identity-based, anchored on chain): it is not answered from an '
      + 'account with a challenge (version 0).');
  }
  const { challenge, credentialStatements } = request ?? {};
  if (typeof challenge !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(challenge)) {
    throw invalid('The request needs a challenge: hex text chosen by the website (e.g. 32 random bytes).');
  }
  if (!Array.isArray(credentialStatements) || credentialStatements.length === 0) {
    throw invalid('The request asks for nothing: credentialStatements must be a non-empty list.');
  }
  credentialStatements.forEach(checkCredentialStatement);
  return { challenge, credentialStatements };
}

function checkCredentialStatement(credentialStatement, n) {
  const where = `credentialStatements[${n}]`;
  const qualifier = credentialStatement?.idQualifier;
  if (qualifier?.type === 'sci') {
    throw invalid(`${where} asks about a Web3 ID credential issued by a smart contract; this package proves facts `
      + 'about Concordium identities only.');
  }
  if (qualifier?.type !== 'cred' || !Array.isArray(qualifier.issuers) || qualifier.issuers.length === 0
    || !qualifier.issuers.every((i) => Number.isSafeInteger(i) && i >= 0)) {
    throw invalid(`${where}.idQualifier must be { type: 'cred', issuers: [provider numbers] }.`);
  }
  checkStatements(credentialStatement.statement, `${where}.statement`);
}

/** The statements of one group (the same kinds in both versions): known type and attribute, each attribute once. */
function checkStatements(statements, where) {
  if (!Array.isArray(statements) || statements.length === 0) throw invalid(`${where} must be a non-empty list.`);
  const seen = new Set();
  statements.forEach((s, m) => {
    const at = `${where}[${m}]`;
    if (!STATEMENT_TYPES.includes(s?.type)) throw invalid(`${at} has an unknown type: ${JSON.stringify(s?.type)}.`);
    if (!ATTRIBUTE_NAMES.includes(s.attributeTag)) {
      throw new ProofError(`${at} names an attribute an identity does not have: ${JSON.stringify(s.attributeTag)}.`,
        { reason: 'unknown-attribute', detail: String(s.attributeTag) });
    }
    if (seen.has(s.attributeTag)) {
      throw invalid(`${at}: ${s.attributeTag} is asked about twice; only one statement per attribute is allowed.`);
    }
    seen.add(s.attributeTag);
    if (s.type === 'AttributeInRange' && (typeof s.lower !== 'string' || typeof s.upper !== 'string' || !(s.lower < s.upper))) {
      throw invalid(`${at}: a range needs a lower and an upper value, lower first.`);
    }
    if ((s.type === 'AttributeInSet' || s.type === 'AttributeNotInSet') && (!Array.isArray(s.set) || s.set.length === 0)) {
      throw invalid(`${at}: a set statement needs a non-empty set.`);
    }
  });
}

// ---- Version 1 -------------------------------------------------------------------------------------------------

/** The context labels Concordium defines: given by the website, or requested from the wallet. */
const CONTEXT_LABELS = ['Nonce', 'ConnectionID', 'ResourceID', 'ContextString', 'BlockHash', 'PaymentHash'];
/** Where an answer may come from: the identity itself, or an account made from it. */
const SOURCES = { identityCredential: 'identity', accountCredential: 'account' };

/**
 * Read and check a website's version 1 question (identity-based, anchored on chain). Accepts its JSON (as an object
 * or as text), the SDK's VerificationRequestV1 object, or WalletConnect's `{ paramsJson }` wrapper. No network: the
 * anchor itself is checked when answering.
 *
 * @returns {{ version: 1, network: 'Testnet' | 'Mainnet', request: object, given: Record<string, string>,
 *   requested: string[], claims: Array<{ providers: number[], source: string[], statements: object[] }>,
 *   anchor: string }}  `request`: the SDK's VerificationRequestV1, ready for answering; `given`: the context the
 *   website gave, by label; `requested`: what the wallet fills in; `anchor`: the anchor transaction's hash
 * @throws {ProofError} reason 'invalid-request' (with what is wrong) or 'unknown-attribute'
 */
export function readProofRequestV1(input) {
  const request = plainRequest(input);
  if (request?.type !== 'ConcordiumVerificationRequestV1') {
    throw invalid('Not a version 1 question: its type must be \'ConcordiumVerificationRequestV1\'.');
  }
  const { context, subjectClaims, transactionRef } = request;
  if (context?.type !== 'ConcordiumUnfilledContextInformationV1' || !Array.isArray(context.given) || !Array.isArray(context.requested)) {
    throw invalid('The question\'s context must be { type: \'ConcordiumUnfilledContextInformationV1\', given: [...], requested: [...] }.');
  }
  const given = {};
  context.given.forEach((g, n) => {
    if (!CONTEXT_LABELS.includes(g?.label) || typeof g.context !== 'string') {
      throw invalid(`context.given[${n}] must be { label, context } with a known label (${CONTEXT_LABELS.join(', ')}) and text.`);
    }
    if (g.label in given) throw invalid(`context.given: ${g.label} is given twice.`);
    given[g.label] = g.context;
  });
  context.requested.forEach((label, n) => {
    if (!CONTEXT_LABELS.includes(label)) throw invalid(`context.requested[${n}] is not a known label: ${JSON.stringify(label)}.`);
    if (label in given) throw invalid(`context: ${label} is both given and requested.`);
  });
  if (typeof transactionRef !== 'string' || !/^[0-9a-fA-F]{64}$/.test(transactionRef)) {
    throw invalid('The question needs its anchor: transactionRef must be the anchor transaction\'s hash (64 hex characters).');
  }
  if (!Array.isArray(subjectClaims) || subjectClaims.length === 0) {
    throw invalid('The question asks for nothing: subjectClaims must be a non-empty list.');
  }
  const networks = new Set();
  const claims = subjectClaims.map((claim, n) => {
    const where = `subjectClaims[${n}]`;
    if (claim?.type !== 'identity') throw invalid(`${where} has an unknown type: ${JSON.stringify(claim?.type)}; only 'identity' is known.`);
    const { source, issuers } = claim;
    if (!Array.isArray(source) || source.length === 0 || !source.every((x) => x in SOURCES) || new Set(source).size !== source.length) {
      throw invalid(`${where}.source must list 'identityCredential' and/or 'accountCredential'.`);
    }
    if (!Array.isArray(issuers) || issuers.length === 0) throw invalid(`${where}.issuers must be a non-empty list of providers.`);
    const providers = issuers.map((did, m) => {
      try {
        const { network, index } = sdk.IdentityProviderDID.fromJSON(did);
        networks.add(network);
        return index;
      } catch {
        throw invalid(`${where}.issuers[${m}] is not an identity provider: ${JSON.stringify(did)} (expected e.g. 'did:ccd:testnet:idp:0').`);
      }
    });
    checkStatements(claim.statements, `${where}.statements`);
    return { providers, source: [...source], statements: claim.statements };
  });
  if (networks.size !== 1) throw invalid(`The question mixes networks (${[...networks].join(', ')}): its providers must all be on one.`);
  let sdkRequest;
  try {
    sdkRequest = sdk.VerificationRequestV1.fromJSON(request);
  } catch (e) {
    throw invalid(`The question could not be read: ${e.message}`);
  }
  return {
    version: 1, network: [...networks][0], request: sdkRequest, given, requested: [...context.requested], claims,
    anchor: transactionRef.toLowerCase(),
  };
}

/** '20081104' → '4 Nov 2008' (dates in attributes and statements are YYYYMMDD). */
function readableDate(yyyymmdd) {
  const date = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The youngest age someone can be today if born before `upper` (YYYYMMDD; the range excludes `upper` itself):
 * the latest birth date allowed is the day before, so count the full years from that day to today.
 */
function minimumAgeToday(upper, now) {
  const latest = new Date(Date.UTC(Number(upper.slice(0, 4)), Number(upper.slice(4, 6)) - 1, Number(upper.slice(6, 8)) - 1));
  let years = now.getUTCFullYear() - latest.getUTCFullYear();
  const birthdayThisYear = Date.UTC(now.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (birthdayThisYear > today) years--; // not had this year's birthday yet
  return years;
}

/** One statement in plain English. Range proofs prove lower ≤ value < upper. */
function describeStatement(s, now) {
  const label = attributeLabel(s.attributeTag);
  if (s.type === 'RevealAttribute') {
    return { kind: 'reveal', attribute: s.attributeTag, text: `show your ${label}` };
  }
  if (s.type === 'AttributeInSet') {
    return { kind: 'in-set', attribute: s.attributeTag, text: `prove your ${label} is one of: ${s.set.join(', ')} (without showing which)` };
  }
  if (s.type === 'AttributeNotInSet') {
    return { kind: 'not-in-set', attribute: s.attributeTag, text: `prove your ${label} is none of: ${s.set.join(', ')} (without showing it)` };
  }
  // AttributeInRange
  if (s.attributeTag === 'dob' && s.lower === sdk.MIN_DATE) {
    const years = minimumAgeToday(s.upper, now);
    return { kind: 'range', attribute: 'dob', text: `prove you were born before ${readableDate(s.upper)} (at least ${years} years old), without showing your date of birth` };
  }
  if (s.attributeTag === 'idDocExpiresAt' && /^9999/.test(s.upper)) {
    return { kind: 'range', attribute: s.attributeTag, text: `prove your ID document is still valid on ${readableDate(s.lower)}, without showing its dates` };
  }
  if (DATE_ATTRIBUTES.has(s.attributeTag)) {
    return { kind: 'range', attribute: s.attributeTag, text: `prove your ${label} is from ${readableDate(s.lower)} up to (not including) ${readableDate(s.upper)}, without showing it` };
  }
  return { kind: 'range', attribute: s.attributeTag, text: `prove your ${label} is from ${s.lower} up to (not including) ${s.upper}, without showing it` };
}

/**
 * Describe a website's request in plain English, for the person's consent screen: what will be proven or shown,
 * and which identity providers' identities the website accepts. Checks the request first (readProofRequest, or
 * readProofRequestV1 for a version 1 question).
 *
 * A version 1 question's parts also say which network they are about, and where the answer may come from
 * (`answerFrom`: 'identity', 'account' or 'identity or account'). describeProofContext tells who is asking.
 *
 * @param {object} request  `{ challenge, credentialStatements }`, WalletConnect's `{ paramsJson }`, or a version 1
 *   question (Concordium's VerificationRequestV1, as JSON or the SDK's object)
 * @param {{ now?: Date }} [options]  today's date, for "at least N years old" (default: now)
 * @returns {Array<{ providers: number[], network?: 'testnet' | 'mainnet', answerFrom?: string,
 *   asks: Array<{ kind: 'reveal' | 'range' | 'in-set' | 'not-in-set', attribute: string, text: string }> }>}
 *   one entry per group of questions (usually one); `network` and `answerFrom` for version 1 only
 * @throws {ProofError} reason 'invalid-request' or 'unknown-attribute'
 */
export function describeProofRequest(request, { now = new Date() } = {}) {
  if (isProofRequestV1(request)) {
    const { network, claims } = readProofRequestV1(request);
    return claims.map((claim) => ({
      providers: claim.providers,
      network: network.toLowerCase(),
      answerFrom: ['identity', 'account'].filter((x) => claim.source.some((y) => SOURCES[y] === x)).join(' or '),
      asks: claim.statements.map((s) => describeStatement(s, now)),
    }));
  }
  const { credentialStatements } = readProofRequest(request);
  return credentialStatements.map((cs) => ({
    providers: [...cs.idQualifier.issuers],
    asks: cs.statement.map((s) => describeStatement(s, now)),
  }));
}

/**
 * Who is asking a version 1 question, for the consent screen: what the website wrote into the question. It is
 * recorded on chain with the anchor, so it cannot be changed afterwards, but the website chose it: compare `website`
 * with the site the wallet is actually connected to before showing it as fact.
 *
 * @param {object} request  a version 1 question (as describeProofRequest takes it)
 * @returns {{ network: 'testnet' | 'mainnet', website?: string, purpose?: string, connection?: string,
 *   anchor: string }}  `website`: its ResourceID; `purpose`: its ContextString; `connection`: its ConnectionID;
 *   `anchor`: the anchor transaction's hash (e.g. to show it on a block explorer)
 * @throws {ProofError} reason 'invalid-request' (also for a version 0 request, which carries none of this)
 */
export function describeProofContext(request) {
  if (!isProofRequestV1(request)) {
    throw invalid('Only a version 1 question says who is asking; a version 0 request has a challenge only.');
  }
  const { network, given, anchor } = readProofRequestV1(request);
  return {
    network: network.toLowerCase(),
    ...(given.ResourceID !== undefined ? { website: given.ResourceID } : {}),
    ...(given.ContextString !== undefined ? { purpose: given.ContextString } : {}),
    ...(given.ConnectionID !== undefined ? { connection: given.ConnectionID } : {}),
    anchor,
  };
}
