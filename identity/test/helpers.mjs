/**
 * Shared test helpers. Network data comes from the recorded fixtures in
 * test/fixtures (re-captured with `npm run fixtures`), so unit tests never
 * contact a service.
 */
import { readFileSync } from 'node:fs';

/**
 * A recorded wallet-proxy /v1/ip_info response. Parsed fresh on every call,
 * so a test that edits it cannot affect another test.
 * @param {'testnet' | 'mainnet'} network
 */
export function ipInfoFixture(network) {
  const file = new URL(`./fixtures/ip_info.${network}.v1.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * A fake `fetch` that answers <any wallet-proxy>/v1/ip_info with `body`
 * (by default, the recorded list of `network`) and records every requested URL
 * in `requests`. Any other URL throws, so an unexpected request is caught.
 * @param {'testnet' | 'mainnet'} network
 */
export function ipInfoFetch(network, body = ipInfoFixture(network)) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    if (!String(url).endsWith('/v1/ip_info')) throw new Error(`ipInfoFetch has no answer for ${url}`);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, requests };
}
