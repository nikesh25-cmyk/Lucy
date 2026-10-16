import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventHub, EVENT_LIMITS } from '../server.js';

// The channel's enforced bounds, proven directly against the shipped hub. HTTP-level behaviour is in
// realtime-channel.test.js; these cases drive the queue and rate limits that a real client only
// reaches under a slow or hostile socket.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition, label, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = condition(); if (value) return value; await sleep(10); }
  throw new Error(`timed out waiting for ${label}`);
};

const ACCOUNT = { id: 'account-1' };
function fakePlatform() {
  return {
    authorize: () => ({ account: ACCOUNT, agent: null, kind: 'session', credential: { hash: 'a'.repeat(64) } }),
    canReadWorld: () => true,
  };
}

/** A response double whose `write` starts refusing after `accept` frames, to model a slow client. */
function fakeResponse({ accept = Infinity } = {}) {
  const state = { status: null, chunks: [], ended: false, writes: 0, handlers: new Map() };
  return {
    writeHead(status, headers) { state.status = status; state.headers = headers; },
    write(chunk) { state.writes += 1; state.chunks.push(chunk); return state.writes <= accept; },
    end() { state.ended = true; },
    on(event, handler) { if (!state.handlers.has(event)) state.handlers.set(event, []); state.handlers.get(event).push(handler); },
    emit(event, ...args) { for (const handler of state.handlers.get(event) || []) handler(...args); },
    state,
  };
}

function subscribe(hub, options = {}) {
  const response = fakeResponse(options);
  const result = hub.subscribe({ actor: { account: ACCOUNT, kind: 'session', credential: { hash: 'a'.repeat(64) } }, worldId: options.worldId || 'commons', request: {}, response });
  return { response, result };
}

const frameOf = (response) => response.state.chunks.filter((chunk) => String(chunk).startsWith('event: update')).map((chunk) => JSON.parse(String(chunk).split('\ndata: ')[1]));

test('the documented bounds are the shipped numbers, not a test override', () => {
  assert.deepEqual({ ...EVENT_LIMITS }, {
    max_connections: 64, max_connections_per_account: 4, max_pending_updates: 256,
    max_pending_bytes: 65536, frames_per_second: 20, heartbeat_ms: 15000, revalidate_ms: 1000,
  });
});

test('many rapid updates coalesce into one frame that carries the newest state', async () => {
  const hub = createEventHub({ platform: fakePlatform() });
  const { response, result } = subscribe(hub);
  assert.equal(result.ok, true);
  for (let step = 0; step < 200; step++) hub.publish('commons', { agents: [{ id: 'walker', x: step, y: 0, z: 0 }] });
  await waitFor(() => frameOf(response).length === 1, 'the first coalesced frame');
  await sleep(150);
  const frames = frameOf(response);
  assert.equal(frames.length, 1, '200 updates between two ticks must collapse into one frame');
  assert.deepEqual(frames[0].agents, [{ id: 'walker', x: 199, y: 0, z: 0 }], 'the frame carries the newest confirmed state only');
  hub.closeAll();
});

test('one client never receives more than the documented frames per second', async () => {
  const hub = createEventHub({ platform: fakePlatform() });
  const { response } = subscribe(hub);
  const started = Date.now();
  while (Date.now() - started < 320) { hub.publish('commons', { agents: [{ id: `a${Date.now() % 50}`, x: 1, y: 1, z: 0 }] }); await sleep(2); }
  await sleep(80);
  const frames = frameOf(response).length;
  const allowed = Math.ceil((Date.now() - started) / (1000 / EVENT_LIMITS.frames_per_second)) + 2;
  assert.ok(frames <= allowed, `received ${frames} frames in ~320 ms; the ${EVENT_LIMITS.frames_per_second}/s bound allows ${allowed}`);
  assert.ok(frames >= 2, 'a continuously updating world must still receive frames');
  hub.closeAll();
});

test('repeating one avatar never grows the buffer; genuinely distinct state does', async () => {
  const hub = createEventHub({ platform: fakePlatform() });
  const { response } = subscribe(hub, { accept: 0 });
  // The socket refused the very first frame, so every later publish stays queued. Coalescing is what
  // keeps 5,000 moves of one avatar to a single pending entry instead of an unbounded queue.
  for (let step = 0; step < 5000; step++) hub.publish('commons', { agents: [{ id: 'walker', x: step % 40, y: 0, z: 0 }] });
  assert.equal(hub.counts().overflow_closed, 0, 'coalesced updates for one avatar must never overflow');
  assert.equal(hub.size, 1, 'the subscriber is still connected');
  assert.equal(response.state.ended, false);
  hub.closeAll();
});

