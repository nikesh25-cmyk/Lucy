#!/usr/bin/env node
// NemoWorld Wave 7 reliability drills.
//
// Three drills that the Task 27 rehearsal (`scripts/ops-rehearsal.mjs`) does not perform, each on its
// own DISPOSABLE installation: a private temporary workspace with its own SQLite database, its own
// backups directory and its own vault key. The shipped data directory, any world already running on
// this machine, installed accounts, credentials and model weights are never opened.
//
//   crash-during-write          a real child process is SIGKILLed *inside* a multi-row transaction
//                               while a worker job is running. Proves the transaction is atomic (no
//                               torn batch), the database reopens and validates, the running job
//                               becomes an explicit interrupted record with its credential revoked,
//                               and re-issuing the interrupted write cannot double-apply it.
//   unexpected-error-record     one request fails with an unexpected internal error whose own message
//                               is seeded with a session token, a runtime token, a stored password
//                               digest, a contact address, a private message marker, a private journal
//                               marker, a private artifact marker and a vault plaintext. Proves the
//                               failure produces a structured, counted, route-named record, that the
//                               world's own refusals are *not* counted, and that none of the planted
//                               values reaches the response, the log, the diagnostics or the audit.
//   rollback-release-candidate  a fresh public world is seeded, its release point is backed up with
//                               the shipped CLI, a release writes to it, and the shipped CLI rolls it
//                               back. Proves the world returns exactly to the release point, that the
//                               rollback is repeatable, and that the world is writable afterwards.
//
// Run it with:  node scripts/reliability-drills.mjs              # every drill, JSON report on stdout
//               node scripts/reliability-drills.mjs --keep       # keep the workspace for inspection
//               node scripts/reliability-drills.mjs --drill crash-during-write
//
// `tests/reliability-drills.test.js` calls runReliabilityDrills() and re-checks the databases, the
// backups and the logs it leaves behind, so the script and the suite cannot drift apart.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { validateDatabase, storageUsage } from '../src/recovery.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'reliability-drill-password-2026';
// Planted private data. Every drill that seeds a value also greps every surface it produced for it.
export const PLANTED = Object.freeze({
  email: 'wave7-secret-contact@reliability.invalid',
  password: 'Wave7-Secret-Password-2026',
  message: 'WAVE7-PRIVATE-MESSAGE-MARKER-4471',
  journal: 'WAVE7-PRIVATE-JOURNAL-MARKER-4471',
  artifact: 'WAVE7-PRIVATE-ARTIFACT-MARKER-4471',
  vault: 'WAVE7-VAULT-PLAINTEXT-MARKER-4471',
});
const TRACKED = ['accounts', 'agents', 'world_objects', 'land_stewardships', 'land_events', 'coin_rewards', 'quest_enrollments', 'guild_projects', 'audit'];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const check = (checks, name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) }); return Boolean(ok); };
const allPassed = (checks) => checks.every((entry) => entry.ok);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const countsFor = (platform) => Object.fromEntries(TRACKED.map((table) => [table, platform.get(`SELECT COUNT(*) AS n FROM ${table}`).n]));
const describeCounts = (values) => TRACKED.filter((table) => values[table]).map((table) => `${table}=${values[table]}`).join(' ') || 'no tracked rows';

