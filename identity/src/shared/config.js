/**
 * Public presets. `useMainnetKeyDerivation` has the same name and meaning as in
 * @concordium/wdk-wallet-concordium, so both packages derive keys from the same
 * tree; the wallet-proxy publishes the identity providers and the network's
 * cryptographic parameters. The derivation flag does not verify the connected network.
 */
export const CONCORDIUM_MAINNET_IDENTITY_CONFIG = {
  useMainnetKeyDerivation: true,
  walletProxyUrl: 'https://wallet-proxy.mainnet.concordium.software',
};

export const CONCORDIUM_TESTNET_IDENTITY_CONFIG = {
  useMainnetKeyDerivation: false,
  walletProxyUrl: 'https://wallet-proxy.testnet.concordium.com',
};

function parseHttpUrl(value, field) {
  try {
    if (typeof value !== 'string' || !value.trim()) throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
    return url;
  } catch {
    // Do not echo configuration URLs: they may contain credentials.
    throw new Error(`config.${field} must be an absolute HTTP(S) URL.`);
  }
}

/** Validate the identity configuration, without contacting any services. */
export function parseIdentityConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('A configuration with useMainnetKeyDerivation and walletProxyUrl is required.');
  }
  if (typeof config.useMainnetKeyDerivation !== 'boolean') {
    throw new Error('config.useMainnetKeyDerivation is required and must be a boolean.');
  }
  const proxy = parseHttpUrl(config.walletProxyUrl, 'walletProxyUrl');
  if (proxy.username || proxy.password || proxy.search || proxy.hash) {
    throw new Error('config.walletProxyUrl must not contain credentials, query parameters, or fragments.');
  }
  return {
    ...config,
    // The SDK's ConcordiumHdWallet takes the derivation network by name.
    derivationNetwork: config.useMainnetKeyDerivation ? 'Mainnet' : 'Testnet',
    // A base path is allowed (e.g. a proxy mounted under /concordium); paths are joined onto it.
    walletProxyUrl: proxy.origin + proxy.pathname.replace(/\/+$/, ''),
  };
}
