import { readProviderList } from '../providers/provider-list.js';
import { requireNode } from '../chain/ChainNode.js';

/**
 * Public presets. `useMainnetKeyDerivation` has the same name and meaning as in
 * @concordium/wdk-wallet-concordium, so both packages derive keys from the same tree. The wallet adds the two things
 * that are its own: the identity provider list (identityProviders, e.g. fetched from the wallet-proxy's /v2/ip_info)
 * and its connection to a Concordium node (node). The derivation flag does not verify the connected network.
 */
export const CONCORDIUM_MAINNET_IDENTITY_CONFIG = {
  useMainnetKeyDerivation: true,
};

export const CONCORDIUM_TESTNET_IDENTITY_CONFIG = {
  useMainnetKeyDerivation: false,
};

/** Validate the identity configuration, without contacting any services. */
export function parseIdentityConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('A configuration with useMainnetKeyDerivation, identityProviders and node is required.');
  }
  if ('walletProxyUrl' in config) {
    throw new Error('config.walletProxyUrl is no longer used: the package talks to the chain only through your node '
      + 'connection (config.node). Remove it; get the identity provider list your own way and pass it as identityProviders.');
  }
  if (typeof config.useMainnetKeyDerivation !== 'boolean') {
    throw new Error('config.useMainnetKeyDerivation is required and must be a boolean.');
  }
  return {
    ...config,
    // The identity provider list the wallet passed in, checked (the package does not fetch it).
    identityProviders: readProviderList(config.identityProviders),
    // The wallet's connection to a Concordium node, checked to have the methods the package calls.
    node: requireNode(config.node),
    // The SDK's ConcordiumHdWallet takes the derivation network by name.
    derivationNetwork: config.useMainnetKeyDerivation ? 'Mainnet' : 'Testnet',
  };
}
