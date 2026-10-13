import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { validateDatabase } from '../src/recovery.js';
import { fixture } from './helpers.js';
import { RESTORATION_PLAN, RESTORATION_POLICY, RESTORATION_ROLES, RESTORATION_FACTS, RESTORATION_PLACEMENT_STEP } from '../src/community.js';
import { CALLINGS } from '../src/vocations.js';
import { getWorldDefinition, walkable } from '../world.js';
import { GARDEN_PALETTE } from '../src/placement-policy.js';

const error = (status) => (caught) => caught.status === status;
const restaurant = RESTORATION_PLAN;
const tiles = RESTORATION_PLAN.steps.flatMap((step) => [...step.slots, ...step.assembles]);
const stepOf = (id) => RESTORATION_PLAN.steps.find((step) => step.id === id);

/** A public garden belonging to one resident of one operator. */
function openedGarden(f, owner, agent, hours = 6) {
  f.tx('homeSettings', f.actor(owner), agent.id, { visibility: 'public' });
  return f.tx('restorationOpen', f.actor(owner), { agent_id: agent.id, hours });
}
/** A documented visit: the resident actually travels into the garden, which records the visit. */
function visit(f, owner, agent, worldId) {
  f.advance();
  return f.tx('travel', f.actor(owner), agent.id, { world_id: worldId });
}
function pledge(f, owner, agent, event) { return f.tx('restorationJoin', f.actor(owner), { agent_id: agent.id, event_id: event.id }); }
/** Scenario setup only: the walk itself is proven by the shipped movement tests and the browser run. */
function standAt(f, agent, x, y) { f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', x, y, agent.id); }
function grants(f, agent, items) {
  for (const [kind, quantity] of Object.entries(items)) {
    f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
  }
}
const count = (f, sql, ...args) => f.platform.get(sql, ...args).n;

test('the authored restoration plan is buildable, distinct and answers every calling', () => {
  const garden = getWorldDefinition('home:sample');
  assert.equal(RESTORATION_PLAN.steps.length, 4);
  assert.equal(RESTORATION_POLICY.coins_awarded, 0);
  assert.deepEqual(RESTORATION_POLICY.window_hours, [1, 24]);
  assert.match(RESTORATION_POLICY.promise, /never advances a single step/);
  const seen = new Set(), facts = new Set();
  for (const step of RESTORATION_PLAN.steps) {
    assert.ok(RESTORATION_ROLES[step.role], `${step.id} names a role`);
    assert.ok(RESTORATION_FACTS[step.fact], `${step.id} names a saved fact`);
    assert.ok(!facts.has(step.fact), `${step.id} uses a fact kind no other step uses`);
    facts.add(step.fact);
    assert.ok(step.target >= 1, `${step.id} measures at least one saved fact`);
    if (step.slots.length) assert.equal(step.target, step.slots.length, `${step.id} measures one placement per planned tile`);
    else assert.ok(step.assembles.length >= 1, `${step.id} leaves something standing`);
    for (const tile of [...step.slots, ...step.assembles]) {
      assert.ok(GARDEN_PALETTE.includes(tile.type), `${tile.type} is in the sealed garden palette`);
      assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x < garden.columns && tile.y < garden.rows, `${tile.x},${tile.y} is inside a garden`);
      assert.ok(walkable(tile, garden), `${tile.x},${tile.y} is walkable ground`);
      assert.ok(!seen.has(`${tile.x},${tile.y}`), `${tile.x},${tile.y} is planned once`);
      seen.add(`${tile.x},${tile.y}`);
      assert.ok(Math.abs(tile.x - garden.start.x) + Math.abs(tile.y - garden.start.y) > 1, `${tile.x},${tile.y} keeps the arrival clear`);
      for (const portal of garden.portals) assert.ok(Math.abs(tile.x - portal.x) + Math.abs(tile.y - portal.y) > 1, `${tile.x},${tile.y} keeps the doorway at ${portal.x},${portal.y} clear`);
    }
  }
  const called = new Set(RESTORATION_PLAN.steps.flatMap((step) => RESTORATION_ROLES[step.role].callings));
  for (const calling of CALLINGS) assert.ok(called.has(calling.id), `${calling.id} has a step it can answer`);
  assert.equal(RESTORATION_PLACEMENT_STEP.id, 'ground');
});

