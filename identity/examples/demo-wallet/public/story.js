// The demo's story: every sentence the page shows about what is happening (approved wording), and the
// "Show the code" panels. One place to edit the words. Plain functions of the state: no network, no DOM.

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- The opening card (Phase 1, and the gap) -------------------------------------------------------------------------------------

export function openingCard(s) {
  return `
    <section class="card title-card">
      <p class="eyebrow">Tether WDK × Concordium</p>
      <h1>One seed phrase, a complete Concordium wallet</h1>
      <p class="lead"><strong>Phase 1 brought Concordium into Tether's Wallet Development Kit</strong>, so a WDK wallet works
        with Concordium the same way it works with its other chains:</p>
      <ul class="points">
        <li><strong>CCD:</strong> balances, fee quotes, transfers, signing messages</li>
        <li><strong>Tokens through one interface:</strong> protocol-level tokens (PLT) and CIS-2 smart-contract tokens</li>
        <li><strong>Sponsored transactions:</strong> someone else can pay the fee, in all four signing orders</li>
        <li><strong>Account recovery</strong> from the seed phrase</li>
      </ul>
      <p class="lead"><strong>The gap:</strong> on Concordium an account needs a verified identity first, and getting one needed
        the Concordium ID App. So a WDK wallet could <em>use</em> Concordium accounts, but not <em>create</em> them.</p>
      <p class="lead"><strong>Phase 2 closes that gap.</strong> This page goes from a seed phrase to a verified identity, a new
        account, and tokens moving, inside a WDK wallet, without the ID App.</p>
      <p class="note">Testnet only, with a public test seed. This page runs on your own computer.
        ${s.reuseIdentity ? `(Using the identity saved earlier, ${esc(s.identityIndex)}.)` : ''}</p>
      <button class="primary" data-action="start">Start</button>
    </section>`;
}

// ---- One caption per step -----------------------------------------------------------------------------

const CAPTIONS = {
  'choose-provider': ['Phase 2 · Step 1 of 6', 'Identity providers are the companies that verify a person. The wallet lists the ones Concordium publishes and checks that each one is accepting requests right now.'],
  verifying: ['Phase 2 · Step 2 of 6', "The wallet builds the identity request from its own seed and opens the provider's page. The person fills in the provider's form there; on testnet, the test provider accepts made-up details."],
  identity: ['Phase 2 · Step 3 of 6', 'The provider issued the identity. The wallet checked it belongs to this seed and saved it encrypted, with a key that comes from the seed. Nothing has gone on the blockchain yet.'],
  account: ['Phase 2 · Step 4 of 6', "An account is created from the identity. The wallet sends proofs, not the identity, and the chain opens the account in seconds: no ID App, no fee. Concordium's own explorer already shows it."],
  receive: ['Phase 1 · Step 5 of 6', 'Now the Phase 1 module takes over: the new account is handed to it by its path, like any WDK account, and receives CCD, a protocol-level token and a CIS-2 token.'],
  funded: ['Phase 1 · Step 6 of 6', 'The account is in use: it sends with the fee quoted first, and a second account with no CCD at all sends a token while a sponsor pays the fee.'],
};

/** The caption for where the story is: the account page shows step 4, and step 5 once receiving starts. */
export function captionFor(s) {
  const key = s.step === 'account' && s.busy === 'receiving' ? 'receive' : s.step;
  const caption = CAPTIONS[key];
  if (!caption) return '';
  return `<div class="caption"><p class="caption-where">${esc(caption[0])}</p><p class="caption-text">${esc(caption[1])}</p></div>`;
}

export const STEPS_WITH_CAPTIONS = Object.keys(CAPTIONS);

// ---- The closing card ---------------------------------------------------------------------------------------

