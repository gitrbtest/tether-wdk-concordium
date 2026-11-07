/**
 * Shared test helpers. Network data comes from the recorded fixtures in
 * test/fixtures (re-captured with `npm run fixtures`), so unit tests never
 * contact a service.
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';

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

// ─── Proofs: a wallet holding the recorded identity, and a pretend node with its account 0 ────────────────────

/** The recorded identity: the public "abandon" test phrase, provider 0, identity 334563111 (testnet, Phase 1). */
export const RECORDED_IDENTITY = { providerIndex: 0, identityIndex: 334563111 };
const RECORDED_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED_CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';

/** The recorded identity's account 0 as stored on chain: { address, credId, issuer, commitments }. */
export function recordedAccount0() {
  return readFixture('account-commitments.testnet.json');
}

/**
 * A wallet holding the recorded identity (the test provider's made-up details: John Doe, born 1970-01-01, lives in
 * DK, nationality DK, national ID N-1234), with the network answered from recordings. `details` replaces some of
 * those details in the wallet's copy (e.g. { countryOfResidence: 'US' }), to try an identity that cannot answer.
 * `node` replaces the pretend node (see recordedNode).
 */
export async function walletWithRecordedIdentity({ details, node } = {}) {
  const { ConcordiumIdentity } = await import('@concordium/wdk-identity-concordium');
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => {
    if (url !== RECORDED_CODE_URI) return recorded.fetch(url, options);
    const issued = readFixture('identity-done.testnet.json');
    Object.assign(issued.token.identityObject.value.attributeList.chosenAttributes, details);
    return { ok: true, status: 200, json: async () => issued };
  };
  const wallet = new ConcordiumIdentity(RECORDED_PHRASE, testnetConfig(node ? { node } : {}), { fetch });
  await wallet.waitForIdentity(RECORDED_CODE_URI, { ...RECORDED_IDENTITY, intervalMs: 1 });
  return wallet;
}

/**
 * A pretend Concordium node with the recorded account 0's record on it, as recorded from testnet. `validTo` /
 * `createdAt` (YYYYMM) set the identity's validity as the chain holds it; `commitments` replaces the sealed details;
 * `fail` makes every question to the node fail with that gRPC code. Counts the questions asked (`asked`).
 */
export async function pretendNode({ validTo = '202709', createdAt = '202609', commitments, fail, now = new Date('2026-11-03T12:00:00Z') } = {}) {
  const sdk = await import('@concordium/web-sdk');
  const account = recordedAccount0();
  const node = {
    asked: 0,
    async getAccountInfo(credId) {
      node.asked++;
      if (fail) throw Object.assign(new Error('the node is unreachable'), { name: 'RpcError', code: fail });
      if (credId.credId !== account.credId) {
        throw Object.assign(new Error('account or block not found.'), { name: 'RpcError', code: 'NOT_FOUND' });
      }
      return {
        accountAddress: sdk.AccountAddress.fromBase58(account.address),
        accountCredentials: { 0: { v: 0, value: { type: 'normal', contents: {
          credId: account.credId, ipIdentity: account.issuer, policy: { createdAt, validTo, revealedAttributes: {} },
          commitments: { cmmAttributes: commitments ?? account.commitments } } } } },
      };
    },
    async getBlockInfo() { return { blockSlotTime: now }; },
    async getCryptographicParameters() { return globalFixture('testnet').value; },
  };
  return node;
}

// ---- The identity configuration, with the recorded provider list (the package does not fetch it) -----------

/**
 * A preset configuration plus the recorded identity provider list (`identityProviders`), as a wallet would pass it.
 * `overrides` replaces fields, e.g. { identityProviders: anEditedList }.
 * @param {'testnet' | 'mainnet'} network
 */
export async function identityConfig(network, overrides = {}) {
  const { CONCORDIUM_TESTNET_IDENTITY_CONFIG, CONCORDIUM_MAINNET_IDENTITY_CONFIG } = await import('../index.js');
  const preset = network === 'mainnet' ? CONCORDIUM_MAINNET_IDENTITY_CONFIG : CONCORDIUM_TESTNET_IDENTITY_CONFIG;
  return { ...preset, identityProviders: ipInfoFixture(network), node: recordedNode(network), ...overrides };
}

