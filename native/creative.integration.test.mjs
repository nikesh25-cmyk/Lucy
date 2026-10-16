import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../tests/helpers.js';
import {createApp} from '../server.js';
import {createBridge} from './bridge.mjs';
import {palette} from '../src/content.js';

test('native creative catalogue is free and complete, but building still needs the paired human’s plot', async t => {
  const f=await fixture(t), actor=f.actor('alice');
  const human=f.tx('createAgent',actor,{kind:'human',name:'Creative player',capabilities:'Creative building',limitations:'Human controlled'});
  f.platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?','frontier:0:0',human.id);
  const app=createApp({platform:f.platform});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections()})});
  const key='c'.repeat(64),bridge=createBridge({api:`http://127.0.0.1:${app.server.address().port}`,modKey:key});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>bridge.close(resolve)));
  const base=`http://127.0.0.1:${bridge.address().port}`;
  let pairId;
  const post=async(path,body,authenticated=true)=>{
    const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{'X-Nemo-Mod-Key':key}:{})},body:JSON.stringify({...body,...(path.startsWith('/native/')&&path!='/native/pair'?{player:'Creative',pair_id:pairId}:{})})});
    return{status:r.status,data:await r.json()};
  };
  const issued=await post('/pair/start',{token:f.credentials.alice.token,agent_id:human.id},false);
  pairId=(await post('/native/pair',{player:'Creative',code:issued.data.code})).data.pair_id;
  const before=f.platform.get('SELECT COUNT(*) n FROM coin_rewards').n;
  const state=await post('/native/state',{});
  assert.ok(state.data.creative,'native state must expose the authoritative creative catalogue');
  assert.deepEqual(state.data.creative.palette,palette('frontier'));
  assert.equal(state.data.creative.unlimited_items,true);
  assert.equal(state.data.creative.coin_reward,0);
  assert.equal(state.data.creative.parcels.length,64);
  assert.equal(state.data.creative.my_plot,null);
  assert.ok(state.data.creative.blueprints.length>=3);
  assert.notEqual((await post('/native/action',{action:'place',type:'clay',pos:{x:33,y:0,z:32}})).status,200);
  assert.equal((await post('/native/plot',{plot_id:'plot:0:0:5:5',purpose:'Creative community studio'} ,false)).status,401);
  assert.equal((await post('/native/plot',{plot_id:'plot:1:0:5:5',purpose:'Creative community studio'})).status,409);
  const claim=await post('/native/plot',{plot_id:'plot:0:0:5:5',purpose:'Creative community studio'});
  assert.equal(claim.status,200,JSON.stringify(claim.data));
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM land_stewardships WHERE account_id=?',actor.account.id).n,1);
  for(const [type,x] of [['clay',33],['slate',34]]){
    f.advance(1000);
    const built=await post('/native/action',{action:'place',type,pos:{x,y:0,z:32}});
    assert.equal(built.status,200,JSON.stringify(built.data));
    assert.equal(f.platform.get('SELECT type FROM frontier_blocks WHERE world_id=? AND x=? AND y=32 AND z=0','frontier:0:0',x)?.type,type);
  }
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM coin_rewards').n,before);
  const refreshed=await post('/native/state',{});
  assert.equal(refreshed.data.creative.my_plot.id,'plot:0:0:5:5');
  for(const x of [33,34]){
    f.advance(1000);
    const removed=await post('/native/action',{action:'remove',pos:{x,y:0,z:32}});
    assert.equal(removed.status,200,JSON.stringify(removed.data));
  }
  const blueprint={action:'blueprint',blueprint:'research-kiosk',pos:{x:30,y:0,z:30}};
  const preview=await post('/native/action',{...blueprint,preview:true});
  assert.equal(preview.status,200,JSON.stringify(preview.data));
  assert.equal(preview.data.result.valid,true,JSON.stringify(preview.data));
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM frontier_blocks').n,0);
  f.advance(1000);
  const built=await post('/native/action',blueprint);
  assert.equal(built.status,200,JSON.stringify(built.data));
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM frontier_blocks').n,11);
  f.advance(1000);
  assert.equal((await post('/native/action',blueprint)).status,200);
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM frontier_blocks').n,11);
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM coin_rewards').n,before);
  assert.equal((await post('/native/action',{...blueprint,blueprint:'unknown'})).status,400);
  f.platform.run('UPDATE tokens SET revoked=1 WHERE hash=?',actor.credential.hash);
  assert.equal((await post('/native/plot',{plot_id:'plot:0:0:0:0',purpose:'Unauthorized'})).status,401);
});
