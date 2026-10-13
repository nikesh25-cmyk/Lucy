import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, realMission, evidence } from './helpers.js';
import { Platform } from '../src/platform.js';
import {
  CALLINGS, PATHWAYS, PATHWAY_DEFECTS, PATHWAY_POLICY, PATHWAY_STATES, PATHWAY_DIVERSITY, PATHWAY_KINDS,
  PATHWAY_SOURCE_KINDS, PATHWAY_UNLOCK_BANNER, pathwayProgress, verifyCallingReceipts,
} from '../src/vocations.js';
import { backupDatabase, validateDatabase } from '../src/recovery.js';

const read = (f, agent, owner = 'alice') => f.platform.callings(f.actor(owner), { agent_id: agent.id });
const select = (f, agent, id, owner = 'alice') => f.tx('callingSelect', f.actor(owner), { agent_id: agent.id, calling_id: id });
const position = (f, agent, world, x = 6, y = 6) => f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', world, x, y, agent.id);
// Garden cells clear of the arrival tile and the cottage door; the build guard refuses anything that
// would block a doorway.
const FARM = [[4, 6], [4, 7], [4, 8], [3, 6], [8, 6]];
const furnish = (f, agent, x, y, type = 'flowers') => { position(f, agent, `home:${agent.id}`); return f.tx('build', f.actor('alice'), agent.id, { x, y, type }); };
const garden = (f, agent, x, y, action, kind) => f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, x, y, action, ...(kind ? { kind } : {}) });
const newestTask = (f, mission, title) => f.tx('createTask', f.actor('admin'), { mission_id: mission.id, title, instructions: 'Provide attribution, location, rights, and uncertainty.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] });
const accept = (f, claim, artifact) => {
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact }), `pathway-submit-${artifact.length}-${artifact.slice(0, 8)}`);
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent source review' });
  return submission;
};

// A stand-in platform that answers the three reads a pathway makes, so the authored ladder can be
// exercised for all eight callings without building every kind of saved fact by hand.
const platform = (receipts, contributions = [], adoptions = []) => ({
  get: (sql) => sql.startsWith('SELECT name FROM sqlite_master') ? { name: 'adoptions' } : { n: 0 },
  all: (sql) => sql.includes('FROM calling_receipts') ? receipts : sql.includes('adoptions d') ? adoptions : contributions,
});
const receipt = (kind, index) => ({ id: `${kind}:${index}`, source_kind: kind, source_id: `${kind}-${index}`, objective_id: null, earned_day: '2026-10-13', created_at: '2026-10-13T00:00:00.000Z' });
const contribution = (index) => ({ source_id: `submission-${index}`, task_id: `task-${index}`, mission: 'A fixture mission', created_at: '2026-10-13T00:00:00.000Z', evidence: PATHWAY_KINDS.verified, earned_day: '2026-10-13' });
const adoption = (index) => ({ source_id: `submission-${index}`, adoption_id: `adoption-${index}`, created_at: '2026-10-13T00:00:00.000Z', adoptions: 1, evidence: PATHWAY_KINDS.adopted, earned_day: '2026-10-13' });
const independent = (kind) => kind === PATHWAY_KINDS.verified || kind === PATHWAY_KINDS.adopted;

