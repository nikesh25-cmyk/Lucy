import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, realMission} from '../tests/helpers.js';
import {createApp} from '../server.js';
import {createBridge} from './bridge.mjs';
import {Platform} from '../src/platform.js';

const key = 'n'.repeat(64);
test('real NemoWorld routes: native build and web build share rows, reject unauthorized plot, survive DB reopen', async t => {
  const f = await fixture(t);
  const human = f.tx('createAgent', f.actor('alice'), {kind:'human', name:'Native Human', capabilities:'Building', limitations:'Operator controlled'});
  const ai = f.agent('bob', 'Other resident');
  f.tx('landAssign', f.actor('alice'), {plot_id:'plot:0:0:5:5',purpose:'Native integration fixture',description:'Disposable test plot.'});
  f.platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?','frontier:0:0',human.id);
  f.platform.run('UPDATE agents SET world_id=?,x=31,y=32,z=0,grounded=1 WHERE id=?','frontier:0:0',ai.id);
  const app = createApp({platform:f.platform});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.stopWorkers(); await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections()})});
  const api = `http://127.0.0.1:${app.server.address().port}`;
  const bridge = createBridge({api,modKey:key});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>bridge.close(resolve)));
  const base = `http://127.0.0.1:${bridge.address().port}`;
  async function post(path, body, mod=false) {
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(mod?{'X-Nemo-Mod-Key':key}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  const issued=await post('/pair/start',{token:f.credentials.alice.token,agent_id:human.id});
  assert.equal(issued.status,200,JSON.stringify(issued.data));
  assert.equal((await post('/pair/start',{token:f.credentials.bob.token,agent_id:human.id})).status,403);
  assert.equal((await post('/pair/start',{token:f.credentials.alice.token,agent_id:ai.id})).status,403);
  const runtime=f.tx('runtime',f.actor('bob'),ai.id,{minutes:1,max_calls:20,scopes:['read','build']});
  assert.equal((await post('/pair/start',{token:runtime.token,agent_id:human.id})).status,403);
  assert.equal((await post('/native/pair',{player:'Alice',code:issued.data.code},true)).status,200);
  const native=await post('/native/action',{player:'Alice',action:'place',type:'wood',pos:{x:33,y:0,z:32}},true);
  assert.equal(native.status,200,JSON.stringify(native.data));
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM frontier_blocks WHERE world_id=? AND x=33 AND y=32','frontier:0:0').n,1);
  const webResponse=await fetch(`${api}/api/v1/world?world_id=frontier:0:0&agent_id=${human.id}&x=28&y=28`,{headers:{Authorization:`Bearer ${f.credentials.alice.token}`}});
  const web=await webResponse.json();
  assert.equal(web.blocks.some(b=>b.x===33&&b.y===32&&b.type==='wood'),true);
  f.advance(1000); // the shipped 200 ms per-operator frontier action interval
  const webBuild=await fetch(`${api}/api/v1/frontier/build`,{method:'POST',headers:{Authorization:`Bearer ${f.credentials.alice.token}`,'Content-Type':'application/json',Origin:api},body:JSON.stringify({agent_id:human.id,world_id:'frontier:0:0',x:32,y:33,z:0,type:'stone'})});
  assert.equal(webBuild.status,200,JSON.stringify(await webBuild.json()));
  const projected=await post('/native/state',{player:'Alice'},true);
  assert.equal(projected.status,200,JSON.stringify(projected.data));
  assert.equal(projected.data.blocks.some(b=>b.x===32&&b.y===33&&b.type==='stone'),true);
  assert.equal(projected.data.terrain.length,48*48);
  assert.equal(projected.data.participants.some(p=>p.id===ai.id&&p.kind==='agent'&&p.x===31&&p.y===32),true);
  // Open the east neighbor at the exact gate, then cross it through the same authoritative /move
  // route used by the browser. The native bridge must follow the owned agent's returned world.
  f.platform.run('UPDATE agents SET x=46,y=24,z=0,grounded=1 WHERE id=?',human.id);
  f.advance(1000);
  const crossed=await post('/native/action',{player:'Alice',action:'move',direction:'right'},true);
  assert.equal(crossed.status,200,JSON.stringify(crossed.data));
  assert.equal(crossed.data.result.world_id,'frontier:1:0');
  const adjacent=await post('/native/state',{player:'Alice'},true);
  assert.equal(adjacent.status,200,JSON.stringify(adjacent.data));
  assert.equal(adjacent.data.world_id,'frontier:1:0');
  // The next east neighbor is unopened. At its boundary the server keeps the resident in place.
  f.platform.run('UPDATE agents SET x=47,y=24,z=0,grounded=1 WHERE id=?',human.id);
  f.advance(1000);
  const closed=await post('/native/action',{player:'Alice',action:'move',direction:'right'},true);
  assert.equal(closed.status,200,JSON.stringify(closed.data));
  assert.equal(closed.data.result.world_id,'frontier:1:0');
  assert.equal(closed.data.result.blocked,true);
  const refused=await post('/native/action',{player:'Alice',action:'place',type:'wood',pos:{x:20,y:0,z:20}},true);
  assert.equal(refused.status,409);
  const reopened=new Platform(f.database); t.after(()=>reopened.close());
  assert.equal(reopened.get('SELECT COUNT(*) n FROM frontier_blocks WHERE world_id=?','frontier:0:0').n,2);
  f.platform.run('UPDATE tokens SET revoked=1 WHERE hash=?',f.actor('alice').credential.hash);
  assert.equal((await post('/native/action',{player:'Alice',action:'move',direction:'right'},true)).status,401);
});

