import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

const denied = (operation, statuses = [403, 404]) => assert.throws(operation, (error) => statuses.includes(error.status));
const avatars = (view) => view.agents || view.participants;

test('character creation provisions a persistent home and directory visibility follows owner settings', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const homeId = `home:${alice.id}`;
  const initial = f.platform.worldList(f.actor('bob'), { limit: 20 });
  assert.equal(initial.worlds.some((w) => w.id === 'commons'), true);
  const home = initial.worlds.find((w) => w.id === homeId);
  assert.equal(home.owner_agent_id, alice.id);
  assert.equal(home.visibility, 'public');
  assert.equal(home.width, 32);
  assert.equal(home.height, 24);
  assert.equal(f.platform.world(f.actor('bob'), { world_id: homeId }).world.id, homeId);
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private', name: 'Private evidence garden' });
  assert.equal(f.platform.worldList(f.actor('bob'), { limit: 20 }).worlds.some((w) => w.id === homeId), false);
  assert.equal(f.platform.worldList(f.actor('alice'), { limit: 20 }).worlds.some((w) => w.id === homeId), true);
  denied(() => f.platform.world(f.actor('bob'), { world_id: homeId }));
  denied(() => f.platform.world(null, { world_id: homeId }));
  denied(() => f.tx('travel', f.actor('bob'), bob.id, { world_id: homeId }));
  denied(() => f.tx('homeSettings', f.actor('bob'), alice.id, { visibility: 'public', name: 'Not my home' }));
  f.tx('travel', f.actor('alice'), alice.id, { world_id: homeId });
  const homeView = f.platform.world(f.actor('alice'), { world_id: homeId });
  const position = avatars(homeView).find((a) => a.id === alice.id);
  assert.ok(position);
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  const actor = restarted.authenticate(f.credentials.alice.token);
  const persisted = restarted.world(actor, { world_id: homeId });
  assert.equal(persisted.world.name, 'Private evidence garden');
  assert.equal(persisted.world.visibility, 'private');
  assert.equal(avatars(persisted).find((a) => a.id === alice.id).x, position.x);
  assert.equal(avatars(persisted).find((a) => a.id === alice.id).y, position.y);
});

test('shared interiors require a nearby portal while homes support directory visits and reliable exits', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const commons = getWorldDefinition('commons');
  const portal = commons.portals.find((p) => p.targetWorldId !== 'commons');
  assert.ok(portal, 'Commons must provide an interior entrance.');
  const interiorId = portal.targetWorldId;
  f.platform.run("UPDATE agents SET world_id='commons',x=80,y=52 WHERE id=?", alice.id);
  denied(() => f.tx('travel', f.actor('alice'), alice.id, { world_id: interiorId }), [400, 403, 409]);
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=? WHERE id=?", portal.x, portal.y, alice.id);
  f.tx('travel', f.actor('alice'), alice.id, { world_id: interiorId });
  const inside = f.platform.world(f.actor('alice'), { world_id: interiorId });
  assert.equal(inside.world.id, interiorId);
  assert.equal(avatars(inside).some((a) => a.id === alice.id), true);
  assert.equal(avatars(f.platform.world(f.actor('bob'), { world_id: 'commons' })).some((a) => a.id === alice.id), false);
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: `home:${alice.id}` });
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: `home:${bob.id}` });
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, `home:${bob.id}`);
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: 'commons' });
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');
  denied(() => f.tx('travel', f.actor('bob'), alice.id, { world_id: 'commons' }));
  denied(() => f.tx('travel', f.actor('alice'), alice.id, { world_id: 'missing-world' }), [400, 404]);
});

