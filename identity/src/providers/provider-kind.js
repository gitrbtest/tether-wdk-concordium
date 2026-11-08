/**
 * Whether an identity provider issues identities of people, or of companies ("Business ID": a company's identity,
 * with its LEI, legal name and country of registration, verified by the provider from the company's documents and
 * its signatory's ID). A wallet can offer the two separately: "verify yourself" and "verify your company".
 *
 * ASSUMPTION. Concordium documents no field that says a provider issues Business IDs, so it is inferred here, from
 * what the provider publishes about itself in the provider list:
 *   - its display name (`metadata.display`) mentions "Business ID": Global FinReg publishes
 *     "Global FinReg (Business ID)" (testnet provider 4, mainnet provider 3); or
 *   - its issuance address ends with "/company": Global FinReg's is …/ccd-id-provider/v1/company.
 * Sources (checked 27 Oct and 8 Nov 2026): the wallet-proxy's documentation describes /v2/ip_info as the list
 * "including company ID providers" (/v1/ip_info leaves them out) and `display` only as an alternative display name;
 * Concordium's web wallet release notes say company ID providers were removed from /v1/ip_info.
 * If Concordium adds a proper marker, change this one function: everything else asks it.
 */

/** 'company' if the provider issues company identities (Business ID), otherwise 'person'. See the note above. */
export function providerKind(entry) {
  const metadata = { ...entry?.ipInfo?.metadata, ...entry?.metadata };
  if (/business\s*id/i.test(String(metadata.display ?? ''))) return 'company';
  try {
    if (/\/company\/?$/.test(new URL(metadata.issuanceStart).pathname)) return 'company';
  } catch { /* no issuance address published */ }
  return 'person';
}
