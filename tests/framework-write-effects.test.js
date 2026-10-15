// What a write leaves behind: the effect it answered must be readable from the database, the
// attribution record the contract promises must exist and name the acting account, and a replayed
// keyed submission must not write a second time. Every request in this file goes over real HTTP to a
// real server against a disposable database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writesFixture, RUNTIME_SCOPES } from './framework/writes-harness.js';
import { prepare, orderedExercises, BLOCKED_EXERCISES, WRITE_EXERCISES } from './framework/writes-table.js';
import { WRITE_ROUTES, policyFor } from '../src/framework/write-contract.js';

const pathOf = (exercise, context) => exercise.route.replace(':id', exercise.id ? exercise.id(context) : (RUNTIME_SCOPES[exercise.as] ? context.residents[exercise.as].id : context.aliceAgent.id));
// Every stored row count, so a replay that writes anywhere at all is visible.
function digest(platform) {
  const tables = platform.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);
  return tables.map((table) => `${table}:${platform.get(`SELECT COUNT(*) AS n FROM "${table}"`).n}`).join('|');
}

test('every exercised write persists its answered effect, its attribution record and replays once', async (t) => {
  const f = await writesFixture(t);
  const context = await prepare(f);
  // The acting account is read from storage, not re-authenticated: two exercised writes revoke a
  // session and delete an account, so the token that made the request is not always usable afterwards.
  const account = (name) => f.platform.get('SELECT id FROM accounts WHERE email=?', `${name}@example.org`)?.id || name;
  const failures = [];
  const fail = (route, message) => failures.push(`${route}: ${message}`);
  const auditSince = (seq) => f.platform.all('SELECT seq,actor,event FROM audit WHERE seq>? ORDER BY seq', seq);
  const maxSeq = () => f.platform.get('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n;

  for (const exercise of orderedExercises()) {
    const entry = policyFor(exercise.route, exercise.method);
    assert.ok(entry, `${exercise.method} ${exercise.route} must be declared in the contract`);
    const token = RUNTIME_SCOPES[exercise.as] ? context.runtimes[exercise.as] : undefined;
    const accountName = token ? (exercise.as === 'read' ? 'admin' : { move: 'moderator', chat: 'reviewer', contribute: 'carol', build: 'dave', vault: 'bob', every: 'erin' }[exercise.as]) : exercise.as;
    const actorId = account(accountName);
    if (exercise.advance) f.advance(exercise.advance);
    if (exercise.before) exercise.before(f, context);
    const before = maxSeq();
    const input = typeof exercise.input === 'function' ? exercise.input(context) : undefined;
    const response = await f.request(pathOf(exercise, context), { method: exercise.method, account: token ? undefined : accountName, token, input, key: exercise.key });

    if (response.status < 200 || response.status >= 300) { fail(exercise.route, `answered ${response.status} ${response.error || ''}`); continue; }
    try { exercise.effect(f, response, context); } catch (error) { fail(exercise.route, `the answered effect is not in storage: ${error.message}`); }

    const written = auditSince(before);
    if (entry.audit === true && written.length === 0) fail(exercise.route, 'the contract promises an attribution record and none was written');
    if (entry.audit === false && written.length > 0) fail(exercise.route, `the contract says no attribution record, but ${written.map((row) => row.event).join(', ')} was written`);
    if (entry.audit !== null) for (const row of written) if (row.actor !== actorId) fail(exercise.route, `attribution record ${row.event} names ${row.actor}, not the acting account ${actorId}`);

    if (entry.idempotency_keyed) {
      const first = digest(f.platform);
      const replay = await f.request(pathOf(exercise, context), { method: exercise.method, account: token ? undefined : accountName, token, input, key: exercise.key });
      if (replay.status < 200 || replay.status >= 300) fail(exercise.route, `the replay answered ${replay.status} ${replay.error || ''}`);
      if (digest(f.platform) !== first) fail(exercise.route, 'a replayed Idempotency-Key wrote a second record');
      const replayAudit = auditSince(before).length - written.length;
      if (replayAudit !== 0) fail(exercise.route, `a replayed Idempotency-Key wrote ${replayAudit} further attribution record(s)`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the contract covers every declared write route, exercised or explicitly blocked', async (t) => {
  const exercised = new Set(WRITE_EXERCISES.map((exercise) => `${exercise.method} ${exercise.route}`));
  const blocked = new Set(Object.keys(BLOCKED_EXERCISES));
  const uncovered = WRITE_ROUTES.filter((entry) => !exercised.has(`${entry.method} ${entry.route}`) && !blocked.has(entry.route)).map((entry) => `${entry.method} ${entry.route}`);
  assert.deepEqual(uncovered, [], 'declared writes with neither an exercise nor a stated reason');
  const unknown = [...blocked].filter((route) => !WRITE_ROUTES.some((entry) => entry.route === route));
  assert.deepEqual(unknown, [], 'blocked routes that the contract does not declare');
  // Reasons are required, not merely present: each blocked entry has to say why in words.
  for (const [route, reason] of Object.entries(BLOCKED_EXERCISES)) assert.ok(typeof reason === 'string' && reason.length > 20, `${route} needs a real reason`);
});
