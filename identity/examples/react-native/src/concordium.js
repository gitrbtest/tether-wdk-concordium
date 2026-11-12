/**
 * The identity package, set up for a phone (testnet): the provider list, the wallet's node connection over gRPC-web
 * (the phone's kind of node client), and Concordium's native cryptography plugged in (see modules/concordium-native).
 */
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, IdentityProviders, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { nativeConcordiumCryptography } from '../modules/concordium-native';

/** Where the identity provider's page sends the browser back: this app's own address (see "scheme" in app.json). */
export const RETURN_ADDRESS = 'concordiumwdkexample://identity/return';

export const node = new sdk.ConcordiumGRPCWebClient('https://grpc.testnet.concordium.com', 20000, { timeout: 15000 });

let providerList; // fetched once per app start
export async function identityProviders() {
  providerList ??= await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
  return providerList;
}

/** The identity object for this seed phrase. Dispose of it when the wallet locks or the app stops. */
export async function identityFor(seedPhrase) {
  const config = { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders: await identityProviders(), node };
  return new ConcordiumIdentity(seedPhrase, config, { cryptography: nativeConcordiumCryptography });
}

/** The providers a person can verify with: identities of people, with a verification page. */
export async function personProviders() {
  const all = await new IdentityProviders(await identityProviders()).list();
  return all.filter((p) => p.kind === 'person' && p.issuanceStart);
}

/** An account's CCD balance, read from the node (in CCD). */
export async function ccdBalance(address) {
  const info = await node.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  return sdk.CcdAmount.toCcd(info.accountAmount).toString();
}
