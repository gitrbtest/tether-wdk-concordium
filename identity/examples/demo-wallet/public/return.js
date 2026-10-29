// The provider sends the browser here after verification, with its reply after "#" (browsers never send that
// part to a server). This page hands the full address to the demo server, then closes itself if it can.

const token = document.querySelector('meta[name="demo-token"]').content;
const message = document.getElementById('message');

try {
  const response = await fetch('/api/callback', {
    method: 'POST',
    headers: { 'x-demo-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: location.href }),
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
  message.textContent = 'Done. The demo wallet is collecting your identity; this tab will close.';
  setTimeout(() => window.close(), 1500); // works for the tab the demo page opened
  // A tab the page did not open (e.g. from the "open the provider's page" link) cannot close itself.
  setTimeout(() => {
    message.textContent = 'Done. You can close this tab and go back to the demo wallet tab.';
  }, 3000);
} catch (e) {
  message.textContent = `The demo wallet could not take the reply: ${e.message}`;
}
