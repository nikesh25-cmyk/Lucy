import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECTATOR_STATUS, SPECTATOR_READS, SPECTATOR_VIEWPORT, SPECTATOR_WRITE_RULE, spectatorRefusal,
  spectatorRefusalFor, wrapFacing, spectatorStep, spectatorFacingLabel, createReadonlyTransport,
  createSpectatorCamera, createSpectatorView,
} from '../src/ui/spectator.js';

// The spectator component as a module: the camera it moves, the status it shows, the refusals it
// renders, and the writes it must never issue. Nothing here touches the network or a database.

const payload = (overrides = {}) => ({
  world: { id: 'commons', name: 'The Commons', kind: 'outdoors', visibility: 'public', width: 48, height: 48, description: '', ambiance: 'day' },
  camera: { x: 14, y: 17 },
  bounds: { columns: 48, rows: 48 },
  participants: [
    { id: 'res-1', name: 'Ada', kind: 'agent', x: 24, y: 24, z: 0, status: 'active', posture: 'standing', presence: 'connected', operator_id: 'op-1', operator: 'Operator One', capabilities: 'summarize', limitations: 'none' },
  ],
  messages: [
    { id: 'msg-public', channel: 'public', world_id: 'commons', text: 'A public greeting.', author: 'Ada', created_at: '2026-10-13T00:00:00.000Z', recipients: '[]', mission_id: null, account_id: 'acc-1', agent_id: 'res-1' },
    { id: 'msg-private', channel: 'private', world_id: 'commons', text: 'A private note.', author: 'Ada', created_at: '2026-10-13T00:00:00.000Z', recipients: '["res-1"]', mission_id: null, account_id: 'acc-1', agent_id: 'res-1' },
  ],
  objects: [{ id: 'obj-1', type: 'tree', x: 10, y: 10 }],
  portals: [{ x: 11, y: 6, name: 'Gallery', target_world_id: 'gallery' }],
  paused: false,
  counts: { world_agents: 1, visible_agents: 1 },
  ...overrides,
});

/** A read double that records every request, so a test can prove what the component asked for. */
function reader(handlers = {}) {
  const calls = [];
  return {
    calls,
    read: async (path, params = {}) => {
      calls.push({ path, params });
      const handler = handlers[path];
      if (!handler) throw Object.assign(new Error('The observation view may not read ' + path + '.'), { status: 403, rule: 'read_not_allowed' });
      return typeof handler === 'function' ? handler(params) : handler;
    },
  };
}

/** A subscribe double that only fires its handlers when the test asks it to. */
function streamer() {
  const opened = [];
  return {
    opened,
    subscribe: (worldId, handlers) => { const record = { worldId, handlers, closed: 0 }; opened.push(record); return { close: () => { record.closed += 1; } }; },
  };
}

const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, found);
  else if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) { found.add(key); keysDeep(nested, found); }
  return found;
};

test('the observer camera walks the way the first-person camera walks', () => {
  for (const [yaw, forward, right] of [[0, 'up', 'right'], [Math.PI / 2, 'left', 'up'], [Math.PI, 'down', 'left'], [-Math.PI / 2, 'right', 'down']]) {
    assert.equal(spectatorStep('up', yaw), forward);
    assert.equal(spectatorStep('right', yaw), right);
  }
  assert.equal(spectatorStep('up', 2 * Math.PI + 0.2), spectatorStep('up', 0.2));
  for (const [direction, yaw] of [['jump', 0], ['up', NaN], ['left', Infinity]]) assert.throws(() => spectatorStep(direction, yaw), TypeError);
  assert.equal(spectatorFacingLabel(0), 'north');
  assert.equal(spectatorFacingLabel(Math.PI / 2), 'west');
  assert.equal(spectatorFacingLabel(Math.PI), 'south');
  assert.equal(Math.abs(wrapFacing(3 * Math.PI)), Math.PI, 'a facing outside the range wraps into it');
  assert.equal(wrapFacing(0.4), 0.4);
});

