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
 *   identity ─► createPresentationV1 (stating nothing) ─► verifyPresentationV1
 *               (with this seed's keys for it)             (the provider's keys, checked against the chain when the
 *                                                           list was used)
 *                                                          holds → genuine; fails → not genuine
 *
 * Both steps go through the cryptography in use (src/shared/cryptography.js): Concordium's JavaScript SDK by default, or a
 * plug-in such as Concordium's native library on a phone. With the SDK it takes about a second, once each time an
 * identity is collected, recovered or imported.
 */
import * as sdk from '@concordium/web-sdk';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { asHex, sdkCryptography, canCheckSignatures } from '../shared/cryptography.js';

/**
 * What a version 1 proof is built from: the identity, its provider, and its secrets worked out from the seed (the
 * same as the SDK's createIdentityCommitmentInputWithHdWallet, with the keys from whichever key derivation is in use).
 * @param {{ identity: object, ipInfo: object, arsInfos: object, identityIndex: number, hdWallet: object }} options
 *   identity: the identity's content (identityContent)
 */
export async function identityCommitmentInput({ identity, ipInfo, arsInfos, identityIndex, hdWallet }) {
  const ip = ipInfo.ipIdentity;
  return sdk.createIdentityCommitmentInput({ ipInfo, arsInfos }, identity, {
    randomness: asHex(await hdWallet.getSignatureBlindingRandomness(ip, identityIndex)),
    aci: {
      prfKey: asHex(await hdWallet.getPrfKey(ip, identityIndex)),
      credentialHolderInformation: { idCredSecret: asHex(await hdWallet.getIdCredSec(ip, identityIndex)) },
    },
  });
}

/**
 * Whether the provider's signature fits the identity.
 * @param {object} options
 * @param {object} options.content  the identity's content (identityContent: preIdentityObject, attributeList, signature)
 * @param {{ ipInfo: object, arsInfos: object }} options.provider  the provider's keys and anonymity revokers
 * @param {number} options.identityIndex
 * @param {object} options.hdWallet  the seed's key derivation
 * @param {object} options.globalContext  the network's cryptographic parameters
 * @param {'Testnet' | 'Mainnet'} options.network
 * @param {object} [options.cryptography]  the cryptography steps in use (default: Concordium's JavaScript SDK)
 * @returns {Promise<boolean>}  true if genuine; false if the signature does not fit (forged, or changed since issued).
 *   With a plug-in that cannot check proofs (verifyPresentationV1: 'unavailable', on phones), true without checking:
 *   the chain and websites check the signature later, as with Concordium's own phone wallets.
 * @throws {Error} If the check itself could not be made (an identity in an unexpected format): never mistaken for
 *   "not genuine"
 */
export async function isSignedByProvider({ content, provider, identityIndex, hdWallet, globalContext, network, cryptography = sdkCryptography }) {
  if (!canCheckSignatures(cryptography)) return true; // a phone plug-in that cannot check proofs said so: see cryptography.js
  const { ipInfo, arsInfos } = provider;
  const input = await identityCommitmentInput({ identity: content, ipInfo, arsInfos, identityIndex, hdWallet });
  const context = sdk.VerifiablePresentationV1.createContext({
    type: 'ConcordiumUnfilledContextInformationV1', given: [{ label: 'Nonce', context: bytesToHex(randomBytes(32)) }], requested: [],
  }, []);
  const claims = sdk.VerifiablePresentationV1.createIdentityClaims(network, ipInfo.ipIdentity, []); // states nothing
  const proof = await cryptography.createPresentationV1({ context, subjectClaims: [claims] }, [input], globalContext);
  try {
    await cryptography.verifyPresentationV1(proof, globalContext, [{ type: 'identity', ipInfo, arsInfos }]);
    return true;
  } catch {
    return false; // the proof does not hold: the signature does not fit this identity
  }
}
