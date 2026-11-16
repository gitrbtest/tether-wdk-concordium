/**
 * A connection to a Concordium node, for the website's side (requestFor records the question on chain,
 * checkPresentation reads the chain). Part of the `@concordium/wdk-identity-concordium/verify` entry point.
 */
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

/** Concordium's public nodes, by network name. */
const PUBLIC_NODES = {
  testnet: 'https://grpc.testnet.concordium.com:20000',
  mainnet: 'https://grpc.mainnet.concordium.software:20000',
};

/**
 * A connection to a Concordium node, for requestFor and checkPresentation. Give 'testnet' or 'mainnet' for Concordium's public node,
 * or the address of your own node, e.g. 'https://my-node.example.com:20000' ('http://…' for a node without TLS).
 *
 * @param {'testnet' | 'mainnet' | string} where
 * @returns {object} the node connection (Concordium's ConcordiumGRPCNodeClient)
 */
export function connectToNode(where) {
  const address = PUBLIC_NODES[String(where).toLowerCase()] ?? where;
  let url;
  try {
    url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new Error("connectToNode needs 'testnet', 'mainnet', or a node address like 'https://my-node.example.com:20000'.");
  }
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  return new ConcordiumGRPCNodeClient(url.hostname, port, secure ? credentials.createSsl() : credentials.createInsecure());
}
