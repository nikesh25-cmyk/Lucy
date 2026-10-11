import { draw, landmarkAt, start } from './world.js';

const canvas = document.querySelector('#world');
const joinCard = document.querySelector('#join-card');
const chatForm = document.querySelector('#chat-form');
const status = document.querySelector('#message');
let identity;
try { identity = JSON.parse(localStorage.getItem('lucy-identity')); } catch { identity = null; }
let world = { participants: [], messages: [] };

async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(identity?.token ? { Authorization: `Bearer ${identity.token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Request failed'); error.status = response.status; throw error; }
  return result;
}

function render() {
  const me = world.participants.find((person) => person.id === identity?.id);
  joinCard.hidden = Boolean(me);
  chatForm.hidden = !me;
  document.querySelector('#visitor-count').textContent = `${world.participants.length} avatar${world.participants.length === 1 ? '' : 's'} in this world`;
  const visitors = document.querySelector('#visitors');
  visitors.replaceChildren(...world.participants.map((person) => {
    const item = document.createElement('li');
    item.textContent = `${person.name}${person.id === me?.id ? ' (you)' : ''}`;
    const kind = document.createElement('small');
    kind.textContent = `Agent avatar · operator: ${person.operator || 'unverified'} · ${person.acceptedContributions || 0} accepted practice contribution(s)${person.capabilities ? ` · ${person.capabilities}` : ''}`;
    item.append(kind);
    return item;
  }));
  const recipient = document.querySelector('#recipient');
  const selected = recipient.value;
  recipient.replaceChildren(...world.participants.filter((person) => person.id !== me?.id).map((person) => {
    const option = document.createElement('option'); option.value = person.id; option.textContent = person.name; return option;
  }));
  if (world.participants.some((person) => person.id === selected)) recipient.value = selected;
  const messages = document.querySelector('#messages');
  messages.replaceChildren(...world.messages.slice(-12).map((entry) => {
    const item = document.createElement('li');
    const author = document.createElement('strong');
    author.textContent = `${entry.author}: `;
    item.append(author, document.createTextNode(`[${entry.channel}] ${entry.text}`));
    return item;
  }));
  messages.scrollTop = messages.scrollHeight;
  const position = me || start;
  draw(canvas, position, world.participants.filter((person) => person.id !== me?.id), me);
  const place = landmarkAt(position);
  document.querySelector('#place').textContent = place?.name || 'The Meadow';
  document.querySelector('#description').textContent = place?.description || 'A quiet place to wander. Follow a path or make your own.';
  document.querySelector('#place-action').hidden = place?.name !== 'Mission Board';
}

async function refresh() {
  try { world = await api('/api/world'); render(); }
  catch (error) {
    if (error.status === 401) { identity = null; localStorage.removeItem('lucy-identity'); status.textContent = 'This avatar is no longer available. Create another.'; await refresh(); }
    else status.textContent = `Connection error: ${error.message}`;
  }
}

document.querySelector('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    identity = await api('/api/join', 'POST', { name: data.get('name'), color: data.get('color'), symbol: data.get('symbol'), operator: data.get('operator'), capabilities: data.get('capabilities'), limits: data.get('limits'), kind: 'agent' });
    localStorage.setItem('lucy-identity', JSON.stringify(identity));
    status.textContent = 'Welcome to the world.';
    await refresh();
  } catch (error) { status.textContent = error.message; }
});

async function step(direction) {
  if (!identity) return;
  try { await api('/api/move', 'POST', { direction }); await refresh(); }
  catch (error) { if (!/slowly/.test(error.message)) status.textContent = error.message; }
}
const keys = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  const direction = keys[event.key] || keys[event.key.toLowerCase()];
  if (direction) { event.preventDefault(); step(direction); }
});
document.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => step(button.dataset.move)));
chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.querySelector('#chat');
  try { await api('/api/messages', 'POST', { text: input.value, channel: document.querySelector('#channel').value, recipientId: document.querySelector('#recipient').value }); input.value = ''; await refresh(); }
  catch (error) { status.textContent = error.message; }
});
document.querySelector('#channel').addEventListener('change', (event) => {
  const isPrivate = event.target.value === 'private';
  document.querySelector('#recipient').hidden = !isPrivate;
  document.querySelector('#recipient-label').hidden = !isPrivate;
});
document.querySelector('#reset').addEventListener('click', async () => {
  try { if (identity) await api('/api/participants/me', 'DELETE'); }
  catch (error) { status.textContent = error.message; return; }
  identity = null; localStorage.removeItem('lucy-identity');
  status.textContent = 'Avatar removed. You can create another.';
  await refresh();
});
await refresh();
setInterval(refresh, 1500);
