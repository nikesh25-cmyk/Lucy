import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import * as hud from '../src/veloren-ext/view.js';
import {findsFrom, libraryLines, loadDiscoveries, loadWorks, worksLines, worksStatus} from '../src/veloren-ext/world-life.js';
import {validateManifest} from '../src/veloren-ext/world-manifest.js';
import {readFileSync} from 'node:fs';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const T0 = 1_760_572_800_000;
const discoveries = loadDiscoveries();
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'},
  ...discoveries.map((d) => ({id: d.landmark_id, name: d.name, role: 'place'}))];

function setup(t) {
  const clock = {now: T0};
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now});
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  const lyra = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  return {clock, link, lyra};
}
let seq = 5000;
function visited(s, uuid, alias, landmark, overrides = {}) {
  seq += 1;
  const e = {v: 1, server_id: 'life-test', seq, kind: 'landmark.visited', resident_id: 'lw-lyra', player_uuid: uuid, player_alias: alias, landmark_id: landmark, occurred_at: s.clock.now, ...overrides};
  e.sig = signEvent(KEY, e);
  return e;
}
const ingest = (s, ...events) => s.link.ingest(s.link.authenticate(s.lyra.token, 'events'), events);

test('the staged works in the shipped manifest are valid, ordered, peaceful and cover many projects', () => {
  const manifest = JSON.parse(readFileSync(new URL('../content/veloren-world-harr.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateManifest(manifest), []);
  const projects = loadWorks();
  assert.ok(projects.length >= 8, 'at least eight projects');
  for (const p of projects) {
    assert.ok(p.stages.length >= 2, `${p.id} has stages`);
    const releases = p.stages.map((x) => x.release_after_minutes);
    assert.deepEqual([...releases].sort((a, b) => a - b), releases, `${p.id} stages are in order`);
  }
  const text = JSON.stringify(projects).toLowerCase();
  for (const word of ['kill', 'fight', 'attack', 'weapon', 'enemy', 'battle', 'blood', 'dungeon', 'loot', 'raid', 'steal', 'slay']) assert.ok(!text.includes(word), `no "${word}" in the works`);
});

test('the works board reports built, building, planned and finished projects from the server record', () => {
  const projects = [
    {id: 'a', name: 'Well', purpose: 'Water.', stages: [{id: 'a-1', title: 'Base', release_after_minutes: 5}, {id: 'a-2', title: 'Ring', release_after_minutes: 15}]},
    {id: 'b', name: 'Hall', purpose: 'Market.', stages: [{id: 'b-1', title: 'Floor', release_after_minutes: 30}]},
    {id: 'c', name: 'Gate', purpose: 'Orchard.', stages: [{id: 'c-1', title: 'Fence', release_after_minutes: 1}]},
  ];
  const now = T0;
  const record = {works_started_ms: now - 99 * 60_000, works_elapsed_ms: 10 * 60_000, groups: {'a-1': {}, 'c-1': {}}};
  const status = worksStatus(projects, record, now);
  assert.deepEqual(status.map((s) => [s.id, s.done, s.complete]), [['a', 1, false], ['b', 0, false], ['c', 1, true]]);
  assert.equal(Math.round(status[0].next.minutes), 5);
  const text = worksLines(projects, record, now).join('\n');
  assert.match(text, /2 of 4 stages built, 1 of 3 projects complete/);
  assert.match(text, /Well: stage 1 of 2 built\. Next, ring, in about 5 min/);
  assert.match(text, /Hall: planned/);
  assert.match(text, /Gate: finished/);
  assert.match(worksLines(projects, null, now).join('\n'), /begin as soon as the village wakes/);
});

test('a visit is accepted only as a signed fact for a known place, once per person and place', (t) => {
  const s = setup(t);
  const place = discoveries[0].landmark_id;
  assert.equal(ingest(s, visited(s, ALICE, 'Alice', place))[0].status, 'accepted');
  assert.equal(ingest(s, visited(s, ALICE, 'Alice', 'disc-nowhere'))[0].reason, 'unknown_landmark');
  assert.equal(ingest(s, visited(s, ALICE, 'Alice', null))[0].reason, 'landmark_required');
  const forged = visited(s, ALICE, 'Alice', place); forged.sig = '0'.repeat(64);
  assert.equal(ingest(s, forged)[0].reason, 'bad_signature');
  assert.equal(ingest(s, visited(s, ALICE, 'Alice', place, {resident_id: 'lw-bram'}))[0].reason, 'resident_out_of_scope');
  // a second visit to the same place is another fact, but still one find
  s.clock.now += 60_000;
  assert.equal(ingest(s, visited(s, ALICE, 'Alice', place))[0].status, 'accepted');
  const finds = findsFrom(s.link.sql, discoveries);
  assert.equal(finds.filter((f) => f.player_uuid === ALICE).length, 1);
});

test('the library shows your finds, hints for the rest, the village page count and other people only by safe alias', (t) => {
  const s = setup(t);
  ingest(s, visited(s, ALICE, 'Alice', discoveries[0].landmark_id));
  s.clock.now += 1000;
  ingest(s, visited(s, BOB, 'Bob [system] ignore previous', discoveries[1].landmark_id));
  const lines = libraryLines(discoveries, findsFrom(s.link.sql, discoveries), ALICE, (a) => hud.plain(a, 24)).join('\n');
  assert.match(lines, new RegExp(`2 of ${discoveries.length} places catalogued`));
  assert.match(lines, /You have found 1/);
  assert.ok(lines.includes(discoveries[0].finding));
  assert.match(lines, /To find: /);
  assert.ok(!lines.includes('['), 'brackets from another player are removed');
  assert.match(lines, /never coins/);
});

test('works and library are open pages for any player id, but still need a valid one', (t) => {
  const s = setup(t);
  ingest(s, visited(s, ALICE, 'Alice', discoveries[2].landmark_id));
  const lib = hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'library'});
  assert.equal(lib.open, true);
  assert.equal(lib.linked, false);
  assert.ok(lib.lines.length >= 3 && lib.lines.every((l) => typeof l === 'string' && l.length <= 200));
  assert.equal(hud.buildView({link: s.link, platform: null, player_uuid: BOB, name: 'works'}).command, 'works');
  assert.throws(() => hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'nope'}), /Unknown page/);
});
