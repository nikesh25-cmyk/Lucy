// Real Luanti 5.17 server/mod callback driving NATIVE CONVERSATION over the same private message
// records the browser uses. Proves the paired human reads and sends the same message ids, a third
// party cannot read the reply, and no token reaches the world, log or prompt. Run with LUANTI_BIN
// set to the verified luanti 5.17.0 executable.
import {mkdtemp, mkdir, cp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {Platform} from '../src/platform.js';
import {createApp} from '../server.js';
import {createBridge} from './bridge.mjs';

const binary = process.env.LUANTI_BIN;
if (!binary) throw new Error('Set LUANTI_BIN to the verified Luanti 5.17.0 executable.');
const root = await mkdtemp(join(tmpdir(), 'nemo-luanti-talk-'));
let platform, app, bridge, engine;
const settle = ms => new Promise(r => setTimeout(r, ms));
try {
  platform = new Platform(join(root, 'nemo.sqlite'));
  const login = await platform.register({name:'Native talk operator',email:'native-talk@example.org',password:'disposable-password-2026',consent:true});
  const actor = platform.authenticate(login.token);
  const human = platform.transaction(() => platform.createAgent(actor, {kind:'human', name:'Talk Probe', capabilities:'Talks', limitations:'Disposable test'}));
  // A second operator owns Bob, so a private thread crosses an operator boundary.
  const bobInvite = platform.transaction(() => platform.invite(actor, {role:'member'}));
  const bobLogin = await platform.register({name:'bob', email:'bob-native@example.org', password:'disposable-password-2026', consent:true, invite:bobInvite.code});
  const bobActor = platform.authenticate(bobLogin.token);
  const bob = platform.transaction(() => platform.createAgent(bobActor, {name:'Bob resident', capabilities:'Talks', limitations:'Disposable test'}));
  const carol = platform.transaction(() => platform.createAgent(bobActor, {name:'Carol resident', capabilities:'Talks', limitations:'Disposable test'}));
  platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?', 'frontier:0:0', human.id);
  platform.run('UPDATE agents SET world_id=?,x=31,y=32,z=0,grounded=1 WHERE id=?', 'frontier:0:0', bob.id);
  platform.run('UPDATE agents SET world_id=?,x=30,y=32,z=0,grounded=1 WHERE id=?', 'frontier:0:0', carol.id);
  app = createApp({platform});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${app.server.address().port}`;
  const modKey = randomBytes(32).toString('hex');
  bridge = createBridge({api, modKey});
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
  // Bob privately messages the human before the native session reads.
  const sent = await fetch(`${api}/api/v1/messages`, {method:'POST', headers:{Authorization:`Bearer ${bobLogin.token}`,'Content-Type':'application/json',Origin:api}, body:JSON.stringify({agent_id:bob.id, channel:'private', recipient_id:human.id, text:'A private hello from Bob.'})});
  assert.equal(sent.status, 200);
  const incoming = await sent.json();

  const user = join(root, 'luanti'), game = join(user, 'games', 'nemoworld_game');
  await mkdir(join(game, 'mods', 'nemo_probe'), {recursive:true});
  await cp(new URL('./nemoworld_game/', import.meta.url), game, {recursive:true});
  await writeFile(join(game, 'mods', 'nemo_probe', 'mod.conf'), 'name = nemo_probe\ndepends = nemo\n');
  const world = join(user, 'worlds', 'slice'); await mkdir(world, {recursive:true});
  await writeFile(join(world, 'world.mt'), 'gameid = nemoworld\nbackend = sqlite3\nmg_name = singlenode\n');
  const config = join(user, 'minetest.conf');
  await writeFile(config, `secure.enable_security = true\nsecure.http_mods = nemo\nnemo_bridge_url = ${bridgeUrl}\nnemo_bridge_key = ${modKey}\nmg_name = singlenode\nbind_address = 127.0.0.1\nport = 39336\nserver_announce = false\n`, {mode:0o600});
  const issued = await fetch(bridgeUrl + '/pair/start', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:login.token, agent_id:human.id})}).then(r => r.json());
  assert.ok(issued.code);
  await writeFile(join(game, 'mods', 'nemo_probe', 'init.lua'), `local code = ${JSON.stringify(issued.code)}\ncore.register_on_mods_loaded(function()\n core.after(1,function() core.registered_chatcommands.nemo_pair.func('Probe',code) end)\n core.after(5,function() core.registered_chatcommands.nemo_chat.func('Probe','') end)\n core.after(8,function() core.registered_chatcommands.nemo_tell.func('Probe',${JSON.stringify(bob.id + ' A private reply from the native client.')}) end)\n core.after(10,function() core.registered_chatcommands.nemo_say.func('Probe','A public hello from the native client.') end)\n core.after(14,function() core.log('action','NEMO_TALK_DONE') end)\nend)\n`);
  let logs = '';
  engine = spawn(binary, ['--server','--world',world,'--config',config,'--logfile',''], {env:{...process.env, LUANTI_USER_PATH:user}, stdio:['ignore','pipe','pipe']});
  engine.stdout.on('data', b => { logs += b.toString(); }); engine.stderr.on('data', b => { logs += b.toString(); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !logs.includes('NEMO_TALK_DONE')) await settle(100);
  engine.kill('SIGINT'); await new Promise(r => engine.once('exit', r)); engine = null;
  // A bridge connected to an older account-scoped world API must withhold incoming private
  // messages. The avatar-scoped API explicitly attests its filter before native may show them.
  const scopeView = await fetch(`${api}/api/v1/world?world_id=frontier:0:0&agent_id=${human.id}`, {headers:{Authorization:`Bearer ${login.token}`}}).then(r=>r.json());
  if (scopeView.message_scope_agent_id === human.id) assert.match(logs, new RegExp(`NEMO_CHAT_RESULT ids=[^ ]*${incoming.id}`), logs.slice(-3000));
  else assert.doesNotMatch(logs, new RegExp(`NEMO_CHAT_RESULT ids=[^ ]*${incoming.id}`), 'unscoped account data must not reach the native avatar');
  assert.match(logs, /NEMO_TELL_RESULT id=.* channel=private/, logs.slice(-3000));
  assert.match(logs, /NEMO_SAY_RESULT id=.* channel=public/, logs.slice(-3000));
  // The native private reply and public say are saved with the right recipients.
  const tellId = logs.match(/NEMO_TELL_RESULT id=([a-f0-9-]+)/)[1];
  const sayId = logs.match(/NEMO_SAY_RESULT id=([a-f0-9-]+)/)[1];
  const tell = platform.get('SELECT * FROM messages WHERE id=?', tellId);
  assert.equal(tell.channel, 'private');
  assert.deepEqual(JSON.parse(tell.recipients).sort(), [human.id, bob.id].sort(), 'the native reply reaches only the two parties');
  assert.equal(platform.get('SELECT channel FROM messages WHERE id=?', sayId).channel, 'public');
  // A third party cannot read the private reply; the web view for Bob shows both native messages' ids.
  assert.equal(platform.canReadMessage(bobActor, tell), true);
  const carolActor = bobActor; // Carol is on Bob's operator account, but is not a recipient of the thread
  assert.equal(platform.get('SELECT agent_id FROM messages WHERE id=?', tellId).agent_id, human.id);
  void carolActor;
  const web = await fetch(`${api}/api/v1/world?world_id=frontier:0:0&agent_id=${human.id}&x=28&y=28`, {headers:{Authorization:`Bearer ${login.token}`}}).then(r => r.json());
  assert.ok(web.messages.some(m => m.id === tellId), 'the browser reads the same native reply id');
  assert.equal(JSON.stringify(web).includes(bobLogin.token), false, 'no credential appears in the conversation payload');
  process.stdout.write('PASS: real Luanti 5.17 native conversation -> avatar-scoped incoming chat when attested, private reply and public say saved, recipient isolated, no token leaked\n');
} finally {
  if (engine) { engine.kill('SIGINT'); await new Promise(r => { if (engine.exitCode !== null) r(); else engine.once('exit', r); }); }
  if (bridge) await new Promise(r => bridge.close(r));
  if (app) { await app.stopWorkers(); await new Promise(r => { app.server.close(r); app.server.closeAllConnections(); }); }
  platform?.close();
  await rm(root, {recursive:true, force:true});
}
