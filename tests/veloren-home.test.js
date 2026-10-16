// Cottages in the game: a linked player asks the keeper resident (Rowan) for their cottage, and the
// Veloren server is asked to build or enter it with a signed `home_*` command.
//
// What this file proves is that the module owns no rule NemoWorld already owns: the plot comes from the
// land registry, entry comes from the cottage's own visibility rule, and the vault is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { VelorenLink, signEvent } from '../src/veloren-link.js';
import { setIdentityProvider } from '../src/veloren-ext/identity.js';
import { HOME_KEEPERS, HOME_POLICY, HomeService, parseIntent } from '../src/veloren-ext/home.js';
import { fixture } from './helpers.js';

const KEY = Buffer.from('nemo-home-test-key-nemo-home-test-key-0001');
const LANDMARKS = [{ id: 'lyra-post', name: "Harr's house", role: 'post' }, { id: 'lyra-survey', name: "Harr's farm field", role: 'survey' }];
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const refused = (status, reason) => (error) => error.status === status && (reason === undefined || error.reason === reason);

/** The Veloren server's half: signed acknowledgements and nothing else. */
function makeServer(link, relayCredential) {
  let seq = 7000;
  const answered = new Set(link.sql.all("SELECT landmark_id, player_uuid FROM link_events WHERE kind IN ('command.applied','command.rejected')").map((row) => `${row.landmark_id}/${row.player_uuid}`));
  return {
    outstanding: () => link.sql.all('SELECT cmd_id, kind, player_uuid FROM home_commands ORDER BY issued_at').filter((row) => !answered.has(`${row.cmd_id}/${row.player_uuid}`)),
    /** Answer the oldest unanswered command, as the world would. */
    answer(kind = 'command.applied') {
      const cmd = this.outstanding()[0];
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
  const directory = mkdtempSync(join(tmpdir(), 'home-test-'));
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
  const keeper = link.issueCredential({ resident_id: HOME_KEEPERS[0], scopes: ['director'], days: 1 });
  const relay = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['events'], days: 1 });
  const server = makeServer(link, link.authenticate(relay.token, 'events'));
  const credential = link.authenticate(keeper.token, 'director');
  const home = new HomeService(link, f.platform);
  // Most tests ask several things in a row, so the helper steps past the keeper's own pacing; the pacing
  // test uses `askNow` on purpose.
  const askNow = (text, uuid = P1, alias = 'Tester') => home.ask(credential, { resident_id: HOME_KEEPERS[0], player_uuid: uuid, player_alias: alias, text });
  const ask = (text, uuid = P1, alias = 'Tester') => { f.advance(HOME_POLICY.ask_gap_ms + 1); return askNow(text, uuid, alias); };
  const commands = () => link.sql.all('SELECT * FROM home_commands ORDER BY issued_at');
  // Asking the keeper what he has to say is also what writes a player's notice, so this calls him.
  const notices = () => home.notices();
  const availablePlot = () => f.platform.land(f.actor('alice'), { status: 'available', limit: 1 }).plots[0];
  const claim = (plot_id) => f.tx('landAssign', f.actor('alice'), { plot_id, purpose: 'My cottage', description: '' });
  return { f, link, home, server, credential, keeper, relay, aliceAvatar, bobAvatar, ask, askNow, commands, notices, availablePlot, claim };
}

// ---- the words -----------------------------------------------------------------------------------

test('a spoken line only ever chooses a fixed answer and a bounded style', () => {
  assert.deepEqual(parseIntent('where is my home'), { intent: 'where' });
  assert.deepEqual(parseIntent('build my home'), { intent: 'build', style: null });
  assert.deepEqual(parseIntent('build my home in style 3'), { intent: 'build', style: 3 });
  assert.deepEqual(parseIntent('build it blue'), { intent: 'build', style: 0 });
  assert.deepEqual(parseIntent('can I step inside'), { intent: 'enter' });
  assert.deepEqual(parseIntent('let me out'), { intent: 'leave' });
  assert.deepEqual(parseIntent('what are my notes'), { intent: 'notes' });
  assert.deepEqual(parseIntent('hello there'), { intent: 'help' });
  // A plot address or a coordinate in the text changes nothing: only a style number is ever read.
  assert.deepEqual(parseIntent('build plot:1:1:1:1 at 999 999'), { intent: 'build', style: 1 });
  assert.deepEqual(parseIntent('build my home style 99'), { intent: 'build', style: null });
});

