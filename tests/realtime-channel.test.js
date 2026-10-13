import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createApp, EVENT_LIMITS } from '../server.js';
import { fixture } from './helpers.js';
import { getWorldDefinition, walkable } from '../world.js';

// The real-time event channel over its real HTTP surface. Every case opens a genuine Server-Sent
// Events subscription against the shipped server and reads the frames a real client would read.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await condition(); if (value) return value; await sleep(15); }
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

async function post(base, path, body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function patch(base, path, body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function openStream(base, { token, cookie, worldId }) {
  const url = new URL(base);
  const path = `/api/v1/events?world_id=${encodeURIComponent(worldId)}`;
  const state = { status: null, headers: null, frames: [], buffer: '', ended: false, error: null, body: '', opened: null };
  let resolveOpened;
  state.opened = new Promise((resolve) => { resolveOpened = resolve; });
  const request = httpRequest({ host: url.hostname, port: Number(url.port), path, method: 'GET', headers: { Host: url.host, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (response) => {
    state.status = response.statusCode; state.headers = response.headers; resolveOpened();
    if (response.statusCode !== 200) {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => { state.body = Buffer.concat(chunks).toString('utf8'); state.ended = true; });
      return;
    }
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      state.buffer += chunk;
      let index;
      while ((index = state.buffer.indexOf('\n\n')) !== -1) {
        const frame = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 2);
        let event = 'message', data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        state.frames.push({ event, data: data ? JSON.parse(data) : null, raw: frame });
      }
    });
    response.on('end', () => { state.ended = true; });
  });
  request.on('error', (error) => { state.error = error; state.ended = true; });
  request.end();
  state.close = () => { try { request.destroy(); } catch { /* already gone */ } };
  state.text = () => state.frames.map((frame) => frame.raw).join('\n');
  return state;
}

const updates = (stream) => stream.frames.filter((frame) => frame.event === 'update').map((frame) => frame.data);
const hasUpdate = (stream, predicate) => waitFor(() => updates(stream).find(predicate), 'a matching update frame');

/** Walk the resident in the first direction the server confirms, and report the stored tile. */
async function walkOneTile(f, base, token, agentId) {
  for (const direction of ['up', 'down', 'left', 'right']) {
    const before = f.platform.get('SELECT x,y FROM agents WHERE id=?', agentId);
    f.advance(200);
    const result = await post(base, '/move', { agent_id: agentId, direction }, { Authorization: `Bearer ${token}` });
    assert.equal(result.status, 200, `move ${direction} must be accepted: ${JSON.stringify(result.body)}`);
    const after = f.platform.get('SELECT x,y FROM agents WHERE id=?', agentId);
    if (after.x !== before.x || after.y !== before.y) return after;
  }
  throw new Error('the resident could not step in any direction from its arrival tile');
}

test('an event subscription requires a credential and the right to read the world', async (t) => {
  const { f, base } = await serve(t);
  const anonymous = openStream(base, { worldId: 'commons' });
  await anonymous.opened;
  assert.equal(anonymous.status, 401, 'an anonymous caller must be refused before any stream opens');
  assert.equal(anonymous.headers['content-type'], 'application/json; charset=utf-8');
  assert.match(anonymous.body, /Sign in/);
  anonymous.close();

  const member = openStream(base, { token: f.credentials.alice.token, worldId: 'commons' });
  await member.opened;
  assert.equal(member.status, 200, 'a signed-in member may observe a public world');
  member.close();

  // Alice's own garden is public by default; making it private must lock the channel for an outsider.
  const alice = f.agent('alice', 'Alice walker');
  const garden = `home:${alice.id}`;
  await patch(base, `/agents/${alice.id}/home`, { visibility: 'private' }, { Authorization: `Bearer ${f.credentials.alice.token}` });
  const refused = openStream(base, { token: f.credentials.bob.token, worldId: garden });
  await refused.opened;
  assert.equal(refused.status, 403, 'an authenticated but unentitled caller must be refused a private world');
  assert.match(refused.body, /private/i);
  refused.close();
  assert.equal(f.platform.get('SELECT visibility FROM worlds WHERE id=?', garden).visibility, 'private');
});

test('a subscriber sees another resident move, and the database agrees', async (t) => {
  const { f, base } = await serve(t);
  const walker = f.agent('alice', 'Alice walker');
  const stream = openStream(base, { token: f.credentials.bob.token, worldId: 'commons' });
  await stream.opened;
  assert.equal(stream.status, 200);
  const ready = await waitFor(() => stream.frames.find((frame) => frame.event === 'ready'), 'the ready frame');
  assert.equal(ready.data.world_id, 'commons');

  const stored = await walkOneTile(f, base, f.credentials.alice.token, walker.id);
  const frame = await hasUpdate(stream, (update) => update.agents?.some((agent) => agent.id === walker.id));
  const seen = frame.agents.find((agent) => agent.id === walker.id);
  assert.deepEqual({ x: seen.x, y: seen.y }, { x: stored.x, y: stored.y }, 'the pushed tile must equal the stored tile');
  assert.equal(f.platform.get('SELECT x FROM agents WHERE id=?', walker.id).x, stored.x);
  stream.close();
});

