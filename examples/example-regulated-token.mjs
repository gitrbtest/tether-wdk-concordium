/**
 * A regulated token, from a wallet's side: see its rules, check a transfer before offering it, catch a blocked
 * transfer, and follow a transaction to final, the WDK way. On testnet; READ-ONLY: nothing is sent, nothing is spent.
 *
 * Some protocol-level tokens (PLTs) restrict who may hold or move them: an allow list (only accounts on it may send
 * or receive), a deny list (accounts on it may not), and a pause (no transfers at all). Their issuer manages these
 * rules; a wallet only reads them. This example:
 *   1. Reads a regulated token's rules (UPEU, "Upwood Test Euro": an allow list and a deny list).
 *   2. Reads this account's standing with it, and the recipient's.
 *   3. Checks a transfer before offering it: every reason it would be refused, nothing sent.
 *   4. Checks the same transfer of a token without rules (TN): it can go, with its fee.
 *   5. Tries the blocked transfer anyway, as an app might: refused before sending, with WDK's TransferError.
 *   6. Reads a transaction's status as WDK's standard receipt (a real one from testnet).
 *
 * Settings (environment variables, optional):
 *   REGULATED_TOKEN   default "UPEU"   a PLT with an allow list (another one on testnet: "USC", "eUSD", "EUDemo")
 *   PLAIN_TOKEN       default "TN"     a PLT without lists, that this account holds
 *   RECIPIENT         default: the regulated token's governance account (on its allow list)
 *
 * Run:  npm run example:regulated-token
 */

import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG, ConcordiumTransferError } from '../index.js';

// Public demonstration phrase only. Never use it for anything of value.
const TEST_SEED =
  'abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon about';

const REGULATED = process.env.REGULATED_TOKEN || 'UPEU';
const PLAIN = process.env.PLAIN_TOKEN || 'TN';
// A real testnet transaction, to read its status: a 100 CCD transfer made on 7 Nov 2026.
const A_TRANSACTION = 'd5e402bd149f56d9340b916b31156878bb671e289688c342f638adabce77173d';

const yesNo = (value) => (value === null ? 'n/a' : value ? 'yes' : 'no');

async function main() {
  const manager = new WalletManagerConcordium(TEST_SEED, { ...CONCORDIUM_TESTNET_CONFIG });
  try {
    const account = await manager.getAccountByPath('0/899424164/0');
    const me = await account.getAddress();
    console.log('This account:', me, '\n');

    // Step 1. The token's rules, as the chain holds them now. A wallet can show them, or decide what to offer.
    console.log(`1. The rules of ${REGULATED}`);
    const rules = await account.getTokenRules(REGULATED);
    console.log(`   ${rules.name ?? rules.token}: paused ${yesNo(rules.paused)}, allow list ${yesNo(rules.allowList)}, `
      + `deny list ${yesNo(rules.denyList)}`);
    console.log(`   managed by ${rules.governanceAccount}\n`);
    const recipient = process.env.RECIPIENT || rules.governanceAccount;

    // Step 2. Who may use it: this account, and the recipient. (n/a: the token keeps no such list.)
    console.log(`2. Standing with ${REGULATED}`);
    for (const [who, address] of [['this account', me], ['the recipient', recipient]]) {
      const s = await account.getTokenAccountStatus(REGULATED, address);
      console.log(`   ${who}: holds ${s.balance} base units; on the allow list ${yesNo(s.onAllowList)}, on the deny list ${yesNo(s.onDenyList)}`);
    }
    console.log();

    // Step 3. Before offering "Send": would it be refused, and why? Every reason at once; nothing is sent.
    console.log(`3. Can this account send 1 ${REGULATED} to the recipient? (checkTransfer, nothing sent)`);
    const blocked = await account.checkTransfer({ token: REGULATED, recipient, amount: 1000000n });
    console.log(`   ${blocked.ok ? '✔ yes' : '✖ no'}`);
    for (const r of blocked.reasons) console.log(`     ${r.reason}: ${r.message}`);
    console.log('   (a wallet would disable "Send" and show these reasons)\n');

    // Step 4. A token without rules: it can go.
    console.log(`4. Can this account send 1 ${PLAIN}? (a token without lists)`);
    const fine = await account.checkTransfer({ token: PLAIN, recipient, amount: 1000000n });
    console.log(`   ${fine.ok ? '✔ yes' : '✖ no'}, fee ${Number(fine.fee) / 1e6} CCD\n`);

    // Step 5. Trying the blocked transfer anyway: transfer checks first, so nothing is sent and no fee is spent. The
    // error is WDK's TransferError (ConcordiumTransferError), with the first reason and all of them.
    console.log(`5. Trying to send the ${REGULATED} anyway`);
    try {
      await account.transfer({ token: REGULATED, recipient, amount: 1000000n });
      console.log('   (it went through: this account is allowed after all)');
    } catch (e) {
      if (!(e instanceof ConcordiumTransferError)) throw e;
      console.log(`   ✖ refused before sending (${e.reason}): ${e.message}`);
      console.log(`   sent: ${e.hash ? `yes, ${e.hash}` : 'no, and no fee was charged'}\n`);
    }

    // Step 6. A transaction's status, in WDK's words (the same for every chain). waitForTransaction(hash) would wait
    // until it is final.
    console.log('6. A transaction\'s status, as WDK\'s standard receipt');
    const receipt = await account.getTransaction(A_TRANSACTION);
    console.log(`   ${receipt.finality}, success ${receipt.success}, fee ${Number(receipt.fee) / 1e6} CCD, block ${receipt.block}`);
  } finally {
    manager.dispose();
  }
}

main().catch((e) => { console.error('Unexpected failure:', e); process.exit(1); });