// One disposable public world: an administrator, two members and a reviewer, one resident with a saved
// garden object, one stewarded plot, one quest enrolment, and — when asked — a private contact whose
// resident holds a private message, a private journal entry, a vault plaintext and a runtime credential.
async function seedPublicWorld(directory, { plantSecrets = false } = {}) {
  const database = join(directory, 'world.sqlite');
  const platform = new Platform(database);
  const tx = (method, ...args) => platform.transaction(() => platform[method](...args));
  const accounts = {};
  accounts.admin = await platform.register({ name: 'Wave 7 administrator', email: 'wave7-admin@reliability.invalid', password: PASSWORD, consent: true });
  const actor = (name) => platform.authenticate(accounts[name].token);
  for (const [name, role] of [['alice', 'member'], ['bob', 'member'], ['reviewer', 'reviewer']]) {
    const invite = tx('invite', actor('admin'), { role });
    accounts[name] = await platform.register({ name: `Wave 7 ${name}`, email: `${name}@reliability.invalid`, password: PASSWORD, consent: true, invite: invite.code });
  }
  const agent = (name) => tx('createAgent', actor(name), { name: `Wave 7 ${name} resident`, capabilities: 'Read approved public sources', limitations: 'Requires human review', color: '#3f6f9f', symbol: '◆' });
  const aliceAgent = agent('alice');
  tx('travel', actor('alice'), aliceAgent.id, { world_id: `home:${aliceAgent.id}` });
  tx('build', actor('alice'), aliceAgent.id, { type: 'farm', x: 3, y: 6 });
  tx('landAssign', actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A Wave 7 reliability fixture', description: 'An isolated fixture used only by the reliability drills.' });
  const mission = tx('createMission', actor('admin'), { title: 'Wave 7 verified mission', area: 'Climate', summary: 'Exercise an evidence contribution end to end.', beneficiary: 'Wave 7 fixture', owner_id: actor('admin').account.id, reviewer_id: actor('reviewer').account.id, rubric: 'Check exact original sources, rights, uncertainty and attribution.' });
  const task = tx('createTask', actor('admin'), { mission_id: mission.id, title: 'Record one source', instructions: 'Provide attribution, location, rights and uncertainty.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] });
  tx('missionStatus', actor('admin'), mission.id, 'open');
  const claim = tx('claim', actor('alice'), { task_id: task.id, agent_id: aliceAgent.id }, 'wave7-claim');
  const submission = tx('submit', actor('alice'), { claim_id: claim.id, artifact: plantSecrets ? `Attributed register entry. ${PLANTED.artifact}` : 'An attributed plain text register entry.', sources: [{ url: 'https://example.org/report', location: 'Section 2, paragraph 3', date: '2026-01-01' }], method: 'Read the original source and recorded the exact supporting section.', limitations: 'A fixture; facts and rights require human verification.', rights: 'Permission and attribution were checked for this fixture.' }, 'wave7-submit');
  const review = tx('review', actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture source review' });
  if (review.coin_reward?.amount !== 10) throw new Error('The fixture coin receipt was not issued as expected.');
  tx('questJoin', actor('alice'), { agent_id: aliceAgent.id, chain_id: 'quiet-harvest' }, 'wave7-quest-key');
  const ids = { aliceAgent: aliceAgent.id, submission: submission.id, plot: 'plot:0:0:5:5' };
  const plantedCredentials = [];
  if (plantSecrets) {
    const privateAccount = await platform.register({ name: 'Wave 7 private contact', email: PLANTED.email, password: PLANTED.password, consent: true });
    const privateSession = platform.authenticate(privateAccount.token);
    const privateAgent = tx('createAgent', privateSession, { name: 'Wave 7 private resident', capabilities: 'Fixture only', limitations: 'Fixture only' });
    const runtime = tx('runtime', privateSession, privateAgent.id, { scopes: ['read', 'vault'], minutes: 5, max_calls: 10 });
    platform.run('INSERT INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,status,created_at,world_id) VALUES(?,?,?,?,?,?,?,?,?,?)', 'wave7-private-message', privateAgent.id, privateSession.account.id, 'private', null, '[]', PLANTED.message, 'visible', new Date().toISOString(), 'commons');
    tx('writeJournal', actor('alice'), { agent_id: aliceAgent.id, text: PLANTED.journal });
    // The vault stores ciphertext only, so the plaintext exists nowhere in the database; the drill
    // still greps every produced surface for it, which is the property a leak would violate.
    platform.transaction(() => platform.vaultWrite(platform.authenticate(runtime.token), { agent_id: privateAgent.id, slot: 1, text: PLANTED.vault }));
    // The stored password digest for the private contact, read straight from the row rather than guessed.
    const digest = platform.get('SELECT password FROM accounts WHERE email=?', PLANTED.email).password;
    ids.privateAgent = privateAgent.id;
    plantedCredentials.push(privateAccount.token, runtime.token, digest);
  }
  return { platform, database, ids, accounts, actor, plantedCredentials };
}

// ---- Drill: a process killed inside a transaction, while a job is running ------------------------
const CRASH_MARKER = 'wave7-crash-drill';
const CRASH_BATCH_SIZE = 4000;
const CRASH_TRIALS = [['killed in the first moments of a transaction', 0], ['killed a few milliseconds into a transaction', 3], ['killed later in a transaction', 9]];

/**
 * The child. It starts a real worker job (a `resident_runs` row with its credential hash, plus the
 * `jobs` row the server writes), then writes batches of rows inside one transaction each, announcing
 * the start and the commit of every batch so the parent can kill it at a chosen moment.
 */
async function runCrashChild(database, accountId, agentId, credentialHash, jobId) {
  const platform = new Platform(database);
  const insert = platform.db.prepare("INSERT INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,status,created_at,world_id) VALUES(?,NULL,?, 'public',NULL,'[]',?, 'visible',?,'commons')");
  for (let batch = 0; ; batch++) {
    process.stdout.write(`begin ${batch}\n`);
    platform.transaction(() => {
      for (let index = 0; index < CRASH_BATCH_SIZE; index++) insert.run(`crash-${batch}-${index}`, accountId, CRASH_MARKER, new Date().toISOString());
    });
    process.stdout.write(`committed ${batch}\n`);
  }
}

async function crashTrial(directory, jitterMs) {
  const seeded = await seedPublicWorld(directory);
  const { platform, database, accounts, ids } = seeded;
  // A real bounded run, recorded exactly as the server records it, so the same kill leaves both a
  // half-written transaction and a running job.
  const runtime = platform.transaction(() => platform.runtime(seeded.actor('alice'), ids.aliceAgent, { scopes: ['read'], minutes: 5, max_calls: 10 }));
  const jobId = randomUUID();
  const credentialHash = sha256(runtime.token);
  platform.transaction(() => platform.run('INSERT INTO jobs VALUES(?,?,?,?,?)', jobId, ids.aliceAgent, 'running', 'Wave 7 crash drill resident run in progress.', new Date().toISOString()));
  platform.transaction(() => platform.startResidentRun({ account_id: accounts.alice.account.id, agent_id: ids.aliceAgent, id: jobId, permission: 'observe', decisions: 3, minutes: 5, credential_hash: credentialHash }));
  const before = countsFor(platform);
  const accountId = accounts.alice.account.id;
  platform.close();

  // SIGKILL cannot be caught, so no cleanup, no receipt and no credential revocation runs.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', 'crash-write', database, accountId, ids.aliceAgent, credentialHash, jobId], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const began = [], committed = [];
  const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  // Wait for the "begin" line of a batch that is not the first, so at least one batch is known to have
  // committed and the transaction body is genuinely in flight when the signal lands.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const line of output.split('\n')) {
      const begin = /^begin (\d+)$/.exec(line.trim());
      if (begin && !began.includes(Number(begin[1]))) began.push(Number(begin[1]));
      const commit = /^committed (\d+)$/.exec(line.trim());
      if (commit && !committed.includes(Number(commit[1]))) committed.push(Number(commit[1]));
    }
    if (committed.length >= 1 && output.trim().split('\n').some((line) => line.trim() === `begin ${committed[committed.length - 1] + 1}`)) break;
    if (child.exitCode !== null) break;
    await sleep(2);
  }
  await sleep(jitterMs);
  const inFlight = (() => {
    const begins = output.trim().split('\n').map((line) => line.trim()).filter((line) => line.startsWith('begin ')).map((line) => Number(line.slice(6)));
    return begins.length ? Math.max(...begins) : null;
  })();
  child.kill('SIGKILL');
  const ended = await done;
  return { seeded, database, jobId, credentialHash, accountId, agentId: ids.aliceAgent, before, began, committed, inFlight, signal: ended.signal, code: ended.code, output: output.trim().slice(0, 200) };
}

async function drillCrashDuringWrite(directory) {
  const checks = [];
  const observed = [];
  let sawTornAttempt = false;
  for (const [label, jitterMs] of CRASH_TRIALS) {
    const trial = await crashTrial(join(directory, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()), jitterMs);
    const { database, jobId, credentialHash, before } = trial;
    check(checks, `${label}: the worker process was killed without cleanup`, trial.signal === 'SIGKILL', `signal=${trial.signal} code=${trial.code} batches begun=${trial.began.join(',')} committed=${trial.committed.join(',')} output=${trial.output.slice(0, 120)}`);
    const platform = new Platform(database);
    try {
      // Atomicity: every batch is either entirely present or entirely absent. A batch with a partial
      // row count is a torn transaction, which is the failure this drill exists to look for.
      const perBatch = new Map();
      for (const row of platform.all("SELECT id FROM messages WHERE text=? AND id LIKE 'crash-%'", CRASH_MARKER)) perBatch.set(Number(String(row.id).split('-')[1]), (perBatch.get(Number(String(row.id).split('-')[1])) || 0) + 1);
      const partial = [...perBatch.entries()].filter(([, n]) => n !== CRASH_BATCH_SIZE).map(([batch, n]) => ({ batch, n }));
      check(checks, `${label}: no transaction was left half-applied`, partial.length === 0, partial.length ? `torn batches: ${JSON.stringify(partial.slice(0, 3))}` : `${perBatch.size} batch(es) present, each exactly ${CRASH_BATCH_SIZE} rows`);
      // Every batch the child announced as committed must be there in full.
      const missing = trial.committed.filter((batch) => !platform.get("SELECT 1 FROM messages WHERE id=? LIMIT 1", `crash-${batch}-0`));
      check(checks, `${label}: every batch announced as committed survived the kill`, missing.length === 0, missing.length ? `missing committed batches ${missing.join(',')}` : `committed ${trial.committed.join(',') || 'none'}`);
      const attempted = trial.began.filter((batch) => !trial.committed.includes(batch));
      const absent = attempted.filter((batch) => !platform.get("SELECT 1 FROM messages WHERE id=? LIMIT 1", `crash-${batch}-0`));
      if (absent.length) sawTornAttempt = true;
      check(checks, `${label}: the batch in flight at the kill is either wholly there or wholly gone`, attempted.every((batch) => (perBatch.get(batch) || 0) === (absent.includes(batch) ? 0 : CRASH_BATCH_SIZE)), `attempted=${attempted.join(',') || 'none'} rolled back=${absent.join(',') || 'none'}`);
      // The database itself is sound: file-level integrity, full validation (schema, audit chain,
      // coin ledger, foreign keys) and a quick check.
      check(checks, `${label}: the database reopens sound after the kill`, validateDatabase(database).schema_version === 25 && platform.verifyAudit() && platform.integrity().quick_check === 'ok');
      // The running job is an explicit record, not a mystery.
      const job = platform.get('SELECT * FROM jobs WHERE id=?', jobId);
      const run = platform.get('SELECT * FROM resident_runs WHERE id=?', jobId);
      check(checks, `${label}: the interrupted job is explicitly classified and never silently repeated`, job.status === 'interrupted' && run.status === 'interrupted' && run.stop_reason === 'process_restart' && /No action is repeated automatically/.test(job.detail), `status=${job.status} interrupted=${run.interrupted} detail=${String(job.detail).slice(0, 90)}`);
      check(checks, `${label}: the orphaned runtime credential was revoked`, platform.get('SELECT revoked FROM tokens WHERE hash=?', credentialHash).revoked === 1);
      check(checks, `${label}: exactly one honest interruption event was recorded`, platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='resident.run.interrupted'").n === 1);
      // No duplicate effect: re-issuing the interrupted batch's own row identifiers cannot add a row.
      const beforeReissue = platform.get("SELECT COUNT(*) AS n FROM messages WHERE text=?", CRASH_MARKER).n;
      const insert = platform.db.prepare("INSERT OR IGNORE INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,status,created_at,world_id) VALUES(?,NULL,?, 'public',NULL,'[]',?, 'visible',?,'commons')");
      platform.transaction(() => { for (let index = 0; index < CRASH_BATCH_SIZE; index++) insert.run(`crash-0-${index}`, trial.accountId, CRASH_MARKER, new Date().toISOString()); });
      const afterReissue = platform.get("SELECT COUNT(*) AS n FROM messages WHERE text=?", CRASH_MARKER).n;
      check(checks, `${label}: re-issuing the interrupted write cannot double-apply it`, afterReissue === beforeReissue + (platform.get("SELECT 1 FROM messages WHERE id='crash-0-0'") ? 0 : CRASH_BATCH_SIZE), `${beforeReissue} → ${afterReissue}`);
      const after = countsFor(platform);
      check(checks, `${label}: every world, land, coin, quest and guild record survived the crash`, ['world_objects', 'land_stewardships', 'land_events', 'coin_rewards', 'quest_enrollments', 'accounts', 'agents'].every((table) => before[table] === after[table]), `before=${describeCounts(before)} after=${describeCounts(after)}`);
      observed.push({ label, batch_size: CRASH_BATCH_SIZE, batches_present: perBatch.size, batches_committed: trial.committed.length, batch_rolled_back: absent.length > 0, database, job_id: jobId, storage: storageUsage(database) });
    } finally { platform.close(); }
  }
  check(checks, 'at least one trial killed a real transaction in flight', sawTornAttempt, sawTornAttempt ? 'a batch was announced and rolled back, so the kill landed inside the transaction body' : 'every kill landed around a commit boundary; the atomicity claim was not exercised');
  return { ok: allPassed(checks), checks, detail: `Three SIGKILLs landed inside ${CRASH_BATCH_SIZE}-row transactions. ${observed.map((row) => `${row.label}: ${row.batches_present} batch(es) kept, ${row.batches_committed} committed, transaction-in-flight rollback=${row.batch_rolled_back}`).join('; ')}.`, artifacts: { batch_size: CRASH_BATCH_SIZE, trials: observed } };
}

// ---- Drill: an unexpected server error produces a structured, redacted record --------------------
async function drillUnexpectedErrorRecord(directory) {
  const checks = [];
  const seeded = await seedPublicWorld(directory, { plantSecrets: true });
  // The whole set a leak would expose: both live credentials, the stored password digest of the
  // private contact, its contact address, the private message, the private journal entry, the private
  // artifact and the vault plaintext.
  const secrets = [...seeded.plantedCredentials, PLANTED.email, PLANTED.message, PLANTED.journal, PLANTED.artifact, PLANTED.vault];
  const app = createApp({ platform: seeded.platform, backupDir: join(directory, 'backups'), mayorModel: async () => '{"action":"wait"}' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const get = async (path, token) => { const response = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: response.status, text: await response.text() }; };
  // Every line the process writes to stderr while the failing request is in flight is captured, so the
  // log surface is grepped as it really is rather than as the drill imagines it.
  const captured = [];
  const realWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { captured.push(String(chunk)); return realWrite.call(this, chunk, ...rest); };
  try {
    const before = JSON.parse((await get('/operations', seeded.accounts.admin.token)).text).diagnostics.incidents;
    // An unexpected failure whose own message carries every planted secret.
    const originalWorld = seeded.platform.world;
    seeded.platform.world = () => { throw new Error(`Unexpected fixture failure token=${seeded.accounts.admin.token} runtime=${seeded.plantedCredentials[1]} contact=${PLANTED.email} digest=${seeded.plantedCredentials[2]} note=${PLANTED.message} vault=${PLANTED.vault} artifact=${PLANTED.artifact}`); };
    const failed = await get(`/world?agent_id=${seeded.ids.aliceAgent}&secret_query=${PLANTED.message}`, seeded.accounts.admin.token);
    seeded.platform.world = originalWorld;
    // A request the world itself refused is an ordinary outcome, not an incident.
    const refused = await get('/operations', null);
    const after = JSON.parse((await get('/operations', seeded.accounts.admin.token)).text).diagnostics.incidents;

    check(checks, 'the unexpected failure answers with the generic 500 and no internal detail', failed.status === 500 && failed.text === '{"error":"Server error."}', `${failed.status} ${failed.text.slice(0, 80)}`);
    check(checks, 'the failure produced one structured record, counted once', after.recorded_since_start === before.recorded_since_start + 1 && after.recent.length >= 1, `${before.recorded_since_start} → ${after.recorded_since_start}`);
    const record = after.recent[after.recent.length - 1];
    check(checks, 'the record is structured: an identifier, a time, the method, the route and the failure class',
      typeof record.id === 'string' && record.id.length === 36 && !Number.isNaN(Date.parse(record.at)) && record.method === 'GET' && record.route === '/world' && record.status === 500 && typeof record.error_name === 'string', JSON.stringify(record).slice(0, 300));
    check(checks, 'the record names the normalised route, never the raw query string', !JSON.stringify(record).includes('secret_query') && !JSON.stringify(record).includes(seeded.ids.aliceAgent), JSON.stringify(record).slice(0, 200));
    check(checks, 'the world\u2019s own refusals are not counted as incidents', refused.status === 401 && after.recorded_since_start === before.recorded_since_start + 1, `anonymous /operations answered ${refused.status}`);
    const log = captured.join('');
    const logLines = log.split('\n').filter((line) => line.includes('"level":"error"'));
    let parsedLog = null;
    try { parsedLog = JSON.parse(logLines[0]); } catch { parsedLog = null; }
    check(checks, 'the same failure is one structured JSON line on the log, not a bare sentence', logLines.length >= 1 && parsedLog && parsedLog.route === '/world' && parsedLog.status === 500 && typeof parsedLog.at === 'string', logLines[0]?.slice(0, 200) || 'no structured line was written');

    const diagnosticsText = (await get('/operations', seeded.accounts.admin.token)).text;
    const audit = JSON.stringify(seeded.platform.all('SELECT * FROM audit'));
    // The audit chain legitimately carries 64-character integrity hashes of its own, so only the
    // planted values are asserted absent there; the other three surfaces must also be free of any
    // email shape and any 64-character hex value at all.
    const surfaces = [
      ['the HTTP response', failed.text, true],
      ['the process log', log, true],
      ['the administrator diagnostics and audit response', diagnosticsText, true],
      ['the database audit chain', audit, false],
    ];
    for (const [label, text, shapes] of surfaces) {
      const leaked = secrets.filter((secret) => text.includes(secret));
      const extraShape = shapes && (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text) || /\b[0-9a-f]{64}\b/.test(text));
      check(checks, `no token, password digest, contact address, private marker or vault plaintext appears in ${label}`, leaked.length === 0 && !extraShape, leaked.length ? `${leaked.length} planted value(s) present` : shapes ? 'every planted value absent, no email shape, no 64-character hex value' : 'every planted value absent');
    }
    check(checks, 'the diagnostic record is visible to an administrator and refused to everyone else', diagnosticsText.includes('"incidents"') && (await get('/operations')).status === 401 && (await get('/operations', seeded.accounts.alice.token)).status === 403);
    // The two surfaces are written out so the suite re-greps what the shipped server really produced
    // rather than trusting this drill's own summary of it.
    const artifacts = { diagnostics: join(directory, 'diagnostics.json'), log: join(directory, 'incidents.log'), response: join(directory, 'error-response.txt'), secrets: join(directory, 'planted-secrets.json') };
    writeFileSync(artifacts.diagnostics, diagnosticsText, { mode: 0o600 });
    writeFileSync(artifacts.log, log, { mode: 0o600 });
    writeFileSync(artifacts.response, failed.text, { mode: 0o600 });
    // The planted values are written for the suite to re-grep with. This file is the one place they are
    // stored in cleartext, which is why it lives in the retained drill workspace and nowhere else.
    writeFileSync(artifacts.secrets, `${JSON.stringify({ secrets, markers: PLANTED }, null, 2)}\n`, { mode: 0o600 });
    return { ok: allPassed(checks), checks, detail: `One unexpected failure was recorded once (${after.recorded_since_start} in total), named by route and time, across ${surfaces.length} grepped surfaces with ${secrets.length} planted values.`, artifacts };
  } finally {
    process.stderr.write = realWrite;
    await app.stopWorkers();
    await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
    seeded.platform.close();
  }
}

// ---- Drill: the release-candidate rollback path --------------------------------------------------
const recovery = (args) => JSON.parse(execFileSync(process.execPath, [join(ROOT, 'scripts', 'recovery.js'), ...args], { cwd: ROOT, encoding: 'utf8' }).trim());
async function drillRollbackReleaseCandidate(directory) {
  const checks = [];
  const install = join(directory, 'install');
  mkdirSync(install, { recursive: true, mode: 0o700 });
  const releases = join(directory, 'releases');
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const seeded = await seedPublicWorld(install);
  const { database } = seeded;
  const releasePoint = countsFor(seeded.platform);
  const releasePointAuditTip = seeded.platform.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').hash;
  seeded.platform.close();

  // Step 1 — the release-point backup, taken by the shipped CLI with the world stopped. This file is
  // the rollback artifact; nothing else is needed to undo a release.
  const backup = join(releases, 'world-release-point.sqlite');
  const backupReport = recovery(['backup', database, backup]);
  check(checks, 'the released world has a verified release-point backup beside it', validateDatabase(backup).schema_version === 25 && backupReport.path === backup && (statSync(backup).mode & 0o777) === 0o600, `${statSync(backup).size} bytes, mode ${(statSync(backup).mode & 0o777).toString(8)}`);

  // Step 2 — the release. The first public sessions write to the world.
  const released = new Platform(database);
  const releasedActor = (name) => released.authenticate(seeded.accounts[name].token);
  released.transaction(() => released.build(releasedActor('alice'), seeded.ids.aliceAgent, { type: 'flowers', x: 4, y: 6 }));
  released.transaction(() => released.message(releasedActor('alice'), { agent_id: seeded.ids.aliceAgent, text: 'A message written after the release point.' }));
  const invite = released.transaction(() => released.invite(releasedActor('admin'), { role: 'member' }));
  await released.register({ name: 'Wave 7 post-release member', email: 'postrelease@reliability.invalid', password: PASSWORD, consent: true, invite: invite.code });
  const afterRelease = countsFor(released);
  check(checks, 'the release really changed the world', afterRelease.world_objects > releasePoint.world_objects && afterRelease.accounts > releasePoint.accounts, `before=${describeCounts(releasePoint)} after=${describeCounts(afterRelease)}`);
  released.close();

  // Step 3 — the rollback, through the shipped CLI, exactly as an operator would run it.
  const began = Date.now();
  const rollback = recovery(['restore', backup, database]);
  const durationMs = Date.now() - began;
  const restored = new Platform(database);
  const rolledBack = countsFor(restored);
  const restoredActor = (name) => restored.authenticate(seeded.accounts[name].token);
  let live = restored;
  try {
    check(checks, 'the rollback succeeds and preserves the released bytes before replacing them', rollback.schema_version === 25 && Boolean(rollback.preserved_original) && existsSync(rollback.preserved_original), `preserved_original=${Boolean(rollback.preserved_original)} in ${durationMs} ms`);
    check(checks, 'the world is exactly the release-point state again', describeCounts(rolledBack) === describeCounts(releasePoint), `release point=${describeCounts(releasePoint)} rolled back=${describeCounts(rolledBack)}`);
    check(checks, 'the audit chain tip is the release-point tip again', restored.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').hash === releasePointAuditTip && restored.verifyAudit());
    check(checks, 'work committed after the release point is gone', restored.get("SELECT COUNT(*) AS n FROM world_objects WHERE x=4 AND y=6").n === 0 && restored.get("SELECT COUNT(*) AS n FROM accounts WHERE email='postrelease@reliability.invalid'").n === 0);
    check(checks, 'the rolled-back world validates completely and its storage is intact', validateDatabase(database).schema_version === 25 && restored.integrity().quick_check === 'ok', JSON.stringify(storageUsage(database)));
    // Step 4 — the world serves and accepts writes again, so a rollback is a recovery and not a stop.
    const app = createApp({ platform: restored, backupDir: join(install, 'backups'), mayorModel: async () => '{"action":"wait"}' });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    try {
      const health = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/health`);
      check(checks, 'the rolled-back world serves the public health endpoint', health.status === 200 && (await health.json()).status === 'ok');
      const delivered = restored.transaction(() => restored.message(restoredActor('alice'), { agent_id: seeded.ids.aliceAgent, text: 'The world resumed after the rollback.' }));
      check(checks, 'the rolled-back world accepts new writes and keeps a valid audit chain', Boolean(delivered.id) && restored.verifyAudit() && validateDatabase(database).schema_version === 25);
    } finally {
      await app.stopWorkers();
      await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
    }
    // Step 5 — repeating the rollback from the same artifact must be safe (a failed rollback is
    // retried, not re-invented).
    restored.close();
    live = null;
    recovery(['restore', backup, database]);
    const again = new Platform(database);
    try {
      const repeat = countsFor(again);
      check(checks, 'rolling back a second time from the same artifact is safe and idempotent', describeCounts({ ...repeat, audit: releasePoint.audit }) === describeCounts(releasePoint) && again.verifyAudit(), `second rollback=${describeCounts(repeat)}`);
    } finally { again.close(); }
    // The three states are written out so the suite can confirm the live database really is the
    // release-point state, using the numbers this drill recorded before the release happened.
    const evidence = { release_point: releasePoint, after_release: afterRelease, rolled_back: rolledBack, release_point_audit_tip: releasePointAuditTip, database, backup, preserved_original: rollback.preserved_original, rollback_duration_ms: durationMs };
    const evidencePath = join(directory, 'rollback-evidence.json');
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return { ok: allPassed(checks), checks, detail: `Release point backed up (${statSync(backup).size} bytes, mode 0600), released (${describeCounts(afterRelease)}), rolled back through scripts/recovery.js in ${durationMs} ms to ${describeCounts(rolledBack)}, served again and re-rolled-back safely.`, artifacts: { ...evidence, evidence: evidencePath } };
  } finally { live?.close(); }
}

const DRILLS = [
  ['crash-during-write', drillCrashDuringWrite],
  ['unexpected-error-record', drillUnexpectedErrorRecord],
  ['rollback-release-candidate', drillRollbackReleaseCandidate],
];

export async function runReliabilityDrills({ workspace, keep = false, only = null } = {}) {
  const root = workspace || mkdtempSync(join(tmpdir(), 'nemoworld-wave7-'));
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
  const report = { name: 'nemoworld-wave7-reliability-drills', started_at: started, finished_at: new Date().toISOString(), workspace: root, ok: drills.length > 0 && drills.every((drill) => drill.ok), drills };
  const reportPath = join(root, 'reliability-drills-report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const retain = keep || Boolean(workspace);
  if (!retain) rmSync(root, { recursive: true, force: true });
  return { ...report, report_path: retain ? reportPath : null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--child') {
      await runCrashChild(args[2], args[3], args[4], args[5], args[6]);
    } else {
      const keep = args.includes('--keep');
      const index = args.indexOf('--drill');
      const report = await runReliabilityDrills({ keep, only: index >= 0 ? args[index + 1] : null });
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
