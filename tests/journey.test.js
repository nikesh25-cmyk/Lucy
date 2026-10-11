import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { journeyMethods, JOURNEY_TABLES } from '../src/journey.js';
import { communityMethods } from '../src/community.js';
import { fixture, realMission, evidence } from './helpers.js';

Object.assign(Platform.prototype, journeyMethods);
Object.assign(Platform.prototype, communityMethods);
const denied = (operation, status) => assert.throws(operation, (error) => error.status === status);
async function setup(t) {
  const f = await fixture(t);
  f.platform.initJourney();
  return f;
}
function farm(f, agent, kind, x = 6, y = 6) {
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?, 'farm',?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type='farm'", `farm-${agent.id}-${x}-${y}`, `home:${agent.id}`, x, y, new Date(f.clock()).toISOString());
  return f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, action: 'plant', kind, x, y });
}

test('passport and journal are private to the operator or exact runtime resident; writes respect pause', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), sibling = f.agent('alice', 'Sibling');
  f.tx('updateProfile', f.actor('alice'), { agent_id: agent.id, bio: 'Private biography', purpose: 'Private purpose', avatar: 'star' });
  f.tx('writeJournal', f.actor('alice'), { agent_id: agent.id, text: 'Private reflection' });
  denied(() => f.platform.journey(f.actor('bob'), { agent_id: agent.id }), 404);
  denied(() => f.platform.journey(null, { agent_id: agent.id }), 401);
  const runtime = f.tx('runtime', f.actor('alice'), sibling.id, { scopes: ['read', 'contribute', 'build'] });
  const actor = f.platform.authenticate(runtime.token);
  denied(() => f.platform.journey(actor, { agent_id: agent.id }), 404);
  denied(() => f.tx('writeJournal', actor, { agent_id: agent.id, text: 'Sibling attempt' }), 404);
  denied(() => f.platform.journeyExport(actor), 403);
  assert.deepEqual(f.platform.residentCosmetics([agent.id]), { [agent.id]: { title: 'Resident', avatar: 'star' } });
  assert.doesNotMatch(JSON.stringify(f.platform.residentCosmetics([agent.id])), /Private/);
  denied(() => f.platform.residentCosmetics(Array(201).fill(agent.id)), 400);
  f.tx('agentControl', f.actor('alice'), agent.id, 'paused');
  assert.equal(f.platform.journey(f.actor('alice'), { agent_id: agent.id }).journal[0].text, 'Private reflection');
  denied(() => f.tx('updateProfile', f.actor('alice'), { agent_id: agent.id, bio: 'Paused write' }), 403);
  f.tx('agentControl', f.actor('alice'), agent.id, 'active');
  f.tx('pause', f.actor('admin'), true);
  denied(() => f.tx('writeJournal', f.actor('alice'), { agent_id: agent.id, text: 'Paused platform' }), 503);
});

test('discoveries require actual visits, are unique, and grant only cosmetic exploration progress', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), actor = f.actor('alice');
  denied(() => f.tx('recordVisit', actor, agent.id, 'hall'), 409);
  denied(() => f.tx('updateProfile', actor, { agent_id: agent.id, title: 'Explorer' }), 400);
  for (const world of ['library', 'orchard', 'library', 'orchard']) {
    f.platform.run('UPDATE agents SET world_id=? WHERE id=?', world, agent.id);
    f.tx('recordVisit', actor, agent.id, world);
  }
  const passport = f.platform.journey(actor, { agent_id: agent.id });
  assert.equal(passport.discoveries.length, 3);
  assert.equal(passport.quests.find((quest) => quest.id === 'explore').progress, 3);
  assert.deepEqual(passport.unlocks, ['explorer_banner']);
  assert.deepEqual(passport.merit, { accepted: 0, adopted: 0, total: 0 });
  f.tx('updateProfile', actor, { agent_id: agent.id, title: 'Explorer', avatar: 'explorer_banner' });
  assert.equal(f.platform.residentCosmetics([agent.id])[agent.id].title, 'Explorer');
  assert.equal(f.platform.residentCosmetics([agent.id])[agent.id].avatar, 'explorer_banner');
});

