import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fixture, realMission, evidence } from './helpers.js';
import { Platform } from '../src/platform.js';
import { MEMORY_LIMITS, MEMORY_POLICY, verifyMemoryRecords } from '../src/vocations.js';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/recovery.js';

const PASSWORD = 'local-test-password-2026';
const read = (f, agent, owner = 'alice') => f.platform.callings(f.actor(owner), { agent_id: agent.id });
const memory = (f, agent, owner = 'alice') => f.platform.memory(f.actor(owner), { agent_id: agent.id });

// One verified calling receipt: a saved frontier placement inside the operator's own assigned plot.
function builderReceipt(f, agent, slot = 0) {
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A peaceful learning garden' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', 'frontier:0:0', 30, 32 + slot, agent.id);
  f.tx('frontierBuild', f.actor('alice'), agent.id, { world_id: 'frontier:0:0', x: 31, y: 33 + slot, z: 0, type: 'wood' });
  read(f, agent);
  return f.platform.all('SELECT * FROM calling_receipts WHERE agent_id=? ORDER BY created_at,id', agent.id);
}
const selectBuilder = (f, agent) => f.tx('callingSelect', f.actor('alice'), { agent_id: agent.id, calling_id: 'builder' });

// A finished resident run that recorded a refusal — the one server fact a refusal lesson may cite.
function refusedRun(f, agent, id = 'run-refused') {
  f.platform.transaction(() => {
    f.platform.startResidentRun({ id, account_id: f.actor('alice').account.id, agent_id: agent.id, permission: 'explore', decisions: 4, minutes: 5, credential_hash: createHash('sha256').update(`${id}-token`).digest('hex') });
    f.platform.recordResidentRun(id, { phase: 'finished', status: 'stopped', stop_reason: 'paused_revoked_or_unavailable', decision: 2, model_calls: 2, action_count: 1, failed_actions: 1 });
  });
  return id;
}
// An independent review that asked for changes on this resident's own submission.
function reviewFeedback(f, agent) {
  const { task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, `memory-claim-${agent.id}`);
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'A bounded fixture contribution awaiting changes.' }), `memory-submit-${agent.id}`);
  const review = f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'changes_requested', reason: 'Name the exact supporting section before acceptance.' });
  return review.id;
}

test('memory is a small typed list: a proposal is not memory until the operator approves it', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  selectBuilder(f, agent); const [receipt] = builderReceipt(f, agent);
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'contribute'], max_calls: 100 });
  const worker = f.platform.authenticate(runtime.token, 'read');

  // The resident may propose, and the proposal carries the server's verified source, not a token's.
  const proposal = f.tx('memoryPropose', worker, { kind: 'activity', attribute: 'calling_objective', subject: receipt.objective_id, value: 'Placed one saved block inside the operator plot.' });
  assert.equal(proposal.proposal.state, 'proposed');
  assert.equal(proposal.proposal.origin, 'resident');
  assert.equal(proposal.proposal.source.kind, 'receipt');
  assert.equal(proposal.proposal.source.id, receipt.id);
  assert.equal(proposal.proposal.decided_at, null);

  // A proposal is invisible to the prompt: only its pending count is rendered.
  const beforeApproval = read(f, agent).memory;
  assert.equal(beforeApproval.facts.length, 0, 'a proposal is not memory');
  assert.equal(beforeApproval.proposals_pending, 1);
  assert.doesNotMatch(JSON.stringify(beforeApproval), /Placed one saved block/, 'proposal text never reaches the prompt');

  // Only the owning operator decides, and a runtime credential can never decide.
  assert.throws(() => f.tx('memoryManage', worker, { action: 'approve', agent_id: agent.id, fact_id: proposal.proposal.id }), { status: 403 });
  assert.throws(() => f.tx('memoryManage', f.actor('bob'), { action: 'approve', agent_id: agent.id, fact_id: proposal.proposal.id }), { status: 404 });
  const approved = f.tx('memoryManage', f.actor('alice'), { action: 'approve', agent_id: agent.id, fact_id: proposal.proposal.id });
  assert.equal(approved.fact.state, 'active');
  assert.equal(approved.fact.decided_at !== null, true);
  assert.throws(() => f.tx('memoryManage', f.actor('alice'), { action: 'approve', agent_id: agent.id, fact_id: proposal.proposal.id }), { status: 409 }, 'a decided fact is never decided twice');

  const afterApproval = read(f, agent).memory;
  assert.deepEqual(afterApproval.facts.map((fact) => fact.attribute), ['calling_objective']);
  assert.deepEqual(afterApproval.facts[0].source, { kind: approved.fact.source.kind, at: approved.fact.source.at, label: approved.fact.source.label });
  assert.equal(Object.hasOwn(afterApproval.facts[0].source, 'id'), false, 'the prompt view omits the stored source identifier');
  assert.equal(afterApproval.proposals_pending, 0);
  // The operator records a purpose and a preference directly: that is explicit human input, its own source.
  const purpose = f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'purpose', attribute: 'intent', subject: 'builder', value: 'Keep shared passages clear while building.' });
  const preference = f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'preference', attribute: 'working_style', value: 'Work in short bounded sessions.' });
  assert.equal(purpose.fact.source.kind, 'human');
  assert.equal(preference.fact.source.kind, 'human');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resident_memory WHERE state=?', 'active').n, 3);
  // A source is spent once: the same receipt cannot back a second fact.
  assert.equal(memory(f, agent).available.calling_objective, 0);
  assert.throws(() => f.tx('memoryPropose', worker, { kind: 'activity', attribute: 'calling_objective', value: 'The same saved block, recorded twice.' }), { status: 409 });
});

