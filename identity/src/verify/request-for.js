/**
 * The website's side of a proof (scope part E): build the question to send to a wallet. Part of the
 * `@concordium/wdk-identity-concordium/verify` entry point, meant for servers (Node.js): the website makes the
 * request on its server, keeps it (to check the answer against later), and sends it to the wallet.
 *
 * Built with Concordium's own Web3StatementBuilder, so the request is exactly what Concordium's wallets and apps
 * use (version 0, account-based), and what WalletConnect's `request_verifiable_presentation` carries.
 */
import { randomBytes } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ProofError } from '../shared/errors.js';
import { readProofRequest, ATTRIBUTE_NAMES } from '../proofs/proof-request.js';

const invalid = (message) => new ProofError(message, { reason: 'invalid-request' });

/** Today (or a given day) as YYYYMMDD, the date format attributes use. */
function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function countries(list, option) {
  if (!Array.isArray(list) || list.length === 0 || !list.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c))) {
    throw invalid(`${option} must be a list of two-letter country codes, e.g. ['GB', 'DE'].`);
  }
  return list;
}

/**
 * Build a proof request: a fresh random challenge plus the statements, ready to send to a wallet.
 *
 * Keep the returned request on your server: checkPresentation compares the wallet's answer with it, and the
 * challenge makes each answer usable once (remember which challenges were answered, and refuse a second answer).
 *
 * @param {object} options
 * @param {number[]} options.providers  the identity providers whose identities you accept (their numbers on the
 *   network); required: choosing whom to trust is the website's decision
 * @param {boolean} [options.adult]  prove at least 18 years old (same as minAge: 18)
 * @param {number} [options.minAge]  prove at least this many years old
 * @param {string[]} [options.residentIn]  prove the country of residence is one of these (two-letter codes)
 * @param {string[]} [options.notResidentIn]  prove the country of residence is none of these
 * @param {string[]} [options.nationalityIn]  prove the nationality is one of these
 * @param {string[]} [options.nationalityNotIn]  prove the nationality is none of these
 * @param {boolean | Date} [options.documentValid]  prove the ID document is still valid today (true) or on a date
 * @param {string[]} [options.reveal]  attributes to be shown, e.g. ['firstName', 'lastName', 'nationality']
 * @returns {{ challenge: string, credentialStatements: object[] }}
 * @throws {ProofError} reason 'invalid-request' (e.g. no providers, or an attribute used twice) or 'unknown-attribute'
 */
export function requestFor({
  providers, adult, minAge, residentIn, notResidentIn, nationalityIn, nationalityNotIn, documentValid, reveal = [],
} = {}) {
  if (!Array.isArray(providers) || providers.length === 0 || !providers.every((p) => Number.isSafeInteger(p) && p >= 0)) {
    throw invalid('providers is required: the numbers of the identity providers whose identities you accept.');
  }
  if (adult && minAge !== undefined) throw invalid('Give adult or minAge, not both.');
  const age = adult ? 18 : minAge;
  if (age !== undefined && (!Number.isSafeInteger(age) || age < 1 || age > 150)) throw invalid('minAge must be a whole number of years.');
  if (!Array.isArray(reveal)) throw invalid('reveal must be a list of attribute names.');

  // Only one statement per attribute is allowed (Concordium's rule): say which option clashes, in plain words.
  const used = new Map();
  const use = (attribute, option) => {
    if (used.has(attribute)) {
      throw invalid(`${attribute} is used twice (by ${used.get(attribute)} and ${option}); ask about it only once.`);
    }
    used.set(attribute, option);
  };
  if (age !== undefined) use('dob', adult ? 'adult' : 'minAge');
  if (residentIn) use('countryOfResidence', 'residentIn');
  if (notResidentIn) use('countryOfResidence', 'notResidentIn');
  if (nationalityIn) use('nationality', 'nationalityIn');
  if (nationalityNotIn) use('nationality', 'nationalityNotIn');
  if (documentValid) use('idDocExpiresAt', 'documentValid');
  for (const name of reveal) {
    if (!ATTRIBUTE_NAMES.includes(name)) {
      throw new ProofError(`reveal names an attribute an identity does not have: ${JSON.stringify(name)}.`,
        { reason: 'unknown-attribute', detail: String(name) });
    }
    use(name, 'reveal');
  }
  if (used.size === 0) throw invalid('The request asks for nothing: give at least one of adult, minAge, residentIn, … or reveal.');

  const credentialStatements = new sdk.Web3StatementBuilder().addForIdentityCredentials([...providers], (b) => {
    if (age !== undefined) b.addMinimumAge(age);
    if (residentIn) b.addMembership('countryOfResidence', countries(residentIn, 'residentIn'));
    if (notResidentIn) b.addNonMembership('countryOfResidence', countries(notResidentIn, 'notResidentIn'));
    if (nationalityIn) b.addMembership('nationality', countries(nationalityIn, 'nationalityIn'));
    if (nationalityNotIn) b.addNonMembership('nationality', countries(nationalityNotIn, 'nationalityNotIn'));
    if (documentValid) b.documentExpiryNoEarlierThan(yyyymmdd(documentValid instanceof Date ? documentValid : new Date()));
    for (const name of reveal) b.revealAttribute(name);
    return b;
  }).getStatements();

  // 32 fresh random bytes: a challenge no one can guess or reuse from another request.
  return readProofRequest({ challenge: randomBytes(32).toString('hex'), credentialStatements });
}
