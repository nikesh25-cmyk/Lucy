// One global map: the atlas keeper answers where a player is and travels them to a place on the map.
//
// The rules this file pins are the ones that matter: the allow-list is NemoWorld's own atlas file, a
// player's position is only ever read from the **signed** landmarks the game server reported, a travel is
// one place at a time and bounded by the same cooldown the server applies, and "arrived" means the server's
// own signed acknowledgement — never a chat line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { VelorenLink, signEvent } from '../src/veloren-link.js';
import { setIdentityProvider } from '../src/veloren-ext/identity.js';
import { ATLAS_KEEPERS, ATLAS_POLICY, AtlasService, loadAtlas, parseIntent } from '../src/veloren-ext/atlas.js';
import { fixture } from './helpers.js';

const KEY = Buffer.from('nemo-atlas-test-key-nemo-atlas-test-key-01');
const LANDMARKS = [
  { id: 'lyra-house', name: "Harr's house", role: 'post' },
  { id: 'lyra-field', name: "Harr's farm field", role: 'survey' },
  { id: 'lyra-plaza', name: "Harr's plaza", role: 'place' },
];
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const refused = (status) => (error) => error.status === status;

/** The Veloren server's half: signed acknowledgements and nothing else. */
function makeServer(link, relayCredential) {
  let seq = 9000;
  const answered = new Set(link.sql.all("SELECT landmark_id, player_uuid FROM link_events WHERE kind IN ('command.applied','command.rejected')").map((row) => `${row.landmark_id}/${row.player_uuid}`));
  const outstanding = () => link.sql.all('SELECT cmd_id, kind, player_uuid FROM atlas_commands ORDER BY issued_at').filter((row) => !answered.has(`${row.cmd_id}/${row.player_uuid}`));
  return {
    outstanding,
    answer(kind = 'command.applied') {
      const cmd = outstanding()[0];
      if (!cmd) return 0;
      const event = { v: 1, server_id: 'local-dev', seq: (seq += 1), kind, resident_id: 'lw-lyra', player_uuid: cmd.player_uuid, player_alias: '', landmark_id: cmd.cmd_id, occurred_at: link.clock() };
      event.sig = signEvent(KEY, event);
      const [result] = link.ingest(relayCredential, [event]);
      if (result.status !== 'accepted') throw new Error(`the simulated server could not report ${cmd.cmd_id}: ${result.reason}`);
      answered.add(`${cmd.cmd_id}/${cmd.player_uuid}`);
      return 1;
    },
  };
}

async function world(t) {
  const f = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'atlas-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = new VelorenLink({ dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: f.clock, commandsPath: join(directory, 'commands.jsonl') });
  link.platform = f.platform;
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  const aliceAvatar = f.agent('alice', 'Alice Walker');
  const bobAvatar = f.agent('bob', 'Bob Builder');
  setIdentityProvider((_link, player_uuid) => (player_uuid === P1
    ? { account_id: f.actor('alice').account.id, agent_id: aliceAvatar.id, display_name: 'Alice Walker' }
    : player_uuid === P2 ? { account_id: f.actor('bob').account.id, agent_id: bobAvatar.id, display_name: 'Bob Builder' } : null));
  t.after(() => setIdentityProvider(null));
  const keeper = link.issueCredential({ resident_id: ATLAS_KEEPERS[0], scopes: ['director'], days: 1 });
  const relay = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['events'], days: 1 });
  const relayCredential = link.authenticate(relay.token, 'events');
  const server = makeServer(link, relayCredential);
  const atlas = new AtlasService(link, f.platform);
  const credential = link.authenticate(keeper.token, 'director');
  // Most tests ask several things in a row, so the helper steps past the keeper's own pacing; a test that
  // measures a cooldown advances the clock itself.
  const askNow = (text, uuid = P1, alias = 'Tester') => atlas.ask(credential, { resident_id: ATLAS_KEEPERS[0], player_uuid: uuid, player_alias: alias, text });
  const ask = (text, uuid = P1, alias = 'Tester') => { f.advance(ATLAS_POLICY.ask_gap_ms + 1); return askNow(text, uuid, alias); };
  /** A signed landmark event, exactly as the Veloren server writes them. */
  const observe = (landmark_id, uuid = P1) => {
    const event = { v: 1, server_id: 'local-dev', seq: (seq = (seq || 500) + 1), kind: 'landmark.together', resident_id: 'lw-lyra', player_uuid: uuid, player_alias: 'Tester', landmark_id, occurred_at: link.clock() };
    event.sig = signEvent(KEY, event);
    const [result] = link.ingest(relayCredential, [event]);
    if (result.status !== 'accepted') throw new Error(`could not store the observation: ${result.reason}`);
  };
  let seq = 500;
  const commands = () => link.sql.all('SELECT * FROM atlas_commands ORDER BY issued_at');
  const notices = () => atlas.notices();
  return { f, link, atlas, server, credential, keeper, relay, aliceAvatar, bobAvatar, ask, observe, commands, notices };
}