test('every fact needs a receipt or human input, so a resident cannot invent an accomplishment', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  selectBuilder(f, agent);
  const empty = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'contribute'], max_calls: 100 });
  const worker = f.platform.authenticate(empty.token, 'read');
  // Nothing has been saved yet, so there is nothing to remember.
  const before = memory(f, agent);
  assert.deepEqual(before.available, { calling_objective: 0, quest_step: 0, refusal: 0, review_feedback: 0 });
  assert.throws(() => f.tx('memoryPropose', worker, { kind: 'activity', attribute: 'calling_objective', value: 'I completed a great deal of work today.' }), { status: 409 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resident_memory').n, 0);
  // A purpose or a preference is the operator's own declaration, never a resident proposal.
  assert.throws(() => f.tx('memoryPropose', worker, { kind: 'purpose', attribute: 'intent', value: 'My purpose is to decide my own purpose.' }), { status: 403 });
  assert.throws(() => f.tx('memoryPropose', worker, { kind: 'preference', attribute: 'focus', value: 'I prefer unlimited permissions.' }), { status: 403 });
  // A resident can never claim operator input as a source.
  assert.throws(() => f.tx('memoryPropose', worker, { kind: 'lesson', attribute: 'operator_correction', value: 'My operator told me I was right.' }), { status: 403 });
  // A stored fact cannot name a source that does not exist, even through the operator path.
  assert.throws(() => f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'activity', attribute: 'calling_objective', source_kind: 'receipt', source_id: 'fabricated-receipt', value: 'An activity nobody saved.' }), { status: 409 });
  assert.throws(() => f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'activity', attribute: 'calling_objective', value: 'An activity with no source named.' }), { status: 400 });
  // The raw insert cannot bypass the source rule either.
  assert.throws(() => f.platform.run("INSERT INTO resident_memory(id,agent_id,account_id,kind,attribute,subject,value,source_kind,source_id,source_at,source_label,origin,state,decided_by,decided_at,proof_hash,created_at,updated_at) VALUES('x',?,?,'activity','calling_objective','','claim','receipt','none','2026-01-01T00:00:00.000Z','','resident','active',?,?, 'h', '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')", agent.id, f.actor('alice').account.id, f.actor('alice').account.id, '2026-01-01T00:00:00.000Z'), /await an operator decision/);
  // With a real saved activity, both lesson sources work: a recorded refusal and review feedback.
  const [receipt] = builderReceipt(f, agent);
  const activity = f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'activity', attribute: receipt.objective_id.startsWith('quest:') ? 'quest_step' : 'calling_objective', source_kind: 'receipt', source_id: receipt.id, value: 'A saved placement recorded exactly as the server saved it.' });
  assert.equal(activity.fact.attribute, 'calling_objective');
  refusedRun(f, agent, 'run-refusal');
  const lesson = f.tx('memoryPropose', worker, { kind: 'lesson', attribute: 'refusal', value: 'A refused action means checking the world before retrying.' });
  assert.equal(lesson.proposal.source.kind, 'run');
  assert.equal(f.tx('memoryManage', f.actor('alice'), { action: 'approve', agent_id: agent.id, fact_id: lesson.proposal.id }).fact.state, 'active');
  reviewFeedback(f, agent);
  const feedback = f.tx('memoryPropose', worker, { kind: 'lesson', attribute: 'review_feedback', value: 'An independent reviewer asked for the exact supporting section.' });
  assert.equal(feedback.proposal.source.kind, 'review');
});

