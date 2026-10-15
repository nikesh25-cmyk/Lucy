// The authored content families and the validator that refuses a bad manifest by name.
//
// The point of this file is that every refusal an operator can see is reachable from a real manifest,
// that the rules cite the project document they came from, and that the shipped corpus passes all of
// them. A refusal that cannot be triggered is a rule nobody can rely on; a rule without a source is
// an opinion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import content, { CONTENT_FAMILY_OF_KIND, CONTENT_KINDS, createContent } from '../src/content.js';
import {
  ACCESSIBILITY_RULES, CONTENT_FAMILIES, FAMILY_KIND, KIND_FAMILY, MANIFEST_SCHEMA_VERSION, REFUSAL_CODES,
  SITE_KINDS, TERRAIN_TYPES, contrastRatio, formatRefusal, validateContentFamilies, validateContentManifest,
} from '../src/content-manifest.js';
import { SCENERY_CLASSES, TERRAIN_BLOCKING, sceneryClass } from '../src/footprints.js';
import { COUNTRY_VENUE_ASSIGNMENT, PUBLIC_VENUE_PLANS, VENUE_COLUMNS, VENUE_ROWS, getWorldDefinition } from '../world.js';
import { REGIONS } from '../src/civic.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = { entries: content.entries(), notices: { notices: content.notices() } };
const clone = (value) => JSON.parse(JSON.stringify(value));
const shipped = (kind) => content.entries(kind);

// The live shape of every world an authored place claims to reuse, exactly as the publication path
// reads it, so a declaration that would move a saved arrival is checkable here too.
const worlds = new Map();
for (const place of shipped('place')) {
  const id = place.rules.site.world;
  const definition = getWorldDefinition(id);
  worlds.set(id, { columns: definition.columns, rows: definition.rows, start: definition.start, portals: definition.portals.map((portal) => ({ x: portal.x, y: portal.y })) });
}
const validate = (entries, options = {}) => validateContentFamilies({ ...bundle, entries }, { content: resolver, worlds, ...options });
const resolver = content;
/** Every file the seal hashes besides the definitions: the licence notices and the bundled assets. */
function sealedFiles() {
  const files = new Set();
  for (const entry of content.entries()) {
    if (entry.license?.notice_file) files.add(entry.license.notice_file);
    for (const asset of content.assets(entry.id, entry.kind)) files.add(asset.path);
  }
  return [...files];
}
const codesOf = (result) => new Set(result.refusals.map((refusal) => refusal.code));
const rulesOf = (result) => new Set(result.refusals.map((refusal) => refusal.rule));

test('the family schema is frozen, self-consistent and agrees with the kind list the content layer publishes', () => {
  assert.equal(MANIFEST_SCHEMA_VERSION, 1);
  assert.deepEqual(CONTENT_FAMILIES, ['places', 'fixtures', 'activities', 'residents', 'ambient']);
  assert.deepEqual(FAMILY_KIND, { places: 'place', fixtures: 'fixture', activities: 'activity', residents: 'resident', ambient: 'ambient' });
  assert.deepEqual(KIND_FAMILY, { place: 'places', fixture: 'fixtures', activity: 'activities', resident: 'residents', ambient: 'ambient' });
  // The content layer's own copy of the same mapping must not drift from this one.
  assert.deepEqual(CONTENT_FAMILY_OF_KIND, KIND_FAMILY);
  for (const kind of Object.values(FAMILY_KIND)) assert.ok(CONTENT_KINDS.includes(kind), `${kind} is a content kind`);
  for (const [family, kind] of Object.entries(FAMILY_KIND)) assert.equal(KIND_FAMILY[kind], family);
  assert.equal(Object.isFrozen(CONTENT_FAMILIES), true);
  assert.equal(Object.isFrozen(FAMILY_KIND), true);
  assert.equal(Object.isFrozen(ACCESSIBILITY_RULES), true);
  assert.equal(Object.isFrozen(TERRAIN_TYPES), true);
  // The terrain list is the shared table plus the surfaces world.js paints, so it cannot silently
  // lose a blocking type.
  for (const type of TERRAIN_BLOCKING) assert.ok(TERRAIN_TYPES.includes(type), `${type} stays a known terrain`);
  assert.deepEqual(SITE_KINDS, ['country-variant', 'district', 'venue-plan']);
});

