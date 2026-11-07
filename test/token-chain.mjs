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
 * It records the questions asked (`asked`: method names, in order).
 */
export function tokenChain({ tokens = {}, accounts = {} } = {}) {
  const ratio = ({ numerator, denominator }) => ({ numerator: BigInt(numerator), denominator: BigInt(denominator) });
  const node = {
    asked: [],
    async getTokenInfo(tokenId) {
      node.asked.push('getTokenInfo');
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
  };
  return node;
}

/** The test account, with its node replaced by `node`. Call dispose() when done. */
export async function testAccount(node) {
  const manager = makeManager(CONFIG);
  const account = await manager.getAccountByPath('0/899424164/0');
  account._getClient = async () => node;
  return { account, dispose: () => manager.dispose() };
}
