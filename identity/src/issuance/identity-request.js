/**
 * Building an identity request and the link that opens the provider's verification page.
 * The secret keys come from the wallet's key derivation (hdWallet) and stay here: only public values,
 * commitments, encrypted shares and proofs go into the request.
 */
import * as sdk from '@concordium/web-sdk';

/**
 * The identity request for a provider, from the wallet's keys for that provider and identity index.
 *
 * @param {{ provider: { ipInfo: object, arsInfos: object }, globalContext: object, hdWallet: object, identityIndex: number }} options
 * @returns {object}  the versioned idObjectRequest, as the provider expects it
 */
export function buildIdentityRequest({ provider, globalContext, hdWallet, identityIndex }) {
  // Keys are derived with the provider's own index, so the request and the keys always agree.
  const ipIdentity = provider.ipInfo.ipIdentity;
  return sdk.createIdentityRequestWithKeys({
    ipInfo: provider.ipInfo,
    arsInfos: provider.arsInfos,
    // Any arThreshold of the provider's anonymity revokers together can reveal the identity; fewer cannot.
    arThreshold: Math.max(1, Object.keys(provider.arsInfos).length - 1),
    globalContext,
    idCredSec: hdWallet.getIdCredSec(ipIdentity, identityIndex).toString('hex'),
    prfKey: hdWallet.getPrfKey(ipIdentity, identityIndex).toString('hex'),
    blindingRandomness: hdWallet.getSignatureBlindingRandomness(ipIdentity, identityIndex).toString('hex'),
  });
}

/** The link to the provider's verification page: its issuance address with the request and the return address. */
export function issuanceLink(issuanceStart, idObjectRequest, redirectUri) {
  const query = new URLSearchParams({
    state: JSON.stringify({ idObjectRequest }),
    response_type: 'code',
    scope: 'identity',
    redirect_uri: redirectUri,
  });
  return `${issuanceStart}?${query}`;
}

/**
 * The public key (idCredPub) an identity issued for these keys must carry: how waitForIdentity checks an
 * issued identity belongs to this wallet. Computed through the SDK's recovery request, which contains it.
 */
export function expectedIdCredPub({ provider, globalContext, hdWallet, identityIndex }) {
  const idCredSec = hdWallet.getIdCredSec(provider.ipInfo.ipIdentity, identityIndex).toString('hex');
  return sdk.createIdentityRecoveryRequestWithKeys({
    ipInfo: provider.ipInfo, globalContext, idCredSec, timestamp: 0,
  }).value.idCredPub;
}
