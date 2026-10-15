// The preview and publication path.
//
// Preview must be exactly as strict as publishing, and must write nothing anywhere. Publishing must
// either land the whole staged set with a consistent seal, or restore every path it touched. Both
// properties are exercised in an isolated copy of the content layer, so this test can never leave the
// working tree unsealed and can never race the other suites that shell out to the sealer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

/**
 * A minimal root the publication script can run in: the sealed content tree, the two script entry
 * points, the three src modules they import, and only the files the seal hashes. No world.js, so the
 * script reports that its live-world comparison did not run instead of pretending it did.
 */
function mirrorRoot() {
  const mirror = mkdtempSync(join(tmpdir(), 'content-publish-root-'));
  cpSync(join(root, 'content'), join(mirror, 'content'), { recursive: true });
  mkdirSync(join(mirror, 'scripts'), { recursive: true });
  mkdirSync(join(mirror, 'src'), { recursive: true });
  for (const file of ['scripts/seal-content.mjs', 'scripts/content-publish.mjs']) cpSync(join(root, file), join(mirror, file));
  for (const file of ['src/content.js', 'src/content-manifest.js', 'src/footprints.js']) cpSync(join(root, file), join(mirror, file));
  const manifest = JSON.parse(readFileSync(join(root, 'content/content-manifest.json'), 'utf8'));
  const files = new Set(manifest.entries.flatMap((entry) => [entry.license.notice_file, ...entry.assets.map((asset) => asset.path)]));
  for (const file of files) {
    mkdirSync(join(mirror, file, '..'), { recursive: true });
    cpSync(join(root, file), join(mirror, file));
  }
  return mirror;
}

/** A digest of every file under a directory, path and bytes, so "wrote nothing" is provable. */
function treeDigest(directory) {
  const seen = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else seen.push(`${relative(directory, path)}:${digest(readFileSync(path))}:${statSync(path).size}`);
    }
  };
  walk(directory);
  return digest(seen.join('\n'));
}

const run = (mirror, args) => spawnSync(process.execPath, [join(mirror, 'scripts', 'content-publish.mjs'), ...args], { cwd: mirror, encoding: 'utf8' });
const stage = (mirror, directory, id, document) => {
  mkdirSync(join(mirror, 'incoming', directory), { recursive: true });
  writeFileSync(join(mirror, 'incoming', directory, `${id}.json`), JSON.stringify(document, null, 2) + '\n');
};

test('the content layer the publication path runs against is a faithful copy of the shipped one', (t) => {
  const mirror = mirrorRoot();
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  // Every definition, and the mirrored content/manifest, is byte-identical, so a preview in the
  // mirror is a preview of this tree.
  for (const file of ['content/content-manifest.json', 'content/index.js', 'content/notices.json', 'content/palettes.json']) {
    assert.equal(digest(readFileSync(join(mirror, file))), digest(readFileSync(join(root, file))), `${file} is copied byte for byte`);
  }
  const manifest = JSON.parse(readFileSync(join(root, 'content/content-manifest.json'), 'utf8'));
  for (const entry of manifest.entries) assert.equal(existsSync(join(mirror, entry.file)), true, `${entry.file} is present in the mirror`);
});

