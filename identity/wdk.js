/**
 * @concordium/wdk-identity-concordium/wdk
 * -------------------------------------------------------------------
 * The package for a WDK app: an identity manager and an identity protocol, behind the interfaces proposed for WDK
 * (`@tetherto/wdk-wallet`'s IdentityManager and IdentityProtocol). Needs those packages (a peer dependency).
 *
 *   wdk.registerIdentity('concordium', ConcordiumIdentityManager, identityConfig)
 *      .registerIdentityProtocol('concordium', 'concordium-id', ConcordiumIdentityProtocol)
 */
export { default as ConcordiumIdentityManager } from './src/wdk/ConcordiumIdentityManager.js';
export { default as ConcordiumIdentityProtocol } from './src/wdk/ConcordiumIdentityProtocol.js';