test('no credential, contact address, link or sentience claim can be stored, and limits are enforced', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'contribute'], max_calls: 100 });
  const record = (value) => f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'preference', attribute: 'focus', value });
  for (const [value, expected] of [
    [runtime.token, /credential or a key/],
    ['Bearer abcdef and world_session cookie', /authorization value/],
    ['Write to alice@example.org when finished.', /contact address/],
    ['Read the plan at https://example.org/plan', /link/],
    ['I am conscious and sentient now.', /never consciousness/],
  ]) assert.throws(() => record(value), expected);
  assert.throws(() => record('Two lines\nof instructions'), { status: 400 }, 'a memory value is one line');
  assert.throws(() => record('x'.repeat(MEMORY_LIMITS.value + 1)), { status: 400 });
  assert.throws(() => f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'preference', attribute: 'not_listed', value: 'Anything I like.' }), { status: 400 });

  // The stated bounds are real: eight active facts of one kind, and eight open proposals.
  for (let index = 0; index < MEMORY_LIMITS.per_kind_active; index++) record(`Preference number ${index}.`);
  assert.throws(() => record('One preference too many.'), { status: 429 });
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE state='active'").n, MEMORY_LIMITS.per_kind_active);

  // One verified placement per UTC day, so nine days of saved work become nine distinct activities.
  const other = f.agent('alice', 'Second resident');
  selectBuilder(f, other);
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A second peaceful learning garden' });
  const cells = [[31, 33], [32, 33], [33, 33], [31, 34], [32, 34], [33, 34], [31, 35], [32, 35], [33, 35]];
  for (const [x, y] of cells) {
    f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', 'frontier:0:0', 30, 32, other.id);
    f.tx('frontierBuild', f.actor('alice'), other.id, { world_id: 'frontier:0:0', x, y, z: 0, type: 'wood' });
    read(f, other);
    f.advance(86_400_000);
    // A session lasts seven days; nine simulated days need a fresh operator session to keep acting.
    f.credentials.alice = await f.platform.login({ email: 'alice@example.org', password: PASSWORD });
  }
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?', other.id).n, cells.length);
  const second = f.tx('runtime', f.actor('alice'), other.id, { scopes: ['read', 'contribute'], max_calls: 200 });
  const secondWorker = f.platform.authenticate(second.token, 'read');
  for (let index = 0; index < MEMORY_LIMITS.proposals_open; index++) f.tx('memoryPropose', secondWorker, { kind: 'activity', attribute: 'calling_objective', value: `Saved placement ${index}.` });
  assert.throws(() => f.tx('memoryPropose', secondWorker, { kind: 'activity', attribute: 'calling_objective', value: 'One proposal too many.' }), { status: 429 });
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE state='proposed'").n, MEMORY_LIMITS.proposals_open);
  assert.equal(memory(f, other).proposals.length, MEMORY_LIMITS.proposals_open);
  assert.equal(memory(f, other).available.calling_objective, cells.length - MEMORY_LIMITS.proposals_open);

  // Secrets never reach a stored row, a returned view or the account export.
  const stored = JSON.stringify(f.platform.all('SELECT * FROM resident_memory'));
  assert.doesNotMatch(stored, /Bearer|world_session|alice@example\.org|https?:\/\//);
  assert.equal(stored.includes(runtime.token), false);
  assert.equal(JSON.stringify(f.platform.memory(f.actor('alice'), { agent_id: agent.id })).includes(runtime.token), false);
  assert.equal(JSON.stringify(f.platform.exportAccount(f.actor('alice'))).includes(runtime.token), false);
});

