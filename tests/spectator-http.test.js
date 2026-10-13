import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { createReadonlyTransport, createSpectatorView, SPECTATOR_STATUS } from '../src/ui/spectator.js';

// Observation mode against the shipped server: what an anonymous visitor may read, what the server
// refuses, and what a private world or a private conversation must never hand over. Every assertion
// is made over real HTTP on a disposable database.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await condition(); if (value) return value; await sleep(20); }
  throw new Error(`timed out waiting for ${label}`);
}

async function serve(t) {
  const f = await fixture(t);
  const app = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.stopEvents();
    await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
  });
  return { f, base, app };
}

const api = (base, path, options = {}) => fetch(`${base}/api/v1${path}`, { redirect: 'manual', ...options });
const json = async (base, path, options = {}) => { const response = await api(base, path, options); return { status: response.status, body: await response.json().catch(() => null) }; };
const post = (base, path, body, headers = {}) => json(base, path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });

/** A `subscribe` implementation over the real task-16 channel, mirroring the browser client's handlers. */
function liveSubscribe(base, session) {
  return (worldId, handlers) => {
    const url = new URL(base);
    const headers = { Host: url.host, ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) };
    const request = httpRequest({ host: url.hostname, port: Number(url.port), path: `/api/v1/events?world_id=${encodeURIComponent(worldId)}`, method: 'GET', headers }, (response) => {
      if (response.statusCode !== 200) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => { let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* a non-JSON refusal stays generic */ } handlers.onError(Object.assign(new Error(body.error || 'The live feed was refused.'), { status: response.statusCode })); });
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          let event = 'message', data = '';
          for (const line of frame.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
          const payload = data ? JSON.parse(data) : null;
          if (event === 'ready') handlers.onReady(payload);
          else if (event === 'update') handlers.onFrame(payload);
          else if (event === 'closed') handlers.onClosed(payload?.reason);
        }
      });
      response.on('aborted', () => handlers.onError(Object.assign(new Error('The live feed was interrupted.'), { status: 0 })));
      response.on('error', () => handlers.onError(Object.assign(new Error('The live feed failed.'), { status: 0 })));
    });
    request.on('error', () => handlers.onError(Object.assign(new Error('The live feed failed.'), { status: 0 })));
    request.end();
    return { close: () => { try { request.destroy(); } catch { /* already gone */ } } };
  };
}

test('a visitor with no account reads the public world and the public world list', async (t) => {
  const { base } = await serve(t);
  const world = await json(base, '/world?world_id=commons');
  assert.equal(world.status, 200, 'the public world view needs no credential');
  assert.equal(world.body.world.name, 'The Commons');
  assert.equal(world.body.world.visibility, 'public');
  assert.equal(world.body.viewer_agent_id, null, 'an anonymous read is a visitor view with no resident');
  assert.ok(Array.isArray(world.body.participants));

  const directory = await json(base, '/worlds?limit=20');
  assert.equal(directory.status, 200);
  assert.ok(directory.body.worlds.some((item) => item.id === 'commons'));
  assert.equal(directory.body.shared_count, 30, 'the thirty shared worlds are public reads');

  // The same flow through the component itself, over the real server and its real refusal messages.
  const transport = createReadonlyTransport({ fetch: (path) => fetch(new URL(path, base)), base: '/api/v1' });
  const view = createSpectatorView({ read: transport.get, world: 'commons' });
  const opened = await view.open('commons');
  assert.equal(opened.ok, true);
  assert.equal(view.snapshot().world.name, 'The Commons');
  assert.equal(view.status().state, SPECTATOR_STATUS.SNAPSHOT, 'a visitor with no session observes from snapshots');
});

