// Known gaps found while building the Wave 7 reliability slice — reproducible, deliberately failing,
// and NOT discovered by the test runner.
//
// Why the file name matters: bare `node --test` collects `*.test.js`, `*.test.mjs`, `*-test.*`,
// `*_test.*`, `test-*.*`, `test.*` and anything under a directory literally named `test/`. This file
// is `tests/framework/known-gaps-reliability.mjs`: the directory is `tests` (not `test`) and the name
// carries no test marker, so `npm test` never loads it and the suite stays green while the defect stays
// reproducible. Run it explicitly:
//
//     node --test tests/framework/known-gaps-reliability.mjs
//
// Both repros below FAIL on purpose. A failure here is the assertion working, not a regression. Each
// one states its command, the invariant it asserts, the observed behaviour, and who owns the fix.
//
// Every database in this file is disposable: a private temporary directory that is removed before the
// test finishes. The shipped data directory, any running world, installed credentials and model
// weights are never opened.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import content from '../../src/content.js';
import { openDatabase } from '../../src/database.js';
import { worldContentChecksCurrent } from '../../src/schema24.js';
import { RECOVERY_LIMITS } from '../../src/recovery.js';
import { Platform } from '../../src/platform.js';
import { createApp } from '../../server.js';

const temporary = () => mkdtempSync(join(tmpdir(), 'known-gap-reliability-'));
/** The stored CHECK clause of journey_crops, exactly as `sqlite_schema` keeps it. */
const storedCropClause = (db) => db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='journey_crops'").get()?.sql.match(/CHECK\(kind IN \(([^)]*)\)\)/)?.[1] ?? '';
const withDisposableInstall = async (run) => {
  const directory = temporary();
  try { return await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('KNOWN GAP 1 — a content release that adds a crop changes the persisted schema of PRAGMA user_version 25, and the shipped open path then refuses an existing public world with no migration to offer', async () => {
  // COMMAND
  //   node --test tests/framework/known-gaps-reliability.mjs
  // INVARIANT
  //   `src/journey.js` persists the sealed crop family as a SQL CHECK clause derived at load time
  //   (`CHECK(kind IN (${Object.keys(crops)}))` — src/journey.js:106) and the table is created with
  //   `CREATE TABLE IF NOT EXISTS`. The persisted schema that a given `PRAGMA user_version` stands for
  //   must therefore be the same everywhere: recovery (`validateDatabase`, `RECOVERY_LIMITS.
  //   accepted_schema_versions`) decides whether a database is current from the version alone, and a
  //   backup of one schema-25 world is expected to restore onto another. Growing the sealed crop family
  //   has to be either refused at validation time, or carried by a schema version the recovery check can
  //   distinguish.
  // OBSERVED
  //   Neither. The clause is derived from the live sealed list, so the schema a *fresh* database is
  //   built with moves the moment a seventh crop is authored, while the version stays 25. Two databases
  //   both reporting `user_version = 25` then carry different `journey_crops` definitions. The Wave 6
  //   slice established that fork with two hand-built `DatabaseSync` objects. This repro adds the part
  //   that matters operationally and that the earlier repro could not show, because it never went
  //   through the shipped open path: `openDatabase()` does NOT accept the pre-change world. It throws
  //   `Stored world content constraints are incomplete.`, because `sourceVersion < 24` is false and
  //   `worldContentChecksCurrent(db)` therefore compares the stored clause against the new list and
  //   fails. So the fork is real but fail-closed: an existing public world cannot be upgraded to a
  //   release that adds a crop kind at all, and the operator is given one generic sentence and no
  //   migration to run.
  // OWNER
  //   Persistence / schema owner. The fix is a migration that widens the stored clause from the sealed
  //   list on open for `sourceVersion === 25`, exactly as `widenWorldContentChecks()` (src/schema24.js)
  //   already does for `sourceVersion < 24`, plus either a refusal with a named reason or a schema
  //   version in `RECOVERY_LIMITS.accepted_schema_versions` that recovery can tell apart. Wave 7 may not
  //   write it: "No schema change, no migration, no new schema version (26 belongs to a sibling
  //   branch)." A content-side workaround would be to stop deriving the CHECK from the sealed list, which
  //   is a schema change too.

  await withDisposableInstall(async (directory) => {
    const database = join(directory, 'world.sqlite');
    const sealedCrops = [...Object.keys(content.crops())];
    assert.equal(sealedCrops.length, 6, 'the shipped crop family is six definitions on this tip');

    // 1. The clause really is derived from the sealed family, so authoring a crop moves the schema a
    //    fresh database is built with. Read the shipped CREATE TABLE text and compare it with the list.
    const fresh = openDatabase(database);
    const freshClause = storedCropClause(fresh);
    const derivedFromSealed = new RegExp(`^${sealedCrops.map((kind) => `'${kind}'`).join(',')}$`).test(freshClause);
    fresh.close();
    assert.ok(derivedFromSealed, `the stored journey_crops clause is exactly the sealed crop list: ${freshClause}`);
    assert.equal(RECOVERY_LIMITS.schema_version, 25);

    // 2. A world written before the seventh crop was authored: the same schema version, the narrower
    //    clause. This is what every already-running public world looks like after such a release.
    const before = new DatabaseSync(database);
    const narrower = sealedCrops.slice(0, sealedCrops.length - 1).map((kind) => `'${kind}'`).join(',');
    before.exec('PRAGMA foreign_keys=OFF; DROP VIEW IF EXISTS calling_source_events; DROP TRIGGER IF EXISTS calling_receipts_validate_insert;');
    before.exec(`CREATE TABLE jc_before(agent_id TEXT NOT NULL REFERENCES agents(id),x INTEGER NOT NULL,y INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN (${narrower})),planted_at INTEGER NOT NULL,tended_at INTEGER,harvested_at INTEGER,PRIMARY KEY(agent_id,x,y));
      INSERT INTO jc_before SELECT * FROM journey_crops; DROP TABLE journey_crops; ALTER TABLE jc_before RENAME TO journey_crops;`);
    const beforeClause = storedCropClause(before);
    assert.equal(before.prepare('PRAGMA user_version').get().user_version, 25, 'a content release does not move the schema version');
    assert.equal(worldContentChecksCurrent(before), false, 'the pre-change world no longer matches the shipped content constraints');
    before.close();

    // 3. The shipped open path refuses it, and nothing offers a migration.
    let refusal = null;
    try { openDatabase(database).close(); } catch (error) { refusal = error.message; }
    assert.equal(refusal, 'Stored world content constraints are incomplete.', `an existing schema-25 public world is refused on open: ${refusal}`);

    // THE ASSERTION. One schema version must mean one persisted schema. It does not, and this line is
    // meant to keep failing until a migration (or a distinguishing version) exists.
    assert.equal(
      freshClause,
      beforeClause,
      `both databases report PRAGMA user_version ${RECOVERY_LIMITS.schema_version}, which RECOVERY_LIMITS.accepted_schema_versions accepts, but their persisted journey_crops schema differs:` +
        `\n  fresh database (${sealedCrops.length} crops)  CHECK(kind IN (${freshClause}))` +
        `\n  existing world (${sealedCrops.length - 1})  CHECK(kind IN (${beforeClause}))` +
        `\nAdding a crop definition therefore forks the persisted schema. The shipped open path refuses the existing world with: "${refusal}"` +
        `\nThere is no migration for sourceVersion 25, so a content release that adds a crop kind cannot be rolled out to a world that is already running.`,
    );
  });
});

test('KNOWN GAP 2 — a resident runtime credential can print arbitrary free text onto the administrator diagnostics, and the shipped redaction rules cannot name it', async () => {
  // COMMAND
  //   node --test tests/framework/known-gaps-reliability.mjs
  // INVARIANT
  //   docs/OPERATIONS.md §10 promises that an operational log or diagnostics response never contains a
  //   session or runtime token, a stored password digest, a contact address, a private message or
  //   journal text, or a private artifact. `POST /api/v1/jobs` is the one route a *runtime* credential
  //   — the least trusted actor in the system, the credential an autonomous resident run uses — writes
  //   free text through, and `platform.operations()` publishes that text back to every administrator.
  //   Nothing a caller supplies should be published verbatim by the administrator surface.
  // OBSERVED
  //   Wave 7 closed the objectively dangerous half: the operations payload's caller-supplied rows now go
  //   through the same value scrub the diagnostics payload uses, so a token, a `salt:key` password digest
  //   and a contact address written into a job's summary are replaced before an administrator sees them
  //   (asserted below, and passing). What is left is the narrative half. `redactDiagnostics` only drops a
  //   field whose final word names narrative content (recovery.js CONTENT_FIELD), and the field is called
  //   `detail`, so an arbitrary marker — a private message, a journal line, a prompt excerpt — is
  //   published unchanged. The scrub is value-shaped, not provenance-aware.
  // OWNER
  //   Operations-surface owner, with one line in the persistence/redaction owner's file. Two repairs are
  //   possible and this slice may write neither. (a) Drop the run summary from the administrator listing
  //   — `platform.operations()` would return `SELECT id,agent_id,status,created_at FROM jobs` instead of
  //   `SELECT * FROM jobs`, which changes a documented payload shape and the /operations consumers. (b)
  //   Add the field name to the redaction rules in `src/recovery.js` — extend CONTENT_FIELD to match a
  //   trailing `detail|summary|summaries|receipt|receipts` when the field carries text. That file is
  //   explicitly off-limits for this slice ("NEVER edit: … src/recovery.js"), so the patch below is a
  //   proposal, not a change:
  //
  //     const CONTENT_FIELD = /(?:^|_)(?:messages?|…|passages?|details?|summar(?:y|ies)|receipts?)$/i;
  //
  //   and then `platform.operations()` must pass the `jobs` rows through `redactDiagnostics` — which this
  //   slice already does — so the widened rule takes effect. The same question applies to
  //   `accounts.name`, which is caller-supplied at registration and is bounded but not narrative-checked.

  await withDisposableInstall(async (directory) => {
    const PRIVATE_MARKER = 'WAVE7-KNOWN-GAP-PRIVATE-MARKER-8712';
    const CONTACT = 'known-gap-contact@reliability.invalid';
    const platform = new Platform(join(directory, 'world.sqlite'));
    const app = createApp({ platform, backupDir: join(directory, 'backups'), mayorModel: async () => '{"action":"wait"}' });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
    try {
      const admin = await platform.register({ name: 'Known gap administrator', email: 'known-gap-admin@reliability.invalid', password: 'known-gap-password-2026', consent: true });
      platform.run("UPDATE accounts SET role='admin' WHERE id=?", admin.account.id);
      const member = await platform.register({ name: 'Known gap member', email: CONTACT, password: 'known-gap-password-2026', consent: true });
      const actor = platform.authenticate(member.token);
      const agent = platform.transaction(() => platform.createAgent(actor, { name: 'Known gap resident', capabilities: 'Fixture only', limitations: 'Fixture only' }));
      const runtime = platform.transaction(() => platform.runtime(actor, agent.id, { scopes: ['contribute'], minutes: 5, max_calls: 10 }));
      // A resident's runtime credential writes its own run summary, and it may put anything in it.
      const posted = await fetch(`${base}/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', detail: `Run summary: token=${runtime.token} contact=${CONTACT} note=${PRIVATE_MARKER}` }) });
      assert.equal(posted.status, 201, 'a runtime credential may report its own run summary');
      const operations = await (await fetch(`${base}/operations`, { headers: { Authorization: `Bearer ${admin.token}` } })).text();

      // The half Wave 7 closed: no credential and no contact address reaches an administrator.
      assert.equal(operations.includes(runtime.token), false, 'the caller-supplied runtime token is scrubbed from the administrator payload');
      assert.equal(operations.includes(CONTACT), false, 'the caller-supplied contact address is scrubbed from the administrator payload');
      assert.equal(/\b[0-9a-f]{64}\b/.test(operations), false, 'no 64-character hex value survives in the administrator payload');
      const detail = JSON.parse(operations).jobs[0].detail;

      // THE ASSERTION. A caller-supplied free-text field is published verbatim, so any narrative a
      // resident chooses is shown to every administrator. Meant to keep failing until the field is
      // either dropped from the listing or named by the redaction rules.
      assert.equal(
        operations.includes(PRIVATE_MARKER),
        false,
        `POST /api/v1/jobs is writable by a runtime credential and its free text is published verbatim to administrators, so no narrative rule can be stated for it.` +
          `\n  an administrator reads the job summary as: ${detail}` +
          `\n  redactDiagnostics drops a field only when its NAME names cryptographic material or its FINAL WORD names narrative content; this field is called "detail".` +
          `\n  proposed patch: widen CONTENT_FIELD in src/recovery.js to a trailing detail|summary|summaries|receipt|receipts (off-limits to this slice), or stop selecting "detail" in platform.operations().`,
      );
    } finally {
      await app.stopWorkers();
      await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
      platform.close();
    }
  });
});