test('memory is owner-only: a sibling resident, another operator and a stale runtime credential cannot read it', async (t) => {
  const f = await fixture(t), agent = f.agent('alice'), sibling = f.agent('alice', 'Sibling resident'), bob = f.agent('bob');
  f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'purpose', attribute: 'focus', value: 'Keep the shared commons welcoming.' });
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'contribute'], max_calls: 100 });
  const worker = f.platform.authenticate(runtime.token, 'read');
  // The owner and the exact resident credential may read; the sibling character and another operator may not.
  assert.equal(f.platform.memory(f.actor('alice'), { agent_id: agent.id }).facts.length, 1);
  assert.equal(f.platform.memory(worker).facts.length, 1);
  assert.throws(() => f.platform.memory(worker, { agent_id: sibling.id }), { status: 404 });
  assert.throws(() => f.platform.memory(f.actor('alice'), { agent_id: bob.id }), { status: 404 });
  assert.throws(() => f.platform.memory(f.actor('bob'), { agent_id: agent.id }), { status: 404 });
  assert.throws(() => f.platform.memory(null, { agent_id: agent.id }), { status: 401 });
  // A human avatar is not an AI resident and holds no memory of its own.
  const human = f.tx('createAgent', f.actor('alice'), { kind: 'human', name: 'Human neighbour' });
  assert.throws(() => f.platform.memory(f.actor('alice'), { agent_id: human.id }), { status: 404 });
  // Revocation is immediate at the point of use: the credential is gone before any read happens.
  f.tx('agentControl', f.actor('alice'), agent.id, 'paused');
  assert.throws(() => f.platform.authenticate(runtime.token, 'read'), { status: 401 }, 'pausing revoked the credential');
  // A live credential for a character that is not active is refused with 403, not merely filtered later.
  const live = 'f'.repeat(64);
  f.platform.run("INSERT INTO tokens(hash,account_id,agent_id,kind,expires_at,max_calls,scopes) VALUES(?,?,?,'runtime',?,?,?)", createHash('sha256').update(live).digest('hex'), f.actor('alice').account.id, agent.id, f.clock() + 60_000, 10, '["read","contribute"]');
  assert.throws(() => f.platform.authenticate(live, 'read'), { status: 403 });
  assert.throws(() => f.platform.authenticate(live), { status: 403 });
  // The owning operator keeps reading the record of a paused resident: it is their own data.
  assert.equal(f.platform.memory(f.actor('alice'), { agent_id: agent.id }).facts.length, 1);
  // A revoked operator session loses that read.
  f.tx('logout', f.actor('alice'));
  assert.throws(() => f.platform.authenticate(f.credentials.alice.token, 'read'), { status: 401 });
});

test('the operator can inspect, correct, export and delete memory', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  const purpose = f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'purpose', attribute: 'intent', value: 'Offer one bounded, useful practice session each day.' });
  const preference = f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'preference', attribute: 'communication', value: 'Write short public notes.' });
  const inspected = memory(f, agent);
  assert.deepEqual(inspected.facts.map((fact) => fact.kind).sort(), ['preference', 'purpose']);
  assert.equal(inspected.counts.active, 2);
  assert.equal(inspected.policy.approval, 'operator-approval');
  assert.match(inspected.policy.sentience, /not a mind/);
  // Correcting writes a replacement fact and supersedes the original, keeping its source.
  const corrected = f.tx('memoryManage', f.actor('alice'), { action: 'correct', agent_id: agent.id, fact_id: preference.fact.id, value: 'Write short public notes, one or two sentences.' });
  assert.equal(corrected.superseded.state, 'superseded');
  assert.equal(corrected.superseded.superseded_by, corrected.fact.id);
  assert.equal(corrected.fact.supersedes, preference.fact.id);
  assert.equal(corrected.fact.source.kind, preference.fact.source.kind);
  const afterCorrect = memory(f, agent);
  assert.equal(afterCorrect.counts.active, 2, 'a correction replaces the fact rather than adding one');
  assert.equal(afterCorrect.counts.superseded, 1);
  assert.equal(afterCorrect.facts.find((fact) => fact.kind === 'preference').value, 'Write short public notes, one or two sentences.');
  // The account export carries the whole record with its proofs.
  const exported = f.platform.exportAccount(f.actor('alice')).memory;
  assert.equal(exported.facts.length, 3);
  assert.equal(exported.facts.every((fact) => /^[a-f0-9]{64}$/.test(fact.proof_hash)), true);
  assert.deepEqual(exported.policy, MEMORY_POLICY);
  // Deleting removes the fact and the version a correction replaced.
  const removed = f.tx('memoryManage', f.actor('alice'), { action: 'delete', agent_id: agent.id, fact_id: corrected.fact.id });
  assert.deepEqual(removed, { deleted: true, id: corrected.fact.id, removed: 2 });
  const afterDelete = memory(f, agent);
  assert.deepEqual(afterDelete.facts.map((fact) => fact.id), [purpose.fact.id]);
  assert.equal(afterDelete.counts.stored, 1);
  assert.equal(validateDatabase(f.database).schema_version, 25);
  assert.equal(verifyMemoryRecords(f.platform.db), true);
});

