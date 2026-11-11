/**
 * The provider list checked against the chain's own record.
 *
 * The wallet passes in the identity provider list (usually the wallet-proxy's /v2/ip_info). The package uses its
 * keys to build identity requests, account credentials and proofs, so a tampered or out-of-date list would make it
 * build them for the wrong keys: for example, recovery data meant for the official anonymity revokers would be
 * encrypted to keys someone else holds. The chain keeps the official record of every registered provider and
 * anonymity revoker, so each provider in the list is compared with it:
 *
 *   the provider's two verify keys (ipVerifyKey, ipCdiVerifyKey)    = the chain's record for its number (ipIdentity)
 *   each of its anonymity revokers' public keys (arPublicKey)       = the chain's record for that revoker's number
 *
 * A provider that does not match, or is not on the chain at all, is refused: no request, account or proof is built
 * with it. What the chain does not record cannot be checked here: the addresses of the providers' pages
 * (issuanceStart, recoveryStart) exist only in the list, so the wallet must still fetch the list from a source it
 * trusts.
 */

/**
 * Compare each provider in the list with the chain's record.
 * @param {object[]} entries  the provider list (as checked by readProviderList)
 * @param {{ identityProviders: object[], anonymityRevokers: object[] }} chain  the chain's record (from the node)
 * @returns {Map<number, string | null>}  provider number → null if it matches, or why it does not
 */
export function compareWithChain(entries, { identityProviders, anonymityRevokers }) {
  const providers = new Map(identityProviders.map((ip) => [ip.ipIdentity, ip]));
  const revokers = new Map(anonymityRevokers.map((ar) => [ar.arIdentity, ar]));
  const verdicts = new Map();
  for (const { ipInfo, arsInfos } of entries) {
    const index = ipInfo.ipIdentity;
    const onChain = providers.get(index);
    let problem = null;
    if (!onChain) {
      problem = `identity provider ${index} is not registered on the chain`;
    } else if (onChain.ipVerifyKey !== ipInfo.ipVerifyKey || onChain.ipCdiVerifyKey !== ipInfo.ipCdiVerifyKey) {
      problem = `identity provider ${index}'s keys in the list differ from the chain's record`;
    } else {
      for (const ar of Object.values(arsInfos)) {
        const arOnChain = revokers.get(ar.arIdentity);
        if (!arOnChain) {
          problem = `anonymity revoker ${ar.arIdentity} (of identity provider ${index}) is not registered on the chain`;
          break;
        }
        if (arOnChain.arPublicKey !== ar.arPublicKey) {
          problem = `anonymity revoker ${ar.arIdentity}'s key (of identity provider ${index}) differs from the chain's record`;
          break;
        }
      }
    }
    verdicts.set(index, problem);
  }
  return verdicts;
}