test('a client that falls behind by more than the update bound is dropped, not buffered forever', async () => {
  const hub = createEventHub({ platform: fakePlatform() });
  const { response } = subscribe(hub, { accept: 0 });
  for (let index = 0; index <= EVENT_LIMITS.max_pending_updates; index++) hub.publish('commons', { agents: [{ id: `agent-${index}`, x: index, y: 0, z: 0 }] });
  assert.equal(hub.counts().overflow_closed, 1, 'the buffer bound must drop the slow client exactly once');
  assert.equal(hub.size, 0, 'the dropped subscriber is gone');
  assert.equal(response.state.ended, true, 'the stream is closed');
  const closed = response.state.chunks.find((chunk) => String(chunk).includes('event: closed'));
  assert.match(String(closed), /buffer_overflow/, 'the client is told why it was dropped');
  hub.closeAll();
});

test('a single oversized update also trips the byte bound', async () => {
  const hub = createEventHub({ platform: fakePlatform() });
  const { response } = subscribe(hub, { accept: 0 });
  hub.publish('commons', { agents: [{ id: 'walker', x: 0, y: 0, z: 0, blob: 'x'.repeat(EVENT_LIMITS.max_pending_bytes + 1000) }] });
  assert.equal(hub.counts().overflow_closed, 1, 'a payload past the byte bound must be refused');
  assert.match(String(response.state.chunks.find((chunk) => String(chunk).includes('event: closed'))), /buffer_overflow/);
  hub.closeAll();
});

test('the global connection bound refuses new subscribers without disturbing existing ones', () => {
  const hub = createEventHub({ platform: fakePlatform(), limits: { ...EVENT_LIMITS, max_connections: 2, max_connections_per_account: 8 } });
  assert.equal(subscribe(hub).result.ok, true);
  assert.equal(subscribe(hub).result.ok, true);
  const refused = subscribe(hub).result;
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 503);
  assert.equal(hub.size, 2, 'the refused subscriber never joined');
  assert.equal(hub.counts().refused, 1);
  hub.closeAll();
});

test('the per-account bound refuses one operator piling up subscriptions', () => {
  const hub = createEventHub({ platform: fakePlatform(), limits: { ...EVENT_LIMITS, max_connections_per_account: 2 } });
  assert.equal(subscribe(hub).result.ok, true);
  assert.equal(subscribe(hub).result.ok, true);
  const refused = subscribe(hub).result;
  assert.equal(refused.status, 429);
  assert.equal(hub.size, 2);
  hub.closeAll();
});

test('an idle connection is kept alive with a heartbeat comment', async () => {
  const hub = createEventHub({ platform: fakePlatform(), limits: { ...EVENT_LIMITS, heartbeat_ms: 60 } });
  const { response } = subscribe(hub);
  await waitFor(() => response.state.chunks.some((chunk) => String(chunk).includes(': ping')), 'a heartbeat comment');
  hub.closeAll();
});

test('a re-authorization that fails closes the subscription and ends the stream', async () => {
  let allowed = true;
  const platform = {
    authorize: () => { if (!allowed) throw Object.assign(new Error('revoked'), { status: 401 }); return { account: ACCOUNT, kind: 'session', credential: { hash: 'a'.repeat(64) } }; },
    canReadWorld: () => true,
  };
  const hub = createEventHub({ platform, limits: { ...EVENT_LIMITS, revalidate_ms: 50 } });
  const { response } = subscribe(hub);
  allowed = false;
  await waitFor(() => response.state.ended, 'the stream to close after re-authorization failed');
  assert.equal(hub.counts().revoked, 1);
  assert.match(String(response.state.chunks.find((chunk) => String(chunk).includes('event: closed'))), /session_revoked/);
  hub.closeAll();
});

test('losing read access to the world closes the subscription', async () => {
  let readable = true;
  const platform = {
    authorize: () => ({ account: ACCOUNT, kind: 'session', credential: { hash: 'a'.repeat(64) } }),
    canReadWorld: () => readable,
  };
  const hub = createEventHub({ platform, limits: { ...EVENT_LIMITS, revalidate_ms: 50 } });
  const { response } = subscribe(hub);
  readable = false;
  await waitFor(() => response.state.ended, 'the stream to close when the world became unreadable');
  assert.match(String(response.state.chunks.find((chunk) => String(chunk).includes('event: closed'))), /access_revoked/);
  hub.closeAll();
});

test('a closed hub holds no subscribers and refuses new ones', () => {
  const hub = createEventHub({ platform: fakePlatform() });
  subscribe(hub);
  hub.closeAll();
  assert.equal(hub.size, 0);
  assert.equal(subscribe(hub).result.status, 503);
});

test('publishing only ever reaches subscribers bound to that world', () => {
  const hub = createEventHub({ platform: fakePlatform() });
  const commons = subscribe(hub, { worldId: 'commons' });
  const garden = subscribe(hub, { worldId: 'home:someone' });
  hub.publish('commons', { messages: [{ id: 'm1', channel: 'public', text: 'hello' }] });
  return waitFor(() => frameOf(commons.response).length === 1, 'the commons subscriber to receive its frame').then(() => {
    assert.equal(frameOf(garden.response).length, 0, 'the other world’s subscriber must receive nothing');
    assert.equal(commons.result.world_id, 'commons');
    hub.closeAll();
  });
});
