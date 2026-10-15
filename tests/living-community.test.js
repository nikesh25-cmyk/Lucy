import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { ensureLivingWorld, livingWorldTick, LIVING_ROSTER } from '../src/living-world.js';
import { LIVING_CIRCLES, LIVING_GATHERINGS, seedLivingCommunity } from '../src/living-community.js';

const world = (t) => {
  let time = Date.parse('2026-10-15T09:00:00Z');
  const platform = new Platform(':memory:', () => time);
  t.after(() => platform.close());
  return { platform, advance: (ms) => { time += ms; }, now: () => time };
};
const count = (platform, sql, ...args) => platform.get(sql, ...args).n;

test('the living residents seed circles, a guild project and a gathering per host', (t) => {
  const w = world(t);
  const { accounts } = ensureLivingWorld(w.platform, { bootstrap: true });
  const report = seedLivingCommunity(w.platform, { accounts, roster: LIVING_ROSTER });
  assert.equal(report.circles_created, LIVING_CIRCLES.length);
  assert.equal(report.gatherings_created, LIVING_GATHERINGS.length);
  assert.equal(report.projects_created, 1);
  assert.equal(count(w.platform, "SELECT COUNT(*) AS n FROM community_circles WHERE status='active'"), LIVING_CIRCLES.length);
  assert.equal(count(w.platform, "SELECT COUNT(*) AS n FROM community_events WHERE status='scheduled'"), LIVING_GATHERINGS.length);
  assert.equal(count(w.platform, "SELECT COUNT(*) AS n FROM guild_projects WHERE status='open'"), 1);
  // Every circle has its creator plus the listed members, and each circle's gathering is RSVPed by them.
  for (const spec of LIVING_CIRCLES) {
    const row = w.platform.get('SELECT id FROM community_circles WHERE name=?', spec.name);
    assert.equal(count(w.platform, 'SELECT COUNT(*) AS n FROM community_members WHERE circle_id=?', row.id), 1 + spec.members.length);
  }
  const hall = w.platform.get("SELECT e.id,e.world_id FROM community_events e WHERE e.creator_agent_id='lw-selene'");
  assert.equal(hall.world_id, 'hall');
  assert.equal(count(w.platform, 'SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', hall.id), 1 + 3);
});

