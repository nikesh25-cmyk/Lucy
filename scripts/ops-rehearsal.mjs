#!/usr/bin/env node
// NemoWorld operational failure drills (Task 27).
//
// Every drill runs against a DISPOSABLE installation: a private temporary workspace with its own
// SQLite database, its own backups directory and its own server process. The shipped data directory,
// any world already running on this machine, installed accounts, credentials and model weights are
// never opened. Nothing here is a simulation of a result: a drill either performs the real operation
// and reports what happened, or it fails.
//
// Run it with:  node scripts/ops-rehearsal.mjs            # every drill, JSON report on stdout
//               node scripts/ops-rehearsal.mjs --keep     # keep the workspace for inspection
//               node scripts/ops-rehearsal.mjs --drill corrupt-backup
//
// The tests in tests/ops-rehearsal.test.js call runOpsRehearsal() directly and re-check the
// databases and files it leaves behind, so the script and the suite cannot drift apart.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { boundedModel } from '../runtime/model.js';
import { verifyCoinLedger } from '../src/coins.js';
import { backupDatabase, restoreDatabase, validateDatabase, storageUsage, redactDiagnostics } from '../src/recovery.js';

const PASSWORD = 'ops-rehearsal-password-2026';
// Planted private data. Every drill that seeds it also greps the produced diagnostics for it.
export const PLANTED = Object.freeze({
  email: 'ops-secret-contact@rehearsal.invalid',
  password: 'Ops-Rehearsal-Secret-Password-2026',
  message: 'PRIVATE-MESSAGE-MARKER-OPS-7121',
  journal: 'PRIVATE-JOURNAL-MARKER-OPS-7121',
  artifact: 'PRIVATE-ARTIFACT-MARKER-OPS-7121',
  journalOwner: 'jane.private@rehearsal.invalid',
});
const TRACKED = ['accounts', 'agents', 'world_objects', 'land_stewardships', 'land_events', 'coin_rewards', 'quest_enrollments', 'guild_projects', 'guild_participants', 'guild_contributions', 'audit'];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const check = (checks, name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); return Boolean(ok); };
const allPassed = (checks) => checks.every((entry) => entry.ok);
const refused = (action) => { try { action(); return null; } catch (error) { return error; } };
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
// The durable records a recovery must preserve. The audit chain is checked separately: recovery
// appends its own honest event, so its length is expected to grow by exactly that event.
const RECORDS = TRACKED.filter((table) => table !== 'audit');
const countsFor = (platform) => Object.fromEntries(TRACKED.map((table) => [table, platform.get(`SELECT COUNT(*) AS n FROM ${table}`).n]));
const countsMatch = (left, right, tables = TRACKED) => tables.every((table) => left[table] === right[table]);
const describeCounts = (values) => TRACKED.filter((table) => values[table]).map((table) => `${table}=${values[table]}`).join(' ') || 'no tracked rows';
const backupName = (stamp, digit) => `world-${stamp}-${String(digit).repeat(8)}-1111-2222-3333-444444444444.sqlite`;

