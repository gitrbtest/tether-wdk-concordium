/**
 * Is this identity genuine: issued by its provider, exactly as it is now?
 *
 * An identity carries its provider's signature over the person's details, the identity's validity and the public key
 * it was issued to. Concordium's SDK has no function to check that signature on its own, so the package checks it
 * the way a website would: it builds a tiny proof from the identity, locally and for no one (a version 1 proof that
 * states nothing, with a random nonce), and checks it with Concordium's own verifier against the provider's public
 * keys. The proof only holds if the provider's signature fits the identity: a forged identity, or one with any
 * detail changed (a name, a date, the number of accounts), fails. Nothing is sent anywhere.
 *
 *   identity ─► VerifiablePresentationV1.create (stating nothing) ─► VerifiablePresentationV1.verify
 *               (with this seed's keys for it)                         (the provider's keys, checked against the
 *                                                                       chain when the list was used)
 *                                                                       holds → genuine; fails → not genuine
 *
 * It takes about a second (two zero-knowledge proof steps), once each time an identity is collected, recovered or
 * imported.
 */
import * as sdk from '@concordium/web-sdk';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

/**
 * Whether the provider's signature fits the identity.
 * @param {object} options
 * @param {object} options.content  the identity's content (identityContent: preIdentityObject, attributeList, signature)
 * @param {{ ipInfo: object, arsInfos: object }} options.provider  the provider's keys and anonymity revokers
 * @param {number} options.identityIndex
 * @param {object} options.hdWallet  the seed's key derivation
 * @param {object} options.globalContext  the network's cryptographic parameters
 * @param {'Testnet' | 'Mainnet'} options.network
 * @returns {boolean}  true if genuine; false if the signature does not fit (forged, or changed since it was issued)
 * @throws {Error} If the check itself could not be made (an identity in an unexpected format): never mistaken for
 *   "not genuine"
 */
export function isSignedByProvider({ content, provider, identityIndex, hdWallet, globalContext, network }) {
  const { ipInfo, arsInfos } = provider;
  const input = sdk.createIdentityCommitmentInputWithHdWallet(content, { ipInfo, arsInfos }, identityIndex, hdWallet);
  const context = sdk.VerifiablePresentationV1.createContext({
    type: 'ConcordiumUnfilledContextInformationV1', given: [{ label: 'Nonce', context: bytesToHex(randomBytes(32)) }], requested: [],
  }, []);
  const claims = sdk.VerifiablePresentationV1.createIdentityClaims(network, ipInfo.ipIdentity, []); // states nothing
  const proof = sdk.VerifiablePresentationV1.create({ context, subjectClaims: [claims] }, [input], globalContext);
  try {
    sdk.VerifiablePresentationV1.verify(proof, globalContext, [{ type: 'identity', ipInfo, arsInfos }]);
    return true;
  } catch {
    return false; // the proof does not hold: the signature does not fit this identity
  }
}
