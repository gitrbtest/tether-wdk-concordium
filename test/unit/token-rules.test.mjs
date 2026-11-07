/**
 * Token rules (regulated tokens): getTokenRules and getTokenAccountStatus, offline. A pretend node replays what the
 * testnet node said about three real tokens and two accounts (test/fixtures/plt.testnet.json, recorded by
 * capture-plt.mjs); a test can change one thing on it (a paused token, an account put on a deny list).
 *
 * Who is who:
 *   WALLET        the test account (public test phrase, identity 899424164, account 0): holds TN, on no UPEU list
 *   PRETEND NODE  the recorded tokens: UPEU (allow list + deny list), EURQ (deny list), TN (no lists); and the
 *                 recorded accounts: the test account, and UPEU's governance account (on UPEU's allow list)
 *
 *   WALLET                                           PRETEND NODE
 *   ──────                                           ────────────
 *   1. getTokenRules(token) ───────────────────────► the token's state: paused? allow list? deny list? …
 *                                                    (an unknown token: InvalidTokenError; CIS-2: rules not known)
 *   2. getTokenAccountStatus(token, address) ──────► the account's entry for the token: balance, on the lists?
 *                                                    (an account not on chain: exists false, balance 0)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import * as plt from '@concordium/web-sdk/plt';
import { InvalidTokenError } from '@tetherto/wdk-wallet';
import { makeManager, CONFIG, KNOWN_ADDRESS } from '../helpers.mjs';

const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/plt.testnet.json', import.meta.url), 'utf8'));
const GOVERNANCE = RECORDED.upeuGovernance;
const NOT_ON_CHAIN = sdk.getAccountAddress('00'.repeat(48)).toString(); // a valid address no account has
const notFound = (what) => Object.assign(new Error(`${what} not found.`), { name: 'RpcError', code: 'NOT_FOUND' });

/** A recorded token's state, changed by `change` (e.g. { paused: true }), as CBOR. */
function tokenState(id, change = {}) {
  const state = plt.Cbor.decode(plt.Cbor.fromHexString(RECORDED.tokens[id].moduleState), 'TokenModuleState');
  return plt.Cbor.encode({ ...state, ...change });
}

/**
 * A pretend node answering from the recordings. `tokens` changes a token's state ({ UPEU: { paused: true } });
 * `accounts` adds or replaces an account's token entries ({ address: [{ id, balance, moduleState: { denyList: true } }] }).
 */
function recordedNode({ tokens = {}, accounts = {} } = {}) {
  return {
    async getTokenInfo(tokenId) {
      const id = Object.keys(RECORDED.tokens).find((t) => t.toLowerCase() === tokenId.value.toLowerCase());
      if (!id) throw notFound('tokenId or block');
      const r = RECORDED.tokens[id];
      return {
        id: plt.TokenId.fromString(id),
        state: {
          decimals: r.decimals,
          moduleRef: plt.TokenModuleReference.fromHexString(r.moduleRef),
          totalSupply: plt.TokenAmount.create(BigInt(r.totalSupply), r.decimals),
          moduleState: tokenState(id, tokens[id]),
        },
      };
    },
    async getAccountInfo(address) {
      const text = address.address ?? String(address);
      const entries = accounts[text] ?? RECORDED.accounts[text];
      if (!entries) throw notFound('account or block');
      return {
        accountAddress: sdk.AccountAddress.fromBase58(text),
        accountTokens: entries.map((e) => ({
          id: plt.TokenId.fromString(e.id),
          state: {
            balance: plt.TokenAmount.create(BigInt(e.balance), RECORDED.tokens[e.id].decimals),
            moduleState: typeof e.moduleState === 'string' ? plt.Cbor.fromHexString(e.moduleState) : plt.Cbor.encode(e.moduleState ?? {}),
          },
        })),
      };
    },
  };
}

/** The test account, with its node replaced by `node`. */
async function testAccount(node) {
  const manager = makeManager(CONFIG);
  const account = await manager.getAccountByPath('0/899424164/0');
  account._getClient = async () => node;
  return { account, dispose: () => manager.dispose() };
}

