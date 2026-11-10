/**
 * Making a proof (scope part E). Internal: ConcordiumIdentity is the public face.
 *
 * Version 0, account-based:
 *   prove ─► check the website's question ─► identity held? ─► its provider accepted? ─► can it TRULY answer?
 *         ─► which account answers (its id, from the seed) ─► the secret ingredients (each detail and the random
 *            number used to seal it when the account was created, from the seed) ─► Concordium's
 *            getVerifiablePresentation ─► the proof
 *
 * Version 1, identity-based (no account):
 *   proveIdentity ─► check the question ─► same network? ─► what the wallet must fill in ─► identity held? ─► not
 *         expired? ─► answers from the identity accepted? ─► its provider accepted? ─► can it TRULY answer?
 *         ─► the secret ingredients (the identity and its secrets, from the seed) ─► node: is the anchor on chain,
 *            final, and really this question? ─► Concordium's VerifiablePresentationV1.create, tied to the anchor's
 *            block ─► the proof
 *
 * The identity never leaves the wallet: only the proof does (plus any detail the question asks to show).
 */
import * as sdk from '@concordium/web-sdk';
import { bytesToHex } from '@noble/hashes/utils';
import { ProofError } from '../shared/errors.js';
import { requireIndex, IDENTITY_INDEX_HINT, MAX_CRED_NUMBER } from '../shared/inputs.js';
import { identityContent, hasExpired } from '../issuance/identity-object.js';
import { readProofRequest, readProofRequestV1, attributeLabel } from './proof-request.js';

/** Context labels a question may ask the wallet to fill in with text it knows (e.g. the site it is connected to). */
const TEXT_CONTEXT = ['ResourceID', 'ContextString', 'ConnectionID'];
const nodeFailed = (e) => new ProofError(`The Concordium node could not be asked: ${e?.message ?? e}`,
  { reason: 'node', detail: e?.message ?? String(e) });

export default class IdentityProofs {
  #node;
  #hdWallet;
  #held;
  #network;
  #findAccounts;
  #providers;

  /**
   * @param {{ node: object, hdWallet: () => object, held: object, network: 'Testnet' | 'Mainnet',
   *   findAccounts: (options: object) => Promise<Array<{ credNumber: number, address: string, path: string }>>,
   *   providers: object }} collaborators  `providers`: the identity provider list (IdentityProviders)
   */
  constructor({ node, hdWallet, held, network, findAccounts, providers }) {
    this.#providers = providers;
    this.#node = node;
    this.#hdWallet = hdWallet;
    this.#held = held;
    this.#network = network;
    this.#findAccounts = findAccounts;
  }