// One disposable installation with the five record groups the recovery drill must preserve: a saved
// garden object (world), a stewarded plot (land), one independently reviewed contribution (coins),
// one quest enrollment, and a verified guild contribution. Only alice's token is ever handed to a
// child process; no drill writes a token into its report.
async function seedDisposableWorld(directory, { plantSecrets = false } = {}) {
  const database = join(directory, 'world.sqlite');
  const platform = new Platform(database);
  const tx = (method, ...args) => platform.transaction(() => platform[method](...args));
  const accounts = {};
  accounts.admin = await platform.register({ name: 'Rehearsal administrator', email: 'ops-admin@rehearsal.invalid', password: PASSWORD, consent: true });
  const actor = (name) => platform.authenticate(accounts[name].token);
  for (const [name, role] of [['alice', 'member'], ['bob', 'member'], ['reviewer', 'reviewer']]) {
    const invite = tx('invite', actor('admin'), { role });
    accounts[name] = await platform.register({ name: `Rehearsal ${name}`, email: `${name}@rehearsal.invalid`, password: PASSWORD, consent: true, invite: invite.code });
  }
  const agent = (name) => tx('createAgent', actor(name), { name: `Rehearsal ${name} resident`, capabilities: 'Read approved public sources', limitations: 'Requires human review', color: '#397f79', symbol: '✦' });
  const aliceAgent = agent('alice'), bobAgent = agent('bob');

  // World: one saved object in alice's own garden. The resident walks into its garden first, because
  // building is only permitted inside the garden or cottage that character owns.
  tx('travel', actor('alice'), aliceAgent.id, { world_id: `home:${aliceAgent.id}` });
  tx('build', actor('alice'), aliceAgent.id, { type: 'farm', x: 4, y: 8 });
  // Land: the human steward of one canonical plot.
  tx('landAssign', actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A rehearsal learning garden', description: 'An isolated fixture used only by the operational drills.' });
  // Coins: one contribution accepted by an independent reviewer.
  const mission = tx('createMission', actor('admin'), { title: 'Rehearsal verified mission', area: 'Climate', summary: 'Exercise an evidence contribution from claim through independent acceptance.', beneficiary: 'Rehearsal community', owner_id: actor('admin').account.id, reviewer_id: actor('reviewer').account.id, rubric: 'Check exact original sources, rights, uncertainty and attribution.' });
  const task = tx('createTask', actor('admin'), { mission_id: mission.id, title: 'Record one source', instructions: 'Provide attribution, location, rights and uncertainty.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] });
  tx('missionStatus', actor('admin'), mission.id, 'open');
  const claim = tx('claim', actor('alice'), { task_id: task.id, agent_id: aliceAgent.id }, 'rehearsal-claim');
  const submission = tx('submit', actor('alice'), { claim_id: claim.id, artifact: plantSecrets ? `Attributed register entry. ${PLANTED.artifact}` : 'An attributed plain text register entry.', sources: [{ url: 'https://example.org/report', location: 'Section 2, paragraph 3', date: '2026-01-01' }], method: 'Read the original source and recorded the exact supporting section.', limitations: 'A rehearsal fixture; facts and rights require human verification.', rights: 'Permission and attribution were checked for this fixture.' }, 'rehearsal-submit');
  const review = tx('review', actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent rehearsal source review' });
  if (review.coin_reward?.amount !== 10) throw new Error('The rehearsal coin receipt was not issued as expected.');
  // Quests: one enrollment in the shipped practice chain.
  tx('questJoin', actor('alice'), { agent_id: aliceAgent.id, chain_id: 'quiet-harvest' }, 'rehearsal-quest-key');
  // Guilds: one planned workstream, pledged, submitted and verified by a different operator.
  const project = tx('guildProjectCreate', actor('alice'), { agent_id: aliceAgent.id, guild_id: 'cultivator', title: 'Rehearsal soil survey', summary: 'A scoped, peaceful rehearsal workstream.', visibility: 'public', plan: [{ id: 'soil-survey', title: 'Survey one garden row', output_name: 'One written soil observation', scope: 'One garden row inside the creating resident’s own garden.' }] });
  tx('guildContribution', actor('alice'), { agent_id: aliceAgent.id, project_id: project.id, workstream_id: 'soil-survey', action: 'pledge', commitment: 'Record one soil observation from one garden row.' });
  tx('guildContribution', actor('alice'), { agent_id: aliceAgent.id, project_id: project.id, workstream_id: 'soil-survey', action: 'submit', evidence: 'One written observation of the first row, recorded on the day of the reading.', sources: [{ url: 'https://example.org/soil', location: 'Methods' }] });
  const contribution = platform.get('SELECT id FROM guild_contributions WHERE project_id=?', project.id);
  tx('guildVerify', actor('bob'), { agent_id: bobAgent.id, project_id: project.id, contribution_id: contribution.id, action: 'approve', reason: 'Independent rehearsal verification' });
  // Two gatherings so a killed resident always has a fresh action to confirm.
  const schedule = (days) => ({ starts_at: new Date(Date.now() + days * 3600000).toISOString(), ends_at: new Date(Date.now() + (days + 1) * 3600000).toISOString() });
  const eventForAlice = tx('createEvent', actor('bob'), { agent_id: bobAgent.id, title: 'Rehearsal gathering hosted by Bob', summary: 'A fictional rehearsal gathering.', capacity: 4, world_id: 'commons', ...schedule(2) });
  const eventForBob = tx('createEvent', actor('alice'), { agent_id: aliceAgent.id, title: 'Rehearsal gathering hosted by Alice', summary: 'A fictional rehearsal gathering.', capacity: 4, world_id: 'commons', ...schedule(3) });

  const credentials = [];
  if (plantSecrets) {
    // Private data that must never reach a diagnostics response or a log: a private conversation, a
    // private journal entry, a contact address, a password and both kinds of credential.
    const secrets = await platform.register({ name: 'Rehearsal private contact', email: PLANTED.email, password: PLANTED.password, consent: true });
    const privateActor = platform.authenticate(secrets.token);
    const privateAgent = tx('createAgent', privateActor, { name: 'Rehearsal private resident', capabilities: 'Fixture only', limitations: 'Fixture only' });
    const runtime = tx('runtime', privateActor, privateAgent.id, { scopes: ['read'], minutes: 5, max_calls: 10 });
    platform.run('INSERT INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,status,created_at,world_id) VALUES(?,?,?,?,?,?,?,?,?,?)', 'rehearsal-private-message', privateAgent.id, privateActor.account.id, 'private', null, '[]', PLANTED.message, 'visible', new Date().toISOString(), 'commons');
    tx('writeJournal', actor('alice'), { agent_id: aliceAgent.id, text: PLANTED.journal });
    credentials.push(secrets.token, runtime.token);
  }
  const ids = { aliceAgent: aliceAgent.id, bobAgent: bobAgent.id, eventForAlice: eventForAlice.id, eventForBob: eventForBob.id, submission: submission.id, project: project.id, contribution: contribution.id, plot: 'plot:0:0:5:5' };
  return { platform, database, ids, accounts, actor, plantedCredentials: credentials };
}

// ---- Drill: the recovery point and what a restore preserves ------------------------------------
async function drillRecoveryPoint(directory) {
  const checks = [];
  const seeded = await seedDisposableWorld(directory);
  const { platform, database, ids } = seeded;
  const backups = join(directory, 'backups');
  const backup = join(backups, backupName(1700000000000, 1));
  const before = countsFor(platform);
  const written = backupDatabase(platform.db, backup);
  check(checks, 'a verified backup is written beside the world', validateDatabase(backup).schema_version === 25 && written.path === backup, `${describeCounts(before)} · ${statSync(backup).size} bytes · mode ${(statSync(backup).mode & 0o777).toString(8)}`);
  // Everything after this line happened after the backup and must be lost by a restore.
  platform.transaction(() => platform.build(seeded.actor('alice'), ids.aliceAgent, { type: 'flowers', x: 5, y: 8 }));
  platform.transaction(() => platform.run("INSERT INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,status,created_at,world_id) VALUES('post-backup-write',NULL,?, 'public',NULL,'[]','A message written after the backup.','visible',?,'commons')", seeded.actor('alice').account.id, new Date().toISOString()));
  const afterMutation = countsFor(platform);
  platform.close();

  const restored = restoreDatabase(backup, database);
  const reopened = new Platform(database);
  const counts = countsFor(reopened);
  try {
    check(checks, 'a restore replaces the world atomically and keeps the previous bytes', Boolean(restored.preserved_original) && existsSync(restored.preserved_original), `preserved_original=${Boolean(restored.preserved_original)}`);
    check(checks, 'the restored world is schema 25 and passes full validation', validateDatabase(database).schema_version === 25);
    check(checks, 'work committed after the backup is gone', afterMutation.world_objects > before.world_objects && reopened.get("SELECT COUNT(*) AS n FROM world_objects WHERE x=5 AND y=8").n === 0, `before=${describeCounts(before)} after=${describeCounts(afterMutation)} restored=${describeCounts(counts)}`);
    check(checks, 'every world, land, coin, quest and guild record is preserved', countsMatch(before, counts), describeCounts(counts));
    check(checks, 'the audit chain still verifies after the restore', reopened.verifyAudit());
    check(checks, 'the coin ledger still verifies after the restore', verifyCoinLedger(reopened.db));
    check(checks, 'the coin, quest and guild records keep their exact identity and state',
      reopened.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', ids.submission).n === 1
      && reopened.get('SELECT COUNT(*) AS n FROM quest_enrollments e JOIN quest_chains c ON c.id=e.chain_id WHERE c.slug=?', 'quiet-harvest').n === 1
      && reopened.get("SELECT COUNT(*) AS n FROM guild_contributions WHERE project_id=? AND status='verified'", ids.project).n === 1
      && reopened.get('SELECT plot_id FROM land_stewardships').plot_id === ids.plot);
    check(checks, 'the file-level integrity check reports ok', reopened.integrity().quick_check === 'ok', JSON.stringify(reopened.integrity()));
  } finally { reopened.close(); }
  return { ok: allPassed(checks), checks, detail: `Measured recovery point: the backup file is the last committed transaction before the copy; the post-backup write was correctly lost. ${describeCounts(counts)}.` };
}

// ---- Drill: an invalid backup must fail closed --------------------------------------------------
async function drillCorruptBackup(directory) {
  const checks = [];
  const seeded = await seedDisposableWorld(directory);
  const { platform, database } = seeded;
  const backups = join(directory, 'backups');
  const good = join(backups, backupName(1700000001000, 2));
  backupDatabase(platform.db, good);
  const digest = sha256File(database), counts = countsFor(platform);
  const bytes = readFileSync(good);

  const garbage = join(directory, 'garbage.sqlite');
  const garbageBytes = Buffer.from(bytes); garbageBytes.write('not-a-sqlite-database-file', 0, 'utf8');
  writeFileSync(garbage, garbageBytes, { mode: 0o600 });
  const damaged = join(directory, 'damaged.sqlite');
  const damagedBytes = Buffer.from(bytes);
  const from = Math.floor(damagedBytes.length * 0.4), to = Math.floor(damagedBytes.length * 0.9);
  damagedBytes.fill(0xff, from, to);
  writeFileSync(damaged, damagedBytes, { mode: 0o600 });
  const truncated = join(directory, 'truncated.sqlite');
  writeFileSync(truncated, Buffer.alloc(0), { mode: 0o600 });
  const foreign = join(directory, 'foreign.sqlite');
  const foreignDb = new DatabaseSync(foreign); foreignDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE unrelated(a TEXT)'); foreignDb.close();

  for (const [label, path] of [['a file that is not a database', garbage], ['a backup whose pages are damaged', damaged], ['an empty file', truncated], ['a valid database that is not NemoWorld', foreign]]) {
    const validation = refused(() => validateDatabase(path));
    check(checks, `${label} is refused by validation`, Boolean(validation), validation ? validation.message : 'validation unexpectedly accepted it');
    const restore = refused(() => restoreDatabase(path, database));
    check(checks, `restoring ${label} is refused`, Boolean(restore), restore ? restore.message : 'the restore unexpectedly succeeded');
  }
  check(checks, 'the live world was never touched by the refusals', sha256File(database) === digest && validateDatabase(database).schema_version === 25 && countsMatch(counts, countsFor(platform)));
  check(checks, 'no partial restore file was left behind', readdirSync(directory).every((name) => !name.includes('.restore-')), readdirSync(directory).join(', '));
  const recovery = restoreDatabase(good, database);
  const reopened = new Platform(database);
  try {
    check(checks, 'failing closed does not damage the recovery path: the good backup still restores', recovery.schema_version === 25 && countsMatch(counts, countsFor(reopened)) && reopened.verifyAudit());
  } finally { reopened.close(); platform.close(); }
  return { ok: allPassed(checks), checks, detail: `Four invalid backups were refused before any file was touched; the live world stayed byte-identical (sha256 ${digest.slice(0, 12)}…) and the valid backup restored afterwards.` };
}

// ---- Drill: schema-migration rehearsal ----------------------------------------------------------
async function drillMigrationRehearsal(directory) {
  const checks = [];
  const seeded = await seedDisposableWorld(directory);
  const { platform, database } = seeded;
  const before = countsFor(platform);
  platform.close();
  // Recreate a schema 17 world by removing the additive guild layer, exactly as a database written
  // before Task 06 looks. Nothing else is changed.
  const legacy = new DatabaseSync(database);
  legacy.exec('PRAGMA foreign_keys=OFF; DROP TABLE guild_contributions; DROP TABLE guild_participants; DROP TABLE guild_projects; PRAGMA user_version=17;');
  legacy.close();
  const beforeDowngrade = validateDatabase(database);
  check(checks, 'the rehearsal fixture validates as schema 17', beforeDowngrade.schema_version === 17, JSON.stringify(beforeDowngrade));
  const source = join(directory, 'backups', backupName(1700000002000, 3));
  const sourceDb = new DatabaseSync(database);
  try { backupDatabase(sourceDb, source); } finally { sourceDb.close(); }
  check(checks, 'a schema 17 backup is accepted and preserved', validateDatabase(source).schema_version === 17);

  const target = join(directory, 'migrated', 'world.sqlite');
  const restored = restoreDatabase(source, target);
  check(checks, 'the schema 17 backup restores into a clean path', restored.schema_version === 17 && validateDatabase(target).schema_version === 17);
  const upgraded = new Platform(target);
  try {
    const after = countsFor(upgraded);
    check(checks, 'opening the restored world migrates it to schema 25', validateDatabase(target).schema_version === 25);
    check(checks, 'the migration is additive: no world, land, coin or quest record changed',
      ['world_objects', 'land_stewardships', 'land_events', 'coin_rewards', 'quest_enrollments', 'accounts', 'agents', 'audit'].every((table) => before[table] === after[table]),
      `before=${describeCounts(before)} after=${describeCounts(after)}`);
    check(checks, 'the migrated world recreates the guild layer empty rather than inventing rows', after.guild_projects === 0 && after.guild_contributions === 0 && after.guild_participants === 0);
    check(checks, 'the migrated world still verifies its audit chain and coin ledger', upgraded.verifyAudit() && verifyCoinLedger(upgraded.db));
    check(checks, 'the pre-migration backup is still restorable afterwards', validateDatabase(source).schema_version === 17);
    const memberActor = upgraded.authenticate(seeded.accounts.alice.token);
    check(checks, 'a role below administrator cannot read the operational diagnostics', refused(() => upgraded.operations(memberActor))?.status === 403);
  } finally { upgraded.close(); }
  return { ok: allPassed(checks), checks, detail: `Schema 17 → 22 rehearsal on a disposable copy: ${describeCounts(countsFor(new Platform(target)))}.` };
}

// ---- Drill: interrupted worker recovery ---------------------------------------------------------
const rsvpCount = (platform, agentId) => platform.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE agent_id=?', agentId).n;
function crashChild(args, timeoutMs = 40000) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ signal: 'timeout', output }); }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}
// The child process: a real bounded resident run over real HTTP, killed with SIGKILL at a chosen
// durable state. SIGKILL cannot be caught, so no cleanup, receipt or credential revocation runs.
async function runInterruptedWorkerChild(mode, database, token, agentId, eventId) {
  let decisions = 0;
  const model = async () => (decisions++ === 0 ? JSON.stringify({ action: 'rsvp', event_id: eventId, intent: 'join' }) : new Promise(() => {}));
  const platform = new Platform(database);
  const app = createApp({ platform, mayorModel: model });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${url}/api/v1/residents/run`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agentId, minutes: 5, model_calls: 3, permission: 'creative' }) });
  const started = await response.json();
  if (response.status !== 202) throw new Error(`The drill resident run was refused: ${response.status} ${JSON.stringify(started)}`);
  process.stdout.write(`worker ${started.job_id} started\n`);
  for (let attempt = 0; attempt < 8000; attempt++) {
    const run = platform.get('SELECT * FROM resident_runs WHERE id=?', started.job_id);
    const reached = mode === 'confirmed' ? run?.phase === 'confirmed' && run.action_count === 1 : run?.phase === 'model_call' && run.model_calls === 2;
    if (reached) process.kill(process.pid, 'SIGKILL');
    await sleep(2);
  }
  throw new Error('The run never reached the chosen durable state.');
}
async function interruptedWorkerCase(checks, directory, mode, owner, expectedClass, expectedDetail) {
  const seeded = await seedDisposableWorld(directory);
  const { database, ids, accounts } = seeded;
  const before = countsFor(seeded.platform);
  // Each waiting resident joins the gathering hosted by the other operator, so the action it confirms
  // is a fresh RSVP rather than the one the host already holds.
  const workerAgent = ids[`${owner}Agent`], event = owner === 'alice' ? ids.eventForAlice : ids.eventForBob;
  const beforeRsvps = rsvpCount(seeded.platform, workerAgent);
  seeded.platform.close();
  const crashed = await crashChild([fileURLToPath(import.meta.url), '--child', mode, database, accounts[owner].token, workerAgent, event]);
  check(checks, `${mode}: the worker process was killed without cleanup`, crashed.signal === 'SIGKILL', `signal=${crashed.signal} code=${crashed.code} output=${crashed.output.trim().slice(0, 120)}`);

  const platform = new Platform(database);
  const recovered = platform.get('SELECT * FROM resident_runs ORDER BY started_at DESC LIMIT 1');
  check(checks, `${mode}: the interrupted run is classified from its last durable write`, recovered.status === 'interrupted' && recovered.interrupted === expectedClass && recovered.stop_reason === 'process_restart', `status=${recovered.status} interrupted=${recovered.interrupted} stop_reason=${recovered.stop_reason}`);
  const job = platform.get('SELECT * FROM jobs WHERE id=?', recovered.id);
  check(checks, `${mode}: the job is marked interrupted with an actionable explanation`, job.status === 'interrupted' && expectedDetail.test(job.detail), job.detail);
  check(checks, `${mode}: the orphaned runtime credential is revoked`, platform.get('SELECT revoked FROM tokens WHERE hash=?', recovered.credential_hash).revoked === 1);
  check(checks, `${mode}: the recorded counters are the real ones`, recovered.model_calls === (mode === 'confirmed' ? 1 : 2) && recovered.action_count === 1, `model_calls=${recovered.model_calls} action_count=${recovered.action_count} failed_actions=${recovered.failed_actions}`);
  check(checks, `${mode}: the action the server confirmed before the crash is recorded exactly once`, rsvpCount(platform, workerAgent) === beforeRsvps + 1, `${beforeRsvps} → ${rsvpCount(platform, workerAgent)}`);
  const after = countsFor(platform);
  check(checks, `${mode}: every world, land, coin, quest and guild record survived the crash`, countsMatch(before, after, RECORDS), describeCounts(after));
  check(checks, `${mode}: recovery recorded exactly one honest interruption event and the world recorded one RSVP`,
    platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='resident.run.interrupted'").n === 1
    && platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='event.rsvp'").n === 1
    && after.audit > before.audit, `audit ${before.audit} → ${after.audit}`);
  check(checks, `${mode}: the world is still valid and the audit chain still verifies`, validateDatabase(database).schema_version === 25 && platform.verifyAudit());

  const app = createApp({ platform, mayorModel: async () => '{"action":"wait"}' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const call = async (path) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1${path}`, { method: 'POST', headers: { Authorization: `Bearer ${accounts[owner].token}`, 'Content-Type': 'application/json' }, body: '{}' }); return { status: response.status, data: await response.json() }; };
  try {
    const resumed = await call('/residents/resume');
    check(checks, `${mode}: resuming is an explicit action with the remaining budget and fresh credentials`, resumed.status === 202 && resumed.data.resumed_from === recovered.id && resumed.data.job_id !== recovered.id, JSON.stringify(resumed.data));
    for (let attempt = 0; attempt < 400 && platform.get('SELECT status FROM jobs WHERE id=?', resumed.data.job_id).status === 'running'; attempt++) await sleep(20);
    check(checks, `${mode}: the resumed run finishes and never repeats the recorded action`, platform.get('SELECT status FROM jobs WHERE id=?', resumed.data.job_id).status === 'completed' && rsvpCount(platform, workerAgent) === beforeRsvps + 1, `${beforeRsvps} → ${rsvpCount(platform, workerAgent)}`);
    check(checks, `${mode}: a second resume is refused`, (await call('/residents/resume')).status === 409);
  } finally {
    await app.stopWorkers();
    await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
    platform.close();
  }
}
async function drillInterruptedWorker(directory) {
  const checks = [];
  await interruptedWorkerCase(checks, join(directory, 'after-confirmed-action'), 'confirmed', 'alice', 'action_confirmed', /last confirmed action is recorded/);
  await interruptedWorkerCase(checks, join(directory, 'during-model-call'), 'model_call', 'bob', 'model_call_in_flight', /while a model call was in flight/);
  return { ok: allPassed(checks), checks, detail: 'Two SIGKILL interruptions (after a confirmed action and inside a model call) were classified from durable state, their credentials were revoked, nothing was replayed and each was resumed explicitly.' };
}