test('home construction validates ownership, walkability, bounds and capacity and persists objects', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const homeId = `home:${alice.id}`;
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'flowers', x: 4, y: 4 }), [400, 403, 409]);
  f.tx('travel', f.actor('alice'), alice.id, { world_id: homeId });
  denied(() => f.tx('build', f.actor('bob'), alice.id, { type: 'flowers', x: 4, y: 4 }));
  f.tx('travel', f.actor('bob'), bob.id, { world_id: homeId });
  denied(() => f.tx('build', f.actor('bob'), bob.id, { type: 'flowers', x: 4, y: 4 }));
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'active-script', x: 4, y: 4 }), [400]);
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'flowers', x: -1, y: 4 }), [400]);
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'flowers', x: 1000, y: 4 }), [400]);
  const definition = getWorldDefinition(homeId);
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'path', ...definition.start }), [409]);
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'path', x: definition.portals[0].x, y: definition.portals[0].y }), [409]);
  const candidates = [];
  for (let y = 1; y < definition.rows - 1; y++) for (let x = 1; x < definition.columns - 1; x++) {
    const distance = (p) => Math.abs(p.x - x) + Math.abs(p.y - y);
    if (walkable({ x, y }, homeId) && distance(definition.start) > 1 && definition.portals.every((portal) => distance(portal) > 1)) candidates.push({ x, y });
  }
  assert.ok(candidates.length > 201);
  const tile = candidates.find((p) => p.x === 4 && p.y === 8) || candidates[0];
  f.tx('build', f.actor('alice'), alice.id, { type: 'flowers', ...tile });
  assert.equal(f.platform.world(f.actor('alice'), { world_id: homeId, x: tile.x, y: tile.y }).objects.some((o) => o.x === tile.x && o.y === tile.y && o.type === 'flowers'), true);
  f.tx('build', f.actor('alice'), alice.id, { remove: true, ...tile });
  assert.equal(f.platform.world(f.actor('alice'), { world_id: homeId, x: tile.x, y: tile.y }).objects.some((o) => o.x === tile.x && o.y === tile.y), false);
  for (const position of candidates.slice(0, 200)) f.tx('build', f.actor('alice'), alice.id, { type: 'path', ...position });
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'path', ...candidates[200] }), [429]);
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  const view = restarted.world(restarted.authenticate(f.credentials.alice.token), { world_id: homeId, x: 0, y: 0 });
  assert.ok(view.objects.length > 0);
  assert.equal(view.objects.every((o) => o.type === 'path'), true);
  assert.equal(restarted.verifyAudit(), true);
});

test('nearby messages and presence are scoped to each world, including private homes', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  f.tx('travel', f.actor('alice'), alice.id, { world_id: `home:${alice.id}` });
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private', name: 'Quiet home' });
  const a = f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', a.x, a.y, bob.id);
  const nearby = f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'nearby', text: 'Only agents in this private home can hear this.' });
  const own = f.platform.world(f.actor('alice'), { world_id: `home:${alice.id}` });
  assert.equal(own.messages.some((m) => m.id === nearby.id), true);
  assert.equal(f.platform.world(f.actor('bob'), { world_id: 'commons' }).messages.some((m) => m.id === nearby.id), false);
  assert.equal(avatars(f.platform.world(f.actor('bob'), { world_id: 'commons' })).some((a) => a.id === alice.id), false);
  f.advance();
  const heartbeat = f.tx('heartbeat', f.actor('alice'), alice.id);
  assert.ok(heartbeat);
  assert.equal(f.platform.get('SELECT last_seen FROM agents WHERE id=?', alice.id).last_seen, f.clock());
  denied(() => f.tx('heartbeat', f.actor('bob'), alice.id));
});

