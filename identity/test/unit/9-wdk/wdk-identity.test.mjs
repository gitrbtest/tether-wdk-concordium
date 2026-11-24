// The package inside WDK: ConcordiumIdentityManager and ConcordiumIdentityProtocol behind the identity interfaces
// proposed for WDK (registerIdentity, registerIdentityProtocol). No network: the identity is the one recorded from
// testnet, the provider list and node are recorded, and the question's anchor is on a pretend node.
//
// Who is who:
//   WDK            Tether's core (the proposal's fork): holds the seed; builds the identity manager with it, and the
//                  identity protocol for an account with that manager
//   WALLET MODULE  a stand-in for the Concordium wallet module: it gives an account its path, nothing else
//   IDENTITY       the recorded identity: provider 0, identity 334563111 (the test provider's made-up John Doe);
//                  its account 0 exists on the pretend node
//   SHOP           played by the test: a version 1 question, anchored on the pretend node; Concordium's own
//                  verifier checks the answer against account 0's recorded sealed details
//
//   APP (the test)                       WDK                               CONCORDIUM (this package)
//   ──────────────                       ───                               ─────────────────────────
//   1. registerIdentity ───────────────► builds the manager with its seed ─► ConcordiumIdentity
//   2. getIdentity().completeVerification(identity, reply) ─────────────────► retrieveIdentity: collected, checked
//   3. getAccountByPath('0/334563111/0') ► the account, and its getIdentityProtocol
//   4. getIdentityProtocol('concordium-id').describeRequest(question) ─────► describeProofRequest: the consent wording
//   5. getIdentityProtocol('concordium-id').prove(question) ───────────────► prove from account 0 ──► the shop checks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '@concordium/web-sdk';
import WDK from '@tetherto/wdk';
import WalletManager from '@tetherto/wdk-wallet';
import { IdentityError, IdentityErrorReason } from '@tetherto/wdk-wallet/identity';
import { ConcordiumIdentityManager, ConcordiumIdentityProtocol } from '@concordium/wdk-identity-concordium/wdk';
import { walletProxyFetch, globalFixture, testnetConfig, recordedNode, RECORDED_IDENTITY } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));
const ACCOUNT_0 = fixture('account-commitments.testnet.json'); // { address, credId, issuer, commitments }
const CODE_URI = 'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a';
const RETURN_URL = 'https://wallet.example/return';
const REPLY = `${RETURN_URL}#code_uri=${encodeURIComponent(CODE_URI)}`;
const ANCHOR_BLOCK = 'b7'.repeat(32);
const ANCHOR_HASH = 'cd'.repeat(32);

/** The shop's question: "over 18", answered from an account, anchored at ANCHOR_HASH. */
function question() {
  const context = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(9), 'connection-1', 'shop.example', 'age check');
  const claims = sdk.VerificationRequestV1.claimsBuilder()
    .addAccountClaims([0, 1, 2].map((i) => new sdk.IdentityProviderDID('Testnet', i)), (b) => b.addMinimumAge(18)).getClaims();
  return sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR_HASH));
}

/** The pretend node's answer about the anchor: final, recording `asked`. */
function anchoredOnChain(asked) {
  const data = Buffer.from(sdk.VerificationRequestV1.createAnchor(asked.context, asked.subjectClaims)).toString('hex');
  return {
    status: 'finalized',
    outcome: { blockHash: sdk.BlockHash.fromHexString(ANCHOR_BLOCK), summary: { type: 'accountTransaction', transactionType: 'registerData', dataRegistered: { data } } },
  };
}

/** A stand-in for the Concordium wallet module: an account is only its path. */
class StandInWallet extends WalletManager {
  async getAccountByPath(path) { return { path }; }
  async getAccount(index = 0) { return this.getAccountByPath(`0/0/${index}`); }
  async getFeeRates() { return { normal: 0n, fast: 0n }; }
}

/** The identity configuration a WDK app passes: recorded list and node, and a fetch giving the recorded identity. */
function identityConfig({ anchor } = {}) {
  const recorded = walletProxyFetch('testnet');
  const fetch = async (url, options) => (url === CODE_URI
    ? { ok: true, status: 200, json: async () => fixture('identity-done.testnet.json') }
    : recorded.fetch(url, options));
  const node = recordedNode('testnet', { statuses: anchor ? [anchor] : undefined, accountExists: (address) => address === ACCOUNT_0.address });
  return { ...testnetConfig({ node }), fetch };
}