test('an observer pans inside the world bounds and in first person follows the camera', () => {
  const camera = createSpectatorCamera({ position: { x: 2, y: 2 } });
  camera.setBounds({ columns: 5, rows: 4 });
  assert.deepEqual({ x: camera.view().x, y: camera.view().y }, { x: 2, y: 2 });
  assert.deepEqual({ x: camera.pan('left').x, y: camera.view().y }, { x: 1, y: 2 });
  camera.pan('up'); camera.pan('up'); camera.pan('up');
  assert.equal(camera.view().y, 0, 'panning cannot leave the world');
  for (let i = 0; i < 9; i += 1) camera.pan('left');
  assert.equal(camera.view().x, 0, 'the observer viewpoint is clamped to the returned bounds');
  camera.setMode('first-person');
  camera.place({ x: 2, y: 2 }, { yaw: Math.PI / 2 });
  assert.equal(camera.pan('up').x, 1, 'in first person one step is view-relative, as walking is');
});

test('following a visible resident pins the target and a pan releases it', () => {
  const camera = createSpectatorCamera({ position: { x: 1, y: 1 } });
  camera.followResident({ id: 'res-1', x: 9, y: 9, z: 0 });
  assert.equal(camera.following(), 'res-1');
  assert.deepEqual(camera.target(), { x: 9, y: 9, z: 0 });
  assert.equal(camera.moveResident('res-2', { x: 0, y: 0 }), false, 'another resident cannot move the followed target');
  assert.equal(camera.moveResident('res-1', { x: 10, y: 9 }), true);
  assert.deepEqual(camera.target(), { x: 10, y: 9, z: 0 });
  camera.pan('down');
  assert.equal(camera.following(), null, 'the camera has one target owner, so a pan ends the follow');
});

test('a visitor with no session has no live channel and is told so, honestly', async () => {
  const { read } = reader({ '/world': payload() });
  const view = createSpectatorView({ read, world: 'commons' });
  assert.equal(view.anonymous, true);
  const opened = await view.open('commons');
  assert.equal(opened.ok, true);
  assert.equal(view.status().state, SPECTATOR_STATUS.SNAPSHOT);
  assert.equal(view.status().live, false);
  assert.equal(view.status().reason, 'no_session');
  assert.match(view.status().detail, /no live feed without a session/i);
  assert.equal(view.frames(), 0);
});

test('a session observer is connected, reconnects after a drop and recovers from a snapshot', async () => {
  const { read } = reader({ '/world': payload() });
  const s = streamer();
  const view = createSpectatorView({ read, subscribe: s.subscribe, world: 'commons' });
  assert.equal(view.anonymous, false);
  await view.open('commons');
  assert.equal(s.opened.length, 1, 'opening a world starts exactly one subscription');
  s.opened[0].handlers.onReady();
  assert.equal(view.status().state, SPECTATOR_STATUS.CONNECTED);
  assert.equal(view.status().live, true);
  const dropped = view.lose('buffer_overflow');
  assert.equal(dropped.state, SPECTATOR_STATUS.RECONNECTING);
  assert.equal(dropped.reason, 'buffer_overflow');
  assert.match(dropped.detail, /last confirmed snapshot/i);
  assert.equal(s.opened[0].closed, 1, 'a lost feed is closed, not left half-open');
  const recovered = await view.recover();
  assert.equal(recovered.ok, true, 'recovery re-reads the authoritative world');
  assert.equal(recovered.status.state, SPECTATOR_STATUS.RECONNECTING, 'recovery is only complete when the channel says so');
  assert.equal(recovered.status.reason, 'recovered');
  assert.match(recovered.status.detail, /authoritative public snapshot/i);
  assert.equal(s.opened.length, 2, 'recovery opens a fresh subscription');
  s.opened[1].handlers.onReady();
  assert.equal(view.status().state, SPECTATOR_STATUS.CONNECTED);
});