test('ten thousand registered agents produce bounded viewport and directory responses', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const ownerId = f.actor('bob').account.id;
  const position = f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
  // Synthetic load data bypasses the account creation quota solely to test query bounds.
  f.platform.transaction(() => {
    const insert = f.platform.db.prepare("INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,world_id,last_seen,created_at) VALUES(?,?,?,'#397f79','✦','','',?,?,'commons',?,?)");
    const insertHome = f.platform.db.prepare("INSERT INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,'home',?,'public',32,24,?)");
    for (let i = 0; i < 10_000; i++) {
      const id = randomUUID();
      const date = new Date(f.clock()).toISOString();
      insert.run(id, ownerId, `Load fixture ${i}`, position.x, position.y, f.clock(), date);
      insertHome.run(`home:${id}`, `Load garden ${i}`, id, date);
    }
  });
  const started = performance.now();
  const view = f.platform.world(f.actor('alice'), { world_id: 'commons', x: position.x, y: position.y });
  const elapsed = performance.now() - started;
  assert.equal(view.counts.registered_agents, 10_001);
  assert.equal(view.counts.world_agents, 10_001);
  assert.ok(avatars(view).length <= 200);
  assert.equal(view.counts.visible_agents, avatars(view).length);
  assert.ok(view.terrain.length <= 14);
  assert.ok(view.terrain.every((row) => row.length <= 20));
  assert.ok(JSON.stringify(view).length < 250_000);
  const farAway = f.platform.world(f.actor('alice'), { world_id: 'commons', x: 80, y: 50 });
  assert.equal(avatars(farAway).length, 0);
  const listing = f.platform.worldList(f.actor('alice'), { offset: 0, limit: 2 });
  assert.equal(listing.total, 10_001);
  assert.equal(listing.has_more, true);
  assert.ok(listing.worlds.length <= listing.shared_count + 2);
  assert.ok(listing.worlds.filter((world) => world.kind === 'home').length <= 2);
  const searched = f.platform.worldList(f.actor('alice'), { q: 'Load garden 9999', offset: 0, limit: 2 });
  assert.equal(searched.total, 1);
  assert.equal(searched.worlds.filter((world) => world.kind === 'home').length, 1);
  t.diagnostic(`Synthetic storage fixture: ${view.counts.registered_agents} agent records and ${listing.total} homes; viewport ${avatars(view).length} avatars; query ${elapsed.toFixed(2)} ms; JSON ${Buffer.byteLength(JSON.stringify(view))} bytes. This does not simulate concurrent clients or model calls.`);
});

test('HTTP build credentials stay scoped and visitors cannot build or change another character home', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (route, token, input, method = 'POST') => {
    const response = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  f.tx('travel', f.actor('alice'), alice.id, { world_id: `home:${alice.id}` });
  const readOnly = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read'] });
  assert.equal((await call(`/agents/${alice.id}/build`, readOnly.token, { type: 'flowers', x: 4, y: 8 })).status, 403);
  const builder = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'build'] });
  assert.equal((await call(`/agents/${alice.id}/build`, builder.token, { type: 'flowers', x: 4, y: 8 })).status, 201);
  assert.equal((await call(`/agents/${alice.id}/home`, builder.token, { name: 'No runtime management', visibility: 'private' }, 'PATCH')).status, 403);
  const world = await call(`/world?world_id=${encodeURIComponent(`home:${alice.id}`)}`, builder.token, null, 'GET');
  assert.equal(world.status, 200);
  assert.equal(world.data.objects.some((o) => o.type === 'flowers'), true);
  assert.ok([403, 404].includes((await call(`/agents/${alice.id}/build`, f.credentials.bob.token, { type: 'bench', x: 5, y: 4 })).status));
});

test('account export includes owned messages from homes and visitors can report readable home content', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const homeId = `home:${alice.id}`;
  f.tx('travel', f.actor('alice'), alice.id, { world_id: homeId });
  const publicMessage = f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'public', text: 'A public garden conversation.' });
  assert.equal(f.platform.world(f.actor('bob'), { world_id: homeId }).messages.some((m) => m.id === publicMessage.id), true);
  assert.equal(f.platform.exportAccount(f.actor('alice')).messages.some((m) => m.id === publicMessage.id), true);
  const report = f.tx('report', f.actor('bob'), { target_type: 'message', target_id: publicMessage.id, reason: 'Readable public garden content can be reported.' });
  assert.ok(report.id);
  f.advance();
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private' });
  const privateGardenMessage = f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'public', text: 'Content limited to the private garden.' });
  denied(() => f.tx('report', f.actor('bob'), { target_type: 'message', target_id: privateGardenMessage.id, reason: 'Guessing a private garden message id.' }));
  assert.equal(f.platform.exportAccount(f.actor('alice')).messages.some((m) => m.id === privateGardenMessage.id), true);
  f.advance();
  const direct = f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'A direct conversation across worlds.' });
  assert.ok(f.tx('report', f.actor('bob'), { target_type: 'message', target_id: direct.id, reason: 'Direct recipient can report without entering the sender home.' }).id);
});

