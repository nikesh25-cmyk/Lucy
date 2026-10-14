import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {fixture, realMission} from './helpers.js';
import {verifyQuestReceipts, verifyQuestStructure} from '../src/quests.js';
import {verifyCallingReceipts} from '../src/vocations.js';

const spec={slug:'harbour-path',title:'A path to the harbour wall',route:'world_building',practice:true,
 summary:'Two saved frontier steps: a placed block and a saved ground path inside the same steward plot.',
 narrative:'Written for a resident who wants the water to be reachable on foot.',
 steps:[
  {slug:'first-block',title:'Place one saved block',instructions:'Build a permitted block inside your operator’s plot.',output_name:'One saved frontier block',source_kind:'frontier_place'},
  {slug:'ground-path',title:'Lay a ground path',instructions:'Place a path block on the ground inside the same plot.',output_name:'One saved ground path',source_kind:'path_place',prerequisite:'first-block'},
 ]};

const evidenceSpec={slug:'sourced-harvest',title:'From claim to independent acceptance',route:'evidence_research',practice:false,beneficiary:'A named public beneficiary',
 summary:'Carry one scoped real question from a leased claim to an independent human acceptance.',
 narrative:'A real chain authored for this HTTP fixture. Its first step records the leased claim and its second waits for a different authorized operator to accept the sourced work, so no contributor and no model can complete it alone.',
 steps:[
  {slug:'claim-a-task',title:'Claim one scoped real task',instructions:'Claim an open real mission task that has an independent reviewer.',output_name:'A leased claim on a real task',source_kind:'research_claim'},
  {slug:'accepted-evidence',title:'Wait for independent acceptance',instructions:'Submit sourced work and wait for a different authorized operator to accept it.',output_name:'An accepted review receipt from another human',source_kind:'research_accepted',prerequisite:'claim-a-task'},
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
 assert.equal(catalog.data.chains.length,5);assert.ok(catalog.data.chains.some(chain=>chain.slug==='quiet-harvest'));
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
 assert.equal((await req('/quests/catalog')).data.chains.length,6);
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

test('the shipped practice chain completes over HTTP from a mature harvest and one craft, crediting each step once',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),token=f.credentials.alice.token,home=`home:${alice.id}`;
 const req=await serve(t,f);
 // Fixture setup: the resident travels to its own garden and two crop patches are placed there. The
 // joining, the sowing, the harvest, the craft and every board read below are HTTP requests.
 assert.equal(f.tx('travel',f.actor('alice'),alice.id,{world_id:home}).world_id,home);
 for(const x of [4,8]) f.tx('build',f.actor('alice'),alice.id,{x,y:6,type:'farm'});
 f.platform.run('UPDATE agents SET x=4,y=7 WHERE id=?',alice.id);
 const board=async()=>{const read=await req(`/quests?agent_id=${alice.id}`,{token});assert.equal(read.status,200);return read.data;};
 const chain=of=>of.chains.find(item=>item.slug==='quiet-harvest');
 const receipts=()=>f.platform.all("SELECT objective_id,source_kind,source_id,points,earned_day FROM calling_receipts WHERE agent_id=? AND objective_id LIKE 'quest:%' ORDER BY objective_id",alice.id);

 const joined=await req('/quests/join',{token,input:{agent_id:alice.id,chain_id:'quiet-harvest'},key:'practice-join-1'});
 assert.equal(joined.status,201);
 assert.equal(joined.data.repeated,false);
 assert.equal(joined.data.next_action.step_slug,'first-sowing');
 assert.equal(joined.data.next_action.output.source_kind,'crop_plant');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM quest_enrollments WHERE agent_id=?',alice.id).n,1);

 // Sowing: the first step is credited from the saved planting, and only from it.
 for(const [x,kind] of [[4,'herbs'],[8,'fiber']]) assert.equal((await req('/journey/garden',{token,input:{agent_id:alice.id,action:'plant',kind,x,y:6}})).status,200);
 const sown=await board();
 assert.deepEqual(chain(sown).steps.map(step=>step.state),['complete','available','locked']);
 assert.equal(sown.next_action.step_slug,'patient-tending');
 assert.equal(sown.next_action.output.name,'Two gathered resources from a mature crop');
 assert.equal(sown.next_action.action.section,'workshop');
 assert.equal(sown.next_action.requires_human_review,false);
 assert.equal(chain(sown).steps[0].saved_facts.length,1);
 assert.deepEqual(receipts().map(row=>[row.objective_id,row.source_kind]),[['quest:quiet-harvest.first-sowing','crop_plant']]);
 assert.equal(receipts()[0].points,5);
 assert.equal((await req(`/callings?agent_id=${alice.id}`,{token})).data.today.earned,5);

 // The harvest answers the second step, which the crop could not do while it was still growing.
 f.advance(25*60_000);
 for(const x of [4,8]) assert.equal((await req('/journey/garden',{token,input:{agent_id:alice.id,action:'harvest',x,y:6}})).status,200);
 const harvested=await board();
 assert.deepEqual(chain(harvested).steps.map(step=>step.state),['complete','complete','available']);
 assert.equal(harvested.next_action.step_slug,'keepsake');
 assert.equal(harvested.progress[0].steps[1].have,1);
 const gathered=receipts().find(row=>row.objective_id==='quest:quiet-harvest.patient-tending');
 assert.equal(gathered.source_kind,'crop_harvest');
 assert.match(gathered.source_id,/^4:6:\d+$/,'the receipt must name the tile and the planting that was gathered');
 // The day's ten cosmetic points are spent: the keepsake step is available and uncredited, and the
 // second board read cannot credit the same facts twice.
 const spent=await req(`/callings?agent_id=${alice.id}`,{token});
 assert.equal(spent.data.today.earned,10);
 assert.equal(spent.data.today.remaining,0);
 assert.equal(receipts().length,2);
 assert.equal((await board()).progress[0].complete,false);

 // The next UTC day earns its own craft, and the chain finishes on saved facts alone.
 f.advance(86_400_000);
 const crafted=await req('/journey/craft',{token,input:{agent_id:alice.id,recipe_id:'flower_crown'}});
 assert.equal(crafted.status,200);
 assert.equal(crafted.data.crafted,'flower_crown');
 const finished=await board();
 assert.deepEqual(chain(finished).steps.map(step=>step.state),['complete','complete','complete']);
 assert.equal(finished.progress[0].complete,true);
 assert.equal(finished.next_action,null);
 assert.deepEqual(receipts().map(row=>[row.objective_id,row.source_kind]),[
  ['quest:quiet-harvest.first-sowing','crop_plant'],
  ['quest:quiet-harvest.keepsake','craft'],
  ['quest:quiet-harvest.patient-tending','crop_harvest'],
 ]);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE points!=5').n,0);
 assert.equal(f.platform.get('SELECT crafts FROM journey_profiles WHERE agent_id=?',alice.id).crafts,1);
 assert.equal(f.platform.get('SELECT harvests FROM journey_profiles WHERE agent_id=?',alice.id).harvests,2);
 // A practice chain mints nothing, and the only writer of a step is still the server's saved-fact pass.
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
 const wallet=await req(`/coins?agent_id=${alice.id}`,{token});
 assert.equal(wallet.data.balance,0);
 assert.equal(wallet.data.receipt_count,0);
 const spoof=await req('/quests/complete',{token,input:{agent_id:alice.id,chain_id:'quiet-harvest'}});
 assert.equal(spoof.status,400);
 assert.match(spoof.data.error,/saved server fact/);
 assert.equal(receipts().length,3,'a refused client completion must write nothing');
 assert.equal((await board()).progress[0].complete,true);
 // The receipts the HTTP path wrote verify as a whole against their own authored steps.
 assert.equal(verifyQuestReceipts(f.platform.db),true);
 assert.equal(verifyQuestStructure(f.platform.db),true);
 assert.equal(verifyCallingReceipts(f.platform.db),true);
 assert.equal(f.platform.all('SELECT earned_day FROM calling_receipts WHERE agent_id=?',alice.id).every(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.earned_day)),true);
});

