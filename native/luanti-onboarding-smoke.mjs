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
local slots={ItemStack('nemo:place_wood 3')}
local inventory={get_list=function() return slots end,set_size=function() end,set_list=function(_,_,items) slots=items end}
local player={
 get_player_name=function() return 'UnpairedProbe' end,
 get_pos=function() return pos end,
 set_pos=function(_,p) pos=p end,
 set_velocity=function() end,
 set_physics_override=function(_,p) for k,v in pairs(p) do physics[k]=v end end,
 get_physics_override=function() return physics end,
 get_inventory=function() return inventory end,
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
  assert(form and form.spec:find('native_email',1,true),'unpaired join must show local pairing instructions')
  assert(form.spec:find('native_password',1,true),'native sign-in needs a password field; no browser code')
  assert(#slots==9,'joining must replace duplicate tool stacks with the nine canonical creative tools')
  for _,stack in ipairs(slots) do assert(stack:get_count()==1,'each reusable tool must appear only once') end
  local receive
  local original_receive=core.register_on_player_receive_fields
  local original_command=core.register_chatcommand
  core.register_on_player_receive_fields=function(callback) receive=callback end
  core.register_chatcommand=function() end
  local requests={}
  local scene={world_id='frontier:0:0',player={x=32,y=32},creative={palette={'wood','clay','slate'},parcels={{id='plot:0:0:5:5',x=30,y=30,can_assign=true}},blueprints={{id='research-kiosk',name='Research kiosk',block_count=11}}}}
  local factory=dofile(core.get_modpath('nemo')..'/creative.lua')
  local ui=factory({scene=function() return scene end,connect=function() error('unexpected connection fallback') end,
   sync=function() end,message=function() end,request=function(_,path,body,done)
    requests[#requests+1]={path=path,body=body}
    if path=='/native/plot' then done(true,{result={plot={id=body.plot_id,world_id='frontier:0:0',x=30,y=30,purpose=body.purpose}}})
    elseif body.preview then done(true,{result={valid=true,issues={}}}) else done(true,{result={}}) end
   end})
  core.register_on_player_receive_fields=original_receive
  core.register_chatcommand=original_command
  ui.show('UnpairedProbe')
  assert(form.spec:find('material_slate',1,true) and form.spec:find('Use this free building plot',1,true),'creative menu must offer tools and explicit plot stewardship')
  receive(player,'nemo:creative',{claim=true,plot='1',purpose='Community research studio'})
  assert(requests[1].path=='/native/plot' and requests[1].body.purpose=='Community research studio','plot purpose must be explicitly sent to authoritative route')
  local fields={blueprint='1',anchor_x='30',anchor_z='30',build=true}
  receive(player,'nemo:creative',fields)
  assert(#requests==1,'placement without an exact successful preview must not send a write')
  fields.build=nil;fields.preview=true;receive(player,'nemo:creative',fields)
  assert(requests[2].body.preview==true,'preview must remain a read-only request')
  fields.preview=nil;fields.build=true;fields.anchor_x='31';receive(player,'nemo:creative',fields)
  assert(#requests==2,'changed footprint must require another preview')
  fields.anchor_x='30';receive(player,'nemo:creative',fields)
  assert(#requests==3 and requests[3].body.preview==false,'explicit confirmed placement must call the existing build route')
  ui.clear('UnpairedProbe')
  core.log('action','NEMO_CREATIVE_UI_PASS')
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
  assert.match(engine.logs,/NEMO_CREATIVE_UI_PASS/);
  console.log('PASS: real Luanti join callback shows pairing UI, suspends unpaired physics and emerges a floor; creative UI sends explicit plot purpose and refuses placement without an unchanged successful preview.');
} finally {
  if(engine) await engine.stop();
  await rm(root,{recursive:true,force:true});
}
