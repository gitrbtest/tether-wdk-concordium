/**
 * The demo wallet's story, step by step, using the two packages exactly as the samples do. Each step updates the
 * shared `state` (what the page draws: never a seed or a key); long steps run in the background and report their
 * progress there, so the page only has to redraw.
 *
 *   start ─► choose-provider ─► verifying ─► identity ─► (piece 3) account ─► …
 *            (or, with IDENTITY_INDEX: start ─► identity, loaded from the store)
 */
import {
  ConcordiumIdentity,
  IdentityProviders,
  IdentityIssuanceError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { FileIdentityStore } from '@concordium/wdk-identity-concordium/node';
import { randomBytes } from 'node:crypto';
import { checkProvider } from '../../scripts/lib/provider-check.mjs';

const CONFIG = CONCORDIUM_TESTNET_IDENTITY_CONFIG;

/** The verification's stages, in order, as the page shows them (progress dots). */
export const VERIFY_STAGES = ['request sent', 'verifying at the provider', 'reply received', 'identity checked', 'saved encrypted'];

export default class DemoFlow {
  #settings;
  #fetch;
  #identity;
  #returnUrl = null;

  /**
   * @param {{ settings: object, state: object, fetch?: typeof fetch, checkProviders?: boolean }} options
   *   fetch: HTTP for both packages (tests pass a fake); checkProviders: run the live "online" check (default true)
   */
  constructor({ settings, state, fetch: fetchFn = (url, options) => fetch(url, options), checkProviders = true }) {
    this.#settings = settings;
    this.#fetch = fetchFn;
    this.state = state;
    this.checkProviders = checkProviders;
    this.#identity = new ConcordiumIdentity(settings.seedPhrase, CONFIG, {
      fetch: fetchFn, store: new FileIdentityStore(settings.storeFolder),
    });
    Object.assign(state, { providers: null, verification: null, identity: null, error: null });
  }

  /** Where the provider sends the browser back to: the demo server's own /return page. */
  setReturnUrl(url) {
    this.#returnUrl = url;
  }

  /** Dispose of the identity (zeroes the seed). */
  dispose() {
    this.#identity.dispose();
  }

  // ---- Start ------------------------------------------------------------------------------------------------

  /** [Start]: a saved identity is loaded (IDENTITY_INDEX); otherwise the providers are listed. */
  async start() {
    this.state.error = null;
    if (this.#settings.reuseIdentity) {
      const slot = { providerIndex: this.#settings.providerIndex, identityIndex: this.#settings.identityIndex };
      const summary = await this.#identity.loadIdentity(slot);
      if (!summary) throw new Error(`No identity ${slot.identityIndex} is saved in ${this.#settings.storeFolder}.`);
      this.state.identity = { ...summary, providerName: await this.#providerName(slot.providerIndex), loaded: true };
      this.state.step = 'identity';
      return;
    }
    await this.#listProviders();
    this.state.step = 'choose-provider';
  }

  async #listProviders() {
    const providers = await new IdentityProviders(CONFIG, { fetch: this.#fetch }).list();
    this.state.providers = providers
      .filter((p) => p.issuanceStart)
      .map(({ index, name }) => ({ index, name, online: this.checkProviders ? 'checking' : 'not checked' }));
    if (this.checkProviders) this.#checkOnline(); // in the background: a few seconds per provider
  }

  /**
   * Mark each provider online (it accepts a request built by this wallet and serves its verification page now)
   * or not: the live provider check, all providers at once, each marked as soon as it answers. The requests come
   * from a throwaway random seed, never the demo's.
   */
  async #checkOnline() {
    const checker = new ConcordiumIdentity(randomBytes(64), CONFIG, { fetch: this.#fetch });
    try {
      await Promise.all((this.state.providers ?? []).map(async (provider) => {
        try {
          const { outcome, detail } = await checkProvider(checker, provider.index, { fetch: this.#fetch });
          provider.online = outcome === 'accepted' ? 'online' : `not available (${detail})`;
        } catch {
          provider.online = 'not checked';
        }
      }));
    } finally {
      checker.dispose();
    }
  }

  async #providerName(index) {
    return (await new IdentityProviders(CONFIG, { fetch: this.#fetch }).get(index)).name;
  }

  // ---- Verify -----------------------------------------------------------------------------------------------

  /** [Verify with …]: the link to the provider's verification page, which comes back to /return. */
  async verify(providerIndex) {
    this.state.error = null;
    const provider = this.state.providers?.find((p) => p.index === providerIndex);
    if (!provider) throw new Error(`Provider ${providerIndex} is not in the list.`);
    if (provider.online !== 'online' && provider.online !== 'not checked') {
      throw new Error(`${provider.name} is ${provider.online === 'checking' ? 'still being checked' : 'not available'}: choose it once it is online.`);
    }
    const { issuanceUrl } = await this.#identity.createIdentityRequest({
      providerIndex, identityIndex: this.#settings.identityIndex, redirectUri: this.#returnUrl,
    });
    this.state.verification = { providerIndex, stage: 1 }; // stages are 1-based positions in VERIFY_STAGES
    this.state.step = 'verifying';
    setTimeout(() => { if (this.state.verification?.stage === 1) this.state.verification.stage = 2; }, 1500);
    return { issuanceUrl };
  }

  /** The provider's reply, from /return: collect the identity, check it is this wallet's, save it encrypted. */
  callback(url) {
    if (!this.#returnUrl || !url.startsWith(this.#returnUrl)) throw new Error('This is not a reply to the demo\'s request.');
    if (this.state.step !== 'verifying') throw new Error('No verification is in progress.');
    this.state.verification.stage = 3;
    this.#collect(url); // in the background: the page follows the stages
  }

  async #collect(url) {
    const { providerIndex } = this.state.verification;
    const slot = { providerIndex, identityIndex: this.#settings.identityIndex };
    try {
      const summary = await this.#identity.retrieveIdentity(url, { ...slot, intervalMs: 2000 });
      this.state.verification.stage = 4;
      const { slotName } = await this.#identity.saveIdentity(slot);
      this.state.verification.stage = 5;
      this.state.identity = { ...summary, providerName: await this.#providerName(providerIndex), slotName, storeFolder: this.#settings.storeFolder };
      this.state.step = 'identity';
    } catch (e) {
      this.state.error = e instanceof IdentityIssuanceError
        ? `The identity was not issued (${e.reason}): ${e.message}`
        : `Collecting the identity failed: ${e.message}`;
      this.state.step = 'choose-provider';
    }
  }
}