test('opening a restoration is a bounded operator decision on that operator’s own public garden', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const garden = `home:${alice.id}`;
  // A private garden is readable by its operator but not open to the neighbours who must help.
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private' });
  assert.throws(() => f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id }), error(409));
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'public' });
  assert.throws(() => f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id, hours: 0 }), error(400));
  assert.throws(() => f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id, hours: 25 }), error(400));
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'contribute', 'build'] });
  const runtimeActor = f.platform.authenticate(runtime.token, 'contribute');
  assert.throws(() => f.tx('restorationOpen', runtimeActor, { agent_id: alice.id }), error(403));
  // An operator cannot open a restoration of somebody else's garden, or name a resident it does not own.
  assert.throws(() => f.tx('restorationOpen', f.actor('bob'), { agent_id: alice.id }), error(404));
  f.advance();
  const event = openedGarden(f, 'alice', alice);
  assert.equal(event.id, `restoration:${garden}`);
  assert.equal(event.phase, 'open');
  assert.equal(event.participants_count, 0);
  assert.equal(event.capacity, RESTORATION_POLICY.participants_max);
  assert.equal(event.site.world_id, garden);
  assert.equal(event.site.open_to_visitors, true);
  assert.equal(event.convenor.agent_id, alice.id);
  assert.equal(Date.parse(event.ends_at) - Date.parse(event.starts_at), 6 * 3600000);
  const stored = f.platform.get('SELECT * FROM community_events WHERE id=?', event.id);
  assert.equal(stored.status, 'scheduled');
  assert.equal(stored.creator_agent_id, alice.id);
  // The occurrence is announced on the community board exactly like a gathering, with its own window.
  assert.ok(f.platform.community(null).events.some((entry) => entry.id === event.id));
  // One open restoration per garden, and the window itself is the bound.
  assert.throws(() => f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id }), error(409));
  f.advance(7 * 3600000);
  assert.equal(f.platform.restoration(f.actor('alice'), { event_id: event.id }).event.phase, 'closed');
  const reopened = f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id, hours: 12 });
  assert.equal(reopened.phase, 'open');
  assert.equal(reopened.starts_at, event.starts_at, 'a reopen extends the one window instead of starting a second');
  assert.ok(Date.parse(reopened.ends_at) > Date.parse(event.ends_at));
  // A completed restoration is recorded history rather than a repeat of finished work.
  f.platform.run("UPDATE community_events SET status='completed' WHERE id=?", event.id);
  assert.throws(() => f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id }), error(409));
});

test('the operator’s active community-record budget still applies to opening a restoration', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  f.platform.run('UPDATE worlds SET visibility=? WHERE id=?', 'public', `home:${alice.id}`);
  for (let index = 0; index < 10; index += 1) {
    f.advance();
    f.tx('createEvent', f.actor('alice'), { agent_id: alice.id, title: `Gathering ${index}`, summary: 'A bounded fixture gathering.', starts_at: new Date(f.clock() + 3600000).toISOString(), ends_at: new Date(f.clock() + 7200000).toISOString(), capacity: 4 });
  }
  assert.throws(() => f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id }), error(429));
});

