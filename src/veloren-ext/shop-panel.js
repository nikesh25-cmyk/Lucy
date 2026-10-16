// The operator's shop page, served by the shop extension itself (no `server.js` change): the three
// exports are the page, its script and its stylesheet, exactly like the Veloren link page.
//
// Same safety rules as the link page: text only (nothing from the server is ever inserted as markup),
// no inline script, style or event handler, and every request is same-origin and carries the
// operator's own session cookie.

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#051d18">
<meta name="description" content="Confirm Karma Coin purchases that linked Veloren players asked for in the game.">
<title>Veloren shop requests · NemoWorld</title>
<link rel="icon" type="image/svg+xml" href="/assets/nemoworld-mark.svg">
<link rel="stylesheet" href="/api/v1/veloren/shop/panel.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar"><a class="brand" href="/" aria-label="NemoWorld home"><img src="/assets/nemoworld-mark.svg" alt="" width="36" height="36"><span>NEMOWORLD</span></a></header>
<main id="main" tabindex="-1">
  <h1 id="title" tabindex="-1">Shop requests from the game</h1>
  <p class="lede">A linked player can ask a shopkeeper resident for a good. Asking costs nothing. Only you, signed in here, can confirm it: confirming spends the Karma Coins and asks the game to hand the good over. The order counts as delivered only when the game server acknowledges it.</p>

  <p id="status" role="status" aria-live="polite" class="status" hidden></p>

  <section id="signed-out" aria-labelledby="signed-out-title" hidden>
    <h2 id="signed-out-title">Sign in first</h2>
    <p>Open <a href="/">NemoWorld</a>, sign in as yourself, then come back to this page.</p>
  </section>

  <section id="unavailable" aria-labelledby="unavailable-title" hidden>
    <h2 id="unavailable-title">Not available</h2>
    <p>The Veloren shop is not switched on in this NemoWorld.</p>
  </section>

  <section id="shop" aria-labelledby="wallet-title" hidden>
    <h2 id="wallet-title" tabindex="-1">Your purse</h2>
    <p id="wallet" class="facts">No linked character yet, so there is nothing to show.</p>
    <div class="actions"><button type="button" id="refresh" class="secondary">Refresh</button></div>

    <h2 id="requests-title">Requests</h2>
    <p class="muted" id="empty">No requests. A player asks a shopkeeper resident in the game, by whispering to him.</p>
    <ul id="requests" class="requests" aria-labelledby="requests-title"></ul>
  </section>
</main>
<script type="module" src="/api/v1/veloren/shop/panel.js"></script>
</body>
</html>
`;

export const PANEL_JS = `// The operator side of the shop: list this account's requests, confirm one (which spends Karma and
// asks the game to deliver), decline one, or ask the game to deliver a paid order again. Plain DOM,
// text only, same-origin requests with NemoWorld's own session cookie.
const API = '/api/v1/veloren/shop';
const $ = (id) => document.getElementById(id);

function say(message, kind = '') {
  const status = $('status');
  status.textContent = message || '';
  status.className = ('status ' + kind).trim();
  status.hidden = !message;
}

function when(ms) {
  try { return new Date(ms).toLocaleString(); } catch { return ''; }
}

async function call(path, body, key) {
  const init = { credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    if (key) init.headers['Idempotency-Key'] = key;
    init.body = JSON.stringify(body);
  }
  const response = await fetch(API + path, init);
  let data = {};
  try { data = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, data };
}

function line(text, className) {
  const item = document.createElement('span');
  if (className) item.className = className;
  item.textContent = text;
  return item;
}

function button(label, className, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener('click', async () => {
    element.disabled = true;
    try { await onClick(); } catch { say('Could not reach NemoWorld. Try again.', 'error'); }
    finally { element.disabled = false; }
  });
  return element;
}

// One confirming click reuses the same Idempotency-Key; a fresh click gets a new one. The world also
// derives its own key from the request id, so a repeated confirmation can never charge twice.
let lastKey = null;
function idempotencyKey(requestId) {
  const fresh = !lastKey || lastKey.requestId !== requestId;
  if (fresh) lastKey = { requestId, key: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()) };
  return lastKey.key;
}

