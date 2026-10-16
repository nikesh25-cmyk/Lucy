// The eight residents' world, checked before the game is ever asked.
//
// The landmark manifest (`content/veloren-world-landmarks.json`) says where each resident walks at
// each of the four schedule phases, using real Harr plots and the roster's own words. This file
// exercises NemoWorld's validator on it, pins the shape the Veloren link config takes, and - when the
// world stream's server has run once and logged its own resolution - checks the manifest against the
// plots world generation actually produced.
//
// The Veloren side of that check belongs to the server: `server/src/sys/nemo_link.rs` turns
// `site` + `plot` + `nth` into a position, and logs every landmark it resolved. Nothing here invents a
// coordinate; the last test reads the positions the server itself logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVING_ROSTER } from '../src/living-world.js';
import { PLACES } from '../src/veloren-ext/world-manifest.js';
import {
  CONFIG_KEYS, LANDMARKS, LANDMARKS_PATH, LIMITS, PHASES, ROLES,
  labelsInUse, linkConfigLandmarks, linkConfigResidents, loadWorldLandmarks, scheduleFor, unmapped, validateWorldLandmarks,
} from '../src/veloren-ext/world-residents.js';

const here = fileURLToPath(new URL('.', import.meta.url));
/** The world stack's own server log: the game's resolution of Harr, from a real run. */
const SERVER_LOG = join(here, '..', '..', 'run', 'world', 'logs', 'veloren-server.log');

const clone = () => JSON.parse(readFileSync(LANDMARKS_PATH, 'utf8'));
const where = (resident, phase) => [resident, phase];

test('the checked-in manifest is one NemoWorld is willing to hand to the game', () => {
  const errors = validateWorldLandmarks(clone());
  assert.deepEqual(errors, [], `NemoWorld refused its own manifest: ${errors.join('; ')}`);
  assert.equal(LANDMARKS.format, 'veloren-world-landmarks-v1');
  assert.equal(LANDMARKS.landmarks.length, 6);
  assert.equal(PLACES.sites.get('Harr').length, 4, "the plots Harr is known to have changed; nothing here may assume more");
});

