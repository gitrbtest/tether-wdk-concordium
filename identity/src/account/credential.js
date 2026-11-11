/**
 * Building and signing the credential that creates a new account from an identity (offline: nothing is
 * sent here). The credential holds the new account's public key, the identity provider's number, the
 * identity's dates, any attributes the wallet chose to reveal, commitments to the other attributes and
 * zero-knowledge proofs that it comes from an identity the provider signed. The identity itself, the
 * person's details and the secret keys are not in it.
 *
 * The secret keys come from the wallet's key derivation (hdWallet), as for the identity request; the seed
 * itself is never handed to the SDK.
 */
import * as sdk from '@concordium/web-sdk';
import { asHex, wipe, sdkCryptography } from '../shared/cryptography.js';

/**
 * The address of account number credNumber under an identity, without building the credential (fast):
 * it comes from the credential id, which comes from the seed and the network's commitment key.
 */
export async function accountAddressOf({ provider, globalContext, hdWallet, identityIndex, credNumber }) {
  const credId = await hdWallet.getCredentialId(provider.ipInfo.ipIdentity, identityIndex, credNumber, globalContext);
  return sdk.getAccountAddress(asHex(credId)).toString();
}

/** The attribute names an identity can hold, e.g. 'firstName', 'countryOfResidence'. */
export const ATTRIBUTE_NAMES = Object.keys(sdk.AttributesKeys).filter((name) => Number.isNaN(Number(name)));

/**
 * The signed credential for account number credNumber of an identity.
 *
 * @param {{
 *   provider: { ipInfo: object, arsInfos: object },
 *   globalContext: object,
 *   hdWallet: object,
 *   idObject: object,             the identity as the provider issued it (identityObject.value)
 *   identityIndex: number,
 *   credNumber: number,           the account number under this identity: 0, 1, 2…
 *   revealAttributes?: string[],  attribute names to show publicly on the account (default: none)
 *   expiry: Date,                 the chain ignores the credential if it is not included by then
 *   cryptography: object,               the cryptography steps in use (src/shared/cryptography.js)
 * }} options
 * @returns {Promise<{ payload: Uint8Array, expiry: object, credInfo: object, transactionHash: string, address: string,
 *   expiryEpochSeconds: number }>}
 *   payload is the signed credential, serialized as a node takes it; expiry its expiry (the SDK's TransactionExpiry);
 *   credInfo the same credential, readable (keys, policy, proofs); transactionHash identifies it on chain (known before
 *   it is sent).
 */
export async function buildAccountCredential({
  provider, globalContext, hdWallet, idObject, identityIndex, credNumber, revealAttributes = [], expiry, cryptography = sdkCryptography,
}) {
  // Keys are derived with the provider's own index, so the credential and the keys always agree.
  const ipIdentity = provider.ipInfo.ipIdentity;
  const attributeRandomness = {};
  for (const name of ATTRIBUTE_NAMES) {
    attributeRandomness[name] = asHex(await hdWallet.getAttributeCommitmentRandomness(ipIdentity, identityIndex, credNumber, sdk.AttributesKeys[name]));
  }

  const unsigned = await cryptography.createCredentialPayloadNoSeed({
    ipInfo: provider.ipInfo,
    arsInfos: provider.arsInfos,
    globalContext,
    idObject,
    revealedAttributes: revealAttributes,
    identityIndex,
    credNumber,
    idCredSec: asHex(await hdWallet.getIdCredSec(ipIdentity, identityIndex)),
    prfKey: asHex(await hdWallet.getPrfKey(ipIdentity, identityIndex)),
    sigRetrievelRandomness: asHex(await hdWallet.getSignatureBlindingRandomness(ipIdentity, identityIndex)),
    credentialPublicKeys: {
      keys: { 0: { schemeId: 'Ed25519', verifyKey: asHex(await hdWallet.getAccountPublicKey(ipIdentity, identityIndex, credNumber)) } },
      threshold: 1,
    },
    attributeRandomness,
  }, sdk.TransactionExpiry.fromDate(expiry));

  // Signed with the new account's key, so the chain knows the sender controls it. The key bytes are
  // zeroed straight after (the SDK takes keys as hex text, which JavaScript cannot wipe).
  const signingKey = await hdWallet.getAccountSigningKey(ipIdentity, identityIndex, credNumber);
  let signature;
  try {
    signature = await sdk.signCredentialTransaction(unsigned, asHex(signingKey)); // plain JavaScript (Ed25519): fast anywhere
  } finally {
    wipe(signingKey);
  }

  const expiryEpochSeconds = Number(unsigned.expiry.expiryEpochSeconds);
  const details = JSON.parse(await cryptography.getDeploymentDetails([signature], JSON.stringify(unsigned.unsignedCdi), BigInt(expiryEpochSeconds)));
  return {
    // The credential with its signature, in the bytes a node takes (the SDK's own serializer).
    payload: new Uint8Array(await cryptography.serializeCredentialDeploymentPayload([signature], unsigned)),
    expiry: unsigned.expiry,
    credInfo: details.credInfo,
    transactionHash: details.transactionHash,
    address: sdk.getAccountAddress(unsigned.unsignedCdi.credId).toString(),
    expiryEpochSeconds,
  };
}