// ---- the words and the file -------------------------------------------------------------------

test('the atlas file is the allow-list, and a broken one is refused', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-file-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, body) => {
    const path = join(directory, `${name}.json`);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };
  const place = { id: 'commons', name: 'The Commons', short: 'Arrival.', kind: 'site', site: 'Harr', arrive_radius: 12 };
  const file = (places, extra = {}) => ({ format: 'veloren-atlas-server-v1', manifest_hash: 'a'.repeat(64), world_seed: 130626853, places, ...extra });
  assert.ok(loadAtlas(write('good', file([place]))).places.has('commons'));
  const bad = [
    file([place], { format: 'veloren-atlas-server-v2' }),
    file([place], { manifest_hash: 'abc' }),
    file([place], { world_seed: 'soon' }),
    file([]),
    file([{ ...place, id: 'Commons' }]),
    file([{ ...place, name: '' }]),
    file([{ ...place, kind: 'town' }]),
    file([{ ...place, kind: 'plot' }]),
    file([{ ...place, arrive_radius: 0 }]),
    file([place, place]),
  ];
  for (const [index, body] of bad.entries()) assert.throws(() => loadAtlas(write(`bad-${index}`, body)), undefined, `case ${index}`);
  // The shipped atlas is one NemoWorld and the Veloren server can both read.
  const shipped = loadAtlas(fileURLToPath(new URL('../content/veloren-atlas-places.json', import.meta.url)));
  assert.ok(shipped.places.get('library').landmark_id, 'the shipped atlas ties a place to a NemoWorld landmark');
});

test('a spoken line only ever chooses a fixed answer and a place the atlas knows', () => {
  const atlas = loadAtlas();
  const of = (text) => parseIntent(text, atlas);
  assert.equal(of('where am I').intent, 'where');
  assert.equal(of('what is near me').intent, 'near');
  assert.equal(of('places').intent, 'list');
  assert.equal(of('hello there').intent, 'help');
  assert.equal(of('travel to the commons').intent, 'travel');
  assert.equal(of('travel to the commons').place.id, 'commons');
  assert.equal(of('take me to Ajakkuq').place.id, 'ajakkuq');
  assert.equal(of('travel to the moon').place, null, 'a place nobody has is never invented');
  assert.equal(of('travel plot:0:0:0:0 15300 16100').place, null, 'a coordinate is not a place');
});

// ---- the keeper answers -----------------------------------------------------------------------

test('an unlinked player is told to link, and nothing is written', async (t) => {
  const w = await world(t);
  assert.match(w.ask('travel to the commons', STRANGER, 'Stranger').reply, /link/i);
  assert.deepEqual(w.commands(), []);
});

test('"where am I" is answered only from a signed landmark, and never from a command id', async (t) => {
  const w = await world(t);
  assert.match(w.ask('where am I').reply, /has not seen you/i, 'nothing observed yet');
  w.observe('lyra-house');
  const answer = w.ask('where am I');
  assert.match(answer.reply, /The Lantern Library/, 'the atlas names the place for the landmark the server signed');
  w.f.advance(ATLAS_POLICY.ask_gap_ms + 1);
  assert.match(w.ask('what is near me').reply, /The Lantern Library|The Commons|The workshop yard/, 'nearby places come from the same atlas');
  // A delivered travel writes an acknowledgement whose landmark_id is the command id: it must never be
  // mistaken for a place the player was seen at.
  w.f.advance(ATLAS_POLICY.ask_gap_ms + 1);
  w.ask('travel to the commons');
  w.server.answer();
  assert.equal(w.commands()[0].kind, 'teleport');
  w.f.advance(ATLAS_POLICY.ask_gap_ms + 1);
  assert.doesNotMatch(w.ask('where am I').reply, /[0-9a-f]{8}-[0-9a-f]{4}/, 'no command id is ever read out as a place');
});

test('travel is one place at a time, bounded by the same cooldown the server applies', async (t) => {
  const w = await world(t);
  const answer = w.ask('travel to the library');
  assert.match(answer.reply, /Asking the world to take you to The Lantern Library/);
  const issued = w.commands();
  assert.equal(issued.length, 1);
  assert.equal(issued[0].kind, 'teleport');
  assert.equal(issued[0].place_id, 'library');
  const record = JSON.parse(readFileSync(w.link.commands.path, 'utf8').trim().split('\n').pop());
  const args = JSON.parse(record.args);
  assert.deepEqual(Object.keys(args).sort(), ['m', 'place_id'], 'exactly the two keys the server parses');
  assert.equal(args.place_id, 'library');
  assert.equal(args.m, w.atlas.atlas.manifest_hash.slice(0, 16), 'the manifest hash, first 16 hex');
  // Asking again while the first is unanswered is answered, not repeated.
  w.f.advance(ATLAS_POLICY.ask_gap_ms + 1);
  assert.match(w.ask('travel to the library').reply, /already asked the world/i);
  assert.equal(w.commands().length, 1);
  // A different place inside the cooldown is refused by the keeper (the server would refuse it too).
  w.f.advance(ATLAS_POLICY.ask_gap_ms + 1);
  assert.throws(() => w.ask('travel to the plaza'), refused(429));
  assert.equal(w.commands().length, 1);
  // After the cooldown a new travel is issued.
  w.f.advance(ATLAS_POLICY.teleport_gap_ms + 1);
  assert.equal(w.ask('travel to the plaza').intent, 'travel');
  assert.equal(w.commands().length, 2);
});