test('a manifest that asks for anything else is refused, whole, and names the reason', () => {
  const cases = [
    ['the wrong format', (m) => { m.format = 'veloren-world-landmarks-v2'; }, 'format must be'],
    ['a site NemoWorld may not dress', (m) => { m.site = 'Elsewhere'; }, 'is not one NemoWorld may dress'],
    ['a plot Harr does not have', (m) => { m.landmarks[3].plot = 'Tavern'; }, "plot Tavern is not one of Harr's known plots"],
    ['an nth the game does not have', (m) => { m.landmarks[4].nth = 9; }, 'nth must be 0 to 7'],
    ['a radius of zero', (m) => { m.landmarks[0].radius = 0; }, 'radius must be 1 to 24'],
    ['a radius no schedule would fit in', (m) => { m.landmarks[0].radius = 99; }, 'radius must be 1 to 24'],
    ['a duplicate id', (m) => { m.landmarks[1].id = m.landmarks[0].id; }, 'id is used twice'],
    ['two landmarks sharing a label', (m) => { m.landmarks[3].label = 'Library'; }, 'is already carried by'],
    ['two entries on the same structure, undeclared', (m) => { delete m.landmarks[5].shared_with; }, 'without shared_with'],
    ['a shared_with that is a different structure', (m) => { m.landmarks[5].shared_with = 'harr-orchard'; }, 'is a different structure'],
    ['a shared_with that names nothing', (m) => { m.landmarks[5].shared_with = 'nowhere'; }, 'which is not in this file'],
    ['a field NemoWorld does not write', (m) => { m.landmarks[0].x = 15200; }, 'x is not a landmark field'],
    ['a landmark nobody walks to', (m) => { m.landmarks.push({ id: 'harr-spare', label: 'Storehouse', name: 'Harr', site: 'Harr', plot: 'Plaza', nth: 0, radius: 9 }); }, 'is not on any resident\'s schedule'],
    ['a resident the roster does not have', (m) => { m.residents['lw-nobody'] = m.residents['lw-aria']; }, "resident lw-nobody is not one of NemoWorld's living roster"],
    ['a resident with no schedule', (m) => { delete m.residents['lw-kael']; }, 'resident lw-kael has no schedule'],
    ['a phase no schedule has', (m) => { m.residents['lw-lyra'].midnight = { label: 'Library', landmark: 'lyra-house' }; }, 'has a phase midnight'],
    ['a phase with no destination', (m) => { delete m.residents['lw-lyra'].night; }, 'lw-lyra night: no destination'],
    ['a label that is not the roster\'s word', (m) => { m.residents['lw-lyra'].day = { label: 'Market Square', landmark: 'lyra-house' }; }, 'the roster says "Library"'],
    ['a destination with neither a landmark nor an unmapped marker', (m) => { m.residents['lw-aria'].day = { label: 'Orchard' }; }, 'needs a landmark or an explicit unmapped marker'],
    ['a landmark the file does not have', (m) => { m.residents['lw-aria'].day = { label: 'Orchard', landmark: 'harr-orchard-2' }; }, 'is not in this file'],
    ['a landmark whose label is a different word', (m) => { m.residents['lw-lyra'].day = { label: 'Library', landmark: 'harr-workshop' }; }, 'so the bridge would never find it for Library'],
    ['an unmapped label that also names a landmark', (m) => { m.residents['lw-bram'].dawn = { label: 'Harbor', landmark: 'lyra-plaza', unmapped: true, reason: 'r', needed: 'n' }; }, 'unmapped, so it may not name a landmark'],
    ['an unmapped label with no reason', (m) => { delete m.residents['lw-bram'].dawn.reason; }, 'an unmapped label needs a reason'],
    ['an unmapped label with nothing said about what is missing', (m) => { delete m.residents['lw-rowan'].dawn.needed; }, 'needs to say what would be needed'],
    ['an unmapped marker that is not true', (m) => { m.residents['lw-bram'].dawn.unmapped = 'yes'; }, 'unmapped must be true or absent'],
    ['a destination with a field of its own', (m) => { m.residents['lw-lyra'].day.radius = 3; }, 'is not part of a destination'],
    ['the link landmark the Quiet Survey names, dropped', (m) => { m.landmarks = m.landmarks.filter((l) => l.id !== 'lyra-field'); }, 'is missing from this file'],
    ['a link landmark renamed behind the same id', (m) => { m.landmarks[0].name = "Harr's hut"; }, "is named Harr's house, not Harr's hut"],
  ];
  for (const [why, mutate, expected] of cases) {
    const manifest = clone();
    mutate(manifest);
    const errors = validateWorldLandmarks(manifest);
    assert.ok(errors.length > 0, `${why} was accepted`);
    assert.ok(errors.some((error) => error.includes(expected)), `${why}: expected ${JSON.stringify(expected)} in ${JSON.stringify(errors)}`);
  }
  // And the good file, unmutated, still passes - so the cases above are not passing for another reason.
  assert.deepEqual(validateWorldLandmarks(clone()), []);
});

test('the roster decides the schedule: every resident, four phases, in her own words', () => {
  assert.equal(LIVING_ROSTER.length, 8, 'the living roster is no longer eight residents');
  let mapped = 0;
  let missing = 0;
  for (const resident of LIVING_ROSTER) {
    const schedule = scheduleFor(resident.id);
    assert.deepEqual(Object.keys(schedule).sort(), [...PHASES].sort(), `${resident.id} does not have exactly the four phases`);
    for (const phase of PHASES) {
      const slot = schedule[phase];
      const roster_label = resident.destinations[phase].label;
      assert.equal(slot.label, roster_label, `${resident.id} ${phase} is not in the roster's words`);
      if (slot.landmark) {
        mapped += 1;
        // A landmark is only found by the bridge when its label is exactly the roster's word...
        assert.equal(slot.landmark.label, roster_label, `${resident.id} ${phase}`);
        // ...and it has to be a real Harr plot, not something NemoWorld made up.
        assert.equal(slot.landmark.site, 'Harr');
        assert.ok(PLACES.sites.get('Harr').includes(slot.landmark.plot), `${slot.landmark.plot} is not one of Harr's plots`);
        assert.equal(slot.unmapped, null);
      } else {
        missing += 1;
        // An unmapped phase is not a gap in the data: it says what the world does not have.
        assert.ok(slot.unmapped, `${resident.id} ${phase} is neither mapped nor explained`);
        assert.ok(slot.unmapped.reason.length > 20, `${resident.id} ${phase} needs a real reason`);
        assert.ok(slot.unmapped.needed.length > 20, `${resident.id} ${phase} needs to say what would be needed`);
      }
    }
  }
  assert.equal(mapped + missing, 32, 'eight residents times four phases');
  assert.equal(mapped, 28, 'the number of scheduled phases this world can honour');
  assert.equal(missing, 4, 'the number of scheduled phases it cannot');
});

