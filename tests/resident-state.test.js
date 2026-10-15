import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';
import { runAgent } from '../runtime/agent.js';
import { validateDatabase, backupDatabase, restoreDatabase, classifyResidentRun, INTERRUPTION_SUMMARY } from '../src/recovery.js';

async function service(t, platform, token, options = {}) {
  const app = createApp({ platform, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, input, credential = token) => {
    const response = await fetch(url + '/api/v1' + path, { method: input ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${credential}`, ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { app, call, url };
}
async function settled(f, id, attempts = 200) {
  for (let i = 0; i < attempts; i++) { const job = f.platform.get('SELECT * FROM jobs WHERE id=?', id); if (job && job.status !== 'running') return job; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Worker did not settle');
}
const gathering = (f, owner, agent) => f.tx('createEvent', f.actor(owner), {
  agent_id: agent.id, title: 'Fixture gathering', summary: 'A fictional gathering used by a bounded run test.',
  starts_at: new Date(Date.now() + 3600000).toISOString(), ends_at: new Date(Date.now() + 7200000).toISOString(), capacity: 4, world_id: 'commons',
});
const sha = (value) => createHash('sha256').update(value).digest('hex');

test('a bounded run records real counters, its last confirmed action and its stop reason', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const event = gathering(f, 'bob', bob);
  let credential = null, decisions = 0;
  const { call } = await service(t, f.platform, f.credentials.alice.token, {
    residentRunner: (options) => { credential = options.token; return runAgent(options); },
    mayorModel: async () => (++decisions === 1 ? JSON.stringify({ action: 'rsvp', event_id: event.id, intent: 'join' }) : '{"action":"wait"}'),
  });
  const started = await call('/residents/run', { agent_id: alice.id, minutes: 2, model_calls: 2, permission: 'creative' });
  assert.equal(started.status, 202);
  const job = await settled(f, started.data.job_id);
  assert.equal(job.status, 'completed');
  assert.match(job.detail, /2 model decisions, 1 actions/);
  assert.match(job.detail, /completed · call_limit/);
  assert.match(job.detail, /Last confirmed action: rsvp/);
  const run = f.platform.get('SELECT * FROM resident_runs WHERE id=?', started.data.job_id);
  assert.equal(run.status, 'completed');
  assert.equal(run.phase, 'finished');
  assert.equal(run.permission, 'creative');
  assert.equal(run.decision, 2);
  assert.equal(run.decision_budget, 2);
  assert.equal(run.model_calls, 2);
  assert.equal(run.action_count, 1);
  assert.equal(run.failed_calls, 0);
  assert.equal(run.failed_actions, 0);
  assert.equal(run.stop_reason, 'call_limit');
  assert.deepEqual(run.pending_action, '{}');
  assert.equal(JSON.parse(run.last_action).action, 'rsvp');
  assert.equal(JSON.parse(run.last_action).decision, 1);
  // The stored identifier is the same credential hash the tokens table already holds.
  assert.equal(run.credential_hash, sha(credential));
  const token = f.platform.get('SELECT revoked,used_calls FROM tokens WHERE hash=?', run.credential_hash);
  assert.equal(token.revoked, 1);
  assert.ok(token.used_calls > 0);
  // One confirmed action, exactly one stored RSVP: nothing was applied twice.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE agent_id=?', alice.id).n, 1);
  // The durable receipt is operator history, and it is not visible to another operator.
  assert.equal(f.platform.history(f.actor('bob')).runs.length, 0);
  const own = f.platform.history(f.actor('alice')).runs;
  assert.equal(own.length, 1);
  assert.equal(own[0].last_action.action, 'rsvp');
  assert.equal(own[0].decisions_remaining, 0);
  assert.equal(own[0].credential_hash, undefined);
  // The run/history interface reads exactly this data over HTTP.
  const history = await call('/history');
  assert.equal(history.status, 200);
  assert.equal(history.data.runs.length, 1);
  assert.equal(history.data.runs[0].id, started.data.job_id);
  assert.equal(history.data.runs[0].credential_hash, undefined);
  assert.equal(history.data.runs[0].last_action.action, 'rsvp');
  assert.equal((await call('/history', null, f.credentials.bob.token)).data.runs.length, 0);
  assert.equal(validateDatabase(f.database).schema_version, 26);
});

test('a failed model call and a refused action are counted honestly, never as completed work', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const full = gathering(f, 'bob', bob);
  f.platform.run('UPDATE community_events SET capacity=1 WHERE id=?', full.id);
  const { call } = await service(t, f.platform, f.credentials.alice.token, {
    mayorModel: async () => JSON.stringify({ action: 'rsvp', event_id: full.id, intent: 'join' }),
  });
  const refused = await call('/residents/run', { agent_id: alice.id, minutes: 2, model_calls: 2, permission: 'creative' });
  const job = await settled(f, refused.data.job_id);
  assert.equal(job.status, 'failed');
  assert.match(job.detail, /1 model decisions, 0 actions \(1 refused actions\)/);
  assert.match(job.detail, /failed · unavailable_or_invalid_action/);
  const run = f.platform.get('SELECT * FROM resident_runs WHERE id=?', refused.data.job_id);
  assert.equal(run.model_calls, 1);
  assert.equal(run.action_count, 0);
  assert.equal(run.failed_calls, 0);
  assert.equal(run.failed_actions, 1);
  assert.equal(run.status, 'failed');
  assert.equal(run.phase, 'finished');
  assert.equal(run.last_action, '{}');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE agent_id=?', alice.id).n, 0);

  const broke = await service(t, f.platform, f.credentials.alice.token, { mayorModel: async () => { throw new Error('Local model is unavailable.'); } });
  const errorRun = await broke.call('/residents/run', { agent_id: alice.id, minutes: 2, model_calls: 2, permission: 'observe' });
  const failed = await settled(f, errorRun.data.job_id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /1 model decisions, 0 actions \(1 failed model calls\)/);
  const broken = f.platform.get('SELECT * FROM resident_runs WHERE id=?', errorRun.data.job_id);
  assert.equal(broken.model_calls, 1);
  assert.equal(broken.failed_calls, 1);
  assert.equal(broken.action_count, 0);
  assert.equal(broken.phase, 'finished');
  assert.equal(broken.status, 'failed');
});

test('a runtime credential is never written into run state or receipts, only its hash', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  let credential = null;
  const { call } = await service(t, f.platform, f.credentials.alice.token, {
    residentRunner: (options) => { credential = options.token; return runAgent(options); },
    mayorModel: async () => '{"action":"wait"}',
  });
  const started = await call('/residents/run', { agent_id: alice.id, minutes: 1, model_calls: 1, permission: 'explore' });
  await settled(f, started.data.job_id);
  assert.match(credential, /^[a-f0-9]{64}$/);
  const stored = [
    ...f.platform.all('SELECT * FROM resident_runs').map(JSON.stringify),
    ...f.platform.all('SELECT * FROM jobs').map(JSON.stringify),
    JSON.stringify(f.platform.history(f.actor('alice'))),
    JSON.stringify(f.platform.exportAccount(f.actor('alice'))),
  ].join('|');
  assert.doesNotMatch(stored, new RegExp(credential));
  assert.equal(f.platform.get('SELECT credential_hash FROM resident_runs').credential_hash, sha(credential));
  // The session token that started the run is a different credential and is likewise absent.
  assert.doesNotMatch(stored, new RegExp(f.credentials.alice.token));
});

test('restart classifies each interrupted run from its last durable write and revokes its credential', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), account = f.actor('alice').account.id, agent = f.agent('bob', 'Bob researcher');
  const start = (id, changes) => {
    const session = f.tx('runtime', f.actor('alice'), id.startsWith('bob-') ? agent.id : alice.id, { minutes: 5, max_calls: 40, scopes: ['read', 'move', 'chat', 'contribute', 'build'] });
    f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', id, id.startsWith('bob-') ? agent.id : alice.id, 'running', 'Local resident: fixture run.', new Date().toISOString());
    f.platform.startResidentRun({ id, account_id: account, agent_id: id.startsWith('bob-') ? agent.id : alice.id, permission: 'creative', decisions: 4, minutes: 5, credential_hash: sha(session.token) });
    f.platform.recordResidentRun(id, changes);
    return session;
  };
  const inFlight = start('run-model-call', { phase: 'model_call', decision: 2, model_calls: 2 });
  const confirmed = start('run-confirmed', { phase: 'confirmed', decision: 1, model_calls: 1, action_count: 1, last_action: { action: 'rsvp', decision: 1, key: 'k1' } });
  const dispatched = start('run-dispatched', { phase: 'dispatch', decision: 1, model_calls: 1, pending_action: { action: 'build_block', decision: 1, key: 'k2' } });
  const empty = start('run-empty', { phase: 'observing' });
  start('run-ambiguous', { phase: 'dispatch' });
  f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', 'bob-research', agent.id, 'running', 'Research worker fixture.', new Date().toISOString());
  assert.equal(f.tx('recoverWorkerJobs'), 6);
  const classification = (id) => f.platform.get('SELECT * FROM resident_runs WHERE id=?', id).interrupted;
  assert.equal(classification('run-model-call'), 'model_call_in_flight');
  assert.equal(classification('run-confirmed'), 'action_confirmed');
  assert.equal(classification('run-dispatched'), 'action_dispatched_unconfirmed');
  assert.equal(classification('run-empty'), 'no_action_yet');
  assert.equal(classification('run-ambiguous'), 'unknown');
  assert.equal(f.platform.get('SELECT status FROM jobs WHERE id=?', 'bob-research').status, 'stopped');
  for (const id of ['run-model-call', 'run-confirmed', 'run-dispatched', 'run-empty', 'run-ambiguous']) {
    const job = f.platform.get('SELECT * FROM jobs WHERE id=?', id);
    assert.equal(job.status, 'interrupted');
    assert.match(job.detail, new RegExp(INTERRUPTION_SUMMARY[classification(id)].slice(0, 40)));
    assert.equal(f.platform.get('SELECT status FROM resident_runs WHERE id=?', id).status, 'interrupted');
    assert.equal(f.platform.get('SELECT stop_reason FROM resident_runs WHERE id=?', id).stop_reason, 'process_restart');
    const hash = f.platform.get('SELECT credential_hash FROM resident_runs WHERE id=?', id).credential_hash;
    assert.equal(f.platform.get('SELECT revoked FROM tokens WHERE hash=?', hash).revoked, 1);
  }
  // The classification is written once, and the confirmed action is still the only action.
  assert.equal(f.tx('recoverWorkerJobs'), 0);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='resident.run.interrupted'").n, 5);
  assert.equal(f.platform.verifyAudit(), true);
  assert.throws(() => f.platform.authenticate(inFlight.token), { status: 401 });
  assert.throws(() => f.platform.authenticate(confirmed.token), { status: 401 });
  assert.equal(classifyResidentRun({ phase: 'confirmed' }), 'action_confirmed');
  assert.equal(classifyResidentRun(null), 'unknown');
});

test('resume needs an explicit human action, a live character and an interrupted remainder', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), account = f.actor('alice').account.id;
  const { call } = await service(t, f.platform, f.credentials.alice.token, { mayorModel: async () => '{"action":"wait"}' });
  // Nothing interrupted yet.
  assert.equal((await call('/residents/resume', {})).status, 409);
  // A clean run is not resumable either: only a restart interruption is.
  const clean = await call('/residents/run', { agent_id: alice.id, minutes: 1, model_calls: 1, permission: 'observe' });
  await settled(f, clean.data.job_id);
  assert.equal((await call('/residents/resume', {})).status, 409);
  // An interrupted run whose whole decision budget was used cannot be resumed.
  const session = f.tx('runtime', f.actor('alice'), alice.id, { minutes: 5, max_calls: 40, scopes: ['read'] });
  f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', 'spent-run', alice.id, 'running', 'Local resident: fixture run.', new Date().toISOString());
  f.platform.startResidentRun({ id: 'spent-run', account_id: account, agent_id: alice.id, permission: 'observe', decisions: 1, minutes: 5, credential_hash: sha(session.token) });
  f.platform.recordResidentRun('spent-run', { phase: 'confirmed', decision: 1, model_calls: 1, action_count: 1, last_action: { action: 'say', decision: 1 } });
  f.tx('recoverWorkerJobs');
  const spent = await call('/residents/resume', {});
  assert.equal(spent.status, 409);
  assert.match(spent.data.error, /decision budget/);
  // A paused character ends the work: its interruption cannot be resumed until a human resumes it.
  const halted = f.tx('runtime', f.actor('alice'), alice.id, { minutes: 5, max_calls: 40, scopes: ['read'] });
  f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', 'paused-run', alice.id, 'running', 'Local resident: fixture run.', new Date().toISOString());
  f.platform.startResidentRun({ id: 'paused-run', account_id: account, agent_id: alice.id, permission: 'observe', decisions: 3, minutes: 5, credential_hash: sha(halted.token) });
  f.platform.recordResidentRun('paused-run', { phase: 'model_call', decision: 1, model_calls: 1 });
  f.tx('recoverWorkerJobs');
  f.tx('agentControl', f.actor('alice'), alice.id, 'paused');
  const paused = await call('/residents/resume', {});
  assert.equal(paused.status, 409);
  assert.match(paused.data.error, /Resume this character/);
  f.tx('agentControl', f.actor('alice'), alice.id, 'active');
  // A live, revoked-credential-free resume continues with the remaining budget and a fresh token.
  const resumed = await call('/residents/resume', {});
  assert.equal(resumed.status, 202);
  assert.equal(resumed.data.resumed_from, 'paused-run');
  assert.equal(resumed.data.model_calls, 2);
  assert.equal(resumed.data.minutes, 5);
  assert.equal(resumed.data.permission, 'observe');
  assert.equal(resumed.data.token, undefined);
  const job = await settled(f, resumed.data.job_id);
  assert.equal(job.status, 'completed');
  const successor = f.platform.get('SELECT * FROM resident_runs WHERE id=?', resumed.data.job_id);
  assert.equal(successor.resumed_from, 'paused-run');
  assert.equal(successor.decision_budget, 2);
  assert.equal(successor.credential_hash !== f.platform.get('SELECT credential_hash FROM resident_runs WHERE id=?', 'paused-run').credential_hash, true);
  assert.equal(f.platform.history(f.actor('alice')).runs.filter((run) => run.resumed_from === 'paused-run').length, 1);
  // The interrupted run is consumed: a second resume of the same run is refused.
  assert.equal((await call('/residents/resume', {})).status, 409);
  assert.equal(f.platform.verifyAudit(), true);
});

test('pause and revocation end a running resident and record why', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const { call } = await service(t, f.platform, f.credentials.alice.token, { mayorModel: async () => '{"action":"wait"}' });
  const until = async (test, milliseconds = 8000) => { const deadline = Date.now() + milliseconds; while (Date.now() < deadline) { if (test()) return true; await new Promise((resolve) => setTimeout(resolve, 5)); } return false; };
  // A paused platform stops the run: the next status check is not active, so no further decision is taken.
  const paused = await call('/residents/run', { agent_id: alice.id, minutes: 5, model_calls: 8, permission: 'observe' });
  assert.equal(await until(() => f.platform.get('SELECT model_calls FROM resident_runs WHERE id=?', paused.data.job_id).model_calls >= 1), true);
  f.tx('pause', f.actor('admin'), true);
  const stopped = await settled(f, paused.data.job_id);
  assert.equal(stopped.status, 'stopped');
  const stoppedRun = f.platform.get('SELECT * FROM resident_runs WHERE id=?', paused.data.job_id);
  assert.equal(stoppedRun.status, 'stopped');
  assert.equal(stoppedRun.phase, 'finished');
  assert.equal(stoppedRun.stop_reason, 'revoked_or_expired');
  assert.equal(stoppedRun.model_calls, 1);
  f.tx('pause', f.actor('admin'), false);
  // Revoking the character ends the work too: its credential is refused before the next decision.
  const revoked = await call('/residents/run', { agent_id: alice.id, minutes: 5, model_calls: 8, permission: 'observe' });
  assert.equal(await until(() => f.platform.get('SELECT model_calls FROM resident_runs WHERE id=?', revoked.data.job_id).model_calls >= 1), true);
  f.tx('agentControl', f.actor('alice'), alice.id, 'revoked');
  const ended = await settled(f, revoked.data.job_id);
  assert.equal(ended.status, 'failed');
  const endedRun = f.platform.get('SELECT * FROM resident_runs WHERE id=?', revoked.data.job_id);
  assert.equal(endedRun.stop_reason, 'paused_revoked_or_unavailable');
  assert.equal(endedRun.model_calls, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM tokens WHERE kind=\'runtime\' AND revoked=0').n, 0);
  assert.equal(f.platform.verifyAudit(), true);
});

test('the run-state schema migrates forward and survives a backup round-trip', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), account = f.actor('alice').account.id;
  const session = f.tx('runtime', f.actor('alice'), alice.id, { minutes: 5, max_calls: 40, scopes: ['read'] });
  f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', 'kept-run', alice.id, 'completed', 'Local resident: fixture run.', new Date().toISOString());
  f.platform.startResidentRun({ id: 'kept-run', account_id: account, agent_id: alice.id, permission: 'observe', decisions: 2, minutes: 5, credential_hash: sha(session.token) });
  f.platform.recordResidentRun('kept-run', { status: 'completed', phase: 'finished', stop_reason: 'call_limit', decision: 1, model_calls: 1, action_count: 0 });
  const backup = join(f.directory, 'runs-backup.sqlite');
  backupDatabase(f.platform.db, backup);
  assert.equal(validateDatabase(backup).schema_version, 26);
  f.platform.close();
  // The verified backup restores over the live database and keeps the run receipt and its counters.
  const restored = restoreDatabase(backup, f.database);
  assert.equal(restored.schema_version, 26);
  assert.ok(restored.preserved_original);
  const reopened = new Platform(f.database); t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT decision FROM resident_runs WHERE id=?', 'kept-run').decision, 1);
  assert.equal(reopened.get('SELECT action_count FROM resident_runs WHERE id=?', 'kept-run').action_count, 0);
  assert.equal(reopened.history(reopened.authenticate(f.credentials.alice.token)).runs.length, 1);
  assert.equal(reopened.verifyAudit(), true);
  // The run table is part of the validated schema, not an optional extra.
  reopened.db.exec('DROP TABLE resident_runs');
  assert.throws(() => validateDatabase(f.database), /resident run schema is incomplete/);
});

test('a pre-change database migrates forward to the run-state schema without losing records', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const before = f.platform.history(f.actor('alice')).jobs.length;
  f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', 'legacy-job', alice.id, 'completed', 'A run recorded before the schema change.', new Date().toISOString());
  f.platform.close();
  const legacy = new DatabaseSync(f.database);
  legacy.exec('PRAGMA foreign_keys=OFF; DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE IF EXISTS karma_receipts; DROP TABLE IF EXISTS karma_purchases; DROP TABLE IF EXISTS shop_purchases; DROP TABLE resident_runs; PRAGMA user_version=15');
  legacy.close();
  assert.equal(validateDatabase(f.database).schema_version, 15);
  const migrated = new Platform(f.database); t.after(() => migrated.close());
  assert.equal(migrated.get('PRAGMA user_version').user_version, 26);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM resident_runs').n, 0);
  assert.equal(migrated.get('SELECT status FROM jobs WHERE id=?', 'legacy-job').status, 'completed');
  assert.equal(migrated.history(migrated.authenticate(f.credentials.alice.token)).jobs.length, before + 1);
  assert.equal(validateDatabase(f.database).schema_version, 26);
  assert.equal(migrated.verifyAudit(), true);
});

test('an explicit resume preserves remaining API calls and the original expiry',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),account=f.actor('alice').account.id;
 const token=f.tx('runtime',f.actor('alice'),alice.id,{minutes:5,max_calls:40,scopes:['read']});
 f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)','low-budget',alice.id,'running','Local resident: fixture.',new Date().toISOString());
 f.platform.startResidentRun({id:'low-budget',account_id:account,agent_id:alice.id,permission:'observe',decisions:4,minutes:5,credential_hash:sha(token.token)});
 f.platform.recordResidentRun('low-budget',{phase:'confirmed',decision:1,model_calls:1,action_count:1});
 f.platform.run('UPDATE tokens SET used_calls=38 WHERE hash=?',sha(token.token));f.advance(125000);f.tx('recoverWorkerJobs');
 let observed;const{call}=await service(t,f.platform,f.credentials.alice.token,{mayorModel:async()=>'{"action":"wait"}',residentRunner:async options=>{observed=options;return{status:'completed',model_calls:0,action_count:0};}});
 const result=await call('/residents/resume',{});assert.equal(result.status,202);await settled(f,result.data.job_id);
 const run=f.platform.get('SELECT * FROM resident_runs WHERE id=?',result.data.job_id),credential=f.platform.get('SELECT * FROM tokens WHERE hash=?',run.credential_hash);
 assert.equal(credential.max_calls,2);assert.equal(credential.expires_at,token.expires_at);assert.equal(observed.durationMs,175000);assert.equal(run.decision_budget,3);
});
test('an expired interrupted run requires a new bounded run instead of replenishing time',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),account=f.actor('alice').account.id,token=f.tx('runtime',f.actor('alice'),alice.id,{minutes:1,max_calls:20,scopes:['read']});
 f.platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)','expired-budget',alice.id,'running','Local resident: fixture.',new Date().toISOString());
 f.platform.startResidentRun({id:'expired-budget',account_id:account,agent_id:alice.id,permission:'observe',decisions:2,minutes:1,credential_hash:sha(token.token)});
 f.tx('recoverWorkerJobs');f.advance(61000);assert.throws(()=>f.platform.residentResumePlan(account),/time budget/);
});
