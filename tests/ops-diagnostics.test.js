// Task 27 — the bounded administrator diagnostics surface.
//
// These tests read the real /api/v1/operations response of the shipped server and compare it with the
// database and the process it describes. They also prove the surface is administrator-only, that the
// counters are never invented, that an idle model is distinguishable from a working inference run, and
// that no credential, contact address or private artifact can reach it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { redactDiagnostics } from '../src/recovery.js';

const PASSWORD = 'ops-diagnostics-password-2026';
const SECRET = {
  email: 'diagnostics-secret-contact@rehearsal.invalid',
  password: 'Diagnostics-Secret-Password-2026',
  message: 'DIAGNOSTICS-PRIVATE-MESSAGE-MARKER',
  journal: 'DIAGNOSTICS-PRIVATE-JOURNAL-MARKER',
  artifact: 'DIAGNOSTICS-PRIVATE-ARTIFACT-MARKER',
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (predicate, timeoutMs = 8000) => {
  for (let attempt = 0; attempt * 20 < timeoutMs; attempt++) { if (await predicate()) return true; await sleep(20); }
  return false;
};

async function start(t, options) {
  const app = createApp(options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const call = async (path, token, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { app, base, call };
}

test('the diagnostics surface is administrators only and never public', async (t) => {
  const f = await fixture(t);
  const { call } = await start(t, { platform: f.platform, backupDir: join(f.directory, 'backups') });
  const anonymous = await call('/operations');
  const member = await call('/operations', f.credentials.alice.token);
  const reviewer = await call('/operations', f.credentials.reviewer.token);
  const runtime = f.tx('runtime', f.actor('alice'), f.agent('alice').id, { scopes: ['read'], minutes: 5, max_calls: 10 });
  const agentSession = await call('/operations', runtime.token);
  const admin = await call('/operations', f.credentials.admin.token);
  assert.equal(anonymous.status, 401);
  assert.equal(member.status, 403);
  assert.equal(reviewer.status, 403);
  assert.equal(agentSession.status, 403);
  assert.equal(admin.status, 200);
  assert.ok(admin.data.diagnostics);
  // The public health response keeps only its aggregate counters: no diagnostics block, no account
  // identity, no contact data, no storage path.
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.text.includes('"diagnostics"'), false);
  assert.equal(health.text.includes(f.actor('admin').account.id), false);
  assert.equal(health.text.includes('@'), false);
  assert.deepEqual(Object.keys(health.data).sort(), ['model_configured', 'model_queue', 'research_workers', 'resident_workers', 'status', 'storage']);
  // A role below administrator cannot reach it even through the platform method itself.
  assert.throws(() => f.platform.operations(f.actor('alice')), { status: 403 });
});

test('the dashboard counters are read from the world and the process, never estimated', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  f.tx('travel', f.actor('alice'), agent.id, { world_id: `home:${agent.id}` });
  f.tx('build', f.actor('alice'), agent.id, { type: 'farm', x: 4, y: 8 });
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A diagnostics rehearsal plot', description: 'Fixture.' });
  const backups = join(f.directory, 'backups');
  const { call } = await start(t, { platform: f.platform, backupDir: backups, mayorModel: async () => '{"action":"wait"}' });
  const diagnostics = async () => (await call('/operations', f.credentials.admin.token)).data.diagnostics;

  const before = await diagnostics();
  assert.equal(before.schema.version, 26);
  assert.deepEqual(before.schema.accepted_versions, Array.from({ length: 26 }, (_, index) => index + 1));
  assert.equal(before.integrity.quick_check, 'ok');
  assert.equal(before.integrity.audit_chain_valid, true);
  assert.equal(before.integrity.coin_ledger_valid, true);
  assert.equal(before.records.world_objects, f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n);
  assert.equal(before.records.land_stewardships, 1);
  assert.equal(before.records.accounts, f.platform.get('SELECT COUNT(*) AS n FROM accounts').n);
  assert.equal(before.records.audit_entries, f.platform.get('SELECT MAX(seq) AS n FROM audit').n);
  assert.ok(before.storage.database_bytes >= statSync(f.database).size - 1);
  assert.ok(before.storage.total_bytes >= before.storage.database_bytes);
  assert.ok(before.process.uptime_seconds >= 0 && typeof before.process.started_at === 'string');
  assert.equal(before.backups.count, 0);
  assert.equal(before.recovery.last_backup_at, null);
  assert.equal(before.runs.interrupted, 0);

  const created = await call('/operations/backup', f.credentials.admin.token, {});
  assert.equal(created.status, 201);
  const after = await diagnostics();
  assert.equal(after.backups.count, 1);
  assert.equal(after.backups.latest.filename, created.data.filename);
  assert.equal(after.backups.latest.bytes, statSync(join(backups, created.data.filename)).size);
  assert.equal(after.recovery.last_backup_at, after.backups.latest.created_at);
  assert.equal(after.recovery.schema_version, 26);

  // A run left behind by a dead process is classified by recovery; the dashboard must count it.
  const runId = 'diagnostics-interrupted-run';
  f.tx('startResidentRun', { id: runId, account_id: f.actor('alice').account.id, agent_id: agent.id, permission: 'observe', decisions: 3, minutes: 5, credential_hash: createHash('sha256').update('diagnostics-credential').digest('hex') });
  f.platform.run("INSERT INTO jobs VALUES(?,?,?,'A rehearsal run left behind by a dead process.',?)", runId, agent.id, 'running', new Date().toISOString());
  f.tx('recoverWorkerJobs');
  const recovered = await diagnostics();
  assert.equal(recovered.runs.interrupted, 1);
  assert.equal(recovered.runs.by_interruption.no_action_yet, 1);
  assert.equal(recovered.jobs.interrupted, 1);
  assert.equal(recovered.workers.interrupted, 1);
  assert.equal(recovered.failures.count_24h, 1);
  assert.equal(recovered.failures.recent[0].event, 'resident.run.interrupted');
  assert.ok(recovered.failures.last_at);
  // Only an event name and a time are exposed — never a payload, an actor or a private record.
  assert.deepEqual(Object.keys(recovered.failures.recent[0]).sort(), ['created_at', 'event']);
  assert.deepEqual(f.platform.get('SELECT status FROM jobs WHERE id=?', runId).status, 'interrupted');
});

test('an administrator can distinguish an idle model from a working inference run', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  let open = false, dispatched = 0;
  const model = async () => { dispatched += 1; while (!open) await sleep(5); return '{"action":"wait"}'; };
  const { call } = await start(t, { platform: f.platform, backupDir: join(f.directory, 'backups'), mayorModel: model });
  const diagnostics = async () => (await call('/operations', f.credentials.admin.token)).data.diagnostics;

  const idle = await diagnostics();
  assert.equal(idle.model.configured, true);
  assert.equal(idle.model.state, 'idle');
  assert.equal(idle.model.inference.in_flight, 0);
  assert.match(idle.model.state_note, /idle/i);
  assert.equal(idle.model.since_process_start.started, 0);

  const started = await call('/residents/run', f.credentials.alice.token, { agent_id: agent.id, minutes: 1, model_calls: 1, permission: 'observe' });
  assert.equal(started.status, 202);
  assert.equal(await waitFor(async () => (await diagnostics()).model.inference.in_flight === 1), true);
  const working = await diagnostics();
  assert.equal(working.model.state, 'inferring');
  assert.equal(working.model.inference.in_flight, 1);
  assert.equal(working.model.queue.active, 1);
  assert.ok(working.model.inference.oldest_started_at);
  assert.ok(working.model.inference.elapsed_ms >= 0);
  assert.equal(working.model.since_process_start.started, 1);
  assert.notEqual(working.model.state_note, idle.model.state_note);
  // The run list alone would not tell the administrator this: the working resident is shown here as
  // one active worker, and the inference counters are what prove the model is actually reasoning.
  assert.equal(working.workers.resident.active, 1);
  assert.equal(working.workers.resident.available, 0);

  // A second request while the single resident worker is busy is refused and counted.
  const refused = await call('/residents/run', f.credentials.bob.token, { agent_id: f.agent('bob').id, minutes: 1, model_calls: 1, permission: 'observe' });
  assert.equal(refused.status, 429);
  assert.equal((await diagnostics()).workers.capacity_refusals_since_start, 1);

  open = true;
  assert.equal(await waitFor(async () => f.platform.get('SELECT status FROM jobs WHERE id=?', started.data.job_id).status !== 'running'), true);
  assert.equal(dispatched, 1);
  const finished = await diagnostics();
  assert.equal(finished.model.state, 'idle');
  assert.equal(finished.model.inference.in_flight, 0);
  assert.equal(finished.model.queue.active, 0);
  assert.equal(finished.model.since_process_start.completed, 1);
  assert.equal(finished.model.since_process_start.failed, 0);
  assert.equal(finished.workers.resident.active, 0);
  assert.equal(f.platform.get('SELECT status FROM jobs WHERE id=?', started.data.job_id).status, 'completed');
});