// ---- Drill: bounded model-queue saturation ------------------------------------------------------
const ambassadorAnswer = '{"answer":"National indicators are context only. Register a proposal with a named owner and an independent reviewer before the work is used.","sources":[]}';
async function drillModelQueueSaturation(directory) {
  const checks = [];
  const seeded = await seedDisposableWorld(directory);
  const platform = seeded.platform;
  // The queue mechanism itself, proved at its own boundary: one inference at a time, two waiting,
  // the next refused rather than queued, an abort removing a waiting entry and order preserved.
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bounded = boundedModel(async ({ prompt }) => { order.push(prompt); await gate; return prompt; }, { maxWaiting: 2 });
  const waitFor = async (predicate) => { for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await sleep(5); };
  const first = bounded({ prompt: 'first' });
  await waitFor(() => bounded.status().active === 1);
  const controller = new AbortController();
  const cancelled = bounded({ prompt: 'cancelled', signal: controller.signal }).then(() => null, (error) => error);
  await waitFor(() => bounded.status().waiting === 1);
  controller.abort();
  check(checks, 'an aborted request leaves the queue instead of holding a slot', Boolean(await cancelled) && /abort/i.test((await cancelled)?.name || (await cancelled)?.message || 'abort') && bounded.status().waiting === 0, JSON.stringify(bounded.status()));
  const third = bounded({ prompt: 'third' }), fourth = bounded({ prompt: 'fourth' });
  await waitFor(() => bounded.status().waiting === 2);
  const saturated = bounded.status();
  check(checks, 'the queue holds one inference and only the configured number of waiters', saturated.active === 1 && saturated.waiting === 2 && saturated.max_waiting === 2, JSON.stringify(saturated));
  const overflow = await bounded({ prompt: 'overflow' }).then(() => null, (error) => error);
  check(checks, 'work beyond the bound is refused instead of queued', overflow instanceof Error && /busy/i.test(overflow.message), overflow?.message || 'accepted');
  release();
  const answers = await Promise.all([first, third, fourth]);
  check(checks, 'released work runs in the order it was accepted and the queue drains', answers.join(',') === 'first,third,fourth' && order.join(',') === 'first,third,fourth' && bounded.status().active === 0 && bounded.status().waiting === 0, `${answers.join(',')} / ${JSON.stringify(bounded.status())}`);

  // The same bound inside the shipped server, over real HTTP. Two conversations are accepted and one
  // is refused; the refused request answers from the published rules instead of hanging, and the
  // administrator dashboard is what makes that visible.
  const gate2 = { open: false, waiters: [] };
  const app = createApp({ platform, modelQueueWait: 1, mayorModel: async () => { while (!gate2.open) await sleep(5); return ambassadorAnswer; } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const extra = {};
  for (const name of ['quiet-one', 'quiet-two']) {
    const invite = platform.transaction(() => platform.invite(seeded.actor('admin'), { role: 'member' }));
    extra[name] = await platform.register({ name, email: `${name}@rehearsal.invalid`, password: PASSWORD, consent: true, invite: invite.code });
  }
  const talk = (token) => fetch(`${base}/ambassadors/talk`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ambassador_id: seeded.platform.get("SELECT id FROM npc_ambassadors WHERE status='active' LIMIT 1").id, question: 'What should a researcher check before starting a country study?' }) }).then(async (response) => ({ status: response.status, data: await response.json() }));
  const diagnostics = async () => (await (await fetch(`${base}/operations`, { headers: { Authorization: `Bearer ${seeded.accounts.admin.token}` } })).json()).diagnostics;
  try {
    const working = [talk(extra['quiet-one'].token), talk(extra['quiet-two'].token), talk(seeded.accounts.alice.token)];
    for (let attempt = 0; attempt < 400 && (await diagnostics()).model.queue.waiting < 1; attempt++) await sleep(10);
    const busy = await diagnostics();
    check(checks, 'the running server reports a working inference and a queued request', busy.model.state === 'inferring_with_queue' && busy.model.inference.in_flight === 1 && busy.model.queue.waiting === 1 && busy.model.queue.full === true, JSON.stringify(busy.model));
    gate2.open = true;
    const answers = await Promise.all(working);
    check(checks, 'the refused request degrades to the published rules instead of queueing without bound', answers.filter((entry) => entry.data.model_fallback === true).length === 1 && answers.every((entry) => entry.status === 200), answers.map((entry) => `${entry.status}:${entry.data.model_fallback ? 'rules-fallback' : entry.data.mode || 'unknown'}`).join(' '));
    check(checks, 'the saturation refusal is counted, not hidden', (await diagnostics()).model.since_process_start.rejected_saturated === 1);
    for (let attempt = 0; attempt < 400 && (await diagnostics()).model.inference.in_flight > 0; attempt++) await sleep(10);
    const idle = await diagnostics();
    check(checks, 'once the work finishes the dashboard reports an idle model', idle.model.state === 'idle' && idle.model.inference.in_flight === 0 && idle.model.queue.waiting === 0 && idle.model.since_process_start.completed === 2, JSON.stringify(idle.model));
    check(checks, 'an administrator can tell an idle model from a working run by the inference counters, not by the run list', typeof idle.model.state_note === 'string' && idle.model.state_note.length > 0 && idle.workers.resident.active === 0);
  } finally {
    await app.stopWorkers();
    await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
    platform.close();
  }
  return { ok: allPassed(checks), checks, detail: 'The local model queue refused work beyond its bound at its own boundary and inside the shipped server, where the refused request fell back to published rules and the refusal was counted.' };
}