// Task 5 — the native client and the browser read one mission authority. This drives the bridge's
// Node entry point over real HTTP against a disposable database. It does NOT prove a real Luanti
// server/mod callback (the pinned engine binary is not installed here); that gate remains pending.
test('native and web read the same mission records; a repeated native claim and submit do not duplicate', async t => {
  const f = await fixture(t);
  const human = f.tx('createAgent', f.actor('alice'), {kind:'human', name:'Mission Human', capabilities:'Reviewed mission work', limitations:'Operator controlled'});
  const { task } = realMission(f);
  f.platform.run('UPDATE agents SET world_id=?,x=32,y=32,z=0,grounded=1 WHERE id=?','frontier:0:0',human.id);
  const app = createApp({platform:f.platform});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.stopWorkers(); await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections()})});
  const api = `http://127.0.0.1:${app.server.address().port}`;
  const bridge = createBridge({api,modKey:key});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>bridge.close(resolve)));
  const base = `http://127.0.0.1:${bridge.address().port}`;
  async function post(path, body, mod=false) {
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(mod?{'X-Nemo-Mod-Key':key}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  const issued = await post('/pair/start',{token:f.credentials.alice.token,agent_id:human.id});
  assert.equal(issued.status,200,JSON.stringify(issued.data));
  assert.equal((await post('/native/pair',{player:'Alice',code:issued.data.code},true)).status,200);
  // Native reads the same task id the web directory publishes.
  const native = await post('/native/missions',{player:'Alice'},true);
  assert.equal(native.status,200,JSON.stringify(native.data));
  assert.ok(native.data.tasks.some(item=>item.id===task.id),'the native client sees the same task id');
  assert.equal(native.data.active_claim,null);
  // Native claims it: exactly one claims row, owned by the paired human's operator account.
  const claim = await post('/native/claim',{player:'Alice',task_id:task.id},true);
  assert.equal(claim.status,200,JSON.stringify(claim.data));
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM claims').n,1);
  assert.equal(f.platform.get('SELECT account_id FROM claims').account_id,f.actor('alice').account.id);
  assert.equal(f.platform.get('SELECT agent_id FROM claims').agent_id,human.id);
  // A repeated native claim (a bridge or Luanti restart) replays the same lease, no second row.
  const again = await post('/native/claim',{player:'Alice',task_id:task.id},true);
  assert.equal(again.status,200,JSON.stringify(again.data));
  assert.equal(again.data.claim.id,claim.data.claim.id);
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM claims').n,1);
  // Web and native read the same active claim id.
  const webDir = await (await fetch(`${api}/api/v1/missions?limit=12`,{headers:{Authorization:`Bearer ${f.credentials.alice.token}`}})).json();
  assert.equal(webDir.active_claim.id,claim.data.claim.id);
  assert.equal((await post('/native/missions',{player:'Alice'},true)).data.active_claim.id,claim.data.claim.id);
  // A submission through native, then a retry and a database reopen, leaves exactly one row.
  const body = {player:'Alice',claim_id:claim.data.claim.id,artifact:'A native-sourced register entry.',method:'Read the original source and recorded the exact supporting section.',limitations:'A workflow fixture; facts and rights require human verification.',rights:'Permission and attribution were checked for this fixture.',sources:[{url:'https://example.org/a',location:'Section 1'}]};
  const submission = await post('/native/submit',body,true);
  assert.equal(submission.status,200,JSON.stringify(submission.data));
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM submissions').n,1);
  const repeatSubmit = await post('/native/submit',body,true);
  assert.equal(repeatSubmit.data.submission.id,submission.data.submission.id);
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM submissions').n,1);
  const reopened=new Platform(f.database); t.after(()=>reopened.close());
  assert.equal(reopened.get('SELECT COUNT(*) n FROM claims').n,1);
  assert.equal(reopened.get('SELECT COUNT(*) n FROM submissions').n,1);
  // Native human mission work mints no coin.
  assert.equal(f.platform.get('SELECT COUNT(*) n FROM coin_rewards').n,0);
});
