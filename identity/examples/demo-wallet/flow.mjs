/**
 * The demo wallet's story, step by step, using the two packages exactly as the samples do. Each step updates the
 * shared `state` (what the page draws: never a seed or a key); long steps run in the background and report their
 * progress there, so the page only has to redraw.
 *
 *   start ─► choose-provider ─► verifying ─► identity ─► account ─► funded ─► (piece 4) send …
 *            (or, with IDENTITY_INDEX: start ─► identity, loaded from the store)
 *   account: created from the identity (this package). funded: CCD, TN and CIS-2 received from the funding account
 *   through the wallet package, or, with no funding account, testnet CCD sent to it from any wallet.
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
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';
import { FUND, CIS2, PLT, accountLink, transactionLink, balancesOf, sendOnce, walletAccount } from './chain.mjs';

const CONFIG = CONCORDIUM_TESTNET_IDENTITY_CONFIG;

/** The verification's stages, in order, as the page shows them (progress dots). */
export const VERIFY_STAGES = ['request sent', 'verifying at the provider', 'reply received', 'identity checked', 'saved encrypted'];

export default class DemoFlow {
  #settings;
  #fetch;
  #identity;
  #returnUrl = null;
  #makeWallet;
  #wallet = null;   // the demo seed's accounts, through the wallet package
  #funder = null;   // the funding account's wallet (its seed stays here, never in the state)
  #watchFunds = null;

  /**
   * @param {{ settings: object, state: object, fetch?: typeof fetch, checkProviders?: boolean,
   *   makeWallet?: (seed: string) => object, pauseMs?: number }} options
   *   fetch: HTTP for this package (tests pass a fake); checkProviders: run the live "online" check (default true);
   *   makeWallet: the wallet package's manager for a seed (tests pass a fake); pauseMs: waits between checks
   */
  constructor({
    settings, state, fetch: fetchFn = (url, options) => fetch(url, options), checkProviders = true,
    makeWallet = (seed) => new WalletManagerConcordium(seed, { ...CONCORDIUM_TESTNET_CONFIG }), pauseMs = 2000,
  }) {
    this.#makeWallet = makeWallet;
    this.pauseMs = pauseMs;
    this.#settings = settings;
    this.#fetch = fetchFn;
    this.state = state;
    this.checkProviders = checkProviders;
    this.#identity = new ConcordiumIdentity(settings.seedPhrase, CONFIG, {
      fetch: fetchFn, store: new FileIdentityStore(settings.storeFolder),
    });
    Object.assign(state, {
      providers: null, verification: null, identity: null, account: null, balances: null, activity: [], busy: null, error: null,
    });
  }

  /** Where the provider sends the browser back to: the demo server's own /return page. */
  setReturnUrl(url) {
    this.#returnUrl = url;
  }

  /** Dispose of the identity (zeroes the seed). */
  dispose() {
    clearInterval(this.#watchFunds);
    this.#identity.dispose();
    this.#wallet?.dispose();
    this.#funder?.dispose();
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

  // ---- Step 4: create an account ------------------------------------------------------------------------------

  /** [Create account]: account 0 of the identity, on chain (or found, if it exists already). In the background. */
  createAccount() {
    if (this.state.step !== 'identity') throw new Error('Verify or load an identity first.');
    this.#begin('creating-account');
    this.#run(async () => {
      const { providerIndex, identityIndex } = this.state.identity;
      const line = this.#log("Sending the account's credential through the wallet-proxy, waiting until it is final");
      const started = Date.now();
      const account = await this.#identity.createAccount({ providerIndex, identityIndex, credNumber: 0, intervalMs: this.pauseMs });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      this.#done(line, account.created ? `Account created, final on chain in ${seconds} s` : 'The account already exists on chain: nothing was sent',
        account.transactionHash && transactionLink(account.transactionHash));
      this.state.account = { ...account, link: accountLink(account.address), seconds };
      this.state.step = 'account';
      if (!this.#settings.funding) this.#waitForFunds();
    });
  }

  // ---- Step 5: receive ----------------------------------------------------------------------------------------

  /** [Receive]: the funding account sends CCD, TN and CIS-2 to the new account, through the wallet package. */
  receive() {
    if (this.state.step !== 'account') throw new Error('Create the account first.');
    if (!this.#settings.funding) throw new Error('No funding account is configured: send testnet CCD to the address shown.');
    this.#begin('receiving');
    this.#run(async () => {
      const account = await this.#account();
      const funding = await this.#funding();
      const to = this.state.account.address;
      for (const [name, send] of [
        ['CCD', () => funding.sendTransaction({ to, value: FUND.ccd })],
        [PLT, () => funding.transfer({ token: PLT, recipient: to, amount: FUND.plt })],
        ['CIS-2', () => funding.transfer({ token: CIS2, recipient: to, amount: FUND.cis2 })],
      ]) {
        const line = this.#log(`The funding account sends ${name}, waiting until final`);
        const started = Date.now();
        const { hash } = await sendOnce(`the funding account sends ${name}`, send);
        this.#done(line, `${name} received, final in ${((Date.now() - started) / 1000).toFixed(1)} s`, transactionLink(hash));
      }
      this.state.balances = await balancesOf(account);
      this.state.step = 'funded';
    });
  }

  /** No funding account: check the new account's CCD every few seconds until someone sends some. */
  #waitForFunds() {
    const line = this.#log('Waiting for testnet CCD to arrive at this address (send some from any testnet wallet)');
    this.#watchFunds = setInterval(async () => {
      try {
        const balances = await balancesOf(await this.#account());
        if (BigInt(balances.ccd) > 0n) {
          clearInterval(this.#watchFunds);
          this.state.balances = balances;
          this.#done(line, `${balances.text.ccd} arrived`);
          this.state.step = 'funded';
        }
      } catch { /* the node blipped: try again at the next tick */ }
    }, this.pauseMs * 2);
  }

  // ---- Helpers: the wallet package, and progress for the page --------------------------------------------------

  async #account() {
    this.#wallet ??= this.#makeWallet(this.#settings.seedPhrase);
    return walletAccount(this.#wallet, this.state.account.path, { pauseMs: this.pauseMs });
  }

  async #funding() {
    this.#funder ??= this.#makeWallet(this.#settings.funding.seed);
    return walletAccount(this.#funder, this.#settings.funding.path, { pauseMs: this.pauseMs });
  }

  /** One long action at a time. */
  #begin(busy) {
    if (this.state.busy) throw new Error('Please wait: the previous step is still running.');
    this.state.error = null;
    this.state.busy = busy;
  }

  /** Run a step in the background; its error is shown on the page. */
  #run(step) {
    step().catch((e) => {
      const running = this.state.activity.findLast((l) => l.status === 'running');
      if (running) running.status = 'failed';
      this.state.error = e.message;
    }).finally(() => { this.state.busy = null; });
  }

  /** A progress line on the page: running until done. */
  #log(text) {
    const line = { text, status: 'running' };
    this.state.activity.push(line);
    return line;
  }

  #done(line, text, link) {
    Object.assign(line, { text, status: 'done', ...(link ? { link } : {}) });
  }
}
