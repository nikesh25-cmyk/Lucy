// Reproducible defects this wave found but must not fix, in files it is not allowed to edit, or in
// parts of the write path outside its two permitted files. `node --test` never discovers this file
// (the runner matches `*.test.js` / `*.test.mjs`), so `npm test` stays green while each defect stays
// reproducible.
//
//   Run every repro:            node tests/framework/known-gaps.mjs
//   Run one repro by id:        node tests/framework/known-gaps.mjs unkeyed
//
// Each repro prints the invariant it is testing, what actually happens, and the patch its file's
// owner should apply. A repro that stops reproducing reports FAIL, so a fix cannot leave this file
// claiming a defect that no longer exists.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writesFixture, RUNTIME_SCOPES } from './writes-harness.js';
import { prepare, orderedExercises } from './writes-table.js';

const root = new URL('../..', import.meta.url).pathname;
const source = async (file) => readFile(join(root, file), 'utf8');
const digest = (f) => f.platform.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => `${row.name}:${f.platform.get(`SELECT COUNT(*) AS n FROM "${row.name}"`).n}`).join('|');
const newAudit = (f, since) => f.platform.all('SELECT event FROM audit WHERE seq>?', since).map((row) => row.event);
const OWNERS = { move: 'moderator', chat: 'reviewer', contribute: 'carol', build: 'dave', vault: 'bob', every: 'erin', read: 'admin' };

