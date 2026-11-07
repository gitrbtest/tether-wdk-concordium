/**
 * The Concordium node, through the connection the wallet passes in (`config.node`). Internal: ConcordiumIdentity's
 * helpers use it for everything they need from the chain: the network's cryptographic parameters, whether an account
 * exists, sending a new account's credential and following it, and finding a version 1 question's anchor. The package never opens a connection itself, so
 * it runs wherever the wallet's own client does: a gRPC client in Node.js (ConcordiumGRPCNodeClient), gRPC-web in
 * browsers and phones (ConcordiumGRPCWebClient), or the client a WDK wallet already has.
 */
import * as sdk from '@concordium/web-sdk';

/** The node methods the package calls. */
export const NODE_METHODS = ['getCryptographicParameters', 'getAccountInfo', 'sendCredentialDeploymentTransaction', 'getBlockItemStatus'];

/**
 * Check the node connection the wallet passed in has the methods the package calls.
 * @throws {Error} naming the first missing method
 */
export function requireNode(node) {
  if (!node || typeof node !== 'object') {
    throw new Error('config.node is required: a connection to a Concordium node (e.g. the SDK\'s ConcordiumGRPCNodeClient '
      + 'or ConcordiumGRPCWebClient, or the client your wallet already has).');
  }
  for (const method of NODE_METHODS) {
    if (typeof node[method] !== 'function') throw new Error(`config.node has no ${method}(): it must be a Concordium node client.`);
  }
  return node;
}

/** The node's "not found" answer (gRPC status NOT_FOUND): no such account, or no such transaction. */
export const isNotFound = (e) => e?.code === 'NOT_FOUND' || e?.code === 5;

export default class ChainNode {
  #client;
  #globalContext; // read once: the parameters do not change

  /** @param {object} client  the node connection the wallet passed in (checked by requireNode) */
  constructor(client) {
    this.#client = client;
  }

  /**
   * The network's cryptographic parameters ("global context" in Concordium's SDK): public values that every wallet
   * and node on the network uses for zero-knowledge proofs, the same for everyone and fixed for the network. Identity
   * requests, ownership checks, account credentials and proofs are all built against them.
   *   genesisString          the network's name, mixed into proofs so they cannot be reused on another network
   *   onChainCommitmentKey   the key for commitments ("sealed envelopes" holding attribute values)
   *   bulletproofGenerators  public numbers for range proofs (e.g. "over 18"); about 49 KB of hex
   * Read once from the node, then reused: they never change, and the generators are large. A failed read is not
   * remembered, so the next call tries again.
   */
  async globalContext() {
    if (!this.#globalContext) {
      const parameters = await this.#client.getCryptographicParameters();
      if (!parameters?.onChainCommitmentKey || !parameters?.bulletproofGenerators || !parameters?.genesisString) {
        throw new Error('The node returned cryptographic parameters in an unexpected format.');
      }
      this.#globalContext = parameters;
    }
    return this.#globalContext;
  }

  /**
   * Whether an account exists on chain (at the last finalized block). The node answers "not found" for an address
   * with no account; any other failure is thrown, so it is never mistaken for "no account".
   * @param {string} address  base58
   */
  async accountExists(address) {
    try {
      await this.#client.getAccountInfo(sdk.AccountAddress.fromBase58(address));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  /**
   * Send a signed credential that creates an account.
   * @param {{ payload: Uint8Array, expiry: object }} credential  the serialized credential and its expiry (see
   *   account/credential.js)
   * @returns {Promise<string>}  the transaction hash, hex
   * @throws whatever the node answers when it refuses it (e.g. an invalid credential), as the node's error
   */
  async sendCredential({ payload, expiry }) {
    const hash = await this.#client.sendCredentialDeploymentTransaction(payload, expiry);
    return sdk.TransactionHash.toHexString(hash);
  }

  /**
   * Where a sent transaction is:
   *   { status: 'absent' }      the node does not know it (not yet seen, or dropped)
   *   { status: 'received' }    waiting to be put in a block
   *   { status: 'committed' }   in a block, not yet final
   *   { status: 'finalized', created: boolean, blockHash, detail? }  final; created says whether it made an account
   *   { status: 'unexpected', detail }  an answer the package does not know (reported, not waited on)
   * @param {string} transactionHash  hex
   */
  async transactionStatus(transactionHash) {
    let status;
    try {
      status = await this.#client.getBlockItemStatus(sdk.TransactionHash.fromHexString(transactionHash));
    } catch (e) {
      if (isNotFound(e)) return { status: 'absent' };
      throw e;
    }
    if (status?.status === 'finalized') {
      const { blockHash, summary } = status.outcome ?? {};
      const created = summary?.type === sdk.TransactionSummaryType.AccountCreation;
      return {
        status: 'finalized', created, blockHash: blockHash && sdk.BlockHash.toHexString(blockHash),
        ...(created ? {} : { detail: `finalized as ${summary?.type ?? 'unknown'}` }),
      };
    }
    if (status?.status === 'received' || status?.status === 'committed') return { status: status.status };
    return { status: 'unexpected', detail: JSON.stringify(status?.status) }; // reported by the caller, not waited on
  }

  /**
   * Where a version 1 question's anchor is: the transaction the website sent to record the question on chain.
   *   { status: 'absent' }      the node does not know it (not sent, or sent on another network)
   *   { status: 'received' }    sent, waiting to be put in a block
   *   { status: 'committed' }   in a block, not yet final
   *   { status: 'finalized', blockHash }  final, and it really records this question (the SDK's own check)
   *   { status: 'mismatch', detail }      final, but it does not record this question (another question, or not
   *                                       a registerData transaction at all)
   *   { status: 'unexpected', detail }    an answer the package does not know
   * @param {object} request  the SDK's VerificationRequestV1
   */
  async anchorOf(request) {
    let status;
    try {
      status = await this.#client.getBlockItemStatus(request.transactionRef);
    } catch (e) {
      if (isNotFound(e)) return { status: 'absent' };
      throw e;
    }
    if (status?.status === 'received' || status?.status === 'committed') return { status: status.status };
    if (status?.status !== 'finalized') return { status: 'unexpected', detail: JSON.stringify(status?.status) };
    try {
      // The SDK's check (registerData, holding this question's hash), on the status already read: no second call.
      const outcome = await sdk.VerificationRequestV1.verifyAnchor(request, { getBlockItemStatus: async () => status });
      return { status: 'finalized', blockHash: outcome.blockHash };
    } catch (e) {
      return { status: 'mismatch', detail: e.message };
    }
  }
}
