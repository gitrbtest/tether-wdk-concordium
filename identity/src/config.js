/** Public wallet-proxy presets. Identity providers and their addresses are read from the wallet-proxy. */
export const CONCORDIUM_MAINNET_IDENTITY_CONFIG = {
  walletProxyUrl: 'https://wallet-proxy.mainnet.concordium.software',
};

export const CONCORDIUM_TESTNET_IDENTITY_CONFIG = {
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
    throw new Error('A configuration with walletProxyUrl is required.');
  }
  const proxy = parseHttpUrl(config.walletProxyUrl, 'walletProxyUrl');
  if (proxy.username || proxy.password || proxy.search || proxy.hash) {
    throw new Error('config.walletProxyUrl must not contain credentials, query parameters, or fragments.');
  }
  // A base path is allowed (e.g. a proxy mounted under /concordium); paths are joined onto it.
  return { ...config, walletProxyUrl: proxy.origin + proxy.pathname.replace(/\/+$/, '') };
}