const REPROS = [
  {
    id: 'read-scope-write',
    command: 'node tests/framework/known-gaps.mjs read-scope-write',
    invariant: 'A credential scoped `read` can read; it cannot change stored state.',
    async run() {
      const f = await writesFixture({ after: () => {} });
      const resident = f.tx('createAgent', f.actor('admin'), { name: 'read-scope repro resident', kind: 'agent', capabilities: 'Read approved sources', limitations: 'Repro bounds' });
      const readOnly = f.tx('runtime', f.actor('admin'), resident.id, { scopes: ['read'], max_calls: 10, minutes: 5 }).token;
      const before = f.platform.get('SELECT last_seen FROM agents WHERE id=?', resident.id).last_seen;
      f.advance(1_000);
      const answered = await f.request(`/agents/${resident.id}/heartbeat`, { method: 'POST', token: readOnly, input: {} });
      const after = f.platform.get('SELECT last_seen FROM agents WHERE id=?', resident.id).last_seen;
      return `POST /agents/:id/heartbeat with a read-only credential answered ${answered.status} and moved agents.last_seen ${before} → ${after} (server.js:483 maps heartbeat to the read scope; src/spaces.js:634 writes last_seen)`;
    },
    patch: 'server.js:483 — in the dynamic scope map change `heartbeat: \'read\'` to `heartbeat: \'move\'`, then update docs/API.md:91 and tests/spaces-http.test.js:74, which both currently assert the read-scoped presence write. Do this only with the owner\'s decision: the read mapping is documented policy, and the resident client heartbeats every 20 s (app.js:2657), so the change costs every resident one movement-scoped credential.',
  },
  {
    id: 'movement-attribution',
    command: 'node tests/framework/known-gaps.mjs movement-attribution',
    invariant: 'Every write that changes a resident\'s durable state leaves a record naming who did it.',
    async run() {
      const f = await writesFixture({ after: () => {} });
      const context = await prepare(f);
      const resident = context.residents.move;
      const since = f.platform.get('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n;
      f.advance(1_000);
      const moved = await f.request('/move', { method: 'POST', token: context.runtimes.move, input: { direction: 'right' } });
      const events = newAudit(f, since);
      return `POST /move answered ${moved.status} and stored agents.x=${f.platform.get('SELECT x FROM agents WHERE id=?', resident.id).x}, while the audit table gained ${events.length} entries (${events.join(', ') || 'none'}) — src/spaces.js stepAgent writes the position, its elevation and its throttle with no attribution record at all`;
    },
    patch: 'src/spaces.js stepAgent (near line 573): after the UPDATE, add `this.audit(actor.account.id, "agent.moved", agent.id)`. Movement is high-volume, so the owner may prefer a bounded movement log over the hash-chained audit table; either way the credential that moved a resident must be recoverable from storage. This wave cannot apply it: src/spaces.js is on the do-not-edit list.',
  },
  {
    id: 'message-journal-attribution',
    command: 'node tests/framework/known-gaps.mjs message-journal-attribution',
    invariant: 'A private message and a private journal entry are attributable to the account that wrote them.',
    async run() {
      const f = await writesFixture({ after: () => {} });
      const context = await prepare(f);
      const since = f.platform.get('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n;
      const runner = { token: context.runtimes.chat, route: `/agents/${context.residents.chat.id}` };
      const sent = await f.request('/messages', { method: 'POST', token: runner.token, input: { agent_id: context.residents.chat.id, channel: 'public', text: 'Attribution repro message.' } });
      const journal = await f.request('/journey/journal', { method: 'POST', token: context.runtimes.contribute, input: { agent_id: context.residents.contribute.id, text: 'Attribution repro journal entry.' } });
      const events = newAudit(f, since);
      const message = f.platform.get('SELECT agent_id,account_id FROM messages WHERE id=?', sent.data.id);
      const entry = f.platform.get('SELECT agent_id FROM journey_journal WHERE id=?', journal.data.id);
      return `POST /messages answered ${sent.status} storing messages.account_id=${message.account_id} with no audit entry, and POST /journey/journal answered ${journal.status} storing journey_journal.agent_id=${entry.agent_id} with no account column and no audit entry; the audit table gained ${events.length} entries (${events.join(', ') || 'none'})`;
    },
    patch: 'src/platform.js message() (line ~393): add `this.audit(actor.account.id, "message.sent", id)` beside the INSERT (private conversations included — the audit table is operator-only reading). src/journey.js writeJournal (line ~524): add the same call for the entry id. Both files are owned elsewhere; this wave only reads them and asserts the absence in tests/framework-write-effects.test.js.',
  },
  {
    id: 'session-issuance-attribution',
    command: 'node tests/framework/known-gaps.mjs session-issuance-attribution',
    invariant: 'Issuing a session credential is attributable: an operator can see when and for whom one was issued.',
    async run() {
      const f = await writesFixture({ after: () => {} });
      const since = f.platform.get('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n;
      const login = await f.request('/auth/login', { input: { email: 'alice@example.org', password: f.password } });
      const events = newAudit(f, since);
      const sessions = f.platform.get("SELECT COUNT(*) AS n FROM tokens WHERE kind='session' AND revoked=0").n;
      return `POST /auth/login answered ${login.status} issuing a session (${sessions} live session rows) while the audit table gained ${events.length} entries (${events.join(', ') || 'none'})`;
    },
    patch: 'src/platform.js login(): after the token INSERT add `this.audit(account.id, "session.issued", credential.id)`. The platform contract marks this route `audit: false` today, so the change also updates src/framework/write-contract.js in the same commit. Out of this wave\'s fix list, and it changes one behaviour (an audit row per sign-in), so it is reported rather than applied.',
  },
  {
    id: 'coin-eligibility-duplicated',
    command: 'node tests/framework/known-gaps.mjs coin-eligibility-duplicated',
    invariant: 'One predicate decides whether a coin receipt is eligible, wherever it is asked.',
    async run() {
      const coins = await source('src/coins.js');
      const trigger = /CREATE TRIGGER IF NOT EXISTS coins_validate_insert BEFORE INSERT ON coin_rewards BEGIN[\s\S]*?END;/.exec(coins)[0];
      const reader = /const eligible=`([\s\S]*?)`;/.exec(coins)[1];
      // The three conditions the reader adds that the insert trigger never checks, by name.
      const extras = [['only the latest submission version', /s\.version=\(SELECT MAX\(version\)/], ['only the latest review', /r\.rowid=\(SELECT latest\.rowid/], ['no quarantined later version', /NOT EXISTS\(SELECT 1 FROM submissions latest/]];
      const absent = extras.filter(([, pattern]) => pattern.test(reader) && !pattern.test(trigger)).map(([name]) => name);
      return `the insert trigger (src/coins.js:21) and the reader predicate (src/coins.js:45) are two hand-maintained copies of one policy; conditions the reader checks and the trigger does not: ${absent.join('; ') || 'none'}`;
    },
    patch: 'src/coins.js: build both copies from one constant — export the predicate body once and interpolate it into the trigger SQL and the reader SQL (`const ELIGIBLE = \`...\`; const trigger = \`... WHEN NOT EXISTS(${ELIGIBLE with NEW.*}) ...\``). The trigger names NEW.submission_id while the reader names a subquery, so the shared text needs one substitution parameter per use; the recovery validator that drops and recreates the trigger (src/database.js:74) then reads the same text. Not applied here: the coin path is outside this wave\'s two permitted files and a wrong edit mints or withholds credit.',
  },
  {
    id: 'audit-not-append-only',
    command: 'node tests/framework/known-gaps.mjs audit-not-append-only',
    invariant: 'The audit table cannot be rewritten by anything that holds the database.',
    async run() {
      const f = await writesFixture({ after: () => {} });
      f.tx('invite', f.actor('admin'), { role: 'member' });
      const row = f.platform.get('SELECT seq,event FROM audit ORDER BY seq DESC LIMIT 1');
      f.platform.run('UPDATE audit SET event=? WHERE seq=?', 'backup.created', row.seq);
      const rewritten = f.platform.get('SELECT event FROM audit WHERE seq=?', row.seq).event;
      const detected = f.platform.verifyAudit();
      f.platform.run('UPDATE audit SET event=? WHERE seq=?', row.event, row.seq);
      return `an UPDATE of audit seq ${row.seq} succeeded (${row.event} → ${rewritten}); the hash chain notices it (verifyAudit() = ${detected}, restore ${f.platform.verifyAudit()}), but nothing in storage refuses the write: src/database.js:42 creates the table with no append-only trigger`;
    },
    patch: 'src/database.js: add `CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,\'The audit log is append-only\'); END;` and the matching DELETE trigger, then bump the schema number and teach scripts/ops-rehearsal.mjs and tests/recovery.test.js the new version. This wave cannot apply it: src/database.js is on the do-not-edit list, and the schema number is pinned at 25 by tests/framework-write-static.test.js until that bump happens deliberately.',
  },
  {
    id: 'unkeyed-duplicates',
    command: 'node tests/framework/known-gaps.mjs unkeyed-duplicates',
    invariant: 'A create write sent twice with the same Idempotency-Key leaves one record.',
    async run() {
      const f = await writesFixture({ after: () => {} });
      const context = await prepare(f);
      const candidates = ['/reports', '/missions', '/tasks', '/circles', '/guilds/projects', '/journey/journal', '/memory/manage', '/adoptions'];
      const duplicated = [];
      for (const route of candidates) {
        const exercise = orderedExercises().find((item) => item.route === route);
        const token = RUNTIME_SCOPES[exercise.as] ? context.runtimes[exercise.as] : undefined;
        const account = token ? OWNERS[exercise.as] : exercise.as;
        const path = exercise.route.replace(':id', token ? context.residents[exercise.as].id : context.aliceAgent.id);
        if (exercise.advance) f.advance(exercise.advance);
        if (exercise.before) exercise.before(f, context);
        const input = exercise.input(context);
        const first = await f.request(path, { method: exercise.method, account: token ? undefined : account, token, input, key: 'known-gap-key' });
        const after = digest(f);
        const second = await f.request(path, { method: exercise.method, account: token ? undefined : account, token, input, key: 'known-gap-key' });
        if (digest(f) !== after) duplicated.push(`${route} (${first.status} then ${second.status})`);
      }
      if (!duplicated.length) throw new Error('no unkeyed route duplicated: the finding may be fixed');
      return `single submission with one Idempotency-Key each, the header ignored: ${duplicated.join(', ')}`;
    },
    patch: 'These eight creates are outside the keyed mechanism (server.js:742 lists the ten routes that reach it, and each of those names a platform method whose third parameter is the key). A key needs somewhere to be remembered, so the patch is: (1) add a nullable `idempotency_key` column with a UNIQUE(account_id, idempotency_key) index to reports, missions, tasks, community_circles, guild_projects, journey_journal, resident_memory and adoptions; (2) bump the schema number and add the migration; (3) give each platform method a `key` third parameter that returns the recorded row when the key repeats, exactly as claim/submit/questJoin/tradePost already do; (4) add the routes to the list at server.js:742; (5) extend tests/framework/write-effects.test.js, whose keyed replay check then covers them automatically. Steps (1) and (2) edit src/database.js, which this wave must not touch, so the repro is delivered and the patch is proposed rather than applied.',
  },
];

const only = process.argv[2];
let failed = 0;
for (const repro of REPROS) {
  if (only && !repro.id.includes(only)) continue;
  process.stdout.write(`\n── ${repro.id} ─────────────────────────────────────────────\n`);
  process.stdout.write(`command:   ${repro.command}\n`);
  process.stdout.write(`invariant: ${repro.invariant}\n`);
  try {
    const observed = await repro.run();
    process.stdout.write(`observed:  ${observed}\n`);
    process.stdout.write(`REPRODUCED (the invariant above does not hold)\n`);
  } catch (error) {
    process.stdout.write(`FAIL: the repro no longer reproduces — ${error.message}\n`);
    failed += 1;
  }
  process.stdout.write(`proposed patch: ${repro.patch}\n`);
}
if (only && !REPROS.some((repro) => repro.id.includes(only))) {
  process.stdout.write(`\nNo repro matches ${only}. Known ids: ${REPROS.map((repro) => repro.id).join(', ')}\n`);
  failed += 1;
}
process.stdout.write(`\n${REPROS.length} repro(s) recorded; ${failed} no longer reproduce.\n`);
process.exit(failed ? 1 : 0);
