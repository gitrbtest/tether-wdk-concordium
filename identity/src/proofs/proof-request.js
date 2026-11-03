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

/**
 * Read and check a website's proof request. Accepts the request itself, or WalletConnect's
 * `{ paramsJson }` wrapper. Returns `{ challenge, credentialStatements }`.
 *
 * @throws {ProofError} reason 'invalid-request' (with what is wrong) or 'unknown-attribute'
 */
export function readProofRequest(input) {
  let request = input;
  if (typeof input?.paramsJson === 'string') {
    try {
      request = JSON.parse(input.paramsJson);
    } catch {
      throw invalid('The request\'s paramsJson is not valid JSON.');
    }
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
  const statements = credentialStatement.statement;
  if (!Array.isArray(statements) || statements.length === 0) throw invalid(`${where}.statement must be a non-empty list.`);
  const seen = new Set();
  statements.forEach((s, m) => {
    const at = `${where}.statement[${m}]`;
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
 * and which identity providers' identities the website accepts. Checks the request first (readProofRequest).
 *
 * @param {object} request  `{ challenge, credentialStatements }` or WalletConnect's `{ paramsJson }`
 * @param {{ now?: Date }} [options]  today's date, for "at least N years old" (default: now)
 * @returns {Array<{ providers: number[], asks: Array<{ kind: 'reveal' | 'range' | 'in-set' | 'not-in-set',
 *   attribute: string, text: string }> }>}  one entry per credential statement (usually one)
 * @throws {ProofError} reason 'invalid-request' or 'unknown-attribute'
 */
export function describeProofRequest(request, { now = new Date() } = {}) {
  const { credentialStatements } = readProofRequest(request);
  return credentialStatements.map((cs) => ({
    providers: [...cs.idQualifier.issuers],
    asks: cs.statement.map((s) => describeStatement(s, now)),
  }));
}
