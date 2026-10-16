// Real Luanti 5.17 server/mod callback against a disposable NemoWorld HTTP server and DB.
import {mkdtemp, mkdir, cp, writeFile, appendFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {Platform} from '../src/platform.js';
import {createApp} from '../server.js';
import {createBridge} from './bridge.mjs';
import {startLoopbackSmokeEngine} from './smoke-process.mjs';
import {getWorldDefinition} from '../world.js';

const binary = process.env.LUANTI_BIN;
if (!binary) throw new Error('Set LUANTI_BIN to the verified Luanti 5.17.0 executable.');
const root = await mkdtemp(join(tmpdir(),'nemo-luanti-smoke-'));
let platform, app, bridge, engine;
try {
  platform = new Platform(join(root,'nemo.sqlite'));
  const login = await platform.register({name:'Native smoke operator',email:'native-smoke@example.org',password:'disposable-password-2026',consent:true});
  const actor = platform.authenticate(login.token);
  const human = platform.transaction(()=>platform.createAgent(actor,{kind:'human',name:'Native Probe',capabilities:'Build',limitations:'Disposable test'}));
  platform.transaction(()=>platform.landAssign(actor,{plot_id:'plot:0:0:5:5',purpose:'Native callback smoke test',description:'Disposable.'}));
  platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?','frontier:0:0',human.id);
  app = createApp({platform});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const api=`http://127.0.0.1:${app.server.address().port}`;
  const modKey=randomBytes(32).toString('hex');
  bridge=createBridge({api,modKey});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  const bridgeUrl=`http://127.0.0.1:${bridge.address().port}`;
  const issued=await fetch(bridgeUrl+'/pair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:login.token,agent_id:human.id})}).then(r=>r.json());
  assert.ok(issued.code);
  const user=join(root,'luanti');
  const game=join(user,'games','nemoworld_game');
  await mkdir(join(game,'mods','nemo_probe'),{recursive:true});
  await cp(new URL('./nemoworld_game/',import.meta.url),game,{recursive:true});
  await writeFile(join(game,'mods','nemo_probe','mod.conf'),'name = nemo_probe\ndepends = nemo\n');
  await writeFile(join(game,'mods','nemo_probe','init.lua'),`local code = ${JSON.stringify(issued.code)}\ncore.register_on_mods_loaded(function()\n core.after(1,function() core.registered_chatcommands.nemo_pair.func('Probe',code) end)\n core.after(3,function()\n  local placer={is_player=function() return true end,get_player_name=function() return 'Probe' end}\n  core.registered_items['nemo:place_wood'].on_place(nil,placer,{type='node',above={x=33,y=0,z=32}})\n  core.log('action','NEMO_PROBE_CALLBACK_INVOKED')\n end)\n core.after(4,function() core.registered_chatcommands.nemo_move.func('Probe','left'); core.log('action','NEMO_PROBE_MOVE_REQUESTED') end)\n core.after(8,function() core.log('action','NEMO_PROBE_RENDERED ' .. core.get_node({x=33,y=0,z=32}).name) end)\n core.after(12,function() core.registered_chatcommands.nemo_move.func('Probe','right'); core.log('action','NEMO_PROBE_GATE_REQUESTED') end)\n core.after(17,function() core.log('action','NEMO_PROBE_CROSSED ' .. core.get_node({x=33,y=0,z=32}).name) end)\nend)\n`);
  const world=join(user,'worlds','slice'); await mkdir(world,{recursive:true});
  const terrain=getWorldDefinition('frontier:0:0').terrain;
  const treeY=terrain.findIndex(row=>row.includes('tree')),treeX=terrain[treeY].indexOf('tree');
  await appendFile(join(game,'mods','nemo_probe','init.lua'),`\ncore.register_on_mods_loaded(function() core.after(8,function()\n assert(core.get_node({x=${treeX},y=0,z=${treeY}}).name=='nemo:scenery_trunk','authoritative trees must be projected in three dimensions')\n assert(core.registered_items['nemo:place_clay'] and core.registered_items['nemo:place_slate'],'the complete nine-material palette must be registered')\n assert(core.registered_items['nemo:place_clay'].stack_max==1,'creative tools must not accumulate duplicate stacks')\n core.log('action','NEMO_CREATIVE_SCENE_PASS')\nend) end)\n`);
  await writeFile(join(world,'world.mt'),'gameid = nemoworld\nbackend = sqlite3\nmg_name = singlenode\n');
  const config=join(user,'minetest.conf');
  const secrets=[modKey,login.token,issued.code];
  const launch=()=>startLoopbackSmokeEngine(binary,['--server','--world',world,'--config',config,'--logfile',''],{configPath:config,configText:port=>`secure.enable_security = true\nsecure.http_mods = nemo\nnemo_bridge_url = ${bridgeUrl}\nnemo_bridge_key = ${modKey}\nmg_name = singlenode\nbind_address = 127.0.0.1\nport = ${port}\nserver_announce = false\n`,env:{...process.env,LUANTI_USER_PATH:user},secrets});
  engine=await launch();
  await engine.waitForMarker('NEMO_PROBE_RENDERED',{timeoutMs:20000});
  let logs=engine.logs;
  assert.match(logs,/NEMO_PROBE_CALLBACK_INVOKED/);
  assert.match(logs,/NEMO_PROBE_MOVE_REQUESTED/);
  assert.match(logs,/NEMO_PROBE_RENDERED nemo:wood/,logs.slice(-2500));
  await engine.waitForMarker('NEMO_CREATIVE_SCENE_PASS',{timeoutMs:10000});
  assert.equal(platform.get('SELECT type FROM frontier_blocks WHERE world_id=? AND x=33 AND y=32 AND z=0','frontier:0:0')?.type,'wood',logs.slice(-2000));
  assert.equal(platform.get('SELECT x FROM agents WHERE id=?',human.id)?.x,31,logs.slice(-2000));
  const response=await fetch(`${api}/api/v1/world?world_id=frontier:0:0&agent_id=${human.id}&x=28&y=28`,{headers:{Authorization:`Bearer ${login.token}`}});
  const web=await response.json(); assert.equal(web.blocks.some(b=>b.x===33&&b.y===32&&b.type==='wood'),true);
  // The next native callback starts on an opened east gate. The authoritative move crosses sectors,
  // and the Lua projection must clear the old area's block while keeping its database row.
  platform.run('UPDATE agents SET x=46,y=24,z=0,grounded=1 WHERE id=?',human.id);
  await engine.waitForMarker('NEMO_PROBE_CROSSED',{timeoutMs:16000});
  logs=engine.logs;
  assert.match(logs,/NEMO_PROBE_GATE_REQUESTED/,logs.slice(-2500));
  assert.equal(platform.get('SELECT world_id FROM agents WHERE id=?',human.id)?.world_id,'frontier:1:0',logs.slice(-2500));
  assert.match(logs,/NEMO_PROBE_CROSSED air/,logs.slice(-2500));
  await engine.stop(); engine=null;
  platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?','frontier:0:0',human.id);
  const removed=await fetch(`${api}/api/v1/frontier/build`,{method:'POST',headers:{Authorization:`Bearer ${login.token}`,'Content-Type':'application/json',Origin:api},body:JSON.stringify({agent_id:human.id,world_id:'frontier:0:0',x:33,y:32,z:0,remove:true})});
  assert.equal(removed.status,200,JSON.stringify(await removed.json()));
  const again=await fetch(bridgeUrl+'/pair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:login.token,agent_id:human.id})}).then(r=>r.json());
  assert.ok(again.code);
  secrets.push(again.code);
  await writeFile(join(game,'mods','nemo_probe','init.lua'),`local code = ${JSON.stringify(again.code)}\ncore.register_on_mods_loaded(function()\n core.after(1,function() core.registered_chatcommands.nemo_pair.func('Probe',code) end)\n core.after(8,function() core.log('action','NEMO_PROBE_RESTARTED ' .. core.get_node({x=33,y=0,z=32}).name) end)\nend)\n`);
  engine=await launch();
  await engine.waitForMarker('NEMO_PROBE_RESTARTED',{timeoutMs:20000});
  logs=engine.logs;
  assert.match(logs,/NEMO_PROBE_RESTARTED air/,logs.slice(-2500));
  assert.equal(platform.get('SELECT COUNT(*) n FROM frontier_blocks WHERE world_id=?','frontier:0:0').n,0);
  process.stdout.write('PASS: Luanti 5.17 callbacks -> NemoWorld rows -> web; movement and open-sector crossing saved; new sector cleared stale projection; restart reconciled removed node (1 placed, 1 removed)\n');
} finally {
  if(engine) await engine.stop();
  if(bridge) await new Promise(r=>bridge.close(r));
  if(app){await app.stopWorkers();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections()})}
  platform?.close();
  await rm(root,{recursive:true,force:true});
}