test('every calling ships one complete pathway, and no repeated source can walk more than its first tier', () => {
  assert.deepEqual(PATHWAY_DEFECTS, []);
  assert.equal(PATHWAYS.length, 8);
  assert.deepEqual(PATHWAYS.map((item) => item.calling_id), CALLINGS.map((item) => item.id));
  for (const definition of PATHWAYS) {
    const calling = CALLINGS.find((item) => item.id === definition.calling_id);
    assert.ok(definition.tiers.length >= 3, `${definition.calling_id} needs at least three tiers`);
    const used = new Set();
    definition.tiers.forEach((tier, index) => {
      const kinds = tier.requires.map((item) => item.kind);
      assert.equal(new Set(kinds).size, kinds.length, `${definition.calling_id} tier ${index + 1} repeats a kind`);
      if (index === 0) assert.deepEqual(kinds, [calling.objectives[0].source_kind], `${definition.calling_id} opens with its own practice`);
      else {
        // A tier either names two different kinds, or rests entirely on facts one activity cannot make.
        assert.ok(kinds.every(independent) || new Set(kinds).size >= PATHWAY_DIVERSITY.kinds_per_tier, `${definition.calling_id} tier ${index + 1} needs diverse evidence`);
        assert.ok(kinds.some((kind) => !used.has(kind)), `${definition.calling_id} tier ${index + 1} adds no new kind`);
      }
      for (const kind of kinds) used.add(kind);
    });
    assert.ok(used.size >= definition.tiers.length, `${definition.calling_id} needs at least one distinct kind per tier`);
    // One activity, repeated without limit, credits at most the opening tier; so does repeating one
    // independent fact, because another operator's decision is not a practice a resident can grind.
    for (const kind of new Set([...PATHWAY_SOURCE_KINDS, PATHWAY_KINDS.adopted])) {
      const repeated = pathwayProgress(platform(Array.from({ length: 60 }, (_, index) => receipt(kind, index))), 'agent', definition.calling_id);
      assert.ok(repeated.completed <= PATHWAY_DIVERSITY.single_kind_completes_at_most, `${definition.calling_id} advanced on repeated ${kind}`);
      if (kind === calling.objectives[0].source_kind) assert.equal(repeated.completed, 1, `${definition.calling_id} must credit its opening tier`);
    }
    assert.ok(pathwayProgress(platform([], Array.from({ length: 60 }, (_, index) => contribution(index))), 'agent', definition.calling_id).completed <= 1);
    assert.ok(pathwayProgress(platform([], [], Array.from({ length: 60 }, (_, index) => adoption(index))), 'agent', definition.calling_id).completed <= 1);
    // Supplying exactly the evidence the tiers name completes every tier: the pathway is reachable.
    const needed = new Map();
    for (const tier of definition.tiers) for (const item of tier.requires) needed.set(item.kind, (needed.get(item.kind) || 0) + item.min);
    const receipts = [], contributions = [], adoptions = [];
    let index = 0;
    for (const [kind, count] of needed) for (let n = 0; n < count; n += 1) {
      index += 1;
      if (kind === PATHWAY_KINDS.adopted) adoptions.push(adoption(index));
      else if (kind === PATHWAY_KINDS.verified) contributions.push(contribution(index));
      else receipts.push(receipt(kind, index));
    }
    const complete = pathwayProgress(platform(receipts, contributions, adoptions), 'agent', definition.calling_id);
    assert.equal(complete.completed, definition.tiers.length, `${definition.calling_id} could not be completed`);
    assert.equal(complete.complete, true);
    assert.equal(complete.next, null);
    for (const state of complete.tiers.flatMap((tier) => tier.requires)) assert.ok(PATHWAY_STATES.some((item) => item.id === state.evidence));
  }
  assert.deepEqual(PATHWAY_STATES.map((item) => item.id), ['practice', 'verified-contribution', 'external-adoption']);
  assert.deepEqual(PATHWAY_POLICY.grants, { account_role: false, land_permission: false, review_authority: false, action_scope: false, coins: 0 });
});