// Step 1.
test('getTokenRules: a token with an allow list and a deny list (UPEU), as the chain holds it', async () => {
  const { account, dispose } = await testAccount(recordedNode());
  assert.deepEqual(await account.getTokenRules('UPEU'), {
    kind: 'plt', token: 'UPEU', name: 'Upwood Test Euro', decimals: 6, totalSupply: 1000000000000n,
    paused: false, allowList: true, denyList: true, mintable: true, burnable: true,
    governanceAccount: GOVERNANCE,
    metadataUrl: 'https://indigo-sparkling-pelican-161.mypinata.cloud/ipfs/bafkreifbz2ym57tk6735rd4lpudq6ow7yhi4lbzhl4n2lgqrxe3i7zxkui',
  });
  dispose();
});

// Step 1.
test('getTokenRules: a deny list only (EURQ); no lists (TN); "plt:" and any letter case name the same token', async () => {
  const { account, dispose } = await testAccount(recordedNode());
  const eurq = await account.getTokenRules('EURQ');
  assert.deepEqual([eurq.allowList, eurq.denyList, eurq.paused], [false, true, false]);
  const tn = await account.getTokenRules('plt:tn');
  assert.deepEqual([tn.token, tn.allowList, tn.denyList, tn.paused], ['TN', false, false, false]);
  dispose();
});

// Step 1.
test('getTokenRules: a paused token says so', async () => {
  const { account, dispose } = await testAccount(recordedNode({ tokens: { UPEU: { paused: true } } }));
  assert.equal((await account.getTokenRules('UPEU')).paused, true);
  dispose();
});

// Step 1.
test('getTokenRules: an unknown token is InvalidTokenError; a CIS-2 token has no standard rules (all null)', async () => {
  const { account, dispose } = await testAccount(recordedNode());
  await assert.rejects(account.getTokenRules('NOPE42'), (e) => e instanceof InvalidTokenError && /no protocol-level token "NOPE42"/.test(e.message));
  const cis2 = await account.getTokenRules('cis2:12754:0:01');
  assert.equal(cis2.kind, 'cis2');
  assert.deepEqual([cis2.paused, cis2.allowList, cis2.denyList], [null, null, null], 'its contract decides, when transferring');
  dispose();
});

// Step 1: the node down is not mistaken for "no such token".
test('getTokenRules: a node that cannot be asked is reported as it is, not as an unknown token', async () => {
  const down = { async getTokenInfo() { throw Object.assign(new Error('connection refused'), { code: 'UNAVAILABLE' }); } };
  const { account, dispose } = await testAccount(down);
  await assert.rejects(account.getTokenRules('UPEU'), (e) => !(e instanceof InvalidTokenError) && /connection refused/.test(e.message));
  dispose();
});

// Step 2.
test('getTokenAccountStatus: the governance account is on UPEU\'s allow list; this account is on no list', async () => {
  const { account, dispose } = await testAccount(recordedNode());
  assert.deepEqual(await account.getTokenAccountStatus('UPEU', GOVERNANCE), {
    token: 'UPEU', address: GOVERNANCE, exists: true, balance: 941200000000n, onAllowList: true, onDenyList: false,
  });
  assert.deepEqual(await account.getTokenAccountStatus('UPEU'), {
    token: 'UPEU', address: KNOWN_ADDRESS, exists: true, balance: 0n, onAllowList: false, onDenyList: false,
  }, 'default: this account; it never held UPEU');
  dispose();
});

// Step 2.
test('getTokenAccountStatus: a token without lists reads null for them; a deny-listed account says so', async () => {
  const denied = { [KNOWN_ADDRESS]: [{ id: 'EURQ', balance: '5000000', moduleState: { denyList: true } }] };
  const { account, dispose } = await testAccount(recordedNode({ accounts: denied }));
  const tn = await account.getTokenAccountStatus('TN', GOVERNANCE);
  assert.deepEqual([tn.balance, tn.onAllowList, tn.onDenyList], [0n, null, null]);
  const eurq = await account.getTokenAccountStatus('EURQ');
  assert.deepEqual([eurq.balance, eurq.onAllowList, eurq.onDenyList], [5000000n, null, true], 'EURQ keeps no allow list');
  dispose();
});

// Step 2.
test('getTokenAccountStatus: an account not on chain: exists false, balance 0, on no list', async () => {
  const { account, dispose } = await testAccount(recordedNode());
  assert.deepEqual(await account.getTokenAccountStatus('UPEU', NOT_ON_CHAIN), {
    token: 'UPEU', address: NOT_ON_CHAIN, exists: false, balance: 0n, onAllowList: false, onDenyList: false,
  });
  dispose();
});
