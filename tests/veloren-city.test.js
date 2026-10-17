import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { VelorenLink, signEvent, withWorkSites } from '../src/veloren-link.js';
import { CityService, nativeHomePlot } from '../src/veloren-ext/city.js';

const KEY = Buffer.from('nemo-city-test-key-nemo-city-test-key-0001');
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const LANDMARKS = [{ id: 'lyra-post', name: 'Post', role: 'post' }, { id: 'lyra-survey', name: 'Field', role: 'survey' }];
const refuses = (status) => (e) => e.status === status;

async function world(t) {
  const f = await fixture(t);
  const dbPath = join(f.directory, 'city-link.sqlite');
  const commandsPath = join(f.directory, 'commands.jsonl');
  const options = { dbPath, eventKey: KEY, landmarks: LANDMARKS, commandsPath, clock: f.clock };
  let link = new VelorenLink(options);
  link.platform = f.platform;
  const avatar = f.tx('createAgent', f.actor('alice'), { name: 'Alice Guest', kind: 'human', capabilities: 'Visit', limitations: 'Human guest', color: '#397f79', symbol: '✦' });
  f.tx('createAgent', f.actor('bob'), { name: 'Bob Guest', kind: 'human', capabilities: 'Visit', limitations: 'Human guest', color: '#397f79', symbol: '✦' });
  for (const [uuid, owner] of [[P1, 'alice'], [P2, 'bob']]) link.sql.run('INSERT INTO ident_links VALUES(?,?,?,?,?)', uuid, f.actor(owner).account.id, owner, owner, f.clock());
  t.after(() => { try { link.close(); } catch {} });
  return {
    f, avatar, get link() { return link; }, get city() { return new CityService(link, f.platform); },
    commands: () => link.sql.all('SELECT * FROM home_commands'),
    restart() { link.close(); link = new VelorenLink(options); link.platform = f.platform; },
    ack(kind = 'command.applied') {
      const cmd = link.sql.get('SELECT * FROM home_commands ORDER BY issued_at DESC LIMIT 1');
      const e = { v: 1, server_id: 'city-test', seq: link.sql.get('SELECT COUNT(*) AS n FROM link_events').n + 1, kind, resident_id: 'lw-rowan', player_uuid: cmd.player_uuid, player_alias: 'Guest', landmark_id: cmd.cmd_id, occurred_at: f.clock() };
      e.sig = signEvent(KEY, e);
      const relay = link.issueCredential({ resident_id: 'lw-rowan', scopes: ['events'], days: 1 });
      link.ingest(link.authenticate(relay.token, 'events'), [e]);
    },
  };
}

test('native home plots use the existing strict Commons projection, not arbitrary coordinates', () => {
  assert.equal(nativeHomePlot('plot:0:0:1:2'), true);
  for (const id of ['plot:1:0:1:2', 'plot:0:0:3:2', 'plot:0:0:2:4', 'plot:0:0:8:2', 'plot:0:0:01:2', 'plot:-0:0:1:2', 'plot:0:0:1:2/../x', null]) assert.equal(nativeHomePlot(id), false, String(id));
});

test('home preview writes nothing, shows both scales, and offers only registry-available native plots', async t => {
  const w = await world(t);
  const view = w.city.home(w.f.actor('alice'));
  assert.equal(view.linked, true);
  assert.equal(view.builder.id, 'lw-rowan');
  assert.equal(view.builder.source, 'scripted');
  assert.equal(view.metrics.registry.width, 6);
  assert.equal(view.metrics.native.pitch, 14);
  assert.equal(view.metrics.native.pad_width, 12);
  assert.ok(view.available.length > 0);
  for (const plot of view.available) {
    assert.equal(nativeHomePlot(plot.id), true);
    assert.equal(w.f.platform.landPlot(w.f.actor('alice'), { plot_id: plot.id }).plot.state, 'available');
    assert.equal('account_id' in plot, false);
  }
  assert.equal(w.commands().length, 0);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
});

test('native ground report filters unsuitable plots and is checked again before assigning', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plotsPath = join(w.f.directory, 'native-plots.json');
  const selected = w.city.home(actor).available[0].id;
  const plots = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (![3, 4].includes(x) && ![3, 4].includes(y)) plots.push({ plot: `plot:0:0:${x}:${y}`, suitable: true });
  writeFileSync(plotsPath, JSON.stringify({ spacing: 14, plots }));
  const city = new CityService(w.link, w.f.platform, { plotsPath });
  assert.equal(city.home(actor).ground, 'estimated');
  assert.ok(city.home(actor).available.some(p => p.id === selected));
  plots.find(p => p.plot === selected).suitable = false;
  writeFileSync(plotsPath, JSON.stringify({ spacing: 14, plots }));
  assert.equal(city.home(actor).available.some(p => p.id === selected), false);
  assert.throws(() => city.requestHome(actor, { plot_id: selected, style: 0 }), refuses(409));
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
});