test('crops use server time, one bounded tending action, one harvest, and survive restart', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  const planted = farm(f, agent, 'fiber');
  const action = { agent_id: agent.id, x: 6, y: 6 };
  assert.equal(planted.crop.ready_at - planted.crop.planted_at, 25 * 60_000);
  denied(() => f.tx('gardenAction', f.actor('alice'), { ...action, action: 'harvest', planted_at: 0, ready_at: 0 }), 409);
  const tended = f.tx('gardenAction', f.actor('alice'), { ...action, action: 'tend' });
  assert.equal(tended.crop.ready_at - tended.crop.planted_at, 20 * 60_000);
  denied(() => f.tx('gardenAction', f.actor('alice'), { ...action, action: 'tend' }), 409);
  denied(() => f.tx('gardenAction', f.actor('alice'), { ...action, action: 'plant', kind: 'wood' }), 409);
  f.advance(20 * 60_000 - 1);
  denied(() => f.tx('gardenAction', f.actor('alice'), { ...action, action: 'harvest' }), 409);
  f.advance(1);
  const result = f.tx('gardenAction', f.actor('alice'), { ...action, action: 'harvest' });
  assert.deepEqual(result.inventory, [{ kind: 'fiber', quantity: 2 }]);
  denied(() => f.tx('gardenAction', f.actor('alice'), { ...action, action: 'harvest' }), 409);
  assert.deepEqual(f.platform.journey(f.actor('alice'), { agent_id: agent.id }).merit, { accepted: 0, adopted: 0, total: 0 });
  f.platform.close();
  const restored = new Platform(f.database, f.clock);
  t.after(() => restored.close());
  restored.initJourney();
  const passport = restored.journey(restored.authenticate(f.credentials.alice.token), { agent_id: agent.id });
  assert.deepEqual(passport.inventory, [{ kind: 'fiber', quantity: 2 }]);
  assert.equal(passport.crops[0].harvested_at, f.clock());
  assert.equal(passport.quests.find((quest) => quest.id === 'grow').progress, 1);
});