test('a personal cottage requires its garden doorway and inherits private visiting with guest eviction', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const homeId = `home:${alice.id}`;
  const houseId = `house:${alice.id}`;
  assert.equal(f.platform.world(f.actor('alice'), { world_id: houseId }).world.kind, 'house');
  denied(() => f.tx('travel', f.actor('alice'), alice.id, { world_id: houseId }), [409]);
  f.tx('travel', f.actor('alice'), alice.id, { world_id: homeId });
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: houseId });
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, houseId);
  f.tx('travel', f.actor('bob'), bob.id, { world_id: homeId });
  f.advance();
  f.tx('travel', f.actor('bob'), bob.id, { world_id: houseId });
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private' });
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', bob.id).world_id, 'commons');
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, houseId);
  denied(() => f.platform.world(f.actor('bob'), { world_id: houseId }));
  denied(() => f.platform.world(null, { world_id: houseId }));
  assert.equal(f.platform.world(f.actor('alice'), { world_id: houseId }).world.visibility, 'private');
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: homeId });
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: 'commons' });
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');
});

test('placed obstacles block movement and removing them restores passage while flowers stay walkable', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.tx('travel', f.actor('alice'), alice.id, { world_id: `home:${alice.id}` });
  f.platform.run('UPDATE agents SET x=3,y=8 WHERE id=?', alice.id);
  f.tx('build', f.actor('alice'), alice.id, { type: 'pond', x: 4, y: 8 });
  f.advance();
  const blocked = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' });
  assert.equal(blocked.x, 3);
  assert.equal(blocked.y, 8);
  f.tx('build', f.actor('alice'), alice.id, { remove: true, x: 4, y: 8 });
  f.advance();
  const unblocked = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' });
  assert.equal(unblocked.x, 4);
  f.tx('build', f.actor('alice'), alice.id, { type: 'flowers', x: 5, y: 8 });
  f.advance();
  assert.equal(f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' }).x, 5);
});

test('deleting a home owner clears construction and safely evacuates garden and cottage visitors', async (t) => {
  const f = await fixture(t);
  const owner = f.agent('alice');
  const cottageVisitor = f.agent('bob');
  const gardenVisitor = f.agent('bob', 'Garden visitor');
  const homeId = `home:${owner.id}`;
  const houseId = `house:${owner.id}`;
  f.tx('travel', f.actor('alice'), owner.id, { world_id: homeId });
  f.tx('build', f.actor('alice'), owner.id, { type: 'flowers', x: 4, y: 8 });
  f.tx('travel', f.actor('bob'), cottageVisitor.id, { world_id: homeId });
  f.advance();
  f.tx('travel', f.actor('bob'), cottageVisitor.id, { world_id: houseId });
  f.tx('travel', f.actor('bob'), gardenVisitor.id, { world_id: homeId });
  const ownerRuntime = f.tx('runtime', f.actor('alice'), owner.id, { scopes: ['read', 'move'] });
  const visitorRuntime = f.tx('runtime', f.actor('bob'), cottageVisitor.id, { scopes: ['read', 'move'] });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', homeId).n, 1);
  f.tx('deleteAccount', f.actor('alice'));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', homeId).n, 0);
  for (const id of [homeId, houseId]) {
    assert.equal(f.platform.get('SELECT name FROM worlds WHERE id=?', id).name, 'Deleted home');
    denied(() => f.platform.world(f.actor('bob'), { world_id: id }), [404]);
    assert.equal(f.platform.worldList(f.actor('bob'), {}).worlds.some((world) => world.id === id), false);
  }
  for (const agent of [cottageVisitor, gardenVisitor]) assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', agent.id).world_id, 'commons');
  denied(() => f.platform.authenticate(ownerRuntime.token), [401]);
  denied(() => f.platform.authenticate(f.credentials.alice.token), [401]);
  f.advance();
  const visitorActor = f.platform.authenticate(visitorRuntime.token, 'move');
  assert.equal(f.tx('moveAgent', visitorActor, { direction: 'left' }).world_id, 'commons');
  f.advance();
  f.tx('travel', visitorActor, cottageVisitor.id, { world_id: `home:${cottageVisitor.id}` });
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', cottageVisitor.id).world_id, `home:${cottageVisitor.id}`);
  assert.equal(f.platform.verifyAudit(), true);
});

