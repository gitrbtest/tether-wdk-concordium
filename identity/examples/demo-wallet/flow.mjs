/**
 * The demo wallet's story, step by step, using the two packages exactly as the samples do. Each step updates the
 * shared `state` (what the page draws: never a seed or a key); long steps run in the background and report their
 * progress there, so the page only has to redraw.
 *
 *   start ─► choose-provider ─► verifying ─► identity ─► account ─► funded ─► (piece 4) send …
 *            (or, with IDENTITY_INDEX: start ─► identity, imported from the copy the wallet kept)
 *   account: created from the identity (this package). funded: CCD, TN and CIS-2 received from the funding account
 *   through the wallet package, or, with no funding account, testnet CCD sent to it from any wallet.
 */
import {
  ConcordiumIdentity,
  IdentityProviders,
  IdentityIssuanceError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { IdentityStorageError } from '@concordium/wdk-identity-concordium';
import { readFileSync, writeFileSync } from 'node:fs';
import { keepIdentity, keptIdentity } from '../kept-identities.mjs';
import { randomBytes, randomInt } from 'node:crypto';
import { checkProvider } from '../../scripts/lib/provider-check.mjs';
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';
import {
  FUND, SPONSORED, TOKENS, CIS2, PLT, accountLink, transactionLink, balancesOf, read, sendOnce, walletAccount,
  toBaseUnits, formatAmount, formatCcd, formatPlt,
} from './chain.mjs';
import { AccountAddress } from '@concordium/web-sdk';

const CONFIG = CONCORDIUM_TESTNET_IDENTITY_CONFIG;

/** The verification's stages, in order, as the page shows them (progress dots). */
export const VERIFY_STAGES = ['request sent', 'verifying at the provider', 'reply received', 'identity checked', 'kept, encrypted'];

export default class DemoFlow {
  #settings;
  #fetch;
  #identity;
  #returnUrl = null;
  #makeWallet;
  #wallet = null;   // the demo seed's accounts, through the wallet package
  #funder = null;   // the funding account's wallet (its seed stays here, never in the state)
  #watchFunds = null;
  #keptFile = null; // where the wallet keeps the exported identity (a file: this demo's own way of keeping it)

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
    // The package stores nothing: it hands the identity to the wallet (exportIdentity), which keeps it its own way.
    this.#identity = new ConcordiumIdentity(settings.seedPhrase, CONFIG, { fetch: fetchFn });
    Object.assign(state, {
      providers: null, verification: null, identity: null, account: null, balances: null, activity: [], busy: null, error: null,
      fundingAddress: null, sponsored: null, lastSend: null, storage: null,
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

  /** [Start again]: back to the beginning; a fresh identity unless a saved one is being reused. */
  async reset() {
    if (this.state.busy) throw new Error('Please wait: the previous step is still running.');
    clearInterval(this.#watchFunds);
    await this.#repairIfDamaged();
    if (!this.#settings.reuseIdentity) this.#settings.identityIndex = randomInt(1, 2 ** 31 - 1);
    Object.assign(this.state, {
      step: 'start', identityIndex: this.#settings.identityIndex, providers: null, verification: null, identity: null,
      account: null, balances: null, activity: [], busy: null, error: null, sponsored: null, lastSend: null, storage: null,
    });
  }

  // ---- Start ------------------------------------------------------------------------------------------------

  /** [Start]: the identity kept earlier is imported (IDENTITY_INDEX); otherwise the providers are listed. */
  async start() {
    this.state.error = null;
    if (this.#settings.reuseIdentity) {
      const which = { providerIndex: this.#settings.providerIndex, identityIndex: this.#settings.identityIndex };
      const kept = keptIdentity(this.#settings.identityFolder, which);
      if (!kept) throw new Error(`No identity ${which.identityIndex} is kept in ${this.#settings.identityFolder}.`);
      const summary = await this.#identity.importIdentity(kept);
      this.#keptFile = keepIdentity(this.#settings.identityFolder, which, kept); // the same text, where it already was
      this.state.identity = { ...summary, providerName: await this.#providerName(which.providerIndex), loaded: true, keptIn: this.#keptFile };
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

  /** The provider's reply, from /return: collect the identity, check it is this wallet's, export it and keep it. */
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
      // The package hands the identity over as encrypted text; the wallet keeps it its own way (here, a file).
      this.#keptFile = keepIdentity(this.#settings.identityFolder, slot, await this.#identity.exportIdentity(slot));
      this.state.verification.stage = 5;
      this.state.identity = { ...summary, providerName: await this.#providerName(providerIndex), keptIn: this.#keptFile };
      this.state.step = 'identity';
    } catch (e) {
      this.state.error = e instanceof IdentityIssuanceError
        ? `The identity was not issued (${e.reason}): ${e.message}`
        : `Collecting the identity failed: ${e.message}`;
      this.state.step = 'choose-provider';
    }
  }

  // ---- Step 3b: what the wallet keeps (optional) ------------------------------------------------------------

  /**
   * The panel's buttons, each quick (no network, except "plain", which needs none either):
   *   open      show the panel: the encrypted text the wallet keeps, and that nothing personal can be read in it
   *   restart   a new wallet object with the same seed imports the kept text: the identity is back, with no network
   *   damage    one character of the kept text is changed, then importing is tried again (it is refused)
   *   repair    the wallet exports the identity it holds again, over the damaged copy
   *   plain     the plain form (exportIdentity with encrypted: false), shown only, never kept: the details ARE readable
   */
  async storage({ action } = {}) {
    if (this.state.step !== 'identity') throw new Error('This panel needs an identity: verify or import one first.');
    if (this.state.busy) throw new Error('Please wait: the previous step is still running.');
    this.state.error = null;
    const panel = this.state.storage ??= { result: null, damaged: false, plain: null };
    if (action === 'open') {
      await this.#repairIfDamaged();
      Object.assign(panel, { result: null, plain: null });
    } else if (action === 'restart') {
      panel.result = await this.#importWithNewWallet();
    } else if (action === 'damage') {
      const kept = readFileSync(this.#keptFile, 'utf8');
      const at = kept.length - 30; // inside the encrypted part: any change there is detected
      writeFileSync(this.#keptFile, kept.slice(0, at) + (kept[at] === 'A' ? 'B' : 'A') + kept.slice(at + 1));
      panel.damaged = true;
      panel.result = await this.#importWithNewWallet();
    } else if (action === 'repair') {
      if (!panel.damaged) throw new Error('Nothing to repair: the kept copy is not damaged.');
      await this.#repairIfDamaged();
      panel.result = { outcome: 'repaired' };
    } else if (action === 'plain') {
      const plain = await this.#identity.exportIdentity({ ...this.#which(), encrypted: false });
      const details = this.#identityDetails();
      panel.plain = { characters: plain.length, preview: `${plain.slice(0, 90)}…`, found: details.filter((d) => plain.includes(d)) };
    } else {
      throw new Error('Unknown action.');
    }
    panel.kept = this.#whatIsKept();
  }

  #which() {
    return { providerIndex: this.state.identity.providerIndex, identityIndex: this.state.identity.identityIndex };
  }

  /** As after an app restart: a new wallet object, the same seed, the kept text; no network. */
  async #importWithNewWallet() {
    const restarted = new ConcordiumIdentity(this.#settings.seedPhrase, CONFIG, { fetch: this.#fetch });
    try {
      const summary = await restarted.importIdentity(readFileSync(this.#keptFile, 'utf8'));
      return { outcome: 'imported', validTo: summary.validTo };
    } catch (e) {
      if (e instanceof IdentityStorageError) return { outcome: 'refused', reason: e.reason, message: e.message };
      throw e;
    } finally {
      restarted.dispose();
    }
  }

  /** Put back a damaged copy: the wallet still holds the identity, so it exports it again and keeps that. */
  async #repairIfDamaged() {
    if (!this.state.storage?.damaged) return;
    writeFileSync(this.#keptFile, await this.#identity.exportIdentity(this.#which()));
    this.state.storage.damaged = false;
  }

  /**
   * What the wallet keeps for this identity: the encrypted text, its readable label, and whether any of the identity's
   * own details can be found in it (they cannot: it is encrypted).
   */
  #whatIsKept() {
    const text = readFileSync(this.#keptFile, 'utf8');
    const bytes = Buffer.from(text, 'base64');
    const asText = bytes.toString('latin1');
    const details = this.#identityDetails();
    return {
      where: this.#keptFile.replace(/\\/g, '/'),
      characters: text.length,
      preview: `${text.slice(0, 60)}…`,
      magic: asText.slice(0, 4),
      version: bytes[4],
      label: asText.slice(6, 6 + bytes[5]),
      searched: details.length,
      found: details.filter((detail) => asText.includes(detail) || text.includes(detail)),
    };
  }

  /**
   * The identity's own details to search the kept text for: its attribute values (four characters or more, so a
   * match cannot happen by chance) and the identity's field names. The demo reads them from the identity the
   * wallet holds in memory (an internal of the package, used here for this check only).
   */
  #identityDetails() {
    let attributes = {};
    try {
      const held = this.#identity._held.require(this.#which().providerIndex, this.#which().identityIndex);
      attributes = (held.value ?? held).attributeList?.chosenAttributes ?? {};
    } catch { /* not held: search the field names only */ }
    const values = Object.values(attributes).map(String).filter((v) => v.length >= 4);
    return [...new Set([...values, 'chosenAttributes', 'firstName', 'lastName', 'preIdentityObject'])];
  }

  // ---- Step 4: create an account ------------------------------------------------------------------------------

  /** [Create account]: account 0 of the identity, on chain (or found, if it exists already). In the background. */
  createAccount() {
    if (this.state.step !== 'identity') throw new Error('Verify or load an identity first.');
    this.#begin('creating-account');
    this.#run(async () => {
      await this.#repairIfDamaged(); // a copy damaged in the Storage panel is put back first
      const { providerIndex, identityIndex } = this.state.identity;
      const line = this.#log("Sending the account's credential through the wallet-proxy, waiting until it is final");
      const started = Date.now();
      const account = await this.#identity.createAccount({ providerIndex, identityIndex, credNumber: 0, intervalMs: this.pauseMs });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      this.#done(line, account.created ? `Account created, final on chain in ${seconds} s` : 'The account already exists on chain: nothing was sent',
        account.transactionHash && transactionLink(account.transactionHash));
      this.state.account = { ...account, link: accountLink(account.address), seconds };
      if (this.#settings.funding) this.state.fundingAddress = await read(async () => (await this.#funding()).getAddress());
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
        const line = this.#log(`The funding account (${this.state.fundingAddress?.slice(0, 8) ?? ''}…) sends ${name}, waiting until final`);
        const started = Date.now();
        const { hash } = await sendOnce(`the funding account sends ${name}`, send);
        this.#done(line, `${name} received from the funding account, final in ${((Date.now() - started) / 1000).toFixed(1)} s`, transactionLink(hash));
      }
      this.state.balances = await balancesOf(account);
      this.state.fundingAddress = await read(() => funding.getAddress());
      this.state.step = 'funded';
    });
  }

  // ---- Step 6: send -------------------------------------------------------------------------------------------

  /** Check a send: token, recipient, amount, and the fee (with whether the account's CCD covers it). Sends nothing. */
  async quote({ token, recipient, amount }) {
    if (this.state.step !== 'funded') throw new Error('Receive some funds first.');
    const request = this.#sendRequest({ token, recipient, amount });
    const account = await this.#account();
    const fee = await this.#fee(account, request);
    const needed = fee + (request.token === 'CCD' ? request.base : 0n);
    const ccd = BigInt((await balancesOf(account)).ccd);
    return {
      fee: String(fee), feeText: formatCcd(fee), enough: ccd >= needed,
      amountText: formatAmount(request.token, request.base), neededText: formatCcd(needed),
    };
  }

  /** [Send]: checked again, the fee checked against the account's CCD, then sent once. In the background. */
  send({ token, recipient, amount }) {
    if (this.state.step !== 'funded') throw new Error('Receive some funds first.');
    const request = this.#sendRequest({ token, recipient, amount });
    this.#begin('sending');
    this.#run(async () => {
      const account = await this.#account();
      const fee = await this.#fee(account, request);
      const needed = fee + (request.token === 'CCD' ? request.base : 0n);
      const ccd = BigInt((await balancesOf(account)).ccd);
      if (ccd < needed) throw new Error(`Not enough CCD: this send needs ${formatCcd(needed)} (fee ${formatCcd(fee)}), the account has ${formatCcd(ccd)}.`);
      const what = `${formatAmount(request.token, request.base)} to ${request.recipient.slice(0, 8)}…`;
      const line = this.#log(`Sending ${what} (fee ${formatCcd(fee)}), waiting until final`);
      // The Send card shows this send's result in place (sending → sent).
      this.state.lastSend = { status: 'sending', what, feeText: formatCcd(fee) };
      const started = Date.now();
      const { hash } = await sendOnce(`sending ${what}`, () => (request.token === 'CCD'
        ? account.sendTransaction({ to: request.recipient, value: request.base })
        : account.transfer({ token: TOKENS[request.token].id, recipient: request.recipient, amount: request.base })));
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      this.#done(line, `Sent ${what}, final in ${seconds} s`, transactionLink(hash));
      this.state.balances = await balancesOf(account);
      Object.assign(this.state.lastSend, { status: 'sent', seconds, link: transactionLink(hash), balances: this.state.balances.text });
    });
  }

  /** The send's inputs, checked: a token the page offers, a valid testnet address, a positive amount. */
  #sendRequest({ token, recipient, amount }) {
    if (!TOKENS[token]) throw new Error('Choose CCD, TN or CIS-2.');
    const to = String(recipient ?? '').trim();
    try { AccountAddress.fromBase58(to); } catch { throw new Error('The recipient is not a valid Concordium address.'); }
    if (to === this.state.account.address) throw new Error('That is this account\'s own address: choose another recipient.');
    return { token, recipient: to, base: toBaseUnits(amount, TOKENS[token].decimals) };
  }

  async #fee(account, { token, recipient, base }) {
    const { fee } = await read(() => (token === 'CCD'
      ? account.quoteSendTransaction({ to: recipient, value: base })
      : account.quoteTransfer({ token: TOKENS[token].id, recipient, amount: base })));
    return BigInt(fee);
  }

  // ---- Step 6b: the sponsored send ----------------------------------------------------------------------------

  /**
   * [Sponsored send]: three roles. A SENDER (account 1 of the identity, given TN but no CCD) sends TN to the
   * RECIPIENT (account 0); the SPONSOR (the funding account, standing in for the wallet operator) pays the fee.
   */
  sponsored() {
    if (this.state.step !== 'funded') throw new Error('Receive some funds first.');
    if (!this.#settings.funding) throw new Error('A sponsored send needs a sponsor: configure a funding account.');
    this.#begin('sponsoring');
    this.state.sponsored = null; // a new run: the three boxes start again
    this.#run(async () => {
      const { providerIndex, identityIndex } = this.state.identity;
      let line = this.#log('Creating a second account (account 1) for the sender, waiting until final');
      const second = await this.#identity.createAccount({ providerIndex, identityIndex, credNumber: 1, intervalMs: this.pauseMs });
      this.#done(line, second.created ? 'Account 1 created: the sender' : 'Account 1 already exists: the sender', second.transactionHash && transactionLink(second.transactionHash));
      const sender = await walletAccount(this.#wallet ??= this.#makeWallet(this.#settings.seedPhrase), second.path, { pauseMs: this.pauseMs });
      const recipient = await this.#account();
      const funding = await this.#funding();
      const sponsorAddress = await read(() => funding.getAddress());

      line = this.#log(`The sponsor gives the sender ${formatPlt(SPONSORED.give)} and no CCD`);
      const given = await sendOnce('giving the sender TN', () => funding.transfer({ token: PLT, recipient: second.address, amount: SPONSORED.give }));
      this.#done(line, `The sender holds TN and no CCD`, transactionLink(given.hash));

      const before = { sender: await balancesOf(sender), recipient: await balancesOf(recipient), sponsor: await balancesOf(funding) };
      this.state.sponsored = {
        sender: { address: second.address, path: second.path, before: before.sender.text },
        recipient: { address: this.state.account.address, path: this.state.account.path, before: before.recipient.text },
        sponsor: { address: sponsorAddress, before: before.sponsor.text },
        amountText: formatPlt(SPONSORED.send),
      };

      line = this.#log(`The sender signs "send ${formatPlt(SPONSORED.send)}", the sponsor signs to pay the fee; waiting until final`);
      const started = Date.now();
      let tx = await sender.buildSponsorableTransfer({ token: PLT, recipient: this.state.account.address, amount: SPONSORED.send, sponsorAddress });
      tx = await sender.signAsAccountToBeSponsored(tx);
      tx = await funding.signAsSponsorSigned(tx);
      const { hash } = await sendOnce('the sponsored send', () => sender.submitSponsored(tx));
      this.#done(line, `Sponsored send final in ${((Date.now() - started) / 1000).toFixed(1)} s: the sender paid no fee`, transactionLink(hash));

      const after = { sender: await balancesOf(sender), recipient: await balancesOf(recipient), sponsor: await balancesOf(funding) };
      Object.assign(this.state.sponsored.sender, { after: after.sender.text });
      Object.assign(this.state.sponsored.recipient, { after: after.recipient.text });
      Object.assign(this.state.sponsored.sponsor, {
        after: after.sponsor.text, feeText: formatCcd(BigInt(before.sponsor.ccd) - BigInt(after.sponsor.ccd)),
      });
      this.state.sponsored.link = transactionLink(hash);
      this.state.balances = after.recipient;
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
      if (this.state.lastSend?.status === 'sending') Object.assign(this.state.lastSend, { status: 'failed', error: e.message });
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