function render(request) {
  const item = document.createElement('li');
  item.dataset.state = request.state;
  const head = document.createElement('p');
  head.className = 'head';
  head.append(line(request.label + ' — ' + request.price + ' Karma', 'label'));
  head.append(line(' (code ' + request.code + ')', 'muted'));
  item.append(head);
  const facts = document.createElement('p');
  facts.className = 'facts';
  facts.textContent = 'from ' + request.player_alias + ' · asked ' + when(request.created_at) + ' · ' + request.text;
  item.append(facts);
  if (request.anomaly) item.append(line('Note: the game acknowledged this order more than once. Ask before acting.', 'warn'));
  const actions = document.createElement('p');
  actions.className = 'actions';
  if (request.can_confirm) {
    actions.append(button('Confirm and spend ' + request.price + ' Karma', 'primary', async () => {
      const result = await call('/requests/confirm', { request_id: request.request_id }, idempotencyKey(request.request_id));
      if (result.status !== 200) { say(result.data.error || 'Could not confirm this request.', 'error'); return; }
      lastKey = null;
      say(result.data.repeated ? 'That request was already confirmed; nothing more was charged.' : 'Confirmed. Asking the game to hand it over.', 'ok');
      await refresh();
    }));
    actions.append(button('Decline', 'secondary', async () => {
      const result = await call('/requests/decline', { request_id: request.request_id });
      if (result.status !== 200) { say(result.data.error || 'Could not decline this request.', 'error'); return; }
      say('Declined. Nothing was charged.', 'ok');
      await refresh();
    }));
  }
  if (request.can_retry) {
    actions.append(button(request.delivery === 'none' ? 'Ask the game to deliver it' : 'Retry delivery', 'primary', async () => {
      const result = await call('/orders/retry', { request_id: request.request_id });
      if (result.status !== 200) { say(result.data.error || 'Could not ask the game to deliver this order.', 'error'); return; }
      say('Asked the game again. It never delivers one order twice.', 'ok');
      await refresh();
    }));
  }
  if (request.purchase_id) item.append(line('purchase ' + request.purchase_id, 'muted'));
  item.append(actions);
  return item;
}

async function refresh(focus = false) {
  const list = $('requests');
  const result = await call('/requests');
  if (result.status === 401) { $('shop').hidden = true; $('signed-out').hidden = false; return; }
  if (result.status === 404) { $('shop').hidden = true; $('unavailable').hidden = false; return; }
  if (result.status !== 200) { say(result.data.error || 'Could not load your requests.', 'error'); return; }
  $('signed-out').hidden = true; $('unavailable').hidden = true;
  $('shop').hidden = false;
  const wallet = result.data.wallet;
  $('wallet').textContent = wallet
    ? 'You hold ' + wallet.balance + ' Karma Coins.'
    : 'No linked Veloren character on this account yet, so there is no purse to show.';
  const requests = result.data.requests || [];
  $('empty').hidden = requests.length > 0;
  list.replaceChildren(...requests.map(render));
  if (focus) $('wallet-title').focus();
}

$('refresh').addEventListener('click', async () => {
  try { await refresh(); say('', ''); } catch { say('Could not reach NemoWorld. Try again.', 'error'); }
});

refresh().catch(() => say('Could not reach NemoWorld. Try again.', 'error'));
`;

export const PANEL_CSS = `:root { color-scheme: dark; --ink: #eaf5f1; --muted: #9fbcb4; --bg: #051d18; --card: #0b2b23; --line: #17564a; --accent: #7fe3c8; --warn: #ffd79a; --bad: #ffb4a8; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 "DM Sans", system-ui, sans-serif; }
a { color: var(--accent); }
.bar { padding: 14px 20px; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; gap: 10px; align-items: center; color: var(--ink); text-decoration: none; letter-spacing: .12em; font-weight: 600; }
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 12px; top: 10px; background: var(--card); padding: 8px 12px; z-index: 9; }
main { max-width: 780px; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: 1.7rem; margin: 0 0 12px; outline: none; }
h2 { font-size: 1.15rem; margin: 28px 0 8px; outline: none; }
.lede, .muted, .facts { color: var(--muted); }
.status { padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.status.ok { border-color: var(--accent); color: var(--accent); }
.status.error { border-color: var(--bad); color: var(--bad); }
.requests { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.requests li { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; background: var(--card); }
.requests .head { margin: 0 0 6px; }
.requests .label { font-weight: 600; }
.requests .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; }
.requests .warn { display: block; color: var(--warn); margin: 6px 0 0; }
button { font: inherit; padding: 9px 14px; border-radius: 9px; border: 1px solid var(--line); background: #0f3a30; color: var(--ink); cursor: pointer; }
button.primary { background: var(--accent); color: #04231c; border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: .55; cursor: progress; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
`;