test('configured missing, corrupt or oversized native ground reports refuse before claiming', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plotsPath = join(w.f.directory, 'native-plots.json');
  const plot_id = w.city.home(actor).available[0].id;
  const city = new CityService(w.link, w.f.platform, { plotsPath });
  const duplicate = JSON.stringify({ spacing: 14, plots: Array.from({ length: 36 }, () => ({ plot: 'plot:0:0:0:0', suitable: true })) });
  for (const data of [null, '{bad json', JSON.stringify({ spacing: 6, plots: [] }), duplicate, ' '.repeat(65537)]) {
    if (data !== null) writeFileSync(plotsPath, data);
    assert.equal(city.home(actor).ground, 'unavailable');
    assert.deepEqual(city.home(actor).available, []);
    assert.throws(() => city.requestHome(actor, { plot_id, style: 0 }), refuses(503));
  }
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
});

test('guest request assigns through existing land rules and Rowan issues one native build; ack and restart preserve it', async t => {
  const w = await world(t);
  const plot_id = w.city.home(w.f.actor('alice')).available[0].id;
  const answer = w.city.requestHome(w.f.actor('alice'), { plot_id, style: 3 });
  assert.equal(answer.home.built, 'building');
  assert.equal(answer.home.plot, plot_id);
  assert.equal(w.f.platform.get("SELECT visibility FROM worlds WHERE owner_agent_id=? AND kind='house'", w.avatar.id).visibility, 'private');
  assert.equal(w.commands().length, 1);
  const outbox = readFileSync(join(w.f.directory, 'commands.jsonl'), 'utf8');
  assert.equal(JSON.parse(JSON.parse(outbox.trim()).args).style, 3);
  w.city.requestHome(w.f.actor('alice'), { plot_id, style: 3 });
  assert.equal(w.commands().length, 1, 'retry during build cannot enqueue twice');
  w.ack();
  w.restart();
  const saved = w.city.home(w.f.actor('alice'));
  assert.equal(saved.home.built, 'built');
  assert.equal(saved.home.plot, plot_id);
  assert.equal(saved.home.can_enter, true);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_events WHERE action=\'assign\'').n, 1);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('request strictly refuses impersonation, reserved/unsupported plots, invalid styles and runtime actors', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const good = w.city.home(actor).available[0].id;
  for (const input of [{ plot_id: good, style: 8 }, { plot_id: good, style: '3' }, { plot_id: good, style: 1, player_uuid: P2 }, { plot_id: good, style: 1, completed: true }]) assert.throws(() => w.city.requestHome(actor, input), refuses(400));
  for (const plot_id of ['plot:0:0:3:2', 'plot:1:0:1:2']) assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(409));
  assert.throws(() => w.city.requestHome({ ...actor, kind: 'runtime' }, { plot_id: good, style: 0 }), refuses(403));
  assert.equal(w.commands().length, 0);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
});

test('a second account cannot use a claimed plot or choose the first guest as command target', async t => {
  const w = await world(t);
  const plot_id = w.city.home(w.f.actor('alice')).available[0].id;
  w.city.requestHome(w.f.actor('alice'), { plot_id, style: 0 });
  assert.throws(() => w.city.requestHome(w.f.actor('bob'), { plot_id, style: 0 }), refuses(409));
  assert.equal(w.city.home(w.f.actor('bob')).home.plot, null);
  assert.throws(() => w.city.homeAction(w.f.actor('bob'), { action: 'enter', player_uuid: P1 }), refuses(400));
  assert.equal(w.commands().length, 1);
});

test('a new cottage on an existing empty claim is private, but a confirmed existing home keeps its visiting setting', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plot_id = w.city.home(actor).available[0].id;
  w.f.tx('landAssign', actor, { plot_id, purpose: 'Existing guest home claim' });
  w.city.requestHome(actor, { plot_id, style: 0 });
  assert.equal(w.f.platform.get("SELECT visibility FROM worlds WHERE owner_agent_id=? AND kind='house'", w.avatar.id).visibility, 'private');
  assert.throws(() => w.f.platform.space(w.f.actor('bob'), `house:${w.avatar.id}`), refuses(403));
  w.ack(); w.f.advance(3000);
  w.f.tx('homeSettings', actor, w.avatar.id, { house_visibility: 'public' });
  w.city.requestHome(actor, { plot_id, style: 1 });
  assert.equal(w.f.platform.get("SELECT visibility FROM worlds WHERE owner_agent_id=? AND kind='house'", w.avatar.id).visibility, 'public');
  assert.equal(w.commands().length, 1);
});