test('a subscription refusal with no session degrades to a snapshot instead of a broken screen', async () => {
  const { read } = reader({ '/world': payload() });
  const view = createSpectatorView({ read, subscribe: () => { throw Object.assign(new Error('Sign in to subscribe to world events.'), { status: 401 }); } });
  await view.open('commons');
  assert.equal(view.status().state, SPECTATOR_STATUS.SNAPSHOT);
  assert.equal(view.status().reason, 'no_session');
  assert.equal(view.snapshot().world.name, 'The Commons', 'the public view is still there');
});

test('an observer chooses a public location from the public world list', async () => {
  const { read, calls } = reader({
    '/worlds': { worlds: [{ id: 'commons', name: 'The Commons', kind: 'outdoors', visibility: 'public', owner_agent_id: null, width: 48 }, { id: 'home:res-1', name: 'Ada’s garden', kind: 'home', visibility: 'public', owner_agent_id: 'res-1', agent_count: 1 }, { id: 'home:res-2', name: 'Secret garden', kind: 'home', visibility: 'private', owner_agent_id: 'res-2' }], total: 2, has_more: false, shared_count: 30 },
    '/world': (params) => payload({ world: { ...payload().world, id: params.world_id, name: params.world_id === 'commons' ? 'The Commons' : 'Ada’s garden', kind: params.world_id === 'commons' ? 'outdoors' : 'home' } }),
  });
  const view = createSpectatorView({ read, world: 'commons' });
  const list = await view.worldList({ q: '', limit: 20 });
  assert.equal(list.ok, true);
  assert.deepEqual(list.worlds.map((world) => world.id), ['commons', 'home:res-1'], 'a private garden is never listed as a place to choose');
  assert.equal(list.shared_count, 30);
  const chosen = await view.intent({ kind: 'choose-location', world_id: 'home:res-1' });
  assert.equal(chosen.ok, true);
  assert.equal(view.worldId(), 'home:res-1');
  assert.deepEqual(calls.map((call) => call.path), ['/worlds', '/world']);
});

test('a private world is refused with the server’s own sentence, not a blank view', async () => {
  const { read } = reader({ '/world': () => { throw Object.assign(new Error('This garden is private.'), { status: 403 }); } });
  const view = createSpectatorView({ read, world: 'commons' });
  const result = await view.open('home:res-2');
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.equal(result.rule, 'world_is_private');
  assert.equal(result.message, 'This garden is private.', 'the refusal renders the server’s own sentence');
  assert.ok(result.next_step.length > 0);
  assert.equal(view.snapshot(), null, 'no half-built view is left on screen');
  assert.equal(view.lastRefusal().world, 'home:res-2');
  assert.equal(view.status().detail, 'This garden is private.', 'the status line names the refusal, not a silent freeze');
  assert.equal(view.status().state, SPECTATOR_STATUS.SNAPSHOT);
});

test('a refused location never blanks a world the observer is already watching', async () => {
  const { read } = reader({ '/world': (params) => {
    if (params.world_id !== 'commons') throw Object.assign(new Error('This garden is private.'), { status: 403 });
    return payload();
  } });
  const view = createSpectatorView({ read });
  await view.open('commons');
  const result = await view.open('home:res-2');
  assert.equal(result.refused, true);
  assert.equal(view.worldId(), 'commons', 'the observer stays in the world it could read');
  assert.equal(view.snapshot().world.name, 'The Commons', 'the last good view is still on screen');
  assert.equal(view.status().detail, 'This garden is private.', 'the refusal is shown over the view that remains');
  assert.equal(view.status().state, SPECTATOR_STATUS.SNAPSHOT);
});

test('a missing world is a not-found refusal and a throttled read names the rule', () => {
  assert.equal(spectatorRefusalFor(Object.assign(new Error('World not found.'), { status: 404 })).rule, 'world_not_found');
  assert.equal(spectatorRefusalFor(Object.assign(new Error('Slow down.'), { status: 429 })).rule, 'read_throttled');
  assert.equal(spectatorRefusal('x', 'y').next_step, '');
});