/** The node's "not found" answer, as the SDK's gRPC client throws it. */
export const notFoundError = () => Object.assign(new Error('account or block not found.'), { name: 'RpcError', code: 'NOT_FOUND' });

/** Transaction statuses as a node gives them (getBlockItemStatus), for scripting a pretend node. */
export const nodeStatus = {
  received: () => ({ status: 'received' }),
  committed: () => ({ status: 'committed', outcomes: [] }),
  /** Final; `type` 'accountCreation' means the account was created. */
  finalized: (blockHashHex = 'b1'.repeat(32), type = 'accountCreation') => ({
    status: 'finalized', outcome: { blockHash: sdk.BlockHash.fromHexString(blockHashHex), summary: { type } },
  }),
};

/**
 * A pretend Concordium node for one network, answering from recordings and scripts. What each option does:
 *   parameters, fail     the cryptographic parameters it gives (default: recorded), or an error to throw instead
 *   accountExists        (address) => true | false | Error: whether an account exists (default: none does)
 *   send                 sending a credential: an Error to throw (e.g. the node refusing it), or a function to call
 *                        (default: accepted, with transaction hash `hash`)
 *   statuses             answers to the status checks, in order; the last repeats. Each is a nodeStatus value,
 *                        'absent' (the node does not know it), or an Error (the node unreachable). Default: final, created.
 * It records what it was asked: calls (parameters), accountsAsked (addresses), sent (credentials), statusCalls.
 */
export function recordedNode(network, { parameters, fail, accountExists, send, statuses, hash = 'ab'.repeat(32) } = {}) {
  const node = {
    calls: 0, accountsAsked: [], sent: [], statusCalls: 0,
    async getCryptographicParameters() {
      node.calls++;
      if (fail) throw fail;
      return parameters ?? globalFixture(network).value;
    },
    async getAccountInfo(address) {
      const text = address?.address ?? String(address);
      node.accountsAsked.push(text);
      const answer = accountExists ? await accountExists(text) : false;
      if (answer instanceof Error) throw answer;
      if (!answer) throw notFoundError();
      return { accountAddress: address };
    },
    async sendCredentialDeploymentTransaction(payload, expiry) {
      node.sent.push({ payload, expiry });
      if (send instanceof Error) throw send;
      if (typeof send === 'function') return send();
      return sdk.TransactionHash.fromHexString(hash);
    },
    async getBlockItemStatus() {
      const list = statuses ?? [nodeStatus.finalized()];
      const answer = list[Math.min(node.statusCalls++, list.length - 1)];
      if (answer instanceof Error) throw answer;
      if (answer === 'absent') throw notFoundError();
      return answer;
    },
  };
  return node;
}

/** The testnet configuration with the recorded provider list and a recorded node (synchronous: for constructors). */
export function testnetConfig(overrides = {}) {
  return {
    useMainnetKeyDerivation: false, identityProviders: ipInfoFixture('testnet'), node: recordedNode('testnet'), ...overrides,
  };
}

/** The mainnet configuration with the recorded provider list and a recorded node. */
export function mainnetConfig(overrides = {}) {
  return {
    useMainnetKeyDerivation: true, identityProviders: ipInfoFixture('mainnet'), node: recordedNode('mainnet'), ...overrides,
  };
}

/**
 * For live tests: the testnet configuration with the LIVE provider list, fetched from the wallet-proxy as a wallet
 * would (the package does not fetch it), and a real testnet node connection, so a change on the network shows up.
 */
export async function liveTestnetConfig(overrides = {}) {
  const config = testnetConfig();
  const response = await fetch('https://wallet-proxy.testnet.concordium.com/v1/ip_info');
  if (!response.ok) throw new Error(`The wallet-proxy answered HTTP ${response.status} for the identity provider list.`);
  const { ConcordiumGRPCNodeClient, credentials } = await import('@concordium/web-sdk/nodejs');
  const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
  return { ...config, identityProviders: await response.json(), node, ...overrides };
}