test('the ids the other streams and the Quiet Survey already use keep their meaning', () => {
  const emitted = linkConfigLandmarks();
  const byId = new Map(emitted.map((landmark) => [landmark.id, landmark]));
  // These three ids are named by content/veloren-landmarks.json (the link's post/survey/place roles),
  // by every stream's veloren-link.json and by the Quiet Survey's own objective text. Changing any of
  // their labels or plots would move a quest objective or a travel destination without saying so.
  const existing = [
    { id: 'lyra-house', label: 'Library', name: "Harr's house", site: 'Harr', plot: 'House', nth: 0, radius: 9 },
    { id: 'lyra-field', label: 'Peace Pavilion', name: "Harr's farm field", site: 'Harr', plot: 'FarmField', nth: 0, radius: 9 },
    { id: 'lyra-plaza', label: 'Meeting Hall', name: "Harr's plaza", site: 'Harr', plot: 'Plaza', nth: 0, radius: 9 },
  ];
  for (const landmark of existing) assert.deepEqual(byId.get(landmark.id), landmark, `${landmark.id} changed`);
  for (const role of ROLES) {
    const landmark = byId.get(role.id);
    assert.ok(landmark, `the link's ${role.role} landmark ${role.id} is not in the manifest`);
    assert.equal(landmark.name, role.name);
  }
});

test('the emitted array is exactly the shape the Veloren link config and the server read', () => {
  const emitted = linkConfigLandmarks();
  assert.equal(emitted.length, 6);
  for (const landmark of emitted) {
    assert.deepEqual(Object.keys(landmark), [...CONFIG_KEYS], `${landmark.id} carries fields the config does not read`);
    assert.match(landmark.id, /^[a-z0-9][a-z0-9-]{0,39}$/);
    assert.ok(Number.isInteger(landmark.nth) && landmark.nth <= LIMITS.max_nth);
    assert.ok(landmark.radius > 0);
    // The server resolves a landmark from world generation only when it is given both a site and a
    // plot (server/src/sys/nemo_link.rs:216-228); a landmark missing either is silently left out.
    assert.equal(landmark.site, 'Harr');
    assert.ok(PLACES.sites.get('Harr').includes(landmark.plot));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), emitted, 'the array does not survive a JSON round trip');
  assert.equal(new Set(emitted.map((l) => l.id)).size, emitted.length);
  assert.equal(new Set(emitted.map((l) => l.label)).size, emitted.length, 'the bridge looks a landmark up by label, so labels must be unique');
  // The character map the server matches signed events against: one entry per resident, named as the
  // bridge names the character (the first word of her name).
  assert.deepEqual(linkConfigResidents(), {
    Aria: 'lw-aria', Theron: 'lw-theron', Bram: 'lw-bram', Lyra: 'lw-lyra',
    Kael: 'lw-kael', Selene: 'lw-selene', Vaelen: 'lw-vaelen', Rowan: 'lw-rowan',
  });
});

test('the three labels this world cannot honour are named, explained and not invented', () => {
  const listed = unmapped();
  assert.deepEqual(
    listed.map((item) => `${item.resident_id}:${item.phase}`),
    ['lw-bram:dawn', 'lw-bram:dusk', 'lw-rowan:dawn', 'lw-rowan:dusk'],
  );
  assert.deepEqual([...new Set(listed.map((item) => item.label))].sort(), ['Gateway', 'Harbor', 'Observatory']);
  const labels = labelsInUse();
  for (const label of ['Gateway', 'Harbor', 'Observatory']) {
    assert.equal(labels.get(label), null, `${label} was mapped to something after all`);
    assert.ok(!LANDMARKS.landmarks.some((landmark) => landmark.label === label), `${label} has a landmark it should not have`);
  }
  // Every label the roster uses is present in the map, mapped or explicitly not.
  assert.deepEqual([...labels.keys()].sort(), ['Central Plaza', 'Gateway', 'Harbor', 'Library', 'Meeting Hall', 'Observatory', 'Orchard', 'Peace Pavilion', 'Workshop']);
  assert.equal([...labels.values()].filter(Boolean).length, 6);
});

test('a manifest for one roster is refused for another, so the two cannot drift', () => {
  const two = LIVING_ROSTER.slice(0, 2);
  const errors = validateWorldLandmarks(clone(), { roster: two });
  assert.ok(errors.some((error) => error.includes('lw-bram is not one of')), errors.join('; '));
  // And a file naming a resident who is no longer on the roster is refused too.
  const manifest = clone();
  manifest.residents['lw-old'] = manifest.residents['lw-aria'];
  assert.ok(validateWorldLandmarks(manifest).some((error) => error.includes('lw-old')));
});