/** Steps 1-2: a WDK with the Concordium identity manager and protocol, the recorded identity collected. */
async function wdkWithIdentity(options) {
  const wdk = new WDK(PHRASE)
    .registerWallet('concordium', StandInWallet, {})
    .registerIdentity('concordium', ConcordiumIdentityManager, identityConfig(options))
    .registerIdentityProtocol('concordium', 'concordium-id', ConcordiumIdentityProtocol);
  await wdk.getIdentity('concordium').completeVerification(RECORDED_IDENTITY, REPLY);
  return wdk;
}

const rejectsWith = (promise, reason) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof IdentityError, `an IdentityError, not ${e?.name}: ${e?.message}`);
  assert.equal(e.reason, reason);
  return true;
});

// Step 1
test('step 1: WDK builds the Concordium identity manager with its own seed', async () => {
  const wdk = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig());
  const manager = wdk.getIdentity('concordium');
  assert.ok(manager instanceof ConcordiumIdentityManager);
  // The same seed as the wallet: the recorded identity (issued for this phrase) is accepted as this seed's in step 2.
  await manager.completeVerification(RECORDED_IDENTITY, REPLY);
});

test('step 1: the providers, from the recorded list checked against the recorded chain, in WDK\'s shape', async () => {
  const wdk = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig());
  const providers = await wdk.getIdentity('concordium').getProviders();
  const first = providers.find((p) => p.id === '0');
  assert.ok(first, 'provider 0 is listed');
  assert.equal(typeof first.name, 'string');
  assert.ok(providers.every((p) => typeof p.id === 'string' && typeof p.name === 'string'));
  // Each provider's own published description and website (provider 0 publishes no website).
  const dts = providers.find((p) => p.id === '3');
  assert.equal(dts.description, 'Identity verified by Digital Trust Solutions on behalf of Concordium');
  assert.equal(dts.url, 'https://www.digitaltrustsolutions.nl');
  assert.equal(first.url, undefined, 'no website published, none given');
});

test('step 1: startVerification refuses a provider that is not one of the ids, or no return address (ValueError)', async () => {
  const manager = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig()).getIdentity('concordium');
  for (const provider of ['', ' ', 'zero', '0x1', undefined, -1]) {
    await assert.rejects(manager.startVerification({ provider, returnUrl: RETURN_URL, identityIndex: 7 }),
      (e) => e.name === 'ValueError' && /getProviders/.test(e.message), `provider ${JSON.stringify(provider)}`);
  }
  await assert.rejects(manager.startVerification({ provider: '0', identityIndex: 7 }), (e) => e.name === 'ValueError' && /returnUrl/.test(e.message));
});

test('step 1: startVerification gives the provider\'s page and the reference of the identity being issued', async () => {
  const wdk = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig());
  const { url, identity } = await wdk.getIdentity('concordium').startVerification({ provider: '0', returnUrl: RETURN_URL, identityIndex: 7 });
  assert.deepEqual(identity, { providerIndex: 0, identityIndex: 7 });
  const link = new URL(url);
  assert.equal(link.searchParams.get('redirect_uri'), RETURN_URL);
  assert.ok(link.searchParams.get('state'), 'the identity request travels in the link');
});

// Step 2
test('step 2: completeVerification collects the identity; the summary has no personal data', async () => {
  const wdk = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig());
  const summary = await wdk.getIdentity('concordium').completeVerification(RECORDED_IDENTITY, REPLY);
  assert.deepEqual(summary.identity, RECORDED_IDENTITY);
  assert.equal(summary.provider, '0');
  assert.ok(summary.createdAt instanceof Date && summary.validTo instanceof Date);
  assert.ok(summary.validTo > summary.createdAt);
  assert.doesNotMatch(JSON.stringify(summary), /John|Doe|19700101/, 'no personal data');
});

test('step 2: the identity can be exported and imported again (another WDK, the same seed)', async () => {
  const exported = await (await wdkWithIdentity()).getIdentity('concordium').exportIdentity(RECORDED_IDENTITY);
  const other = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig());
  const summary = await other.getIdentity('concordium').importIdentity(exported);
  assert.deepEqual(summary.identity, RECORDED_IDENTITY);
});

test('step 2: the provider\'s refusal comes out as WDK\'s IdentityError, with the package\'s error as its cause', async () => {
  const wdk = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig());
  const refused = `${RETURN_URL}#error=${encodeURIComponent(JSON.stringify({ error: { code: 'X', detail: 'refused' } }))}`;
  await assert.rejects(wdk.getIdentity('concordium').completeVerification(RECORDED_IDENTITY, refused), (e) => {
    assert.ok(e instanceof IdentityError);
    assert.equal(e.reason, IdentityErrorReason.PROVIDER_ERROR);
    assert.equal(e.cause?.name, 'IdentityIssuanceError');
    return true;
  });
});

