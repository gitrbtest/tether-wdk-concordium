/**
 * A pretend Concordium node for the token tests, answering from what the testnet node said about three real tokens
 * and two accounts (test/fixtures/plt.testnet.json, recorded by test/fixtures/capture-plt.mjs). A test can change one
 * thing on it: a token's state (e.g. paused), an account's entries (e.g. put on a deny list), or add an account.
 *
 * Recorded: UPEU (an allow list and a deny list), EURQ (a deny list), TN (no lists); the test account (public test
 * phrase, identity 899424164, account 0: holds TN and CCD, on no UPEU list) and UPEU's governance account (on UPEU's
 * allow list); the chain's fee rates.
 */
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import * as plt from '@concordium/web-sdk/plt';
import { makeManager, CONFIG } from './helpers.mjs';

export const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/plt.testnet.json', import.meta.url), 'utf8'));
export const TEST_ACCOUNT = RECORDED.testAccount;
export const UPEU_GOVERNANCE = RECORDED.upeuGovernance;
/** A valid address that no account has. */
export const NOT_ON_CHAIN = sdk.getAccountAddress('00'.repeat(48)).toString();

export const notFound = (what) => Object.assign(new Error(`${what} not found.`), { name: 'RpcError', code: 'NOT_FOUND' });

/** A recorded token's state, changed by `change` (e.g. { paused: true }), as CBOR. */
function tokenState(id, change = {}) {
  const state = plt.Cbor.decode(plt.Cbor.fromHexString(RECORDED.tokens[id].moduleState), 'TokenModuleState');
  return plt.Cbor.encode({ ...state, ...change });
}

/**
 * The pretend node. What each option does:
 *   tokens    changes a token's state: { UPEU: { paused: true } }
 *   accounts  adds an account or replaces one: { address: { ccd: '1000000', tokens: [{ id, balance, moduleState }] } },
 *             where moduleState is CBOR hex as recorded, or an object such as { denyList: true }; null: not on chain
 *   later     the chain changing in the moment after the wallet's own check (an issuer pausing the token, or
 *             changing a list): { afterTokenReads: 1, tokens, accounts } replaces `tokens` / `accounts` from the token's
 *             second read on (the transfer re-reads it); { afterSend: true, tokens, accounts } from the sending on
 *   outcome   what the chain says when a sent transaction is final: 'success' (default), or a reject reason
 *             (e.g. a TokenUpdateTransactionFailed one, see rejection())
 * It records the questions asked (`asked`: method names, in order) and the transactions sent (`sent`).
 */
export function tokenChain({ tokens: tokensAtFirst = {}, accounts: accountsAtFirst = {}, later, outcome = 'success' } = {}) {
  const ratio = ({ numerator, denominator }) => ({ numerator: BigInt(numerator), denominator: BigInt(denominator) });
  let tokenReads = 0;
  let sentAny = false;
  const changed = () => later && ((later.afterTokenReads !== undefined && tokenReads > later.afterTokenReads) || (later.afterSend && sentAny));
  const state = () => (changed()
    ? { tokens: { ...tokensAtFirst, ...later.tokens }, accounts: { ...accountsAtFirst, ...later.accounts } }
    : { tokens: tokensAtFirst, accounts: accountsAtFirst });
  const node = {
    asked: [],
    sent: [],
    async getTokenInfo(tokenId) {
      node.asked.push('getTokenInfo');
      tokenReads++;
      const { tokens } = state();
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
      node.asked.push('getAccountInfo');
      const { accounts } = state();
      const text = address.address ?? String(address);
      const account = text in accounts ? accounts[text] : RECORDED.accounts[text];
      if (!account) throw notFound('account or block');
      return {
        accountAddress: sdk.AccountAddress.fromBase58(text),
        accountAmount: sdk.CcdAmount.fromMicroCcd(BigInt(account.ccd ?? 0)),
        accountTokens: (account.tokens ?? []).map((e) => ({
          id: plt.TokenId.fromString(e.id),
          state: {
            balance: plt.TokenAmount.create(BigInt(e.balance), RECORDED.tokens[e.id].decimals),
            moduleState: typeof e.moduleState === 'string' ? plt.Cbor.fromHexString(e.moduleState) : plt.Cbor.encode(e.moduleState ?? {}),
          },
        })),
      };
    },
    async getBlockChainParameters() {
      node.asked.push('getBlockChainParameters');
      return { euroPerEnergy: ratio(RECORDED.feeRates.euroPerEnergy), microGTUPerEuro: ratio(RECORDED.feeRates.microGTUPerEuro) };
    },
    async getNextAccountNonce() {
      node.asked.push('getNextAccountNonce');
      return { nonce: sdk.SequenceNumber.create(7) };
    },
    async sendTransaction(transaction) { return node._send(transaction); },
    async sendAccountTransaction(transaction) { return node._send(transaction); },
    _send(transaction) {
      node.asked.push('send');
      node.sent.push(transaction);
      sentAny = true;
      return sdk.TransactionHash.fromHexString('5e'.repeat(32));
    },
    async waitForTransactionFinalization(hash) {
      node.asked.push('waitForTransactionFinalization');
      const summary = outcome === 'success'
        ? { type: 'accountTransaction', transactionType: 'tokenUpdate', cost: sdk.CcdAmount.fromMicroCcd(4647253n), hash }
        : { type: 'accountTransaction', transactionType: 'failed', rejectReason: outcome, cost: sdk.CcdAmount.fromMicroCcd(4647253n), hash };
      return { blockHash: sdk.BlockHash.fromHexString('b5'.repeat(32)), summary };
    },
  };
  return node;
}

/**
 * The chain's reject reason for a token transfer the token refused, as the node gives it: TokenUpdateTransactionFailed
 * with the token module's reason (`type`: e.g. 'operationNotPermitted', 'tokenBalanceInsufficient', 'addressNotFound')
 * and its details (`address`: the account it concerns; `reason`: the module's own words).
 */
export function rejection(tokenId, type, { address, reason, availableBalance, requiredBalance } = {}) {
  const details = { index: 0 };
  if (address) details.address = plt.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(address));
  if (reason) details.reason = reason;
  const decimals = RECORDED.tokens[tokenId].decimals;
  if (availableBalance !== undefined) details.availableBalance = plt.TokenAmount.create(BigInt(availableBalance), decimals);
  if (requiredBalance !== undefined) details.requiredBalance = plt.TokenAmount.create(BigInt(requiredBalance), decimals);
  return { tag: 'TokenUpdateTransactionFailed', contents: { tokenId: plt.TokenId.fromString(tokenId), type, details: plt.Cbor.encode(details) } };
}

/** The test account, with its node replaced by `node`. Call dispose() when done. */
export async function testAccount(node) {
  const manager = makeManager(CONFIG);
  const account = await manager.getAccountByPath('0/899424164/0');
  account._getClient = async () => node;
  return { account, dispose: () => manager.dispose() };
}
