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
import { getDeploymentDetails } from '@concordium/rust-bindings/wallet';
import { bytesToHex } from '@noble/hashes/utils';

/** The attribute names an identity can hold, e.g. 'firstName', 'countryOfResidence'. */
const ATTRIBUTE_NAMES = Object.keys(sdk.AttributesKeys).filter((name) => Number.isNaN(Number(name)));

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
 * }} options
 * @returns {Promise<{ credInfo: object, transactionHash: string, address: string, expiryEpochSeconds: number }>}
 *   credInfo is the signed credential as the wallet-proxy takes it; transactionHash identifies it on chain.
 */
export async function buildAccountCredential({
  provider, globalContext, hdWallet, idObject, identityIndex, credNumber, revealAttributes = [], expiry,
}) {
  // Keys are derived with the provider's own index, so the credential and the keys always agree.
  const ipIdentity = provider.ipInfo.ipIdentity;
  const attributeRandomness = Object.fromEntries(ATTRIBUTE_NAMES.map((name) => [
    name,
    hdWallet.getAttributeCommitmentRandomness(ipIdentity, identityIndex, credNumber, sdk.AttributesKeys[name]).toString('hex'),
  ]));

  const unsigned = sdk.createCredentialPayloadNoSeed({
    ipInfo: provider.ipInfo,
    arsInfos: provider.arsInfos,
    globalContext,
    idObject,
    revealedAttributes: revealAttributes,
    identityIndex,
    credNumber,
    idCredSec: hdWallet.getIdCredSec(ipIdentity, identityIndex).toString('hex'),
    prfKey: hdWallet.getPrfKey(ipIdentity, identityIndex).toString('hex'),
    sigRetrievelRandomness: hdWallet.getSignatureBlindingRandomness(ipIdentity, identityIndex).toString('hex'),
    credentialPublicKeys: {
      keys: { 0: { schemeId: 'Ed25519', verifyKey: hdWallet.getAccountPublicKey(ipIdentity, identityIndex, credNumber).toString('hex') } },
      threshold: 1,
    },
    attributeRandomness,
  }, sdk.TransactionExpiry.fromDate(expiry));

  // Signed with the new account's key, so the chain knows the sender controls it. The key bytes are
  // zeroed straight after (the SDK takes keys as hex text, which JavaScript cannot wipe).
  const signingKey = hdWallet.getAccountSigningKey(ipIdentity, identityIndex, credNumber);
  let signature;
  try {
    signature = await sdk.signCredentialTransaction(unsigned, bytesToHex(signingKey));
  } finally {
    signingKey.fill(0);
  }

  const expiryEpochSeconds = Number(unsigned.expiry.expiryEpochSeconds);
  const details = JSON.parse(getDeploymentDetails([signature], JSON.stringify(unsigned.unsignedCdi), BigInt(expiryEpochSeconds)));
  return {
    credInfo: details.credInfo,
    transactionHash: details.transactionHash,
    address: sdk.getAccountAddress(unsigned.unsignedCdi.credId).toString(),
    expiryEpochSeconds,
  };
}