// ---- the keeper answers ---------------------------------------------------------------------------

test('an unlinked player is told to link first, and nothing is written', async (t) => {
  const w = await world(t);
  const answer = w.ask('build my home', STRANGER, 'Stranger');
  assert.match(answer.reply, /link/i);
  assert.deepEqual(w.commands(), [], 'no command was issued for an unlinked player');
});

test('a linked player without a plot is sent to NemoWorld: the deed is not the keeper\'s to give', async (t) => {
  const w = await world(t);
  const answer = w.ask('build my home');
  assert.match(answer.reply, /claim one/i);
  assert.match(w.ask('where is my home').reply, /do not steward a plot/i);
  assert.deepEqual(w.commands(), [], 'nothing was sent to the game');
});

test('with a plot: one bounded build naming NemoWorld\'s own plot, then a signed word that it stands', async (t) => {
  const w = await world(t);
  const plot = w.availablePlot();
  w.claim(plot.id);
  assert.equal(w.ask('where is my home').reply.includes(plot.id), true, 'the keeper names the plot the land registry gave');

  const answer = w.ask('build my home in style 3');
  assert.match(answer.reply, /only say it is built when the world confirms/i);
  const issued = w.commands();
  assert.equal(issued.length, 1);
  assert.equal(issued[0].kind, 'home_build');
  assert.equal(issued[0].plot_id, plot.id, 'the plot comes from the registry, never from the words');
  const command = w.link.sql.get('SELECT * FROM home_commands WHERE cmd_id=?', issued[0].cmd_id);
  assert.equal(command.kind, 'home_build');
  assert.deepEqual(w.home.view(P1).built, 'building');
  // Asking again while the first build is still unanswered is answered, not repeated: no second command.
  assert.match(w.ask('build my home').reply, /already asked the world/i);
  assert.equal(w.commands().length, 1);

  // The world answers: only now is it built, and the player is told once.
  assert.equal(w.server.answer(), 1);
  assert.equal(w.home.view(P1).built, 'built');
  const told = w.notices();
  assert.equal(told.length, 1);
  assert.match(told[0].text, /cottage is built/i);
  w.home.ackNotices([w.link.sql.get('SELECT id FROM home_notices').id]);
  assert.deepEqual(w.home.notices(), [], 'a notice is handed over once');

  // Entering is a second, separate command.
  const enter = w.ask('enter');
  assert.match(enter.reply, /asking the world/i);
  const kinds = w.commands().map((row) => row.kind);
  assert.deepEqual(kinds, ['home_build', 'home_enter']);
});

test('the cottage door is the owner\'s own, and a closed cottage is closed to visitors', async (t) => {
  const w = await world(t);
  const plot = w.availablePlot();
  w.claim(plot.id);
  w.ask('build my home');
  w.server.answer();
  // The owner's own door: the keeper only ever names the asking player's own plot, so its owner can step in.
  assert.equal(w.home.view(P1).can_enter, true, 'a human avatar\'s cottage follows its garden: open by default');
  assert.equal(w.ask('enter').intent, 'enter');
  assert.equal(w.commands().some((row) => row.kind === 'home_enter'), true);

  // A visitor is the platform's rule, not this module's. Once the owner closes the cottage in NemoWorld,
  // another operator's account cannot read it at all — and the keeper never even tries, because it only
  // ever names the asking player's own plot.
  w.f.tx('homeSettings', w.f.actor('alice'), w.aliceAvatar.id, { house_visibility: 'private' });
  const actorFor = (name) => Object.freeze({ account: w.f.actor(name).account, agent: null, kind: 'session', credential: null, readOnly: true });
  assert.throws(() => w.f.platform.space(actorFor('bob'), `house:${w.aliceAvatar.id}`), refused(403), 'a private cottage is invisible to another account');
  assert.ok(w.f.platform.space(actorFor('alice'), `house:${w.aliceAvatar.id}`), 'and still open to its owner');
  for (const row of w.commands()) assert.equal(row.plot_id, plot.id, 'every command names the asker\'s own plot');
  assert.equal(w.home.view(P2).plot, null, 'another player has no plot of their own here');
});