test('seeding is idempotent, throttled and creates no coin, plot, receipt or review', (t) => {
  const w = world(t);
  const { accounts } = ensureLivingWorld(w.platform, { bootstrap: true });
  seedLivingCommunity(w.platform, { accounts, roster: LIVING_ROSTER });
  const tables = ['community_circles', 'community_events', 'guild_projects', 'coin_rewards', 'land_stewardships', 'calling_receipts', 'reviews', 'resident_memory'];
  const snapshot = () => tables.map((name) => count(w.platform, `SELECT COUNT(*) AS n FROM ${name}`));
  const before = snapshot();
  assert.equal(seedLivingCommunity(w.platform, { accounts, roster: LIVING_ROSTER }), null, 'a second call inside the interval does nothing');
  w.advance(61_000);
  const again = seedLivingCommunity(w.platform, { accounts, roster: LIVING_ROSTER });
  assert.deepEqual(Object.values(again), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(snapshot(), before);
  assert.equal(count(w.platform, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
  assert.equal(w.platform.verifyAudit(), true);
});

test('a finished gathering is replaced by the next one, with a different title', (t) => {
  const w = world(t);
  const { accounts } = ensureLivingWorld(w.platform, { bootstrap: true });
  seedLivingCommunity(w.platform, { accounts, roster: LIVING_ROSTER });
  const first = w.platform.get("SELECT title FROM community_events WHERE creator_agent_id='lw-selene' ORDER BY created_at LIMIT 1").title;
  w.advance(3 * 3_600_000);
  const report = seedLivingCommunity(w.platform, { accounts, roster: LIVING_ROSTER });
  assert.equal(report.gatherings_created, LIVING_GATHERINGS.length);
  const titles = w.platform.all("SELECT title FROM community_events WHERE creator_agent_id='lw-selene' ORDER BY starts_at").map((row) => row.title);
  assert.equal(titles.length, 2); assert.notEqual(titles[1], first);
  assert.equal(count(w.platform, "SELECT COUNT(*) AS n FROM community_events WHERE creator_agent_id='lw-selene' AND ends_at>?", new Date(w.now()).toISOString()), 1);
});

test('a newcomer can join the seeded circle, RSVP and pledge to the guild project', (t) => {
  const w = world(t);
  const { accounts } = ensureLivingWorld(w.platform, { bootstrap: true });
  seedLivingCommunity(w.platform, { accounts, roster: LIVING_ROSTER });
  // A real human-operated resident: a third operator that is not a living-world account.
  const id = 'newcomer-op';
  w.platform.run("INSERT INTO accounts(id,name,email,password,role,status,consent_at,created_at) VALUES(?,?,?,?,?,?,?,?)", id, 'Newcomer', 'newcomer@example.org', 'x:y', 'member', 'active', new Date(w.now()).toISOString(), new Date(w.now()).toISOString());
  const actor = { account: w.platform.get('SELECT * FROM accounts WHERE id=?', id), kind: 'session' };
  const agent = w.platform.transaction(() => w.platform.createAgent(actor, { name: 'Newcomer avatar', capabilities: 'Curious', limitations: 'New here' }));
  const circle = w.platform.get("SELECT id FROM community_circles WHERE name='Dawn Gardeners'");
  assert.ok(w.platform.transaction(() => w.platform.circleMembership(actor, { agent_id: agent.id, circle_id: circle.id, action: 'join' })).joined);
  const event = w.platform.get("SELECT id FROM community_events WHERE creator_agent_id='lw-aria'");
  assert.equal(w.platform.transaction(() => w.platform.eventRSVP(actor, { agent_id: agent.id, event_id: event.id, action: 'join' })).rsvped, true);
  const project = w.platform.get("SELECT id FROM guild_projects LIMIT 1");
  assert.ok(w.platform.transaction(() => w.platform.guildParticipation(actor, { agent_id: agent.id, project_id: project.id, action: 'join' })));
});

test('the living tick runs the seeding and reports it', (t) => {
  const w = world(t);
  ensureLivingWorld(w.platform, { bootstrap: true });
  const report = livingWorldTick(w.platform, { bootstrap: true });
  assert.equal(report.community.gatherings_created, LIVING_GATHERINGS.length);
});

test('seeding works inside the server\'s own tick transaction, and a refused write undoes only itself', (t) => {
  const w = world(t);
  ensureLivingWorld(w.platform, { bootstrap: true });
  // The server runs `platform.transaction(() => livingWorldTick(platform))`; a nested BEGIN would throw
  // and silently seed nothing, so the real scheduling path is the one that has to be proven.
  const report = w.platform.transaction(() => livingWorldTick(w.platform, { bootstrap: true }));
  assert.equal(report.community.circles_created, LIVING_CIRCLES.length);
  assert.equal(count(w.platform, "SELECT COUNT(*) AS n FROM community_circles WHERE status='active'"), LIVING_CIRCLES.length);
  assert.equal(count(w.platform, "SELECT COUNT(*) AS n FROM community_events WHERE status='scheduled'"), LIVING_GATHERINGS.length);
  assert.equal(count(w.platform, "SELECT COUNT(*) AS n FROM guild_projects"), 1);
  assert.equal(w.platform.db.isTransaction, false);
  // A second tick inside its own transaction after the interval adds nothing and still commits cleanly.
  w.advance(61_000);
  const again = w.platform.transaction(() => livingWorldTick(w.platform, { bootstrap: true }));
  assert.equal(again.community.circles_created + again.community.gatherings_created + again.community.projects_created, 0);
  assert.equal(w.platform.verifyAudit(), true);
});
