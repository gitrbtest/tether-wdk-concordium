/**
 * The identity provider list, as the wallet hands it to the package: the package does
 * not fetch it. The wallet gets it from wherever it likes (today the wallet-proxy's /v2/ip_info, which includes the
 * company (Business ID) providers, or /v1/ip_info, which leaves them out) and passes it in that shape; only the shape
 * matters, so if the wallet-proxy is ever replaced, any source giving the same shape works.
 *
 * The shape, per provider (the fields the package reads):
 *
 *   {
 *     ipInfo: {
 *       ipIdentity: 0,                                   the provider's number on the network
 *       ipDescription: { name: 'Concordium testnet IP', url, description },
 *       ipVerifyKey: '…', ipCdiVerifyKey: '…',          its public keys (hex)
 *     },
 *     arsInfos: { '1': { arIdentity: 1, arPublicKey: '…', arDescription: {…} }, … },   its anonymity revokers
 *     metadata: {                                        optional: the provider's own addresses
 *       display: 'Global FinReg (Business ID)',          optional: its display name
 *       issuanceStart: 'https://…',                      where a person (or a company) goes to verify
 *       recoveryStart: 'https://…',                      where a wallet asks for an identity back
 *       icon, support,
 *     },
 *   }
 *
 * The node also knows the providers, but only their keys: the issuance and recovery addresses exist only in this list.
 * ConcordiumIdentity checks the list's keys against the node's record on first use (check-against-chain.js).
 */

const bad = (message) => new Error(`config.identityProviders ${message} (expected the identity provider list, in the shape `
  + 'of the wallet-proxy\'s /v2/ip_info or /v1/ip_info).');

const isText = (value) => typeof value === 'string' && value.length > 0;

function optionalAddress(entry, key, at) {
  const value = entry.metadata?.[key] ?? entry.ipInfo?.metadata?.[key];
  if (value === undefined || value === null || value === '') return; // not published
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw bad(`${at}.metadata.${key} must be an http(s) address`);
  }
}

/**
 * Check the list the wallet passed in, and keep a copy (so later changes to the wallet's own array do not affect the
 * package). Throws a clear error naming the first field that is missing or wrong.
 * @param {unknown} list
 * @returns {object[]}
 */
export function readProviderList(list) {
  if (!Array.isArray(list)) throw bad('is required and must be a list');
  if (list.length === 0) throw bad('is empty');
  const seen = new Set();
  list.forEach((entry, n) => {
    const at = `[${n}]`;
    const info = entry?.ipInfo;
    if (!info || typeof info !== 'object') throw bad(`${at} has no ipInfo`);
    if (!Number.isSafeInteger(info.ipIdentity) || info.ipIdentity < 0) throw bad(`${at}.ipInfo.ipIdentity must be the provider's number`);
    if (seen.has(info.ipIdentity)) throw bad(`lists provider ${info.ipIdentity} twice`);
    seen.add(info.ipIdentity);
    if (!isText(info.ipDescription?.name)) throw bad(`${at}.ipInfo.ipDescription.name is missing`);
    if (!isText(info.ipVerifyKey) || !isText(info.ipCdiVerifyKey)) throw bad(`${at}.ipInfo is missing the provider's keys`);
    const ars = entry.arsInfos;
    if (!ars || typeof ars !== 'object' || Array.isArray(ars) || Object.keys(ars).length === 0) {
      throw bad(`${at}.arsInfos must list the provider's anonymity revokers`);
    }
    for (const [key, ar] of Object.entries(ars)) {
      if (!Number.isSafeInteger(ar?.arIdentity) || !isText(ar?.arPublicKey)) throw bad(`${at}.arsInfos.${key} is incomplete`);
    }
    optionalAddress(entry, 'issuanceStart', at);
    optionalAddress(entry, 'recoveryStart', at);
  });
  return JSON.parse(JSON.stringify(list)); // a copy (plain JSON: works in every JavaScript runtime)
}