test('step 2: an identity not held, or not a reference at all, is IDENTITY_NOT_FOUND', async () => {
  const manager = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, identityConfig()).getIdentity('concordium');
  await rejectsWith(manager.exportIdentity(RECORDED_IDENTITY), IdentityErrorReason.IDENTITY_NOT_FOUND);
  await rejectsWith(manager.exportIdentity({ provider: 0 }), IdentityErrorReason.IDENTITY_NOT_FOUND);
});

// Steps 3-5
test('steps 3-4: the identity protocol describes the shop\'s question for the consent screen', async () => {
  const wdk = await wdkWithIdentity();
  const account = await wdk.getAccountByPath('concordium', '0/334563111/0');
  const described = await account.getIdentityProtocol('concordium-id').describeRequest(question().toJSON());
  assert.equal(described.requester, 'shop.example');
  assert.equal(described.purpose, 'age check');
  assert.equal(described.asks.length, 1);
  assert.equal(described.asks[0].kind, 'prove');
  assert.equal(described.asks[0].attribute, 'dob');
  assert.match(described.asks[0].text, /18/);
});

test('step 5: the identity protocol proves from the account; Concordium\'s verifier accepts it, naming account 0', async () => {
  const asked = question();
  const wdk = await wdkWithIdentity({ anchor: anchoredOnChain(asked) });
  const account = await wdk.getAccountByPath('concordium', '0/334563111/0');
  const proof = await account.getIdentityProtocol('concordium-id').prove(asked.toJSON());

  const sent = sdk.VerifiablePresentationV1.fromJSON(JSON.parse(JSON.stringify(proof))); // as the shop receives it
  const publicData = [{ type: 'account', issuer: ACCOUNT_0.issuer, commitments: ACCOUNT_0.commitments }];
  const checked = sdk.VerifiablePresentationV1.verify(sent, globalFixture('testnet').value, publicData);
  assert.equal(checked.type, 'success', `Concordium's verifier: ${checked.error?.message}`);
  const [credential] = JSON.parse(JSON.stringify(proof)).verifiableCredential;
  assert.match(credential.credentialSubject.id, new RegExp(`:cred:${ACCOUNT_0.credId}$`), 'it names account 0');
  assert.doesNotMatch(JSON.stringify(proof), /19700101/, 'the date of birth itself is not in the proof');
});

test('step 5: a question the identity cannot truly answer is refused as CANNOT_PROVE', async () => {
  const context = sdk.VerificationRequestV1.createSimpleContext(new Uint8Array(32).fill(9), 'connection-1', 'shop.example', 'age check');
  const claims = sdk.VerificationRequestV1.claimsBuilder()
    .addAccountClaims([new sdk.IdentityProviderDID('Testnet', 0)], (b) => b.addMinimumAge(100)).getClaims(); // born 1970
  const asked = sdk.VerificationRequestV1.create(context, claims, sdk.TransactionHash.fromHexString(ANCHOR_HASH));
  const wdk = await wdkWithIdentity({ anchor: anchoredOnChain(asked) });
  const account = await wdk.getAccountByPath('concordium', '0/334563111/0');
  await rejectsWith(account.getIdentityProtocol('concordium-id').prove(asked.toJSON()), IdentityErrorReason.CANNOT_PROVE);
});

test('step 5: an account whose path is not a Concordium path, or no identity manager registered, is refused', async () => {
  const wdk = await wdkWithIdentity();
  const odd = await wdk.getAccount('concordium', 0); // the stand-in's other path shape: '0/0/0' is fine, so use a bad one
  odd.path = "m/44'/0'/0'";
  await rejectsWith(odd.getIdentityProtocol('concordium-id').prove(question().toJSON()), IdentityErrorReason.IDENTITY_NOT_FOUND);

  const noManager = new WDK(PHRASE).registerWallet('concordium', StandInWallet, {})
    .registerIdentityProtocol('concordium', 'concordium-id', ConcordiumIdentityProtocol);
  const account = await noManager.getAccountByPath('concordium', '0/334563111/0');
  await rejectsWith(account.getIdentityProtocol('concordium-id').prove(question().toJSON()), IdentityErrorReason.IDENTITY_NOT_FOUND);
});

// ---- A new phone: recover() through WDK ------------------------------------------------------------------------
//
//   APP: wdk.getIdentity('concordium').recover()
//     └─► ConcordiumIdentity.recoverAll: each provider's recovery address, identity 0, 1, 2 … (a scripted provider
//         here: identities 0 and 1 of provider 0 exist), then each identity's accounts on the (recorded) node
//   ◄── WDK's IdentitySummary for each: the reference, the provider, the dates, the accounts' paths and addresses