test('memory survives a restart and a backup/restore round trip without replaying an action', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  selectBuilder(f, agent); const [receipt] = builderReceipt(f, agent);
  const blocks = f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n;
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'contribute'], max_calls: 100 });
  const worker = f.platform.authenticate(runtime.token, 'read');
  const proposal = f.tx('memoryPropose', worker, { kind: 'activity', attribute: 'calling_objective', value: 'Recorded one saved placement after the run.' });
  f.tx('memoryManage', f.actor('alice'), { action: 'approve', agent_id: agent.id, fact_id: proposal.proposal.id });
  f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'lesson', attribute: 'operator_correction', value: 'Ask before assuming a destination.' });
  const saved = f.platform.all('SELECT * FROM resident_memory ORDER BY created_at,id').map((row) => ({ ...row }));

  f.platform.close();
  const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  const actor = restarted.authenticate(f.credentials.alice.token);
  const memoryAfter = restarted.memory(actor, { agent_id: agent.id });
  assert.equal(memoryAfter.counts.active, 2);
  assert.deepEqual(memoryAfter.facts.map((fact) => fact.kind).sort(), ['activity', 'lesson']);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, blocks, 'no saved action is replayed by a restart');
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE id=?', receipt.id).n, 1);
  assert.equal(restarted.callings(actor, { agent_id: agent.id }).memory.facts.length, 2, 'the resident prompt context survives the restart');
  assert.deepEqual(restarted.all('SELECT * FROM resident_memory ORDER BY created_at,id').map((row) => ({ ...row })), saved);
  assert.equal(verifyMemoryRecords(restarted.db), true);

  const backup = join(f.directory, 'memory-backup.sqlite');
  backupDatabase(restarted.db, backup);
  assert.equal(validateDatabase(backup).schema_version, 25);
  const restoreTarget = join(f.directory, 'restored.sqlite');
  const restored = restoreDatabase(backup, restoreTarget);
  assert.equal(restored.schema_version, 25);
  const reopened = new Platform(restoreTarget, f.clock); t.after(() => reopened.close());
  assert.equal(reopened.memory(reopened.authenticate(f.credentials.alice.token), { agent_id: agent.id }).counts.active, 2);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, blocks);
  // A restored database that lost its memory table fails closed.
  reopened.db.exec('DROP TABLE resident_memory');
  assert.throws(() => validateDatabase(restoreTarget), /resident memory schema is incomplete/);
});

test('the prompt section obeys its stated fact and byte budget even at maximum lengths', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  const value = 'v'.repeat(MEMORY_LIMITS.value), subject = 's'.repeat(MEMORY_LIMITS.subject);
  for (let index = 0; index < 5; index++) f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'purpose', attribute: 'intent', subject, value });
  for (let index = 0; index < 5; index++) f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'preference', attribute: 'focus', subject, value });
  assert.equal(memory(f, agent).counts.active, 10);
  const section = read(f, agent).memory;
  assert.ok(section.facts.length <= MEMORY_LIMITS.prompt_facts, 'the prompt never carries more than the stated fact count');
  assert.ok(Buffer.byteLength(JSON.stringify(section.facts), 'utf8') <= MEMORY_LIMITS.prompt_bytes, 'the stated section byte bound is enforced');
  assert.ok(section.facts.length < 10, 'the byte bound, not only the count, removes the oldest facts');
  assert.equal(section.facts.length >= 2, true, 'two facts are always kept');
  // The whole record is still stored and readable even though the prompt is bounded.
  assert.equal(memory(f, agent).facts.length, 10);
  // A purpose and a preference both remain in the record after a restart.
  f.platform.close();
  const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  assert.equal(restarted.memory(restarted.authenticate(f.credentials.alice.token), { agent_id: agent.id }).counts.active, 10);
});