test('existing browser construction on a compatible claimed plot refuses native cottage construction without removing anything', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plot_id = 'plot:0:0:5:5';
  w.f.tx('landAssign', actor, { plot_id, purpose: 'An existing garden' });
  w.f.platform.run('UPDATE agents SET world_id=?,x=32,y=35,z=0,grounded=1 WHERE id=?', 'frontier:0:0', w.avatar.id);
  w.f.tx('frontierBuild', actor, w.avatar.id, { world_id: 'frontier:0:0', action: 'place', type: 'wood', x: 33, y: 35, z: 0 });
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(409));
  assert.equal(w.commands().length, 0);
  assert.equal(w.f.platform.landPlot(actor, { plot_id }).plot.block_count, 1);
  assert.equal(w.city.home(actor).home.plot, plot_id);
});

test('rejected and expired builds remain recoverable without a second assignment', async t => {
  const w = await world(t);
  const plot_id = w.city.home(w.f.actor('alice')).available[0].id;
  w.city.requestHome(w.f.actor('alice'), { plot_id, style: 0 });
  w.ack('command.rejected');
  assert.equal(w.city.home(w.f.actor('alice')).home.built, 'failed');
  w.f.advance(31_000);
  w.city.requestHome(w.f.actor('alice'), { plot_id, style: 1 });
  w.f.advance(181_000);
  assert.equal(w.city.home(w.f.actor('alice')).home.built, 'unconfirmed');
  w.restart();
  assert.equal(w.city.home(w.f.actor('alice')).home.plot, plot_id);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 1);
});

test('missing command channel or link refuses before assigning; an existing unsupported claim is preserved', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plot_id = w.city.home(actor).available[0].id;
  w.link.commands = null;
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(503));
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
  w.link.sql.run('DELETE FROM ident_links WHERE account_id=?', actor.account.id);
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(409));
  const existing = w.f.platform.land(actor, { world_id: 'frontier:1:0', status: 'available', limit: 1 }).plots[0];
  w.f.tx('landAssign', actor, { plot_id: existing.id, purpose: 'Existing garden' });
  const view = w.city.home(actor);
  assert.equal(view.home.plot, existing.id);
  assert.equal(view.compatible, false);
});

test('paused world refuses new work but the city remains readable', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plot_id = w.city.home(actor).available[0].id;
  w.f.tx('pause', w.f.actor('admin'), true);
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }));
  assert.equal(w.city.home(actor).paused, true);
  assert.equal(w.commands().length, 0);
});

test('command failure after assignment leaves the same recoverable plot and retry does not claim again', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plot_id = w.city.home(actor).available[0].id;
  const issue = w.link.issueCommand;
  w.link.issueCommand = () => { throw Object.assign(new Error('Outbox unavailable'), { status: 503 }); };
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(503));
  assert.equal(w.city.home(actor).home.plot, plot_id);
  assert.equal(w.commands().length, 0);
  w.link.issueCommand = issue;
  w.f.advance(3000);
  w.city.requestHome(actor, { plot_id, style: 0 });
  assert.equal(w.commands().length, 1);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_events WHERE action=\'assign\'').n, 1);
});

test('paused avatars, suspended accounts and removed identity links cannot request a new home', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plot_id = w.city.home(actor).available[0].id;
  w.f.platform.run("UPDATE agents SET status='paused' WHERE id=?", w.avatar.id);
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(409));
  w.f.platform.run("UPDATE agents SET status='active' WHERE id=?", w.avatar.id);
  w.f.platform.run("UPDATE accounts SET status='suspended' WHERE id=?", actor.account.id);
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(403));
  w.f.platform.run("UPDATE accounts SET status='active' WHERE id=?", actor.account.id);
  w.link.sql.run('DELETE FROM ident_links WHERE account_id=?', actor.account.id);
  assert.throws(() => w.city.requestHome(actor, { plot_id, style: 0 }), refuses(409));
  assert.equal(w.commands().length, 0);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
});

test('home entry uses the own confirmed cottage; pause never prevents asking to leave', async t => {
  const w = await world(t);
  const actor = w.f.actor('alice');
  const plot_id = w.city.home(actor).available[0].id;
  w.city.requestHome(actor, { plot_id, style: 0 });
  w.ack(); w.f.advance(3000);
  w.city.homeAction(actor, { action: 'enter' });
  assert.equal(w.commands().at(-1).kind, 'home_enter');
  w.f.tx('pause', w.f.actor('admin'), true); w.f.advance(6000);
  assert.throws(() => w.city.homeAction(actor, { action: 'enter' }));
  w.city.homeAction(actor, { action: 'leave' });
  assert.equal(w.commands().at(-1).kind, 'home_leave');
  assert.equal(w.commands().at(-1).player_uuid, P1);
});