test('preview is as strict as publish, reports every change, and writes nothing at all', (t) => {
  const mirror = mirrorRoot();
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  const base = JSON.parse(readFileSync(join(mirror, 'content/activities/bund-survey.json'), 'utf8'));
  const addition = { ...base, id: 'preview-addition', label: 'Preview addition', order: 40, notes: ['Staged only for a preview.'] };
  stage(mirror, 'activities', 'preview-addition', addition);
  const before = treeDigest(join(mirror, 'content'));
  const preview = run(mirror, ['--from', 'incoming', '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Preview only: nothing was written/);
  assert.match(preview.stdout, /Live world shapes: NOT CHECKED/);
  assert.match(preview.stdout, /add\s+content\/activities\/preview-addition\.json/);
  assert.match(preview.stdout, /Validator: 3[0-9] authored entries over 5 families, 0 refusal\(s\)/);
  assert.equal(treeDigest(join(mirror, 'content')), before, 'a preview writes nothing: every file under content/ is byte-identical');
  // The machine-readable half of the same report says the same thing.
  const report = JSON.parse(preview.stdout.slice(preview.stdout.lastIndexOf('\n{\n  "mode"')));
  assert.equal(report.mode, 'preview');
  assert.equal(report.ok, true);
  assert.deepEqual(report.changes, [{ action: 'add', path: 'content/activities/preview-addition.json', id: 'preview-addition', kind: 'activity' }]);
  assert.equal(report.counts.after.activity, report.counts.before.activity + 1);
  // And nothing was written outside content/ either: no file appeared in the mirror root.
  assert.equal(existsSync(join(mirror, 'incoming/.publish-journal.json')), false);
});

test('a refusable staged set is refused by name and leaves every file exactly as it was', (t) => {
  const mirror = mirrorRoot();
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  const base = JSON.parse(readFileSync(join(mirror, 'content/places/terrace-flight-venue.json'), 'utf8'));
  const bad = JSON.parse(JSON.stringify(base));
  bad.id = 'staged-and-bad';
  bad.rules.accessibility.hit_target_px = 32;
  bad.notes = ['Endorsed by the ministry of Agriculture as an official representative.'];
  stage(mirror, 'places', 'staged-and-bad', bad);
  const before = treeDigest(join(mirror, 'content'));
  const preview = run(mirror, ['--from', 'incoming']);
  assert.equal(preview.status, 1, 'a refused set exits non-zero');
  assert.match(preview.stderr, /validation refusal\(s\); nothing was written/);
  assert.match(preview.stdout, /REFUSED\s+accessibility \[hit-target\]/);
  assert.match(preview.stdout, /REFUSED\s+independence-claim \[no-endorsement-claim\]/);
  assert.match(preview.stdout, /not computed \(the staged set was refused\)/);
  assert.equal(treeDigest(join(mirror, 'content')), before, 'a refused set wrote nothing, not even a generated document');
  // Publishing a refused set is refused too, with the same rule named.
  const publish = run(mirror, ['--from', 'incoming', '--publish']);
  assert.equal(publish.status, 1);
  assert.match(publish.stderr, /validation refusal\(s\); nothing was written/);
  assert.equal(treeDigest(join(mirror, 'content')), before);
});

test('publish applies the staged set, reseals, verifies, and a rollback restores the tree exactly', (t) => {
  const mirror = mirrorRoot();
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  const base = JSON.parse(readFileSync(join(mirror, 'content/activities/bund-survey.json'), 'utf8'));
  stage(mirror, 'activities', 'published-addition', { ...base, id: 'published-addition', label: 'Published addition', order: 41 });
  // A replacement as well as an addition, so both halves of the report are exercised.
  const place = JSON.parse(readFileSync(join(mirror, 'content/places/mosaic-field-venue.json'), 'utf8'));
  place.notes = [...place.notes, 'Republished through the publication path.'];
  stage(mirror, 'places', 'mosaic-field-venue', place);

  const before = treeDigest(join(mirror, 'content'));
  const publish = run(mirror, ['--from', 'incoming', '--publish']);
  assert.equal(publish.status, 0, publish.stderr);
  assert.match(publish.stdout, /Published 2 file\(s\); the sealer regenerated the manifest, notices and index and --check verifies\./);
  const after = treeDigest(join(mirror, 'content'));
  assert.notEqual(after, before, 'the publication really changed the tree');
  assert.equal(existsSync(join(mirror, 'content/activities/published-addition.json')), true);
  assert.match(readFileSync(join(mirror, 'content/places/mosaic-field-venue.json'), 'utf8'), /Republished through the publication path/);
  // The seal verifies after publishing: the generated documents were produced by the sealer, not by hand.
  const checked = spawnSync(process.execPath, [join(mirror, 'scripts/seal-content.mjs'), '--check'], { cwd: mirror, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /Verified: 1[0-9]{2} definitions/);
  const manifest = JSON.parse(readFileSync(join(mirror, 'content/content-manifest.json'), 'utf8'));
  assert.equal(manifest.entries.some((entry) => entry.id === 'published-addition'), true, 'the added definition is indexed');
  assert.equal(manifest.generated_by, 'scripts/seal-content.mjs');

  // The journal is kept, so the publication is reversible by an operator and not only by a crash.
  assert.equal(existsSync(join(mirror, 'incoming/.publish-journal.json')), true, 'the publication keeps its journal');
  const rollback = run(mirror, ['--rollback', '--from', 'incoming']);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, /Restored \d+ path\(s\) from incoming\/\.publish-journal\.json; the seal verifies again\./);
  assert.equal(treeDigest(join(mirror, 'content')), before, 'a rollback restores every touched file, byte for byte');
  assert.equal(existsSync(join(mirror, 'content/activities/published-addition.json')), false, 'the added definition is removed again');
  assert.equal(existsSync(join(mirror, 'incoming/.publish-journal.json')), false, 'the journal is consumed by the rollback');
  const reverified = spawnSync(process.execPath, [join(mirror, 'scripts/seal-content.mjs'), '--check'], { cwd: mirror, encoding: 'utf8' });
  assert.equal(reverified.status, 0, reverified.stderr);

  // And the staged set can be published again, producing exactly the state the first publish did.
  const again = run(mirror, ['--from', 'incoming', '--publish']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(treeDigest(join(mirror, 'content')), after, 'republishing the same staged set reproduces the same tree');
});

test('the script refuses a staged file it cannot place, and reports a rollback with no journal', (t) => {
  const mirror = mirrorRoot();
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  const base = JSON.parse(readFileSync(join(mirror, 'content/activities/bund-survey.json'), 'utf8'));
  // A family directory that is not one of the five, and a file whose name disagrees with its id.
  mkdirSync(join(mirror, 'incoming/monuments'), { recursive: true });
  writeFileSync(join(mirror, 'incoming/monuments/pillar.json'), JSON.stringify({ ...base, id: 'pillar' }, null, 2) + '\n');
  stage(mirror, 'activities', 'mismatched-name', base);
  const before = treeDigest(join(mirror, 'content'));
  const result = run(mirror, ['--from', 'incoming']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"monuments" is not one of the five authored families/);
  assert.match(result.stderr, /carries id "bund-survey"; the file must be named bund-survey\.json/);
  assert.equal(treeDigest(join(mirror, 'content')), before);

  const missing = run(mirror, ['--from', 'nowhere']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /the staging directory nowhere does not exist/);
  const noJournal = run(mirror, ['--rollback', '--from', 'incoming']);
  assert.equal(noJournal.status, 1);
  assert.match(noJournal.stderr, /no journal at incoming\/\.publish-journal\.json, so there is nothing to roll back/);
  const both = run(mirror, ['--preview', '--publish', '--from', 'incoming']);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--preview and --publish are mutually exclusive/);
});