test('a file that is not a manifest is refused rather than half-read', () => {
  const directory = mkdtempSync(join(tmpdir(), 'world-landmarks-'));
  const path = join(directory, 'landmarks.json');
  try {
    for (const body of ['not json at all', '[]', '{}', '{"format":"veloren-world-landmarks-v1"}']) {
      writeFileSync(path, body);
      assert.throws(() => loadWorldLandmarks(path));
    }
    writeFileSync(path, JSON.stringify(clone()));
    assert.equal(loadWorldLandmarks(path).landmarks.length, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The game's own answer, read from the last live run of this stream's server. The server resolves each
 * `site` + `plot` + `nth` from world generation and logs every landmark it resolved
 * (`server/src/sys/nemo_link.rs:198-244`), so this test re-derives the same positions the same way and
 * checks the two things NemoWorld cannot check alone: that every plot kind and nth this manifest names
 * really exists in that world, and that no two landmarks' radii overlap. It skips, with the command to
 * produce the log, when the stream has never run.
 */
test('the game agrees: the plots exist, the nth is real, and no two radii overlap', (t) => {
  if (!existsSync(SERVER_LOG)) {
    t.skip(`no server log at ${SERVER_LOG}; run: wt/stack.sh world start, then grep 'has .* plots' wt/run/world/logs/veloren-server.log`);
    return;
  }
  const report = /site Harr \(origin Vec2 \{ x: (\d+), y: (\d+) \}\) has (\d+) plots: (.*)$/m.exec(readFileSync(SERVER_LOG, 'utf8'));
  assert.ok(report, 'the server log has no Harr plot report');
  const origin = { x: Number(report[1]), y: Number(report[2]) };
  const plots = [...report[4].matchAll(/([A-Za-z]+)@\((\d+),(\d+)\)/g)]
    .map((match) => ({ kind: match[1], x: Number(match[2]), y: Number(match[3]) }));
  assert.ok(plots.length >= 4, `only ${plots.length} plots were reported`);
  assert.ok(plots.some((plot) => plot.kind === 'Plaza'), 'Harr has no plaza in this world');
  assert.ok(plots.some((plot) => plot.kind === 'House'), 'Harr has no house in this world');
  assert.ok(plots.some((plot) => plot.kind === 'Workshop'), 'Harr has no workshop in this world');

  // Exactly the server's own rule (nemo_link.rs:221-227): the plots of that kind, nearest the site's
  // origin first, then pick `nth`.
  const resolve = (landmark) => {
    const of_kind = plots
      .filter((plot) => plot.kind === landmark.plot)
      .map((plot) => ({ ...plot, distance: (plot.x - origin.x) ** 2 + (plot.y - origin.y) ** 2 }))
      .sort((a, b) => a.distance - b.distance);
    return of_kind[landmark.nth];
  };
  const resolved = linkConfigLandmarks().map((landmark) => ({ landmark, at: resolve(landmark) }));
  for (const { landmark, at } of resolved) {
    assert.ok(at, `${landmark.id}: this world has no ${landmark.plot} number ${landmark.nth}`);
  }
  // The two farm fields must be two fields, or the orchard and the Peace Pavilion are one place.
  const fields = resolved.filter(({ landmark }) => landmark.plot === 'FarmField');
  assert.equal(fields.length, 2);
  assert.notEqual(`${fields[0].at.x},${fields[0].at.y}`, `${fields[1].at.x},${fields[1].at.y}`, 'both farm fields resolved to one field');

  // A radius that swallows another landmark's centre would make "which of the two am I in?" depend on
  // the order of the config file (nemo_link.rs:554-560 takes the first match).
  for (const a of resolved) {
    for (const b of resolved) {
      if (a === b) continue;
      const shared = LANDMARKS.landmarks.find((l) => l.id === a.landmark.id)?.shared_with === b.landmark.id
        || LANDMARKS.landmarks.find((l) => l.id === b.landmark.id)?.shared_with === a.landmark.id;
      if (shared) continue;
      const distance = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
      assert.ok(distance > a.landmark.radius, `${a.landmark.id} stands inside ${b.landmark.id}'s radius (${distance.toFixed(1)} blocks)`);
      assert.ok(distance > b.landmark.radius, `${b.landmark.id} stands inside ${a.landmark.id}'s radius (${distance.toFixed(1)} blocks)`);
    }
  }
  console.log(`WORLD_RESOLVED ${resolved.map(({ landmark, at }) => `${landmark.id}=${landmark.plot}[${landmark.nth}]@(${at.x},${at.y})`).join(' ')}`);
});