test('the world\'s own word decides: arrived, refused, and never guessed', async (t) => {
  const w = await world(t);
  w.ask('travel to the workshop');
  assert.equal(w.atlas.travelState(P1, 'workshop').status, 'travelling');
  assert.equal(w.server.answer(), 1);
  assert.equal(w.atlas.travelState(P1, 'workshop').status, 'arrived');
  const told = w.notices();
  assert.equal(told.length, 1);
  assert.match(told[0].text, /You are at The workshop yard/);
  w.atlas.ackNotices([w.link.sql.get('SELECT id FROM atlas_notices').id]);
  assert.deepEqual(w.atlas.notices(), [], 'a notice is handed over once');

  // A refused travel says so and is not an arrival.
  w.f.advance(ATLAS_POLICY.teleport_gap_ms + 1);
  w.ask('travel to Ajakkuq');
  assert.equal(w.server.answer('command.rejected'), 1);
  assert.equal(w.atlas.travelState(P1, 'ajakkuq').status, 'failed');
  assert.match(w.notices()[0].text, /would not take you to Ajakkuq/);
});

test('another player gets their own map, and a place nobody has is refused by name', async (t) => {
  const w = await world(t);
  w.ask('travel to the commons');
  assert.equal(w.commands().every((row) => row.player_uuid === P1), true);
  w.f.advance(ATLAS_POLICY.ask_gap_ms + 1);
  assert.match(w.ask('travel to the moon', P2, 'Bob Builder').reply, /I do not know "moon"/);
  assert.equal(w.commands().length, 1, 'nothing was issued for an unknown place or another player');
  assert.equal(w.atlas.view(P2).at, null, 'Bob has his own view, with nothing observed');
});

// ---- over HTTP --------------------------------------------------------------------------------

async function serve(t, w) {
  const app = createApp({ platform: w.f.platform, backupDir: join(w.f.directory, 'backups'), velorenLink: w.link, mayorModel: null });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { token, input, method = input === undefined ? 'GET' : 'POST', origin: withOrigin = true } = {}) => {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { ...(withOrigin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };
  return { call, session: w.f.credentials.alice.token };
}

test('over HTTP the map is for the keeper, and the ask and notices routes with it', async (t) => {
  const w = await world(t);
  const { call, session } = await serve(t, w);
  assert.equal((await call('/veloren/atlas')).status, 401, 'no credential');
  assert.equal((await call('/veloren/atlas', { token: session })).status, 401, 'a human session is not a link credential');
  assert.equal((await call('/veloren/atlas', { token: w.relay.token })).status, 403, 'an events credential');
  const other = w.link.issueCredential({ resident_id: 'lw-lyra', scopes: ['director'], days: 1 });
  assert.equal((await call('/veloren/atlas', { token: other.token })).status, 403, 'a director credential that is not the keeper\'s');
  const map = await call('/veloren/atlas', { token: w.keeper.token });
  assert.equal(map.status, 200);
  assert.equal(map.data.format, 'veloren-atlas-server-v1');
  assert.equal(map.data.places.some((place) => place.id === 'library'), true);
  assert.equal(JSON.stringify(map.data).includes('1111'), false, 'the map carries no player data');
  const body = { resident_id: ATLAS_KEEPERS[0], player_uuid: P1, player_alias: 'Tester', text: 'where am I' };
  assert.equal((await call('/veloren/atlas/ask', { input: body })).status, 401);
  assert.equal((await call('/veloren/atlas/ask', { input: body, token: w.keeper.token })).status, 200);
  assert.equal((await call('/veloren/atlas/ask', { input: { ...body, extra: 1 }, token: w.keeper.token })).status, 400);
  assert.equal((await call('/veloren/atlas/notices', { token: w.keeper.token })).status, 200);
  assert.equal((await call('/veloren/atlas/notices', { token: w.relay.token })).status, 403);
  assert.equal((await call('/veloren/atlas/notices/ack', { input: { ids: ['nope'] }, token: w.keeper.token })).status, 400);
  assert.equal((await call('/veloren/atlas/nothing-here', { token: w.keeper.token })).status, 404);
});
