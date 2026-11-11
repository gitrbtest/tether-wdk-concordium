/**
 * The heavy cryptography, behind one plug-in point.
 *
 * The package's logic is plain JavaScript, but a few steps need Concordium's cryptography: working out keys from the
 * seed, building an identity request or a recovery request, building an account's credential, and making or checking
 * a proof. By default they are done by Concordium's JavaScript SDK (`@concordium/web-sdk`), which runs the
 * cryptography as WebAssembly: fast on computers, servers and in browsers.
 *
 * On a phone with React Native there is no WebAssembly: the SDK's cryptography becomes plain JavaScript there, far too
 * slow (an identity request did not finish in 47 minutes on an Android emulator). A phone wallet can instead plug in
 * the same steps done by Concordium's native libraries (on Android, Concordium's Android SDK through a small native
 * module): `new ConcordiumIdentity(seed, config, { cryptography: myNativeCryptography })`. It may plug in all the steps or only
 * some; the others stay with the JavaScript SDK.
 *
 * Each step has the name, the arguments and the result of the SDK function it stands in for, so a plug-in can be
 * checked against the SDK; any step may answer with a promise (native calls are asynchronous):
 *
 *   deriveKeys(seedHex, network)                  ConcordiumHdWallet.fromHex: an object with the key functions below
 *     getIdCredSec(ip, identity)                    each returns the key as hex text, a Uint8Array or a Buffer
 *     getPrfKey(ip, identity)
 *     getSignatureBlindingRandomness(ip, identity)
 *     getAttributeCommitmentRandomness(ip, identity, cred, attributeIndex)
 *     getAccountSigningKey(ip, identity, cred)
 *     getAccountPublicKey(ip, identity, cred)
 *     getCredentialId(ip, identity, cred, { onChainCommitmentKey })
 *   createIdentityRequestWithKeys(input)          the identity request a provider verifies
 *   createIdentityRecoveryRequestWithKeys(input)  the recovery request (also how ownership is checked)
 *   createCredentialPayloadNoSeed(input, expiry)  an account's credential, unsigned
 *   serializeCredentialDeploymentPayload(signatures, unsigned)   the credential as the bytes sent to the node
 *   getDeploymentDetails(signatures, unsignedCdiJson, expiry)    its readable form and transaction hash (JSON text)
 *   getVerifiablePresentation(input)              a version 0 proof (from an account)
 *   createPresentationV1(request, inputs, globalContext)        a version 1 proof (VerifiablePresentationV1.create)
 *   verifyPresentationV1(presentation, globalContext, material) checking one (VerifiablePresentationV1.verify)
 *
 * Checking a proof has no native version: Concordium's Android library builds proofs but cannot check one, and the
 * SDK's check in plain JavaScript fails on a phone. A phone plug-in therefore says so explicitly,
 * `verifyPresentationV1: 'unavailable'`: the package then skips its own check of an identity's provider signature
 * (see issuance/identity-signature.js) and works as Concordium's own phone wallets do, where that signature is checked
 * by the chain when an account is created, and by websites when they check a proof. Nothing else can be left out.
 */
import * as sdk from '@concordium/web-sdk';
import { getDeploymentDetails } from '@concordium/rust-bindings/wallet';
import { bytesToHex } from '@noble/hashes/utils';

/** What a plug-in gives as verifyPresentationV1 when it cannot check proofs (see above). */
export const UNAVAILABLE = 'unavailable';

/** The steps a plug-in may provide. */
export const CRYPTOGRAPHY_STEPS = [
  'deriveKeys', 'createIdentityRequestWithKeys', 'createIdentityRecoveryRequestWithKeys', 'createCredentialPayloadNoSeed',
  'serializeCredentialDeploymentPayload', 'getDeploymentDetails', 'getVerifiablePresentation', 'createPresentationV1',
  'verifyPresentationV1',
];

/** The default: Concordium's JavaScript SDK. */
export const sdkCryptography = Object.freeze({
  deriveKeys: (seedHex, network) => sdk.ConcordiumHdWallet.fromHex(seedHex, network),
  createIdentityRequestWithKeys: (input) => sdk.createIdentityRequestWithKeys(input),
  createIdentityRecoveryRequestWithKeys: (input) => sdk.createIdentityRecoveryRequestWithKeys(input),
  createCredentialPayloadNoSeed: (input, expiry) => sdk.createCredentialPayloadNoSeed(input, expiry),
  serializeCredentialDeploymentPayload: (signatures, unsigned) => sdk.serializeCredentialDeploymentPayload(signatures, unsigned),
  getDeploymentDetails: (signatures, unsignedCdiJson, expiry) => getDeploymentDetails(signatures, unsignedCdiJson, expiry),
  getVerifiablePresentation: (input) => sdk.getVerifiablePresentation(input),
  createPresentationV1: (request, inputs, globalContext) => sdk.VerifiablePresentationV1.create(request, inputs, globalContext),
  verifyPresentationV1: (presentation, globalContext, material) => sdk.VerifiablePresentationV1.verify(presentation, globalContext, material),
});

/**
 * The steps to use: the plug-in's where it provides them, the SDK's otherwise.
 * @param {object} [plugIn]  the `cryptography` option
 * @throws {Error} If it is not an object, names a step that does not exist, or a step is not a function.
 */
export function readCryptography(plugIn) {
  if (plugIn === undefined) return sdkCryptography;
  if (!plugIn || typeof plugIn !== 'object') throw new Error('cryptography must be an object of cryptography steps (see CRYPTOGRAPHY_STEPS).');
  for (const [name, step] of Object.entries(plugIn)) {
    if (!CRYPTOGRAPHY_STEPS.includes(name)) throw new Error(`cryptography has an unknown step "${name}"; the steps are: ${CRYPTOGRAPHY_STEPS.join(', ')}.`);
    if (name === 'verifyPresentationV1' && step === UNAVAILABLE) continue; // said explicitly: see above
    if (typeof step !== 'function') throw new Error(`cryptography.${name} must be a function.`);
  }
  return Object.freeze({ ...sdkCryptography, ...plugIn });
}

/** Whether the identity signature check can be made with these steps (false only when a plug-in says so). */
export const canCheckSignatures = (cryptography) => cryptography.verifyPresentationV1 !== UNAVAILABLE;

/** A key as hex text, whichever form the step gave it in (hex text, Uint8Array or Buffer). */
export function asHex(key) {
  if (typeof key === 'string') return key;
  if (key instanceof Uint8Array) return bytesToHex(key);
  throw new Error('A key derivation step gave something that is not a key (expected hex text or bytes).');
}

/** Wipe a key's bytes after use, where they are bytes (hex text cannot be wiped). */
export function wipe(key) {
  if (key instanceof Uint8Array) key.fill(0);
}
