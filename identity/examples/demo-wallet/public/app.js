// The demo wallet page: draws the server's state and sends the clicks. It never sees a seed or a key.

import { openingCard, closingCard, captionFor, codeFor } from './story.js';

const token = document.querySelector('meta[name="demo-token"]').content;

// The header switches: story mode (captions; on by default) and "Show the code" (off by default), remembered in this
// browser when it allows it.
const prefs = { story: true, code: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('demo-wallet-prefs') ?? '{}')); } catch { /* not stored: defaults */ }
let closing = false; // the closing card, shown by [Finish]
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
  start: (s) => openingCard(s),
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
          <code>getAccountByPath('${esc(s.account.path)}')</code>. Then it receives CCD, a protocol-level token (TN)
          and a CIS-2 token:</p>
        <dl class="facts">
          <dt>From</dt><dd><strong>the funding account</strong>: a testnet account set up for this demo, standing in
            for an exchange or a friend sending you funds${s.fundingAddress ? `<br><span class="address">${esc(s.fundingAddress)}</span>` : ''}</dd>
          <dt>To</dt><dd>your new account<br><span class="address">${esc(s.account.address)}</span></dd>
          <dt>Amounts</dt><dd>40 CCD · 5 TN · 500 CIS-2 units</dd>
        </dl>
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
    </section>
    ${sendCard(s)}
    ${sponsoredCard(s)}
    <div class="finish"><button class="primary" data-action="finish" ${s.busy ? 'disabled' : ''}>Finish</button></div>
    ${activity(s)}`,
};

// ---- Step 6: Send (the form keeps what is typed in `form`, so redrawing never wipes it) ---------------------------

const form = { token: 'CCD', recipient: '', amount: '1', quote: null };

function sendCard(s) {
  const busy = Boolean(s.busy);
  const q = form.quote;
  return `
    <section class="card send-card">
      <p class="eyebrow">Step 6 · Send · Phase 1</p>
      <h2>Send</h2>
      <div class="form">
        <label>Token
          <select data-field="token" ${busy ? 'disabled' : ''}>
            ${['CCD', 'TN', 'CIS-2'].map((t) => `<option ${form.token === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></label>
        <label>Amount <input data-field="amount" value="${esc(form.amount)}" inputmode="decimal" ${busy ? 'disabled' : ''}></label>
        <label class="wide">Recipient (a testnet address)
          <input data-field="recipient" value="${esc(form.recipient)}" placeholder="e.g. the funding account" ${busy ? 'disabled' : ''}></label>
        ${s.fundingAddress ? `<button data-action="use-funding" ${busy ? 'disabled' : ''}>Use the funding account</button>` : ''}
      </div>
      <div class="send-actions">
        <button data-action="quote" ${busy ? 'disabled' : ''}>Check the fee</button>
        ${q ? `<span class="fee ${q.enough ? '' : 'short'}">Fee ${esc(q.feeText)} (paid in CCD by your account)${q.enough ? '' : ` · not enough CCD: needs ${esc(q.neededText)}`}</span>` : ''}
        <button class="primary" data-action="send" ${busy || !q || !q.enough ? 'disabled' : ''}>${s.busy === 'sending'
          ? '<span class="spinner"></span>Sending…' : q ? `Send ${esc(q.amountText)}` : s.lastSend ? 'Check the fee to send again' : 'Check the fee first'}</button>
      </div>
      ${sendResult(s.lastSend, s.account)}
      <p class="note">The fee is quoted first by the WDK wallet module, then checked again before sending; a transfer is
        never sent twice.</p>
    </section>`;
}

/** This card's last send, in place: sending (spinner), sent (with the new balance), or failed. */
function sendResult(r, account) {
  if (!r) return '';
  if (r.status === 'sending') return `<div class="result sending"><span class="spinner"></span>Sending ${esc(r.what)} (fee ${esc(r.feeText)}), waiting until final…</div>`;
  if (r.status === 'failed') return `<div class="result failed">✖ Not sent: ${esc(r.error)}</div>`;
  return `<div class="result sent">✔ Sent ${esc(r.what)} · final in ${esc(r.seconds)} s · fee ${esc(r.feeText)} ·
    <a href="${esc(r.link)}" target="_blank" rel="noopener">transaction ↗</a>
    <br>Your account now holds ${esc(r.balances.ccd)} · ${esc(r.balances.plt)} · ${esc(r.balances.cis2)}</div>`;
}

// ---- Step 6b: the sponsored send: three roles ------------------------------------------------------------------

function sponsoredCard(s) {
  if (s.funding === 'none') return '';
  const sp = s.sponsored;
  const role = (title, who, detail) => `
    <div class="role"><p class="role-title">${title}</p><p class="address">${esc(who)}</p>${detail}</div>`;
  const change = (party) => (party?.after
    ? `<p class="change">${esc(party.before.plt)} → <strong>${esc(party.after.plt)}</strong><br>${esc(party.before.ccd)} → <strong>${esc(party.after.ccd)}</strong></p>`
    : party?.before ? `<p class="change">${esc(party.before.plt)} · ${esc(party.before.ccd)}</p>` : '');
  return `
    <section class="card sponsored-card">
      <p class="eyebrow">Step 6b · Sponsored send · Phase 1</p>
      <h2>A token sent by an account with no CCD</h2>
      <p class="note">A second account of your identity receives some TN but <strong>no CCD</strong>, so it cannot pay a fee.
        It sends TN to your first account, and a <strong>sponsor</strong> (standing in for the wallet operator) pays the
        fee. New users can move a token straight away, without first buying CCD.</p>
      ${sp ? `
        <div class="roles">
          ${role('Sender · account 1', sp.sender.address, change(sp.sender))}
          ${role('Recipient · account 0', sp.recipient.address, change(sp.recipient))}
          ${role('Sponsor · pays the fee', sp.sponsor.address, `<p class="change">the funding account</p>${change(sp.sponsor)}${sp.sponsor.feeText ? `<p class="change">fee paid: <strong>${esc(sp.sponsor.feeText)}</strong></p>` : ''}`)}
        </div>
        ${sp.link ? `<p><a class="link" href="${esc(sp.link)}" target="_blank" rel="noopener">The sponsored transaction on CCDScan ↗</a></p>` : ''}` : ''}
      <button class="primary" data-action="sponsored" ${s.busy ? 'disabled' : ''}>${s.busy === 'sponsoring'
        ? '<span class="spinner"></span>Running the sponsored send…' : sp?.link ? 'Run it again' : 'Run the sponsored send'}</button>
    </section>`;
}

/** The new account: address, path and where to see it. */
function accountCard(s) {
  return `
    <section class="card account-card">
      <p class="eyebrow">Step 4 · Account · Phase 2</p>
      <h2>Your ${s.account.created ? 'new ' : ''}account is on chain ✔</h2>
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

/** The history of this session: every step so far, running (spinner), done (with a CCDScan link), or failed. */
function activity(s) {
  if (!s.activity?.length) return '';
  return `
    <section class="history">
      <h3>History of this session</h3>
      <p class="note">Every step since Start, oldest first, with links to the transactions on CCDScan.</p>
      <ul class="activity">${s.activity.map((line) => `
    <li class="${line.status}">${line.status === 'running' ? '<span class="spinner"></span>' : line.status === 'done' ? '✔ ' : '✖ '}${esc(line.text)}${line.link
      ? ` · <a href="${esc(line.link)}" target="_blank" rel="noopener">transaction ↗</a>` : ''}</li>`).join('')}</ul>
    </section>`;
}

// ---- Drawing and clicks ----------------------------------------------------------------------------------------

let lastDrawn = '';
let verifyLink = null; // the provider link, kept on the page in case the new tab was blocked

function draw(state) {
  if (state.verification) state.verification.link = verifyLink;
  let html;
  if (closing) {
    html = closingCard();
  } else {
    html = (prefs.story ? captionFor(state) : '') + (views[state.step] ?? views.start)(state);
    if (prefs.code) {
      const panel = codeFor(state);
      html = html.includes('<section class="history">') ? html.replace('<section class="history">', `${panel}<section class="history">`) : html + panel;
    }
    html += state.error ? `<p class="error">${esc(state.error)}</p>` : '';
  }
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

const rememberField = (event) => {
  const field = event.target.dataset?.field;
  if (!field) return;
  form[field] = event.target.value;
  if (form.quote) { form.quote = null; lastDrawn = ''; refresh(); }
};
app.addEventListener('input', rememberField);
app.addEventListener('change', rememberField);

app.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.action === 'start') await api('/api/start', { method: 'POST', body: {} });
    if (button.dataset.action === 'finish') { closing = true; lastDrawn = ''; window.scrollTo(0, 0); }
    if (button.dataset.action === 'back') { closing = false; lastDrawn = ''; }
    if (button.dataset.action === 'restart') {
      await api('/api/reset', { method: 'POST', body: {} });
      closing = false; lastDrawn = '';
      Object.assign(form, { token: 'CCD', recipient: '', amount: '1', quote: null });
      verifyLink = null;
      window.scrollTo(0, 0);
    }
    if (button.dataset.action === 'create-account') await api('/api/create-account', { method: 'POST', body: {} });
    if (button.dataset.action === 'receive') await api('/api/receive', { method: 'POST', body: {} });
    if (button.dataset.action === 'use-funding') {
      form.recipient = (await api('/api/state')).fundingAddress;
      form.quote = null;
      lastDrawn = '';
    }
    if (button.dataset.action === 'quote') {
      form.quote = null;
      form.quote = await api('/api/quote', { method: 'POST', body: { token: form.token, recipient: form.recipient, amount: form.amount } });
      lastDrawn = '';
    }
    if (button.dataset.action === 'send') {
      await api('/api/send', { method: 'POST', body: { token: form.token, recipient: form.recipient, amount: form.amount } });
      form.quote = null;
    }
    if (button.dataset.action === 'sponsored') await api('/api/sponsored', { method: 'POST', body: {} });
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

for (const [id, key] of [['story-mode', 'story'], ['show-code', 'code']]) {
  const box = document.getElementById(id);
  box.checked = prefs[key];
  box.addEventListener('change', () => {
    prefs[key] = box.checked;
    try { localStorage.setItem('demo-wallet-prefs', JSON.stringify(prefs)); } catch { /* fine: this session only */ }
    lastDrawn = '';
    refresh();
  });
}

refresh();
setInterval(refresh, 1000);