export function closingCard() {
  return `
    <section class="card title-card">
      <p class="eyebrow">Tether WDK × Concordium</p>
      <h1>What you just saw</h1>
      <p class="lead">From one seed phrase, inside a WDK wallet:</p>
      <ol class="points">
        <li>a verified identity from an identity provider, without the ID App <span class="phase">Phase 2</span></li>
        <li>kept encrypted in a store the wallet chooses <span class="phase">Phase 2</span></li>
        <li>a new account created from it on chain <span class="phase">Phase 2</span></li>
        <li>that account receiving and sending CCD, a PLT and a CIS-2 token, and a token sent with the fee paid by a
          sponsor <span class="phase">Phase 1, through the WDK module</span></li>
      </ol>
      <h2>How it is built</h2>
      <ul class="points">
        <li>Unit tests for every part, including the failure cases, and live tests against testnet</li>
        <li>Clear, named errors a wallet can show to its users</li>
        <li>Safeguards: the main package runs without Node-only code (browsers and phones), saved identities stay readable
          across versions, and the cryptography stays in step with Concordium's SDK</li>
        <li>The storage format and its threat model are documented</li>
        <li>Usable outside WDK too: the identity package does not depend on WDK</li>
      </ul>
      <h2>What comes next</h2>
      <ul class="points">
        <li>Getting the identity back from the seed phrase alone (recovery on a new device)</li>
        <li>Proving facts about a person without revealing them, e.g. "over 18"</li>
        <li>Regulated tokens (allow and deny lists) and transaction status</li>
        <li>Also planned: a browser extension sample, and company identities (Business ID)</li>
      </ul>
      <p class="lead"><strong>Try it yourself:</strong> the step-by-step guide that came with this video.</p>
      <div class="send-actions">
        <button data-action="back">Back to the wallet</button>
        <button class="primary" data-action="restart">Start again</button>
      </div>
    </section>`;
}

// ---- "Show the code": the package calls each step made, with this run's values ----------------------------------

const code = (step, lines, where) => `
  <section class="code-panel">
    <p class="code-title">Under the hood · ${esc(step)}</p>
    <pre><code>${esc(lines.join('\n'))}</code></pre>
    <p class="code-where">${esc(where)}</p>
  </section>`;

