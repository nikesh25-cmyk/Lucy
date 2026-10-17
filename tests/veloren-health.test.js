import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import {buildHealth, healthExtension, HEALTH_POLICY} from '../src/veloren-ext/health.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const T0 = 1_760_572_800_000;
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}];

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'veloren-health-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const clock = {now: T0};
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, commandsPath: join(directory, 'commands.jsonl'), extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  return {clock, link, directory};
}
function sendEvent(s, seq = 1) {
  const lyra = s.link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  const e = {v: 1, server_id: 'health-test', seq, kind: 'landmark.visited', resident_id: 'lw-lyra', player_uuid: ALICE, player_alias: 'Alice', landmark_id: 'lyra-post', occurred_at: s.clock.now};
  e.sig = signEvent(KEY, e);
  s.link.ingest(s.link.authenticate(lyra.token, 'events'), [e]);
}
function call(link, route = '/veloren/harr/health', method = 'GET') {
  const seen = {};
  const handled = healthExtension.handle(link, {route, request: {method}, response: {}, json: (_r, status, body) => { seen.status = status; seen.body = body; }});
  return handled.then((value) => ({value, ...seen}));
}

test('health is registered and answers 200 with aggregate facts only', async (t) => {
  const s = setup(t);
  assert.ok(EXTENSIONS.some((e) => e.name === 'health'));
  const r = await call(s.link);
  assert.equal(r.value, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.db.ok, true);
  assert.equal(r.body.link.ok, true);
});

test('other routes and methods are passed on', async (t) => {
  const s = setup(t);
  assert.equal((await call(s.link, '/veloren/harr/overview')).value, false);
  assert.equal((await call(s.link, '/veloren/harr/health', 'POST')).value, false);
});

test('last event age is measured from the newest received event, null before any', async (t) => {
  const s = setup(t);
  assert.equal(buildHealth(s.link, T0, null).events.last_event_age_s, null);
  assert.ok(buildHealth(s.link, T0, null).warnings.includes('no game events recorded yet'));
  sendEvent(s);
  s.clock.now = T0 + 90_000;
  const h = buildHealth(s.link, s.clock.now, null);
  assert.equal(h.events.last_event_age_s, 90);
  assert.equal(h.events.warn, false);
  const later = buildHealth(s.link, T0 + (HEALTH_POLICY.event_warn_s + 60) * 1000, null);
  assert.equal(later.events.warn, true);
  assert.equal(later.ok, true, 'quiet game is a warning, not a failure');
});

test('works record: missing, fresh and stale; counts only', async (t) => {
  const s = setup(t);
  const path = join(s.directory, 'world.json');
  assert.equal(buildHealth(s.link, T0, path).works_record.present, false);
  assert.ok(buildHealth(s.link, T0, path).warnings.includes('works record missing'));
  writeFileSync(path, JSON.stringify({updated_at: T0 - 30_000, groups: {'cottage-1-1': {}, 'cottage-1-2': {}, 'field-hut': {}}, waiting: {'cottage-1-3': 'needs a crew'}}));
  const fresh = buildHealth(s.link, T0, path).works_record;
  assert.deepEqual(fresh, {present: true, age_s: 30, stages_built: 2, waiting: 1, warn: false});
  const stale = buildHealth(s.link, T0 + 3_600_000, path).works_record;
  assert.equal(stale.warn, true);
  writeFileSync(path, '{ not json');
  assert.equal(buildHealth(s.link, T0, path).works_record.present, false);
});

test('a broken database gives 503 and ok:false; the report never leaks names, ids, paths or secrets', async (t) => {
  const s = setup(t);
  sendEvent(s);
  const path = join(s.directory, 'world.json');
  writeFileSync(path, JSON.stringify({updated_at: T0, groups: {}, waiting: {}, manifest: '/secret/path'}));
  process.env.NEMO_WORLD_RECORD = path;
  t.after(() => { delete process.env.NEMO_WORLD_RECORD; });
  const text = JSON.stringify((await call(s.link)).body);
  for (const forbidden of [ALICE, 'Alice', 'lw-lyra', '/secret/path', directoryOf(path), 'token', 'signature']) assert.ok(!text.includes(forbidden), `leaked ${forbidden}`);
  s.link.close();
  const broken = await call(s.link);
  assert.equal(broken.status, 503);
  assert.equal(broken.body.ok, false);
  assert.ok(broken.body.warnings.includes('database unreadable'));
});
function directoryOf(p) { return p.slice(0, p.lastIndexOf('/')); }
