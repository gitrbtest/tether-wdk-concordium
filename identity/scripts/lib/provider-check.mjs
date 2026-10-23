/**
 * Live check of identity providers: build a real identity request for a
 * provider and open its link, following the provider's redirects one at a time
 * (never to the return address), to see whether it serves its verification
 * page or answers with an error. Used by `npm run check:providers` and the
 * integration test. Nothing is filled in and no identity is issued, but each
 * accepted check opens a verification session at the provider.
 *
 * Not part of the published package.
 */
import { randomBytes } from 'node:crypto';
import { ConcordiumIdentity, IdentityProviders, IdentityProviderError } from '../../index.js';

/** The return address sent with check requests. Nothing listens there; the check never goes there. */
export const CHECK_REDIRECT_URI = 'http://localhost:4000/callback';

const MAX_REDIRECTS = 5;
const snippet = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 160);

/**
 * Check one provider.
 * @returns {Promise<{ outcome: 'accepted' | 'provider-error' | 'http-error' | 'unreachable' | 'no-issuance-address', detail: string }>}
 *   'accepted': the provider served its verification page (detail: that page's host).
 */
export async function checkProvider(identity, providerIndex, { fetch: fetchFn = fetch } = {}) {
  let issuanceUrl;
  try {
    ({ issuanceUrl } = await identity.createIdentityRequest({ providerIndex, redirectUri: CHECK_REDIRECT_URI }));
  } catch (e) {
    if (e instanceof IdentityProviderError) return { outcome: 'no-issuance-address', detail: e.message };
    throw e;
  }

  // Follow the provider's redirects one at a time (never to our own return address),
  // until it serves its verification page or answers otherwise.
  let url = issuanceUrl;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await fetchFn(url, { redirect: 'manual' });
    } catch (e) {
      return { outcome: 'unreachable', detail: `${new URL(url).host}: ${e.cause?.code ?? e.message}` };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { outcome: 'http-error', detail: `HTTP ${response.status} without a location` };
      const next = new URL(location, url);
      // A redirect back to our own return address is the provider's answer, not its verification page.
      if (next.href.startsWith(CHECK_REDIRECT_URI)) return providerAnswer(identity, next.href);
      url = next.href;
      continue;
    }
    if (response.ok) return { outcome: 'accepted', detail: new URL(url).host };

    const body = await response.text().catch(() => '');
    return { outcome: 'http-error', detail: `HTTP ${response.status}${body ? ` ${snippet(body)}` : ''}` };
  }
  return { outcome: 'http-error', detail: `more than ${MAX_REDIRECTS} redirects` };
}

/** The provider sent the browser straight back to the return address: report its error. */
function providerAnswer(identity, callbackUrl) {
  try {
    identity.parseIdentityCallback(callbackUrl);
    return { outcome: 'provider-error', detail: 'returned to the return address without verification' };
  } catch (e) {
    return { outcome: 'provider-error', detail: e.message };
  }
}

/** Check every provider a network's wallet-proxy publishes, with a fresh random seed that is never stored. */
export async function checkNetwork(config, { fetch: fetchFn = fetch } = {}) {
  const providers = await new IdentityProviders(config, { fetch: fetchFn }).list();
  const identity = new ConcordiumIdentity(randomBytes(64), config, { fetch: fetchFn });
  try {
    const results = [];
    for (const { index, name } of providers) {
      results.push({ index, name, ...(await checkProvider(identity, index, { fetch: fetchFn })) });
    }
    return results;
  } finally {
    identity.dispose();
  }
}
