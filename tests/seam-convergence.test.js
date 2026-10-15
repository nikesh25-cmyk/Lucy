// Convergence on stored truth after the four events that break a client's hold on the world: a
// reconnect, events missed while away, a real server restart mid-session, and simultaneous writes.
//
// The client here is the map client the shared world actually has: it holds global coordinates, it
// reads `/api/v1/map` for its snapshot, and it applies the channel's deltas through the same
// projection the browser uses (`src/map-view.js`). The invariant after every event is one:
//   the global tile this client draws for a resident equals the global tile of that resident's
//   stored row, and the world it attributes to it is the world that row names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';
import { fixture } from './helpers.js';
import { toMapItem } from '../src/map-view.js';
import { onMap, toGlobal } from '../src/global-map.js';
import { getWorldDefinition } from '../world.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const place = (p, agent, world, x, y, clock = Date.now()) => p.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0,last_seen=? WHERE id=?', world, x, y, clock, agent.id);
const storedTile = (platform, id) => { const row = platform.get('SELECT world_id,x,y FROM agents WHERE id=?', id); return { ...toGlobal(row.world_id, row.x, row.y), world_id: row.world_id }; };
async function settle(condition, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (condition()) return true; await sleep(15); }
  throw new Error(`timed out waiting for ${label}`);
}