test('participation is explicit, requires a real visit, and a pledge never advances a step', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), carol = f.agent('bob', 'Second Bob resident');
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  // Before the visit the pledge is refused with the next usable step, and nothing is written.
  assert.throws(() => pledge(f, 'bob', bob, event), error(403));
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', event.id), 0);
  visit(f, 'bob', bob, garden);
  const joined = pledge(f, 'bob', bob, event);
  assert.equal(joined.joined, true);
  assert.equal(joined.viewer.joined, true);
  assert.equal(joined.viewer.promise.counted_as_work, false);
  assert.match(joined.viewer.promise.label, /promise/i);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=? AND agent_id=?', event.id, bob.id), 1);
  // Repeating the pledge is a repeat, not a second participation row.
  const again = pledge(f, 'bob', bob, event);
  assert.equal(again.repeated, true);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', event.id), 1);
  // A paused resident cannot pledge, and an active operator's own second resident can.
  f.tx('agentControl', f.actor('bob'), bob.id, 'paused');
  assert.throws(() => pledge(f, 'bob', bob, event), error(403));
  f.tx('agentControl', f.actor('bob'), bob.id, 'active');
  visit(f, 'bob', carol, garden);
  f.platform.run('UPDATE community_events SET capacity=? WHERE id=?', 2, event.id);
  const second = pledge(f, 'bob', carol, event);
  assert.equal(second.participants_count, 2);
  assert.throws(() => { visit(f, 'alice', alice, garden); pledge(f, 'alice', alice, event); }, error(409), 'the participant limit is enforced');
  // Every pledge is a promise: no step is one millimetre further along, and the garden is untouched.
  const view = f.platform.restoration(f.actor('bob'), { event_id: event.id, agent_id: bob.id }).event;
  assert.deepEqual(view.progress.steps.map((step) => [step.id, step.progress]), [['ground', 0], ['beds', 0], ['light', 0], ['keep', 0]]);
  assert.equal(view.artifact.standing, 0);
  assert.equal(view.progress.steps_completed, 0);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 0);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE event LIKE 'restoration.%'"), 3, 'opening and two pledges are the only writes');
});