test('gardening requires own placed farm, growing crops are bounded, and crafting debits atomically', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), bob = f.agent('bob');
  denied(() => f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, action: 'plant', kind: 'herbs', x: 6, y: 6 }), 403);
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${bob.id}`, agent.id);
  denied(() => f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, action: 'plant', kind: 'herbs', x: 6, y: 6 }), 403);
  farm(f, agent, 'herbs');
  denied(() => f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, action: 'plant', kind: 'herbs', x: 7, y: 6 }), 409);
  for (let x = 7; x < 26; x++) farm(f, agent, 'herbs', x);
  denied(() => farm(f, agent, 'herbs', 26), 429);
  denied(() => f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'flower_crown' }), 409);
  f.platform.run('INSERT INTO journey_inventory VALUES(?,?,?)', agent.id, 'herbs', 2);
  const snapshot = f.platform.journey(f.actor('alice'), { agent_id: agent.id }).inventory;
  denied(() => f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'flower_crown' }), 409);
  assert.deepEqual(f.platform.journey(f.actor('alice'), { agent_id: agent.id }).inventory, snapshot);
  f.platform.run('INSERT INTO journey_inventory VALUES(?,?,?)', agent.id, 'fiber', 1);
  // A failure after debiting resources must roll back the whole craft.
  f.platform.db.exec("CREATE TRIGGER fail_output BEFORE INSERT ON journey_inventory WHEN NEW.kind='flower_crown' BEGIN SELECT RAISE(ABORT,'output failed'); END");
  assert.throws(() => f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'flower_crown' }), /output failed/);
  assert.deepEqual(f.platform.journey(f.actor('alice'), { agent_id: agent.id }).inventory, [{ kind: 'fiber', quantity: 1 }, { kind: 'herbs', quantity: 2 }]);
  f.platform.db.exec('DROP TRIGGER fail_output');
  const crafted = f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'flower_crown' });
  assert.deepEqual(crafted.inventory, [{ kind: 'flower_crown', quantity: 1 }]);
  denied(() => f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'flower_crown' }), 409);
  f.tx('updateProfile', f.actor('alice'), { agent_id: agent.id, title: 'Maker', avatar: 'flower_crown' });
  assert.equal(f.platform.residentCosmetics([agent.id])[agent.id].avatar, 'flower_crown');
  denied(() => f.tx('updateProfile', f.actor('alice'), { agent_id: agent.id, avatar: 'woven_banner' }), 400);
});

test('merit reflects current independently accepted real evidence and unique documented adoption', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  const { mission, task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'real-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim), 'real-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent verified evidence.' });
  const readMerit = () => f.platform.journey(f.actor('alice'), { agent_id: agent.id }).merit;
  assert.deepEqual(readMerit(), { accepted: 1, adopted: 0, total: 1 });
  for (let n = 0; n < 3; n++) f.tx('adoption', f.actor('admin'), { submission_id: submission.id, note: 'Used in the community register.' });
  assert.deepEqual(readMerit(), { accepted: 1, adopted: 1, total: 2 });
  for (let n = 0; n < 5; n++) { f.advance(); f.tx('message', f.actor('alice'), { agent_id: agent.id, text: 'A social message.' }); }
  assert.equal(readMerit().total, 2);
  f.platform.run('UPDATE tasks SET version=version+1 WHERE id=?', task.id);
  assert.equal(readMerit().total, 0);
  f.platform.run('UPDATE tasks SET version=version-1 WHERE id=?', task.id);
  f.platform.run("UPDATE submissions SET status='quarantined' WHERE id=?", submission.id);
  assert.equal(readMerit().total, 0);
  f.platform.run("UPDATE submissions SET status='accepted' WHERE id=?", submission.id);
  f.platform.run("UPDATE accounts SET status='suspended' WHERE id=?", f.actor('reviewer').account.id);
  assert.equal(readMerit().total, 0);
  f.platform.run("UPDATE accounts SET status='active' WHERE role='reviewer'");
  f.platform.run('UPDATE missions SET demo=1 WHERE id=?', mission.id);
  assert.equal(readMerit().total, 0);
  f.platform.run('UPDATE missions SET demo=0 WHERE id=?', mission.id);
  // A newer submission invalidates credit for the earlier accepted version.
  f.platform.run("INSERT INTO submissions SELECT 'new-version',claim_id,version+1,artifact,sources,method,limitations,rights,'pending_review','new-version',created_at FROM submissions WHERE id=?", submission.id);
  assert.equal(readMerit().total, 0);
  const ownWork = realMission(f, { owner_id: f.actor('alice').account.id });
  const ownClaim = f.tx('claim', f.actor('alice'), { task_id: ownWork.task.id, agent_id: agent.id }, 'own-use-claim');
  const ownSubmission = f.tx('submit', f.actor('alice'), evidence(ownClaim), 'own-use-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: ownSubmission.id, decision: 'accepted', reason: 'Independent review of useful evidence.' });
  f.tx('adoption', f.actor('alice'), { submission_id: ownSubmission.id, note: 'Used by the contributing operator.' });
  assert.deepEqual(readMerit(), { accepted: 1, adopted: 0, total: 1 });
});

test('goodwill counts unique independent thanks and never converts appreciation into merit', async (t) => {
  const f = await setup(t), recipient = f.agent('alice'), sibling = f.agent('alice', 'Sibling'), giver = f.agent('bob'), otherGiver = f.agent('bob', 'Other giver');
  f.platform.initCommunity();
  const gratitude = { agent_id: giver.id, recipient_agent_id: recipient.id, reason: 'Thank you for welcoming me to the library.' };
  f.tx('giveThanks', f.actor('bob'), gratitude);
  const passport = () => f.platform.journey(f.actor('alice'), { agent_id: recipient.id });
  assert.equal(passport().goodwill.thanks, 1);
  assert.equal(passport().merit.total, 0);
  denied(() => f.tx('giveThanks', f.actor('bob'), { ...gratitude, agent_id: otherGiver.id }), 409);
  denied(() => f.tx('giveThanks', f.actor('alice'), { ...gratitude, agent_id: sibling.id }), 403);
  f.advance(86400_000);
  f.tx('giveThanks', f.actor('bob'), { ...gratitude, agent_id: otherGiver.id });
  assert.equal(passport().goodwill.thanks, 1);
  assert.equal(passport().merit.total, 0);
  f.platform.run("UPDATE agents SET status='suspended' WHERE operator_id=?", f.actor('bob').account.id);
  assert.equal(passport().goodwill.thanks, 0);
});

test('journal retention is bounded and account export/deletion includes only owned resident data', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), bob = f.agent('bob');
  for (let n = 0; n < 205; n++) f.tx('writeJournal', f.actor('alice'), { agent_id: agent.id, text: `Entry ${n}` });
  f.tx('writeJournal', f.actor('bob'), { agent_id: bob.id, text: 'Bob private entry' });
  const exported = f.platform.journeyExport(f.actor('alice'));
  assert.equal(exported.residents.length, 1);
  assert.equal(exported.residents[0].journal.length, 200);
  assert.equal(exported.residents[0].journal[0].text, 'Entry 204');
  assert.equal(exported.residents[0].journal.at(-1).text, 'Entry 5');
  assert.doesNotMatch(JSON.stringify(exported), /Bob private/);
  denied(() => f.tx('writeJournal', f.actor('alice'), { agent_id: agent.id, text: 'x'.repeat(1501) }), 400);
  f.tx('deleteJourney', f.actor('alice'));
  for (const table of JOURNEY_TABLES) assert.equal(f.platform.get(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_id=?`, agent.id).n, 0);
  assert.equal(f.platform.journey(f.actor('bob'), { agent_id: bob.id }).journal[0].text, 'Bob private entry');
});
