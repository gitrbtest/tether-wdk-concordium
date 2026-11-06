/**
 * Making a proof (scope part E, version 0: account-based). Internal: ConcordiumIdentity is the public face.
 *
 *   prove ─► check the website's question ─► identity held? ─► its provider accepted? ─► can it TRULY answer?
 *         ─► which account answers (its id, from the seed) ─► the secret ingredients (each detail and the random
 *            number used to seal it when the account was created, from the seed) ─► Concordium's
 *            getVerifiablePresentation ─► the proof
 *
 * The identity never leaves the wallet: only the proof does (plus any detail the question asks to show).
 */
import * as sdk from '@concordium/web-sdk';
import { bytesToHex } from '@noble/hashes/utils';
import { ProofError } from '../shared/errors.js';
import { requireIndex, IDENTITY_INDEX_HINT } from '../shared/inputs.js';
import { identityContent, hasExpired } from '../issuance/identity-object.js';
import { readProofRequest, attributeLabel } from './proof-request.js';

export default class IdentityProofs {
  #node;
  #hdWallet;
  #held;
  #network;
  #findAccounts;

  /**
   * @param {{ node: object, hdWallet: () => object, held: object, network: 'Testnet' | 'Mainnet',
   *   findAccounts: (options: object) => Promise<Array<{ credNumber: number, address: string, path: string }>> }} collaborators
   */
  constructor({ node, hdWallet, held, network, findAccounts }) {
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
    requireIndex(credNumber, 'credNumber', 'say which account answers (accountsThatCanAnswer lists the ones that can).');
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

  /** The held identity's attribute list (its details and dates); ProofError 'not-held' if none is held. */
  #attributesOf(providerIndex, identityIndex) {
    if (!this.#held.has(providerIndex, identityIndex)) {
      throw new ProofError(`No identity is held for provider ${providerIndex}, identity ${identityIndex}: verify, load or `
        + 'recover it first.', { reason: 'not-held' });
    }
    return identityContent(this.#held.require(providerIndex, identityIndex), 'The identity held is in an unexpected format.')
      .attributeList;
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
