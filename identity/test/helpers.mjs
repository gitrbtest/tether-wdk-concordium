/**
 * Shared test helpers. Network data comes from the recorded fixtures in
 * test/fixtures (re-captured with `npm run fixtures`), so unit tests never
 * contact a service.
 */
import { readFileSync } from 'node:fs';

const readFixture = (file) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));

/**
 * A recorded wallet-proxy /v1/ip_info response. Parsed fresh on every call,
 * so a test that edits it cannot affect another test.
 * @param {'testnet' | 'mainnet'} network
 */
export function ipInfoFixture(network) {
  return readFixture(`ip_info.${network}.v1.json`);
}

/**
 * A recorded wallet-proxy /v0/global response: the network's cryptographic
 * parameters, as `{ v, value }`. Parsed fresh on every call.
 * @param {'testnet' | 'mainnet'} network
 */
export function globalFixture(network) {
  return readFixture(`global.${network}.json`);
}

/**
 * A fake `fetch` standing in for one network's wallet-proxy. It answers
 * /v1/ip_info and /v0/global from the recorded fixtures, or from `overrides`
 * (e.g. a deliberately edited provider list), and records every requested URL
 * in `requests`. Any other URL throws, so an unexpected request is caught.
 * @param {'testnet' | 'mainnet'} network
 * @param {{ ipInfo?: unknown, global?: unknown }} [overrides]
 */
export function walletProxyFetch(network, overrides = {}) {
  const requests = [];
  const answers = {
    '/v1/ip_info': () => overrides.ipInfo ?? ipInfoFixture(network),
    '/v0/global': () => overrides.global ?? globalFixture(network),
  };
  const fetch = async (url) => {
    requests.push(url);
    const path = Object.keys(answers).find((p) => String(url).endsWith(p));
    if (!path) throw new Error(`walletProxyFetch has no answer for ${url}`);
    const body = answers[path]();
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, requests };
}
