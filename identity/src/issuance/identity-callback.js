/**
 * Reading the address the identity provider sent the browser back to, after verification.
 * No network call: the provider's reply is in the URL itself, after `#` (or `?`).
 */
import { IdentityIssuanceError } from '../shared/errors.js';
import { httpUrlOrNull } from '../shared/inputs.js';

/** The provider's error from the callback: JSON {"error":{"code","detail"}}, or plain text. */
function providerError(raw) {
  let code;
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    const error = parsed?.error ?? parsed;
    code = typeof error?.code === 'string' ? error.code : undefined;
    detail = typeof error?.detail === 'string' ? error.detail : raw;
  } catch {
    // not JSON: keep the raw text as the detail
  }
  return new IdentityIssuanceError(
    `The identity provider reported an error${code ? ` (${code})` : ''}${detail ? `: ${detail}` : '.'}`,
    { reason: 'provider-error', code, detail },
  );
}

/**
 * The provider's reply in a callback address: on success a `code_uri`, where the issued identity
 * can be collected.
 *
 * @param {string} callbackUrl  the full URL the browser arrived at (the redirectUri plus the provider's reply)
 * @returns {{ codeUri: string }}
 * @throws {IdentityIssuanceError} With reason 'provider-error' if the provider reported an error.
 * @throws {Error} If the URL holds neither a code_uri nor a provider error.
 */
export function parseIdentityCallback(callbackUrl) {
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error('callbackUrl must be the absolute URL the provider sent the browser to.');
  }
  const reply = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
  if (reply.has('error')) throw providerError(reply.get('error'));
  if (!reply.has('code_uri')) {
    throw new Error('The callback holds neither a code_uri nor an error from the identity provider.');
  }
  const codeUri = httpUrlOrNull(reply.get('code_uri'));
  if (!codeUri) throw new Error("The callback's code_uri is not an absolute HTTP(S) URL.");
  return { codeUri };
}