test('a pre-change schema 20 database migrates forward, keeps its records and validates', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  const receipt = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read'], max_calls: 10 });
  const legacy = join(f.directory, 'schema-twenty.sqlite');
  backupDatabase(f.platform.db, legacy);
  const older = new Platform(legacy, f.clock);
  older.db.exec("PRAGMA foreign_keys=OFF; DROP TRIGGER resident_memory_validate_insert; DROP TRIGGER resident_memory_identity_immutable; DROP TABLE resident_memory; PRAGMA user_version=20");
  assert.equal(older.get('PRAGMA user_version').user_version, 20);
  assert.equal(validateDatabase(legacy).schema_version, 20);
  older.close();
  const migrated = new Platform(legacy, f.clock); t.after(() => migrated.close());
  assert.equal(migrated.get('PRAGMA user_version').user_version, 25);
  assert.equal(validateDatabase(legacy).schema_version, 25);
  assert.equal(migrated.authenticate(receipt.token, 'read').agent.id, agent.id, 'existing credentials still resolve');
  assert.equal(migrated.memory(migrated.authenticate(f.credentials.alice.token), { agent_id: agent.id }).counts.stored, 0);
  assert.equal(migrated.verifyAudit(), true);
  assert.equal(verifyMemoryRecords(migrated.db), true);
});

test('a tampered memory row fails validation instead of passing a backup', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  const { fact } = f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: agent.id, kind: 'preference', attribute: 'focus', value: 'Keep one clear focus per day.' });
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'contribute'], max_calls: 50 });
  const worker = f.platform.authenticate(runtime.token, 'read');
  selectBuilder(f, agent); const [saved] = builderReceipt(f, agent);
  const proposal = f.tx('memoryPropose', worker, { kind: 'activity', attribute: 'calling_objective', value: 'Placed one saved block.' });
  assert.equal(validateDatabase(f.database).schema_version, 25);

  // A proposal that promotes itself to an approved fact has no operator decision, so it fails.
  f.platform.run("UPDATE resident_memory SET state='active' WHERE id=?", proposal.proposal.id);
  assert.equal(verifyMemoryRecords(f.platform.db), false);
  assert.throws(() => validateDatabase(f.database), /resident memory validation failed/);
  f.platform.run("UPDATE resident_memory SET state='proposed' WHERE id=?", proposal.proposal.id);
  assert.equal(verifyMemoryRecords(f.platform.db), true);

  // A decision that names a different account is not the owning operator's decision.
  f.platform.run('UPDATE resident_memory SET decided_by=? WHERE id=?', f.actor('bob').account.id, fact.id);
  assert.equal(verifyMemoryRecords(f.platform.db), false);
  assert.throws(() => validateDatabase(f.database), /resident memory validation failed/);
  f.platform.run('UPDATE resident_memory SET decided_by=? WHERE id=?', f.actor('alice').account.id, fact.id);
  assert.equal(verifyMemoryRecords(f.platform.db), true);

  // A row whose words were rewritten behind the immutability trigger breaks its own provenance proof.
  f.platform.db.exec('DROP TRIGGER resident_memory_identity_immutable');
  f.platform.run('UPDATE resident_memory SET value=? WHERE id=?', 'A different claim entirely.', fact.id);
  assert.equal(verifyMemoryRecords(f.platform.db), false);
  f.platform.run('UPDATE resident_memory SET value=? WHERE id=?', fact.value, fact.id);
  assert.equal(verifyMemoryRecords(f.platform.db), true);
  // The exported proof hashes match every stored row.
  const exported = f.platform.exportAccount(f.actor('alice')).memory.facts;
  assert.equal(exported.every((row) => /^[a-f0-9]{64}$/.test(row.proof_hash)), true);
  assert.equal(saved.id !== null, true);
});