test('following needs a resident the server reports, and the follow ends when they leave', async () => {
  const { read } = reader({ '/world': payload() });
  const view = createSpectatorView({ read });
  await view.open('commons');
  assert.deepEqual(view.snapshot().residents.map((resident) => resident.id), ['res-1']);
  const missing = await view.intent({ kind: 'follow', resident_id: 'nobody' });
  assert.equal(missing.refused, true);
  assert.equal(missing.rule, 'resident_not_visible');
  const followed = await view.intent({ kind: 'follow', resident_id: 'res-1' });
  assert.equal(followed.ok, true);
  assert.deepEqual(view.target(), { x: 24, y: 24, z: 0 });
  const applied = view.applyFrame({ world_id: 'commons', agents: [{ id: 'res-1', x: 25, y: 24, z: 0 }] });
  assert.equal(applied.ok, true);
  assert.deepEqual(view.target(), { x: 25, y: 24, z: 0 }, 'the camera targets the confirmed tile, never a guess');
  const away = view.applyFrame({ world_id: 'commons', agents: [{ id: 'res-1', world_id: 'gallery' }] });
  assert.equal(away.ok, true);
  assert.equal(view.following(), null);
  assert.equal(view.lastRefusal().rule, 'resident_left');
  assert.ok(!view.snapshot().residents.some((resident) => resident.id === 'res-1'));
});

test('the component issues no write: every intent is either an allow-listed read or a refusal', async () => {
  const { read, calls } = reader({ '/world': payload(), '/worlds': { worlds: [], total: 0, has_more: false, shared_count: 0 } });
  const view = createSpectatorView({ read });
  await view.open('commons');
  await view.intent({ kind: 'world-list' });
  await view.intent({ kind: 'choose-location', world_id: 'commons' });
  await view.intent({ kind: 'pan', direction: 'left' });
  await view.intent({ kind: 'turn', yaw: 0.2, pitch: -0.1 });
  await view.intent({ kind: 'follow', resident_id: 'res-1' });
  await view.intent({ kind: 'unfollow' });
  await view.intent({ kind: 'set-mode', mode: 'first-person' });
  const refused = [];
  for (const kind of ['write', 'build', 'move', 'chat', 'interact', 'travel', 'memory', 'respawn', 'grant']) {
    const result = await view.intent({ kind });
    assert.equal(result.refused, true, `${kind} must be refused`);
    assert.equal(result.rule, SPECTATOR_WRITE_RULE.rule);
    refused.push(result.message);
  }
  assert.equal(new Set(refused).size, 1, 'one rule explains every refusal an observer meets');
  assert.ok(calls.every((call) => SPECTATOR_READS.includes(call.path)), 'only the allow-listed public reads were requested');
  assert.equal(calls.filter((call) => call.path === '/world').length, 2, 'choosing a location re-reads the world and nothing else');
});

test('no private message, memory or operator field reaches the view model', async () => {
  const { read } = reader({ '/world': payload() });
  const view = createSpectatorView({ read });
  await view.open('commons');
  const snapshot = view.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => message.id), ['msg-public'], 'only a public conversation is kept');
  assert.equal(snapshot.messages[0].recipients, undefined, 'a message recipient list is never kept');
  assert.equal(snapshot.messages[0].mission_id, undefined);
  assert.equal(snapshot.residents[0].operator_id, undefined);
  assert.equal(snapshot.residents[0].operator, undefined);
  const keys = keysDeep(snapshot);
  for (const forbidden of ['recipients', 'mission_id', 'account_id', 'memory', 'facts', 'proposals', 'journal', 'bio', 'email', 'token', 'credential']) {
    assert.ok(!keys.has(forbidden), `the view model must not carry a ${forbidden} field`);
  }
  // A live frame cannot smuggle a private field in either.
  view.applyFrame({ world_id: 'commons', messages: [{ id: 'sneak', channel: 'private', text: 'secret', recipients: '["res-1"]' }], agents: [{ id: 'res-2', name: 'Bob', x: 1, y: 1, operator_id: 'op-2', operator: 'Other' }] });
  assert.ok(!keysDeep(view.snapshot()).has('recipients'));
  assert.equal(view.snapshot().messages.some((message) => message.id === 'sneak'), false, 'a private frame message is dropped');
  assert.equal(view.snapshot().residents.find((resident) => resident.id === 'res-2').operator_id, undefined);
});