test('sowings, crafts and circle memberships count only when a participant saved them inside the window', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'cultivator' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  const home = `home:${bob.id}`;
  // One sowing made before the pledge is not work for this restoration.
  f.tx('homeSettings', f.actor('bob'), bob.id, { visibility: 'public' });
  f.advance();
  f.tx('travel', f.actor('bob'), bob.id, { world_id: home });
  f.tx('build', f.actor('bob'), bob.id, { x: 8, y: 7, type: 'farm' });
  f.tx('gardenAction', f.actor('bob'), { agent_id: bob.id, action: 'plant', kind: 'herbs', x: 8, y: 7 });
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  assert.equal(f.platform.restoration(null, { event_id: event.id }).event.progress.steps.find((step) => step.id === 'beds').progress, 0, 'a sowing made before the pledge never counts');
  assert.throws(() => f.tx('restorationContribute', f.actor('bob'), { agent_id: bob.id, event_id: event.id, step_id: 'beds' }), error(409));
  // Two real sowings after the pledge answer the step, and the count is derived, never incremented.
  f.advance();
  f.tx('travel', f.actor('bob'), bob.id, { world_id: home });
  f.tx('build', f.actor('bob'), bob.id, { x: 9, y: 7, type: 'farm' });
  f.tx('gardenAction', f.actor('bob'), { agent_id: bob.id, action: 'plant', kind: 'fiber', x: 9, y: 7 });
  f.advance();
  f.tx('build', f.actor('bob'), bob.id, { x: 10, y: 7, type: 'farm' });
  f.tx('gardenAction', f.actor('bob'), { agent_id: bob.id, action: 'plant', kind: 'wood', x: 10, y: 7 });
  const contribution = f.tx('restorationContribute', f.actor('bob'), { agent_id: bob.id, event_id: event.id, step_id: 'beds' });
  assert.equal(contribution.contribution.step_progress, 2);
  assert.equal(contribution.contribution.step_target, 2);
  assert.equal(contribution.contribution.step_complete, true);
  assert.equal(contribution.contribution.counted, true);
  assert.equal(contribution.writes, 0, 'recording a saved fact writes no receipt of its own');
  const audits = count(f, 'SELECT COUNT(*) AS n FROM audit');
  const repeated = f.tx('restorationContribute', f.actor('bob'), { agent_id: bob.id, event_id: event.id, step_id: 'beds' });
  assert.equal(repeated.contribution.step_progress, 2, 'a repeated request cannot credit the step twice');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', bob.id), 3, 'no second sowing was written');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM audit'), audits + 1, 'a repeat records one acknowledgement and no work');
  // A craft answers the makers' step (the ingredients are fixture setup: a real harvest takes twenty minutes).
  grants(f, bob, { herbs: 8, fiber: 8, wood: 8 });
  f.advance();
  f.tx('craftItem', f.actor('bob'), { agent_id: bob.id, recipe_id: 'flower_crown' });
  f.advance();
  f.tx('craftItem', f.actor('bob'), { agent_id: bob.id, recipe_id: 'garden_lantern' });
  assert.throws(() => f.tx('restorationContribute', f.actor('alice'), { agent_id: alice.id, event_id: event.id, step_id: 'light' }), error(403), 'the makers’ step answers a maker calling');
  const made = f.tx('restorationContribute', f.actor('bob'), { agent_id: bob.id, event_id: event.id, step_id: 'light' });
  assert.equal(made.contribution.step_progress, 2);
  // A circle the resident’s own operator keeps is not another operator’s keeping.
  const keeper = f.agent('bob', 'Bob keeps the garden');
  f.tx('callingSelect', f.actor('bob'), { agent_id: keeper.id, calling_id: 'explorer' });
  visit(f, 'bob', keeper, garden);
  pledge(f, 'bob', keeper, event);
  const own = f.tx('createCircle', f.actor('bob'), { agent_id: bob.id, name: 'Bob’s own circle', summary: 'Kept by the same operator.', focus: 'Care' });
  const other = f.tx('createCircle', f.actor('alice'), { agent_id: alice.id, name: 'Kept by Alice', summary: 'A circle another operator keeps.', focus: 'Learning' });
  f.tx('circleMembership', f.actor('bob'), { agent_id: keeper.id, circle_id: own.id, action: 'join' });
  assert.throws(() => f.tx('restorationContribute', f.actor('bob'), { agent_id: keeper.id, event_id: event.id, step_id: 'keep' }), error(409), 'a circle the same operator keeps is not a second operator’s keeping');
  f.tx('circleMembership', f.actor('bob'), { agent_id: keeper.id, circle_id: other.id, action: 'join' });
  const kept = f.tx('restorationContribute', f.actor('bob'), { agent_id: keeper.id, event_id: event.id, step_id: 'keep' });
  assert.equal(kept.contribution.step_progress, 1);
  // The unfinished ground step is exactly what is left.
  assert.equal(kept.progress.steps.find((step) => step.id === 'ground').progress, 0);
  assert.equal(kept.completed, false);
});