test('ten shared worlds expose scenic region metadata and doorway travel returns to the correct district', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const listing = f.platform.worldList(f.actor('alice'));
  assert.equal(listing.shared_count, 10);
  const commons = getWorldDefinition('commons');
  for (const id of ['library', 'workshop', 'observatory', 'orchard', 'harbor']) {
    assert.ok(listing.worlds.some((world) => world.id === id));
    const entrance = commons.portals.find((gate) => gate.targetWorldId === id);
    f.advance();
    f.platform.run("UPDATE agents SET world_id='commons',x=10,y=6 WHERE id=?", agent.id);
    denied(() => f.tx('travel', f.actor('alice'), agent.id, { world_id: id }), [409]);
    f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', entrance.x, entrance.y, agent.id);
    f.tx('travel', f.actor('alice'), agent.id, { world_id: id });
    const inside = f.platform.world(f.actor('alice'), { agent_id: agent.id });
    assert.equal(inside.world.id, id);
    assert.ok(inside.world.description && inside.world.lore && inside.world.ambiance);
    assert.ok(walkable(avatars(inside).find((candidate) => candidate.id === agent.id), id));
    f.advance();
    const returned = f.tx('travel', f.actor('alice'), agent.id, { world_id: 'commons' });
    assert.deepEqual({ x: returned.x, y: returned.y }, { x: entrance.x, y: entrance.y });
  }
  assert.equal(f.platform.verifyAudit(), true);
});

test('garden decorations and safe cottage furnishing preserve ownership and clear doorways', async (t) => {
  const f = await fixture(t);
  const owner = f.agent('alice'); const visitor = f.agent('bob');
  const homeId = `home:${owner.id}`; const houseId = `house:${owner.id}`;
  f.tx('travel', f.actor('alice'), owner.id, { world_id: homeId });
  for (const [index, type] of ['bookshelf', 'table', 'lantern', 'sculpture', 'trellis', 'cushion'].entries()) {
    f.tx('build', f.actor('alice'), owner.id, { type, x: 8 + index, y: 18 });
  }
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', homeId).n, 6);
  f.advance();
  f.tx('travel', f.actor('alice'), owner.id, { world_id: houseId });
  const view = f.platform.world(f.actor('alice'), { agent_id: owner.id });
  assert.ok(view.build_palette.includes('bookshelf'));
  assert.equal(view.build_palette.includes('pond'), false);
  for (const [index, type] of ['bookshelf', 'table', 'lantern', 'sculpture', 'cushion'].entries()) {
    f.tx('build', f.actor('alice'), owner.id, { type, x: 6 + index, y: 8 });
  }
  denied(() => f.tx('build', f.actor('alice'), owner.id, { type: 'farm', x: 12, y: 9 }), [400]);
  denied(() => f.tx('build', f.actor('alice'), owner.id, { type: 'bench', x: 4, y: 4 }), [409]);
  denied(() => f.tx('build', f.actor('alice'), owner.id, { type: 'table', x: 10, y: 11 }), [409]);
  denied(() => f.tx('build', f.actor('bob'), owner.id, { type: 'table', x: 12, y: 8 }));
  f.tx('travel', f.actor('bob'), visitor.id, { world_id: homeId }); f.advance();
  f.tx('travel', f.actor('bob'), visitor.id, { world_id: houseId });
  denied(() => f.tx('build', f.actor('bob'), visitor.id, { type: 'table', x: 12, y: 8 }), [403]);
  assert.equal(f.platform.world(f.actor('alice'), { agent_id: owner.id }).objects.length, 5);
  f.advance();
  f.tx('travel', f.actor('alice'), owner.id, { world_id: homeId });
  assert.equal(f.platform.world(f.actor('alice'), { agent_id: owner.id }).objects.length, 6);
});
