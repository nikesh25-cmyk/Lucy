// Known gaps found while building the content slice — reproducible, deliberately failing, and NOT
// discovered by the test runner.
//
// Why the file name matters: bare `node --test` collects `*.test.js`, `*.test.mjs`, `*-test.*`,
// `*_test.*`, `test-*.*`, `test.*` and anything under a directory literally named `test/`. This file
// is `tests/framework/known-gaps-content.mjs`: the directory is `tests` (not `test`) and the name
// carries no test marker, so `npm test` never loads it and the suite stays green while the defect
// stays reproducible. Run it explicitly:
//
//     node --test tests/framework/known-gaps-content.mjs
//
// Both repros below FAIL on purpose. A failure here is the assertion working, not a regression. Each
// one states its command, the invariant it asserts, the observed behaviour, and who owns the fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import content from '../../src/content.js';
import { RECOVERY_LIMITS } from '../../src/recovery.js';
import { SCENERY_CLASSES, sceneryClass } from '../../src/footprints.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Evidence from the repro, quoted in the failing assertion so the report carries the observation.
let observedConstraintError = '';

/** A sealed mirror of content/ with whatever change the repro needs applied. */
function mirror(change) {
  const directory = mkdtempSync(join(tmpdir(), 'known-gap-content-'));
  cpSync(join(root, 'content'), join(directory, 'content'), { recursive: true });
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  cpSync(join(root, 'scripts/seal-content.mjs'), join(directory, 'scripts/seal-content.mjs'));
  for (const entry of content.entries()) {
    const files = [entry.license?.notice_file, ...content.assets(entry.id, entry.kind).map((asset) => asset.path)].filter(Boolean);
    for (const file of files) {
      if (!existsSync(join(root, file))) continue;
      mkdirSync(join(directory, dirname(file)), { recursive: true });
      cpSync(join(root, file), join(directory, file));
    }
  }
  change(join(directory, 'content'));
  execFileSync(process.execPath, [join(directory, 'scripts', 'seal-content.mjs')], { cwd: directory, stdio: 'pipe' });
  return directory;
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
/** Exactly the clause src/journey.js builds: CHECK(kind IN (...the sealed crop ids...)). */
const cropClause = (ids) => `CHECK(kind IN (${ids.map((id) => `'${id}'`).join(',')}))`;
const cropTable = (ids) => `CREATE TABLE "journey_crops"(agent_id TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, kind TEXT NOT NULL ${cropClause(ids)}, planted_at INTEGER NOT NULL, tended_at INTEGER, harvested_at INTEGER, PRIMARY KEY(agent_id,x,y));`;

test('KNOWN GAP 1 — a seventh crop definition silently forks the persisted schema, and recovery cannot tell the two databases apart', () => {
  // COMMAND
  //   node --test tests/framework/known-gaps-content.mjs
  // INVARIANT
  //   The sealed crop list is persisted as a SQL CHECK clause derived at load time by src/journey.js
  //   (`CHECK(kind IN (${Object.keys(crops)}))`). Growing the crop family therefore changes the schema
  //   a *fresh* database is created with. An existing database keeps the clause it was created with,
  //   because the table is `CREATE TABLE IF NOT EXISTS`. The invariant the project relies on is that
  //   the persisted schema for a given `PRAGMA user_version` is the same everywhere, so
  //   `validateDatabase()` and `RECOVERY_LIMITS.accepted_schema_versions` can decide whether a
  //   database is current. Growth in the crop family must therefore either be refused at validation
  //   time, or be carried by a schema version the recovery check can distinguish.
  // OBSERVED
  //   Neither. The mirror seals a seventh crop happily; a fresh database then accepts a `tuber`
  //   planting while the pre-change database rejects it with a raw SQLite constraint error; and both
  //   databases report `PRAGMA user_version = 25`, which `RECOVERY_LIMITS` accepts.
  // OWNER
  //   Persistence / schema owner. The fix is a migration (add the new kind, or replace the derived
  //   CHECK with a validated reference), which this slice is forbidden to write: "No schema change,
  //   no migration, no new schema version." A content-side workaround would be to stop deriving the
  //   CHECK from the sealed list, but that is a schema change too.
  const liveIds = Object.keys(content.crops());
  assert.equal(liveIds.length, 6, 'the shipped crop family is six definitions');

  // 1. A seventh crop is a legal *content* addition: the sealer accepts it and the resolver returns it.
  const added = mirror((contentRoot) => {
    const base = JSON.parse(readFileSync(join(contentRoot, 'crops', 'grain.json'), 'utf8'));
    const next = { ...base, id: 'tuber', label: 'Tuber', order: 6, rules: { ...base.rules, grow_ms: 3_000_000, yield: { item: 'tuber', quantity: 3 } } };
    writeFileSync(join(contentRoot, 'crops', 'tuber.json'), JSON.stringify(next, null, 2) + '\n');
  });
  const addedIds = readdirSync(join(added, 'content', 'crops')).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, '')).sort();
  assert.equal(addedIds.length, 7, 'the mirror sealed seven crop definitions, so the content layer grew');
  assert.equal(digest(readFileSync(join(added, 'content', 'content-manifest.json'))).length, 64);

  // 2. The persisted schema text therefore differs, while the schema *version* does not.
  const freshClause = cropClause([...liveIds, 'tuber'].sort());
  const existingClause = cropClause([...liveIds].sort());
  assert.notEqual(freshClause, existingClause, 'growth in the crop family changes the CHECK clause a fresh database is built with');
  assert.equal(RECOVERY_LIMITS.schema_version, 25);
  assert.ok(RECOVERY_LIMITS.accepted_schema_versions.includes(25));

  // 3. Two real databases: one built before the change, one built after it. Both claim version 25.
  const fresh = new DatabaseSync(join(added, 'fresh.sqlite'));
  const existing = new DatabaseSync(join(added, 'existing.sqlite'));
  try {
    fresh.exec(cropTable([...liveIds, 'tuber'].sort()));
    fresh.exec('PRAGMA user_version = 25;');
    existing.exec(cropTable([...liveIds].sort()));
    existing.exec('PRAGMA user_version = 25;');
    assert.equal(fresh.prepare('PRAGMA user_version').get().user_version, 25);
    assert.equal(existing.prepare('PRAGMA user_version').get().user_version, 25, 'a content update does not move the schema version');
    const insert = (db) => db.prepare('INSERT INTO journey_crops(agent_id,x,y,kind,planted_at) VALUES (?,?,?,?,?)').run('agent', 4, 7, 'tuber', 1_700_000_000_000);
    // Expected: growth is either refused with a named reason, or the version differs so recovery can
    // see it. Observed: the fresh database accepts the new kind, and the pre-change database raises a
    // raw SQLite CHECK failure.
    assert.doesNotThrow(() => insert(fresh));
    assert.throws(() => insert(existing), (error) => {
      observedConstraintError = String(error.message);
      return /CHECK constraint failed/.test(observedConstraintError);
    });
    assert.match(observedConstraintError, /CHECK constraint failed/, 'the pre-change database rejects a planting of the new kind with an unnamed SQLite error rather than a refusal this project formats');
    // THE ASSERTION. A database that reports the current schema version must carry the schema the
    // current content produces; otherwise a backup of one cannot be restored onto the other and
    // validateDatabase() cannot tell which shape it is looking at. It does not hold, and this line is
    // meant to keep failing until a migration exists.
    assert.equal(
      freshClause,
      existingClause,
      `both databases report PRAGMA user_version ${RECOVERY_LIMITS.schema_version}, which RECOVERY_LIMITS.accepted_schema_versions accepts, but their persisted schema differs:\n` +
        `  fresh (7 crops)    ${freshClause}\n  existing (6 crops) ${existingClause}\n` +
        `Adding a crop definition therefore forks the persisted schema silently. The observed error on the pre-change database was: ${observedConstraintError}`,
    );
  } finally {
    fresh.close();
    existing.close();
    rmSync(added, { recursive: true, force: true });
  }
});

