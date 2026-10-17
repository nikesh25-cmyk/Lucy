import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { createApp } from '../../server.js';
import { declarationCore, institutionalClaim } from '../../src/resident-framework.js';

// Known gaps of the Wave 3 resident framework: real defects and boundaries this branch found and must
// not fix, because each one belongs to a file another owner holds (app.js, src/database.js,
// src/recovery.js, src/spaces.js) or to a sibling branch's remit.
//
// This file is deliberately NOT discovered by `npm test`: the default runner glob matches
// `*.test.js` / `*.test.mjs` (and a directory named exactly `test`), so a `.mjs` file under
// `tests/framework/` is invisible to it and `npm test` stays green while every defect below stays
// reproducible. Run it explicitly:
//
//   node --test tests/framework/known-gaps-resident.mjs
//
// Each test states the command, the expected invariant, the observed behaviour and the owner. A
// failing test here is the repro, not a regression: it fails while the defect stands.

const openServer = async (t, f) => {
  const app = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  return { app, base };
};

test('KNOWN GAP 1 — the audit ledger has no index on record_id, so the declared replay lookup is a scan', async (t) => {
  // Command:      node --test tests/framework/known-gaps-resident.mjs
  // Invariant:    the framework’s own durable lookup — "has this resident already applied this
  //               intent?" — should be answered from an index, because it runs on every declared
  //               action and on every inspection read.
  // Observed:     `audit` carries only its INTEGER PRIMARY KEY. The lookup is
  //               `record_id LIKE '<agent>|<intent>|%'`, which SQLite answers by scanning the table,
  //               so both the replay check and the action history grow linearly with the ledger.
  // Owner:        src/database.js (the schema owner). NOT editable by this branch, and an index is a
  //               schema change, so the fix is proposed rather than made:
  //                 CREATE INDEX IF NOT EXISTS audit_record ON audit(record_id);
  //               inside the existing migration transaction. Nothing about the ledger’s shape changes.
  const f = await fixture(t);
  const indexes = f.platform.all("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='audit'");
  const covered = indexes
    .flatMap((index) => (index.sql ? f.platform.all(`PRAGMA index_info(${JSON.stringify(index.name)})`) : []))
    .some((column) => column.name === 'record_id');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM pragma_table_info('audit') WHERE name='record_id'").n, 1);
  assert.ok(covered, `no index covers audit.record_id (indexes found: ${indexes.map((index) => index.name).join(', ') || 'none'}). Add: CREATE INDEX IF NOT EXISTS audit_record ON audit(record_id);`);
});

test('KNOWN GAP 2 — a moderator has no direct pause or revoke for another operator’s resident', async (t) => {
  // Command:      node --test tests/framework/known-gaps-resident.mjs
  // Invariant:    the Wave 3 brief asks that "an operator (and separately, a moderator) can pause,
  //               inspect, resume and revoke a resident".
  // Observed:     inspection works for a moderator (GET /residents/declaration), and suspension works
  //               through an open report (POST /moderation), but a direct pause or revoke is refused:
  //               Platform.agentControl resolves the resident through ownedAgent(), so a moderator
  //               receives 404 for another operator’s resident. There is no moderator path to resume
  //               either: only an overturned appeal returns a suspended resident to paused.
  // Owner:        src/platform.js (agentControl / operate control policy). Widening a moderator’s
  //               direct control over another operator’s resident is a policy decision for the
  //               moderation owner, so this branch reports it and does not make it. The proposal is a
  //               moderator-only control route that records the same audit event and the same reason
  //               the report path already requires, rather than loosening ownedAgent().
  const f = await fixture(t);
  const { base } = await openServer(t, f);
  const resident = f.tx('createAgent', f.actor('alice'), { name: 'Moderated resident', capabilities: 'Read', limitations: 'Needs review', color: '#397f79', symbol: '✦' });
  const control = async (route, body) => {
    const response = await fetch(`${base}/api/v1${route}`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${f.credentials.moderator.token}`, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return response.status;
  };
  assert.equal(await control('/agents/control', { agent_id: resident.id, status: 'paused' }), 200, 'a moderator cannot pause another operator’s resident (observed 404)');
  assert.equal(await control('/agents/control', { agent_id: resident.id, status: 'revoked' }), 200, 'a moderator cannot revoke another operator’s resident (observed 404)');
});

test('KNOWN GAP 3 — an institutional-authority claim is refused when it is acted on, but not when it is stored', async (t) => {
  // Command:      node --test tests/framework/known-gaps-resident.mjs
  // Invariant:    "no field may assert government, UN, ministry or institutional endorsement".
  // Observed:     the guard added by this branch covers (a) every text a resident authors through a
  //               declared action and (b) the declaration’s own read — a claim in the operator-entered
  //               agent fields or in a recorded purpose fact makes the declaration defective and
  //               blocks every declared action. The claim itself is still *stored* and still published
  //               by the world’s own account read: POST /agents accepts it and GET /me returns it
  //               verbatim, because createAgent does no content check. (GET /world does not publish
  //               `capabilities`, so the exposure is to the owning operator’s own read, not to
  //               anonymous visitors.)
  // Owner:        src/platform.js (createAgent and the avatar field writers). A write-time refusal
  //               there would change an existing public behaviour for every account, so it is proposed
  //               rather than made: call institutionalClaim() (src/resident-framework.js) on `name`,
  //               `capabilities` and `limitations` inside createAgent, and on the purpose-fact value
  //               inside memoryRecord, refusing with 400. The declaration guard stays as the second,
  //               derived line of defence whatever that decision is.
  const f = await fixture(t);
  const { base } = await openServer(t, f);
  const claim = 'Authorized representative of the Ministry of Health';
  const created = f.tx('createAgent', f.actor('alice'), { name: 'Attaché', capabilities: claim, limitations: 'Needs review', color: '#397f79', symbol: '✦' });
  assert.equal(institutionalClaim(claim)?.rule, 'endorsement', 'the guard itself detects the claim');
  const declaration = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', created.id), {});
  assert.equal(declaration.may_act, false, 'a defective declaration blocks declared action');
  const world = await (await fetch(`${base}/api/v1/world?world_id=commons`, { headers: { Origin: base } })).text();
  assert.equal(world.includes(claim), false, 'the world’s participant read does not publish capabilities at all');
  const me = await (await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${f.credentials.alice.token}`, Origin: base } })).text();
  assert.equal(me.includes(claim), false, 'the operator’s own read still publishes the stored claim');
});

