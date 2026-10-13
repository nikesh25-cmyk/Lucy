import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';

// Bounds for the reads task 14 measured. These assertions are about *shape* — how many records a
// response can carry — not about timing, so they belong in the suite. The before/after timings and
// the concurrent-client measurements live in docs/PERFORMANCE.md and scripts/perf-profile.mjs.
const avatars = (view) => view.agents || view.participants;

/** Synthetic residents that bypass the account creation quota solely to test query bounds. */
function seedResidents(f, count, { x = 10, y = 6, operatorId = f.actor('admin').account.id } = {}) {
  const ids = [];
  const stamp = new Date(f.clock()).toISOString();
  f.platform.transaction(() => {
    const insert = f.platform.db.prepare("INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,world_id,last_seen,created_at) VALUES(?,?,?,'#397f79','✦','','',?,?,'commons',?,?)");
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      insert.run(id, operatorId, `Bound fixture ${index}`, x, y, f.clock(), stamp);
      ids.push(id);
    }
  });
  return ids;
}

test('a crowded viewport stays bounded and reports an accepted-contribution count for every avatar', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  seedResidents(f, 4_000, { x: 10, y: 6 });
  const view = f.platform.world(f.actor('alice'), { world_id: 'commons', x: 10, y: 6, agent_id: alice.id });
  const visible = avatars(view);
  assert.equal(view.counts.world_agents, 4_001);
  assert.ok(visible.length <= 200, `the roster must stay within its 200-avatar bound (${visible.length})`);
  assert.equal(visible.length, 200);
  const inWindow = f.platform.get("SELECT COUNT(*) AS n FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.world_id='commons' AND a.status!='deleted' AND o.status='active'").n;
  assert.equal(view.counts.visible_agents + view.counts.hidden_agents, inWindow, 'visible plus hidden must equal every resident in the window');
  // The grouped contribution read replaced one correlated subquery per avatar; the field must still be
  // present and numeric on every agent row, including the ones with no contribution at all.
  const agents = visible.filter((participant) => participant.kind !== 'npc');
  assert.equal(agents.length, 200);
  assert.ok(agents.every((participant) => Number.isInteger(participant.accepted_contributions)), 'every avatar reports an integer accepted-contribution count');
  assert.ok(agents.every((participant) => participant.accepted_contributions === 0));
  assert.equal(agents.some((participant) => participant.id === alice.id), true, 'the viewer keeps a place in the bounded page');
});

test('per-resident history reads stay within the listing bound however many records are stored', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const accountId = f.actor('alice').account.id;
  const task = f.platform.get("SELECT id FROM tasks WHERE mission_id='climate'");
  const stored = 260;
  f.platform.transaction(() => {
    const insert = f.platform.db.prepare("INSERT INTO claims VALUES(?,?,1,?,?, 'released',?,?,?)");
    for (let index = 0; index < stored; index++) {
      insert.run(randomUUID(), task.id, accountId, index % 2 ? alice.id : null, f.clock(), `bound-claim-${index}`, new Date(f.clock() - index * 60_000).toISOString());
    }
  });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims').n, stored);
  const history = f.platform.history(f.actor('alice'));
  assert.equal(history.claims.length, 200, 'the claim list is capped at the 200-record bound');
  assert.ok(history.claims.length < stored, 'the bound must actually bind');
  const storedDates = history.claims.map((claim) => claim.created_at);
  assert.deepEqual(storedDates, [...storedDates].sort().reverse(), 'the newest claims are the ones kept');
  assert.ok(history.tasks.length <= 200, 'task context derived from the bounded claims stays bounded');
  assert.ok(history.missions.length <= history.tasks.length);

  // A runtime credential sees the same bound applied to its own character, in SQL rather than after
  // the page had already been cut, so it can never lose its own newest records to another agent's.
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { minutes: 10, max_calls: 100 });
  const runtimeHistory = f.platform.history(f.platform.authenticate(runtime.token));
  assert.ok(runtimeHistory.claims.length <= 200);
  assert.equal(runtimeHistory.claims.some((claim) => claim.agent_id !== alice.id), false, 'a runtime only ever sees its own character’s claims');
});

