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
  platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?','frontier:0:0',human.id);
  app = createApp({platform});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const api=`http://127.0.0.1:${app.server.address().port}`;
  const modKey=randomBytes(32).toString('hex');
  bridge=createBridge({api,modKey,sessionDirectory:join(root,'private-connection')});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  const bridgeUrl=`http://127.0.0.1:${bridge.address().port}`;
  const issued=await fetch(bridgeUrl+'/pair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:login.token,agent_id:human.id})}).then(r=>r.json());
  assert.ok(issued.code);
  const user=join(root,'luanti');
  const game=join(user,'games','nemoworld_game');
  await mkdir(join(game,'mods','nemo_probe'),{recursive:true});
  await cp(new URL('./nemoworld_game/',import.meta.url),game,{recursive:true});
  await writeFile(join(game,'mods','nemo_probe','mod.conf'),'name = nemo_probe\ndepends = nemo\n');
  await writeFile(join(game,'mods','nemo_probe','init.lua'),`
local code=${JSON.stringify(issued.code)}
local pos={x=32,y=2,z=32}
local physics={speed=1,jump=1,gravity=1}
local slots={}
local form
local after_loaded=false
local vertical_velocity=0
local horizontal_velocity=0
local highest_correction=-100
local player={is_player=function() return true end,get_player_name=function() return 'Probe' end,
 get_pos=function() return {x=pos.x,y=pos.y,z=pos.z} end,
 set_pos=function(_,p) pos={x=p.x,y=p.y,z=p.z};if after_loaded then highest_correction=math.max(highest_correction,p.y) end end,
 get_properties=function() return {collisionbox={-0.3,0,-0.3,0.3,1.7,0.3}} end,
 get_velocity=function() return {x=horizontal_velocity,y=vertical_velocity,z=0} end,
 set_velocity=function(_,v) vertical_velocity=v.y;horizontal_velocity=v.x end,
 get_physics_override=function() return physics end,
 set_physics_override=function(_,p) for k,v in pairs(p) do physics[k]=v end end,
 get_inventory=function() return {get_list=function() return slots end,set_size=function() end,set_list=function(_,_,s) slots=s end} end,
 set_wield_index=function() end,
}
local original_get=core.get_player_by_name
core.get_player_by_name=function(name) if name=='Probe' then return player end return original_get(name) end
core.get_connected_players=function() return {player} end
local original_close=core.close_formspec
core.close_formspec=function(name,id) if name=='Probe' then form=nil else original_close(name,id) end end
local original_show=core.show_formspec
core.show_formspec=function(name,id,spec) if name=='Probe' then form={id=id,spec=spec} else original_show(name,id,spec) end end
core.chat_send_player=function() end
local function fields(data)
 for _,callback in ipairs(core.registered_on_player_receive_fields) do
  if debug.getinfo(callback,'S').source:find('/nemo/creative.lua',1,true) then callback(player,'nemo:creative',data) end
 end
end
core.register_on_mods_loaded(function()
 core.after(0.2,function()
  for _,callback in ipairs(core.registered_on_joinplayers) do
   if debug.getinfo(callback,'S').source:find('/nemo/init.lua',1,true) then callback(player) end
  end
  for _,callback in ipairs(core.registered_on_player_receive_fields) do
   if debug.getinfo(callback,'S').source:find('/nemo/init.lua',1,true) then callback(player,'nemo:pairing',{native_signin=true,native_email='native-smoke@example.org',native_password='disposable-password-2026'}) end
  end
 end)
 core.after(3,function()
  assert(math.abs(pos.y+0.49)<0.05,'paired feet must rest on terrain instead of spawning two nodes in the air; actual '..pos.y)
  assert(form and form.id=='nemo:creative','new unlanded player must see the building prerequisite automatically')
  after_loaded=true
  core.registered_items['nemo:place_wood'].on_place(ItemStack('nemo:place_wood'),player,{type='node',under={x=33,y=-1,z=32},above={x=33,y=0,z=32}})
 end)
 core.after(4,function()
  assert(form and form.id=='nemo:creative' and form.spec:find('assigned land plot',1,true),'unowned placement must show the server refusal in the plot menu')
  fields({claim=true,plot='1',purpose='Native controls community workshop'})
 end)
 core.after(5,function()
  assert(not form,'choosing a plot must return to the scene and guide the player to usable land')
  local stack=ItemStack('nemo:place_wood')
  local returned=core.registered_items['nemo:place_wood'].on_place(stack,player,{type='node',under={x=33,y=-1,z=32},above={x=33,y=0,z=32}})
  assert(returned:get_count()==1,'placement must retain the free reusable tool')
 end)
 core.after(7,function()
  assert(core.get_node({x=33,y=0,z=32}).name=='nemo:wood','a normal ground click must project the saved block after stewardship')
  core.registered_nodes['nemo:wood'].on_punch({x=33,y=0,z=32},nil,player)
 end)
 core.after(8.5,function()
  assert(core.get_node({x=33,y=0,z=32}).name=='air','a normal punch must remove the owned saved block')
  pos.x=32.6
  pos.y=0.4
  vertical_velocity=2
  horizontal_velocity=4
 end)
 core.after(10,function()
  assert(horizontal_velocity==4,'ordinary walking must not zero horizontal velocity on every saved tile')
  assert(vertical_velocity==2,'walking confirmation must preserve the native jump velocity')
  assert(highest_correction<0.5,'walking or heartbeat must not teleport feet into the air; max '..highest_correction)
  pos.y=0.4 -- a legitimate short native jump; the heartbeat must not cancel it
 end)
 core.after(11.5,function()
  assert(pos.y==0.4,'a stationary heartbeat must preserve normal native vertical motion')
  core.log('action','NEMO_NATIVE_CONTROLS_PASS')
 end)
 core.after(12,function()
  for _,callback in ipairs(core.registered_on_leaveplayers) do
   if debug.getinfo(callback,'S').source:find('/nemo/init.lua',1,true) then callback(player) end
  end
  for _,callback in ipairs(core.registered_on_joinplayers) do
   if debug.getinfo(callback,'S').source:find('/nemo/init.lua',1,true) then callback(player) end
  end
 end)
 core.after(15,function()
  assert(math.abs(pos.y+0.49)<0.05,'returning native login must restore the saved character without another password or browser code')
  assert(not form,'automatic reconnect must close the sign-in form')
  core.log('action','NEMO_NATIVE_SIGNIN_RESUME_PASS')
 end)
end)
`);
  const world=join(user,'worlds','slice');await mkdir(world,{recursive:true});
  await writeFile(join(world,'world.mt'),'gameid = nemoworld\nbackend = sqlite3\nmg_name = singlenode\n');
  const config=join(user,'minetest.conf');
  engine=await startLoopbackSmokeEngine(binary,['--server','--world',world,'--config',config,'--logfile',''],{configPath:config,configText:port=>`secure.http_mods = nemo\nnemo_bridge_url = ${bridgeUrl}\nnemo_bridge_key = ${modKey}\nmg_name = singlenode\nbind_address = 127.0.0.1\nport = ${port}\nserver_announce = false\n`,env:{...process.env,LUANTI_USER_PATH:user},secrets:[modKey,login.token,issued.code]});
  await engine.waitForMarker('NEMO_NATIVE_SIGNIN_RESUME_PASS',{timeoutMs:20000});
  assert.equal(platform.get('SELECT x FROM agents WHERE id=?',human.id).x,33);
  assert.equal(platform.get('SELECT COUNT(*) n FROM frontier_blocks').n,0);
  assert.equal(platform.get('SELECT plot_id FROM land_stewardships WHERE account_id=?',actor.account.id).plot_id,'plot:0:0:5:5');
  assert.equal(platform.get('SELECT COUNT(*) n FROM coin_rewards').n,0);
  assert.ok(!engine.logs.includes('disposable-password-2026'));
  assert.ok(!engine.logs.includes(login.token));
  console.log('PASS: direct native sign-in and code-free return; native ground height, heartbeat/jump stability, walking, visible land refusal, explicit stewardship, reusable ground placement and punch removal share authoritative saved records.');
} finally {
  if(engine) await engine.stop();
  if(bridge) await new Promise(r=>bridge.close(r));
  if(app){await app.stopWorkers();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections()})}
  platform?.close();
  await rm(root,{recursive:true,force:true});
}