test('every refusal code the operator can see is reachable from a real manifest', () => {
  const reachable = new Map();
  const reached = (entries, options) => codesOf(validate(entries, options));
  const places = shipped('place');
  const fixtures = shipped('fixture');
  const residents = shipped('resident');
  const ambient = shipped('ambient');
  const mutate = (entries, id, shape) => entries.map((entry) => entry.id === id ? shape(clone(entry)) : entry);

  // unknown-family and schema-version are manifest-level.
  reachable.set('unknown-family', new Set([validateContentManifest({ schema_version: 1, family: 'monuments', entries: [clone(places[0])] }).refusals[0].code]));
  reachable.set('schema-version', new Set([validateContentManifest({ schema_version: 2, family: 'places', entries: [clone(places[0])] }).refusals[0].code]));

  // missing-field: drop the remit a resident must state.
  reachable.set('missing-field', reached(mutate(shipped('resident'), residents[0].id, (entry) => { delete entry.rules.remit; return entry; })));

  // malformed-field: an order that is not the integer the envelope requires.
  reachable.set('malformed-field', reached(mutate(places, places[0].id, (entry) => { entry.order = null; return entry; })));

  // missing-license: an identifier that is not evidenced in this repository.
  reachable.set('missing-license', reached(mutate(places, places[0].id, (entry) => { entry.license.spdx = 'MIT'; return entry; })));

  // missing-provenance: a CC0 claim with no pinned commit.
  reachable.set('missing-provenance', reached(mutate(places, places[0].id, (entry) => { entry.license.spdx = 'CC0-1.0'; entry.license.commit = null; return entry; })));

  // unresolved-reference: a fixture naming furniture that does not exist.
  reachable.set('unresolved-reference', reached(mutate(fixtures, fixtures[0].id, (entry) => { entry.rules.object = 'not-a-prop'; return entry; })));

  // duplicate-id: the same entry twice in one manifest.
  reachable.set('duplicate-id', reached([...places, clone(places[0])]));

  // id-collision: an authored id that already belongs to another kind.
  reachable.set('id-collision', reached([...places, Object.assign(clone(places[0]), { id: 'bench' })]));

  // footprint-collision: a mass placed inside the walkable plaza band a country venue keeps clear.
  const bandFixture = fixtures.find((entry) => entry.rules.owner === 'terrace-flight-venue' && entry.rules.scenery_class === 'mass');
  reachable.set('footprint-collision', reached(mutate(fixtures, bandFixture.id, (entry) => { entry.rules.tiles = [[20, 12]]; entry.rules.arrangement.count = 1; return entry; })));

  // accessibility: a contrast target below the bar this repository enforces.
  reachable.set('accessibility', reached(mutate(places, places[0].id, (entry) => { entry.rules.accessibility.contrast[0].target = 3; return entry; })));

  // nondeterminism: a schedule whose slots do not strictly increase.
  reachable.set('nondeterminism', reached(mutate(shipped('resident'), residents[0].id, (entry) => { entry.rules.schedule.slots = [8, 4]; return entry; })));

  // independence-claim: a note that asserts official status.
  reachable.set('independence-claim', reached(mutate(places, places[0].id, (entry) => { entry.notes = ['Endorsed by the ministry of Agriculture.']; return entry; })));

  const expected = Object.keys(REFUSAL_CODES).sort();
  assert.deepEqual([...reachable.keys()].sort(), expected, 'every documented code has a real trigger');
  for (const [code, actual] of reachable) assert.ok(actual.has(code), `${code} must be among the codes its trigger produces; got ${[...actual].join(', ')}`);
  for (const code of expected) assert.equal(typeof REFUSAL_CODES[code], 'string', `${code} must be explained for an operator`);
  // An ambient layer that drifts while the profile says nothing moves is also a reduced-motion refusal.
  assert.ok(rulesOf(validate(mutate(shipped('ambient'), ambient[0].id, (entry) => { entry.rules.layers[0].motion = 'drift'; return entry; }))).has('reduced-motion'));
});

test('the shipped authored corpus validates, and the validator agrees with the sealed bundle', () => {
  const result = validate(bundle.entries);
  assert.equal(result.ok, true, result.refusals.map(formatRefusal).join('\n'));
  assert.deepEqual(result.checked, { entries: 31 + 7, families: 5 });
  assert.deepEqual(result.refusals, []);
  // The counts the schema implies are the counts the sealed manifest carries.
  for (const [family, kind] of Object.entries(FAMILY_KIND)) assert.equal(bundle.entries.filter((entry) => entry.kind === kind).length, content.manifest().kinds[kind], `${family} count`);
  assert.equal(content.manifest().entries.length, bundle.entries.length);
});

