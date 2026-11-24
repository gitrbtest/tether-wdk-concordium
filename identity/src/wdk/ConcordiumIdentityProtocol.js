/**
 * Concordium's identity protocol for WDK: proving facts to websites from an account, behind WDK's `IdentityProtocol`
 * interface (from `@tetherto/wdk-wallet/protocols`). A WDK app registers it with `wdk.registerIdentityProtocol`; WDK
 * builds it for an account with the chain's identity manager (a `ConcordiumIdentityManager`), which holds the identity.
 *
 *   account.getIdentityProtocol('concordium-id')
 *     │  WDK passes the account and the identity manager
 *     ▼
 *   describeRequest(request)  describeProofRequest + describeProofContext: what the website asks, for the consent screen
 *   prove(request)            the account's path '<provider>/<identity>/<account>' → the manager proves from that account
 */
import { IdentityProtocol, IdentityError, IdentityErrorReason } from '@tetherto/wdk-wallet/protocols';
import { describeProofRequest, describeProofContext } from '../proofs/proof-request.js';
import { asIdentityError } from './ConcordiumIdentityManager.js';

/** An account's path, '<providerIndex>/<identityIndex>/<credNumber>' (as the Concordium wallet module gives it). */
function readPath(path) {
  const parts = String(path ?? '').split('/');
  const numbers = parts.map(Number);
  if (parts.length !== 3 || !numbers.every(Number.isSafeInteger)) {
    throw new IdentityError(`Not a Concordium account path: ${JSON.stringify(path)} (expected '<provider>/<identity>/<account>').`,
      { reason: IdentityErrorReason.IDENTITY_NOT_FOUND });
  }
  const [providerIndex, identityIndex, credNumber] = numbers;
  return { identity: { providerIndex, identityIndex }, credNumber };
}

export default class ConcordiumIdentityProtocol extends IdentityProtocol {
  /** What a website asks, for the user's consent: no answer is built. */
  async describeRequest(request) {
    return asIdentityError(async () => {
      const { website, purpose } = describeProofContext(request);
      const asks = describeProofRequest(request).flatMap((part) => part.asks.map(({ kind, attribute, text }) => ({
        kind: kind === 'reveal' ? 'reveal' : 'prove', attribute, text,
      })));
      return { ...(website ? { requester: website } : {}), ...(purpose ? { purpose } : {}), asks };
    });
  }

  /** Proves from this account, through the identity manager that holds the account's identity. */
  async prove(request) {
    if (typeof this._identityManager?.proveFromAccount !== 'function') {
      throw new IdentityError('No Concordium identity manager: register one with wdk.registerIdentity first.',
        { reason: IdentityErrorReason.IDENTITY_NOT_FOUND });
    }
    const { identity, credNumber } = readPath(this._account.path);
    return this._identityManager.proveFromAccount(identity, request, credNumber);
  }
}
