/**
 * Which identity providers issue company identities (Business ID), on testnet and mainnet. Read-only: it only reads
 * the published provider lists.
 *
 *   npm run example:company-providers
 *
 * The wallet-proxy's /v2/ip_info lists every provider, including the company ones; /v1/ip_info leaves those out, so a
 * wallet that wants to offer "verify your company" passes the /v2 list to the package. The package says which
 * providers issue company identities (`kind: 'company'`) and gives each one's display name.
 */
import { IdentityProviders } from '@concordium/wdk-identity-concordium';

const LISTS = {
  testnet: 'https://wallet-proxy.testnet.concordium.com/v2/ip_info',
  mainnet: 'https://wallet-proxy.mainnet.concordium.software/v2/ip_info',
};

for (const [network, url] of Object.entries(LISTS)) {
  // The wallet fetches the list (the package never does) and hands it over.
  const providers = await new IdentityProviders(await (await fetch(url)).json()).list();
  console.log(`${network}:`);
  for (const p of providers) {
    const kind = p.kind === 'company' ? 'company (Business ID)' : 'person';
    console.log(`  ${String(p.index).padStart(2)}  ${p.name.padEnd(34)} ${kind}${p.display && p.display !== p.name ? `   shown as "${p.display}"` : ''}`);
  }
  const companies = providers.filter((p) => p.kind === 'company');
  console.log(`  → for a company: provider ${companies.map((p) => p.index).join(', ') || '(none)'}\n`);
}
