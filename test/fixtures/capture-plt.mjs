/**
 * Record what the testnet node says about a few protocol-level tokens (PLTs) and accounts, for the offline token
 * rules tests (test/unit/token-rules.test.mjs). Read-only: nothing is sent, nothing is spent.
 *
 *   node test/fixtures/capture-plt.mjs
 *
 * Recorded (all public, on chain):
 *   UPEU  "Upwood Test Euro": an allow list and a deny list
 *   EURQ  a deny list only
 *   TN    no lists
 * and, for UPEU and TN, two accounts: the test account (public test phrase, identity 899424164, account 0: it
 * holds TN and is on no UPEU list) and UPEU's governance account (on UPEU's allow list).
 * The token state and each account's token state are kept as the node gives them (CBOR, as hex).
 */
import { writeFile } from 'node:fs/promises';
import * as sdk from '@concordium/web-sdk';
import * as plt from '@concordium/web-sdk/plt';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const TOKENS = ['UPEU', 'EURQ', 'TN'];
const TEST_ACCOUNT = '3GEmZc57STNxVqWykUceXAeCVsDzaogq6wNZhDLAV8bRNYzUYd';

const tokens = {};
for (const id of TOKENS) {
  const info = await node.getTokenInfo(plt.TokenId.fromString(id));
  tokens[id] = {
    decimals: info.state.decimals,
    moduleRef: plt.TokenModuleReference.toHexString(info.state.moduleRef),
    totalSupply: String(info.state.totalSupply.value),
    moduleState: plt.Cbor.toHexString(info.state.moduleState),
  };
}
const upeuGovernance = plt.Cbor.decode(plt.Cbor.fromHexString(tokens.UPEU.moduleState), 'TokenModuleState').governanceAccount.address.toString();

const accounts = {};
for (const address of [TEST_ACCOUNT, upeuGovernance]) {
  const info = await node.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  accounts[address] = info.accountTokens
    .filter((t) => TOKENS.includes(t.id.value))
    .map((t) => ({ id: t.id.value, balance: String(t.state.balance.value), moduleState: t.state.moduleState ? plt.Cbor.toHexString(t.state.moduleState) : null }));
}

await writeFile(new URL('./plt.testnet.json', import.meta.url),
  JSON.stringify({ recorded: new Date().toISOString(), tokens, accounts, testAccount: TEST_ACCOUNT, upeuGovernance }, null, 2) + '\n');
console.log(`Recorded ${TOKENS.join(', ')} and ${Object.keys(accounts).length} accounts.`);
