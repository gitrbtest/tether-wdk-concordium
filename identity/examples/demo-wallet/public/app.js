// The demo wallet page: draws the server's state and sends the clicks. It never sees a seed or a key.

const token = document.querySelector('meta[name="demo-token"]').content;
const app = document.getElementById('app');

/** Call the demo server's API (with the page's token: other sites cannot add it). */
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { 'x-demo-token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
  return reply;
}

/** Text from the network (e.g. provider names) is escaped before it goes into the page. */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const yearMonth = (yyyymm) => `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}`;

/**
 * A provider's Verify button: usable once the live check says it accepts requests ("online"), or when the check
 * itself could not run ("not checked": a passing network problem should not block the demo). While checking, and
 * for a provider that is not available, it cannot be clicked.
 */
function verifyButton(p) {
  if (p.online === 'online' || p.online === 'not checked') {
    return `<button data-action="verify" data-provider="${p.index}">Verify with this provider</button>`;
  }
  return p.online === 'checking'
    ? '<button class="checking" disabled><span class="spinner"></span>Checking…</button>'
    : '<button disabled>Not available</button>';
}

// ---- One view per step ---------------------------------------------------------------------------------------

const views = {
  start: (s) => `
    <section class="card title-card">
      <p class="eyebrow">Tether WDK × Concordium</p>
      <h1>One seed phrase, a complete Concordium wallet</h1>
      <p class="lead">A verified identity and a new account without the Concordium ID App, then CCD and tokens moving
        through Tether's Wallet Development Kit.</p>
      <p class="note">Testnet only, with a public test seed. This page runs on your own computer.
        ${s.reuseIdentity ? `Using the identity saved earlier (${s.identityIndex}).` : `A fresh identity will be verified (index ${s.identityIndex}).`}</p>
      <button class="primary" data-action="start">Start</button>
    </section>`,

  'choose-provider': (s) => `
    <section class="card">
      <p class="eyebrow">Step 1 · Identity · Phase 2</p>
      <h2>Choose your identity provider</h2>
      <p class="note">Identity providers verify a person and issue the identity. These are the ones Concordium's
        testnet publishes; "online" means a request built by this wallet was accepted just now.</p>
      <ul class="providers">
        ${(s.providers ?? []).map((p) => `
          <li class="provider">
            <span class="name">${esc(p.name)}</span>
            <span class="online ${p.online === 'online' ? 'yes' : p.online === 'checking' ? 'wait' : 'no'}">${p.online === 'checking' ? '<span class="spinner"></span>' : ''}${esc(p.online)}</span>
            ${verifyButton(p)}
          </li>`).join('')}
      </ul>
    </section>`,

  verifying: (s) => `
    <section class="card">
      <p class="eyebrow">Step 2 · Identity · Phase 2</p>
      <h2>Verify your identity</h2>
      <p class="note">The provider's page opened in a new tab: fill in its form there (on testnet, the Concordium
        test provider accepts made-up details). <strong>Then come back to this tab:</strong> the provider's tab closes
        itself, and this page follows each stage below.</p>
      <ol class="stages">
        ${s.verifyStages.map((name, i) => `<li class="${i + 1 < s.verification.stage ? 'done' : i + 1 === s.verification.stage ? 'now' : ''}">${esc(name)}</li>`).join('')}
      </ol>
      ${s.verification.link ? `<p class="note">If no tab opened: <a href="${esc(s.verification.link)}" target="_blank" rel="noopener">open the provider's page</a>.</p>` : ''}
    </section>`,

  identity: (s) => `
    <section class="card identity-card">
      <p class="eyebrow">Step 3 · Identity · Phase 2</p>
      <h2>Your identity ${s.identity.loaded ? 'is loaded' : 'is verified'} 🔒</h2>
      <dl class="facts">
        <dt>Issued by</dt><dd>${esc(s.identity.providerName)}</dd>
        <dt>Valid until</dt><dd>${yearMonth(s.identity.validTo)} (issued ${yearMonth(s.identity.createdAt)})</dd>
        <dt>Accounts allowed</dt><dd>up to ${s.identity.maxAccounts}</dd>
        <dt>Stored</dt><dd>${s.identity.loaded ? 'loaded from the encrypted store' : `encrypted in ${esc(s.identity.storeFolder)}`}: the key comes
          from the seed and is never stored; nothing personal is on disk</dd>
      </dl>
      <p class="note"><strong>Held by your wallet: not on the blockchain.</strong> The chain only sees proofs of it
        when an account is created, never the identity itself.</p>
      <p class="note">Checked to belong to this wallet's seed before it was kept. Next: create an account from it.</p>
      <button class="primary" data-action="create-account" ${s.busy ? 'disabled' : ''}>${s.busy === 'creating-account'
        ? '<span class="spinner"></span>Creating the account…' : 'Create account'}</button>
    </section>
    ${activity(s)}`,

  account: (s) => `
    ${accountCard(s)}
    <section class="card">
      <p class="eyebrow">Step 5 · Using the account: the WDK wallet module · Phase 1</p>
      <h2>Receive</h2>
      ${s.funding === 'none' ? `
        <p class="note">No funding account is configured. Send some testnet CCD to this address from any testnet wallet;
          this page notices when it arrives.</p>
        <p class="address">${esc(s.account.address)}</p>` : `
        <p class="note">The new account is handed to our Concordium module for Tether's WDK
          (<code>@concordium/wdk-wallet-concordium</code>, Phase 1) with
          <code>getAccountByPath('${esc(s.account.path)}')</code>. A funding account then sends it CCD, a
          protocol-level token (TN) and a CIS-2 token.</p>
        <button class="primary" data-action="receive" ${s.busy ? 'disabled' : ''}>${s.busy === 'receiving'
          ? '<span class="spinner"></span>Receiving…' : 'Receive test funds'}</button>`}
    </section>
    ${activity(s)}`,

  funded: (s) => `
    ${accountCard(s)}
    <section class="card">
      <p class="eyebrow">Step 5 · Using the account: the WDK wallet module · Phase 1</p>
      <h2>Balances</h2>
      ${balancesTable(s.balances)}
      <p class="note">Read through the WDK wallet module (Phase 1) from the testnet node. CIS-2 tokens live in a smart contract:
        CCDScan shows them under the account's <strong>Tokens</strong> section, not in its transaction list.</p>
      <p class="note">Next: send.</p>
    </section>
    ${activity(s)}`,
};

/** The new account: address, path and where to see it. */
function accountCard(s) {
  return `
    <section class="card account-card">
      <p class="eyebrow">Step 4 · Account · Phase 2</p>
      <h2>Your new account is on chain ✔</h2>
      <dl class="facts">
        <dt>Address</dt><dd class="address">${esc(s.account.address)}</dd>
        <dt>Created</dt><dd>${s.account.created ? `from your identity, final in ${esc(s.account.seconds)} s; no ID App, no fee` : 'earlier: it already existed, nothing was sent'}</dd>
        <dt>Path</dt><dd><code>${esc(s.account.path)}</code> (provider / identity / account number)</dd>
      </dl>
      <p><a class="link" href="${esc(s.account.link)}" target="_blank" rel="noopener">View it on CCDScan, Concordium's explorer ↗</a></p>
    </section>`;
}

/** CCD and the two tokens. */
function balancesTable(b) {
  return `
    <table class="balances">
      <tr><td>CCD</td><td class="kind">Concordium's own coin</td><td class="amount">${esc(b.text.ccd)}</td></tr>
      <tr><td>TN</td><td class="kind">protocol-level token (PLT)</td><td class="amount">${esc(b.text.plt)}</td></tr>
      <tr><td>CIS-2</td><td class="kind">smart-contract token 12754:0:01</td><td class="amount">${esc(b.text.cis2)}</td></tr>
    </table>`;
}

/** The progress lines of the current step: running (spinner), done (with a CCDScan link), or failed. */
function activity(s) {
  if (!s.activity?.length) return '';
  return `<ul class="activity">${s.activity.map((line) => `
    <li class="${line.status}">${line.status === 'running' ? '<span class="spinner"></span>' : line.status === 'done' ? '✔ ' : '✖ '}${esc(line.text)}${line.link
      ? ` · <a href="${esc(line.link)}" target="_blank" rel="noopener">transaction ↗</a>` : ''}</li>`).join('')}</ul>`;
}

// ---- Drawing and clicks ----------------------------------------------------------------------------------------

let lastDrawn = '';
let verifyLink = null; // the provider link, kept on the page in case the new tab was blocked

function draw(state) {
  if (state.verification) state.verification.link = verifyLink;
  const html = (views[state.step] ?? views.start)(state)
    + (state.error ? `<p class="error">${esc(state.error)}</p>` : '');
  document.getElementById('network').textContent = state.network;
  document.getElementById('funding').textContent = `funding: ${state.funding}`;
  if (html !== lastDrawn) { app.innerHTML = html; lastDrawn = html; } // redraw only what changed: no flicker
}

async function refresh() {
  try {
    draw(await api('/api/state'));
  } catch (e) {
    app.innerHTML = `<p class="error">The demo server did not answer: ${esc(e.message)}. Is it still running?</p>`;
    lastDrawn = '';
  }
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.action === 'start') await api('/api/start', { method: 'POST', body: {} });
    if (button.dataset.action === 'create-account') await api('/api/create-account', { method: 'POST', body: {} });
    if (button.dataset.action === 'receive') await api('/api/receive', { method: 'POST', body: {} });
    if (button.dataset.action === 'verify') {
      // Open the tab now, in the click (browsers block tabs opened later), then send it to the provider.
      const tab = window.open('about:blank', '_blank');
      // Building the identity request takes a few seconds: say so in the new tab rather than leave it blank.
      tab?.document.write('<!doctype html><title>Opening the identity provider…</title>'
        + '<h1>Preparing your identity request…</h1>'
        + '<p>The identity provider\'s page opens here in a few seconds. Fill in its form, then go back to the demo wallet tab.</p>');
      tab?.document.close();
      const { issuanceUrl } = await api('/api/verify', { method: 'POST', body: { providerIndex: Number(button.dataset.provider) } });
      verifyLink = issuanceUrl;
      if (tab) tab.location.href = issuanceUrl;
    }
  } catch (e) {
    lastDrawn = '';
    app.insertAdjacentHTML('beforeend', `<p class="error">${esc(e.message)}</p>`);
  } finally {
    await refresh();
  }
});

refresh();
setInterval(refresh, 1000);
