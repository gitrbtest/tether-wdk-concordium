/**
 * @concordium/wdk-identity-concordium/verify
 * -------------------------------------------------------------------
 * The website's side of proofs: build a question (recorded on chain) to send to a wallet, and check the wallet's answer.
 * Meant for servers (Node.js): checking needs a connection to a Concordium node. Wallets do not need this
 * entry point; they use the main one.
 */
export { requestFor } from './src/verify/request-for.js';
export { checkPresentation } from './src/verify/check-presentation.js';
export { connectToNode } from './src/verify/node.js';
export { describeProofRequest, describeProofContext } from './src/proofs/proof-request.js';
export { ProofError } from './src/shared/errors.js';
