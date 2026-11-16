/**
 * Making a proof (scope part E). Internal: ConcordiumIdentity is the public face.
 *
 *   prove ─► check the question ─► same network? ─► what the wallet must fill in ─► identity held? ─► not expired?
 *         ─► answered from where the question allows (the identity itself, or an account: credNumber)? ─► its
 *            provider accepted? ─► can it TRULY answer? ─► the secret ingredients (from the identity: the identity and
 *            its secrets; from an account: the account's id and the random numbers that sealed its details; all
 *            worked out from the seed) ─► node: is the anchor on chain, final, and really this question?
 *         ─► Concordium's VerifiablePresentationV1.create, tied to the anchor's block ─► the proof
 *
 * The identity never leaves the wallet: only the proof does (plus any detail the question asks to show).
 */
import * as sdk from '@concordium/web-sdk';
import { asHex } from '../shared/cryptography.js';
import { identityCommitmentInput } from '../issuance/identity-signature.js';
import { ProofError } from '../shared/errors.js';
import { requireIndex, IDENTITY_INDEX_HINT, MAX_CRED_NUMBER } from '../shared/inputs.js';
import { identityContent, hasExpired } from '../issuance/identity-object.js';
import { readProofRequest, attributeLabel } from './proof-request.js';

/** Context labels a question may ask the wallet to fill in with text it knows (e.g. the site it is connected to). */
const TEXT_CONTEXT = ['ResourceID', 'ContextString', 'ConnectionID'];
const nodeFailed = (e) => new ProofError(`The Concordium node could not be asked: ${e?.message ?? e}`,
  { reason: 'node', detail: e?.message ?? String(e) });

export default class IdentityProofs {
  #node;
  #hdWallet;
  #cryptography; // the cryptography steps in use (src/shared/cryptography.js)
  #held;
  #network;
  #findAccounts;
  #providers;

  /**
   * @param {{ node: object, hdWallet: () => object, held: object, network: 'Testnet' | 'Mainnet',
   *   findAccounts: (options: object) => Promise<Array<{ credNumber: number, address: string, path: string }>>,
   *   providers: object }} collaborators  `providers`: the identity provider list (IdentityProviders)
   */
  constructor({ node, hdWallet, held, network, findAccounts, providers, cryptography }) {
    this.#providers = providers;
    this.#node = node;
    this.#hdWallet = hdWallet;
    this.#held = held;
    this.#network = network;
    this.#findAccounts = findAccounts;
    this.#cryptography = cryptography;
  }

  /** See ConcordiumIdentity.accountsThatCanAnswer. */
  async accountsThatCanAnswer({ providerIndex, identityIndex, request, gap, signal } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex', IDENTITY_INDEX_HINT);
    const question = readProofRequest(request);
    const { attributeList } = this.#identityOf(providerIndex, identityIndex);
    if (question.network !== this.#network) return []; // about another network's identities
    if (!question.claims.every((c) => c.source.includes('accountCredential'))) return []; // not answered from an account
    if (hasExpired({ attributeList })) return []; // an expired identity's accounts cannot answer acceptably
    try {
      this.#checkCanAnswer(question.claims, providerIndex, attributeList.chosenAttributes);
    } catch (e) {
      if (e instanceof ProofError && (e.reason === 'provider-not-accepted' || e.reason === 'cannot-prove')) return [];
      throw e;
    }
    // The identity can answer; any of its accounts on chain can carry the answer.
    return this.#findAccounts({ providerIndex, identityIndex, gap, signal });
  }

  /** See ConcordiumIdentity.prove. */
  async prove({ providerIndex, identityIndex, request, context = {}, credNumber } = {}) {
    requireIndex(providerIndex, 'providerIndex');
    requireIndex(identityIndex, 'identityIndex', IDENTITY_INDEX_HINT);
    const fromAccount = credNumber !== undefined; // answer from account credNumber, or from the identity itself
    if (fromAccount) requireIndex(credNumber, 'credNumber', 'say which account answers.', MAX_CRED_NUMBER);
    const question = readProofRequest(request);
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
      if (!fromAccount && !claim.source.includes('identityCredential')) {
        throw new ProofError(`Part ${n + 1} of the question accepts answers from an account only, not from the identity `
          + 'itself: answer from one of the identity\'s accounts (pass its credNumber).', { reason: 'account-only' });
      }
      if (fromAccount && !claim.source.includes('accountCredential')) {
        throw new ProofError(`Part ${n + 1} of the question accepts answers from the identity only, not from an account: `
          + 'answer without a credNumber.', { reason: 'identity-only' });
      }
    });
    this.#checkCanAnswer(question.claims, providerIndex, attributeList.chosenAttributes);

    // What is proven, per part: the statements as asked, with any detail to show filled in from the identity.
    const statementsOf = (claim) => sdk.VerifiablePresentationV1.revealRequestedStatements(claim.statements, attributeList.chosenAttributes);
    let subjectClaims;
    let inputs;
    if (fromAccount) {
      // From an account: the account is named by its credential id (worked out from the seed), and each part is proven
      // with the random numbers that sealed the account's details when it was created (worked out from the seed
      // again). Handed to the SDK as text, which JavaScript cannot wipe: they live only for this call.
      const hdWallet = await this.#hdWallet();
      const credId = asHex(await hdWallet.getCredentialId(providerIndex, identityIndex, credNumber, await this.#globalContextOrFail()));
      subjectClaims = question.claims.map((claim) => sdk.VerifiablePresentationV1.createAccountClaims(
        this.#network, sdk.CredentialRegistrationId.fromHexString(credId), providerIndex, statementsOf(claim)));
      inputs = [];
      for (const claim of subjectClaims) {
        const randomness = {};
        for (const statement of claim.statement) {
          randomness[statement.attributeTag] = asHex(await hdWallet.getAttributeCommitmentRandomness(
            providerIndex, identityIndex, credNumber, sdk.AttributesKeys[statement.attributeTag]));
        }
        inputs.push(sdk.createAccountCommitmentInput(claim.statement, providerIndex, attributeList, randomness));
      }
    } else {
      // From the identity: the identity, with its secrets worked out from the seed again (Concordium's SDK helper), and
      // the provider's keys. Handed to the SDK as text, which JavaScript cannot wipe: they live only for this call.
      const { ipInfo, arsInfos } = await this.#providers.get(providerIndex);
      const input = await identityCommitmentInput({ identity, ipInfo, arsInfos, identityIndex, hdWallet: await this.#hdWallet() });
      subjectClaims = question.claims.map((claim) => sdk.VerifiablePresentationV1.createIdentityClaims(this.#network, providerIndex, statementsOf(claim)));
      inputs = subjectClaims.map(() => input);
    }

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
    return this.#cryptography.createPresentationV1({ context: proofContext, subjectClaims }, inputs, globalContext);
  }

  /** The network's cryptographic parameters, from the node; a node problem becomes a ProofError ('node'). */
  async #globalContextOrFail() {
    try {
      return await this.#node.globalContext();
    } catch (e) {
      throw nodeFailed(e);
    }
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

  /**
   * Refuse BEFORE building anything if the answer would not be true: the provider must be accepted, and every
   * detail asked about must satisfy its statement. So a wallet never sends a proof that cannot be right.
   */
  #checkCanAnswer(claims, providerIndex, attributes) {
    for (const claim of claims) {
      if (!claim.providers.includes(providerIndex)) {
        throw new ProofError(`The website accepts identities from providers ${claim.providers.join(', ')}, `
          + `not from provider ${providerIndex}.`, { reason: 'provider-not-accepted' });
      }
      for (const statement of claim.statements) {
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
