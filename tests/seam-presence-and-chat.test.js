// Presence and nearby communication across a seam, over the real HTTP and Server-Sent Events surface.
//
// Both are the same question the map asks: is a resident a neighbour of mine? Presence answers it in
// global tiles (the channel watches a radius around the tile a change happened on), and nearby chat
// answers it in global tiles too (three of them, counted across the join). Neither ever compares two
// regions' local coordinates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { toGlobal } from '../src/global-map.js';
import { createSoakClient } from '../scripts/multiplayer-soak.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const place = (f, agent, world, x, y) => f.platform.run("UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0,last_seen=? WHERE id=?", world, x, y, f.clock(), agent.id);
const step = (f, agent, direction) => { f.advance(200); return f.tx('moveAgent', f.actor('alice'), { agent_id: agent.id, direction }); };
async function settle(condition, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (condition()) return true; await sleep(15); }
  throw new Error(`timed out waiting for ${label}`);
}
async function post(base, path, body, token) {
  const response = await fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('a presence delta reaches a subscriber on the other side of the seam, and only the worlds in sight', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice');
  place(f, alice, 'commons', 25, 0);
  // Subscribers on the anchor side, the landing side, a world within the watch radius, and one far away.
  const commons = createSoakClient({ base, token: f.credentials.alice.token, worldId: 'commons', name: 'commons' });
  const highlands = createSoakClient({ base, token: f.credentials.alice.token, worldId: 'district:highlands', name: 'highlands' });
  const snowline = createSoakClient({ base, token: f.credentials.alice.token, worldId: 'district:snowline', name: 'snowline' });
  const woodlands = createSoakClient({ base, token: f.credentials.alice.token, worldId: 'district:woodlands', name: 'woodlands' });
  const opened = await Promise.all([commons, highlands, snowline, woodlands].map((client) => client.connect()));
  assert.ok(opened.every(Boolean), 'every subscription must open and apply an authoritative snapshot');

  const across = step(f, alice, 'up');
  assert.deepEqual({ seam: across.seam, world: across.world_id, x: across.x, y: across.y }, { seam: true, world: 'district:highlands', x: 25, y: 35 });
  await settle(() => highlands.historyOf(alice.id).some((tile) => tile.x === 25 && tile.y === 35), 'the landing world to see the arrival');
  // The world the resident left receives the same delta, now naming the world it entered, which is how a
  // client of that world drops it. The client library keeps only entries for its own world.
  await settle(() => commons.state().frames > 0, 'the anchor world to receive the departure frame');
  assert.equal(commons.state().residents.has(alice.id), false, 'the anchor-side subscriber drops a resident that left for the neighbour');
  assert.deepEqual({ x: highlands.state().residents.get(alice.id).x, y: highlands.state().residents.get(alice.id).y }, { x: 25, y: 35 }, 'the landing-side subscriber holds the stored tile');
  await sleep(250);
  assert.equal(snowline.state().frames, 0, 'a world outside the watch radius receives nothing at all');
  assert.equal(woodlands.state().frames, 0, 'and neither does the woodlands, which lies the other way');
  assert.equal(snowline.state().foreign + woodlands.state().foreign, 0);

  // And back: both sides see the reverse crossing, with the stored tile of the world returned to.
  const back = step(f, alice, 'down');
  assert.deepEqual({ world: back.world_id, x: back.x, y: back.y }, { world: 'commons', x: 25, y: 0 });
  await settle(() => commons.state().residents.get(alice.id)?.x === 25 && commons.state().residents.get(alice.id)?.y === 0, 'the anchor world to see the resident return');
  await settle(() => !highlands.state().residents.has(alice.id), 'the landing world to drop the resident that left');
  for (const client of [commons, highlands, snowline, woodlands]) await client.close();
});

