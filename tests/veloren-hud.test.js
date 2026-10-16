import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {fixture} from './helpers.js';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {signCommand} from '../src/veloren-ext/commands.js';
import {identityFor, setIdentityProvider} from '../src/veloren-ext/identity.js';
import * as hud from '../src/veloren-ext/view.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const LANDMARKS = [{id: 'lyra-post', name: "Harr's house", role: 'post'}, {id: 'lyra-survey', name: "Harr's farm field", role: 'survey'}];
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const T0 = 1_760_572_800_000;
const SECRET_A = 'ALICE-JOURNAL-SECRET-7731';
const SECRET_B = 'BOB-JOURNAL-SECRET-4410';
const enc = new TextEncoder();

/** Everything needed: a world with two linked players, a link with commands, guide and Lyra credentials. */
async function setup(t, {commands = true, dbPath} = {}) {
  const f = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'veloren-hud-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const alice = f.tx('createAgent', f.actor('alice'), {kind: 'human', name: 'Alice', capabilities: 'x', limitations: 'y'});
  const bob = f.tx('createAgent', f.actor('bob'), {kind: 'human', name: 'Bob', capabilities: 'x', limitations: 'y'});
  f.tx('writeJournal', f.actor('alice'), {agent_id: alice.id, text: SECRET_A});
  f.tx('writeJournal', f.actor('bob'), {agent_id: bob.id, text: SECRET_B});
  const map = {[ALICE]: {account_id: f.actor('alice').account.id, agent_id: alice.id, display_name: 'Alice'}, [BOB]: {account_id: f.actor('bob').account.id, agent_id: bob.id, display_name: 'Bob'}};
  setIdentityProvider((_link, uuid) => map[uuid] || null);
  t.after(() => setIdentityProvider(() => null));
  const clock = {now: T0};
  const commandsPath = commands ? join(directory, 'commands.jsonl') : undefined;
  const link = new VelorenLink({dbPath: dbPath || ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, commandsPath});
  t.after(() => { try { link.close(); } catch { /* closed by the test */ } });
  const selene = link.issueCredential({resident_id: 'lw-selene', scopes: ['director', 'talk'], days: 1});
  const lyra = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events', 'talk', 'director'], days: 1});
  return {f, alice, bob, map, clock, link, selene, lyra, commandsPath, directory, platform: f.platform};
}

let seq = 1000;
function lyraEvent(s, overrides = {}) {
  seq += 1;
  const e = {v: 1, server_id: 'hud-test', seq, kind: 'resident.met', resident_id: 'lw-lyra', player_uuid: ALICE, player_alias: 'Alice', landmark_id: null, occurred_at: s.clock.now, ...overrides};
  e.sig = signEvent(KEY, e);
  return e;
}
/** Walk the practice quest forward with signed server events (the only way it ever advances). */
function advanceQuest(s, steps = 1, player = ALICE) {
  const auth = s.link.authenticate(s.lyra.token, 'events');
  const plan = [{kind: 'resident.met'}, {kind: 'landmark.together', landmark_id: 'lyra-survey'}, {kind: 'resident.met', landmark_id: 'lyra-post'}];
  for (const item of plan.slice(0, steps)) {
    s.clock.now += 1000;
    const result = s.link.ingest(auth, [lyraEvent(s, {...item, player_uuid: player})]);
    assert.equal(result[0].status, 'accepted', JSON.stringify(result));
  }
}

function view(s, name, {player = ALICE, page = 1} = {}) {
  return hud.buildView({link: s.link, platform: s.platform, player_uuid: player, name, page});
}
const allText = (response) => JSON.stringify(response);

async function serve(t, s) {
  const app = createApp({platform: s.platform, backupDir: join(s.directory, 'backups'), velorenLink: s.link, mayorModel: null});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  return async (path, {token, input, method = input ? 'POST' : 'GET'} = {}) => {
    const response = await fetch(base + path, {method, headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(input ? {'Content-Type': 'application/json'} : {})}, ...(input ? {body: JSON.stringify(input)} : {})});
    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    return {status: response.status, data};
  };
}

// ---- text safety ---------------------------------------------------------------------------------