test('a fixture cannot read the shared footprint table three ways', () => {
  const fixture = shipped('fixture')[0];
  assert.equal(fixture.rules.scenery_class, sceneryClass(fixture.rules.object), 'the declared class is the shared one');
  assert.equal(fixture.appearance.geometry, content.entry(fixture.rules.object, 'furniture').appearance.geometry, 'the fixture draws the sealed builder');
  const wrongClass = validate(bundle.entries.map((entry) => entry.id === fixture.id ? Object.assign(clone(entry), { rules: { ...entry.rules, scenery_class: 'flat' } }) : entry));
  assert.ok(codesOf(wrongClass).has('footprint-collision'));
  assert.ok(rulesOf(wrongClass).has('shared-footprint-table'));
  const wrongBlocks = validate(bundle.entries.map((entry) => entry.id === fixture.id ? Object.assign(clone(entry), { rules: { ...entry.rules, blocks_route: !entry.rules.blocks_route } }) : entry));
  assert.ok(rulesOf(wrongBlocks).has('shared-footprint-table'));
  const wrongFootprint = validate(bundle.entries.map((entry) => entry.id === fixture.id ? Object.assign(clone(entry), { rules: { ...entry.rules, footprint: entry.rules.footprint === 'open' ? 'occupied' : 'open' } }) : entry));
  assert.ok(rulesOf(wrongFootprint).has('sealed-furniture-rule'));
  const wrongGeometry = validate(bundle.entries.map((entry) => entry.id === fixture.id ? Object.assign(clone(entry), { appearance: { ...entry.appearance, geometry: 'not-a-builder' } }) : entry));
  assert.ok(rulesOf(wrongGeometry).has('sealed-furniture-geometry'));
  // An unknown scenery type would fall through the renderer's default branch, so it is refused.
  assert.equal(Object.hasOwn(SCENERY_CLASSES, 'not-a-prop'), false, 'the fixture check would have nothing to compare against');
});

test('the accessibility refusals name the rule and the project document it came from', () => {
  const place = shipped('place')[0];
  const cases = [
    [(entry) => { entry.rules.accessibility.hit_target_px = 32; return entry; }, 'hit-target'],
    [(entry) => { entry.rules.accessibility.min_viewport_px = 320; return entry; }, 'layout-390'],
    [(entry) => { entry.rules.accessibility.contrast[0].foreground = '#f8f6f0'; entry.rules.accessibility.contrast[0].background = '#f2eee4'; return entry; }, 'contrast-text'],
    [(entry) => { entry.rules.motion = 'drift'; entry.rules.accessibility.reduced_motion = 'not-needed'; return entry; }, 'reduced-motion'],
  ];
  for (const [change, rule] of cases) {
    const result = validate(bundle.entries.map((entry) => entry.id === place.id ? change(clone(entry)) : entry));
    const refusal = result.refusals.find((item) => item.rule === rule);
    assert.ok(refusal, `${rule} must be refused by this change: ${result.refusals.map(formatRefusal).join('; ')}`);
    assert.equal(refusal.code, 'accessibility');
    assert.equal(refusal.source, ACCESSIBILITY_RULES[rule].source, `${rule} cites where it comes from`);
    assert.match(formatRefusal(refusal), new RegExp(`\\[${rule}\\]`));
  }
  // A place that moves must hold the still equivalent, and one that does not move must not claim one.
  const still = shipped('place').find((entry) => entry.rules.motion === 'none');
  const claimed = validate(bundle.entries.map((entry) => entry.id === still.id ? Object.assign(clone(entry), { rules: { ...entry.rules, accessibility: { ...entry.rules.accessibility, reduced_motion: 'equivalent-still' } } }) : entry));
  assert.ok(rulesOf(claimed).has('reduced-motion'));
});