test('no token, password, contact address or private artifact can reach the diagnostics', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const secrets = await f.platform.register({ name: 'Private contact', email: SECRET.email, password: SECRET.password, consent: true });
  const privateActor = f.platform.authenticate(secrets.token);
  const privateAgent = f.tx('createAgent', privateActor, { name: 'Private resident', capabilities: 'Fixture', limitations: 'Fixture' });
  const runtime = f.tx('runtime', privateActor, privateAgent.id, { scopes: ['read'], minutes: 5, max_calls: 10 });
  f.platform.run("INSERT INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,status,created_at,world_id) VALUES('diagnostics-private',NULL,?, 'private',NULL,'[]',?,'visible',?,'commons')", privateActor.account.id, SECRET.message, new Date().toISOString());
  f.tx('writeJournal', f.actor('alice'), { agent_id: agent.id, text: SECRET.journal });
  const mission = f.tx('createMission', f.actor('admin'), { title: 'Diagnostics mission', area: 'Climate', summary: 'Fixture', beneficiary: 'Fixture', owner_id: f.actor('admin').account.id, reviewer_id: f.actor('reviewer').account.id, rubric: 'Fixture rubric.' });
  const task = f.tx('createTask', f.actor('admin'), { mission_id: mission.id, title: 'Fixture task', instructions: 'Fixture', rights: 'Fixture', allowed_domains: ['example.org'] });
  f.tx('missionStatus', f.actor('admin'), mission.id, 'open');
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'diagnostics-claim');
  f.tx('submit', f.actor('alice'), { claim_id: claim.id, artifact: SECRET.artifact, sources: [{ url: 'https://example.org/report', location: 'Section 1' }], method: 'Read the source.', limitations: 'Fixture.', rights: 'Fixture.' }, 'diagnostics-submit');
  const { call } = await start(t, { platform: f.platform, backupDir: join(f.directory, 'backups') });
  const admin = await call('/operations', f.credentials.admin.token);
  assert.equal(admin.status, 200);
  const surface = `${admin.text}\n${(await call('/operations', f.credentials.admin.token)).text}`;
  for (const secret of [SECRET.email, SECRET.password, SECRET.message, SECRET.journal, SECRET.artifact]) {
    assert.equal(surface.includes(secret), false, 'the diagnostics response contains a planted secret');
  }
  for (const credential of [secrets.token, runtime.token, f.credentials.admin.token]) {
    assert.equal(surface.includes(credential), false, 'the diagnostics response contains a credential');
  }
  assert.equal(/\b[0-9a-f]{64}\b/.test(surface), false, 'the diagnostics response contains a hash- or token-shaped value');
  // The stored password digest really is in the database this response describes.
  assert.match(f.platform.get('SELECT password FROM accounts WHERE email=?', SECRET.email).password, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  // The sanitizer that guards the payload, checked directly against a poisoned object.
  const poisoned = redactDiagnostics({ safe: 'uptime', password: SECRET.password, email: SECRET.email, runtime_token: 'e'.repeat(64), nested: { credential_hash: 'd'.repeat(64), stored_password: `${'a'.repeat(32)}:${'b'.repeat(128)}` }, note: `write to ${SECRET.email}` });
  const text = JSON.stringify(poisoned);
  assert.equal(text.includes(SECRET.password), false);
  assert.equal(text.includes(SECRET.email), false);
  assert.equal(text.includes('e'.repeat(64)), false);
  assert.equal(text.includes('d'.repeat(64)), false);
  assert.equal(text.includes('a'.repeat(32)), false);
  assert.equal(text.includes('b'.repeat(64)), false);
  assert.equal(poisoned.safe, 'uptime');
});