test('public city directory exposes configured AI roles and real progress, never guest identities or private records', async t => {
  const w = await world(t);
  const before = w.f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n;
  const city = w.city.directory();
  assert.equal(city.human_role, 'guest');
  assert.ok(city.offices.length >= 6);
  const sites = new Set(withWorkSites(LANDMARKS).map(l => l.id));
  assert.ok(city.offices.every(o => sites.has(o.site)), 'every directory workplace names a shipped native site');
  assert.ok(city.residents.length >= 20);
  assert.ok(city.residents.every(r => r.source === 'scripted'));
  assert.equal(city.lifecycle.implemented, false, 'do not present a planned family simulation as shipped');
  for (const secret of [P1, P2, w.f.actor('alice').account.id, 'alice@example.org', 'world.sqlite']) assert.equal(JSON.stringify(city).includes(secret), false);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, before);
});

test('HTTP city routes: public directory, own session home, no anonymous/runtime writes and strict origin', async t => {
  const w = await world(t);
  const app = createApp({ platform: w.f.platform, velorenLink: w.link });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, owner, input, origin) => fetch(`${base}/api/v1/veloren/city${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { ...(owner ? { authorization: `Bearer ${w.f.credentials[owner].token}` } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  assert.equal((await call('')).status, 200);
  assert.equal((await call('/home')).status, 401);
  const own = await (await call('/home', 'alice')).json();
  const request = { plot_id: own.available[0].id, style: 0 };
  assert.equal((await call('/home/request', null, request, base)).status, 401);
  const agent = w.f.agent('bob', 'City worker');
  const runtime = w.f.platform.runtime(w.f.actor('bob'), agent.id, { minutes: 5, max_calls: 50 });
  assert.equal((await fetch(`${base}/api/v1/veloren/city/home/request`, { method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) })).status, 403);
  assert.equal((await call('/home/request', 'alice', request, 'https://untrusted.invalid')).status, 403);
  const response = await call('/home/request', 'alice', request);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).home.built, 'building');
  for (const path of ['/city', '/city.js', '/city.css']) assert.equal((await fetch(base + path)).status, 200, path);
});

test('city visits use only linked guest identity and fixed public destinations', async t => {
  const w = await world(t), actor = w.f.actor('alice');
  assert.throws(() => w.city.visit(actor, { destination: 'city' }), refuses(503));
  w.link.nativeCity = { enabled: true };
  for (const bad of [{ destination: 'secret' }, { destination: 'city', player_uuid: P2 }, { destination: 'city', x: 0 }]) assert.throws(() => w.city.visit(actor,bad), refuses(400));
  assert.throws(() => w.city.visit({...actor,kind:'runtime'},{destination:'city'}),refuses(403));
  const result=w.city.visit(actor,{destination:'city'});
  const cmd=w.link.sql.get('SELECT * FROM link_commands WHERE cmd_id=?',result.cmd_id);
  assert.equal(cmd.player_uuid,P1); assert.equal(cmd.kind,'city_visit');
  assert.deepEqual(JSON.parse(JSON.parse(readFileSync(w.link.commands.path,'utf8').trim().split('\n').find(line => JSON.parse(line).cmd_id===result.cmd_id)).args),{target:'city-arrival'});
  assert.equal(result.status,'pending');
  w.f.advance(1000);
  const back=w.city.visit(actor,{destination:'harr'});
  assert.equal(w.link.sql.get('SELECT kind FROM link_commands WHERE cmd_id=?',back.cmd_id).kind,'city_return');
});

test('city travel confirmation is scoped to the current linked guest and city command kind', async t => {
 const w=await world(t);w.link.nativeCity={enabled:true};const actor=w.f.actor('alice');
 const cmd=w.city.visit(actor,{destination:'city'});
 assert.equal(w.city.travelStatus(actor,cmd.cmd_id).status,'pending');
 assert.throws(()=>w.city.travelStatus(w.f.actor('bob'),cmd.cmd_id),refuses(404));
 assert.throws(()=>w.city.travelStatus(actor,'anything'),refuses(400));
});

 test('guest city travel is rate bounded before appending another native command', async t => {
 const w=await world(t); w.link.nativeCity={enabled:true};const actor=w.f.actor('alice');
 w.city.visit(actor,{destination:'city'});
 assert.throws(()=>w.city.visit(actor,{destination:'city'}),refuses(429));
 assert.equal(w.link.sql.get("SELECT COUNT(*) n FROM link_commands WHERE issued_by='city-guest-travel'").n,1);
 });