const HD = sdk.ConcordiumHdWallet.fromSeedPhrase(PHRASE, 'Testnet');
const providerEntry = (index) => testnetConfig().identityProviders.find((entry) => entry.ipInfo.ipIdentity === index);
const keyOf = (providerIndex, identityIndex) => sdk.createIdentityRecoveryRequestWithKeys({
  ipInfo: providerEntry(providerIndex).ipInfo, globalContext: globalFixture('testnet').value, timestamp: 0,
  idCredSec: HD.getIdCredSec(providerIndex, identityIndex).toString('hex'),
}).value.idCredPub;
const addressOf = (providerIndex, identityIndex, credNumber) => sdk.getAccountAddress(
  HD.getCredentialId(providerIndex, identityIndex, credNumber, globalFixture('testnet').value).toString('hex')).toString();

/**
 * The identity configuration for a scripted "new phone": provider 0 has identities 0 and 1 for this seed, with the
 * accounts `world` lists ({ identityIndex: [credNumber, …] }); the other providers have none. The identities are the
 * recorded one with this seed's key put in, so the provider's signature check is skipped (the package's own test
 * option). `accountsDown`: the node cannot be asked about accounts. `downFrom`: provider 0's recovery address fails
 * (HTTP 500) from this identity number on.
 */
function newPhoneConfig(world, { accountsDown = false, downFrom } = {}) {
  const recorded = walletProxyFetch('testnet');
  const keys = {};
  for (let i = 0; i < 10; i++) keys[keyOf(0, i)] = i;
  const recoveryStarts = testnetConfig().identityProviders.map((entry) => [entry.metadata?.recoveryStart, entry.ipInfo.ipIdentity]);
  const addresses = new Set(Object.entries(world).flatMap(([i, accounts]) => accounts.map((n) => addressOf(0, Number(i), n))));
  const json = (status, body) => ({ ok: status === 200, status, json: async () => body });
  const fetch = async (url, options) => {
    const text = String(url);
    const [, p] = recoveryStarts.find(([start]) => start && text.startsWith(`${start}?`)) ?? [];
    if (p === undefined) return recorded.fetch(url, options);
    const i = keys[JSON.parse(new URL(text).searchParams.get('state')).idRecoveryRequest.value.idCredPub];
    if (p === 0 && downFrom !== undefined && i >= downFrom) return json(500, { message: 'down' });
    if (p !== 0 || !world[i]) return json(404, { message: 'not found' });
    const identity = fixture('identity-done.testnet.json').token.identityObject;
    identity.value.preIdentityObject.idCredPub = keyOf(0, i);
    return json(200, identity);
  };
  const node = recordedNode('testnet', {
    accountExists: (address) => (accountsDown
      ? Object.assign(new Error('the node is unreachable'), { name: 'RpcError', code: 'UNAVAILABLE' })
      : addresses.has(address)),
  });
  return { ...testnetConfig({ node }), fetch, _signatureCheck: () => true };
}

test('recover: a new phone gets every identity back through WDK, each with its accounts, in WDK\'s shape', async () => {
  const wdk = new WDK(PHRASE).registerWallet('concordium', StandInWallet, {})
    .registerIdentity('concordium', ConcordiumIdentityManager, newPhoneConfig({ 0: [0], 1: [0, 1] }))
    .registerIdentityProtocol('concordium', 'concordium-id', ConcordiumIdentityProtocol);
  const recovered = await wdk.getIdentity('concordium').recover();

  assert.deepEqual(recovered.map((r) => r.identity), [{ providerIndex: 0, identityIndex: 0 }, { providerIndex: 0, identityIndex: 1 }]);
  assert.deepEqual(recovered.map((r) => r.accounts.map((a) => a.path)), [['0/0/0'], ['0/1/0', '0/1/1']]);
  assert.equal(recovered[1].accounts[1].address, addressOf(0, 1, 1), 'each account with its address');
  assert.ok(recovered.every((r) => r.provider === '0' && r.validTo instanceof Date && r.createdAt instanceof Date));
  assert.equal(recovered[0].validTo.toISOString(), '2027-09-30T23:59:59.999Z', 'valid to the end of its last month (202709)');
  assert.doesNotMatch(JSON.stringify(recovered), /John|Doe|19700101/, 'no personal data');

  // The recovered identities are held: they can be exported, and their accounts used through WDK.
  for (const { identity } of recovered) {
    assert.equal(typeof await wdk.getIdentity('concordium').exportIdentity(identity), 'string');
  }
  const account = await wdk.getAccountByPath('concordium', recovered[1].accounts[1].path);
  assert.ok(account.getIdentityProtocol('concordium-id') instanceof ConcordiumIdentityProtocol);
});

