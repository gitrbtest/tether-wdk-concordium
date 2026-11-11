/**
 * The ranges Concordium's key derivation supports. Outside them, Concordium's SDK does not refuse every number: it
 * silently reduces some (an account number of 9999 gives account 15's address, but not its signing key), so they
 * are checked here first.
 */
/** Provider and identity numbers: hardened steps of the key path. */
export const MAX_IDENTITY_COORDINATE = 2 ** 31 - 1;
/** Account numbers under an identity (the credential counter): one byte. */
export const MAX_CRED_NUMBER = 255;

/** Validate explicit identity coordinates before deriving keys or contacting services. */
export function validateIdentityCoordinates(providerIndex, identityIndex) {
  for (const [name, value] of Object.entries({ providerIndex, identityIndex })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} is required and must be a non-negative safe integer.`);
    }
    if (value > MAX_IDENTITY_COORDINATE) {
      throw new Error(`${name} must be at most ${MAX_IDENTITY_COORDINATE} (the largest Concordium's key derivation supports).`);
    }
  }
}

/** Validate an account number under an identity (the credential counter). */
export function validateCredNumber(credNumber, name = 'credNumber') {
  if (!Number.isSafeInteger(credNumber) || credNumber < 0 || credNumber > MAX_CRED_NUMBER) {
    throw new Error(`${name} must be an integer from 0 to ${MAX_CRED_NUMBER} (Concordium's account numbers under an identity).`);
  }
}