export function codeFor(s) {
  const p = s.verification?.providerIndex ?? s.identity?.providerIndex ?? 0;
  const i = s.identityIndex;
  switch (s.step) {
    case 'start':
    case 'choose-provider':
      return code('Step 1', [
        "import { IdentityProviders, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';",
        '',
        'const providers = await new IdentityProviders(CONCORDIUM_TESTNET_IDENTITY_CONFIG).list();',
        `// → ${s.providers ? `${s.providers.length} providers: ${s.providers.map((x) => x.name).join(', ')}` : '[{ index, name, issuanceStart, … }]'}`,
      ], '@concordium/wdk-identity-concordium · IdentityProviders.list');
    case 'verifying':
      return code('Step 2', [
        "const identity = new ConcordiumIdentity(seedPhrase, CONCORDIUM_TESTNET_IDENTITY_CONFIG, { store });",
        '',
        `const { issuanceUrl } = await identity.createIdentityRequest({ providerIndex: ${p}, identityIndex: ${i}, redirectUri });`,
        '// open issuanceUrl; the provider sends the browser back to redirectUri with its reply, then:',
        'const summary = await identity.retrieveIdentity(callbackUrl);   // collects it and checks it belongs to the seed',
      ], '@concordium/wdk-identity-concordium · ConcordiumIdentity.createIdentityRequest, retrieveIdentity');
    case 'identity':
      if (s.identity?.loaded) {
        return code('Step 3', [
          "const store = new FileIdentityStore('./demo-identities');   // or any store: a database, a backend, a phone's storage",
          '',
          `const summary = await identity.loadIdentity({ providerIndex: ${p}, identityIndex: ${i} });   // no network call`,
          `// → { validTo: '${s.identity.validTo}', maxAccounts: ${s.identity.maxAccounts} }: decrypted with a key from the seed`,
        ], '@concordium/wdk-identity-concordium · loadIdentity  ·  /node · FileIdentityStore');
      }
      return code('Step 3', [
        "const store = new FileIdentityStore('./demo-identities');   // or any store: a database, a backend, a phone's storage",
        '',
        `const saved = await identity.saveIdentity({ providerIndex: ${p}, identityIndex: ${i} });`,
        `// → { validTo: '${s.identity?.validTo ?? '…'}', maxAccounts: ${s.identity?.maxAccounts ?? '…'}, slotName: '${s.identity?.slotName ?? `concordium-identity/testnet/${p}/${i}`}' }`,
        '//   the store receives only encrypted bytes; the key comes from the seed and is never stored',
      ], '@concordium/wdk-identity-concordium · saveIdentity  ·  /node · FileIdentityStore');
    case 'account': {
      const path = s.account?.path ?? `${p}/${i}/0`;
      // Step 5 once receiving starts (as the caption does); until then, step 4 only.
      if (s.busy === 'receiving') {
        return code('Step 5', [
          '// Phase 1: the WDK wallet module uses the new account by its path, like any WDK account',
          "import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';",
          'const wallet = new WalletManagerConcordium(seedPhrase, CONCORDIUM_TESTNET_CONFIG);',
          `const wdkAccount = await wallet.getAccountByPath('${path}');`,
          '',
          '// The funding account (its own WDK wallet) sends CCD and two tokens to it',
          `await funding.sendTransaction({ to: '${s.account?.address ?? '…'}', value: 40_000_000n });   // 40 CCD`,
          "await funding.transfer({ token: 'TN', recipient, amount: 5_000_000n });                 // 5 TN (a PLT)",
          "await funding.transfer({ token: 'cis2:12754:0:01', recipient, amount: 500n });          // 500 CIS-2 units",
        ], '@concordium/wdk-wallet-concordium · getAccountByPath, sendTransaction, transfer');
      }
      return code('Step 4', [
        `const account = await identity.createAccount({ providerIndex: ${p}, identityIndex: ${i}, credNumber: 0 });`,
        `// → { address: '${s.account?.address ?? '…'}', path: '${path}', created: ${s.account?.created ?? true} }`,
        '//   sends proofs from the identity (never the identity) and waits until the account is final on chain',
      ], '@concordium/wdk-identity-concordium · ConcordiumIdentity.createAccount');
    }
    case 'funded': {
      // Each part says whether it has happened (with this run's values) or what it will run when pressed.
      const b = s.balances?.text ?? {};
      const sent = s.lastSend?.status === 'sent' ? s.lastSend : null;
      const sp = s.sponsored?.link ? s.sponsored : null;
      const short = (address) => (address ? `${address.slice(0, 8)}…` : '…');
      return code('Steps 6 and 6b', [
        '// Done on arrival: the balances, read through the WDK wallet module',
        `await wdkAccount.getBalance();                          // → ${b.ccd ?? '…'}`,
        `await wdkAccount.getTokenBalance('TN');                 // → ${b.plt ?? '…'}`,
        `await wdkAccount.getTokenBalance('cis2:12754:0:01');    // → ${b.cis2 ?? '…'}`,
        '',
        sent ? '// Step 6 · Send: done' : '// Step 6 · Send: not used yet. When you press Send, it runs:',
        'const { fee } = await wdkAccount.quoteTransfer({ token, recipient, amount });   // CCD: quoteSendTransaction({ to, value })',
        'const { hash } = await wdkAccount.transfer({ token, recipient, amount });        // CCD: sendTransaction({ to, value })',
        ...(sent ? [`// → sent ${sent.what} · fee ${sent.feeText} · final in ${sent.seconds} s`] : []),
        '',
        sp ? '// Step 6b · Sponsored send: done. The sender has no CCD; the sponsor signs to pay the fee'
          : '// Step 6b · Sponsored send: not run yet. When you run it: the sender has no CCD; the sponsor signs to pay the fee',
        `let tx = await sender.buildSponsorableTransfer({ token: 'TN', recipient: '${sp ? short(sp.recipient.address) : '…'}', amount, sponsorAddress: '${sp ? short(sp.sponsor.address) : '…'}' });`,
        'tx = await sender.signAsAccountToBeSponsored(tx);   // the sender signs its transfer',
        'tx = await sponsor.signAsSponsorSigned(tx);          // the sponsor signs to pay the fee',
        'await sender.submitSponsored(tx);',
        ...(sp ? [`// → sender ${short(sp.sender.address)} still holds ${sp.sender.after?.ccd ?? '0 CCD'}; the sponsor paid ${sp.sponsor.feeText ?? 'the fee'}`] : []),
      ], '@concordium/wdk-wallet-concordium · getBalance, getTokenBalance, quoteTransfer, transfer, buildSponsorableTransfer, submitSponsored');
    }
    default:
      return '';
  }
}
