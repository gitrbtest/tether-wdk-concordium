/**
 * The Concordium node, through the connection the wallet passes in (`config.node`). Internal: ConcordiumIdentity's
 * helpers use it. The package never opens a connection itself, so it runs wherever the wallet's own client does: a
 * gRPC client in Node.js (ConcordiumGRPCNodeClient), gRPC-web in browsers and phones (ConcordiumGRPCWebClient), or
 * the client a WDK wallet already has.
 */

/** The node methods the package calls. */
export const NODE_METHODS = ['getCryptographicParameters'];

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
}