/** A client of the shared world: global coordinates, rebuilt from `world?map=core`, then live deltas. */
function mapClient({ base, token, worldId, agentId, name }) {
  const state = { name, residents: new Map(), ready: false, buffering: false, queue: [], frames: 0, snapshots: 0, errors: [], streams: 0, entries: 0 };
  let stream = null, generation = 0;
  const remember = (item, fallback) => {
    const mapped = toMapItem(item, fallback);
    if (!mapped?.home_world_id || !onMap(mapped.home_world_id)) return;
    state.residents.set(item.id, { gx: mapped.x, gy: mapped.y, world_id: mapped.home_world_id });
    state.entries += 1;
  };
  const applyFrame = (frame) => {
    if (!frame || typeof frame !== 'object') return;
    state.frames += 1;
    for (const item of frame.agents || []) remember(item, worldId);
  };
  async function refresh(mine) {
    state.buffering = true;
    state.queue = [];
    let payload = null;
    try {
      // The window the client is drawing, centred on the resident it follows and clipped to the bound.
      const response = await fetch(`${base}/api/v1/map?world_id=${encodeURIComponent(worldId)}&agent_id=${encodeURIComponent(agentId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      payload = await response.json();
      if (!response.ok) state.errors.push(`snapshot HTTP ${response.status}`);
    } catch (error) { state.errors.push(`snapshot ${error.message}`); }
    if (mine !== generation) return;
    state.buffering = false;
    if (payload) {
      state.residents = new Map();
      for (const item of payload.participants || []) remember(item, item.world_id);
      state.window = payload.window;
      state.snapshots += 1;
      state.ready = true;
    } else state.ready = false;
    for (const frame of state.queue) if (mine === generation) applyFrame(frame);
    state.queue = [];
  }
  function connect() {
    return new Promise((resolve) => {
      state.ready = false;
      state.streams += 1;
      const mine = ++generation;
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const url = new URL(base);
      const request = httpRequest({ host: url.hostname, port: url.port, method: 'GET', path: `/api/v1/events?world_id=${encodeURIComponent(worldId)}`, headers: { Host: url.host, Authorization: `Bearer ${token}` } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); done(false); return; }
        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk) => {
          buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let event = '', data = '';
            for (const line of block.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); }
            if (event === 'ready') void refresh(mine).then(() => done(true));
            else if (event === 'update' && data) { const frame = JSON.parse(data); if (state.buffering) state.queue.push(frame); else applyFrame(frame); }
          }
        });
        response.on('end', () => done(false));
        response.on('error', () => done(false));
      });
      request.on('error', (error) => { state.errors.push(String(error.code || error.message)); done(false); });
      request.end();
      stream = { close: () => { try { request.destroy(); } catch { /* already gone. */ } } };
    });
  }
  return {
    name, state, connect, applyFrame,
    async close() { generation += 1; state.buffering = true; stream?.close(); stream = null; await sleep(30); },
    drawn: () => Object.fromEntries([...state.residents.entries()].map(([id, tile]) => [id, { gx: tile.gx, gy: tile.gy, world_id: tile.world_id }])),
  };
}

/** One real server process image: its own event hub and its own platform handle on the same file. */
async function startServer(t, f, platform = f.platform) {
  const app = createApp({ platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const server = { app, platform, base: `http://127.0.0.1:${app.server.address().port}` };
  t.after(() => stopServer(server));
  return server;
}
async function stopServer(server) {
  server.app.stopEvents();
  await new Promise((resolve) => { server.app.server.close(resolve); server.app.server.closeAllConnections(); });
  await sleep(60);
}

test('a reconnect across a seam rebuilds the client from the stored rows, not from the last frame it saw', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  place(f.platform, alice, 'commons', 25, 0, f.clock());
  const server = await startServer(t, f);
  const client = mapClient({ base: server.base, token: f.credentials.alice.token, worldId: 'commons', agentId: alice.id, name: 'commons' });
  assert.ok(await client.connect(), 'the client must open its stream and apply an authoritative snapshot');
  assert.deepEqual(client.drawn()[alice.id], { gx: 121, gy: 72, world_id: 'commons' }, 'the snapshot holds the resident in the world it is stored in');

  // Away while the resident crosses the seam and keeps walking.
  await client.close();
  for (let index = 0; index < 4; index++) { f.advance(200); f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' }); }
  const stored = storedTile(f.platform, alice.id);
  assert.deepEqual(stored, { gx: 121, gy: 68, world_id: 'district:highlands' }, 'the resident really crossed and kept walking while the client was away');

  assert.ok(await client.connect(), 'the reconnected client must rebuild from its own snapshot');
  assert.deepEqual(client.drawn()[alice.id], stored, 'the rebuilt view equals the stored row, in the world it was moved into');
  assert.deepEqual(client.drawn()[alice.id], storedTile(f.platform, alice.id), 'and it is the client-visible state, not an internal one');
  // Live again: the walk back is delivered, and the crossing itself is delivered too.
  let returned = null;
  for (let index = 0; index < 5 && returned?.seam !== true; index++) { f.advance(200); returned = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'down' }); }
  assert.equal(returned.seam, true, 'the resident crossed back into the Commons');
  const back = storedTile(f.platform, alice.id);
  assert.deepEqual(back, { gx: 121, gy: 72, world_id: 'commons' });
  await settle(() => JSON.stringify(client.drawn()[alice.id]) === JSON.stringify(back), 'the reconnected client to receive the live delta back across the seam');
  assert.deepEqual(client.state.errors, [], 'no reconnect error was swallowed');
  await client.close();
});

test('events missed while away are recovered without a lost or a duplicated action', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  place(f.platform, alice, 'commons', 25, 0, f.clock());
  place(f.platform, bob, 'district:highlands', 25, 34, f.clock());
  const server = await startServer(t, f);
  const witness = mapClient({ base: server.base, token: f.credentials.bob.token, worldId: 'district:highlands', agentId: bob.id, name: 'highlands' });
  assert.ok(await witness.connect(), 'the witness must subscribe');
  assert.deepEqual(witness.drawn()[alice.id], { gx: 121, gy: 72, world_id: 'commons' }, 'the witness sees the neighbour before the gap');

  await witness.close();
  // Steps that cross the seam, and public messages, all accepted while the witness is away.
  const confirmed = [];
  for (let index = 0; index < 6; index++) { f.advance(200); confirmed.push(f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' })); }
  assert.equal(confirmed.filter((result) => result.blocked).length, 0, 'every step was accepted');
  const sent = [];
  for (let index = 0; index < 3; index++) { f.advance(2000); sent.push(f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'public', text: `missed ${index}` })); }
  const stored = storedTile(f.platform, alice.id);
  assert.equal(stored.world_id, 'district:highlands', 'the resident crossed while the witness was away');
  assert.equal(stored.gy, 66, 'and kept walking into the neighbour');

  assert.ok(await witness.connect(), 'the reconnected witness must rebuild from its own snapshot');
  assert.deepEqual(witness.drawn()[alice.id], stored, 'the rebuilt view equals the stored row, across the gap and across the seam');
  const canonical = f.platform.all("SELECT id FROM messages WHERE channel='public' AND text LIKE 'missed %' ORDER BY rowid").map((row) => row.id);
  assert.equal(canonical.length, 3, 'exactly three messages are stored, so none was written twice');
  assert.deepEqual(new Set(canonical), new Set(sent.map((item) => item.id)), 'and they are the three the server confirmed');
  // No duplicated action: a retried intent with the same idempotency key is answered from the ledger.
  const door = getWorldDefinition('commons').portals.find((portal) => portal.targetWorldId === 'district:highlands');
  assert.ok(door, 'the Commons has a doorway into the Highlands');
  place(f.platform, alice, 'commons', door.x, door.y, f.clock());
  const entered = f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered'").n;
  const once = f.tx('interact', f.actor('alice'), { agent_id: alice.id, x: door.x, y: door.y }, 'missed-gap-key');
  const twice = f.tx('interact', f.actor('alice'), { agent_id: alice.id, x: door.x, y: door.y }, 'missed-gap-key');
  assert.equal(twice.replay, true, 'the retried interaction is answered from the idempotency ledger');
  assert.deepEqual(twice.result, once.result, 'with the recorded outcome, not a second action');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered'").n, entered + 1, 'and exactly one crossing was performed');
  assert.deepEqual(witness.state.errors, []);
  await witness.close();
});

