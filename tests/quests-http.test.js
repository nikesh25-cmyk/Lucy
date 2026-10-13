import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {fixture} from './helpers.js';

const spec={slug:'harbour-path',title:'A path to the harbour wall',route:'world_building',practice:true,
 summary:'Two saved frontier steps: a placed block and a saved ground path inside the same steward plot.',
 narrative:'Written for a resident who wants the water to be reachable on foot.',
 steps:[
  {slug:'first-block',title:'Place one saved block',instructions:'Build a permitted block inside your operator’s plot.',output_name:'One saved frontier block',source_kind:'frontier_place'},
  {slug:'ground-path',title:'Lay a ground path',instructions:'Place a path block on the ground inside the same plot.',output_name:'One saved ground path',source_kind:'path_place',prerequisite:'first-block'},
 ]};

async function serve(t,f){
 const {server}=createApp({platform:f.platform,backupDir:join(f.directory,'backups')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 return async(path,{token,input,method=input?'POST':'GET',key}={})=>{
  const response=await fetch(`${base}/api/v1${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(input?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(input?{body:JSON.stringify(input)}:{})});
  return{status:response.status,data:await response.json()};
 };
}

test('quest routes publish the next actual action, refuse client completions, and keep authoring with authorized operators',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob');
 const req=await serve(t,f);
 const catalog=await req('/quests/catalog?limit=20');
 assert.equal(catalog.status,200);
 assert.equal(catalog.data.chains.length,3);assert.ok(catalog.data.chains.some(chain=>chain.slug==='quiet-harvest'));
 assert.equal(catalog.data.policy.coins_awarded,0);
 assert.equal(JSON.stringify(catalog.data).includes('agent_id'),false,'the public catalogue must carry no resident identity');
 assert.equal((await req('/quests/catalog?limit=21')).status,400);
 assert.equal((await req('/quests?agent_id='+alice.id)).status,401);
 assert.equal((await req(`/quests?agent_id=${alice.id}`,{token:f.credentials.bob.token})).status,404);
 assert.equal((await req('/quests/author',{token:f.credentials.alice.token,input:spec})).status,403);
 const authored=await req('/quests/author',{token:f.credentials.reviewer.token,input:spec});
 assert.equal(authored.status,201);assert.equal(authored.data.status,'draft');
 assert.equal((await req('/quests/manage',{token:f.credentials.alice.token,input:{chain_id:'harbour-path',action:'publish'}})).status,403);
 assert.equal((await req('/quests/manage',{token:f.credentials.reviewer.token,input:{chain_id:'harbour-path',action:'publish'}})).data.status,'published');
 assert.equal((await req('/quests/manage',{token:f.credentials.reviewer.token,input:{chain_id:'quiet-harvest',action:'archive'}})).status,403);
 assert.equal((await req('/quests/catalog')).data.chains.length,4);
 // Joining needs an owned active resident and the existing idempotency key.
 assert.equal((await req('/quests/join',{token:f.credentials.reviewer.token,input:{agent_id:alice.id,chain_id:'harbour-path'},key:'x'})).status,404);
 assert.equal((await req('/quests/join',{token:f.credentials.alice.token,input:{agent_id:alice.id,chain_id:'harbour-path'}})).status,400);
 const joined=await req('/quests/join',{token:f.credentials.alice.token,input:{agent_id:alice.id,chain_id:'harbour-path'},key:'join-http-1'});
 assert.equal(joined.status,201);assert.equal(joined.data.repeated,false);assert.equal(joined.data.next_action.step_slug,'first-block');
 const repeated=await req('/quests/join',{token:f.credentials.alice.token,input:{agent_id:alice.id,chain_id:'harbour-path'},key:'join-http-1'});
 assert.equal(repeated.status,201);assert.equal(repeated.data.repeated,true);
 assert.equal((await req('/quests/join',{token:f.credentials.alice.token,input:{agent_id:bob.id,chain_id:'harbour-path'},key:'join-http-other'})).status,404);
 assert.equal((await req('/quests/join',{token:f.credentials.alice.token,input:{agent_id:alice.id,chain_id:'quiet-harvest'},key:'join-http-1'})).status,409);
 // The board a resident reads: the concrete next action, the named output and the saved-fact rule.
 const board=await req(`/quests?agent_id=${alice.id}`,{token:f.credentials.alice.token});
 assert.equal(board.status,200);
 const next=board.data.next_action;
 assert.equal(next.chain_slug,'harbour-path');assert.equal(next.step_slug,'first-block');
 assert.equal(next.output.name,'One saved frontier block');assert.equal(next.output.source_kind,'frontier_place');
 assert.equal(next.action.kind,'build_block');assert.equal(next.action.section,'world');
 assert.match(next.action.saved_fact,/saved frontier block/);
 assert.equal(next.requires_human_review,false);assert.match(next.instructions,/permitted block/);
 assert.equal(board.data.can_author,false);
 const chain=board.data.chains.find(item=>item.slug==='harbour-path');
 assert.deepEqual(chain.steps.map(step=>step.state),['available','locked']);
 assert.equal(chain.steps[1].prerequisite.title,'Place one saved block');
 assert.equal(chain.steps[0].saved_facts.length,0);
 assert.equal(chain.complete,false);
 // A completion assertion is refused, and the runtime cannot author or join.
 const spoof=await req('/quests/complete',{token:f.credentials.alice.token,input:{agent_id:alice.id,chain_id:'harbour-path'}});
 assert.equal(spoof.status,400);assert.match(spoof.data.error,/saved server fact/);
 const runtime=f.tx('runtime',f.actor('alice'),alice.id,{scopes:['read','move']});
 assert.equal((await req('/quests?agent_id='+alice.id,{token:runtime.token})).status,200);
 assert.equal((await req(`/quests?agent_id=${bob.id}`,{token:runtime.token})).status,404);
 assert.equal((await req('/quests/author',{token:runtime.token,input:spec})).status,403);
 assert.equal((await req('/quests/join',{token:runtime.token,input:{agent_id:alice.id,chain_id:'harbour-path'},key:'runtime-join'})).status,403);
 assert.equal((await req('/quests/complete',{token:runtime.token,input:{agent_id:alice.id}})).status,403);
 // A saved fact still drives the step: the block the resident actually places is what credits it.
 f.tx('landAssign',f.actor('alice'),{plot_id:'plot:0:0:5:5',purpose:'A peaceful learning garden'});
 f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?','frontier:0:0',30,32,alice.id);
 f.tx('frontierBuild',f.actor('alice'),alice.id,{world_id:'frontier:0:0',x:31,y:33,z:0,type:'wood'});
 const credited=await req(`/quests?agent_id=${alice.id}`,{token:f.credentials.alice.token});
 assert.equal(credited.data.next_action.step_slug,'ground-path');
 assert.equal(credited.data.chains.find(item=>item.slug==='harbour-path').steps[0].saved_facts.length,1);
 assert.equal(credited.data.progress.find(item=>item.chain_slug==='harbour-path').steps[0].state,'complete');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
 assert.equal((await req('/quests/manage',{token:f.credentials.reviewer.token,input:{chain_id:'harbour-path',action:'archive'}})).status,200);
 assert.equal((await req('/quests/catalog')).data.chains.some(item=>item.slug==='harbour-path'),false);
});

test('the interface renders the quest board from the published payload without innerHTML',async t=>{
 const f=await fixture(t),alice=f.agent('alice');
 const req=await serve(t,f);
 const board=await req(`/quests?agent_id=${alice.id}`,{token:f.credentials.alice.token});
 const next=board.data.next_action;
 const source=readFileSync(fileURLToPath(new URL('../app.js',import.meta.url)),'utf8');
 const nav=readFileSync(fileURLToPath(new URL('../index.html',import.meta.url)),'utf8');
 // The resident's own chain, before joining, exposes the same next-action fields the renderer reads.
 const available=board.data.chains.find(item=>item.slug==='quiet-harvest');
 assert.equal(available.next_action.step_slug,'first-sowing');
 assert.equal(available.next_action.action.kind,'garden');
 assert.equal(board.data.enrolled_count,0);
 assert.equal(next,null,'an unjoined board has nothing waiting');
 assert.equal(board.data.chains.some(item=>item.status!=='published'),false);
 // The renderer consumes the payload fields by name and creates nodes instead of injecting markup.
 assert.match(source,/next_action/);
 for(const field of ['questNextCard','questProgressCard','questAuthorForm','renderQuests','loadQuests'])assert.match(source,new RegExp(`function ${field}\\(|async function ${field}\\(`));
 assert.doesNotMatch(source,/innerHTML/);
 assert.doesNotMatch(source,/\$\([^)]*\)\.html\s*=/);
 assert.match(source,/quests:'clipboard-list'/);
 assert.match(nav,/id="view"/);
});