test('a real evidence chain advances over HTTP only when a different operator accepts the sourced work',async t=>{
 // The claim and the independent acceptance that follow are seconds apart, so both receipts land in
 // the same UTC day and the shared ten-a-day allowance covers them (5 + 5). The contributing resident
 // belongs to the administrator's operator, so the refusal below is the independence rule itself and
 // not a role check: an operator may never accept its own resident's work.
 const f=await fixture(t),resident=f.agent('admin'),token=f.credentials.admin.token;
 const req=await serve(t,f);
 const board=async()=>{const read=await req(`/quests?agent_id=${resident.id}`,{token});assert.equal(read.status,200);return read.data;};
 const chain=of=>of.chains.find(item=>item.slug==='sourced-harvest');
 const receipts=()=>f.platform.all("SELECT objective_id,source_kind,source_id,points FROM calling_receipts WHERE agent_id=? AND objective_id LIKE 'quest:%' ORDER BY objective_id",resident.id);

 const authored=await req('/quests/author',{token:f.credentials.reviewer.token,input:evidenceSpec});
 assert.equal(authored.status,201);
 assert.equal(authored.data.practice,false);
 assert.equal(authored.data.beneficiary,'A named public beneficiary');
 assert.equal((await req('/quests/manage',{token:f.credentials.reviewer.token,input:{chain_id:'sourced-harvest',action:'publish'}})).data.status,'published');
 const joined=await req('/quests/join',{token,input:{agent_id:resident.id,chain_id:'sourced-harvest'},key:'evidence-join-1'});
 assert.equal(joined.status,201);
 assert.equal(joined.data.next_action.step_slug,'claim-a-task');
 assert.equal(joined.data.next_action.requires_human_review,false);
 assert.equal(joined.data.next_action.output.source_kind,'research_claim');

 // The scoped real work: an owned runtime claims the open task and submits sourced evidence.
 const runtime=f.tx('runtime',f.actor('admin'),resident.id,{scopes:['read','contribute'],max_calls:20});
 const {task}=realMission(f);
 const claim=await req('/claims',{token:runtime.token,input:{task_id:task.id},key:'evidence-claim-1'});
 assert.equal(claim.status,201);
 const claimed=await board();
 assert.equal(chain(claimed).steps[0].state,'complete');
 assert.equal(chain(claimed).steps[1].state,'available');
 assert.equal(claimed.next_action.step_slug,'accepted-evidence');
 assert.equal(claimed.next_action.requires_human_review,true);
 assert.equal(claimed.next_action.action.section,'history');
 assert.deepEqual(receipts().map(row=>[row.objective_id,row.source_kind]),[['quest:sourced-harvest.claim-a-task','research_claim']]);

 const submission=await req('/submissions',{token:runtime.token,key:'evidence-submit-1',input:{claim_id:claim.data.id,artifact:'A plain text acceptance record with one attributed source.',mime:'text/plain',sources:[{url:'https://example.org/report',location:'Section 2, paragraph 3',date:'2026-10-11'}],method:'Read the published report and recorded the exact supporting section.',limitations:'HTTP fixture; the facts and rights still need human verification.',rights:'Public material recorded with attribution.'}});
 assert.equal(submission.status,201);
 assert.equal(submission.data.status,'pending_review');
 // The contributor's own operator cannot accept it, and the second step must not move.
 const self=await req('/reviews',{token,input:{submission_id:submission.data.id,decision:'accepted',reason:'Accepting work my own resident produced.'}});
 assert.equal(self.status,403);
 assert.match(self.data.error,/own or their agents/);
 assert.equal(chain(await board()).steps[1].state,'available');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM reviews').n,0);
 assert.equal(receipts().length,1);

 // A different authorized operator accepts it. That acceptance is the step's only proof, and the coin
 // is issued by the unchanged ledger rather than by anything in the quest layer.
 const review=await req('/reviews',{token:f.credentials.reviewer.token,input:{submission_id:submission.data.id,decision:'accepted',reason:'Independent acceptance against the registered rubric.'}});
 assert.equal(review.status,201);
 assert.equal(review.data.decision,'accepted');
 assert.equal(review.data.coin_reward.status,'awarded');
 assert.equal(review.data.coin_reward.amount,10);
 const finished=await board();
 assert.equal(finished.progress[0].complete,true);
 assert.equal(chain(finished).steps.every(step=>step.state==='complete'),true);
 assert.equal(finished.next_action,null);
 assert.deepEqual(receipts().map(row=>[row.objective_id,row.source_kind]),[
  ['quest:sourced-harvest.accepted-evidence','research_accepted'],
  ['quest:sourced-harvest.claim-a-task','research_claim'],
 ]);
 const accepted=chain(finished).steps[1].saved_facts[0];
 assert.equal(accepted.available,true,'an accepted review with its own saved source is not held');
 assert.equal(accepted.points,5);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
 const wallet=await req(`/coins?agent_id=${resident.id}`,{token});
 assert.equal(wallet.data.balance,10);
 assert.equal(wallet.data.receipt_count,1);
 assert.equal(wallet.data.policy.transferable,false);
 assert.equal((await board()).progress[0].complete,true,'reading the board again must not credit the acceptance twice');
 assert.equal(receipts().length,2);
 assert.equal(verifyQuestReceipts(f.platform.db),true);
 assert.equal(verifyCallingReceipts(f.platform.db),true);
});
