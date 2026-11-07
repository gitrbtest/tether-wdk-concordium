/**
 * @concordium/wdk-wallet-concordium
 * -------------------------------------------------------------------
 * Entry point. Mirrors the shape of the other WDK wallet modules:
 * the default export is the WalletManager class that WDK registers.
 *
 *   import WDK from '@tetherto/wdk'
 *   import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium'
 *
 *   const wdk = new WDK(seedPhrase)
 *     .registerWallet('concordium', WalletManagerConcordium, CONCORDIUM_TESTNET_CONFIG)
 *
 *   const account = await wdk.getAccountByPath('concordium', '0/0/0')
 *   console.log(await account.getAddress(), await account.getBalance())
 */

import WalletManagerConcordium from './src/WalletManagerConcordium.js';
import WalletAccountConcordium, { AccountNotCreatedError, TransactionRejectedError, ConcordiumTransferErrorReason, ConcordiumTransferError } from './src/WalletAccountConcordium.js';

export { CONCORDIUM_MAINNET_CONFIG, CONCORDIUM_TESTNET_CONFIG } from './src/config.js';

export default WalletManagerConcordium;
export { WalletManagerConcordium, WalletAccountConcordium, AccountNotCreatedError, TransactionRejectedError, ConcordiumTransferErrorReason, ConcordiumTransferError };