test('a resident who repeats one activity credits one tier only, a second kind credits the next, and practice mints no coin', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  select(f, agent, 'cultivator');
  for (const [x, y] of FARM) furnish(f, agent, x, y, 'farm');
  // Four plantings of one kind, one per day, credit the opening tier and nothing more.
  for (let day = 0; day < 4; day += 1) {
    f.advance(86400000);
    garden(f, agent, FARM[day][0], FARM[day][1], 'plant', 'herbs');
    read(f, agent);
  }
  let view = read(f, agent).pathway;
  assert.equal(view.completed, 1);
  assert.equal(view.tiers[0].state, 'complete');
  assert.equal(view.tiers[1].state, 'available');
  assert.equal(view.tiers[2].state, 'locked');
  assert.equal(view.contribution.practice.count, 4);
  assert.deepEqual(view.contribution.practice.kinds, ['crop_plant']);
  assert.equal(view.diversity.distinct_kinds, 1);
  assert.equal(view.next.tier_slug, 'sown-and-gathered');
  assert.deepEqual(view.next.missing.map((item) => [item.kind, item.have, item.min]), [['crop_harvest', 0, 1]]);
  assert.equal(view.next.requires_human_review, false);
  assert.equal(view.unlocks.find((item) => item.kind === 'cosmetic').earned, false);
  assert.equal(view.unlocks.find((item) => item.id === 'flower_crown').earned, false);
  const supported = view.tiers[0].evidence[0];
  assert.equal(supported.evidence, 'practice');
  assert.ok(f.platform.get('SELECT id FROM calling_receipts WHERE agent_id=? AND source_kind=? AND source_id=?', agent.id, supported.kind, supported.source_id));
  // A second kind — one mature harvest — credits the next tier and opens the banner decoration.
  f.advance(21 * 60000);
  garden(f, agent, 3, 6, 'harvest');
  view = read(f, agent).pathway;
  assert.equal(view.completed, 2);
  assert.equal(view.tiers[2].state, 'available');
  assert.equal(view.diversity.distinct_kinds, 2);
  assert.equal(view.unlocks.find((item) => item.kind === 'cosmetic').earned, true);
  assert.equal(view.contribution.verified.count, 0);
  assert.equal(f.platform.journey(f.actor('alice'), { agent_id: agent.id }).profile_options.avatars.includes(PATHWAY_UNLOCK_BANNER), true);
  f.tx('updateProfile', f.actor('alice'), { agent_id: agent.id, avatar: PATHWAY_UNLOCK_BANNER });
  // Another day of the same two kinds still cannot reach the reviewed tier.
  f.advance(86400000);
  garden(f, agent, 4, 8, 'harvest');
  garden(f, agent, 8, 6, 'plant', 'herbs');
  view = read(f, agent).pathway;
  assert.equal(view.completed, 2);
  assert.deepEqual(view.next.missing.map((item) => item.kind), ['research_accepted']);
  assert.equal(view.next.requires_human_review, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0, 'practice never mints a coin');
  assert.equal(verifyCallingReceipts(f.platform.db), true);
});

test('a tier stops counting while its evidence is withheld and counts again when the evidence is available', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  select(f, agent, 'researcher');
  const { task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'pathway-claim-1');
  const submission = accept(f, claim, 'A first attributed register entry.');
  let view = read(f, agent).pathway;
  assert.equal(view.tiers[0].state, 'complete', 'the scoped claim credits the opening tier');
  assert.equal(view.tiers[1].state, 'complete', 'the independent acceptance credits the second tier');
  assert.equal(view.contribution.verified.count, 1);
  assert.equal(view.contribution.adopted.count, 0);
  assert.equal(view.tiers[2].state, 'available');
  assert.deepEqual(view.next.missing.map((item) => item.kind), ['adopted']);
  // Withholding the acceptance withdraws the reviewed tier without rewriting anything.
  f.platform.run("UPDATE submissions SET status='quarantined' WHERE id=?", submission.id);
  view = read(f, agent).pathway;
  assert.equal(view.tiers[0].state, 'complete');
  assert.equal(view.tiers[1].state, 'available');
  assert.equal(view.contribution.verified.count, 0);
  assert.equal(view.next.requires_human_review, true, 'the tier now waits on an independent reviewer');
  assert.equal(view.tiers[2].state, 'locked');
  assert.equal(read(f, agent).experience.held, 5, 'the calling ledger holds the same evidence');
  assert.equal(verifyCallingReceipts(f.platform.db), true);
  f.platform.run("UPDATE submissions SET status='accepted' WHERE id=?", submission.id);
  view = read(f, agent).pathway;
  assert.equal(view.contribution.verified.count, 1);
  assert.equal(view.tiers[1].state, 'complete');
});