test('the server refuses every write an observer could attempt and records none', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const before = {
    agent: f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id),
    messages: f.platform.get('SELECT COUNT(*) AS n FROM messages').n,
    objects: f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n,
    blocks: f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n,
    audits: f.platform.get('SELECT COUNT(*) AS n FROM audit').n,
  };
  const attempts = [
    ['/move', { agent_id: alice.id, direction: 'up' }],
    [`/agents/${alice.id}/look`, { yaw: 1, pitch: 0 }],
    [`/agents/${alice.id}/build`, { type: 'tree', x: 11, y: 6 }],
    [`/agents/${alice.id}/travel`, { world_id: 'gallery' }],
    ['/interact', { world_id: 'commons', x: 11, y: 6, agent_id: alice.id, action: 'sit' }],
    ['/messages', { agent_id: alice.id, channel: 'public', text: 'An observer trying to speak.' }],
    ['/frontier/build', { agent_id: alice.id, world_id: 'frontier:0:0', x: 30, y: 32, z: 0, type: 'wood' }],
    ['/memory/propose', { agent_id: alice.id, kind: 'purpose', attribute: 'intent', value: 'A fact an observer cannot record.' }],
  ];
  for (const [path, body] of attempts) {
    const result = await post(base, path, body, { Origin: base });
    assert.equal(result.status, 401, `${path} must be refused without a session: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error, 'Authentication required.', 'the refusal is the server’s ordinary sentence');
  }
  // A bare write with no Origin is refused even earlier, before any credential is considered.
  const bare = await fetch(`${base}/api/v1/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: alice.id, direction: 'up' }) });
  assert.equal(bare.status, 403, 'a browser write needs the same origin and an anonymous one never has it');
  const stored = f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
  assert.deepEqual({ x: stored.x, y: stored.y }, { x: before.agent.x, y: before.agent.y }, 'no step was stored');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages').n, before.messages, 'no message was stored');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n, before.objects, 'no object was stored');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, before.blocks, 'no block was stored');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM audit').n, before.audits, 'a refused observer left no audit trace of a write');
});

test('a private garden is refused with the server’s own sentence, not a blank screen', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const garden = `home:${alice.id}`;
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private' });

  const refused = await json(base, `/world?world_id=${encodeURIComponent(garden)}`);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'This garden is private.', 'the server names its own refusal');
  const missing = await json(base, '/world?world_id=home:no-such-resident');
  assert.equal(missing.status, 404);

  const transport = createReadonlyTransport({ fetch: (path) => fetch(new URL(path, base)), base: '/api/v1' });
  const view = createSpectatorView({ read: transport.get, world: 'commons' });
  const result = await view.open(garden);
  assert.equal(result.ok, false);
  assert.equal(result.rule, 'world_is_private');
  assert.equal(result.message, 'This garden is private.', 'the component shows the server’s sentence, not an empty view');
  assert.equal(view.snapshot(), null);
  assert.equal(view.status().detail, 'This garden is private.');
  const unknown = await view.open('home:no-such-resident');
  assert.equal(unknown.rule, 'world_not_found');
});

test('the public world list never reveals a private garden', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const bob = f.agent('bob', 'Bob walker');
  f.tx('homeSettings', f.actor('alice'), alice.id, { name: 'A Quiet Private Garden' });
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private' });
  f.tx('homeSettings', f.actor('bob'), bob.id, { name: 'A Public Open Garden' });

  const directory = await json(base, '/worlds?limit=50');
  assert.equal(directory.status, 200);
  const ids = directory.body.worlds.map((item) => item.id);
  assert.ok(ids.includes(`home:${bob.id}`), 'a public garden is listed');
  assert.ok(!ids.includes(`home:${alice.id}`), 'a private garden is not listed');
  assert.ok(!JSON.stringify(directory.body).includes('A Quiet Private Garden'), 'a private garden’s name is never sent');
});

test('no private conversation or resident memory is ever read by observation', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const bob = f.agent('bob', 'Bob walker');
  const secret = 'A private note that no observer may read';
  const memoryValue = 'A resident memory fact no observer may read';
  await post(base, '/messages', { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: secret }, { Authorization: `Bearer ${f.credentials.alice.token}` });
  f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: alice.id, kind: 'preference', attribute: 'working_style', value: memoryValue });
  assert.ok(f.platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE value=?", memoryValue).n >= 1, 'the private fact really exists');

  const response = await api(base, '/world?world_id=commons&view=voxel');
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!raw.includes(secret), 'a private conversation never appears in the public world payload');
  assert.ok(!raw.includes('"recipients"'), 'the public payload carries no message recipient list');
  assert.ok(!raw.includes(memoryValue), 'a resident memory fact never appears in the public world payload');
  assert.ok(!raw.includes('resident_memory'), 'the public payload mentions no memory table');
  const body = JSON.parse(raw);
  assert.ok(body.messages.every((message) => message.channel === 'public'), 'only public conversation is returned');

  assert.equal((await json(base, '/memory?agent_id=' + alice.id)).status, 401, 'resident memory needs a session even to ask');
  assert.equal((await json(base, '/journey?agent_id=' + alice.id)).status, 401);

  const transport = createReadonlyTransport({ fetch: (path) => fetch(new URL(path, base)), base: '/api/v1' });
  await assert.rejects(() => transport.get('/memory', { agent_id: alice.id }), (error) => error.rule === 'read_not_allowed');
  const view = createSpectatorView({ read: transport.get, world: 'commons' });
  await view.open('commons');
  assert.ok(!JSON.stringify(view.snapshot()).includes(secret));
  assert.ok(!JSON.stringify(view.snapshot()).includes(memoryValue));
  assert.ok(!JSON.stringify(view.snapshot()).includes('recipients'));
});