test('public chat is pushed while private and nearby conversations never are', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const bob = f.agent('bob', 'Bob walker');
  const witness = f.agent('moderator', 'Moderator walker');
  // Park the third party beside Alice so a `nearby` message would legitimately reach it by the route's
  // own rule. The channel must still push nothing: it carries public conversation only.
  f.platform.run("UPDATE agents SET world_id='commons',x=11,y=6 WHERE id=?", witness.id);
  const stream = openStream(base, { token: f.credentials.moderator.token, worldId: 'commons' });
  await stream.opened;

  const secret = 'A private note that must never reach another subscriber';
  const nearbyText = 'A nearby aside that must never reach the channel';
  const publicText = 'A public greeting that every resident may read';
  await post(base, '/messages', { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: secret }, { Authorization: `Bearer ${f.credentials.alice.token}` });
  f.advance(2000);
  await post(base, '/messages', { agent_id: alice.id, channel: 'nearby', text: nearbyText }, { Authorization: `Bearer ${f.credentials.alice.token}` });
  f.advance(2000);
  await post(base, '/messages', { agent_id: alice.id, channel: 'public', text: publicText }, { Authorization: `Bearer ${f.credentials.alice.token}` });

  await hasUpdate(stream, (update) => update.messages?.some((message) => message.text === publicText));
  await sleep(200);
  assert.ok(!stream.text().includes(secret), 'a private message must never appear on the channel');
  assert.ok(!stream.text().includes(nearbyText), 'a nearby message must never appear on the channel');
  const delivered = updates(stream).flatMap((update) => update.messages || []);
  assert.deepEqual(delivered.map((message) => message.text), [publicText], 'only the public message is pushed');
  assert.equal(delivered[0].channel, 'public');
  stream.close();
});

test('a garden turning private revokes an outsider’s subscription mid-stream', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const garden = `home:${alice.id}`;
  const stream = openStream(base, { token: f.credentials.bob.token, worldId: garden });
  await stream.opened;
  assert.equal(stream.status, 200, 'a public garden may be observed');

  await patch(base, `/agents/${alice.id}/home`, { visibility: 'private' }, { Authorization: `Bearer ${f.credentials.alice.token}` });
  await waitFor(() => stream.frames.some((frame) => frame.event === 'closed'), 'the subscription to be revoked');
  const closed = stream.frames.find((frame) => frame.event === 'closed');
  assert.equal(closed.data.reason, 'access_revoked');
  await waitFor(() => stream.ended, 'the stream to end');
  assert.equal(f.platform.get('SELECT visibility FROM worlds WHERE id=?', garden).visibility, 'private');
});

test('a revoked session loses its subscription and its private feed stops', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice', 'Alice walker');
  const stream = openStream(base, { token: f.credentials.bob.token, worldId: 'commons' });
  await stream.opened;
  assert.equal(stream.status, 200);

  const logout = await post(base, '/auth/logout', {}, { Authorization: `Bearer ${f.credentials.bob.token}` });
  assert.equal(logout.status, 200);
  await waitFor(() => stream.frames.some((frame) => frame.event === 'closed'), 'the revoked subscription to close');
  assert.equal(stream.frames.find((frame) => frame.event === 'closed').data.reason, 'session_revoked');
  await waitFor(() => stream.ended, 'the revoked stream to end');

  // Nothing published after the revocation may reach the closed stream.
  const before = stream.text().length;
  f.advance(200);
  await post(base, '/move', { agent_id: alice.id, direction: 'down' }, { Authorization: `Bearer ${f.credentials.alice.token}` });
  await sleep(300);
  assert.equal(stream.text().length, before, 'a revoked subscriber must receive no further data');
});

test('a reconnecting client is rebuilt from an authoritative snapshot with no divergence', async (t) => {
  const { f, base, app } = await serve(t);
  const walker = f.agent('alice', 'Alice walker');
  const first = openStream(base, { token: f.credentials.bob.token, worldId: 'commons' });
  await first.opened;
  await walkOneTile(f, base, f.credentials.alice.token, walker.id);
  await hasUpdate(first, (update) => update.agents?.some((agent) => agent.id === walker.id));
  first.close();
  await waitFor(() => app.hub.size === 0, 'the server to notice the disconnected client');

  const stored = await walkOneTile(f, base, f.credentials.alice.token, walker.id);
  const second = openStream(base, { token: f.credentials.bob.token, worldId: 'commons' });
  await second.opened;
  const ready = await waitFor(() => second.frames.find((frame) => frame.event === 'ready'), 'the second ready frame');
  assert.equal(ready.data.world_id, 'commons');

  // The authoritative snapshot the client re-reads on reconnect is the `/world` route it already uses.
  const snapshot = await fetch(`${base}/api/v1/world?world_id=commons`, { headers: { Authorization: `Bearer ${f.credentials.bob.token}` } });
  const world = await snapshot.json();
  const published = world.participants.find((agent) => agent.id === walker.id);
  assert.deepEqual({ x: published.x, y: published.y }, { x: stored.x, y: stored.y }, 'the reconnect snapshot must agree with the stored position');

  // And the new subscription is live: the next move arrives without waiting for a poll.
  const again = await walkOneTile(f, base, f.credentials.alice.token, walker.id);
  await hasUpdate(second, (update) => update.agents?.some((agent) => agent.id === walker.id && agent.x === again.x && agent.y === again.y));
  second.close();
});