test('another player cannot use the keeper to reach somebody else\'s cottage', async (t) => {
  const w = await world(t);
  const plot = w.availablePlot();
  w.claim(plot.id);
  w.ask('build my home');
  w.server.answer();

  const bob = w.ask('enter', P2, 'Bob Builder');
  assert.match(bob.reply, /no plot/i, 'Bob is told about his own plot, not Alice\'s');
  assert.equal(w.commands().filter((row) => row.player_uuid === P2).length, 0, 'no command was ever issued for Bob');
  assert.equal(w.home.view(P2).plot, null);
  // Bob asking twice never reaches Alice's plot, whatever he says.
  assert.match(w.ask('enter her cottage at plot:-1:-1:0:0', P2, 'Bob Builder').reply, /no plot/i);
  assert.equal(w.commands().filter((row) => row.player_uuid === P2).length, 0);
});

test('the vault is a pointer: counts only, and this module never reads a note', async (t) => {
  const w = await world(t);
  const answer = w.ask('what are my notes');
  assert.match(answer.reply, /open NemoWorld/i);
  assert.match(answer.reply, /never leaves it|no notes/i);
  // By construction: the module has no call to the reader that a resident's own credential would need.
  const source = readFileSync(fileURLToPath(new URL('../src/veloren-ext/home.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /\.vaultRead\(/, 'no note text can be read from here');
  assert.match(source, /vaultStatus/, 'counts come from the platform\'s own status read');
});

test('a world that refuses the build is reported honestly and cannot be entered', async (t) => {
  const w = await world(t);
  const plot = w.availablePlot();
  w.claim(plot.id);
  w.ask('build my home');
  assert.equal(w.server.answer('command.rejected'), 1);
  assert.equal(w.home.view(P1).built, 'failed');
  const told = w.notices();
  assert.equal(told.length, 1);
  assert.match(told[0].text, /refused to build/i);
  const enter = w.ask('enter');
  assert.match(enter.reply, /no cottage stands there/i);
  assert.equal(w.commands().some((row) => row.kind === 'home_enter'), false);
});

test('the keeper paces a player, and every answer stays inside the chat limits', async (t) => {
  const w = await world(t);
  w.askNow('where is my home');
  assert.throws(() => w.askNow('where is my home'), refused(429), 'a second line within two seconds');
  w.f.advance(HOME_POLICY.ask_gap_ms + 1);
  const long = w.askNow('build my home '.repeat(40));
  assert.ok(long.lines.length <= HOME_POLICY.reply_lines);
  assert.ok(long.lines.every((line) => line.length <= HOME_POLICY.line_chars));
  assert.doesNotMatch(long.reply, /[\u0000-\u001f\u007f]/);
});

// ---- over HTTP ------------------------------------------------------------------------------------

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

test('over HTTP only the home keeper\'s credential may answer for cottages', async (t) => {
  const w = await world(t);
  const { call, session } = await serve(t, w);
  const body = { resident_id: HOME_KEEPERS[0], player_uuid: P1, player_alias: 'Tester', text: 'where is my home' };
  assert.equal((await call('/veloren/home/ask', { input: body })).status, 401, 'no credential, with this site\'s Origin');
  assert.equal((await call('/veloren/home/ask', { input: body, origin: false })).status, 403, 'a write with no Origin and no credential never reaches the keeper');
  assert.equal((await call('/veloren/home/ask', { input: body, token: session })).status, 401, 'a human session is not a link credential');
  assert.equal((await call('/veloren/home/ask', { input: body, token: w.relay.token })).status, 403, 'an events-only credential');
  const other = w.link.issueCredential({ resident_id: 'lw-lyra', scopes: ['director'], days: 1 });
  assert.equal((await call('/veloren/home/ask', { input: body, token: other.token })).status, 403, 'a director credential that is not the keeper\'s');
  const good = await call('/veloren/home/ask', { input: body, token: w.keeper.token });
  assert.equal(good.status, 200);
  assert.equal(good.data.source, 'scripted');
  assert.equal((await call('/veloren/home/ask', { input: { ...body, extra: 1 }, token: w.keeper.token })).status, 400, 'unexpected fields');
  assert.equal((await call('/veloren/home/ask', { input: { ...body, resident_id: 'lw-lyra' }, token: w.keeper.token })).status, 403, 'scoped to its resident');
  assert.equal((await call('/veloren/home/notices', { token: w.keeper.token })).status, 200);
  assert.equal((await call('/veloren/home/notices', { token: w.relay.token })).status, 403);
  assert.equal((await call('/veloren/home/notices/ack', { input: { ids: ['nope'] }, token: w.keeper.token })).status, 400);
  assert.equal((await call('/veloren/home/nothing-here', { token: w.keeper.token })).status, 404);
});