test('a whole pathway is derived, survives a restart, and grants no role, land right, review authority or coin', async (t) => {
  const f = await fixture(t), agent = f.agent('alice'), role = () => f.platform.get('SELECT role FROM accounts WHERE id=?', f.actor('alice').account.id).role;
  const land = () => f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, blocks = () => f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n;
  const { mission, task } = realMission(f);
  const second = newestTask(f, mission, 'Record a second source');
  select(f, agent, 'researcher');
  const first = accept(f, f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'pathway-full-1'), 'A first attributed register entry.');
  read(f, agent);
  const submissions = [first, accept(f, f.tx('claim', f.actor('alice'), { task_id: second.id, agent_id: agent.id }, 'pathway-full-2'), 'A second attributed register entry.')];
  f.tx('adoption', f.actor('admin'), { submission_id: first.id, note: 'Recorded use in the fixture briefing.' });
  const view = read(f, agent).pathway;
  assert.equal(view.complete, true);
  assert.equal(view.completed, view.total);
  assert.equal(view.next, null);
  assert.equal(view.contribution.verified.count, 2);
  assert.equal(view.contribution.adopted.count, 1);
  assert.equal(view.tiers.at(-1).evidence[0].evidence, 'external-adoption');
  const merit = f.platform.journey(f.actor('alice'), { agent_id: agent.id }).merit;
  assert.equal(merit.accepted, view.contribution.verified.count);
  assert.equal(merit.adopted, view.contribution.adopted.count);
  // A pathway grants nothing: no role, no land, no construction, no extra coin, no review power.
  assert.equal(role(), 'member');
  assert.equal(land(), 0);
  assert.equal(blocks(), 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 2, 'exactly one coin receipt per independent acceptance');
  assert.equal(f.platform.coins(f.actor('alice'), { agent_id: agent.id }).balance, 20);
  assert.throws(() => f.tx('review', f.actor('alice'), { submission_id: submissions[1].id, decision: 'accepted', reason: 'Approve myself' }), { status: 403 });
  const credential = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'contribute'] });
  assert.throws(() => f.tx('callingSelect', f.platform.authenticate(credential.token, 'read'), { agent_id: agent.id, calling_id: 'explorer' }), { status: 403 });
  // Derived, not stored: no pathway table exists, the schema is untouched, and a backup validates.
  assert.equal(validateDatabase(f.database).schema_version, 21);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%pathway%'").n, 0);
  const backup = join(f.directory, 'pathway-backup.sqlite');
  backupDatabase(f.platform.db, backup);
  assert.equal(validateDatabase(backup).schema_version, 21);
  f.platform.close();
  const restored = new Platform(f.database, f.clock);
  t.after(() => restored.close());
  const actor = restored.authenticate(f.credentials.alice.token);
  const after = restored.callings(actor, { agent_id: agent.id }).pathway;
  assert.deepEqual(after, view, 'the same progression returns after a restart');
  // Withholding one acceptance withdraws the reviewed tier and the closing tier with it.
  restored.run("UPDATE submissions SET status='quarantined' WHERE id=?", first.id);
  const held = restored.callings(actor, { agent_id: agent.id }).pathway;
  assert.equal(held.complete, false);
  assert.equal(held.completed, 2);
  assert.equal(held.contribution.verified.count, 1);
  assert.equal(held.contribution.adopted.count, 0);
  assert.equal(held.tiers[2].state, 'available');
  assert.equal(verifyCallingReceipts(restored.db), true);
});