test('the live feed is refused without a session, so a visitor observes from snapshots', async (t) => {
  const { base } = await serve(t);
  const refused = await json(base, '/events?world_id=commons');
  assert.equal(refused.status, 401, 'the task-16 channel authenticates before it streams');
  assert.match(refused.body.error, /sign in/i);

  const transport = createReadonlyTransport({ fetch: (path) => fetch(new URL(path, base)), base: '/api/v1' });
  const view = createSpectatorView({ read: transport.get, world: 'commons', subscribe: liveSubscribe(base, { token: null }) });
  await view.open('commons');
  await waitFor(() => view.status().state === SPECTATOR_STATUS.SNAPSHOT, 'the refused feed to degrade to the snapshot');
  assert.equal(view.status().reason, 'no_session');
  assert.ok(view.snapshot().world.name);
});

test('a session observer is connected, follows a resident live, loses the feed and recovers', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const bob = f.agent('bob', 'Bob walker');
  const session = { token: f.credentials.bob.token };
  const transport = createReadonlyTransport({ fetch: (path) => fetch(new URL(path, base)), base: '/api/v1' });
  const view = createSpectatorView({ read: transport.get, subscribe: liveSubscribe(base, session), world: 'commons' });

  const opened = await view.open('commons');
  assert.equal(opened.ok, true);
  assert.equal(view.status().state, SPECTATOR_STATUS.RECONNECTING, 'until the channel reports ready the view is a snapshot');
  await waitFor(() => view.status().state === SPECTATOR_STATUS.CONNECTED, 'the live feed to become ready');
  assert.equal(view.status().live, true);

  const followed = await view.intent({ kind: 'follow', resident_id: alice.id });
  assert.equal(followed.ok, true, 'the observed resident is visible in the public snapshot');
  const start = view.target();
  let stored;
  for (const direction of ['up', 'down', 'left', 'right']) {
    f.advance(200);
    const before = f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
    const moved = await post(base, '/move', { agent_id: alice.id, direction }, { Authorization: `Bearer ${f.credentials.alice.token}` });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    stored = f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
    if (stored.x !== before.x || stored.y !== before.y) break;
  }
  await waitFor(() => view.target().x !== start.x || view.target().y !== start.y, 'the followed resident to move on the live feed');
  assert.deepEqual({ x: view.target().x, y: view.target().y }, { x: stored.x, y: stored.y }, 'the camera targets the tile the server stored');

  // The session is revoked server-side: the channel closes with its own reason and the view says so.
  await post(base, '/auth/logout', {}, { Authorization: `Bearer ${session.token}` });
  await waitFor(() => view.status().state === SPECTATOR_STATUS.RECONNECTING, 'the lost feed to be reported');
  assert.equal(view.status().reason, 'session_revoked');
  assert.match(view.status().detail, /last confirmed snapshot/i);
  assert.ok(view.snapshot(), 'the last authoritative snapshot stays on screen');

  // Recovery: sign in again, then re-read the world and reopen the feed from the fresh session.
  const login = await post(base, '/auth/login', { email: 'bob@example.org', password: 'local-test-password-2026' }, { 'x-api-client': 'operator' });
  assert.equal(login.status, 200);
  assert.ok(login.body.token, 'the operator client receives the fresh session token');
  session.token = login.body.token;
  await view.recover();
  await waitFor(() => view.status().state === SPECTATOR_STATUS.CONNECTED, 'the rebuilt feed to become ready');
  assert.equal(view.status().live, true);
});
