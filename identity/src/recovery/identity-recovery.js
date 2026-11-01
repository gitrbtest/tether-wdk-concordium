/**
 * Getting an identity back from its provider, from the seed alone (scope part D). The wallet builds a
 * recovery request from the seed's keys and asks the provider's published recovery address; the provider
 * answers with the whole identity it issued (the same `{ v, value }` shape as at issuance), or 404 if it
 * never issued one for these keys. One request: no browser, no form, no waiting.
 */
import * as sdk from '@concordium/web-sdk';
import { IdentityRecoveryError } from '../shared/errors.js';
import { identityContent } from '../issuance/identity-object.js';
import { sleep } from '../shared/sleep.js';

const ATTEMPTS = 3;         // network failures and provider server errors are tried this many times in all
const RETRY_PAUSE_MS = 500; // the pause between tries

export function cancelledRecovery() {
  return new IdentityRecoveryError('Recovering the identity was cancelled.', { reason: 'cancelled' });
}

/**
 * The recovery request for one identity: a proof that the wallet holds the identity's secret key, for the
 * provider to look the identity up by. `now` is when it is made (the provider checks it is recent).
 *
 * @param {{ provider: { ipInfo: object }, globalContext: object, hdWallet: object, identityIndex: number,
 *   now?: number }} input
 * @returns {{ v: number, value: { idCredPub: string, timestamp: number, proof: string } }}
 */
export function recoveryRequest({ provider, globalContext, hdWallet, identityIndex, now = Date.now() }) {
  const secret = hdWallet.getIdCredSec(provider.ipInfo.ipIdentity, identityIndex);
  try {
    return sdk.createIdentityRecoveryRequestWithKeys({
      ipInfo: provider.ipInfo,
      globalContext,
      idCredSec: secret.toString('hex'),
      timestamp: Math.floor(now / 1000),
    });
  } finally {
    secret.fill(0);
  }
}

/** The address to ask: the provider's recovery address with the request as its `state`. */
export function recoveryLink(recoveryStart, idRecoveryRequest) {
  return `${recoveryStart}?${new URLSearchParams({ state: JSON.stringify({ idRecoveryRequest }) })}`;
}

/**
 * Ask the provider for the identity. Brief network failures and provider server errors (HTTP 5xx) are
 * tried again, up to ATTEMPTS times in all.
 *
 * @param {{ fetch: typeof fetch, url: string, signal?: AbortSignal }} options
 * @returns {Promise<object | null>}  the identity as the provider returned it (`{ v, value }`), or null if
 *   the provider has none for these keys (HTTP 404)
 * @throws {IdentityRecoveryError} reason 'provider-error', 'network' or 'cancelled'
 */
export async function askProviderForIdentity({ fetch, url, signal }) {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw cancelledRecovery();
    let response;
    try {
      response = await fetch(url, { signal });
    } catch (e) {
      if (signal?.aborted) throw cancelledRecovery();
      if (attempt >= ATTEMPTS) {
        throw new IdentityRecoveryError(`The identity provider could not be reached: ${e.message}`, { reason: 'network' });
      }
      await sleep(RETRY_PAUSE_MS, signal, cancelledRecovery);
      continue;
    }

    if (response.status === 404) return null;
    if (response.status >= 500 && attempt < ATTEMPTS) {
      await sleep(RETRY_PAUSE_MS, signal, cancelledRecovery);
      continue;
    }
    if (!response.ok) {
      const detail = await providerMessage(response);
      throw new IdentityRecoveryError(`The identity provider answered HTTP ${response.status}${detail ? `: ${detail}` : ''}.`,
        { reason: 'provider-error', status: response.status, detail });
    }

    let identityObject;
    try {
      identityObject = await response.json();
      identityContent(identityObject, 'not an identity');
    } catch {
      throw new IdentityRecoveryError('The identity provider answered with something that is not an identity.',
        { reason: 'provider-error', status: response.status });
    }
    return identityObject;
  }
}

/** The provider's own explanation of an error, if its reply has one (`{ message }`, as testnet providers send). */
async function providerMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.message === 'string' ? body.message : undefined;
  } catch {
    return undefined;
  }
}
