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
/** The checker (`nemo-world-check`, from `nemo-world-core`) from THIS stream's build first, falling back to the
 *  older world-stream target; absent on a fresh checkout, so the cross-check skips rather than fails.
 *  `NEMO_WORLD_CHECK` overrides both. */
const CHECKER = [
  process.env.NEMO_WORLD_CHECK,
  join(here, '..', '..', 'target', 'engine', 'release', 'nemo-world-check'),
  join(here, '..', '..', 'target', 'world', 'release', 'nemo-world-check'),
].find((path) => path && existsSync(path)) || null;

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
    t.skip(`the checker is not built; build it with: cd wt/veloren-engine && CARGO_TARGET_DIR=wt/target/engine cargo build --release -p nemo-world-core --bin nemo-world-check`);
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

/**
 * The manifest this stream actually ships (`content/veloren-world-harr.json`), which is the file the
 * Veloren server is pointed at: props on Harr's square and in the workshop's yard, and one furnished
 * interior - the surveyor's hut on the farm field. Both sides have to accept it: NemoWorld's own
 * validator (places, budgets, ops, the anchoring plot) and the game's checker (`nemo-world-check`).
 */
test('the shipped Harr manifest passes NemoWorld and the game', (t) => {
  const shipped = join(here, '..', 'content', 'veloren-world-harr.json');
  const { manifest, errors } = checkManifestFile(shipped);
  assert.deepEqual(errors, [], 'NemoWorld refuses the shipped manifest');
  assert.equal(manifest.site, 'Harr');
  assert.ok(manifest.groups.length >= 3, 'props and an interior');
  const interior = manifest.groups.find((group) => group.id === 'field-hut');
  assert.ok(interior, 'the furnished interior group is there');
  // A room: walls and a roof of fills, a doorway and windows as clears and sprites, furniture inside.
  const kinds = interior.ops.map((op) => op.op);
  for (const kind of ['fill', 'clear', 'sprite', 'foundation']) {
    assert.ok(kinds.includes(kind), `the interior has no ${kind} op`);
  }
  const furniture = interior.ops.filter((op) => op.op === 'sprite'
    && /Bed|Table|Chair|Bookshelf|Hearth|CookingPot|Drawer|Lantern|Crate|Barrel/.test(op.sprite));
  assert.ok(furniture.length >= 10, `the interior is not furnished: ${furniture.length} pieces`);
  for (const group of manifest.groups) {
    assert.ok(group.anchor && typeof group.anchor.plot === 'string',
      `${group.id} is not anchored on a plot of the site`);
  }
  // NemoWorld's atmosphere block is NemoWorld's own clock: four increasing hours within the day, and
  // each of NemoWorld's four phases must fall entirely inside the Veloren day period the bridge names
  // the same way (`common/src/time.rs`: Night before 06:00, Morning to 11:00, Noon to 16:00, Evening
  // to 19:00, Night after). Otherwise a resident would walk the wrong row of her schedule.
  const hours = [manifest.atmosphere.dawn_hour, manifest.atmosphere.day_hour, manifest.atmosphere.dusk_hour, manifest.atmosphere.night_hour];
  assert.deepEqual(hours, [...hours].sort((a, b) => a - b), 'the phase hours must increase');
  const starts = { dawn: hours[0], day: hours[1], dusk: hours[2], night: hours[3] };
  const velorenName = (hour) => (hour < 6 || hour >= 19 ? 'night' : hour < 11 ? 'dawn' : hour < 16 ? 'day' : 'dusk');
  const order = ['dawn', 'day', 'dusk', 'night'];
  order.forEach((phase, index) => {
    const from = starts[phase];
    const to = index === order.length - 1 ? starts.dawn + 24 : starts[order[index + 1]];
    for (let hour = from; hour < to; hour += 0.25) {
      assert.equal(velorenName(hour % 24), phase,
        `NemoWorld's ${phase} reaches ${hour % 24}:00, which Veloren would name ${velorenName(hour % 24)}`);
    }
  });
  assert.equal(manifest.atmosphere.time, true, 'the server pins the time of day to NemoWorld\'s clock');
  assert.equal(manifest.atmosphere.weather, false, 'this server does not set the weather, and the manifest says so');

  if (!existsSync(CHECKER)) {
    t.skip(`the checker is not built; build it with: cd wt/veloren-engine && CARGO_TARGET_DIR=wt/target/engine cargo build --release -p nemo-world-core --bin nemo-world-check`);
    return;
  }
  const out = execFileSync(CHECKER, [shipped], { encoding: 'utf8' });
  assert.match(out, new RegExp(`^OK groups=${manifest.groups.length} blocks=\\d+ sprites=\\d+ lit_sprites=[1-9]\\d* foundation_columns=\\d+`),
    `the game does not accept the shipped manifest: ${out}`);
});
