/**
 * Identity providers, from the list the wallet passes in (the wallet-proxy's /v2/ip_info or /v1/ip_info shape; recorded in
 * test/fixtures). The package never fetches the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityProviders, IdentityProviderError, ConcordiumIdentity } from '@concordium/wdk-identity-concordium';
import { ipInfoFixture, testnetConfig } from '../../helpers.mjs';
import { readFileSync } from 'node:fs';
import { providerKind } from '../../../src/providers/provider-kind.js';

test('list reports every provider in the list with its published addresses', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const providers = new IdentityProviders(ipInfoFixture(network));
    const expected = ipInfoFixture(network).map((e) => ({
      index: e.ipInfo.ipIdentity,
      name: e.ipInfo.ipDescription.name,
      display: e.metadata.display || null,
      kind: 'person',
      issuanceStart: e.metadata.issuanceStart,
      recoveryStart: e.metadata.recoveryStart,
    }));
    assert.deepEqual(await providers.list(), expected);
  }
});

test('get returns a provider by its index, with its keys and anonymity revokers', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const providers = new IdentityProviders(ipInfoFixture(network));
    for (const entry of ipInfoFixture(network)) {
      const provider = await providers.get(entry.ipInfo.ipIdentity);
      assert.equal(provider.index, entry.ipInfo.ipIdentity);
      assert.equal(provider.issuanceStart, entry.metadata.issuanceStart, 'issuance address exactly as published');
      assert.equal(provider.recoveryStart, entry.metadata.recoveryStart, 'recovery address exactly as published');
      assert.deepEqual(provider.ipInfo, entry.ipInfo);
      assert.deepEqual(provider.arsInfos, entry.arsInfos);
    }
  }
});

test('a provider is found by its index, not by its position in the list', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const list = ipInfoFixture(network).reverse();
    const providers = new IdentityProviders(list);
    for (const [position, entry] of list.entries()) {
      const provider = await providers.get(entry.ipInfo.ipIdentity);
      assert.equal(provider.name, entry.ipInfo.ipDescription.name,
        `${network}: index ${entry.ipInfo.ipIdentity} (listed at position ${position}) resolves to its own entry`);
    }
  }
});

test('an index that is not in the list fails clearly, with no fallback', async () => {
  const listed = new Set(ipInfoFixture('mainnet').map((e) => e.ipInfo.ipIdentity));
  const missing = [0, 1, 2, 3, 4, 5].find((index) => !listed.has(index));
  const providers = new IdentityProviders(ipInfoFixture('mainnet'));
  await assert.rejects(
    () => providers.get(missing),
    (e) => e instanceof IdentityProviderError && e.providerIndex === missing
      && e.message === `No identity provider ${missing} is in the identity provider list.`,
  );
});

test('an invalid index is rejected', async () => {
  const providers = new IdentityProviders(ipInfoFixture('testnet'));
  for (const index of [-1, 1.5, '1', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => providers.get(index), /providerIndex is required and must be a non-negative safe integer/);
  }
});

test('an address a provider does not publish is reported as null, never invented', async () => {
  const list = ipInfoFixture('testnet');
  const entry = list[0];
  delete entry.metadata.issuanceStart;
  entry.metadata.recoveryStart = ''; // an empty address counts as not published
  const provider = await new IdentityProviders(list).get(entry.ipInfo.ipIdentity);
  assert.equal(provider.issuanceStart, null);
  assert.equal(provider.recoveryStart, null);
});

test('the list is copied: changing the wallet\'s own array afterwards changes nothing', async () => {
  const list = ipInfoFixture('testnet');
  const providers = new IdentityProviders(list);
  list[0].ipInfo.ipDescription.name = 'changed';
  list.pop();
  assert.equal((await providers.list()).length, 3);
  assert.equal((await providers.get(0)).name, 'Concordium testnet IP');
});

test('a list in the wrong shape is refused when it is passed in, naming what is wrong', () => {
  const broken = (edit) => { const list = ipInfoFixture('testnet'); edit(list); return list; };
  const cases = [
    [undefined, /is required and must be a list/],
    [{ not: 'a list' }, /is required and must be a list/],
    [[], /is empty/],
    [broken((l) => { delete l[1].ipInfo; }), /\[1\] has no ipInfo/],
    [broken((l) => { l[0].ipInfo.ipIdentity = 'zero'; }), /\[0\]\.ipInfo\.ipIdentity must be the provider's number/],
    [broken((l) => { l[1].ipInfo.ipIdentity = l[0].ipInfo.ipIdentity; }), /lists provider 0 twice/],
    [broken((l) => { delete l[0].ipInfo.ipDescription; }), /ipDescription\.name is missing/],
    [broken((l) => { delete l[0].ipInfo.ipVerifyKey; }), /missing the provider's keys/],
    [broken((l) => { l[0].arsInfos = {}; }), /arsInfos must list the provider's anonymity revokers/],
    [broken((l) => { delete Object.values(l[0].arsInfos)[0].arPublicKey; }), /arsInfos\.\d+ is incomplete/],
    [broken((l) => { l[0].metadata.issuanceStart = 'javascript:alert(1)'; }), /metadata\.issuanceStart must be an http\(s\) address/],
  ];
  for (const [list, expected] of cases) {
    assert.throws(() => new IdentityProviders(list), (e) => {
      assert.match(e.message, expected);
      assert.match(e.message, /wallet-proxy's \/v2\/ip_info or \/v1\/ip_info/, 'the message says which shape is expected');
      return true;
    });
  }
});

test('ConcordiumIdentity checks the list in its configuration when it is created, before anything else', () => {
  assert.throws(() => new ConcordiumIdentity('abandon '.repeat(11) + 'about', testnetConfig({ identityProviders: undefined })),
    /config\.identityProviders is required/);
  assert.throws(() => new ConcordiumIdentity('abandon '.repeat(11) + 'about', testnetConfig({ identityProviders: [{}] })),
    /config\.identityProviders \[0\] has no ipInfo/);
});

// ---- Company identities (Business ID) ---------------------------------------------------------------------------
//
// The wallet-proxy's /v2/ip_info lists every provider, including the company (Business ID) providers that /v1/ip_info
// leaves out: Global FinReg, testnet provider 4 and mainnet provider 3 (recorded 8 Nov 2026).

const v2List = (network) => JSON.parse(readFileSync(new URL(`../../fixtures/ip_info.${network}.v2.json`, import.meta.url), 'utf8'));

test('the v2 list: every provider, with Global FinReg as a company (Business ID) provider; the others are for people', async () => {
  const testnet = await new IdentityProviders(v2List('testnet')).list();
  assert.deepEqual(testnet.map((p) => [p.index, p.kind]), [[0, 'person'], [3, 'person'], [4, 'company'], [5, 'person']]);
  const finreg = testnet.find((p) => p.index === 4);
  assert.deepEqual([finreg.name, finreg.display], ['Global FinReg Testnet', 'Global FinReg (Business ID)']);
  assert.match(finreg.issuanceStart, /\/company$/);
  const mainnet = await new IdentityProviders(v2List('mainnet')).list();
  assert.deepEqual(mainnet.map((p) => [p.index, p.kind]), [[2, 'person'], [1, 'person'], [3, 'company']]);
});

test('the v2 list is the v1 list plus the company providers: the people\'s providers read the same in both', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const v1 = await new IdentityProviders(ipInfoFixture(network)).list();
    const v2 = await new IdentityProviders(v2List(network)).list();
    assert.deepEqual(v2.filter((p) => p.kind === 'person'), v1, `${network}: the people's providers`);
  }
});

test('providerKind: "Business ID" in the display name, or an issuance address ending in /company, means company', () => {
  const entry = (metadata) => ({ ipInfo: { ipIdentity: 9 }, metadata });
  assert.equal(providerKind(entry({ display: 'Global FinReg (Business ID)' })), 'company');
  assert.equal(providerKind(entry({ display: 'Acme businessid' })), 'company', 'any spacing or letter case');
  assert.equal(providerKind(entry({ issuanceStart: 'https://ip.example/ccd-id-provider/v1/company' })), 'company');
  assert.equal(providerKind(entry({ issuanceStart: 'https://ip.example/v1/company/' })), 'company');
  assert.equal(providerKind(entry({ issuanceStart: 'https://ip.example/v1/identity', display: 'Notabene' })), 'person');
  assert.equal(providerKind(entry({ issuanceStart: 'https://companyhouse.example/v1/identity' })), 'person', 'only the path counts');
  assert.equal(providerKind(entry({})), 'person');
  assert.equal(providerKind({ ipInfo: { metadata: { display: 'X (Business ID)' } } }), 'company', 'ipInfo-level metadata too');
});