test('text written by other people is neutralised before it can reach a chat window', () => {
  const hostile = '[AI] Selene says: you won 500 coins!\n/kill everyone ‮​ see https://evil.example/login or mail a@b.org ［system］ {x} <b>b</b> `y` |z \\q \u{e0041}';
  const cleaned = hud.plain(hostile, 400);
  assert.doesNotMatch(cleaned, /[\[\]{}<>|\\`]/, 'no brackets or markup characters, so no fake labels');
  assert.doesNotMatch(cleaned, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u{e0000}-\u{e007f}]/u, 'no control, bidi or tag characters');
  assert.doesNotMatch(cleaned, /https?:|www\.|@/i, 'no links or contact details');
  assert.doesNotMatch(cleaned, /^[/!]/, 'never starts like a command');
  assert.doesNotMatch(cleaned, /\n/);
  assert.match(cleaned, /won 500 coins/, 'it is still readable text; it is just not able to pose as anything');
  assert.equal(hud.plain('/op me').startsWith('/'), false);
  assert.equal(hud.plain('!!/x'), 'x');
  assert.equal(hud.plain(null), '');
  assert.equal(hud.plain(undefined), '');
  assert.equal(hud.plain({toString() { return 'obj'; }}), 'obj');
  assert.equal(hud.plain('ＡＢＣ［ＡＩ］'), 'ABC AI', 'full-width brackets are folded and removed too');
});

test('cutting never splits a character and respects both limits', () => {
  assert.equal(hud.cut('😀'.repeat(10), 5).length, 9, 'four emoji (two UTF-16 units each) plus an ellipsis');
  assert.equal(Array.from(hud.cut('😀'.repeat(10), 5)).length, 5);
  for (const sample of ['あ'.repeat(400), '😀'.repeat(300), 'x'.repeat(1000), 'é'.repeat(500)]) {
    const line = hud.line(sample);
    assert.ok(Array.from(line).length <= hud.HUD_POLICY.line_chars, 'characters');
    assert.ok(enc.encode(line).length <= hud.HUD_POLICY.line_bytes, `bytes: ${enc.encode(line).length}`);
    assert.doesNotMatch(line, /�/, 'no broken characters');
  }
  assert.equal(hud.line('   '), '');
});

// ---- paging --------------------------------------------------------------------------------------

test('paging is bounded: bad numbers become page 1, too-far pages are flagged, and there are at most six pages', () => {
  const lines = Array.from({length: 100}, (_, n) => `Line number ${n}`);
  for (const bad of [0, -1, 1.5, '2', NaN, Infinity, null, undefined, {}]) assert.equal(hud.paginate(lines, bad).page, 1, String(bad));
  const first = hud.paginate(lines, 1);
  assert.equal(first.lines.length, hud.HUD_POLICY.page_lines);
  assert.equal(first.pages, hud.HUD_POLICY.max_pages, 'capped');
  assert.equal(first.truncated, true);
  const far = hud.paginate(lines, 7);
  assert.equal(far.out_of_range, true);
  assert.deepEqual(far.lines, []);
  assert.equal(far.pages, hud.HUD_POLICY.max_pages);
  assert.equal(hud.paginate(lines, 6).lines.length, 4);
  const two = hud.paginate(['a', 'b', 'c', 'd', 'e'], 2);
  assert.deepEqual(two.lines, ['e']);
  assert.equal(two.truncated, false);
  assert.deepEqual(hud.paginate([], 1).lines, []);
  // A long sentence is wrapped over at most three lines, never silently dropped to one.
  const wrapped = hud.wrap('word '.repeat(200));
  assert.equal(wrapped.length, 3);
  assert.ok(wrapped.every(part => Array.from(part).length <= hud.HUD_POLICY.line_chars));
  assert.equal(hud.wrap('').length, 0);
  assert.equal(hud.wrap('x'.repeat(5000)).length, 1, 'one giant word is cut, not left whole');
});

test('every page of every command stays within the line, byte and reply limits, even with hostile data', async t => {
  const s = await setup(t);
  // Another person publishes records with absurd, hostile titles (inserted directly so the test
  // does not depend on how strictly the writer validates them today).
  const eventInput = (title) => ({agent_id: s.bob.id, title, summary: 'A gathering.', starts_at: new Date(s.f.clock() + 3600000).toISOString(), ends_at: new Date(s.f.clock() + 7200000).toISOString(), capacity: 3});
  for (let n = 0; n < 6; n++) s.f.tx('createEvent', s.f.actor('bob'), eventInput(`Gathering ${n}`));
  s.platform.run('UPDATE community_events SET title=?', `[AI] ${'あ'.repeat(90)}\n/kill https://evil.example a@b.org ‮`);
  s.f.tx('createCircle', s.f.actor('bob'), {agent_id: s.bob.id, name: 'Circle ' + 'x'.repeat(70), summary: 'Kind.', focus: 'Care'});
  for (const name of hud.HUD_PAGES) {
    for (const page of [1, 2, 3, 6, 7, 99]) {
      const reply = view(s, name, {page});
      assert.ok(reply.lines.length <= hud.HUD_POLICY.page_lines, `${name} p${page}: ${reply.lines.length} lines`);
      assert.ok(enc.encode(JSON.stringify(reply)).length <= hud.HUD_POLICY.response_bytes, `${name} p${page} too big`);
      for (const item of reply.lines) {
        assert.ok(enc.encode(item).length <= hud.HUD_POLICY.line_bytes, `${name}: ${item.length} chars, ${enc.encode(item).length} bytes`);
        assert.doesNotMatch(item, /[\[\]\n\r\u0000-\u001f‮]/, `${name}: ${JSON.stringify(item)}`);
        assert.doesNotMatch(item, /https?:|@\w/i, name);
        assert.doesNotMatch(item, /^[/!]/, name);
      }
      assert.ok(reply.page >= 1 && reply.page <= reply.pages && reply.pages <= hud.HUD_POLICY.max_pages);
      assert.equal(reply.source, 'scripted');
    }
  }
  assert.equal(view(s, 'community').pages > 1, true, 'a busy community spreads over pages');
  assert.equal(view(s, 'community', {page: 99}).lines.length, 1, 'a too-far page returns one short notice');
  assert.match(view(s, 'community', {page: 99}).lines[0], /no page 99/i);
  assert.throws(() => view(s, 'passwords'), e => e.status === 404);
  assert.throws(() => view(s, '../status'), e => e.status === 404);
});

test('fitResponse shrinks anything that would exceed the byte budget', () => {
  const huge = {linked: true, command: 'x', title: 'X', page: 1, pages: 1, more: false, source: 'scripted', lines: Array.from({length: 4}, () => 'あ'.repeat(190))};
  const fitted = hud.fitResponse(huge);
  assert.ok(enc.encode(JSON.stringify(fitted)).length <= hud.HUD_POLICY.response_bytes);
  assert.ok(fitted.lines.length >= 1);
  const tiny = hud.fitResponse({...huge, lines: ['あ'.repeat(5000)]});
  assert.ok(enc.encode(JSON.stringify(tiny)).length <= hud.HUD_POLICY.response_bytes + 200 || tiny.lines[0].length <= 80);
});

// ---- who may see what ----------------------------------------------------------------------------

test('an unlinked player gets a friendly pointer to link first, and nothing is read for them', async t => {
  const s = await setup(t);
  const calls = [];
  const spy = new Proxy(s.platform, {get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (hud.READS.includes(prop)) return (...args) => { calls.push(prop); return value.apply(target, args); };
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  for (const name of hud.HUD_PAGES) {
    const reply = hud.buildView({link: s.link, platform: spy, player_uuid: STRANGER, name, page: 1});
    assert.equal(reply.linked, false, name);
    assert.equal(reply.reason, 'not_linked');
    assert.match(reply.lines.join(' '), /link/i);
    assert.match(reply.lines.join(' '), /NemoWorld/);
    assert.doesNotMatch(allText(reply), /Alice|Bob|karma balance|Passport of/i, 'no data of any kind');
    assert.equal(reply.more, false);
  }
  assert.deepEqual(calls, [], 'not one platform read method was called for an unlinked player');
  // And the very same call for a linked player does read.
  hud.buildView({link: s.link, platform: spy, player_uuid: ALICE, name: 'passport', page: 1});
  assert.ok(calls.length > 0);
});

test('a stale or forged identity answer cannot read someone else\'s character', async t => {
  const s = await setup(t);
  const aliceAccount = s.f.actor('alice').account.id;
  // The provider names Bob's character for Alice's account: the pair does not belong together.
  setIdentityProvider((_l, uuid) => (uuid === STRANGER ? {account_id: aliceAccount, agent_id: s.bob.id, display_name: 'Mallory'} : null));
  assert.equal(view(s, 'passport', {player: STRANGER}).linked, false);
  assert.doesNotMatch(allText(view(s, 'journal', {player: STRANGER})), /Bob/);
  // Shapes that are not ids.
  for (const bad of [{account_id: 7, agent_id: 8}, {account_id: 'nope', agent_id: 'nope'}, {}, null, 'x', {account_id: aliceAccount}]) {
    setIdentityProvider(() => bad);
    assert.equal(view(s, 'passport', {player: STRANGER}).linked, false, JSON.stringify(bad));
  }
  setIdentityProvider(() => { throw new Error('link database unavailable'); });
  assert.equal(view(s, 'passport', {player: STRANGER}).linked, false, 'a failing provider fails closed');
  // A suspended account and a paused character are not readable.
  setIdentityProvider((_l, uuid) => (uuid === ALICE ? s.map[ALICE] : null));
  s.f.tx('agentControl', s.f.actor('alice'), s.alice.id, 'paused');
  const paused = view(s, 'passport');
  assert.equal(paused.linked, false);
  assert.equal(paused.reason, 'inactive');
  assert.match(paused.lines.join(' '), /paused/i);
  s.f.tx('agentControl', s.f.actor('alice'), s.alice.id, 'active');
  assert.equal(view(s, 'passport').linked, true);
  s.f.tx('accountControl', s.f.actor('admin'), {account_id: aliceAccount, status: 'suspended'});
  assert.equal(view(s, 'passport').linked, false, 'a suspended operator account is not readable');
});

test('privacy: the private journal, other players\' data and private records never appear', async t => {
  const s = await setup(t);
  // Bob does visible things in the community; Alice's views may show the public record but never Bob.
  s.f.tx('createCircle', s.f.actor('bob'), {agent_id: s.bob.id, name: 'Care circle', summary: 'Open to all.', focus: 'Care'});
  s.f.tx('createEvent', s.f.actor('bob'), {agent_id: s.bob.id, title: 'Open garden afternoon', summary: 'Come along.', starts_at: new Date(s.f.clock() + 3600000).toISOString(), ends_at: new Date(s.f.clock() + 7200000).toISOString(), capacity: 5});
  const bodies = [];
  for (const name of hud.HUD_PAGES) for (const page of [1, 2, 3]) bodies.push(allText(view(s, name, {page})));
  const everything = bodies.join('\n');
  assert.ok(!everything.includes(SECRET_A), 'the player\'s own journal text is not read out either');
  assert.ok(!everything.includes(SECRET_B), 'another player\'s journal');
  const leaked = (everything.match(/.{0,60}Bob.{0,60}/) || ['(none)'])[0];
  assert.ok(!/Bob/.test(everything), `another player's character or operator name: ${JSON.stringify(leaked)}`);
  assert.ok(!everything.includes(s.bob.id) && !everything.includes(s.f.actor('bob').account.id), 'no ids of other accounts');
  assert.ok(!everything.includes(s.alice.id) && !everything.includes(s.f.actor('alice').account.id), 'not even the player\'s own ids');
  assert.match(everything, /Open garden afternoon/, 'a public gathering title is shown');
  assert.match(view(s, 'journal').lines.join(' '), /1 entry/, 'only a count and a date leave');
  assert.match(view(s, 'journal').lines.join(' '), /never|do not read/i);
  // Bob's own view says the same about Bob and shows nothing of Alice.
  const bobs = JSON.stringify(['journal', 'passport', 'community', 'karma', 'next'].map(name => view(s, name, {player: BOB})));
  assert.ok(!bobs.includes(SECRET_A) && !bobs.includes(SECRET_B) && !/Alice/.test(bobs));
  // The code that builds the views cannot even reach the vault, messages or journal text.
  assert.deepEqual([...hud.READS].sort(), ['callings', 'community', 'firstPlay', 'journey', 'karmaWallet', 'quests']);
  const source = readFileSync(new URL('../src/veloren-ext/view.js', import.meta.url), 'utf8');
  assert.ok(!/vault|\.messages|memory\(|text\)\s*\}\s*of journal/i.test(source.replace(/\/\/.*$/gm, '')), 'no vault or private message access in the code');
  assert.ok(!/\.journal\b[^;\n]*\.text|entry\.text/.test(source), 'journal text is never read');
});

test('only an allow-list of read methods is reachable', async t => {
  const s = await setup(t);
  const facade = hud.readOnly(s.platform);
  assert.deepEqual(Object.keys(facade).sort(), [...hud.READS].sort());
  for (const forbidden of ['writeJournal', 'message', 'gardenAction', 'karmaSpend', 'karmaSettle', 'callingSelect', 'questJoin', 'vaultRead', 'createEvent', 'run', 'transaction']) {
    assert.equal(facade[forbidden], undefined, forbidden);
  }
  assert.throws(() => { 'use strict'; facade.writeJournal = () => 1; }, TypeError, 'the facade is frozen');
});

test('the views write no money, rewards or progress, however often they are asked', async t => {
  const s = await setup(t);
  const count = (sql) => s.platform.get(sql).n;
  const before = {
    coins: count('SELECT COUNT(*) AS n FROM coin_rewards'),
    karma: count('SELECT COUNT(*) AS n FROM karma_receipts'),
    purchases: count('SELECT COUNT(*) AS n FROM karma_purchases'),
    quest: count('SELECT COUNT(*) AS n FROM quest_enrollments'),
    journal: count('SELECT COUNT(*) AS n FROM journey_journal'),
    messages: count('SELECT COUNT(*) AS n FROM messages'),
    objects: count('SELECT COUNT(*) AS n FROM world_objects'),
    accounts: count('SELECT COUNT(*) AS n FROM accounts'),
    tokens: count('SELECT COUNT(*) AS n FROM tokens'),
    steps: s.link.sql.get('SELECT COUNT(*) AS n FROM quest_progress').n,
  };
  for (let round = 0; round < 3; round++) for (const name of hud.HUD_PAGES) for (const page of [1, 2]) view(s, name, {page});
  const after = {
    coins: count('SELECT COUNT(*) AS n FROM coin_rewards'),
    karma: count('SELECT COUNT(*) AS n FROM karma_receipts'),
    purchases: count('SELECT COUNT(*) AS n FROM karma_purchases'),
    quest: count('SELECT COUNT(*) AS n FROM quest_enrollments'),
    journal: count('SELECT COUNT(*) AS n FROM journey_journal'),
    messages: count('SELECT COUNT(*) AS n FROM messages'),
    objects: count('SELECT COUNT(*) AS n FROM world_objects'),
    accounts: count('SELECT COUNT(*) AS n FROM accounts'),
    tokens: count('SELECT COUNT(*) AS n FROM tokens'),
    steps: s.link.sql.get('SELECT COUNT(*) AS n FROM quest_progress').n,
  };
  assert.deepEqual(after, before, 'nothing was created, spent, enrolled or advanced');
  assert.equal(s.platform.verifyAudit(), true);
  // Even a request whose "text" is a claim cannot do anything: the only inputs are a page name and number.
  assert.equal(s.link.progress(ALICE).next_step, 'meet');
});

// ---- page content --------------------------------------------------------------------------------

test('the pages tell the truth about a player\'s saved state', async t => {
  const s = await setup(t);
  const text = (name) => view(s, name).lines.join(' ');
  assert.match(text('passport'), /Passport of Alice/);
  assert.match(text('passport'), /Explorer/);
  assert.match(text('calling'), /Calling: Explorer/);
  assert.match(text('calling'), /Daily objective 1 \(open\)/);
  assert.match(text('karma'), /balance 0/);
  assert.match(text('karma'), /Chat cannot add or spend/);
  assert.match(text('quests'), /Quiet Survey/);
  assert.match(text('quests'), /practice quest/);
  assert.match(text('help'), /scripted guide/);
  assert.match(text('help'), /cannot give, buy, approve or change/);
  assert.match(text('start'), /Step 1, done/);
  assert.match(text('start'), /Step 2, to do: Choose a calling/);
  // The Veloren practice quest moves only with signed server events.
  assert.match(text('next'), /stand beside her/);
  advanceQuest(s, 1);
  assert.match(text('next'), /farm field/);
  assert.match(text('quests'), /farm field|survey/i);
  advanceQuest(s, 2);
  advanceQuest(s, 0);
  assert.match(text('passport'), /practice quest/);
  // After a calling is chosen the daily objective names it.
  s.f.tx('callingSelect', s.f.actor('alice'), {agent_id: s.alice.id, calling_id: 'cultivator'});
  assert.match(text('calling'), /Cultivator of the Living Gardens/);
  assert.match(text('calling'), /Plant a garden crop/);
  assert.match(text('start'), /Step 2, done: Choose a calling/);
  // Bob is untouched by Alice's choices.
  assert.match(view(s, 'calling', {player: BOB}).lines.join(' '), /Explorer/);
});

test('a joined quest chain and a gathering appear, with the player\'s own part marked', async t => {
  const s = await setup(t);
  s.f.tx('questJoin', s.f.actor('alice'), {agent_id: s.alice.id, chain_id: 'quiet-harvest'}, 'key-1');
  assert.match(view(s, 'quests').lines.join(' '), /Quest .*Quiet Harvest.*0 of 3 steps/);
  assert.match(view(s, 'next').lines.join(' '), /Your quest .*Quiet Harvest/);
  const event = s.f.tx('createEvent', s.f.actor('bob'), {agent_id: s.bob.id, title: 'Evening listening circle', summary: 'Talk.', starts_at: new Date(s.f.clock() + 3600000).toISOString(), ends_at: new Date(s.f.clock() + 7200000).toISOString(), capacity: 5});
  assert.match(view(s, 'community').lines.join(' '), /Gathering: Evening listening circle .*1 person going\./);
  s.f.tx('eventRSVP', s.f.actor('alice'), {agent_id: s.alice.id, event_id: event.id, action: 'join'});
  assert.match(view(s, 'community').lines.join(' '), /2 people going \(you are going\)/);
});

// ---- the HTTP surface ----------------------------------------------------------------------------

test('over HTTP: only a guide credential may read views, with the right scope and a valid request', async t => {
  const s = await setup(t);
  const call = await serve(t, s);
  const ok = `/veloren/view/passport?player_uuid=${ALICE}`;
  assert.equal((await call(ok)).status, 401, 'no credential');
  assert.equal((await call(ok, {token: 'not-a-token'})).status, 401);
  assert.equal((await call(ok, {token: '0'.repeat(64)})).status, 401);
  const narrow = s.link.issueCredential({resident_id: 'lw-selene', scopes: ['talk'], days: 1});
  assert.equal((await call(ok, {token: narrow.token})).status, 403, 'talk scope is not enough');
  const events = s.link.issueCredential({resident_id: 'lw-selene', scopes: ['events'], days: 1});
  assert.equal((await call(ok, {token: events.token})).status, 403, 'the relay credential cannot read views');
  const lyra = await call(ok, {token: s.lyra.token});
  assert.equal(lyra.status, 403, 'Lyra\'s director credential is not a guide credential');
  assert.match(lyra.data.error, /guide/i);

  const good = await call(ok, {token: s.selene.token});
  assert.equal(good.status, 200);
  assert.equal(good.data.linked, true);
  assert.equal(good.data.command, 'passport');
  assert.match(good.data.lines[0], /Passport of Alice/);
  assert.ok(JSON.stringify(good.data).length <= hud.HUD_POLICY.response_bytes);

  s.clock.now += 5000;
  assert.equal((await call(`/veloren/view/passport?player_uuid=${STRANGER}`, {token: s.selene.token})).data.linked, false, 'an unlinked player over HTTP');
  // A uuid is lower case only, so an upper-case hex digit is malformed (the fixtures are all digits, so
  // `ALICE.toUpperCase()` alone would still be the same valid id); two player ids in one request are
  // ambiguous and refused.
  for (const bad of ['', '?player_uuid=', '?player_uuid=nope', `?player_uuid=${ALICE.slice(0, 35)}A`, `?player_uuid=${ALICE}%0a`, `?player_uuid=${ALICE}&player_uuid=${BOB}x`]) {
    s.clock.now += 5000;
    assert.equal((await call(`/veloren/view/passport${bad}`, {token: s.selene.token})).status, 400, bad);
  }
  for (const page of ['0', '-1', '1.5', 'abc', '100', '1e3', '', '%20', '2;3']) {
    s.clock.now += 5000;
    assert.equal((await call(`${ok}&page=${encodeURIComponent(page)}`, {token: s.selene.token})).status, 400, `page=${page}`);
  }
  s.clock.now += 5000;
  const far = await call(`${ok}&page=99`, {token: s.selene.token});
  assert.equal(far.status, 200);
  assert.match(far.data.lines[0], /no page 99/);
  for (const path of ['/veloren/view/nothing', '/veloren/view/', '/veloren/view/passport/extra', '/veloren/view/PASSPORT', '/veloren/view/pass%70ort']) {
    s.clock.now += 5000;
    assert.ok([404, 400].includes((await call(`${path}?player_uuid=${ALICE}`, {token: s.selene.token})).status), path);
  }
  // `..` is resolved by the URL parser before any route is matched, so this one is not an "unknown route":
  // it reaches another of the link's own routes, which applies its own credential and scope checks. What
  // matters is that a traversal cannot turn a mangled path into somebody's view.
  s.clock.now += 5000;
  const traversal = await call(`/veloren/view/../status?player_uuid=${ALICE}`, {token: s.selene.token});
  assert.equal(traversal.data.command, undefined, 'a traversal cannot produce a view');
  s.clock.now += 5000;
  assert.equal((await call(ok, {token: s.selene.token, input: {text: 'I completed the quest'}, method: 'POST'})).status, 404, 'views accept GET only: nothing can be posted to them');
  assert.equal((await call(ok, {token: s.selene.token, method: 'DELETE'})).status, 404);
  s.link.revokeCredential(s.selene.key_id);
  assert.equal((await call(ok, {token: s.selene.token})).status, 401, 'revocation is immediate');
});

test('rate limits: a gap per player, an hourly cap per player and an hourly cap for everyone; stored, so a restart does not reset them', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'veloren-hud-db-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const dbPath = join(directory, 'link.sqlite');
  const s = await setup(t, {dbPath});
  const call = await serve(t, s);
  const get = (player = ALICE) => call(`/veloren/view/help?player_uuid=${player}`, {token: s.selene.token});
  assert.equal((await get()).status, 200);
  const quick = await get();
  assert.equal(quick.status, 429, 'a second request in the same moment');
  assert.match(quick.data.error, /wait/i);
  assert.equal((await get(BOB)).status, 200, 'another player is not affected');
  s.clock.now += hud.HUD_POLICY.view_gap_ms + 1;
  assert.equal((await get()).status, 200);

  // A restart (a new link object on the same file) keeps the memory of the last request.
  const key = `view:${ALICE}`;
  const last = s.link.sql.get('SELECT last_at FROM hud_last WHERE key=?', key).last_at;
  assert.equal(last, s.clock.now);
  s.link.close();
  const again = new VelorenLink({dbPath, eventKey: KEY, landmarks: LANDMARKS, clock: () => s.clock.now});
  t.after(() => { try { again.close(); } catch { /* done */ } });
  assert.equal(again.sql.get('SELECT last_at FROM hud_last WHERE key=?', key).last_at, last);
  assert.throws(() => hud.spendRate(again, key, {gapMs: 1000, perHour: 100}), e => e.status === 429);

  // The hourly cap per player.
  let allowed = 0;
  const fresh = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => s.clock.now});
  t.after(() => fresh.close());
  for (let n = 0; n < 30; n++) {
    try { hud.spendRate(fresh, 'k', {gapMs: 0, perHour: 5}); allowed += 1; } catch (e) { assert.equal(e.status, 429); }
  }
  assert.equal(allowed, 5);
  s.clock.now += 3_600_000;
  assert.doesNotThrow(() => hud.spendRate(fresh, 'k', {gapMs: 0, perHour: 5}), 'a new hour starts afresh');
  // A refused request does not extend the wait.
  const before = fresh.sql.get('SELECT last_at FROM hud_last WHERE key=?', 'k').last_at;
  try { hud.spendRate(fresh, 'k', {gapMs: 10 ** 9, perHour: 5}); } catch { /* expected */ }
  assert.equal(fresh.sql.get('SELECT last_at FROM hud_last WHERE key=?', 'k').last_at, before);
});

