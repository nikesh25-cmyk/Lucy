import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import {loadPantry, pantryLines, PANTRY_POLICY, take} from '../src/veloren-ext/pantry.js';
import {loadWorks, worksLines} from '../src/veloren-ext/world-life.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const T0 = 1_760_572_800_000;
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}];

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'veloren-pantry-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const clock = {now: T0};
  const commandsPath = join(directory, 'commands.jsonl');
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, commandsPath, extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  const lyra = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  return {clock, link, lyra, commandsPath};
}
const commandsIn = (s) => readFileSync(s.commandsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
let seq = 9000;
function answer(s, cmd_id, kind, player = ALICE) {
  seq += 1;
  const e = {v: 1, server_id: 'pantry-test', seq, kind, resident_id: 'lw-lyra', player_uuid: player, player_alias: 'Alice', landmark_id: cmd_id, occurred_at: s.clock.now};
  e.sig = signEvent(KEY, e);
  return s.link.ingest(s.link.authenticate(s.lyra.token, 'events'), [e])[0];
}

test('the pantry allow-list is plain food, small amounts, and matches the game server copy', () => {
  const pantry = loadPantry();
  const fingerprint = [...pantry.items.values()].map((e) => `${e.key}=${e.item}*${e.qty}`).sort().join(';');
  assert.equal(fingerprint, 'apple=common.items.food.apple*2;carrot=common.items.food.carrot*2;cheese=common.items.food.cheese*1;lettuce=common.items.food.lettuce*2');
  for (const e of pantry.items.values()) assert.ok(e.qty <= 3 && e.item.startsWith('common.items.food.'));
});

test('a take issues one signed pantry_give for a listed food, reserves it, and the shelf drops only when the game confirms', (t) => {
  const s = setup(t);
  const before = pantryLines(s.link, ALICE).join(' ');
  assert.match(before, /apples/);
  const result = take(s.link, {player_uuid: ALICE, item: 'apple', alias: 'Alice'});
  assert.equal(result.issued, true);
  const [command] = commandsIn(s);
  assert.equal(command.kind, 'pantry_give');
  assert.equal(command.player_uuid, ALICE);
  const args = JSON.parse(command.args);
  assert.deepEqual(Object.keys(args).sort(), ['item', 'order', 'qty']);
  assert.equal(args.item, 'apple'); assert.equal(args.qty, 2);
  // reserved, not yet gone
  const shelf = () => s.link.sql.get("SELECT units FROM pantry_shelf WHERE item='apple'").units;
  assert.equal(shelf(), 12);
  assert.equal(answer(s, command.cmd_id, 'command.applied').status, 'accepted');
  pantryLines(s.link, ALICE); // settles
  assert.equal(shelf(), 10);
  assert.equal(s.link.sql.get('SELECT state FROM pantry_takes WHERE cmd_id=?', command.cmd_id).state, 'delivered');
});

test('a refused delivery (full bag) returns the reservation and costs nothing', (t) => {
  const s = setup(t);
  take(s.link, {player_uuid: ALICE, item: 'carrot'});
  const [command] = commandsIn(s);
  answer(s, command.cmd_id, 'command.rejected');
  pantryLines(s.link, ALICE);
  assert.equal(s.link.sql.get("SELECT units FROM pantry_shelf WHERE item='carrot'").units, 9);
  assert.equal(s.link.sql.get('SELECT state FROM pantry_takes WHERE cmd_id=?', command.cmd_id).state, 'rejected');
  // and it does not count against the person's share for the day
  for (let i = 0; i < PANTRY_POLICY.per_player_per_day; i += 1) assert.equal(take(s.link, {player_uuid: ALICE, item: 'carrot'}).issued, true);
});

test('nobody can take more than their share a day, unknown foods are refused, and the shelf can run dry', (t) => {
  const s = setup(t);
  for (let i = 0; i < PANTRY_POLICY.per_player_per_day; i += 1) assert.equal(take(s.link, {player_uuid: ALICE, item: 'apple'}).issued, true);
  const over = take(s.link, {player_uuid: ALICE, item: 'apple'});
  assert.equal(over.issued, false);
  assert.match(over.lines.join(' '), /your share for today/);
  assert.equal(take(s.link, {player_uuid: BOB, item: 'sword'}).issued, false);
  assert.equal(take(s.link, {player_uuid: BOB, item: '../../etc'}).issued, false);
  // cheese: cap 6, starts at 3, one per take: Bob and others empty it
  const other = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
  const results = other.map((p) => take(s.link, {player_uuid: p, item: 'cheese'}).issued);
  assert.deepEqual(results, [true, true, true, false]);
  assert.equal(commandsIn(s).filter((c) => c.kind === 'pantry_give').length, PANTRY_POLICY.per_player_per_day + 3);
});

test('restocking is capped and never replays absence', (t) => {
  const s = setup(t);
  pantryLines(s.link, ALICE);
  s.clock.now += 1000 * 3_600_000; // a very long absence
  pantryLines(s.link, ALICE);
  assert.equal(s.link.sql.get("SELECT units FROM pantry_shelf WHERE item='apple'").units, PANTRY_POLICY.restock.apple.cap);
});

test('the works board names a stage that waits for a crew, and every crewed site has a crew at some hour of the day', () => {
  const projects = [{id: 'a', name: 'Well', purpose: 'Water.', stages: [{id: 'a-1', title: 'Base', release_after_minutes: 5}, {id: 'a-2', title: 'Ring', release_after_minutes: 15}]}];
  const record = {works_started_ms: T0 - 30 * 60_000, groups: {'a-1': {}}, waiting: {'a-2': 'needs a crew: 1 of 2 nearby'}};
  assert.match(worksLines(projects, record, T0).join('\n'), /waits for a crew \(1 of 2 nearby\)\. Join the builders/);
  const manifest = JSON.parse(readFileSync(new URL('../content/veloren-world-harr.json', import.meta.url), 'utf8'));
  const villagers = JSON.parse(readFileSync(new URL('../content/veloren-villagers.json', import.meta.url), 'utf8')).residents;
  const extra = JSON.parse(readFileSync(new URL('../content/veloren-landmarks-extra.json', import.meta.url), 'utf8')).landmarks;
  const siteOf = {well: 'Well Site', 'market-hall': 'Market Hall Site', 'cottage-1': 'Cottage Row', 'cottage-2': 'Cottage Row', 'cottage-3': 'Cottage Row', observatory: 'Observatory Site', 'field-pavilion': 'Pavilion Site', 'library-annex': 'Annex Site', 'orchard-gate': 'Orchard Gate'};
  const crewed = new Map();
  for (const g of manifest.groups) if (g.crew) crewed.set(g.project, Math.max(crewed.get(g.project) || 0, g.crew));
  for (const [project, crew] of crewed) {
    const label = siteOf[project];
    assert.ok(label && extra.some((l) => l.label === label), `${project} has a work-site landmark`);
    const best = Math.max(...['dawn', 'day', 'dusk'].map((phase) => villagers.filter((v) => v.destinations[phase].label === label).length));
    assert.ok(best >= crew, `${project}: ${best} villagers at ${label} at the busiest hour, needs ${crew}`);
  }
  // no stage is crewed unless it belongs to a project, and the first stage of a project never needs a crew
  for (const g of manifest.groups) { if (g.crew) { assert.ok(g.project); assert.ok(!g.id.endsWith('-1'), `${g.id} is a first stage`); } }
  assert.ok(loadWorks().length >= 8);
});
