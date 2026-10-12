import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {createApp} from '../server.js';

test('land API exposes fixed inventory and routes human stewardship to server-enforced construction without payments',async t=>{
 const f=await fixture(t),app=createApp({platform:f.platform});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});
 const base='http://127.0.0.1:'+app.server.address().port+'/api/v1';
 const request=async(path,token,input)=>{const response=await fetch(base+path,{method:input?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(input?{'Content-Type':'application/json',Origin:new URL(base).origin}:{})},...(input?{body:JSON.stringify(input)}:{})});return {status:response.status,data:await response.json()};};
 const land=await request('/land?limit=1');assert.equal(land.status,200);assert.equal(land.data.counts.gross,16384);assert.equal(land.data.areas.length,256);assert.equal(land.data.world.area_m2,589824);assert.doesNotMatch(JSON.stringify(land.data),/@example\.org|"account_id"|"password"|"token"/);
 const plot='plot:0:0:5:5',alice=f.credentials.alice.token;
 assert.equal((await request('/land/assign',null,{plot_id:plot,purpose:'Community learning space'})).status,401);
 assert.equal((await request('/land/assign',alice,{plot_id:plot,purpose:'Community learning space',price:100})).status,400);
 const assigned=await request('/land/assign',alice,{plot_id:plot,purpose:'Community learning space',description:'Fictional workflow test'});assert.ok([200,201].includes(assigned.status),JSON.stringify(assigned));assert.equal(assigned.data.plot.is_mine,true);
 const detail=await request('/land/plot?plot_id='+plot);assert.equal(detail.data.plot.purpose,'Community learning space');assert.equal(detail.data.plot.is_mine,false);
 const agent=f.agent('alice');f.platform.run('UPDATE agents SET world_id=?,x=30,y=32 WHERE id=?','frontier:0:0',agent.id);
 const runtime=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','build'],max_calls:20});
 assert.equal((await request('/land/release',runtime.token,{plot_id:plot})).status,403);
 const build=await request('/frontier/build',runtime.token,{world_id:'frontier:0:0',x:31,y:33,z:0,type:'wood'});assert.ok([200,201].includes(build.status),JSON.stringify(build));assert.equal(f.platform.get('SELECT plot_id FROM frontier_blocks').plot_id,plot);
 assert.equal((await request('/land/release',alice,{plot_id:plot})).status,409);f.advance(2000);
 assert.ok([200,201].includes((await request('/frontier/build',runtime.token,{world_id:'frontier:0:0',x:31,y:33,z:0,remove:true})).status));
 f.advance(2000);assert.ok([200,201].includes((await request('/land/release',alice,{plot_id:plot})).status));assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);assert.equal(f.platform.verifyAudit(),true);
});