test('the per-player hourly cap and the global hourly cap are enforced over HTTP', async t => {
  const s = await setup(t);
  const call = await serve(t, s);
  let refused = 0, served = 0;
  for (let n = 0; n < hud.HUD_POLICY.view_per_hour + 5; n++) {
    s.clock.now += hud.HUD_POLICY.view_gap_ms + 1;
    const response = await call(`/veloren/view/help?player_uuid=${ALICE}`, {token: s.selene.token});
    if (response.status === 200) served += 1; else { assert.equal(response.status, 429); refused += 1; }
  }
  assert.equal(served, hud.HUD_POLICY.view_per_hour);
  assert.equal(refused, 5);
  // The same player an hour later is served again.
  s.clock.now += 3_600_000;
  assert.equal((await call(`/veloren/view/help?player_uuid=${ALICE}`, {token: s.selene.token})).status, 200);
  // The global counter has been counting everyone.
  const total = s.link.sql.all("SELECT calls FROM hud_usage WHERE key='*'").reduce((sum, row) => sum + row.calls, 0);
  assert.ok(total >= hud.HUD_POLICY.view_per_hour);
});

// ---- the quest tracker and the map marker -----------------------------------------------------------

test('the tracker names the current objective and its landmark from stored facts only', async t => {
  const s = await setup(t);
  assert.deepEqual({step: hud.trackerTarget(s.link, ALICE).step, landmark: hud.trackerTarget(s.link, ALICE).landmark_id}, {step: 'meet', landmark: null});
  advanceQuest(s, 1);
  const survey = hud.trackerTarget(s.link, ALICE);
  assert.equal(survey.step, 'survey');
  assert.equal(survey.landmark_id, 'lyra-survey');
  assert.equal(survey.landmark_name, "Harr's farm field");
  advanceQuest(s, 2);
  // Re-running the first two steps is a no-op (events are stored once and steps are ordered), so
  // continue with the third and last step.
  const auth = s.link.authenticate(s.lyra.token, 'events');
  s.clock.now += 1000;
  s.link.ingest(auth, [lyraEvent(s, {kind: 'resident.met', landmark_id: 'lyra-post'})]);
  assert.equal(hud.trackerTarget(s.link, ALICE).complete, true);
  // Another player's progress is separate.
  assert.equal(hud.trackerTarget(s.link, BOB).step, 'meet');
});