test('the resident passport bounds its visit history while keeping exact totals', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice').id;
  const shared = ['hall', 'library', 'workshop', 'orchard', 'harbor', 'gallery', 'pavilion', 'observatory', 'meditation'];
  const stored = 260;
  f.platform.transaction(() => {
    const insertWorld = f.platform.db.prepare("INSERT INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,'home',?,'public',32,24,?)");
    const insertVisit = f.platform.db.prepare('INSERT OR IGNORE INTO journey_visits(agent_id,world_id,visited_at) VALUES(?,?,?)');
    const stamp = new Date(f.clock()).toISOString();
    for (let index = 0; index < stored; index++) {
      insertWorld.run(`home:bound-${index}`, `Bound garden ${index}`, resident, stamp);
      insertVisit.run(resident, `home:bound-${index}`, f.clock() + 1000 + index);
    }
    for (const [index, worldId] of shared.entries()) insertVisit.run(resident, worldId, f.clock() + 500 + index);
  });
  const passport = f.platform.journey(f.actor('alice'), { agent_id: resident });
  assert.ok(passport.discoveries.length <= 200, `the atlas is capped at the 200-record bound (${passport.discoveries.length})`);
  assert.equal(passport.discovery_count, stored + shared.length + 1, 'the exact visit total is counted in SQL, not taken from the page');
  assert.equal(passport.discoveries_truncated, true);
  assert.equal(passport.discoveries[0].world_id, 'commons', 'the oldest discovery survives the bound');
  // A badge and a skill level read the exact total, so truncating the atlas cannot change what is earned.
  const explore = passport.quests.find((quest) => quest.id === 'explore');
  assert.equal(explore.progress, shared.length + 1, 'the exploration quest counts every shared visit, not the returned page');
  assert.equal(explore.complete, true);
  assert.equal(passport.badges.some((badge) => badge.id === 'explorer'), true);
});

test('world and guild pagination stay bounded however many records are stored', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const participants = seedResidents(f, 250, { operatorId: f.actor('bob').account.id });
  const plan = [{ id: 'research', title: 'Research', output_name: 'A source register', scope: 'Read one source and record it.' }];
  const project = f.tx('guildProjectCreate', f.actor('alice'), { agent_id: alice.id, guild_id: 'researcher', title: 'Bounded board', summary: 'A board with more stored rows than the read returns.', plan });
  f.platform.transaction(() => {
    const stamp = new Date(f.clock()).toISOString();
    const participant = f.platform.db.prepare('INSERT INTO guild_participants VALUES(?,?,?,?,?,?)');
    const contribution = f.platform.db.prepare('INSERT INTO guild_contributions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let index = 0; index < 150; index++) participant.run(project.id, participants[index], 'member', 'active', stamp, stamp);
    for (let index = 0; index < 250; index++) contribution.run(randomUUID(), project.id, 'research', participants[index], f.actor('bob').account.id, `Commitment ${index}`, '', '[]', 'pledged', '', null, null, null, null, stamp, stamp);
  });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants WHERE project_id=?', project.id).n, 151);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_contributions WHERE project_id=?', project.id).n, 250);
  const view = f.platform.guildProject(f.actor('alice'), { id: project.id, agent_id: alice.id });
  assert.ok(view.participants.length <= 100, `participants are capped at 100 (${view.participants.length})`);
  assert.ok(view.contributions.length <= 200, `contributions are capped at 200 (${view.contributions.length})`);
  assert.equal(view.participants.length, 100);
  assert.equal(view.contributions.length, 200);

  assert.throws(() => f.platform.guilds(f.actor('alice'), { limit: 25 }), { status: 400 });
  const board = f.platform.guilds(f.actor('alice'), { limit: 12 });
  assert.ok(board.projects.length <= board.limit);
  assert.equal(board.limit, 12);

  assert.throws(() => f.platform.worldList(f.actor('alice'), { limit: 51 }), { status: 400 });
  assert.throws(() => f.platform.worldList(f.actor('alice'), { limit: 0 }), { status: 400 });
  const directory = f.platform.worldList(f.actor('alice'), { offset: 0, limit: 5 });
  assert.ok(directory.worlds.filter((world) => world.kind === 'home').length <= directory.limit);
  assert.ok(directory.worlds.length <= directory.shared_count + directory.limit);
});

test('a garden read is bounded by the 200 placed items its write path allows', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const home = `home:${alice.id}`;
  f.tx('travel', f.actor('alice'), alice.id, { world_id: home });
  // The capacity itself, without 200 real placements: the storage rows the cap counts.
  f.platform.transaction(() => {
    const insert = f.platform.db.prepare('INSERT INTO world_objects VALUES(?,?,?,?,?,?)');
    const stamp = new Date(f.clock()).toISOString();
    for (let index = 0; index < 200; index++) insert.run(randomUUID(), home, 'path', 1 + index % 30, 1 + Math.floor(index / 30), stamp);
  });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', home).n, 200);
  assert.throws(() => f.tx('build', f.actor('alice'), alice.id, { x: 30, y: 22, type: 'path' }), { status: 429 });
  const view = f.platform.world(f.actor('alice'), { world_id: home, agent_id: alice.id });
  assert.equal(view.objects.length, 200, 'the viewport returns every stored object of a world whose capacity is the bound');
  assert.ok(view.objects.every((object) => Number.isInteger(object.x) && Number.isInteger(object.y)));
});