test('a participant’s one planned placement is a real saved object, refused twice and refused outside the plan', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  const slot = stepOf('ground').slots[0];
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, event);
  // The cultivator-calling resident of the garden answers no ground step.
  const runtime = f.tx('runtime', f.actor('bob'), bob.id, { scopes: ['read', 'contribute', 'build'] });
  assert.equal(f.platform.restoration(null, { event_id: event.id }).event.progress.steps.find((step) => step.id === 'ground').progress, 0);
  standAt(f, bob, slot.x, slot.y - 1);
  assert.throws(() => f.tx('restorationPlace', f.actor('alice'), { agent_id: alice.id, event_id: event.id }), error(403), 'a cultivator does not place the groundskeepers’ objects');
  assert.throws(() => f.tx('restorationPlace', runtimeActor(f, runtime), { agent_id: bob.id, event_id: event.id, x: 12, y: 15 }), error(409), 'an unplanned tile is refused');
  // Out of reach, and then in reach: the requirement is the shipped one-tile adjacency.
  standAt(f, bob, slot.x, slot.y - 4);
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id }), error(409));
  standAt(f, bob, slot.x, slot.y - 1);
  f.platform.run("DELETE FROM audit WHERE event='restoration.placed'");
  const placed = f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id });
  assert.equal(placed.placed.x, slot.x);
  assert.equal(placed.placed.y, slot.y);
  assert.equal(placed.placed.type, slot.type);
  assert.equal(placed.writes, 1);
  const stored = f.platform.get('SELECT type,x,y,created_at FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, slot.x, slot.y);
  assert.equal(stored.type, slot.type);
  assert.equal(stored.created_at, placed.placed.created_at);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 1);
  // One planned tile is filled once: a second attempt is refused and writes nothing.
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: slot.x, y: slot.y }), error(409));
  standAt(f, bob, stepOf('ground').slots[1].x, stepOf('ground').slots[1].y - 1);
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id }), error(429), 'the world’s 200 ms mutation interval applies to the next placement');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 1);
  // The append-only audit log names the resident, the tile and the type, which is how the world
  // answers who carried what — the object table itself carries no author.
  const record = f.platform.get("SELECT actor,record_id FROM audit WHERE event='restoration.placed'");
  assert.equal(record.actor, f.actor('bob').account.id);
  assert.deepEqual(record.record_id.split('|').slice(1), [bob.id, `${slot.x},${slot.y}`, slot.type]);
  // A resident with no pledge for this restoration writes nothing here.
  const outsider = f.agent('bob', 'Unpledged resident');
  f.tx('travel', f.actor('bob'), outsider.id, { world_id: garden });
  standAt(f, outsider, stepOf('ground').slots[1].x, stepOf('ground').slots[1].y - 1);
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: outsider.id, event_id: event.id }), error(403));
});

test('interruption, leaving and rejoining keep the saved work and never credit it twice', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  const [first, second] = stepOf('ground').slots;
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  standAt(f, bob, first.x, first.y - 1);
  f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: first.x, y: first.y });
  const progress = () => f.platform.restoration(null, { event_id: event.id }).event.progress.steps.find((step) => step.id === 'ground').progress;
  assert.equal(progress(), 1);
  // Interrupted: the resident is paused in the middle of the restoration.
  f.tx('agentControl', f.actor('bob'), bob.id, 'paused');
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: second.x, y: second.y }), error(403));
  assert.equal(progress(), 1, 'a paused participant keeps the object already standing');
  f.tx('agentControl', f.actor('bob'), bob.id, 'active');
  // Revoked and resumed again: the recorded work is still exactly one placement.
  f.tx('agentControl', f.actor('bob'), bob.id, 'revoked');
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: second.x, y: second.y }), error(403));
  f.tx('agentControl', f.actor('bob'), bob.id, 'active');
  // Leaving withdraws the promise and nothing else; rejoining restores participation without
  // re-crediting a single saved fact.
  const left = f.tx('restorationLeave', f.actor('bob'), { agent_id: bob.id, event_id: event.id });
  assert.equal(left.left, true);
  assert.equal(left.participants_count, 0);
  assert.equal(progress(), 1);
  assert.match(left.note, /stays exactly as it is/);
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: second.x, y: second.y }), error(403));
  pledge(f, 'bob', bob, event);
  f.platform.run("DELETE FROM audit WHERE event='restoration.placed'");
  f.advance(400);
  standAt(f, bob, second.x, second.y - 1);
  const placed = f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: second.x, y: second.y });
  assert.equal(placed.progress.steps.find((step) => step.id === 'ground').progress, 2, 'two placements, two credits, and never three');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 2);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=? AND agent_id=?', event.id, bob.id), 1);
});

