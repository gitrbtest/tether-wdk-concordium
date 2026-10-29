/**
 * The demo wallet's settings, from environment variables (all optional):
 *   PORT            the local port (default 4321; the provider sends the browser back to it)
 *   IDENTITY_INDEX  reuse an identity saved earlier instead of verifying a fresh one (default: a new random index)
 *   IDENTITY_STORE  folder for the encrypted identities (default ./demo-identities)
 *   FUNDING_SEED, FUNDING_PATH  a funding account for receiving and sending (default: TESTNET_SEED etc. read from
 *                   ../.env.testnet when that file exists). Without one, the demo runs in "no funding" mode.
 */
import { existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';

export const DEFAULT_PORT = 4321;

// Public demonstration phrase only. Never use it for anything of value.
export const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Reads the settings once, at start. Secrets (the funding seed) stay in the returned object, never in the page. */
export function readSettings(env = process.env) {
  const envFile = new URL('../../../.env.testnet', import.meta.url);
  if (!env.FUNDING_SEED && !env.TESTNET_SEED && existsSync(envFile) && process.loadEnvFile && env === process.env) {
    process.loadEnvFile(envFile);
  }
  const fundingSeed = env.FUNDING_SEED || env.TESTNET_SEED;
  const fundingPath = env.FUNDING_PATH
    || (env.TESTNET_PROVIDER_INDEX && `${env.TESTNET_PROVIDER_INDEX}/${env.TESTNET_IDENTITY_INDEX}/0`);
  const reuse = env.IDENTITY_INDEX !== undefined && env.IDENTITY_INDEX !== '';
  return {
    port: env.PORT ? Number(env.PORT) : DEFAULT_PORT,
    seedPhrase: DEMO_PHRASE,
    // A fresh identity each run (a real wallet would use 0, 1, 2…), or one saved earlier.
    identityIndex: reuse ? Number(env.IDENTITY_INDEX) : randomInt(1, 2 ** 31 - 1),
    reuseIdentity: reuse,
    storeFolder: env.IDENTITY_STORE || './demo-identities',
    funding: fundingSeed && fundingPath ? { seed: fundingSeed, path: fundingPath } : null,
  };
}