test('a real server restart mid-session: the restarted process serves the same stored world and the client converges on it', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  place(f.platform, alice, 'commons', 25, 0, f.clock());
  place(f.platform, bob, 'district:highlands', 25, 35, f.clock());
  const token = f.credentials.alice.token;
  const first = await startServer(t, f);
  const client = mapClient({ base: first.base, token, worldId: 'commons', agentId: alice.id, name: 'commons' });
  assert.ok(await client.connect(), 'the client must subscribe to the first process image');
  // A crossing and a saved placement in the other resident's own garden, before the restart.
  f.advance(200);
  assert.equal(f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' }).seam, true);
  const garden = `home:${bob.id}`;
  f.tx('travel', f.actor('bob'), bob.id, { world_id: garden });
  const definition = getWorldDefinition(garden);
  f.tx('build', f.actor('bob'), bob.id, { type: 'flowers', x: definition.start.x + 3, y: definition.start.y });
  const rows = (platform) => ({
    agents: JSON.stringify(platform.all('SELECT id,world_id,x,y,z,posture,status FROM agents ORDER BY id').map((row) => ({ ...row }))),
    objects: JSON.stringify(platform.all('SELECT id,world_id,type,x,y,created_at FROM world_objects ORDER BY world_id,x,y').map((row) => ({ ...row }))),
    worlds: JSON.stringify(platform.all('SELECT id,name,kind,owner_agent_id,visibility,width,height FROM worlds ORDER BY id').map((row) => ({ ...row }))),
  });
  const before = rows(f.platform);
  const storedBefore = storedTile(f.platform, alice.id);
  assert.deepEqual(storedBefore, { gx: 121, gy: 71, world_id: 'district:highlands' }, 'the resident is on the far side of the seam when the process is stopped');

  // A genuine restart: the first image is stopped, its platform handle closed, and a second image opens
  // the same database file with nothing carried over in memory (a fresh hub and a fresh replay ledger).
  await stopServer(first);
  await client.close();
  f.platform.close();
  const reopened = new Platform(f.database);
  t.after(() => { try { reopened.close(); } catch { /* already closed. */ } });
  const second = await startServer(t, f, reopened);

  assert.deepEqual(rows(reopened), before, 'every resident row, saved placement and world row survives the restart byte for byte');
  const revived = mapClient({ base: second.base, token, worldId: 'commons', agentId: alice.id, name: 'after-restart' });
  assert.ok(await revived.connect(), 'the client must subscribe to the restarted process');
  assert.deepEqual(revived.drawn()[alice.id], storedBefore, 'the restarted process serves the row the resident was left on, on the far side of the seam');
  // Live again: the walk back is delivered by the new process image.
  f.advance(200);
  const actor = reopened.authenticate(token);
  assert.equal(reopened.transaction(() => reopened.moveAgent(actor, { agent_id: alice.id, direction: 'down' })).seam, true);
  const storedBack = storedTile(reopened, alice.id);
  await settle(() => JSON.stringify(revived.drawn()[alice.id]) === JSON.stringify(storedBack), 'the restarted process to stream the delta');
  assert.deepEqual(revived.drawn()[alice.id], { gx: 121, gy: 72, world_id: 'commons' });
  assert.deepEqual(revived.state.errors, []);
  await revived.close();
  await stopServer(second);
});

