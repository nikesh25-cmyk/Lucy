import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { createHotbar, createPlacementPreview, grantFor, hotbarModel, paletteFor, placementModel } from '../src/ui/build-interface.js';
import { createInventoryPanel, inventoryModel } from '../src/ui/inventory-panel.js';

// No browser check is performed by this task and no browser scenario may be added, so the component
// contract is verified against the real `node:http` server: the same routes, headers and JSON the
// components send and read, with the database asserted after each action.

async function server(t, f) {
  const app = createApp({ platform: f.platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const request = async (path, token, input) => {
    const response = await fetch(base + path, { method: input ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json', Origin: new URL(base).origin } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { app, request };
}
const tile = (x, y, z = 0) => ({ x, y, z, type: 'terrain', adjacent: { x, y, z } });

test('the build interface reads the server palette, previews without writing, places a block and refuses safely over HTTP', async t => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A shared learning garden', description: 'HTTP build fixture.' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'frontier:0:0', 32, 32, alice.id);
  const { request } = await server(t, f);
  const token = f.credentials.alice.token;

  // 1. The hotbar palette is the payload's own palette.
  const world = (await request('/world?world_id=frontier:0:0&agent_id=' + alice.id, token)).data;
  assert.deepEqual(paletteFor(world).types, world.frontier.palette);
  const hotbar = createHotbar({});
  hotbar.update({ world, pick: tile(32, 32) });
  assert.deepEqual(hotbar.model().entries.map((entry) => entry.type), world.frontier.palette);
  assert.equal(hotbar.model().plot.id, 'plot:0:0:5:5');
  assert.equal(hotbar.model().entries.every((entry) => entry.available), true);

  // 2. The placement preview's blueprint request is the server's own preview and writes nothing.
  const preview = createPlacementPreview({ api: (path, method, body) => request(path, token, body).then((r) => { if (r.status >= 400) throw Object.assign(new Error(r.data.error), { status: r.status }); return r.data; }) });
  preview.update({ world, pick: tile(33, 31), session: { agentId: alice.id, worldId: 'frontier:0:0', player: alice } });
  preview.setBlueprint('garden-shelter');
  const report = await preview.previewBlueprint();
  assert.equal(report.valid, true);
  assert.equal(report.writes, 0);
  assert.equal(preview.refresh().permitted, true);
  assert.equal(preview.refresh().source, 'server-preview');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 0);

  // 3. A confirmed single block is saved, and the payload reflects it.
  preview.setKind('wood');
  const placed = await preview.confirm();
  assert.equal(placed.ok, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE x=? AND y=? AND z=0', 33, 31).n, 1);
  const afterPlace = (await request('/world?world_id=frontier:0:0&agent_id=' + alice.id, token)).data;
  assert.equal(afterPlace.blocks.some((block) => block.x === 33 && block.y === 31 && block.type === 'wood'), true);

  // 4. A refusal is a refusal: out of range, nothing written and no saved record.
  // Find a walkable ground tile in the payload's own window that is further than build_range.
  const blocking = new Set(['water', 'tree', 'building', 'fountain', 'wall']);
  const solid = new Set((world.scenery || []).filter((item) => item.blocks).map((item) => `${item.x},${item.y}`));
  let far = null;
  world.terrain.forEach((row, ry) => row.forEach((type, rx) => {
    if (far) return;
    const x = world.camera.x + rx, y = world.camera.y + ry;
    if (blocking.has(type) || solid.has(`${x},${y}`)) return;
    if (Math.abs(x - 32) + Math.abs(y - 32) <= 6) return;
    far = { x, y };
  }));
  assert.ok(far, 'the payload window contains walkable ground out of range');
  f.advance();
  preview.update({ pick: tile(far.x, far.y) });
  preview.setKind('wood');
  const refused = await preview.confirm();
  assert.equal(refused.ok, false);
  assert.equal(refused.refusal.code, 'out-of-range');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 1);
  assert.doesNotMatch(JSON.stringify(preview.view()), /"data-saved":"1"/);
  assert.match(JSON.stringify(preview.view()), /Walk closer/);
});

test('a guest sees the grant, may build only inside its scope, and the server refuses the rest', async t => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A shared learning garden', description: 'Grant fixture.' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'frontier:0:0', 32, 32, alice.id);
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'frontier:0:0', 34, 34, bob.id);
  const { request } = await server(t, f);
  const aliceToken = f.credentials.alice.token, bobToken = f.credentials.bob.token;

  f.advance();
  const grant = await request('/frontier/grant', aliceToken, {
    plot_id: 'plot:0:0:5:5', guest_agent_id: bob.id, purpose: 'Lay the garden path', duration_minutes: 120,
    block_types: ['wood'], layers: [0, 1], actions: ['place'], max_blocks: 4,
  });
  assert.equal(grant.status, 200);
  assert.equal(grant.data.created, true);

  const bobWorld = (await request('/world?world_id=frontier:0:0&agent_id=' + bob.id, bobToken)).data;
  const live = grantFor(bobWorld.frontier.grants, 'plot:0:0:5:5');
  assert.equal(live.live, true);
  assert.equal(live.purpose, 'Lay the garden path');
  const model = placementModel({ world: bobWorld, pick: tile(32, 31), session: { player: bob } });
  assert.equal(model.grantNotice.kind, 'grant');
  assert.deepEqual(model.grantNotice.scope.block_types, ['wood']);
  const hotbar = hotbarModel({ world: bobWorld, pick: tile(32, 31) });
  assert.equal(hotbar.entries.find((entry) => entry.type === 'wood').available, true);
  assert.equal(hotbar.entries.find((entry) => entry.type === 'stone').available, false);

  // Inside the scope: accepted, recorded with the grant id.
  const api = (path, method, body) => request(path, bobToken, body).then((r) => { if (r.status >= 400) throw Object.assign(new Error(r.data.error), { status: r.status }); return r.data; });
  const preview = createPlacementPreview({ api });
  preview.update({ world: bobWorld, pick: tile(32, 31), session: { agentId: bob.id, worldId: 'frontier:0:0', player: bob } });
  preview.setKind('wood');
  const inside = await preview.confirm();
  assert.equal(inside.ok, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE grant_id IS NOT NULL').n, 1);

  // Outside the scope: refused with the grant named, nothing written.
  f.advance();
  preview.setKind('stone');
  const outside = await preview.confirm();
  assert.equal(outside.ok, false);
  assert.equal(outside.refusal.code, 'grant-scope');
  assert.match(outside.refusal.message, /outside this collaboration grant/i);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 1);
});

test('the inventory panel reads the journey payload and crafts through the server', async t => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'herbs',4) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=4", alice.id);
  f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'fiber',3) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=3", alice.id);
  const { request } = await server(t, f);
  const token = f.credentials.alice.token;

  const journey = (await request('/journey?agent_id=' + alice.id, token)).data;
  assert.ok(journey.coins, 'the payload carries coins');
  const model = inventoryModel({ journey });
  assert.deepEqual(model.shelf.map((item) => item.kind).sort(), ['fiber', 'herbs']);
  assert.equal(model.shelf.some((item) => /coin/i.test(item.kind)), false);
  const flower = model.recipes.find((recipe) => recipe.id === 'flower_crown');
  assert.equal(flower.craftable, true);
  const whistle = model.recipes.find((recipe) => recipe.id === 'reed_whistle');
  assert.equal(whistle.craftable, false);
  assert.equal(whistle.missing.some((item) => item.kind === 'wood'), true);

  // The panel's own craft call is the shipped route, and the shelf shown next is the server's answer.
  const panel = createInventoryPanel({ api: (path, method, body) => request(path, token, body).then((r) => { if (r.status >= 400) throw Object.assign(new Error(r.data.error), { status: r.status }); return r.data; }) });
  panel.update({ journey, agentId: alice.id });
  const crafted = await panel.craft({ id: 'flower_crown', name: 'Flower crown', craftable: true });
  assert.equal(crafted.crafted, 'flower_crown');
  assert.deepEqual(panel.model().shelf.map((item) => item.kind).sort(), ['fiber', 'flower_crown', 'herbs']);
  assert.match(JSON.stringify(panel.view()), /The server crafted Flower crown\./);

  // A refused craft is a refusal, and the shelf is unchanged.
  const refused = await panel.craft({ id: 'reed_whistle', name: 'Reed whistle', craftable: false });
  assert.equal(refused, null);
  assert.match(JSON.stringify(panel.view()), /"data-inventory-status":"refused"/);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM journey_inventory WHERE kind='reed_whistle'").n, 0);
});