test('the contrast the validator measures reproduces the ratios this repository already recorded', () => {
  // The pairs and the ratios printed by tests/mobile-styles.test.js, measured again here with the
  // validator's own arithmetic rather than trusted from the mobile stylesheet.
  const measured = {
    'key label': [4.5, Math.round(contrastRatio('#f6f0d8', '#0a2b25') * 100) / 100],
    'pressed key label': [4.5, Math.round(contrastRatio('#133429', '#e5dea8') * 100) / 100],
    'focus ring on the world': [3, Math.round(contrastRatio('#ded6a5', '#071b19') * 100) / 100],
  };
  assert.deepEqual(measured['key label'], [4.5, 13.26]);
  assert.deepEqual(measured['pressed key label'], [4.5, 9.89]);
  assert.deepEqual(measured['focus ring on the world'], [3, 12.09]);
  assert.equal(contrastRatio('nonsense', '#000000'), null, 'an unmeasurable pair is refused rather than guessed');
  // Every pair an authored place declares is above its rule.
  for (const place of shipped('place')) {
    for (const pair of place.rules.accessibility.contrast) {
      const bar = ACCESSIBILITY_RULES[pair.role === 'text' ? 'contrast-text' : 'contrast-nontext'].minimum;
      assert.ok(contrastRatio(pair.foreground, pair.background) >= bar, `${place.id} ${pair.role} pair`);
    }
  }
});

test('a shared order is refused because the resolver breaks the tie with the runtime locale', () => {
  // The hazard is real: src/content.js sorts by order and then by String.prototype.localeCompare,
  // whose result depends on the collation the runtime was built with. Two locales disagree here.
  const names = ['zulu', 'ängel'];
  const english = [...names].sort((a, b) => new Intl.Collator('en').compare(a, b));
  const swedish = [...names].sort((a, b) => new Intl.Collator('sv').compare(a, b));
  assert.notDeepEqual(english, swedish, 'the two collations order these ids differently, which is why the tie must be refused');
  const fixtures = shipped('fixture');
  const tied = validate(bundle.entries.map((entry) => entry.id === fixtures[1].id ? Object.assign(clone(entry), { order: fixtures[0].order }) : entry));
  const refusal = tied.refusals.find((item) => item.rule === 'order-tiebreak');
  assert.ok(refusal, 'a shared order is refused');
  assert.equal(refusal.code, 'nondeterminism');
  assert.match(refusal.detail, /localeCompare/);
  // And a clock reading, a generated id and a generator call are each refused by name.
  const clocked = validate(bundle.entries.map((entry) => entry.id === shipped('activity')[0].id ? Object.assign(clone(entry), { rules: { ...entry.rules, created_at: 1 } }) : entry));
  assert.ok(rulesOf(clocked).has('no-clock-field'));
  const generated = validate(bundle.entries.map((entry) => entry.id === shipped('activity')[0].id ? Object.assign(clone(entry), { rules: { ...entry.rules, trace: '182e0f2c6d1a4b8f9c3e5d7a0b2c4e6f' } }) : entry));
  assert.ok(rulesOf(generated).has('no-generated-id'));
  const epoch = validate(bundle.entries.map((entry) => entry.id === shipped('activity')[0].id ? Object.assign(clone(entry), { rules: { ...entry.rules, duration_ticks: 1700000000000 } }) : entry));
  assert.ok(rulesOf(epoch).has('no-epoch-value'));
});

