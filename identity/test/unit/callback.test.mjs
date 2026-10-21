/** ConcordiumIdentity.parseIdentityCallback: reading the provider's reply from the return address; no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConcordiumIdentity,
  IdentityIssuanceError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RETURN = 'http://localhost:4000/callback';

/** A code_uri in the form the testnet identity provider sends (from a real issuance). */
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';

/** An error reply in the form a mainnet provider sent (detail shortened). */
const PROVIDER_ERROR = { error: { code: 'INVALID_REQUEST', detail: 'not authorized to perform: kms:Decrypt' } };

/** A fetch that fails the test if called: reading a callback must never use the network. */
const noNetwork = async (url) => { throw new Error(`unexpected request to ${url}`); };

function identity() {
  return new ConcordiumIdentity(TEST_PHRASE, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { fetch: noNetwork });
}

test('a success callback gives the code_uri to collect the identity from', () => {
  const callback = `${RETURN}#code_uri=${CODE_URI}`;
  assert.deepEqual(identity().parseIdentityCallback(callback), { codeUri: CODE_URI });
});

test('the code_uri is read whether it is encoded or not, after # or after ?', () => {
  for (const callback of [
    `${RETURN}#code_uri=${encodeURIComponent(CODE_URI)}`,
    `${RETURN}?code_uri=${encodeURIComponent(CODE_URI)}`,
    `concordium-wallet://identity/return#code_uri=${encodeURIComponent(CODE_URI)}`,
  ]) {
    assert.deepEqual(identity().parseIdentityCallback(callback), { codeUri: CODE_URI }, callback);
  }
});

test("a provider's error reply becomes an IdentityIssuanceError with its code and detail", () => {
  const callback = `${RETURN}#error=${encodeURIComponent(JSON.stringify(PROVIDER_ERROR))}`;
  assert.throws(() => identity().parseIdentityCallback(callback), (e) => {
    assert.ok(e instanceof IdentityIssuanceError);
    assert.equal(e.reason, 'provider-error');
    assert.equal(e.code, 'INVALID_REQUEST');
    assert.equal(e.detail, 'not authorized to perform: kms:Decrypt');
    assert.match(e.message, /reported an error \(INVALID_REQUEST\); no identity was issued/);
    return true;
  });
});

test('an error reply that is not JSON keeps the text as the detail', () => {
  assert.throws(() => identity().parseIdentityCallback(`${RETURN}#error=access_denied`), (e) =>
    e instanceof IdentityIssuanceError && e.reason === 'provider-error' && e.code === undefined
    && e.detail === 'access_denied');
});

test('a callback with neither a code_uri nor an error is rejected', () => {
  for (const callback of [RETURN, `${RETURN}#`, `${RETURN}#state=abc`, `${RETURN}?foo=bar`]) {
    assert.throws(() => identity().parseIdentityCallback(callback), /neither a code_uri nor an error/, callback);
  }
});

test('a code_uri that is not an absolute http(s) URL is rejected', () => {
  for (const codeUri of ['/api/v1/identity/abc', 'javascript:alert(1)', 'ftp://id-service.example/abc']) {
    assert.throws(() => identity().parseIdentityCallback(`${RETURN}#code_uri=${encodeURIComponent(codeUri)}`),
      /code_uri is not an absolute HTTP\(S\) URL/, codeUri);
  }
});

test('the callback must be an absolute URL', () => {
  for (const callback of [undefined, '', 'code_uri=abc', '/callback#code_uri=abc']) {
    assert.throws(() => identity().parseIdentityCallback(callback), /callbackUrl must be the absolute URL/, String(callback));
  }
});
