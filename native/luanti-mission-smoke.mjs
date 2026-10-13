// Real Luanti 5.17 server/mod callback driving the NATIVE MISSION routes against a disposable
// NemoWorld HTTP server and DB. Proves browser and native read the same mission and active-claim
// ids, that claim and submission each produce exactly one saved row across a retry and a restart,
// and that a revoked pairing is refused. Run with LUANTI_BIN set to the verified luanti 5.17.0
// executable. The claim is checked for web/native parity while it is still leased, before submission.
import {mkdtemp, mkdir, cp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Platform} from '../src/platform.js';
import {createApp} from '../server.js';
import {createBridge} from './bridge.mjs';

const binary = process.env.LUANTI_BIN;
if (!binary) throw new Error('Set LUANTI_BIN to the verified Luanti 5.17.0 executable.');
const root = await mkdtemp(join(tmpdir(), 'nemo-luanti-mission-'));
let platform, app, bridge, engine;
const settle = ms => new Promise(r => setTimeout(r, ms));
try {
  platform = new Platform(join(root, 'nemo.sqlite'));
  const login = await platform.register({name:'Native mission operator',email:'native-mission@example.org',password:'disposable-password-2026',consent:true});
  const actor = platform.authenticate(login.token);
  const human = platform.transaction(() => platform.createAgent(actor, {kind:'human', name:'Mission Probe', capabilities:'Reviewed mission work', limitations:'Disposable test'}));
  const mission = platform.transaction(() => platform.createMission(actor, {title:'Native mission smoke', area:'Climate', summary:'A disposable real task for the native callback.', beneficiary:'Disposable fixture', owner_id:actor.account.id, reviewer_id:actor.account.id, rubric:'Check exact sources, rights and uncertainty.'}));
  const task = platform.transaction(() => platform.createTask(actor, {mission_id:mission.id, title:'Record one source', instructions:'Provide attribution, location and rights.', rights:'Explicit permission required.', allowed_domains:['example.org']}));
  platform.transaction(() => platform.missionStatus(actor, mission.id, 'open'));
  platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?', 'frontier:0:0', human.id);
  app = createApp({platform});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${app.server.address().port}`;
  const modKey = randomBytes(32).toString('hex');
  bridge = createBridge({api, modKey});
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;

  const user = join(root, 'luanti'), game = join(user, 'games', 'nemoworld_game');
  await mkdir(join(game, 'mods', 'nemo_probe'), {recursive:true});
  await cp(new URL('./nemoworld_game/', import.meta.url), game, {recursive:true});
  await writeFile(join(game, 'mods', 'nemo_probe', 'mod.conf'), 'name = nemo_probe\ndepends = nemo\n');
  const probeFile = join(game, 'mods', 'nemo_probe', 'init.lua');
  const world = join(user, 'worlds', 'slice'); await mkdir(world, {recursive:true});
  await writeFile(join(world, 'world.mt'), 'gameid = nemoworld\nbackend = sqlite3\nmg_name = singlenode\n');
  const config = join(user, 'minetest.conf');
  await writeFile(config, `secure.enable_security = true\nsecure.http_mods = nemo\nnemo_bridge_url = ${bridgeUrl}\nnemo_bridge_key = ${modKey}\nmg_name = singlenode\nbind_address = 127.0.0.1\nport = 39335\nserver_announce = false\n`, {mode:0o600});
  const pair = async () => (await fetch(bridgeUrl + '/pair/start', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:login.token, agent_id:human.id})}).then(r => r.json())).code;
  const probeScript = code => (body) => `local code = ${JSON.stringify(code)}\ncore.register_on_mods_loaded(function()\n core.after(1,function() core.registered_chatcommands.nemo_pair.func('Probe',code) end)\n ${body}\nend)\n`;

  const runEngine = async (probe, steps, timeout = 30000) => {
    await writeFile(probeFile, probe);
    let logs = '';
    const child = spawn(binary, ['--server','--world',world,'--config',config,'--logfile',''], {env:{...process.env, LUANTI_USER_PATH:user}, stdio:['ignore','pipe','pipe']});
    engine = child;
    child.stdout.on('data', b => { logs += b.toString(); });
    child.stderr.on('data', b => { logs += b.toString(); });
    for (const step of steps) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline && !logs.includes(step.marker)) await settle(100);
      if (step.then) await step.then(logs);
    }
    child.kill('SIGINT'); await new Promise(r => child.once('exit', r)); engine = null;
    return logs;
  };

  // Stage A: pair, read the directory, claim twice (retry), read the directory again.
  const logsA = await runEngine(probeScript(await pair())([
    `core.after(5,function() core.registered_chatcommands.nemo_missions.func('Probe','') end)`,
    `core.after(7,function() core.registered_chatcommands.nemo_claim.func('Probe',${JSON.stringify(task.id)}) end)`,
    `core.after(9,function() core.registered_chatcommands.nemo_claim.func('Probe',${JSON.stringify(task.id)}) end)`,
    `core.after(11,function() core.registered_chatcommands.nemo_missions.func('Probe','') end)`,
    `core.after(14,function() core.log('action','NEMO_CLAIM_DONE') end)`,
  ].join('\n ')), [{marker:'NEMO_CLAIM_DONE'}]);
  assert.match(logsA, new RegExp(`NEMO_MISSIONS_RESULT tasks=[^ ]*${task.id}`), logsA.slice(-3000));
  assert.match(logsA, /NEMO_CLAIM_RESULT id=/, logsA.slice(-3000));
  assert.equal(platform.get('SELECT COUNT(*) n FROM claims').n, 1, 'one claim row after a retry');
  assert.equal(platform.get('SELECT account_id FROM claims').account_id, actor.account.id);
  assert.equal(platform.get('SELECT agent_id FROM claims').agent_id, human.id);
  const claimId = platform.get('SELECT id FROM claims').id;
  // Browser parity while the claim is still leased: the web directory reports the same task and claim ids.
  const webDir = await (await fetch(`${api}/api/v1/missions?limit=12`, {headers:{Authorization:`Bearer ${login.token}`}})).json();
  assert.ok(webDir.tasks.some(item => item.id === task.id), 'the web directory carries the same task id');
  assert.equal(webDir.active_claim.id, claimId, 'web and native report the same active claim id');
  assert.match(logsA, new RegExp(`claim=${claimId}`), logsA.slice(-3000));

  // Stage B: restart Luanti, re-pair, submit twice (retry). The active claim is read from NemoWorld.
  const logsB = await runEngine(probeScript(await pair())([
    `core.after(6,function() core.registered_chatcommands.nemo_submit.func('Probe','A native-sourced register entry.') end)`,
    `core.after(9,function() core.registered_chatcommands.nemo_submit.func('Probe','A native-sourced register entry.') end)`,
    `core.after(13,function() core.log('action','NEMO_SUBMIT_DONE') end)`,
  ].join('\n ')), [{marker:'NEMO_SUBMIT_DONE'}]);
  assert.match(logsB, /NEMO_SUBMIT_RESULT id=.* status=pending_review/, logsB.slice(-3000));
  assert.equal(platform.get('SELECT COUNT(*) n FROM submissions').n, 1, 'one submission row after a retry');

  // Stage C: restart again and read the directory: the saved claim persists, no duplicate.
  const logsC = await runEngine(probeScript(await pair())([
    `core.after(6,function() core.registered_chatcommands.nemo_missions.func('Probe','') end)`,
    `core.after(9,function() core.log('action','NEMO_RESTART_DONE') end)`,
  ].join('\n ')), [{marker:'NEMO_RESTART_DONE'}]);
  // After submission the claim is 'submitted' and the task 'under_review', so neither is listed as
  // open — but the saved rows must persist across the restart, exactly one each, and the claim must
  // still name the same lease the native client created before the restart.
  assert.match(logsC, /NEMO_MISSIONS_RESULT/, logsC.slice(-3000));
  assert.equal(platform.get('SELECT COUNT(*) n FROM claims').n, 1, 'the saved claim persists across a restart');
  assert.equal(platform.get('SELECT COUNT(*) n FROM submissions').n, 1, 'the saved submission persists across a restart');
  assert.equal(platform.get('SELECT status FROM claims').status, 'submitted');
  assert.equal(platform.get('SELECT id FROM claims').id, claimId, 'the same claim id persists');

  // Stage D: pair, confirm the route works, revoke the operator session mid-run, confirm the next
  // native call is refused (the bridge re-checks the session before every request).
  const logsD = await runEngine(probeScript(await pair())([
    `core.after(5,function() core.registered_chatcommands.nemo_missions.func('Probe','') end)`,
    `core.after(7,function() core.log('action','NEMO_PAIRED_OK') end)`,
    `core.after(10,function() core.registered_chatcommands.nemo_missions.func('Probe','') end)`,
    `core.after(19,function() core.log('action','NEMO_REVOKE_DONE') end)`,
  ].join('\n ')), [
    {marker:'NEMO_PAIRED_OK', then: () => { platform.run('UPDATE tokens SET revoked=1 WHERE hash=?', createHash('sha256').update(login.token).digest('hex')); }},
    {marker:'NEMO_REVOKE_DONE'},
  ]);
  assert.match(logsD, /NEMO_MISSIONS_ERROR/, logsD.slice(-3000));
  // The same refusal, deterministically, on the bridge route the mod calls.
  const refused = await fetch(bridgeUrl + '/native/missions', {method:'POST', headers:{'Content-Type':'application/json','X-Nemo-Mod-Key':modKey}, body:JSON.stringify({player:'Probe'})});
  assert.equal(refused.status, 401, 'a revoked operator session cannot drive the native mission route');
  process.stdout.write('PASS: real Luanti 5.17 native mission callbacks -> one claim and one submission row across a retry and a restart; browser and native share the task and active-claim ids; a revoked pairing is refused\n');
} finally {
  if (engine) { engine.kill('SIGINT'); await new Promise(r => { if (engine.exitCode !== null) r(); else engine.once('exit', r); }); }
  if (bridge) await new Promise(r => bridge.close(r));
  if (app) { await app.stopWorkers(); await new Promise(r => { app.server.close(r); app.server.closeAllConnections(); }); }
  platform?.close();
  await rm(root, {recursive:true, force:true});
}