test('a saved object placed by one resident is pushed to another subscriber', async (t) => {
  const { f, base } = await serve(t);
  const builder = f.agent('alice', 'Alice walker');
  const garden = `home:${builder.id}`;
  // Move the resident home, then pick a buildable tile from the shared world definition so the test
  // never guesses at collision. Every published delta must carry exactly this cell.
  f.advance(300);
  const travel = await fetch(`${base}/api/v1/agents/${builder.id}/travel`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.credentials.alice.token}` }, body: JSON.stringify({ world_id: garden }) });
  assert.equal(travel.status, 200, await travel.text());

  const definition = getWorldDefinition(garden);
  const tile = [{ x: 17, y: 4 }, { x: 17, y: 3 }, { x: 16, y: 6 }, { x: 3, y: 8 }].find((candidate) => walkable(candidate, definition)) || null;
  assert.ok(tile, 'the garden fixture must offer a buildable tile');

  const stream = openStream(base, { token: f.credentials.bob.token, worldId: garden });
  await stream.opened;
  assert.equal(stream.status, 200, 'another resident may observe a public garden');

  const placed = await post(base, `/agents/${builder.id}/build`, { type: 'bench', ...tile }, { Authorization: `Bearer ${f.credentials.alice.token}` });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const frame = await hasUpdate(stream, (update) => update.objects?.some((object) => object.x === tile.x && object.y === tile.y));
  const object = frame.objects.find((item) => item.x === tile.x && item.y === tile.y);
  assert.equal(object.op, 'set');
  assert.equal(object.type, 'bench');
  assert.equal(f.platform.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, tile.x, tile.y).type, 'bench');
  stream.close();
});

test('one account cannot pile up unbounded subscriptions', async (t) => {
  const { f, base } = await serve(t);
  const streams = [];
  for (let index = 0; index < EVENT_LIMITS.max_connections_per_account; index++) {
    const stream = openStream(base, { token: f.credentials.alice.token, worldId: 'commons' });
    await stream.opened;
    assert.equal(stream.status, 200, `subscription ${index + 1} must open`);
    streams.push(stream);
  }
  const refused = openStream(base, { token: f.credentials.alice.token, worldId: 'commons' });
  await refused.opened;
  assert.equal(refused.status, 429, 'the per-account bound must refuse the extra subscription');
  assert.match(refused.body, /maximum number of event subscriptions/);
  for (const stream of streams) stream.close();
  refused.close();
});

test('the process holds at most the documented number of concurrent subscriptions', async (t) => {
  const { f, base, app } = await serve(t);
  // Sixteen accounts at the four-per-account bound is exactly the sixty-four connections one process
  // admits, so the next one is the server-wide refusal.
  const tokens = [f.credentials.alice.token, f.credentials.bob.token, f.credentials.reviewer.token, f.credentials.moderator.token, f.credentials.admin.token];
  while (tokens.length < 16) {
    const invite = f.tx('invite', f.actor('admin'), { role: 'member' });
    const account = await f.platform.register({ name: `Filler ${tokens.length}`, email: `filler-${tokens.length}@example.org`, password: 'filler-password-2026', consent: true, invite: invite.code });
    tokens.push(account.token);
  }
  const streams = [];
  for (const token of tokens) {
    for (let index = 0; index < EVENT_LIMITS.max_connections_per_account; index++) {
      const stream = openStream(base, { token, worldId: 'commons' });
      await stream.opened;
      assert.equal(stream.status, 200);
      streams.push(stream);
    }
  }
  assert.equal(streams.length, EVENT_LIMITS.max_connections, `the fixture must open exactly ${EVENT_LIMITS.max_connections} subscriptions`);
  assert.equal(app.hub.size, EVENT_LIMITS.max_connections);
  const refused = openStream(base, { token: tokens[0], worldId: 'commons' });
  await refused.opened;
  assert.equal(refused.status, 503, 'the process-wide bound must refuse the next subscription');
  assert.match(refused.body, /at capacity/);
  for (const stream of streams) stream.close();
  refused.close();
});