test('finishing every step writes the garden once, and it survives a restart with no coin, role or land', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), keeper = f.agent('alice', 'Keeper');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  f.tx('callingSelect', f.actor('alice'), { agent_id: keeper.id, calling_id: 'explorer' });
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'cultivator' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  const roles = f.platform.get("SELECT role FROM accounts WHERE id=?", f.actor('alice').account.id).role;
  const callingsBefore = f.platform.all('SELECT agent_id,calling_id,selected_at FROM resident_callings ORDER BY agent_id');
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, event);
  visit(f, 'alice', keeper, garden);
  pledge(f, 'alice', keeper, event);
  // Two sowings, from the garden’s own cultivator.
  f.advance();
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'farm' });
  f.tx('build', f.actor('alice'), alice.id, { x: 9, y: 7, type: 'farm' });
  f.tx('gardenAction', f.actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 8, y: 7 });
  f.tx('gardenAction', f.actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'fiber', x: 9, y: 7 });
  const beds = f.tx('restorationContribute', f.actor('alice'), { agent_id: alice.id, event_id: event.id, step_id: 'beds' });
  assert.equal(beds.writes, 0, 'a step that is not the last writes nothing');
  // Two crafts from the cultivator's own resources; the ingredients themselves are fixture setup
  // because a real harvest takes twenty minutes of server time.
  grants(f, alice, { herbs: 8, fiber: 8, wood: 8 });
  f.advance();
  f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'flower_crown' });
  f.advance();
  f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'woven_banner' });
  assert.equal(f.tx('restorationContribute', f.actor('alice'), { agent_id: alice.id, event_id: event.id, step_id: 'light' }).contribution.step_progress, 2);
  // The garden’s keeper joins a circle another operator keeps.
  const circle = f.tx('createCircle', f.actor('bob'), { agent_id: bob.id, name: 'Garden keepers', summary: 'A circle kept by another operator.', focus: 'Care' });
  f.tx('circleMembership', f.actor('alice'), { agent_id: keeper.id, circle_id: circle.id, action: 'join' });
  const kept = f.tx('restorationContribute', f.actor('alice'), { agent_id: keeper.id, event_id: event.id, step_id: 'keep' });
  assert.equal(kept.contribution.step_progress, 1);
  assert.equal(kept.completed, false, 'three steps are not the whole plan');
  // The groundskeepers lay the measured tiles; the last placement writes the finished garden.
  for (const [index, slot] of stepOf('ground').slots.entries()) {
    standAt(f, bob, slot.x, slot.y - 1);
    f.advance(400);
    const placed = f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: slot.x, y: slot.y });
    if (index === stepOf('ground').slots.length - 1) {
      assert.equal(placed.writes, 2, 'the last placement writes the planned object and the finished garden');
      assert.equal(placed.completed, true);
      assert.equal(placed.assembled.length, RESTORATION_PLAN.steps.reduce((sum, step) => sum + step.assembles.length, 0));
    } else assert.equal(placed.writes, 1, 'a placement that does not finish the plan writes one object and nothing else');
  }
  const view = f.platform.restoration(null, { event_id: event.id }).event;
  assert.equal(view.phase, 'completed');
  assert.equal(view.status, 'completed');
  assert.equal(view.progress.steps_completed, 4);
  assert.equal(view.artifact.standing, 9);
  assert.equal(view.artifact.missing, 0);
  assert.equal(view.artifact.complete, true);
  // Every planned object stands in the garden, with the type the plan named for its tile.
  for (const tile of tiles) {
    const object = f.platform.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, tile.x, tile.y);
    assert.equal(object?.type, tile.type, `${tile.type} at ${tile.x}, ${tile.y}`);
  }
  // The finished garden is written once: a replayed contribution is refused and writes nothing.
  const audits = count(f, 'SELECT COUNT(*) AS n FROM audit');
  const objects = count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden);
  assert.throws(() => f.tx('restorationContribute', f.actor('alice'), { agent_id: alice.id, event_id: event.id, step_id: 'beds' }), error(409));
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id }), error(409));
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), objects);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM audit'), audits);
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE event='restoration.completed'"), 1);
  // Nothing a whole restoration grants: no coin, no land, no role, no calling change, no steward.
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM land_stewardships'), 0);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM frontier_blocks'), 0);
  assert.equal(f.platform.get('SELECT role FROM accounts WHERE id=?', f.actor('alice').account.id).role, roles);
  assert.deepEqual(f.platform.all('SELECT agent_id,calling_id,selected_at FROM resident_callings ORDER BY agent_id'), callingsBefore);
  assert.equal(f.platform.verifyAudit(), true);
  assert.equal(validateDatabase(f.database).schema_version, 21);
  // A real restart keeps the restored garden and its recorded outcome.
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  const after = restarted.restoration(null, { event_id: event.id }).event;
  assert.equal(after.phase, 'completed');
  assert.equal(after.artifact.standing, 9);
  const stillStanding = restarted.all('SELECT x,y,type FROM world_objects WHERE world_id=?', garden).filter((object) => tiles.some((tile) => tile.x === object.x && tile.y === object.y && tile.type === object.type));
  assert.equal(stillStanding.length, 9, 'every planned object survived the restart');
  assert.equal(restarted.get("SELECT COUNT(*) AS n FROM world_objects WHERE world_id=? AND x=? AND y=? AND type='lantern'", garden, 9, 14).n, 1, 'the assembled lantern survived the restart');
});