test('a frame from another world is refused instead of corrupting this view', async () => {
  const { read } = reader({ '/world': payload() });
  const view = createSpectatorView({ read });
  await view.open('commons');
  const other = view.applyFrame({ world_id: 'gallery', agents: [{ id: 'res-1', x: 0, y: 0 }] });
  assert.equal(other.refused, true);
  assert.equal(other.rule, 'frame_for_another_world');
  assert.deepEqual(view.snapshot().residents.map((resident) => [resident.id, resident.x, resident.y]), [['res-1', 24, 24]]);
  assert.equal(view.frames(), 0, 'a foreign frame is not counted as a received frame');
});

test('the read-only transport can only issue the allow-listed public GETs', async () => {
  const seen = [];
  const transport = createReadonlyTransport({
    fetch: async (url, options) => { seen.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
  });
  await transport.get('/world', { world_id: 'commons', view: 'voxel', nothing: undefined });
  assert.equal(seen[0].url, '/api/v1/world?world_id=commons&view=voxel', 'an undefined parameter is not sent');
  assert.equal(seen[0].options.method, 'GET');
  assert.deepEqual(transport.reads, [{ method: 'GET', path: '/world', at: transport.reads[0].at }]);
  assert.equal(typeof transport.post, 'undefined');
  await assert.rejects(() => transport.get('/memory', { agent_id: 'res-1' }), (error) => error.status === 403 && error.rule === 'read_not_allowed');
  await assert.rejects(() => transport.get('/me'), /may not read/);
  assert.equal(seen.length, 1, 'a refused read never reaches the network');
  for (const forbidden of ['/memory', '/journey', '/drafts', '/export', '/me', '/events', '/messages']) assert.ok(!SPECTATOR_READS.includes(forbidden), `${forbidden} must stay outside the observation surface`);
  assert.deepEqual([...SPECTATOR_READS], ['/worlds', '/world']);
});

test('an error from a read becomes the refusal the interface shows', async () => {
  const { read } = reader({ '/worlds': () => { throw Object.assign(new Error('Authentication required.'), { status: 401 }); } });
  const view = createSpectatorView({ read });
  const list = await view.worldList();
  assert.equal(list.refused, true);
  assert.equal(list.rule, 'read_needs_sign_in');
  assert.equal(list.message, 'Authentication required.');
  assert.ok(list.hint.length > 0 && list.next_step.length > 0);
  assert.equal(view.lastRefusal().rule, 'read_needs_sign_in');
});

test('the observer camera is placed on the world the server sent', async () => {
  const { read } = reader({ '/world': payload() });
  const view = createSpectatorView({ read });
  await view.open('commons');
  assert.deepEqual({ x: view.camera().x, y: view.camera().y }, { x: 14 + Math.floor(SPECTATOR_VIEWPORT.columns / 2), y: 17 + Math.floor(SPECTATOR_VIEWPORT.rows / 2) });
  assert.equal(view.facing(), 'north');
  const exact = createSpectatorView({ read, start: { x: 11, y: 6 } });
  await exact.open('commons');
  assert.deepEqual({ x: exact.camera().x, y: exact.camera().y }, { x: 11, y: 6 }, 'a supplied arrival point wins over the window centre');
});