test('the six authored places are distinct in structure and content, and each names the machinery it reuses', () => {
  const places = shipped('place');
  // A place's distinctness is its site, its structure vocabulary, and the whole family set it wires.
  const signature = (place) => JSON.stringify([
    place.rules.site.kind, place.rules.site.world, place.rules.site.columns, place.rules.site.rows,
    place.rules.structure.kind, place.rules.structure.terrain, place.rules.structure.water,
    place.rules.fixtures, place.rules.activities, place.rules.residents, place.rules.ambient, place.appearance.color,
  ]);
  assert.equal(new Set(places.map(signature)).size, places.length, 'no two places share a signature');
  assert.equal(new Set(places.map((place) => place.rules.site.kind)).size >= 3, true, 'the corpus covers country, regional and commons venue sites');
  assert.equal(new Set(places.map((place) => place.rules.structure.kind)).size, places.length, 'no two places reuse a structure kind');
  // Every declared site is the live shape, so a content update could not have moved a saved arrival.
  for (const place of places) {
    const live = worlds.get(place.rules.site.world);
    assert.ok(live, `${place.id} names a world that resolves`);
    assert.equal(place.rules.site.columns, live.columns);
    assert.equal(place.rules.site.rows, live.rows);
    assert.deepEqual(place.rules.site.arrival, { x: live.start.x, y: live.start.y });
    assert.equal(place.rules.site.registers_land, false, 'a shared venue registers no land');
    assert.match(place.rules.site.machinery, /world\.js|makeCountry|makeDistrict|makePublicVenue|PUBLIC_VENUE_PLANS|COUNTRY_VENUE_ASSIGNMENT|VENUE_COLUMNS|COUNTRY_VENUE_PLAZA/);
  }
  // The two country variants it binds are the reviewed assignment, not a hash default.
  const assigned = places.filter((place) => place.rules.site.kind === 'country-variant');
  for (const place of assigned) {
    const iso3 = place.rules.site.world.split(':')[1];
    assert.equal(COUNTRY_VENUE_ASSIGNMENT[iso3], place.rules.site.venue, `${place.id} reuses the assigned shape for ${iso3}`);
  }
  // The one venue-plan site matches the shipped plan it names.
  const planned = places.find((place) => place.rules.site.kind === 'venue-plan');
  const plan = PUBLIC_VENUE_PLANS.find((candidate) => candidate.id === planned.rules.site.plan);
  assert.ok(plan, 'the plan exists');
  assert.deepEqual(planned.rules.site.plaza, { x: 9, y: 5, width: 13, height: 13 }, 'the venue plan site records the plan it reuses');
  assert.equal(planned.rules.site.columns, VENUE_COLUMNS);
  assert.equal(planned.rules.site.rows, VENUE_ROWS);
  // The district site names a region record that exists.
  const district = places.find((place) => place.rules.site.kind === 'district');
  assert.ok(REGIONS.some((region) => region.id === district.rules.site.region), 'the district names a real region');
});

test('each country-venue and regional example keeps its hosts independent of any government, ministry or UN body', () => {
  for (const place of shipped('place')) {
    const independence = place.rules.independence;
    assert.equal(independence.fictional, true);
    assert.equal(independence.claims_endorsement, false);
    assert.equal(independence.government_role, false);
    assert.equal(independence.un_role, false);
    assert.match(independence.statement, /not a government, ministry, embassy or United Nations office/);
    assert.match(independence.statement, /asserts endorsement, representation or official status/);
  }
  for (const resident of shipped('resident')) {
    assert.equal(resident.rules.independence.un_role, false);
    assert.match(resident.rules.remit, /Holds no office, signs nothing, and speaks for no country, people or institution\./);
    assert.equal(/official representative|endorsed by|ministry of [A-Z]|united nations/i.test(`${resident.rules.role} ${resident.rules.remit}`), false);
  }
  // An endorsement hidden in a nested label is still refused, and the disclaimer is exempt only when
  // it negates an institution.
  const place = shipped('place')[0];
  const claimed = validate(bundle.entries.map((entry) => entry.id === place.id
    ? Object.assign(clone(entry), { rules: { ...entry.rules, independence: { ...entry.rules.independence, statement: 'Supported by the government of the host country.' } } })
    : entry));
  assert.ok(rulesOf(claimed).has('non-vacuous-disclaimer'));
  const role = validate(bundle.entries.map((entry) => entry.id === shipped('resident')[0].id
    ? Object.assign(clone(entry), { rules: { ...entry.rules, remit: 'The official representative of the ministry of Agriculture.' } })
    : entry));
  assert.ok(rulesOf(role).has('no-endorsement-claim'));
});

