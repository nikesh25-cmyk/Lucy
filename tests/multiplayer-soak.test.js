import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { createSoakClient, subsequenceIndex, percentile, SOAK_LIMITS } from '../scripts/multiplayer-soak.mjs';

// The multiplayer soak invariants over the real HTTP and Server-Sent Events surface, at the scale a
// unit test can run quickly. `scripts/multiplayer-soak.mjs` drives the same client code against the
// shipped server as a child process for minutes; these cases pin the invariants it asserts so a
// regression is caught by `npm test` instead of only by a manual soak.
//
// Every case opens genuine SSE subscriptions and reads the frames a real client would read. Nothing
// is mocked. The event hub flushes on its own real-time interval, so the cases sleep briefly after a
// write instead of advancing the fixture clock past it.

const CLIENT_LIMIT = 16;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the server has flushed the changes made so far, or the deadline passes. */
async function settle(condition, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (condition()) return true; await sleep(15); }
  throw new Error(`timed out waiting for ${label}`);
}

async function post(base, path, body, token, method = 'POST') {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** One subscription per account, up to the account's documented ceiling. */
function accountsOf(f) {
  return [
    { token: f.credentials.alice.token, agent: f.agent('alice', 'Alice walker') },
    { token: f.credentials.bob.token, agent: f.agent('bob', 'Bob walker') },
    { token: f.credentials.reviewer.token, agent: f.agent('reviewer', 'Reviewer walker') },
    { token: f.credentials.moderator.token, agent: f.agent('moderator', 'Moderator walker') },
  ];
}

test('many concurrent subscribers receive every public message once, in the stored order', async (t) => {
  const { f, base } = await serve(t);
  const accounts = accountsOf(f);
  const clients = [];
  for (let index = 0; index < CLIENT_LIMIT; index++) {
    const account = accounts[index % accounts.length];
    clients.push(createSoakClient({ base, token: account.token, worldId: 'commons', name: `subscriber-${index}` }));
  }
  const opened = await Promise.all(clients.map((client) => client.connect()));
  assert.equal(opened.filter(Boolean).length, clients.length, 'every subscription must open and apply a snapshot');

  const texts = [];
  for (let index = 0; index < 9; index++) {
    const account = accounts[index % accounts.length];
    f.advance(2000); // The message route allows one message per account per 1500 ms.
    const text = `Soak message ${index}`;
    const result = await post(base, '/messages', { agent_id: account.agent.id, channel: 'public', text }, account.token);
    assert.equal(result.status, 200, `message ${index} must be accepted: ${JSON.stringify(result.body)}`);
    texts.push(text);
  }

  const canonical = f.platform.all("SELECT id FROM messages WHERE world_id='commons' AND channel='public' ORDER BY rowid").map((row) => row.id);
  assert.equal(canonical.length, texts.length, 'every accepted message must be stored');
  const indexOf = new Map(canonical.map((id, index) => [id, index]));
  await settle(() => clients.every((client) => client.messageOrder().length >= canonical.length), 'every subscriber to receive every message');

  for (const client of clients) {
    const indices = client.messageOrder().map((id) => indexOf.get(id)).filter((index) => index !== undefined);
    assert.deepEqual(indices, canonical.map((_, index) => index), `${client.name} must receive every stored message once, in stored order`);
    assert.equal(client.state().duplicates, 0, `${client.name} must not receive a message twice on the wire`);
    assert.equal(client.state().foreign, 0, `${client.name} must receive only frames for the world it subscribed to`);
  }
  const latencies = clients.flatMap((client) => client.state().latency);
  assert.ok(latencies.length >= canonical.length, 'the message frames must be measured');
  assert.ok(percentile(latencies, 0.95) <= 500, `loopback delivery latency p95 must stay under 500 ms (was ${percentile(latencies, 0.95)} ms)`);
  for (const client of clients) await client.close();
});

test('no subscriber observes an avatar tile the server has already superseded', async (t) => {
  const { f, base } = await serve(t);
  const accounts = accountsOf(f);
  const walkers = accounts.slice(0, 2);
  const clients = accounts.map((account, index) => createSoakClient({ base, token: account.token, worldId: 'commons', name: `witness-${index}` }));
  assert.ok((await Promise.all(clients.map((client) => client.connect()))).every(Boolean), 'every witness must subscribe');

  // Each walker is driven by one loop, so the accepted order is the server's order for that avatar.
  const accepted = new Map(walkers.map((walker) => [walker.agent.id, []]));
  const directions = ['up', 'right', 'down', 'left'];
  for (let step = 0; step < 14; step++) {
    for (const [index, walker] of walkers.entries()) {
      f.advance(200); // Above the 120 ms step throttle.
      const direction = directions[(step + index) % directions.length];
      const result = await post(base, '/move', { agent_id: walker.agent.id, direction }, walker.token);
      assert.equal(result.status, 200, `step ${step} for ${walker.agent.id} must be accepted: ${JSON.stringify(result.body)}`);
      accepted.get(walker.agent.id).push({ x: result.body.x, y: result.body.y });
    }
  }
  await settle(() => clients.every((client) => walkers.every((walker) => {
    const history = client.historyOf(walker.agent.id);
    const last = history[history.length - 1];
    const finalTile = accepted.get(walker.agent.id).at(-1);
    return last && last.x === finalTile.x && last.y === finalTile.y;
  })), 'every witness to end on the final accepted tile');
  await sleep(150);

  for (const client of clients) {
    for (const walker of walkers) {
      const history = client.historyOf(walker.agent.id);
      const verdict = subsequenceIndex(history, accepted.get(walker.agent.id));
      assert.ok(verdict.ok, `${client.name} observed ${verdict.at?.x},${verdict.at?.y} for ${walker.agent.id} after the server had superseded that tile`);
      const stored = f.platform.get('SELECT x,y FROM agents WHERE id=?', walker.agent.id);
      const seen = client.state().residents.get(walker.agent.id);
      assert.deepEqual({ x: seen.x, y: seen.y }, { x: stored.x, y: stored.y }, `${client.name} must end on the stored tile for ${walker.agent.id}`);
    }
  }
  for (const client of clients) await client.close();
});

test('a reconnecting client is rebuilt from the snapshot and goes live again', async (t) => {
  const { f, base } = await serve(t);
  const accounts = accountsOf(f);
  const walker = accounts[0], witness = accounts[1];
  const first = createSoakClient({ base, token: witness.token, worldId: 'commons', name: 'first' });
  assert.ok(await first.connect(), 'the first subscription must open');

  // `/world` is viewport-scoped, so the walker is kept beside its arrival tile: the reconnect
  // snapshot must contain it for the comparison to mean anything.
  const directions = ['right', 'down', 'left', 'up'];
  const move = async (step) => {
    let tile = null;
    for (let attempt = 0; attempt < directions.length && !tile; attempt++) {
      f.advance(200);
      const before = f.platform.get('SELECT x,y FROM agents WHERE id=?', walker.agent.id);
      const direction = directions[(step + attempt) % directions.length];
      const result = await post(base, '/move', { agent_id: walker.agent.id, direction }, walker.token);
      assert.equal(result.status, 200, `the move must be accepted: ${JSON.stringify(result.body)}`);
      if (result.body.x !== before.x || result.body.y !== before.y) tile = { x: result.body.x, y: result.body.y };
    }
    assert.ok(tile, 'the walker must be able to step in some direction');
    return tile;
  };
  await move(0);
  await settle(() => first.historyOf(walker.agent.id).length >= 1, 'the first subscription to see a move');

  // Away while the avatar moves, then back through the documented protocol.
  await first.close();
  const missed = [await move(1), await move(2)];
  const stored = f.platform.get('SELECT x,y FROM agents WHERE id=?', walker.agent.id);
  assert.deepEqual({ x: stored.x, y: stored.y }, missed[1], 'the avatar must really have moved while the client was away');
  assert.ok(stored.x >= 8 && stored.x <= 27 && stored.y >= 2 && stored.y <= 15, 'the walker must stay inside the snapshot window');

  const second = createSoakClient({ base, token: witness.token, worldId: 'commons', name: 'second' });
  assert.ok(await second.connect(), 'the reconnected subscription must open and apply its snapshot');
  const seen = second.state().residents.get(walker.agent.id);
  assert.deepEqual({ x: seen.x, y: seen.y }, { x: stored.x, y: stored.y }, 'the rebuilt view must agree with the stored row, not with the last frame it saw');

  const after = await move(3);
  await settle(() => second.historyOf(walker.agent.id).some((tile) => tile.x === after.x && tile.y === after.y), 'the reconnected subscription to receive a live delta');
  await first.close();
  await second.close();
});

test('the soak client holds the documented limits, not a test-only override', () => {
  assert.equal(SOAK_LIMITS.move_pace_ms > 120, true, 'the harness must pace above the server\u2019s own 120 ms step throttle');
  assert.deepEqual({ client_buffer_frames: SOAK_LIMITS.client_buffer_frames, process_subscription_ceiling: SOAK_LIMITS.process_subscription_ceiling }, { client_buffer_frames: 512, process_subscription_ceiling: 64 });
});

test('making a garden private publishes a visitor departure and Commons arrival', async (t) => {
  // A forced relocation is still a world crossing: the owner-authorized garden subscriber drops the
  // visitor and the Commons subscriber adds it at the stored tile. Revocation is covered separately.
  const { f, base } = await serve(t);
  const accounts = accountsOf(f);
  const owner = accounts[0], visitor = accounts[1];
  const garden = `home:${owner.agent.id}`;

  // The witness subscribes before the visitor leaves, so it really holds the departure and can be
  // asked whether it ever learns of the return.
  const witness = createSoakClient({ base, token: owner.token, worldId: 'commons', name: 'commons-witness' });
  const gardenWitness = createSoakClient({ base, token: owner.token, worldId: garden, name: 'garden-witness' });
  assert.ok(await witness.connect(), 'the Commons witness must subscribe');
  assert.ok(await gardenWitness.connect(), 'the garden owner must be able to subscribe');
  assert.ok(witness.state().residents.has(visitor.agent.id), 'the visitor must be in the Commons snapshot before it leaves');
  const entered = await post(base, `/agents/${visitor.agent.id}/travel`, { world_id: garden }, visitor.token);
  assert.equal(entered.status, 200, 'the visitor must be able to enter the public garden');
  // A departure is published to the world that was left, so this is what removes it from the view.
  await settle(() => !witness.state().residents.has(visitor.agent.id), 'the witness to see the visitor leave the Commons');
  await settle(() => gardenWitness.state().residents.has(visitor.agent.id), 'the garden witness to see the visitor arrive');

  const changed = await post(base, `/agents/${owner.agent.id}/home`, { visibility: 'private' }, owner.token, 'PATCH');
  assert.equal(changed.status, 200, 'the owner must be able to make the garden private');
  const relocated = f.platform.get('SELECT world_id,x,y FROM agents WHERE id=?', visitor.agent.id);
  assert.equal(relocated.world_id, 'commons', 'the stored row must have been moved to the Commons');

  await settle(() => witness.state().residents.has(visitor.agent.id), 'the Commons witness to see the relocated visitor arrive');
  await settle(() => !gardenWitness.state().residents.has(visitor.agent.id), 'the garden witness to see the visitor depart');
  const arrived = witness.state().residents.get(visitor.agent.id);
  assert.ok(arrived, 'the Commons subscriber must receive the relocated resident\u2019s arrival');
  assert.deepEqual({ x: arrived.x, y: arrived.y }, { x: relocated.x, y: relocated.y }, 'the arrival must carry the stored tile');
  await witness.close();
  await gardenWitness.close();
});
