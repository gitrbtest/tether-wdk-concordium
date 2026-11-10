// Type-checked by test/unit/1-setup/types.test.mjs: the configuration's types accept Concordium's real node clients
// (Node.js and browser) and the presets, as a TypeScript wallet would write them.
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { ConcordiumGRPCWebClient } from '@concordium/web-sdk';

declare const identityProviders: any; // the fetched list, as JSON
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
new ConcordiumIdentity('seed phrase', { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });

const webNode = new ConcordiumGRPCWebClient('https://grpc.testnet.concordium.com', 20000);
new ConcordiumIdentity('seed phrase', { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node: webNode });
