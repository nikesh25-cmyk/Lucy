import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {createApp} from '../server.js';

async function service(t,f,options={}){
  const app=createApp({platform:f.platform,...options});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,input,account='alice',token=f.credentials[account]?.token)=>{const response=await fetch(url+'/api/v1'+path,{method:input?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});return {status:response.status,data:await response.json()};};
  return {app,call};
}
async function settled(f,id){for(let i=0;i<80;i++){const job=f.platform.get('SELECT * FROM jobs WHERE id=?',id);if(job.status!=='running')return job;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Worker did not settle');}

test('local resident requires a configured model and a valid owned active character before creating work',async t=>{
 const f=await fixture(t),a=f.agent('alice');const noModel=await service(t,f);assert.equal((await noModel.call('/residents/run',{agent_id:a.id})).status,409);
 const {call}=await service(t,f,{mayorModel:async()=>'{"action":"wait"}'});
 assert.equal((await call('/residents/run',{agent_id:a.id,minutes:21})).status,400);
 assert.equal((await call('/residents/run',{agent_id:a.id,permission:'administrator'})).status,400);
 assert.equal((await call('/residents/run',{agent_id:a.id},'bob')).status,404);
 f.tx('agentControl',f.actor('alice'),a.id,'paused');assert.equal((await call('/residents/run',{agent_id:a.id})).status,409);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM jobs').n,0);
});

test('resident worker identity, single-worker capacity, private status, cancellation and token cleanup are enforced',async t=>{
 const f=await fixture(t),a=f.agent('alice'),b=f.agent('bob');let observed;
 const {call}=await service(t,f,{mayorModel:async()=>'{"action":"wait"}',residentRunner:options=>{observed=options;return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({status:'stopped',model_calls:0,action_count:0}),{once:true}));}});
 const start=await call('/residents/run',{agent_id:a.id,minutes:1,model_calls:2,permission:'observe'});assert.equal(start.status,202);assert.equal(start.data.token,undefined);assert.equal(observed.reportJob,false);
 const runtime=f.platform.authenticate(observed.token,'read');assert.equal(runtime.agent.id,a.id);assert.deepEqual(JSON.parse(runtime.credential.scopes),['read']);
 assert.deepEqual((await call('/workers')).data.resident,{job_id:start.data.job_id,agent_id:a.id,status:'running',phase:'starting',decision:0,model_calls:0,action_count:0,decisions_remaining:2,last_action:null});
 assert.deepEqual((await call('/workers',null,'bob')).data,{resident:null,research:null});
 assert.equal((await call('/workers',null,'alice',observed.token)).status,403);
 assert.equal((await call('/residents/run',{agent_id:b.id},'bob')).status,429);
 assert.equal((await call('/runtime/start',{agent_id:a.id})).status,409);assert.equal((await call('/research/run',{task_id:'unused',agent_id:a.id,urls:[]})).status,409);
 assert.equal((await call('/residents/cancel',{},'bob')).data.stopping,false);assert.equal((await call('/workers')).data.resident.job_id,start.data.job_id);
 const token=observed.token;assert.equal((await call('/residents/cancel',{})).data.stopping,true);assert.equal((await settled(f,start.data.job_id)).status,'stopped');
 assert.throws(()=>f.platform.authenticate(token),{status:401});assert.equal((await call('/workers')).data.resident,null);
 const next=await call('/residents/run',{agent_id:b.id},'bob');assert.equal(next.status,202);await call('/residents/cancel',{},'bob');await settled(f,next.data.job_id);
 assert.equal(f.platform.verifyAudit(),true);
});

test('managed resident uses real scoped HTTP actions, reports one job and revokes its own completed credential',async t=>{
 const f=await fixture(t),a=f.agent('alice');const initial=f.platform.get('SELECT x,y FROM agents WHERE id=?',a.id);let calls=0;
 const {call}=await service(t,f,{mayorModel:async()=>{calls++;return '{"action":"move","direction":"right"}';}});
 const started=await call('/residents/run',{agent_id:a.id,minutes:1,model_calls:1,permission:'creative'});assert.equal(started.status,202);
 const job=await settled(f,started.data.job_id);assert.equal(job.status,'completed');assert.match(job.detail,/1 model decisions, 1 actions/);assert.equal(calls,1);
 assert.equal(f.platform.get('SELECT x FROM agents WHERE id=?',a.id).x,initial.x+1);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM jobs').n,1);
 const credential=f.platform.get("SELECT revoked,scopes FROM tokens WHERE kind='runtime' AND agent_id=?",a.id);assert.equal(credential.revoked,1);assert.ok(JSON.parse(credential.scopes).includes('build'));
 const other=f.agent('alice','Second character');assert.equal(f.tx('runtime',f.actor('alice'),other.id,{scopes:['read']}).agent_id,other.id);
});

test('observe-only resident cannot convert a model move into a world action',async t=>{
 const f=await fixture(t),a=f.agent('alice');const initial=f.platform.get('SELECT x,y FROM agents WHERE id=?',a.id);
 const {call}=await service(t,f,{mayorModel:async()=>'{"action":"move","direction":"right"}'});
 const start=await call('/residents/run',{agent_id:a.id,minutes:1,model_calls:1,permission:'observe'});const job=await settled(f,start.data.job_id);
 assert.equal(job.status,'failed');assert.match(job.detail,/0 actions/);assert.deepEqual(f.platform.get('SELECT x,y FROM agents WHERE id=?',a.id),initial);
});

test('queued resident rechecks revoked authority before inference dispatch',async t=>{
 const f=await fixture(t),a=f.agent('alice');let unblock,calls=0;
 const {call}=await service(t,f,{mayorModel:async()=>{calls++;await new Promise(resolve=>{unblock=resolve;});return '{"answer":"Use primary sources and independent review."}';}});
 const mayor=call('/mayors/talk',{npc_id:'mayor-highlands',question:'Explain research'});
 for(let i=0;i<50&&!unblock;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(unblock);
 const started=await call('/residents/run',{agent_id:a.id,model_calls:1});
 for(let i=0;i<50;i++){if((await call('/health')).data.model_queue.waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal((await call('/health')).data.model_queue.waiting,1);
 await call('/agents/control',{agent_id:a.id,status:'paused'});unblock();await mayor;
 const job=await settled(f,started.data.job_id);assert.equal(job.status,'failed');assert.equal(calls,1);assert.match(job.detail,/0 actions/);
});
