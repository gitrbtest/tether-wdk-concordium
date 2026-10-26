/**
 * Small helpers about an issued identity as the provider returns it (`{ v, value: { preIdentityObject,
 * attributeList, signature } }`), and the label it is held under inside ConcordiumIdentity.
 */

/** The label an identity is held under inside ConcordiumIdentity, e.g. "0/334563111" (provider 0, identity index 334563111). */
export const providerIdentityLabel = (providerIndex, identityIndex) => `${providerIndex}/${identityIndex}`;

/**
 * The content of an issued identity (without its version wrapper), checked to have the parts an
 * issued identity has. `problem` is the error message if it does not.
 */
export function identityContent(identityObject, problem) {
  const content = identityObject?.value ?? identityObject;
  if (!content?.preIdentityObject || !content?.attributeList || !content?.signature) throw new Error(problem);
  return content;
}

/** The summary a wallet gets about an identity: no personal data. */
export function summaryOf(content, providerIndex, identityIndex) {
  const { createdAt, validTo, maxAccounts } = content.attributeList;
  return { providerIndex, identityIndex, createdAt, validTo, maxAccounts };
}
