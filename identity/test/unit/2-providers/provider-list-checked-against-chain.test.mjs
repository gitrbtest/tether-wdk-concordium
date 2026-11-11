/**
 * The provider list checked against the chain's own record; no external services (the chain's record is recorded in
 * fixtures/chain-providers.testnet.json, by fixtures/capture-chain-providers.mjs).
 *
 * Who is who:
 *   WALLET    passes in the identity provider list (here the recorded /v1/ip_info list, sometimes changed on purpose)
 *   PACKAGE   ConcordiumIdentity, which builds requests and recovers identities with the list's keys
 *   NODE      the wallet's node connection: the chain's record of the providers and anonymity revokers
 *
 *   WALLET                         PACKAGE                                        NODE
 *   ──────                         ───────                                        ────
 *   1. passes the list ─────────► 2. first use of a provider: reads the record ─► providers + anonymity revokers
 *                                    once, and compares every provider:
 *                                    its two verify keys, its revokers' keys
 *                                 3. a provider that matches: used as before
 *                                 4. one that does not (changed key, not on the chain): refused, nothing built;
 *                                    left out of list, reported by recoverAll
 *                                 5. the node cannot be asked: an error, and the next use tries again
 *
 * Each test says which steps it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConcordiumIdentity, IdentityProviders, IdentityProviderError } from '@concordium/wdk-identity-concordium';
import { ipInfoFixture, testnetConfig, recordedNode } from '../../helpers.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RETURN = 'https://wallet.example/identity/return';
const chainRecord = () => JSON.parse(readFileSync(new URL('../../fixtures/chain-providers.testnet.json', import.meta.url), 'utf8'));

/** A wallet with this provider list and this chain record. `fetch` fails: nothing here may reach a provider. */
function wallet({ list = ipInfoFixture('testnet'), record = chainRecord(), node } = {}) {
  const chain = node ?? recordedNode('testnet', { providerRecord: record });
  const noFetch = async (url) => { throw new Error(`unexpected request to ${url}`); };
  const identity = new ConcordiumIdentity(PHRASE, testnetConfig({ identityProviders: list, node: chain }), { fetch: noFetch });
  return { identity, chain };
}

const request = (identity, providerIndex) => identity.createIdentityRequest({ providerIndex, identityIndex: 0, redirectUri: RETURN });

/** The recorded list with one change, made by `edit` on provider `index`'s entry. */
function listWith(index, edit) {
  const list = ipInfoFixture('testnet');
  edit(list.find((e) => e.ipInfo.ipIdentity === index));
  return list;
}

const refused = (pattern) => (e) => {
  assert.ok(e instanceof IdentityProviderError, `an IdentityProviderError, not ${e?.name}: ${e?.message}`);
  assert.match(e.message, pattern);
  assert.match(e.message, /fetch it again from a source you trust/);
  return true;
};

// Steps 1-3.
test('a list that matches the chain is used as before; the chain\'s record is read once per wallet object', async () => {
  const { identity, chain } = wallet();
  for (const { ipInfo } of ipInfoFixture('testnet')) {
    const { issuanceUrl } = await request(identity, ipInfo.ipIdentity);
    assert.ok(issuanceUrl.startsWith('https://'));
  }
  assert.equal(chain.providerCalls, 1, 'read once, then reused');
  identity.dispose();
});

// Steps 1, 2, 4: a provider's key changed.
test("a provider whose key in the list differs from the chain's is refused; the other providers still work", async () => {
  const list = listWith(0, (e) => { e.ipInfo.ipCdiVerifyKey = 'ab'.repeat(32); });
  const { identity } = wallet({ list });
  await assert.rejects(request(identity, 0), refused(/Identity provider 0 is refused: identity provider 0's keys in the list differ from the chain's record/));
  assert.ok((await request(identity, 3)).issuanceUrl, 'provider 3 matches, and works');
  identity.dispose();
});

// Steps 1, 2, 4: an anonymity revoker's key changed.
test("a provider whose anonymity revoker's key differs from the chain's is refused", async () => {
  const list = listWith(0, (e) => { e.arsInfos['1'].arPublicKey = e.arsInfos['2'].arPublicKey; });
  const { identity } = wallet({ list });
  await assert.rejects(request(identity, 0), refused(/anonymity revoker 1's key \(of identity provider 0\) differs from the chain's record/));
  identity.dispose();
});

// Steps 1, 2, 4: not on the chain at all.
test('a provider, or an anonymity revoker, that is not registered on the chain is refused', async () => {
  const noProvider0 = chainRecord();
  noProvider0.identityProviders = noProvider0.identityProviders.filter((ip) => ip.ipIdentity !== 0);
  const one = wallet({ record: noProvider0 });
  await assert.rejects(request(one.identity, 0), refused(/identity provider 0 is not registered on the chain/));
  one.identity.dispose();

  const noRevoker3 = chainRecord();
  noRevoker3.anonymityRevokers = noRevoker3.anonymityRevokers.filter((ar) => ar.arIdentity !== 3);
  const two = wallet({ record: noRevoker3 });
  await assert.rejects(request(two.identity, 0), refused(/anonymity revoker 3 \(of identity provider 0\) is not registered on the chain/));
  two.identity.dispose();
});

// Steps 1, 2, 4: recovery reports it, and asks no provider for it.
test('recoverAll reports a provider that does not match the chain, and does not ask it', async () => {
  const list = listWith(0, (e) => { e.ipInfo.ipVerifyKey = `00${e.ipInfo.ipVerifyKey.slice(2)}`; });
  const { identity } = wallet({ list });
  const { identities, problems } = await identity.recoverAll({ providerIndexes: [0] });
  assert.deepEqual(identities, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].providerIndex, 0);
  assert.ok(problems[0].error instanceof IdentityProviderError);
  assert.match(problems[0].error.message, /keys in the list differ from the chain's record/);
  identity.dispose();
});

// Step 5.
test('if the node cannot be asked, the error is reported and the next use tries again', async () => {
  const node = recordedNode('testnet', { providerRecord: Object.assign(new Error('the node is unreachable'), { code: 'UNAVAILABLE' }) });
  const { identity } = wallet({ node });
  await assert.rejects(request(identity, 0), /the node is unreachable/);
  const healthy = recordedNode('testnet');
  node.getIdentityProviders = healthy.getIdentityProviders;
  node.getAnonymityRevokers = healthy.getAnonymityRevokers;
  assert.ok((await request(identity, 0)).issuanceUrl, 'works once the node answers');
  identity.dispose();
});

test('IdentityProviders used on its own (no node) does not check the list: list() still shows every provider', async () => {
  const list = listWith(0, (e) => { e.ipInfo.ipCdiVerifyKey = 'ab'.repeat(32); });
  const shown = await new IdentityProviders(list).list();
  assert.deepEqual(shown.map((p) => p.index), list.map((e) => e.ipInfo.ipIdentity));
});