test('simultaneous writes are serialised by the server: every confirmed step is the stored row, exactly once', async (t) => {
  const f = await fixture(t);
  const server = await startServer(t, f);
  const walkers = [f.agent('alice', 'A'), f.agent('bob', 'B'), f.agent('reviewer', 'C')];
  const tokens = [f.credentials.alice.token, f.credentials.bob.token, f.credentials.reviewer.token];
  walkers.forEach((agent, index) => place(f.platform, agent, index % 2 ? 'district:highlands' : 'commons', 20 + index, index % 2 ? 30 : 5, f.clock()));
  const call = async (index, direction) => {
    const response = await fetch(`${server.base}/api/v1/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[index]}` }, body: JSON.stringify({ agent_id: walkers[index].id, direction }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const confirmed = new Map(walkers.map((agent) => [agent.id, []]));
  for (let round = 0; round < 6; round++) {
    f.advance(200);
    const results = await Promise.all(walkers.map((_, index) => call(index, ['up', 'left', 'down', 'right'][(round + index) % 4])));
    results.forEach((result, index) => {
      assert.ok(result.status === 200 || result.status === 429, `a concurrent step must be accepted or throttled, saw ${result.status}: ${JSON.stringify(result.body)}`);
      if (result.status === 200) confirmed.get(walkers[index].id).push({ world_id: result.body.world_id, x: result.body.x, y: result.body.y });
    });
  }
  for (const agent of walkers) {
    const row = f.platform.get('SELECT world_id,x,y FROM agents WHERE id=?', agent.id);
    const last = confirmed.get(agent.id).at(-1);
    assert.deepEqual({ world_id: row.world_id, x: row.x, y: row.y }, last, `${agent.id}: the stored row is the last confirmed step, nothing lost between two writers and nothing applied twice`);
  }
  // A second step inside the server's own 120 ms throttle is refused and leaves the row alone.
  const throttled = await call(0, 'right');
  assert.equal(throttled.status, 429, 'the second step inside the throttle is refused');
  const row = f.platform.get('SELECT world_id,x,y FROM agents WHERE id=?', walkers[0].id);
  assert.deepEqual({ world_id: row.world_id, x: row.x, y: row.y }, confirmed.get(walkers[0].id).at(-1), 'a refused step changes nothing');
  // Two writers on one tile of one garden: the database keeps exactly one placement.
  const builder = walkers[1], garden = `home:${builder.id}`;
  f.advance(2000);
  f.tx('travel', f.actor('bob'), builder.id, { world_id: garden });
  const definition = getWorldDefinition(garden);
  const tile = { x: definition.start.x + 3, y: definition.start.y + 1 };
  const build = (type) => f.platform.transaction(() => f.platform.build(f.actor('bob'), builder.id, { type, x: tile.x, y: tile.y }));
  build('flowers'); build('bench');
  assert.deepEqual(f.platform.all('SELECT type,x,y FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, tile.x, tile.y).map((item) => ({ ...item })), [{ type: 'bench', x: tile.x, y: tile.y }], 'a repeated placement at one tile is one row, not two');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden).n, 1, 'and the garden holds exactly one placement');
});