test('recover: an identity whose accounts cannot be looked up comes back without accounts', async () => {
  const manager = new WDK(PHRASE)
    .registerIdentity('concordium', ConcordiumIdentityManager, newPhoneConfig({ 0: [0] }, { accountsDown: true }))
    .getIdentity('concordium');
  const recovered = await manager.recover();
  assert.deepEqual(recovered.map((r) => r.identity), [{ providerIndex: 0, identityIndex: 0 }]);
  assert.equal(recovered[0].accounts, undefined, 'no accounts list, rather than an empty one that would read "none"');
});

test('recover: a seed with no identities gets an empty list', async () => {
  const manager = new WDK(PHRASE).registerIdentity('concordium', ConcordiumIdentityManager, newPhoneConfig({})).getIdentity('concordium');
  assert.deepEqual(await manager.recover(), []);
});

test('recover: a provider that cannot be asked part way is refused (PROVIDER_ERROR), not a silently shorter list', async () => {
  // Identities 0 and 1 exist, but the provider fails from identity 1 on: the list would miss identity 1.
  const manager = new WDK(PHRASE)
    .registerIdentity('concordium', ConcordiumIdentityManager, newPhoneConfig({ 0: [0], 1: [0] }, { downFrom: 1 }))
    .getIdentity('concordium');
  await assert.rejects(manager.recover(), (e) => {
    assert.ok(e instanceof IdentityError);
    assert.equal(e.reason, IdentityErrorReason.PROVIDER_ERROR);
    assert.match(e.message, /provider 0 .*Try again/);
    return true;
  });
});

test('errors: each of the package\'s errors becomes the IdentityError reason that says what happened', async () => {
  const { asIdentityError } = await import('../../../src/wdk/ConcordiumIdentityManager.js');
  const reasonFor = async (name, reason) => {
    try {
      await asIdentityError(async () => { throw Object.assign(new Error('x'), { name, reason }); });
    } catch (e) {
      return e instanceof IdentityError ? e.reason : `not mapped: ${e.name}`;
    }
  };
  const R = IdentityErrorReason;
  const expected = [
    ['IdentityIssuanceError', 'rejected', R.VERIFICATION_REJECTED], ['IdentityIssuanceError', 'not-genuine', R.VERIFICATION_REJECTED],
    ['IdentityIssuanceError', 'provider-error', R.PROVIDER_ERROR], ['IdentityRecoveryError', 'not-yours', R.IDENTITY_NOT_FOUND],
    ['IdentityRecoveryError', 'node', R.CHAIN_ERROR], ['IdentityRecoveryError', 'network', R.PROVIDER_ERROR],
    ['AccountCreationError', 'identity-expired', R.IDENTITY_EXPIRED], ['AccountCreationError', 'max-accounts', R.ACCOUNT_LIMIT_REACHED],
    ['AccountCreationError', 'rejected', R.CHAIN_ERROR], ['AccountCreationError', 'timeout', R.CHAIN_ERROR],
    ['ProofError', 'invalid-request', R.INVALID_REQUEST], ['ProofError', 'anchor-not-found', R.INVALID_REQUEST],
    ['ProofError', 'not-held', R.IDENTITY_NOT_FOUND], ['ProofError', 'node', R.CHAIN_ERROR], ['ProofError', 'cannot-prove', R.CANNOT_PROVE],
    ['IdentityStorageError', 'unreadable', R.IDENTITY_NOT_FOUND], ['IdentityProviderError', undefined, R.PROVIDER_ERROR],
  ];
  for (const [name, reason, want] of expected) assert.equal(await reasonFor(name, reason), want, `${name} ${reason}`);
  assert.equal(await reasonFor('TypeError', undefined), 'not mapped: TypeError', 'anything else passes through as it is');
});

test('dispose: WDK disposes the identity manager; it then throws DisposalError, as WDK\'s wallets do', async () => {
  const wdk = await wdkWithIdentity();
  const manager = wdk.getIdentity('concordium');
  wdk.dispose();
  assert.equal(manager.disposed, true);
  for (const call of [() => manager.exportIdentity(RECORDED_IDENTITY), () => manager.getProviders(), () => manager.recover()]) {
    await assert.rejects(call(), (e) => e.name === 'DisposalError');
  }
});
