// The demo wallet page: draws the server's state and sends the clicks. It never sees a seed or a key.

const token = document.querySelector('meta[name="demo-token"]').content;

/** Call the demo server's API (with the page's token: other sites cannot add it). */
export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { 'x-demo-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
  return reply;
}

function draw(state) {
  document.getElementById('network').textContent = state.network;
  document.getElementById('funding').textContent = `funding: ${state.funding}`;
  document.getElementById('status').textContent = state.reuseIdentity
    ? `Ready. Using the saved identity ${state.identityIndex}.`
    : `Ready. A fresh identity will be verified (index ${state.identityIndex}).`;
}

async function refresh() {
  try {
    draw(await api('/api/state'));
  } catch (e) {
    document.getElementById('status').textContent = `The demo server did not answer: ${e.message}. Is it still running?`;
  }
}

refresh();
setInterval(refresh, 1000);