test('KNOWN GAP 4 — a declared action inside a managed run is not attributed to that run', async (t) => {
  // Command:      node --test tests/framework/known-gaps-resident.mjs
  // Invariant:    an operator reading one managed resident run should be able to see the declared
  //               actions that run took, next to its counters and its stop reason.
  // Observed:     the two durable records do not meet. `resident_runs` stores counters, the last
  //               confirmed action and the credential hash; the declared ledger stores one audit line
  //               per resident. Nothing links a ledger line to a run id, so a run receipt can only say
  //               "3 actions" while the ledger can only say which resident acted and when — an
  //               operator cannot tell which of the resident’s runs produced which action.
  // Owner:        runtime/agent.js and the resident_runs schema (the crash-safe jobs owner). A run id
  //               in the ledger record would need either a new column or a new table, and this branch
  //               may not change the schema (26 belongs to a sibling). Proposal: pass the run id into
  //               the declared request (`run_id`, already known to the runtime as `writeKey`’s runId)
  //               and store it in the ledger record, which is text and needs no migration.
  const f = await fixture(t);
  const resident = f.tx('createAgent', f.actor('alice'), { name: 'Run resident', capabilities: 'Read', limitations: 'Needs review', color: '#397f79', symbol: '✦' });
  f.tx('callingSelect', f.actor('alice'), { agent_id: resident.id, calling_id: 'mediator' });
  const session = f.tx('runtime', f.actor('alice'), resident.id, { minutes: 10, max_calls: 10, scopes: ['read', 'chat', 'contribute'] });
  f.tx('startResidentRun', { id: 'walkthrough-run-1', account_id: f.actor('alice').account.id, agent_id: resident.id, permission: 'explore', decisions: 4, minutes: 4, credential_hash: f.platform.get("SELECT hash FROM tokens WHERE agent_id=? AND kind='runtime'", resident.id).hash });
  const actor = f.platform.authorize(f.platform.get('SELECT hash FROM tokens WHERE agent_id=? AND kind=\'runtime\'', resident.id).hash, 'contribute');
  const result = f.platform.residentAct(actor, { action: 'say', intent_id: 'run-attribution-1', text: 'A message sent inside a managed run.' });
  assert.equal(result.state, 'executed');
  const ledger = f.platform.all("SELECT record_id FROM audit WHERE event LIKE 'resident.action.%'").map((row) => row.record_id).join('\n');
  assert.match(ledger, /walkthrough-run-1/, `no ledger line names the run it happened in. Ledger as stored: ${ledger}`);
});

test('KNOWN GAP 5 — the declared lifecycle is not yet wired into the managed runtime’s own write path', async (t) => {
  // Command:      node --test tests/framework/known-gaps-resident.mjs
  // Invariant:    one declared lifecycle should guard every resident action, not only the actions a
  //               caller routes through POST /residents/act.
  // Observed:     runtime/agent.js still dispatches its own writes directly to the shipped world
  //               routes (/move, /messages, /thanks, /guilds/participation …) with its own
  //               `authorizeAction` pre-filter and its own Idempotency-Key. Those writes are bounded
  //               by the credential and by the world, but they do not walk the declared lifecycle, so
  //               a managed run’s action is not recorded in the declared ledger and is not refused by
  //               the declared purpose gate (the world’s own scope check is the only gate).
  // Owner:        runtime/agent.js (resident runtime owner). The wiring is a one-line change per
  //               action — route `request()` through /residents/act with serves derived from the
  //               calling objective — but changing the runtime’s dispatch is a behaviour change in a
  //               file this slice does not own, and it would need the full runtime test suite re-read.
  //               Recorded here so the gap is visible rather than implied.
  const source = readFileSync(new URL('../../runtime/agent.js', import.meta.url), 'utf8');
  assert.match(source, /residents\/act/, 'runtime/agent.js never calls the declared action route: a managed run still writes outside the declared lifecycle');
});