test('nearby chat counts its three tiles in world space, across the seam, and never in one region alone', async (t) => {
  const { f, base } = await serve(t);
  const alice = f.agent('alice'), bob = f.agent('bob'), carol = f.agent('reviewer');
  place(f, alice, 'commons', 25, 0);
  // Bob is one global tile away and 35 local tiles away: the two answers differ, so this is the test.
  place(f, bob, 'district:highlands', 25, 35);
  place(f, carol, 'district:highlands', 20, 20);
  const here = toGlobal('commons', 25, 0), there = toGlobal('district:highlands', 25, 35);
  assert.equal(Math.abs(here.gx - there.gx) + Math.abs(here.gy - there.gy), 1, 'one global tile apart');
  assert.equal(Math.abs(25 - 25) + Math.abs(0 - 35), 35, 'and 35 tiles apart if the two regions were subtracted as if they were one');

  f.advance(2000);
  const sent = await post(base, '/messages', { agent_id: alice.id, channel: 'nearby', text: 'One tile away, across the border.' }, f.credentials.alice.token);
  assert.equal(sent.status, 200, `a nearby message must be accepted: ${JSON.stringify(sent.body)}`);
  const recipients = JSON.parse(f.platform.get('SELECT recipients FROM messages WHERE id=?', sent.body.id).recipients);
  assert.ok(recipients.includes(bob.id), 'a resident one world-space tile away across the seam is a recipient');
  assert.equal(recipients.includes(carol.id), false, 'a resident 21 world-space tiles away is not, though it is in the same world as the other one');
  assert.equal(recipients.includes(alice.id), true, 'nearby is a broadcast and includes the sender, as it always has');

  // The recipient reads it from its own world, and a resident of a world with no seam to it does not.
  const read = f.platform.world(f.actor('bob'), { world_id: 'district:highlands', agent_id: bob.id });
  assert.ok(read.messages.some((item) => item.id === sent.body.id), 'the neighbour reads the message from its own world');
  // The boundary is three global tiles, counted the same way on both sides of the join.
  for (const [tile, expected] of [[{ world: 'district:highlands', x: 25, y: 33 }, true], [{ world: 'district:highlands', x: 25, y: 32 }, false]]) {
    place(f, bob, tile.world, tile.x, tile.y);
    const away = Math.abs(toGlobal(tile.world, tile.x, tile.y).gy - here.gy);
    f.advance(2000);
    const probe = await post(base, '/messages', { agent_id: alice.id, channel: 'nearby', text: `${tile.world} ${tile.x},${tile.y}` }, f.credentials.alice.token);
    assert.equal(probe.status, 200, `probe at ${away} global tiles must be accepted: ${JSON.stringify(probe.body)}`);
    const seen = JSON.parse(f.platform.get('SELECT recipients FROM messages WHERE id=?', probe.body.id).recipients).includes(bob.id);
    assert.equal(seen, expected, `a resident ${away} global tiles away is ${expected ? '' : 'not '}a recipient`);
  }
  // The same three tiles are counted on the other side of the seam.
  place(f, bob, 'commons', 25, 3);
  f.advance(2000);
  const same = await post(base, '/messages', { agent_id: alice.id, channel: 'nearby', text: 'Same world, three tiles.' }, f.credentials.alice.token);
  assert.equal(JSON.parse(f.platform.get('SELECT recipients FROM messages WHERE id=?', same.body.id).recipients).includes(bob.id), true, 'three tiles inside one world is still a neighbour');
  place(f, bob, 'commons', 25, 4);
  f.advance(2000);
  const outside = await post(base, '/messages', { agent_id: alice.id, channel: 'nearby', text: 'Same world, four tiles.' }, f.credentials.alice.token);
  assert.equal(JSON.parse(f.platform.get('SELECT recipients FROM messages WHERE id=?', outside.body.id).recipients).includes(bob.id), false, 'four tiles inside one world is not');
  // A world that is not on the map is never a neighbour, however near its local coordinates look.
  place(f, bob, 'hall', 25, 0);
  f.advance(2000);
  const hall = await post(base, '/messages', { agent_id: alice.id, channel: 'nearby', text: 'A different place entirely.' }, f.credentials.alice.token);
  assert.equal(JSON.parse(f.platform.get('SELECT recipients FROM messages WHERE id=?', hall.body.id).recipients).includes(bob.id), false, 'an interior is never a neighbour of the Commons');
});

test('the presence a viewport read reports is the presence the world payload reports', async (t) => {
  const { f } = await serve(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  place(f, alice, 'commons', 25, 0);
  place(f, bob, 'district:highlands', 25, 35);
  const at = toGlobal('commons', 25, 0);
  // A status change is the clearest case: presence follows the stored row, wherever it is read from.
  const cases = [['active', 'recent_visit'], ['paused', 'paused'], ['revoked', 'revoked']];
  for (const [status, expected] of cases) {
    f.platform.run('UPDATE agents SET status=?,last_seen=? WHERE id=?', status, f.clock(), bob.id);
    const view = f.platform.mapViewport(f.actor('alice'), { gx: at.gx - 6, gy: at.gy - 6, columns: 12, rows: 12 });
    assert.equal(view.presence[bob.id], expected, `a ${status} resident across the seam reads as ${expected}`);
    if (status === 'active') {
      // Standing in the same world, the shipped payload and the viewport read must agree exactly.
      f.platform.run("UPDATE agents SET status='active',last_seen=? WHERE id=?", f.clock(), bob.id);
      const inWorld = f.platform.world(f.actor('bob'), { world_id: 'district:highlands', agent_id: bob.id });
      const shared = inWorld.participants.find((item) => item.id === bob.id);
      const viaViewport = f.platform.mapViewport(f.actor('alice'), { gx: at.gx - 30, gy: at.gy - 30, columns: 60, rows: 60 }).participants.find((item) => item.id === bob.id);
      assert.ok(shared && viaViewport, 'both reads hold the resident');
      assert.equal(viaViewport.presence, shared.presence, 'the two derivations of presence agree');
    }
  }
});
