// The world manifest, checked on both sides.
//
// NemoWorld's validator is the authority on "is this a place NemoWorld asked for?"; the Rust checker
// (`nemo-world-check`, from `nemo-world-core`) is the authority on "can the game build this?". This file
// exercises the first and, when the checker binary exists, runs the second over the same files — the
// cross-check the Rust crate's own documentation asks for, so a manifest NemoWorld accepts is also one the
// game accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_LIMITS, PLACES, checkManifestFile, loadPlaces, validateManifest } from '../src/veloren-ext/world-manifest.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const EVIDENCE = join(here, '..', '..', 'evidence', 'world');
const FIXTURE = join(EVIDENCE, 'manifest-harr-plaza.json');
const BAD = join(EVIDENCE, 'manifest-harr-bad.json');
/** The checker the world stream built; absent on a fresh checkout, so the cross-check skips rather than fails. */
const CHECKER = join(here, '..', '..', 'target', 'world', 'release', 'nemo-world-check');

const clone = (value) => JSON.parse(JSON.stringify(value));
const fixture = () => JSON.parse(JSON.stringify(JSON.parse(execFileSync('cat', [FIXTURE], { encoding: 'utf8' }))));

test('NemoWorld may only dress the places it knows, and a broken places file is refused', (t) => {
  assert.ok(PLACES.sites.get('Harr').includes('Plaza'));
  const directory = mkdtempSync(join(tmpdir(), 'world-places-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (body) => {
    const path = join(directory, 'places.json');
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };
  const good = { format: 'nemo-world-places-v1', sites: [{ name: 'Harr', plots: ['Plaza'] }] };
  assert.ok(loadPlaces(write(good)).sites.has('Harr'));
  for (const body of [
    { format: 'nemo-world-places-v2', sites: [{ name: 'Harr', plots: ['Plaza'] }] },
    { format: 'nemo-world-places-v1', sites: [] },
    { format: 'nemo-world-places-v1', sites: [{ name: '', plots: ['Plaza'] }] },
    { format: 'nemo-world-places-v1', sites: [{ name: 'Harr', plots: [] }] },
    { format: 'nemo-world-places-v1', sites: [{ name: 'Harr', plots: ['Plaza'] }, { name: 'Harr', plots: ['House'] }] },
    'not json at all',
  ]) {
    assert.throws(() => loadPlaces(write(body)));
  }
});

test('the stitched fixture is what NemoWorld means to dress', () => {
  const { manifest, errors } = checkManifestFile(FIXTURE);
  assert.deepEqual(errors, [], `NemoWorld's validator refused its own fixture: ${errors.join('; ')}`);
  assert.equal(manifest.format, 'veloren-world-v1');
  assert.equal(manifest.site, 'Harr');
  assert.equal(manifest.groups.length, 2);
  assert.ok(MANIFEST_LIMITS.max_blocks_total >= 9);
});

test('a manifest that asks for anything else is refused, whole', () => {
  const cases = [
    ['a site NemoWorld may not dress', (m) => { m.site = 'Elsewhere'; }],
    ['a plot NemoWorld does not know', (m) => { m.groups[0].anchor.plot = 'Tavern'; }],
    ['an anchor outside the allowed extent', (m) => { m.groups[0].anchor.dx = 99; }],
    ['an op NemoWorld does not write', (m) => { m.groups[0].ops[0] = { op: 'teleport', at: [1, 1, 1] }; }],
    ['a fill that is too large', (m) => { m.groups[1].ops[3] = { op: 'fill', from: [0, 0, 0], to: [20, 20, 20], kind: 'Earth', rgb: [1, 2, 3] }; }],
    ['a height outside the allowed band', (m) => { m.groups[0].ops[0].at = [1, 1, 99]; }],
    ['a foundation with no depth', (m) => { m.groups[0].ops[2].depth = 0; }],
    ['a group with no ops', (m) => { m.groups[0].ops = []; }],
    ['the wrong format', (m) => { m.format = 'veloren-world-v2'; }],
    ['a duplicate group id', (m) => { m.groups[1].id = m.groups[0].id; }],
    ['an rgb that is not three bytes', (m) => { m.groups[1].ops[1].rgb = [300, 1]; }],
  ];
  for (const [why, mutate] of cases) {
    const manifest = fixture();
    mutate(manifest);
    const errors = validateManifest(manifest);
    assert.ok(errors.length > 0, `${why} was accepted`);
  }
  // The good fixture, unmutated, still passes — so the cases above are not passing for another reason.
  assert.deepEqual(validateManifest(fixture()), []);
});

test('the game agrees: the checker accepts what NemoWorld accepts and refuses what it refuses', (t) => {
  if (!existsSync(CHECKER)) {
    t.skip(`the checker is not built (${CHECKER}); build it with: cd wt/veloren-world && CARGO_TARGET_DIR=wt/target/world cargo build --release -p nemo-world-core --bin nemo-world-check`);
    return;
  }
  const run = (path) => {
    try {
      return { code: 0, out: execFileSync(CHECKER, [path], { encoding: 'utf8' }) };
    } catch (error) {
      return { code: error.status, out: String(error.stdout || '') };
    }
  };
  const good = run(FIXTURE);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /^OK groups=2 blocks=\d+ sprites=\d+ lit_sprites=\d+ foundation_columns=\d+/);
  if (existsSync(BAD)) {
    const bad = run(BAD);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /REJECTED/);
  }
});
