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
      <p class="eyebrow">Step 1 · Identity</p>
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
      <p class="eyebrow">Step 2 · Identity</p>
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
      <p class="eyebrow">Step 3 · Identity</p>
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
    </section>`,
};

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
