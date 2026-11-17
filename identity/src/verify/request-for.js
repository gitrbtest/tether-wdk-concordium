/**
 * The website's side of a proof, first half: build the question and record it on chain.
 * Part of the `@concordium/wdk-identity-concordium/verify` entry point (servers, Node.js).
 *
 *   requestFor ─► what to ask, and where the answer may come from (the identity itself, an account made from it,
 *                 or either) ─► the context (a fresh random nonce, the website, the purpose) ─► Concordium's
 *                 claims builder ─► the anchor: a hash of the question, sent on chain in a registerData transaction
 *                 (fee paid by the website, or by a sponsor) ─► wait until it is final (asking for its status, if the node's
 *                 wait drops out) ─► the question, ready to send
 *                 to the wallet (and to keep, to check the answer)
 *
 * Built from Concordium's own pieces (VerificationRequestV1, Transaction), so the question is exactly what
 * Concordium's wallets read. The anchor costs a small fee (about EUR 0.013); with `sponsor`, another account pays
 * it, so the website's own account can hold no CCD at all.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import { ProofError } from '../shared/errors.js';
import { readProofRequest, ATTRIBUTE_NAMES } from '../proofs/proof-request.js';

const invalid = (message) => new ProofError(message, { reason: 'invalid-request' });
/** The node's answers that mean "refused" (it will not take this transaction), not "could not be asked". */
const REFUSED = new Set(['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'ALREADY_EXISTS', 3, 9, 6]);
/** Where the answer may come from, as the option says it, and the builder method that asks for it. */
const ANSWER_FROM = { identity: 'addIdentityClaims', account: 'addAccountClaims', either: 'addAccountOrIdentityClaims' };
const NODE_METHODS = ['getNextAccountNonce', 'sendTransaction', 'waitForTransactionFinalization'];

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
 * Build a question and record it on chain (its anchor), waiting until the anchor is final. Returns the
 * question as Concordium's VerificationRequestV1 JSON: send it to the wallet, and keep it on your server
 * (checkPresentation compares the answer with it).
 *
 * @param {object} options  what to ask, and who asks:
 * @param {number[]} options.providers  the identity providers whose identities you accept (their numbers on the
 *   network); required: choosing whom to trust is the website's decision
 * @param {boolean} [options.adult]  prove at least 18 years old (same as minAge: 18)
 * @param {number} [options.minAge]  prove at least this many years old
 * @param {string[]} [options.residentIn]  prove the country of residence is one of these (two-letter codes)
 * @param {string[]} [options.notResidentIn]  prove the country of residence is none of these
 * @param {string[]} [options.nationalityIn]  prove the nationality is one of these
 * @param {string[]} [options.nationalityNotIn]  prove the nationality is none of these
 * @param {boolean | Date} [options.documentValid]  prove the ID document is still valid today (true) or on a date
 * @param {string[]} [options.registeredIn]  for a company (Business ID): prove its country of registration is one of
 *   these (two-letter codes), without showing it
 * @param {string[]} [options.notRegisteredIn]  for a company: prove its country of registration is none of these
 * @param {string[]} [options.reveal]  attributes to be shown, e.g. ['firstName', 'lastName', 'nationality'], or for a
 *   company ['lei', 'legalName', 'legalCountry', 'businessNumber', 'registrationAuth']
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
 * @param {number} [anchoring.timeoutMs=120000]  how long to wait for the anchor to be final (if the node's wait
 *   drops out, e.g. an HTTP 502, requestFor asks for the anchor's status instead, within the same time)
 * @returns {Promise<object>}  the question (VerificationRequestV1 JSON)
 * @throws {ProofError} reason 'invalid-request' or 'unknown-attribute' (nothing sent); 'anchor-failed' (the node
 *   refused the anchor, or it was rejected on chain, e.g. not enough CCD for the fee: `detail` says); 'node' (the
 *   node could not be asked, or the anchor was not final in time)
 */
export async function requestFor(options = {}, { node, sender, signer, sponsor, timeoutMs = 120_000 } = {}) {
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
    throw new Error("requestFor needs a node connection to record the question: { node: connectToNode('testnet'), sender, signer }.");
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
    outcome = await waitUntilFinal(node, hash, timeoutMs);
  } catch (e) {
    throw new ProofError(`The anchor (${sdk.TransactionHash.toHexString(hash)}) was not seen final: ${e?.message ?? e}. It may still `
      + 'become final; the question cannot be answered until it does.', { reason: 'node', detail: e?.message ?? String(e) });
  }
  const summary = outcome?.summary;
  if (summary?.type !== 'accountTransaction' || summary.transactionType !== 'registerData') {
    const why = summary?.rejectReason?.tag ?? summary?.transactionType ?? 'unknown';
    throw new ProofError(`The anchor was rejected on chain (${why}).`, { reason: 'anchor-failed', detail: String(why) });
  }
  return readProofRequest(sdk.VerificationRequestV1.create(context, claims, hash)).request.toJSON();
}

/** How often to ask the node for the anchor's status, when its wait has dropped out. */
const STATUS_EVERY_MS = 2_000;

/**
 * Wait until the anchor is final, within timeoutMs. The node's wait follows the chain's new blocks; that can drop out
 * (e.g. an HTTP 502 from a proxy in front of the node) while the anchor still becomes final. Then ask the node for
 * the anchor's status every few seconds instead, until it is final or the time is up.
 * @returns {Promise<object>} the anchor's outcome ({ blockHash, summary })
 * @throws the node's error (or 'not final in time'), when the anchor was not seen final within timeoutMs
 */
async function waitUntilFinal(node, hash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let error;
  try {
    return await node.waitForTransactionFinalization(hash, timeoutMs);
  } catch (e) {
    error = e;
  }
  if (typeof node.getBlockItemStatus !== 'function') throw error;
  for (;;) {
    try {
      const status = await node.getBlockItemStatus(hash);
      if (status?.status === 'finalized') return status.outcome;
    } catch (e) {
      error = e;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw error ?? new Error('not final in time');
    await new Promise((resolve) => setTimeout(resolve, Math.min(STATUS_EVERY_MS, left)));
  }
}

/** The options a question can ask (see requestFor). */
const ASK_OPTIONS = ['providers', 'adult', 'minAge', 'residentIn', 'notResidentIn', 'nationalityIn', 'nationalityNotIn',
  'documentValid', 'registeredIn', 'notRegisteredIn', 'reveal'];

/**
 * Check what a website wants to ask (requestFor's options) and turn it into Concordium's statements: returns the
 * accepted providers and `ask`, which adds the statements to Concordium's claims builder.
 * @throws {ProofError} reason 'invalid-request' or 'unknown-attribute'
 */
function readAsks({
  providers, adult, minAge, residentIn, notResidentIn, nationalityIn, nationalityNotIn, documentValid,
  registeredIn, notRegisteredIn, reveal = [],
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
  if (registeredIn) use('legalCountry', 'registeredIn');
  if (notRegisteredIn) use('legalCountry', 'notRegisteredIn');
  for (const name of reveal) {
    if (!ATTRIBUTE_NAMES.includes(name)) {
      throw new ProofError(`reveal names an attribute an identity does not have: ${JSON.stringify(name)}.`,
        { reason: 'unknown-attribute', detail: String(name) });
    }
    use(name, 'reveal');
  }
  if (used.size === 0) throw invalid('The request asks for nothing: give at least one of adult, minAge, residentIn, … or reveal.');
  if (residentIn) countries(residentIn, 'residentIn');
  if (notResidentIn) countries(notResidentIn, 'notResidentIn');
  if (nationalityIn) countries(nationalityIn, 'nationalityIn');
  if (nationalityNotIn) countries(nationalityNotIn, 'nationalityNotIn');
  if (registeredIn) countries(registeredIn, 'registeredIn');
  if (notRegisteredIn) countries(notRegisteredIn, 'notRegisteredIn');

  const ask = (b) => {
    if (age !== undefined) b.addMinimumAge(age);
    if (residentIn) b.addMembership('countryOfResidence', countries(residentIn, 'residentIn'));
    if (notResidentIn) b.addNonMembership('countryOfResidence', countries(notResidentIn, 'notResidentIn'));
    if (nationalityIn) b.addMembership('nationality', countries(nationalityIn, 'nationalityIn'));
    if (nationalityNotIn) b.addNonMembership('nationality', countries(nationalityNotIn, 'nationalityNotIn'));
    if (documentValid) b.documentExpiryNoEarlierThan(yyyymmdd(documentValid instanceof Date ? documentValid : new Date()));
    if (registeredIn) b.addMembership('legalCountry', countries(registeredIn, 'registeredIn'));
    if (notRegisteredIn) b.addNonMembership('legalCountry', countries(notRegisteredIn, 'notRegisteredIn'));
    for (const name of reveal) b.revealAttribute(name);
    return b;
  };
  return { providers: [...providers], ask };
}