  /** See ConcordiumIdentity.prove. */
  async prove({ providerIndex, identityIndex, credNumber, ...request } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex', IDENTITY_INDEX_HINT);
    requireIndex(credNumber, 'credNumber', 'say which account answers (accountsThatCanAnswer lists the ones that can).', MAX_CRED_NUMBER);
    const { challenge, credentialStatements } = readProofRequest(request);
    const attributeList = this.#attributesOf(providerIndex, identityIndex);
    // An expired identity's proof still adds up mathematically, but Concordium reports its account's credential as
    // "Expired" and a careful website refuses it: say so now, so the person can verify again.
    if (hasExpired({ attributeList })) {
      throw new ProofError(`The identity expired at the end of ${attributeList.validTo.slice(0, 4)}-${attributeList.validTo.slice(4)}: `
        + 'verify again for a new identity before answering.', { reason: 'identity-expired' });
    }
    this.#checkCanAnswer(credentialStatements, providerIndex, attributeList.chosenAttributes);

    // Which account answers: its credential id (worked out from the seed) names it, as a "DID".
    const globalContext = await this.#node.globalContext();
    const hdWallet = this.#hdWallet();
    const credId = bytesToHex(hdWallet.getCredentialId(providerIndex, identityIndex, credNumber, globalContext));
    const did = sdk.createAccountDID(this.#network, credId);

    // The secret ingredients, per question group: the details asked about, and the random numbers that sealed them
    // when the account was created (worked out from the seed again; Concordium's SDK helper does this). They are
    // handed to the SDK as text, which JavaScript cannot wipe: they live only as long as this call.
    const commitmentInputs = credentialStatements.map((cs) => sdk.createAccountCommitmentInputWithHdWallet(
      cs.statement, providerIndex, attributeList, hdWallet, identityIndex, credNumber));
    return sdk.getVerifiablePresentation({
      request: { challenge, credentialStatements: credentialStatements.map((cs) => ({ id: did, statement: cs.statement })) },
      globalContext,
      commitmentInputs,
    });
  }

  /** See ConcordiumIdentity.accountsThatCanAnswer. */
  async accountsThatCanAnswer({ providerIndex, identityIndex, gap, signal, ...request } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex', IDENTITY_INDEX_HINT);
    const { credentialStatements } = readProofRequest(request);
    const attributeList = this.#attributesOf(providerIndex, identityIndex);
    if (hasExpired({ attributeList })) return []; // an expired identity's accounts cannot answer acceptably
    try {
      this.#checkCanAnswer(credentialStatements, providerIndex, attributeList.chosenAttributes);
    } catch (e) {
      if (e instanceof ProofError && (e.reason === 'provider-not-accepted' || e.reason === 'cannot-prove')) return [];
      throw e;
    }
    // The identity can answer; any of its accounts on chain can carry the answer.
    return this.#findAccounts({ providerIndex, identityIndex, gap, signal });
  }

  /** See ConcordiumIdentity.proveIdentity. */
  async proveIdentity({ providerIndex, identityIndex, request, context = {} } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex', IDENTITY_INDEX_HINT);
    const question = readProofRequestV1(request);
    if (question.network !== this.#network) {
      throw new ProofError(`The question is about ${question.network} identities; this wallet's are on ${this.#network}.`,
        { reason: 'invalid-request' });
    }
    const filledByWallet = this.#contextToFill(question.requested, context);

    const identity = this.#identityOf(providerIndex, identityIndex);
    const { attributeList } = identity;
    if (hasExpired({ attributeList })) {
      throw new ProofError(`The identity expired at the end of ${attributeList.validTo.slice(0, 4)}-${attributeList.validTo.slice(4)}: `
        + 'verify again for a new identity before answering.', { reason: 'identity-expired' });
    }
    question.claims.forEach((claim, n) => {
      if (!claim.source.includes('identityCredential')) {
        throw new ProofError(`Part ${n + 1} of the question accepts answers from an account only, not from the identity `
          + 'itself: ask the website for a question that accepts the identity, or a version 0 question.', { reason: 'account-only' });
      }
    });
    this.#checkCanAnswer(question.claims.map((c) => ({ idQualifier: { issuers: c.providers }, statement: c.statements })),
      providerIndex, attributeList.chosenAttributes);

    // The secret ingredients: the identity, with its secrets worked out from the seed again (Concordium's SDK helper),
    // and the provider's keys. Handed to the SDK as text, which JavaScript cannot wipe: they live only for this call.
    const { ipInfo, arsInfos } = await this.#providers.get(providerIndex);
    const input = sdk.createIdentityCommitmentInputWithHdWallet(identity, { ipInfo, arsInfos }, identityIndex, this.#hdWallet());
    // What is proven, per part: the statements as asked, with any detail to show filled in from the identity.
    const subjectClaims = question.claims.map((claim) => sdk.VerifiablePresentationV1.createIdentityClaims(
      this.#network, providerIndex, sdk.VerifiablePresentationV1.revealRequestedStatements(claim.statements, attributeList.chosenAttributes)));

    // The anchor: the question must be on chain, final, and really this question; the proof is tied to its block.
    let anchor;
    let globalContext;
    try {
      anchor = await this.#node.anchorOf(question.request);
      if (anchor.status === 'finalized') globalContext = await this.#node.globalContext();
    } catch (e) {
      throw nodeFailed(e);
    }
    this.#requireUsableAnchor(anchor, question.anchor);
    const filled = [...filledByWallet];
    if (question.requested.includes('BlockHash')) filled.push({ label: 'BlockHash', context: anchor.blockHash });
    const proofContext = sdk.VerifiablePresentationV1.createContext(question.request.context, filled);
    return sdk.VerifiablePresentationV1.create({ context: proofContext, subjectClaims }, subjectClaims.map(() => input), globalContext);
  }

  /**
   * What the question asks the wallet to fill in, other than the anchor's block (filled in from the anchor): text the
   * wallet knows, passed as `context` (e.g. { ResourceID: the site it is connected to }). Nothing more, nothing less.
   */
  #contextToFill(requested, context) {
    if (!context || typeof context !== 'object') throw new Error('context must be an object of labels to text, e.g. { ResourceID: \'shop.example\' }.');
    const asked = requested.filter((label) => label !== 'BlockHash');
    for (const label of asked) {
      if (!TEXT_CONTEXT.includes(label)) {
        throw new ProofError(`The question asks the wallet for a ${label}, which this package cannot fill in.`, { reason: 'invalid-request' });
      }
      if (typeof context[label] !== 'string') {
        throw new Error(`The question asks the wallet for its ${label}: pass context: { ${label}: '…' } (for ResourceID, the `
          + 'site the wallet is connected to).');
      }
    }
    for (const label of Object.keys(context)) {
      if (!asked.includes(label)) throw new Error(`context.${label} is not asked for by the question; only ${asked.join(', ') || 'nothing'} is.`);
    }
    return asked.map((label) => ({ label, context: context[label] }));
  }

  /** Refuse an anchor that is not on chain and final, or does not record this question. */
  #requireUsableAnchor(anchor, hash) {
    if (anchor.status === 'finalized') return;
    if (anchor.status === 'absent') {
      throw new ProofError(`The question's anchor (${hash}) is not on chain: the website has not recorded it, or recorded it on `
        + 'another network. Do not answer.', { reason: 'anchor-not-found', detail: 'absent' });
    }
    if (anchor.status === 'received' || anchor.status === 'committed') {
      throw new ProofError(`The question's anchor (${hash}) is not final yet (${anchor.status}): try again in a few seconds.`,
        { reason: 'anchor-not-found', detail: anchor.status });
    }
    if (anchor.status === 'mismatch') {
      throw new ProofError(`The question's anchor (${hash}) does not record this question: it may have been changed. Do not answer.`,
        { reason: 'anchor-mismatch', detail: anchor.detail });
    }
    throw new ProofError(`The node gave an unexpected answer about the anchor: ${anchor.detail}`, { reason: 'node', detail: anchor.detail });
  }

  /** The held identity (its details, dates and signature); ProofError 'not-held' if none is held. */
  #identityOf(providerIndex, identityIndex) {
    if (!this.#held.has(providerIndex, identityIndex)) {
      throw new ProofError(`No identity is held for provider ${providerIndex}, identity ${identityIndex}: verify, load or `
        + 'recover it first.', { reason: 'not-held' });
    }
    return identityContent(this.#held.require(providerIndex, identityIndex), 'The identity held is in an unexpected format.');
  }

  /** The held identity's attribute list (its details and dates); ProofError 'not-held' if none is held. */
  #attributesOf(providerIndex, identityIndex) {
    return this.#identityOf(providerIndex, identityIndex).attributeList;
  }

  /**
   * Refuse BEFORE building anything if the answer would not be true: the provider must be accepted, and every
   * detail asked about must satisfy its statement. So a wallet never sends a proof that cannot be right.
   */
  #checkCanAnswer(credentialStatements, providerIndex, attributes) {
    for (const cs of credentialStatements) {
      if (!cs.idQualifier.issuers.includes(providerIndex)) {
        throw new ProofError(`The website accepts identities from providers ${cs.idQualifier.issuers.join(', ')}, `
          + `not from provider ${providerIndex}.`, { reason: 'provider-not-accepted' });
      }
      for (const statement of cs.statement) {
        if (!(statement.attributeTag in attributes)) {
          throw new ProofError(`The identity has no ${attributeLabel(statement.attributeTag)}, which the website asks about.`,
            { reason: 'cannot-prove', detail: statement.attributeTag });
        }
        if (!sdk.canProveAtomicStatement(statement, attributes)) {
          throw new ProofError(`Cannot prove what the website asks about the ${attributeLabel(statement.attributeTag)}: `
            + 'the identity\'s details do not satisfy it.', { reason: 'cannot-prove', detail: statement.attributeTag });
        }
      }
    }
  }
}
