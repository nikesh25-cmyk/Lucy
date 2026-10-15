// Real engine join callback: an unpaired player must not enter a blank falling world.
import {mkdtemp, mkdir, cp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {startLoopbackSmokeEngine} from './smoke-process.mjs';

if (!process.env.LUANTI_BIN) throw new Error('Set LUANTI_BIN to the verified engine.');
const root = await mkdtemp(join(tmpdir(), 'nemo-native-onboarding-'));
let engine;
try {
  const user=join(root,'user'), game=join(user,'games','nemoworld_game'), world=join(root,'world');
  await mkdir(world,{recursive:true});
  await cp(new URL('./nemoworld_game',import.meta.url),game,{recursive:true});
  await writeFile(join(world,'world.mt'),'gameid = nemoworld\nbackend = sqlite3\nmg_name = singlenode\n');
  await mkdir(join(game,'mods','nemo_probe'),{recursive:true});
  await writeFile(join(game,'mods','nemo_probe','mod.conf'),'name = nemo_probe\ndepends = nemo\n');
  await writeFile(join(game,'mods','nemo_probe','init.lua'), `
local pos={x=24,y=-80,z=24}
local physics={speed=1,jump=1,gravity=1}
local form=nil
local player={
 get_player_name=function() return 'UnpairedProbe' end,
 get_pos=function() return pos end,
 set_pos=function(_,p) pos=p end,
 set_velocity=function() end,
 set_physics_override=function(_,p) for k,v in pairs(p) do physics[k]=v end end,
 get_physics_override=function() return physics end,
 get_inventory=function() return {add_item=function() end} end,
}
local original_show=core.show_formspec
core.show_formspec=function(name,id,spec) if name=='UnpairedProbe' then form={id=id,spec=spec} else original_show(name,id,spec) end end
local original_get=core.get_player_by_name
core.get_player_by_name=function(name) if name=='UnpairedProbe' then return player end return original_get(name) end
core.register_on_mods_loaded(function()
 core.after(0.1,function()
  for _,callback in ipairs(core.registered_on_joinplayers) do
   if debug.getinfo(callback,'S').source:find('/nemo/init.lua',1,true) then callback(player) end
  end
  assert(physics.gravity==0 and physics.speed==0,'unpaired join must suspend physics until shared state is loaded')
  assert(form and form.spec:find('127.0.0.1:3999',1,true),'unpaired join must show local pairing instructions')
  assert(form.spec:find('pair_code',1,true),'pairing screen needs a code field')
  core.log('action','NEMO_JOIN_GUIDE_PASS')
 end)
 core.after(5,function()
  assert(core.get_node({x=24,y=-1,z=24}).name=='nemo:ground','unpaired arrival must emerge a visible floor')
  assert(pos.y>=0,'unpaired player cannot fall below the floor')
  assert(not form.spec:find('Bearer',1,true),'guide must not contain credentials')
  core.log('action','NEMO_JOIN_FLOOR_PASS')
 end)
end)
`);
  engine=await startLoopbackSmokeEngine(process.env.LUANTI_BIN,['--server','--world',world,'--config',join(root,'config'),'--logfile',''],{
    configPath:join(root,'config'),configText:port=>`secure.http_mods = nemo\nnemo_bridge_key = ${'a'.repeat(64)}\nnemo_bridge_url = http://127.0.0.1:3999\nmg_name = singlenode\nbind_address = 127.0.0.1\nport = ${port}\nserver_announce = false\n`,
    env:{...process.env,LUANTI_USER_PATH:user},
  });
  await engine.waitForMarker('NEMO_JOIN_FLOOR_PASS',{timeoutMs:20000});
  assert.match(engine.logs,/NEMO_JOIN_GUIDE_PASS/);
  console.log('PASS: real Luanti join callback shows pairing UI, suspends unpaired physics and emerges a visible floor without an account or world writes.');
} finally {
  if(engine) await engine.stop();
  await rm(root,{recursive:true,force:true});
}
