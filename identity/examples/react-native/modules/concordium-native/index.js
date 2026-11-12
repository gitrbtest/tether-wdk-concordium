/**
 * Concordium's native cryptography, as the identity package's cryptography plug-in:
 *
 *   new ConcordiumIdentity(seedPhrase, config, { cryptography: nativeConcordiumCryptography });
 *
 * On a phone with React Native, Concordium's JavaScript SDK runs its cryptography as plain JavaScript (there is no
 * WebAssembly), far too slow. Concordium publishes the same cryptography compiled for Android (its Android SDK); the
 * Kotlin module beside this file calls it. Each step below does exactly what the JavaScript SDK function of the same
 * name does around its WebAssembly call (the JSON it builds, how it reads the answer), with the native call instead:
 * the same Rust code answers, so the results are the same.
 *
 * One step has no native version: checking a proof (Concordium's Android SDK cannot). It is marked unavailable, so the
 * identity package skips its own check of an identity's provider signature on the phone; the chain checks it when an
 * account is created, and websites when they check a proof, as with Concordium's own phone wallets.
 */
import { requireNativeModule } from 'expo-modules-core';
import * as sdk from '@concordium/web-sdk';
import JSONbig from 'json-bigint';
import { SIGNATURE_CHECK_UNAVAILABLE } from '@concordium/wdk-identity-concordium';

const native = requireNativeModule('ConcordiumNative');

// As the JavaScript SDK: json-bigint's default for version 0 proofs, and big numbers kept exact for version 1.
const JSONBigV0 = JSONbig();
const JSONBigV1 = JSONbig({ alwaysParseAsBig: true, useNativeBigInt: true });

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The JSON form of a proof's context, as the SDK's (internal) proofContextToJSON / givenContextToJSON build it. */
function givenContextToJSON(context) {
  switch (context.label) {
    case 'Nonce':
    case 'PaymentHash':
      return { ...context, context: typeof context.context === 'string' ? context.context : hexOf(context.context) };
    case 'BlockHash':
      return { ...context, context: context.context.toJSON() };
    default:
      return context;
  }
}
const proofContextToJSON = (context) => ({
  type: context.type,
  given: context.given.map(givenContextToJSON),
  requested: context.requested.map(givenContextToJSON),
});

/** Keys from the seed, worked out natively; each key is returned as hex text. */
function deriveKeys(seedHex, network) {
  return {
    getIdCredSec: (ip, id) => native.getIdCredSec(seedHex, network, ip, id),
    getPrfKey: (ip, id) => native.getPrfKey(seedHex, network, ip, id),
    getSignatureBlindingRandomness: (ip, id) => native.getSignatureBlindingRandomness(seedHex, network, ip, id),
    getAttributeCommitmentRandomness: (ip, id, cred, attribute) =>
      native.getAttributeCommitmentRandomness(seedHex, network, ip, id, cred, attribute),
    getAccountSigningKey: (ip, id, cred) => native.getAccountSigningKey(seedHex, network, ip, id, cred),
    getAccountPublicKey: (ip, id, cred) => native.getAccountPublicKey(seedHex, network, ip, id, cred),
    getCredentialId: (ip, id, cred, globalContext) =>
      native.getCredentialId(seedHex, network, ip, id, cred, globalContext.onChainCommitmentKey),
  };
}

export const nativeConcordiumCryptography = {
  deriveKeys,

  // createIdentityRequestWithKeys
  async createIdentityRequestWithKeys(input) {
    return JSON.parse(await native.createIdentityRequestV1(JSON.stringify(input))).idObjectRequest;
  },

  // createIdentityRecoveryRequestWithKeys
  async createIdentityRecoveryRequestWithKeys(input) {
    return JSON.parse(await native.createIdentityRecoveryRequest(JSON.stringify(input))).idRecoveryRequest;
  },

  // createCredentialPayloadNoSeed
  async createCredentialPayloadNoSeed(input, expiry) {
    const { sigRetrievelRandomness, ...other } = input;
    const info = JSON.parse(await native.createUnsignedCredentialV1(JSON.stringify({ ...other, blindingRandomness: sigRetrievelRandomness })));
    return { expiry, ...info };
  },

  // getVerifiablePresentation (version 0)
  async getVerifiablePresentation(input) {
    return sdk.VerifiablePresentation.fromString(await native.createWeb3IdProof(JSONBigV0.stringify(input)));
  },

  // VerifiablePresentationV1.create (version 1)
  async createPresentationV1({ context, subjectClaims }, inputs, globalContext) {
    const request = { type: 'ConcordiumVerifiablePresentationRequestV1', context: proofContextToJSON(context), subjectClaims };
    const answer = await native.createPresentationV1(JSONBigV1.stringify({ request, global: globalContext, inputs }));
    return sdk.VerifiablePresentationV1.fromJSON(JSONBigV1.parse(answer));
  },

  // No native version: see the note at the top.
  verifyPresentationV1: SIGNATURE_CHECK_UNAVAILABLE,
};

export default native;