// ---- Drill: storage limits ----------------------------------------------------------------------
async function drillStorageLimit(directory) {
  const checks = [];
  const seeded = await seedDisposableWorld(directory);
  const { platform, database } = seeded;
  const before = countsFor(platform);
  // A full disk: the page limit is set to the current page count so any write that needs a new page
  // fails, exactly as SQLITE_FULL does when the volume has no free space left.
  const pages = platform.get('PRAGMA page_count').page_count;
  platform.run(`PRAGMA max_page_count=${pages}`);
  const failure = refused(() => platform.transaction(() => platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', 'storage-limit-drill', null, 'failed', 'x'.repeat(200000), new Date().toISOString())));
  check(checks, 'a write that needs new space fails with an actionable storage error', Boolean(failure) && /full/i.test(failure.message), failure?.message || 'the write unexpectedly succeeded');
  platform.run('PRAGMA max_page_count=2000000000');
  check(checks, 'the failed write left nothing behind', countsMatch(before, countsFor(platform)));
  check(checks, 'the world is still valid and its audit chain still verifies after the storage failure', validateDatabase(database).schema_version === 25 && platform.verifyAudit() && platform.integrity().quick_check === 'ok');
  platform.transaction(() => platform.audit('system', 'rehearsal.storage.recovered'));
  check(checks, 'the world accepts writes again once space is available', platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='rehearsal.storage.recovered'").n === 1);

  // A backup destination that cannot be written must fail closed and leave no partial file.
  const locked = join(directory, 'locked-backups');
  mkdirSync(locked, { recursive: true, mode: 0o500 });
  const target = join(locked, backupName(1700000003000, 4));
  const backupFailure = refused(() => backupDatabase(platform.db, target));
  const unwritable = process.getuid?.() === 0 || Boolean(backupFailure);
  check(checks, 'a backup into an unwritable directory fails instead of producing an unusable file', unwritable && !existsSync(target), backupFailure ? backupFailure.message : 'running as root: permission checks do not apply');
  check(checks, 'the failed backup left no partial file', readdirSync(locked).length === 0, readdirSync(locked).join(', '));
  const good = join(directory, 'backups', backupName(1700000004000, 5));
  backupDatabase(platform.db, good);
  check(checks, 'the world can still be backed up into a writable location afterwards', validateDatabase(good).schema_version === 25);
  const usage = storageUsage(database);
  check(checks, 'storage usage is measured, not guessed', usage.database_bytes > 0 && usage.total_bytes >= usage.database_bytes, JSON.stringify(usage));
  platform.close();
  return { ok: allPassed(checks), checks, detail: `Storage failure drills: ${JSON.stringify(usage)}. The world stayed valid and writable after both failures.` };
}

// ---- Drill: diagnostics redaction and administrator-only access ---------------------------------
async function drillDiagnosticsRedaction(directory) {
  const checks = [];
  const seeded = await seedDisposableWorld(directory, { plantSecrets: true });
  const platform = seeded.platform;
  const app = createApp({ platform, backupDir: join(directory, 'backups'), mayorModel: async () => '{"action":"wait"}' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const get = async (path, token) => { const response = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: response.status, text: await response.text() }; };
  try {
    const health = await get('/health');
    const anonymous = await get('/operations');
    const member = await get('/operations', seeded.accounts.alice.token);
    const runtimeSource = `HEAD /operations HTTP/1.1`; void runtimeSource;
    const admin = await get('/operations', seeded.accounts.admin.token);
    check(checks, 'the diagnostics payload is served to an administrator', admin.status === 200 && admin.text.includes('"diagnostics"'), `status=${admin.status} bytes=${admin.text.length}`);
    check(checks, 'the same payload is refused to an anonymous request and to a member', anonymous.status === 401 && member.status === 403, `anonymous=${anonymous.status} member=${member.status}`);
    check(checks, 'the public health endpoint carries no diagnostics, no account and no contact data', health.status === 200 && !health.text.includes('"diagnostics"') && !health.text.includes(PLANTED.email) && !/@"|rehearsal\.invalid/.test(health.text), health.text.slice(0, 160));
    const surface = `${admin.text}\n${health.text}`;
    const leaked = [PLANTED.email, PLANTED.password, PLANTED.message, PLANTED.journal, PLANTED.artifact, PLANTED.journalOwner].filter((secret) => surface.includes(secret));
    check(checks, 'no token, password, contact address or private artifact appears in the diagnostics', leaked.length === 0, leaked.length ? `leaked: ${leaked.length} planted value(s)` : 'all planted values absent');
    const tokenLeak = [...seeded.plantedCredentials, seeded.accounts.admin.token, seeded.accounts.alice.token].filter((token) => surface.includes(token));
    check(checks, 'no session or runtime credential appears in the diagnostics', tokenLeak.length === 0, tokenLeak.length ? `${tokenLeak.length} credential(s) present` : 'every issued credential absent');
    // The sanitizer itself, proved against a deliberately poisoned payload.
    const poisoned = redactDiagnostics({ password: 'hunter2-hunter2', email: PLANTED.email, runtime_token: 'f'.repeat(64), nested: { credential_hash: 'a'.repeat(64), stored_password: `${'b'.repeat(32)}:${'c'.repeat(128)}` }, safe: 'uptime', note: `contact ${PLANTED.email} for keys` });
    const poisonedText = JSON.stringify(poisoned);
    check(checks, 'the diagnostics sanitizer drops secret-named fields and secret-shaped values', !poisonedText.includes('hunter2') && !poisonedText.includes(PLANTED.email) && !poisonedText.includes('f'.repeat(64)) && poisoned.safe === 'uptime', poisonedText.slice(0, 200));
    const artifacts = { operations: join(directory, 'diagnostics.json'), health: join(directory, 'health.json') };
    writeFileSync(artifacts.operations, admin.text, { mode: 0o600 });
    writeFileSync(artifacts.health, health.text, { mode: 0o600 });
    return { ok: allPassed(checks), checks, detail: 'The administrator diagnostics response was written for inspection; every planted secret, contact address and private artifact marker was absent from it.', artifacts };
  } finally {
    await app.stopWorkers();
    await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
    platform.close();
  }
}

// ---- Drill: independent moderation, appeal, revoked runtime and a durable platform pause --------
async function drillSafetyAndPause(directory) {
  const checks = [];
  const seeded = await seedDisposableWorld(directory);
  let { platform } = seeded;
  const tx = (method, ...args) => platform.transaction(() => platform[method](...args));
  const actor = (name) => platform.authenticate(seeded.accounts[name].token);
  for (const name of ['moderatorA', 'moderatorB']) {
    const invite = tx('invite', actor('admin'), { role: 'moderator' });
    seeded.accounts[name] = await platform.register({ name: `Rehearsal ${name}`, email: `${name}@rehearsal.invalid`, password: PASSWORD, consent: true, invite: invite.code });
  }
  const runtime = tx('runtime', actor('bob'), seeded.ids.bobAgent, { scopes: ['read', 'chat'], minutes: 5, max_calls: 10 });
  const report = tx('report', actor('alice'), { target_type: 'agent', target_id: seeded.ids.bobAgent, reason: 'A disposable safety report for the drill.' });
  check(checks, 'the owner and reporter cannot decide the report', Boolean(refused(() => tx('moderate', actor('bob'), { report_id: report.id, action: 'suspend', reason: 'No self-moderation.' }))) && Boolean(refused(() => tx('moderate', actor('alice'), { report_id: report.id, action: 'suspend', reason: 'No reporter decision.' }))));
  tx('moderate', actor('moderatorA'), { report_id: report.id, action: 'suspend', reason: 'Rehearsal suspension by an independent operator.' });
  check(checks, 'independent suspension revoked the resident runtime', platform.get('SELECT status FROM agents WHERE id=?', seeded.ids.bobAgent).status === 'suspended' && Boolean(refused(() => platform.authenticate(runtime.token))));
  const appeal = tx('appeal', actor('bob'), { report_id: report.id, reason: 'Request an independent rehearsal appeal.' });
  check(checks, 'the first moderator cannot decide the appeal', Boolean(refused(() => tx('decideAppeal', actor('moderatorA'), { appeal_id: appeal.id, decision: 'overturned', reason: 'Not my own case.' }))));
  tx('decideAppeal', actor('moderatorB'), { appeal_id: appeal.id, decision: 'overturned', reason: 'A second independent operator checked the case.' });
  check(checks, 'the appeal overturns the report but requires an explicit resident resume', platform.get('SELECT status FROM reports WHERE id=?', report.id).status === 'overturned' && platform.get('SELECT status FROM agents WHERE id=?', seeded.ids.bobAgent).status === 'paused');
  tx('agentControl', actor('bob'), seeded.ids.bobAgent, 'active');
  tx('pause', actor('admin'), true);
  check(checks, 'a paused world refuses an ordinary message', Boolean(refused(() => tx('message', actor('alice'), { agent_id: seeded.ids.aliceAgent, text: 'This must not be saved while paused.' }))) && platform.get("SELECT COUNT(*) AS n FROM messages WHERE text='This must not be saved while paused.'").n === 0);
  platform.close();
  platform = new Platform(seeded.database);
  try {
    check(checks, 'pause and safety decisions survive a real database reopen', platform.get("SELECT value FROM settings WHERE key='paused'").value === 'true' && platform.get('SELECT status FROM reports WHERE id=?', report.id).status === 'overturned' && platform.get('SELECT status FROM appeals WHERE id=?', appeal.id).status === 'overturned' && Boolean(refused(() => tx('message', actor('alice'), { agent_id: seeded.ids.aliceAgent, text: 'Still paused after restart.' }))));
    tx('pause', actor('admin'), false);
    const delivered = tx('message', actor('alice'), { agent_id: seeded.ids.aliceAgent, text: 'The world resumed after the drill.' });
    check(checks, 'unpause restores ordinary action and the audit chain remains valid', Boolean(delivered.id) && platform.verifyAudit() && validateDatabase(seeded.database).schema_version === 25);
  } finally { platform.close(); }
  return { ok: allPassed(checks), checks, detail: 'An independent suspension and appeal, runtime revocation, durable pause and explicit recovery were exercised on a disposable world.' };
}

const DRILLS = [
  ['recovery-point', drillRecoveryPoint],
  ['corrupt-backup', drillCorruptBackup],
  ['migration-rehearsal', drillMigrationRehearsal],
  ['interrupted-worker', drillInterruptedWorker],
  ['model-queue-saturation', drillModelQueueSaturation],
  ['storage-limit', drillStorageLimit],
  ['diagnostics-redaction', drillDiagnosticsRedaction],
  ['safety-and-pause', drillSafetyAndPause],
];

export async function runOpsRehearsal({ workspace, keep = false, only = null } = {}) {
  const root = workspace || mkdtempSync(join(tmpdir(), 'nemoworld-ops-'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const started = new Date().toISOString();
  const drills = [];
  for (const [id, run] of DRILLS) {
    if (only && only !== id) continue;
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const began = Date.now();
    try {
      const result = await run(directory);
      drills.push({ id, duration_ms: Date.now() - began, ok: result.ok, checks: result.checks, detail: result.detail, artifacts: result.artifacts || null });
    } catch (error) {
      drills.push({ id, duration_ms: Date.now() - began, ok: false, checks: [], detail: `The drill could not run: ${error.message}`, artifacts: null });
    }
  }
  const report = { name: 'nemoworld-ops-rehearsal', started_at: started, finished_at: new Date().toISOString(), workspace: root, ok: drills.length > 0 && drills.every((drill) => drill.ok), drills };
  const reportPath = join(root, 'ops-rehearsal-report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const retain = keep || Boolean(workspace);
  if (!retain) rmSync(root, { recursive: true, force: true });
  return { ...report, report_path: retain ? reportPath : null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--child') {
      await runInterruptedWorkerChild(args[1], args[2], args[3], args[4], args[5]);
    } else {
      const keep = args.includes('--keep');
      const index = args.indexOf('--drill');
      const report = await runOpsRehearsal({ keep, only: index >= 0 ? args[index + 1] : null });
      for (const drill of report.drills) {
        console.log(`${drill.ok ? 'PASS' : 'FAIL'}  ${drill.id}  (${drill.duration_ms} ms)`);
        for (const entry of drill.checks) if (!entry.ok) console.log(`        failed: ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
      }
      console.log(`${report.drills.filter((drill) => drill.ok).length}/${report.drills.length} drills passed`);
      if (keep && report.report_path) console.log(`report: ${report.report_path}`);
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`Refused: ${error.message}`);
    process.exitCode = 1;
  }
}