test('KNOWN GAP 2 — the sealed furniture rules and the shared footprint table disagree for most furniture, and nothing cross-checks them', () => {
  // COMMAND
  //   node --test tests/framework/known-gaps-content.mjs
  // INVARIANT
  //   src/footprints.js describes itself as "One source of truth for what stands where", and it is the
  //   table server movement, pathfinding, placement validation and the renderer all read. A sealed
  //   furniture definition also records `rules.walkable` and `rules.footprint`. The two must agree, or
  //   the sealed layer is publishing a claim the running world contradicts — which is exactly the
  //   condition content/README.md promises to record rather than smooth over.
  // OBSERVED
  //   For most furniture the two disagree: the definition says walkable/open while the shared table
  //   classes the type as a blocking `mass`. src/content.js, scripts/seal-content.mjs and
  //   tests/footprints.test.js each check something adjacent and none of them compares the two.
  // OWNER
  //   Content / runtime owner. Not fixed here because either repair changes behaviour beyond this
  //   slice: editing src/footprints.js changes where residents may walk, what pathfinding routes around
  //   and what the renderer blocks, and editing 18 sealed definitions changes what the content layer
  //   publishes and invalidates their notice digests. It is a deliberate decision, not a drive-by fix.
  const furniture = content.entries('furniture');
  const disagreements = furniture
    .filter((entry) => entry.rules?.walkable === true && sceneryClass(entry.id) === 'mass')
    .map((entry) => ({ id: entry.id, declared: `${entry.rules.footprint}/${entry.rules.walkable}`, shared: SCENERY_CLASSES[entry.id] }));
  const agreed = furniture.filter((entry) => (sceneryClass(entry.id) !== 'mass') === (entry.rules?.walkable === true));
  // Observed: 18 of 31 disagree, including every seat, table, shelf, lamp and bed.
  assert.ok(disagreements.length > 0, 'the two sources agree today');
  assert.deepEqual(
    disagreements.map((item) => item.id).slice(0, 6),
    ['bench', 'lamp', 'bookshelf', 'table', 'lantern', 'sculpture'],
    'the disagreement is not a rounding error: it covers the seats, tables, shelves and lamps',
  );
  assert.equal(
    `${disagreements.length} of ${furniture.length} sealed furniture definitions declare walkable/open while src/footprints.js classes them as a blocking mass; ${agreed.length} agree. ` +
      `Server movement, pathfinding, placement validation and the renderer all read the shared table, so the sealed layer is publishing a claim the running world contradicts. ` +
      `No check compares rules.walkable/rules.footprint against SCENERY_CLASSES: src/content.js validates the enum only, the sealer validates shape only, and tests/footprints.test.js never reads content/.`,
    '',
    'a known gap must be recorded rather than true',
  );
});
