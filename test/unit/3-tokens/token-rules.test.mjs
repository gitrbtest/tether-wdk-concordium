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
import { InvalidTokenError } from '@tetherto/wdk-wallet';
import { KNOWN_ADDRESS } from '../../helpers.mjs';
import { tokenChain, testAccount, UPEU_GOVERNANCE as GOVERNANCE, NOT_ON_CHAIN } from '../../token-chain.mjs';

// The pretend node (tokenChain) answers from the recorded testnet data; see test/token-chain.mjs.
const recordedNode = (options) => tokenChain(options);

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
  const denied = { [KNOWN_ADDRESS]: { ccd: '1000000', tokens: [{ id: 'EURQ', balance: '5000000', moduleState: { denyList: true } }] } };
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
