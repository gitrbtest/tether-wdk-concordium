/**
 * Only genuine identities are held: the provider's signature must fit the identity exactly as it is, wherever the
 * identity comes in (collected after verifying, recovered from the provider, imported from the wallet's own copy).
 * No external services: the network is answered from recordings, and the check runs locally (a tiny proof built
 * and checked with Concordium's own SDK; about a second each).
 *
 * Who is who:
 *   WALLET    a wallet with the public test phrase; its genuine identity is the recorded one (provider 0, 334563111)
 *   PROVIDER  answers with the identity: the genuine one, or one with a detail changed (as a forger, or damage, would)
 *   PACKAGE   checks each identity that comes in: this seed's? (as before) and genuine? (its provider's signature)
 *
 *   PROVIDER / WALLET'S COPY                     PACKAGE                                   result
 *   ────────────────────────                     ───────                                   ──────
 *   1. collected after verifying ─────────────► this seed's? genuine? ───────────────────► held, or refused
 *   2. recovered from the provider ───────────► this seed's? genuine? ───────────────────► held, or refused
 *   3. imported from the kept text ───────────► this seed's? genuine? ───────────────────► held, or refused
 *   4. the check itself: genuine → true; another provider's keys → false; an unreadable identity → an error
 *
 * Each test says which step it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import {
  ConcordiumIdentity, IdentityIssuanceError, IdentityRecoveryError, IdentityStorageError,
} from '@concordium/wdk-identity-concordium';
import { isSignedByProvider } from '../../../src/issuance/identity-signature.js';
import { walletProxyFetch, testnetConfig, ipInfoFixture, globalFixture } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECORDED = { providerIndex: 0, identityIndex: 334563111 };
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const issued = () => JSON.parse(readFileSync(new URL('../../fixtures/identity-done.testnet.json', import.meta.url), 'utf8'));
/** The recorded identity with the first name changed: what a forger, or damage, would make. */
const changed = () => {
  const reply = issued();
  reply.token.identityObject.value.attributeList.chosenAttributes.firstName = 'Jane';
  return reply;
};

/** A wallet whose provider answers `reply` both at the code_uri (collecting) and at its recovery address. */
function wallet(reply = issued()) {
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => {
    if (url === CODE_URI) return { ok: true, status: 200, json: async () => reply };
    if (String(url).includes('/recover')) return { ok: true, status: 200, json: async () => reply.token.identityObject };
    return recorded.fetch(url, options);
  };
  return new ConcordiumIdentity(PHRASE, testnetConfig(), { fetch });
}

const notHeld = (identity) => assert.rejects(identity.exportIdentity(RECORDED), /No identity is held/, 'never held');
const notGenuine = (type) => (e) => {
  assert.ok(e instanceof type, `a ${type.name}, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, 'not-genuine');
  assert.match(e.message, /signature does not fit/);
  return true;
};

// Step 1.
test('collected: a genuine identity is held; one with a detail changed is refused (not-genuine) and never held', async () => {
  const genuine = wallet();
  assert.equal((await genuine.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 })).validTo, '202709');
  genuine.dispose();

  const forged = wallet(changed());
  await assert.rejects(forged.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 }), notGenuine(IdentityIssuanceError));
  await notHeld(forged);
  forged.dispose();
});

// Step 2.
test('recovered: a genuine identity comes back; one with a detail changed is refused (not-genuine) and never held', async () => {
  const genuine = wallet();
  assert.equal((await genuine.recoverIdentity(RECORDED)).validTo, '202709');
  genuine.dispose();

  const forged = wallet(changed());
  await assert.rejects(forged.recoverIdentity(RECORDED), notGenuine(IdentityRecoveryError));
  await notHeld(forged);
  forged.dispose();
});

// Step 3.
test('imported: the kept text of a genuine identity is held again; with a detail changed, it is refused', async () => {
  const holder = wallet();
  await holder.waitForIdentity(CODE_URI, { ...RECORDED, intervalMs: 1 });
  const text = await holder.exportIdentity(RECORDED);
  holder.dispose();

  const restarted = wallet();
  assert.equal((await restarted.importIdentity(text)).validTo, '202709');
  restarted.dispose();

  const tampered = wallet();
  await assert.rejects(tampered.importIdentity(text.replace('"firstName":"John"', '"firstName":"Jane"')), notGenuine(IdentityStorageError));
  await notHeld(tampered);
  tampered.dispose();
});

// Step 4.
test('the check itself: genuine → true; checked with another provider\'s keys → false; an unreadable identity → an error', () => {
  const content = issued().token.identityObject.value;
  const providers = ipInfoFixture('testnet');
  const common = {
    identityIndex: RECORDED.identityIndex, hdWallet: sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet'),
    globalContext: globalFixture('testnet').value, network: 'Testnet',
  };
  const provider0 = providers.find((p) => p.ipInfo.ipIdentity === 0);
  const provider3 = providers.find((p) => p.ipInfo.ipIdentity === 3);
  assert.equal(isSignedByProvider({ ...common, content, provider: provider0 }), true);
  assert.equal(isSignedByProvider({ ...common, content, provider: provider3 }), false);
  assert.throws(() => isSignedByProvider({ ...common, content: { attributeList: {} }, provider: provider0 }),
    'an identity in an unexpected format is an error, never mistaken for "not genuine"');
});
