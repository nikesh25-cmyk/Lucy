import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {fixture} from './helpers.js';

test('calling HTTP routes isolate private progress, keep selection human-controlled, and filter the public guild directory',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob');
 const {server}=createApp({platform:f.platform,backupDir:join(f.directory,'backups')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(path,{token,input,method=input?'POST':'GET'}={})=>{
  const response=await fetch(`${base}/api/v1${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
  return{status:response.status,data:await response.json()};
 };
 assert.equal((await req(`/callings?agent_id=${alice.id}`)).status,401);
 assert.equal((await req(`/callings?agent_id=${alice.id}`,{token:f.credentials.bob.token})).status,404);
 const selected=await req('/callings/select',{token:f.credentials.alice.token,input:{agent_id:alice.id,calling_id:'cultivator'}});
 assert.equal(selected.status,200);assert.equal(selected.data.calling.id,'cultivator');assert.equal(selected.data.today.earned,0);
 const runtime=f.tx('runtime',f.actor('alice'),alice.id,{scopes:['read','move','build'],max_calls:20});
 assert.equal((await req('/callings',{token:runtime.token})).data.agent_id,alice.id);
 assert.equal((await req(`/callings?agent_id=${bob.id}`,{token:runtime.token})).status,404);
 assert.equal((await req('/callings/select',{token:runtime.token,input:{calling_id:'builder'}})).status,403);
 assert.equal((await req('/callings/select',{token:f.credentials.alice.token,input:{agent_id:alice.id,calling_id:'builder',experience:1000}})).status,400);
 assert.equal((await req('/callings/select',{token:f.credentials.alice.token,input:{agent_id:alice.id,calling_id:'builder'}})).status,429);
 f.platform.run("UPDATE worlds SET visibility='private' WHERE id=?",`home:${alice.id}`);
 f.platform.run('UPDATE agents SET world_id=? WHERE id=?',`home:${alice.id}`,alice.id);
 const guilds=await req('/callings/guilds');assert.equal(guilds.status,200);assert.equal(guilds.data.catalog.length,8);
 assert.equal(guilds.data.members.some(m=>m.id===alice.id),false);
 assert.equal(guilds.data.members.some(m=>m.id===bob.id),true);
 assert.equal(JSON.stringify(guilds.data).includes('receipts'),false);
 f.tx('agentControl',f.actor('bob'),bob.id,'paused');
 assert.equal((await req('/callings/guilds')).data.members.some(m=>m.id===bob.id),false);
 assert.equal((await req('/callings/guilds?limit=25')).status,400);
});
