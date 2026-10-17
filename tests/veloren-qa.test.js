// Regression tests for bugs found by reading the merged Harr code (see docs/QA_REPORT.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelorenLink, signEvent, velorenLinkFromEnvironment} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import {pantryLines, shelfNow, take} from '../src/veloren-ext/pantry.js';
import {chronicleLines, loadEvents, observe, resetObserver} from '../src/veloren-ext/village.js';
import {loadDiscoveries, worksLines} from '../src/veloren-ext/world-life.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const T0 = 1_760_572_800_000;
const discoveries = loadDiscoveries();
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'},
  ...discoveries.map((d) => ({id: d.landmark_id, name: d.name, role: 'place'}))];

function setup(t, clockStart = T0) {
  const directory = mkdtempSync(join(tmpdir(), 'veloren-qa-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const clock = {now: clockStart};
  const commandsPath = join(directory, 'commands.jsonl');
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, commandsPath, extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  const lyra = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  return {clock, link, lyra, directory, commandsPath};
}
let seq = 40_000;
function event(s, kind, overrides = {}) {
  seq += 1;
  const e = {v: 1, server_id: 'qa-test', seq, kind, resident_id: 'lw-lyra', player_uuid: ALICE, player_alias: 'Alice', landmark_id: null, occurred_at: s.clock.now, ...overrides};
  e.sig = signEvent(KEY, e);
  return e;
}
const ingest = (s, ...events) => s.link.ingest(s.link.authenticate(s.lyra.token, 'events'), events);
const commandsIn = (s) => readFileSync(s.commandsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('QA-01 a full shelf drains when somebody takes from it (restock time starts when the shelf last changed, not when it filled)', (t) => {
  const s = setup(t);
  pantryLines(s.link, ALICE);                    // the shelf appears, half full
  s.clock.now += 3 * 3_600_000;
  pantryLines(s.link, ALICE);                    // three hours later it has filled to the cap
  assert.equal(s.link.sql.get("SELECT units FROM pantry_shelf WHERE item='apple'").units, 24);
  s.clock.now += 5 * 3_600_000;                  // it sits full for five more hours
  assert.equal(take(s.link, {player_uuid: ALICE, item: 'apple', alias: 'Alice'}).issued, true);
  const [command] = commandsIn(s);
  assert.equal(ingest(s, event(s, 'command.applied', {landmark_id: command.cmd_id}))[0].status, 'accepted');
  pantryLines(s.link, ALICE);                    // settles the delivery
  assert.equal(shelfNow(s.link.sql, 'apple', s.clock.now), 22, 'two apples left the shelf and stay gone');
});

test('QA-02 a command acknowledgement (which carries no alias) does not erase the alias the player is known by', (t) => {
  const s = setup(t);
  ingest(s, event(s, 'landmark.visited', {landmark_id: discoveries[0].landmark_id}));
  assert.equal(s.link.sql.get('SELECT alias FROM link_players WHERE player_uuid=?', ALICE).alias, 'Alice');
  const cmd_id = '33333333-3333-4333-8333-333333333333';
  assert.equal(ingest(s, event(s, 'command.applied', {player_alias: '', landmark_id: cmd_id}))[0].status, 'accepted');
  assert.equal(s.link.sql.get('SELECT alias FROM link_players WHERE player_uuid=?', ALICE).alias, 'Alice');
});

test('QA-03 NemoWorld accepts a fact at every landmark the game server is configured with', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'veloren-qa-env-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const content = (name) => new URL(`../content/${name}`, import.meta.url);
  const link = velorenLinkFromEnvironment({
    NEMO_LINK_EVENT_KEY: 'ab'.repeat(32), NEMO_LINK_DB: join(directory, 'link.sqlite'), NEMO_LINK_COMMANDS: join(directory, 'commands.jsonl'),
  }, join(directory, 'world.sqlite'), content('veloren-landmarks.json').pathname);
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  const configured = [
    ...JSON.parse(readFileSync(content('veloren-world-landmarks.json'), 'utf8')).landmarks,
    ...JSON.parse(readFileSync(content('veloren-landmarks-extra.json'), 'utf8')).landmarks,
  ].map((l) => l.id);
  const missing = configured.filter((id) => !link.landmarkById(id));
  assert.deepEqual(missing, [], 'these landmarks are in the game config, so the server tags facts with them, and NemoWorld would refuse the fact as unknown_landmark');
});

test('QA-04 the chronicle keeps days apart across a daylight-saving change and counts a find once per person, place and day', (t) => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const now = new Date(2026, 10, 2, 12, 0).getTime();          // Mon 2 Nov 2026, 12:00 local; Sun 1 Nov was 25 hours long
  const s = setup(t, now);
  const sunday = new Date(2026, 10, 1, 0, 30).getTime();       // 00:30 on Sunday: "Yesterday"
  s.link.sql.run('INSERT INTO village_marks(key,kind,text,at) VALUES(?,?,?,?)', 'stage:qa', 'stage', 'A stage.', sunday);
  const lines = chronicleLines(s.link, loadEvents(), now).join('\n');
  assert.match(lines, /Yesterday: 1 building stage finished/);

  // The same person finding the same place on two different days is two days' discoveries.
  const place = discoveries[0].landmark_id;
  s.clock.now = now - 24 * 3_600_000;
  ingest(s, event(s, 'landmark.visited', {landmark_id: place, occurred_at: now - 24 * 3_600_000}));
  s.clock.now = now;
  ingest(s, event(s, 'landmark.visited', {landmark_id: place, occurred_at: now}));
  const text = chronicleLines(s.link, loadEvents(), now).join('\n');
  assert.match(text, /Today: .*1 discovery recorded/);
  assert.match(text, /Yesterday: .*1 discovery recorded/);
});

test('QA-05 the link database has indexes for the questions every request asks of the event log', (t) => {
  const s = setup(t);
  const plan = (sql, ...args) => s.link.sql.all(`EXPLAIN QUERY PLAN ${sql}`, ...args).map((r) => r.detail).join(' | ');
  assert.doesNotMatch(plan("SELECT kind FROM link_events WHERE landmark_id=? AND kind IN ('command.applied','command.rejected')", 'x'), /SCAN/);
  assert.doesNotMatch(plan("SELECT COUNT(DISTINCT resident_id) AS n FROM link_events WHERE kind='resident.met' AND player_uuid=?", ALICE), /SCAN/);
  assert.doesNotMatch(plan("SELECT 1 FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%' GROUP BY player_uuid, landmark_id"), /SCAN link_events(?! USING)/);
});

test('QA-06 the works board copes with a project the manifest gave no stages', () => {
  const projects = [{id: 'ghost', name: 'The ghost hall', purpose: 'Nothing yet.', stages: []}];
  assert.doesNotThrow(() => worksLines(projects, {works_started_ms: T0, works_elapsed_ms: 0, groups: {}, waiting: {}}, T0));
});

test('QA-07 a player alias cannot start a chat line with a slash', (t) => {
  const s = setup(t);
  ingest(s, event(s, 'resident.met', {player_alias: '/tell Bob'}));
  const spoken = s.link.director('lw-lyra').announcements.map((a) => a.text);
  assert.ok(spoken.length > 0);
  for (const text of spoken) assert.doesNotMatch(text, /^\s*[/!]/);
});

test('QA-08 a stage in the chronicle is dated when the server built it, not when NemoWorld first noticed', (t) => {
  const s = setup(t);
  resetObserver();
  const built = T0 - 3 * 86_400_000;
  const path = join(s.directory, 'world.json');
  writeFileSync(path, JSON.stringify({groups: {'well-1': {applied_at: built}}}));
  observe(s.link, T0, path);
  assert.equal(s.link.sql.get("SELECT at FROM village_marks WHERE key='stage:well-1'").at, built);
  resetObserver();
});