test('the sealer refuses an authored entry that contradicts its own family', () => {
  // The sealer is the second gate: it checks the parts of a family envelope that must hold for every
  // entry, independent of the validator. A wrong family label, a reference to nothing and a truthy
  // registers_land are each refused before anything is sealed.
  const cases = [
    ['places', (entry) => { entry.rules.family = 'fixtures'; }, /rules\.family must be "places"/],
    ['fixtures', (entry) => { entry.rules.object = 'not-a-prop'; }, /rules\.object "not-a-prop" is not a furniture definition/],
    ['residents', (entry) => { entry.rules.appearance = 'not-a-sprite'; }, /rules\.appearance "not-a-sprite" is not an appearance definition/],
    ['activities', (entry) => { entry.rules.place = 'not-a-place'; }, /rules\.place "not-a-place" is not a place definition/],
    ['ambient', (entry) => { delete entry.rules.provenance; }, /rules\.provenance\.derived_from must be a non-empty string/],
  ];
  const fixtures = { places: 'terrace-flight-venue', fixtures: 'bench-row', residents: 'venue-steward', activities: 'terrace-tending', ambient: 'highland-morning' };
  for (const [directory, change, pattern] of cases) {
    const mirror = mkdtempSync(join(tmpdir(), 'seal-family-'));
    try {
      cpSync(join(root, 'content'), join(mirror, 'content'), { recursive: true });
      mkdirSync(join(mirror, 'scripts'), { recursive: true });
      cpSync(join(root, 'scripts/seal-content.mjs'), join(mirror, 'scripts/seal-content.mjs'));
      for (const file of sealedFiles()) { mkdirSync(join(mirror, file, '..'), { recursive: true }); cpSync(join(root, file), join(mirror, file)); }
      const path = join(mirror, 'content', directory, `${fixtures[directory]}.json`);
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      change(entry);
      writeFileSync(path, JSON.stringify(entry, null, 2) + '\n');
      let failed = null;
      try { execFileSync(process.execPath, [join(mirror, 'scripts/seal-content.mjs')], { cwd: mirror, stdio: 'pipe' }); }
      catch (error) { failed = error.stderr.toString(); }
      assert.ok(failed, `the sealer must refuse ${directory}/${fixtures[directory]}`);
      assert.match(failed, pattern);
    } finally { rmSync(mirror, { recursive: true, force: true }); }
  }
  // And the unmutated mirror seals, so the refusals above are the change and not the mirror.
  const clean = mkdtempSync(join(tmpdir(), 'seal-clean-'));
  try {
    cpSync(join(root, 'content'), join(clean, 'content'), { recursive: true });
    mkdirSync(join(clean, 'scripts'), { recursive: true });
    cpSync(join(root, 'scripts/seal-content.mjs'), join(clean, 'scripts/seal-content.mjs'));
    for (const file of sealedFiles()) { mkdirSync(join(clean, file, '..'), { recursive: true }); cpSync(join(root, file), join(clean, file)); }
    assert.doesNotThrow(() => execFileSync(process.execPath, [join(clean, 'scripts/seal-content.mjs')], { cwd: clean, stdio: 'pipe' }));
  } finally { rmSync(clean, { recursive: true, force: true }); }
});

test('the validator refuses a saved tile a place or fixture would take', () => {
  const place = shipped('place')[0];
  const occupied = new Set([`${place.rules.site.world}|${place.rules.site.arrival.x},${place.rules.site.arrival.y}`]);
  const result = validate(bundle.entries, { occupied });
  assert.ok(codesOf(result).has('footprint-collision'));
  assert.ok(rulesOf(result).has('saved-land'));
  // A place whose declared grid disagrees with the live world would move saved placements.
  const drifted = validate(bundle.entries.map((entry) => entry.id === place.id ? Object.assign(clone(entry), { rules: { ...entry.rules, site: { ...entry.rules.site, columns: 41 } } }) : entry));
  assert.ok(rulesOf(drifted).has('live-world-shape'));
  const moved = validate(bundle.entries.map((entry) => entry.id === place.id ? Object.assign(clone(entry), { rules: { ...entry.rules, site: { ...entry.rules.site, arrival: { x: 3, y: 3 } } } }) : entry));
  assert.ok(rulesOf(moved).has('live-arrival'), 'a content update may not move a saved arrival');
  // And a created bundle refuses an entry the manifest does not index, so the resolver cannot lie.
  assert.throws(() => createContent({ entries: [...bundle.entries, Object.assign(clone(place), { id: 'unindexed' })], palettes: { schema_version: 1, palettes: { garden: content.palette('garden'), house: content.palette('house'), frontier: content.palette('frontier') } }, notices: { schema_version: 1, notices: content.notices() }, manifest: content.manifest() }), /does not index this definition/);
});

test('the shipped modules that must not read a file or a clock, do not', () => {
  for (const file of ['src/content-manifest.js']) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const forbidden of ['node:fs', 'require(', 'Math.random', 'Date.now', 'process.env', 'globalThis']) {
      assert.equal(source.includes(forbidden), false, `${file} must stay free of ${forbidden}`);
    }
    assert.equal(source.includes("from './footprints.js'"), true, `${file} reads the one shared footprint table`);
  }
  assert.equal(existsSync(join(root, 'src/content-manifest.js')), true);
});