test('tracking asks for a signed hud_marker naming a landmark, only for a linked player, and is paced', async t => {
  const s = await setup(t);
  const call = await serve(t, s);
  const track = (player = ALICE, token = s.selene.token) => call('/veloren/hud/track', {token, input: {player_uuid: player}});
  const commands = () => (existsSync(s.commandsPath) ? readFileSync(s.commandsPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

  // Step "meet" has no fixed place: nothing is issued.
  const none = await track();
  assert.equal(none.status, 200);
  assert.equal(none.data.issued, false);
  assert.equal(none.data.reason, 'no_landmark');
  assert.equal(commands().length, 0);

  advanceQuest(s, 1);
  s.clock.now += 20_000;
  const unlinked = await track(STRANGER);
  assert.equal(unlinked.data.issued, false);
  assert.equal(unlinked.data.linked, false);
  assert.equal(commands().length, 0, 'no command for an unlinked player');

  const issued = await track();
  assert.equal(issued.data.issued, true);
  assert.match(issued.data.lines[0], /only say it is placed once the world confirms/);
  const written = commands();
  assert.equal(written.length, 1);
  const command = written[0];
  assert.equal(command.kind, 'hud_marker');
  assert.equal(command.player_uuid, ALICE);
  assert.equal(command.sig, signCommand(KEY, command), 'signed with the shared key');
  assert.deepEqual(Object.keys(JSON.parse(command.args)).sort(), ['label', 'landmark_id'], 'a landmark id and a label; never coordinates');
  assert.equal(JSON.parse(command.args).landmark_id, 'lyra-survey');
  assert.match(JSON.parse(command.args).label, /Quiet Survey: Harr's farm field/);
  assert.equal(command.expires_at - command.issued_at, hud.HUD_POLICY.marker_ttl_ms);
  assert.equal(issued.data.cmd_id, command.cmd_id);

  // Paced: asking again at once is refused, and nothing more is written.
  const quick = await track();
  assert.equal(quick.status, 429);
  assert.equal(commands().length, 1);
  // Lyra's credential cannot ask for markers.
  s.clock.now += 20_000;
  assert.equal((await track(ALICE, s.lyra.token)).status, 403);
  assert.equal(commands().length, 1);

  // Once the quest is complete there is nothing to mark.
  advanceQuest(s, 2);
  const auth = s.link.authenticate(s.lyra.token, 'events');
  s.clock.now += 1000;
  s.link.ingest(auth, [lyraEvent(s, {kind: 'resident.met', landmark_id: 'lyra-post'})]);
  s.clock.now += 20_000;
  const done = await track();
  assert.equal(done.data.issued, false);
  assert.equal(done.data.reason, 'complete');
  assert.equal(commands().length, 1);
});

test('with commands switched off, tracking says so instead of pretending', async t => {
  const s = await setup(t, {commands: false});
  const call = await serve(t, s);
  advanceQuest(s, 1);
  const response = await call('/veloren/hud/track', {token: s.selene.token, input: {player_uuid: ALICE}});
  assert.equal(response.status, 200);
  assert.equal(response.data.issued, false);
  assert.equal(response.data.reason, 'commands_off');
});

test('a marker is "placed" only after a signed acknowledgement, and only its own player may ask', async t => {
  const s = await setup(t);
  const call = await serve(t, s);
  advanceQuest(s, 1);
  s.clock.now += 20_000;
  const issued = await call('/veloren/hud/track', {token: s.selene.token, input: {player_uuid: ALICE}});
  const id = issued.data.cmd_id;
  const status = async (player = ALICE, cmd = id) => { s.clock.now += 1500; return call(`/veloren/hud/status?player_uuid=${player}&cmd_id=${cmd}`, {token: s.selene.token}); };
  assert.equal((await status()).data.status, 'pending');
  // Anybody's claim is worthless without the server's signature.
  const auth = s.link.authenticate(s.lyra.token, 'events');
  const forged = lyraEvent(s, {kind: 'command.applied', landmark_id: id, player_alias: ''});
  s.link.ingest(auth, [{...forged, sig: '0'.repeat(64)}]);
  assert.equal((await status()).data.status, 'pending');
  s.link.ingest(auth, [lyraEvent(s, {kind: 'command.applied', landmark_id: id, player_alias: ''})]);
  assert.equal((await status()).data.status, 'applied');
  // Another player, a command this feature did not issue, and junk ids reveal nothing.
  assert.equal((await status(BOB)).data.status, 'unknown');
  const foreign = s.link.issueCommand({kind: 'echo', player_uuid: ALICE, args: {text: 'hi'}, issuedBy: 'test'});
  assert.equal((await status(ALICE, foreign.cmd_id)).data.status, 'unknown');
  assert.equal((await status(ALICE, '00000000-0000-4000-8000-000000000000')).data.status, 'unknown');
  assert.equal((await status(ALICE, 'not-an-id')).status, 400);
  assert.equal((await status('nope', id)).status, 400);
  // A rejected command and an unacknowledged one are not "applied".
  s.clock.now += 20_000;
  const second = await call('/veloren/hud/track', {token: s.selene.token, input: {player_uuid: ALICE}});
  s.link.ingest(auth, [lyraEvent(s, {kind: 'command.rejected', landmark_id: second.data.cmd_id, player_alias: ''})]);
  assert.equal((await status(ALICE, second.data.cmd_id)).data.status, 'rejected');
  s.clock.now += 20_000;
  const third = await call('/veloren/hud/track', {token: s.selene.token, input: {player_uuid: ALICE}});
  s.clock.now += hud.HUD_POLICY.marker_ttl_ms + 5000;
  assert.equal((await status(ALICE, third.data.cmd_id)).data.status, 'expired_unconfirmed');
});

test('chat can never create progress: every view and track call leaves quest progress as the signed events left it', async t => {
  const s = await setup(t);
  const call = await serve(t, s);
  const snapshot = () => JSON.stringify([s.link.sql.all('SELECT * FROM quest_progress ORDER BY step_id'), s.link.sql.all('SELECT * FROM resident_notes'), s.link.sql.get('SELECT COUNT(*) AS n FROM link_events').n]);
  const before = snapshot();
  for (const name of hud.HUD_PAGES) {
    s.clock.now += 1500;
    await call(`/veloren/view/${name}?player_uuid=${ALICE}&page=1`, {token: s.selene.token});
  }
  for (let n = 0; n < 3; n++) { s.clock.now += 20_000; await call('/veloren/hud/track', {token: s.selene.token, input: {player_uuid: ALICE, completed: true, step: 'return'}}); }
  assert.equal(snapshot(), before);
  assert.equal(s.link.progress(ALICE).complete, false);
});

// ---- plumbing ------------------------------------------------------------------------------------

test('the hud keeps its own tables and leaves the core schema alone', async t => {
  const s = await setup(t);
  assert.equal(s.link.sql.get('PRAGMA user_version').user_version, 1);
  assert.equal(s.link.sql.get("SELECT version FROM ext_schema WHERE name='hud'").version, 1);
  assert.ok(s.link.sql.get("SELECT name FROM sqlite_master WHERE name='hud_usage'"));
  assert.ok(hud.GUIDE_RESIDENTS.includes('lw-selene'));
  assert.equal(hud.GUIDE_RESIDENTS.includes('lw-lyra'), false);
});

test('development identity fixtures work only on a developer machine and only from the named file', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'veloren-hud-dev-'));
  t.after(() => { rmSync(directory, {recursive: true, force: true}); setIdentityProvider(() => null); });
  const file = join(directory, 'links.json');
  writeFileSync(file, JSON.stringify({[ALICE]: {account_id: 'a', agent_id: 'b', display_name: 'Dev'}}));
  setIdentityProvider(() => null);
  hud.installDevIdentity({});
  assert.equal(identityFor(null, ALICE), null, 'off unless the variable is set');
  hud.installDevIdentity({NEMO_HUD_DEV_LINKS: file, LUCY_PUBLIC_ORIGIN: 'https://example.org'});
  assert.equal(identityFor(null, ALICE), null, 'ignored when NemoWorld has a public origin');
  hud.installDevIdentity({NEMO_HUD_DEV_LINKS: file, RENDER_EXTERNAL_URL: 'https://example.org'});
  assert.equal(identityFor(null, ALICE), null);
  hud.installDevIdentity({NEMO_HUD_DEV_LINKS: file});
  assert.deepEqual(identityFor(null, ALICE), {account_id: 'a', agent_id: 'b', display_name: 'Dev'});
  assert.equal(identityFor(null, BOB), null, 'only listed players');
  rmSync(file);
  assert.equal(identityFor(null, ALICE), null, 'a missing file fails closed');
});
