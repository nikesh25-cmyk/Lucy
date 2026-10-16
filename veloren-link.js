// The Veloren account-link page. Plain DOM, text only (nothing from the server or the game is ever
// inserted as markup), same-origin requests that carry NemoWorld's own session cookie.
const base = '/api/v1/veloren/identity';
const $ = (id) => document.getElementById(id);
const sections = ['signed-out', 'disabled', 'linked', 'unlinked'];
let pending = null;   // { code, alias } between "Check" and "Link"

function show(name, focusId) {
  for (const id of sections) $(id).hidden = id !== name;
  if (focusId) $(focusId).focus();
}

function say(message, kind = '') {
  const status = $('status');
  status.textContent = message || '';
  status.className = `status ${kind}`.trim();
  status.hidden = !message;
}

async function call(path, input) {
  const init = { credentials: 'same-origin', headers: {} };
  if (input !== undefined) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(input); }
  const response = await fetch(base + path, init);
  let data = {};
  try { data = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, data };
}

function when(ms) {
  try { return new Date(ms).toLocaleString(); } catch { return ''; }
}

function renderProgress(data) {
  const list = $('progress');
  list.replaceChildren();
  for (const step of data.progress?.steps || []) {
    const item = document.createElement('li');
    item.dataset.state = step.state;
    item.textContent = step.instruction;
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = step.state === 'done' ? `Done, seen by the game server${step.completed_at ? ` on ${when(step.completed_at)}` : ''}` : 'Not done yet';
    item.append(state);
    list.append(item);
  }
  const notes = data.notes || [];
  $('notes').textContent = notes.length ? `Lyra's notes: ${notes.map((note) => note.note).join(' ')}` : '';
}

async function refresh(focus = true) {
  $('remove-confirm').hidden = true; $('confirm').hidden = true; pending = null;
  const me = await call('/me');
  if (me.status === 401) { say(''); show('signed-out'); return; }
  if (me.status === 404) { say(''); show('disabled'); return; }
  if (me.status !== 200) { say(me.data.error || 'Could not load your link.', 'error'); return; }
  if (!me.data.linked) { show('unlinked', focus ? 'unlinked-title' : null); return; }
  $('linked-alias').textContent = me.data.player_alias;
  $('linked-at').textContent = when(me.data.linked_at);
  show('linked', focus ? 'linked-title' : null);
  const progress = await call('/progress');
  if (progress.status === 200) renderProgress(progress.data);
}

$('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('code').value.trim();
  if (!code) { say('Type the code Lyra sent you.', 'error'); $('code').focus(); return; }
  $('check').disabled = true;
  try {
    const result = await call('/check', { code });
    if (result.status !== 200) { say(result.data.error || 'That code did not work.', 'error'); $('code').focus(); return; }
    pending = { code, alias: result.data.player_alias };
    $('confirm-alias').textContent = result.data.player_alias;
    $('confirm').hidden = false;
    say('Code accepted. Check the character name below.', 'ok');
    $('confirm-yes').focus();
  } catch { say('Could not reach NemoWorld. Try again.', 'error'); }
  finally { $('check').disabled = false; }
});

$('confirm-no').addEventListener('click', () => { pending = null; $('confirm').hidden = true; say(''); $('code').focus(); });

$('confirm-yes').addEventListener('click', async () => {
  if (!pending) return;
  $('confirm-yes').disabled = true;
  try {
    const result = await call('/redeem', { code: pending.code, expect_alias: pending.alias });
    if (result.status !== 200) { say(result.data.error || 'Linking failed.', 'error'); $('confirm').hidden = true; pending = null; $('code').focus(); return; }
    $('code').value = '';
    say(`Linked. Lyra will confirm in the game.`, 'ok');
    await refresh();
  } catch { say('Could not reach NemoWorld. Try again.', 'error'); }
  finally { $('confirm-yes').disabled = false; }
});

$('remove').addEventListener('click', () => { $('remove-confirm').hidden = false; $('remove-yes').focus(); });
$('remove-no').addEventListener('click', () => { $('remove-confirm').hidden = true; $('remove').focus(); });
$('remove-yes').addEventListener('click', async () => {
  $('remove-yes').disabled = true;
  try {
    const result = await call('/remove', {});
    if (result.status !== 200) { say(result.data.error || 'Could not remove the link.', 'error'); return; }
    say('The link was removed.', 'ok');
    await refresh();
  } catch { say('Could not reach NemoWorld. Try again.', 'error'); }
  finally { $('remove-yes').disabled = false; }
});

refresh(false).catch(() => say('Could not reach NemoWorld. Try again.', 'error'));