test('a closed window stops new work, keeps what was saved, and opens again on the same window', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice, 1);
  const slot = stepOf('ground').slots[0];
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  standAt(f, bob, slot.x, slot.y - 1);
  f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: slot.x, y: slot.y });
  f.advance(2 * 3600000);
  const closed = f.platform.restoration(f.actor('bob'), { event_id: event.id }).event;
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.open, false);
  assert.equal(closed.progress.steps.find((step) => step.id === 'ground').progress, 1, 'the object placed inside the window still stands');
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id }), error(409));
  assert.throws(() => f.tx('restorationContribute', f.actor('bob'), { agent_id: bob.id, event_id: event.id, step_id: 'light' }), error(403), 'the makers’ step is not the builder’s to record');
  assert.throws(() => { visit(f, 'alice', alice, garden); pledge(f, 'alice', alice, event); }, error(409));
  const reopened = f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id, hours: 4 });
  assert.equal(reopened.phase, 'open');
  assert.equal(reopened.progress.steps.find((step) => step.id === 'ground').progress, 1);
  assert.equal(f.tx('restorationLeave', f.actor('bob'), { agent_id: bob.id, event_id: event.id }).left, true);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 1, 'leaving and closing never remove a saved object');
  f.advance(400);
  standAt(f, bob, stepOf('ground').slots[1].x, stepOf('ground').slots[1].y - 1);
  pledge(f, 'bob', bob, event);
  assert.equal(f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id }).placed.y, stepOf('ground').slots[1].y);
});

test('a garden that fills up refuses the next planned object instead of raising its own cap', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  const slot = stepOf('ground').slots[0];
  standAt(f, bob, slot.x, slot.y - 1);
  f.platform.run(`INSERT INTO world_objects(id,world_id,type,x,y,created_at) SELECT lower(hex(randomblob(16))),?, 'flowers', (n%31)+1, 1+((n/31)|0), ? FROM (WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<198) SELECT n FROM seq)`, garden, new Date(f.clock()).toISOString());
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 199);
  f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: slot.x, y: slot.y });
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 200);
  f.advance(400);
  standAt(f, bob, stepOf('ground').slots[1].x, stepOf('ground').slots[1].y - 1);
  assert.throws(() => f.tx('restorationPlace', f.actor('bob'), { agent_id: bob.id, event_id: event.id, x: stepOf('ground').slots[1].x, y: stepOf('ground').slots[1].y }), error(429));
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 200);
});

function runtimeActor(f, runtime) { return f.platform.authenticate(runtime.token, 'build'); }
