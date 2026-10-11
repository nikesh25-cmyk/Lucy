import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDecisionBrief,normalizeCostScenario,serializeDecisionBrief,storedDecisionBrief,decisionBriefText,BRIEF_MARKER} from '../src/decision-brief.js';
import {fixture,realMission,evidence} from './helpers.js';
import {briefFixture} from './brief-fixture.js';
import {Platform} from '../src/platform.js';
import {createApp} from '../server.js';

test('cost register preserves unknowns and computes exact decimal subtotals without inferred FX or margin',()=>{
 const input=briefFixture().cost_scenario,cost=normalizeCostScenario(input,1);assert.equal(cost.known_subtotal,'0.30');assert.equal(cost.unknown_count,1);assert.equal(cost.total,null);assert.equal(cost.cost_per_kg,null);
 input.rows.pop();input.quantity_kg=0.003;const complete=normalizeCostScenario(input,1);assert.equal(complete.total,'0.30');assert.equal(complete.cost_per_kg,'100.00');
 input.quantity_kg=1.001;assert.equal(normalizeCostScenario(input,1).cost_per_kg,'0.30');input.quantity_kg=null;assert.equal(normalizeCostScenario(input,1).cost_per_kg,null);
 input.precision=3;input.rows[0].amount='0.001';input.rows[1].amount='0.002';assert.equal(normalizeCostScenario(input,1).known_subtotal,'0.003');
});
test('brief validation rejects unbacked findings, invented option selection, missing roles and misclassified costs',()=>{
 for(const mutate of [b=>b.findings[0].source_numbers=[2],b=>b.options=b.options.slice(0,1),b=>b.recommended_option=3,b=>b.milestones[0].owner='',b=>b.cost_scenario.rows[0].basis='official',b=>b.cost_scenario.rows[2].amount='0',b=>b.cost_scenario.rows[0].amount='-1',b=>b.cost_scenario.rows[0].amount='1e3',b=>b.cost_scenario.rows[0].amount='0.001',b=>b.cost_scenario.quantity_kg=0,b=>b.cost_scenario.quantity_kg=0.0001,b=>b.cost_scenario.precision=1]){const value=briefFixture();mutate(value);assert.throws(()=>normalizeDecisionBrief(value,{sourceCount:1}),{status:400});}
 const normalized=normalizeDecisionBrief(briefFixture({status:'accepted'}),{sourceCount:1});assert.equal(normalized.status,'proposed_for_independent_review');assert.equal(storedDecisionBrief(BRIEF_MARKER+'{}',1),null);assert.deepEqual(storedDecisionBrief(serializeDecisionBrief(normalized),1),normalized);assert.match(decisionBriefText(normalized),/Total: INCOMPLETE/);
});
test('structured decisions follow ownership, source-domain approval, corrections, independent review, restart and adoption',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'brief-claim');
 assert.throws(()=>f.tx('submit',f.actor('alice'),evidence(claim,{artifact:BRIEF_MARKER+'{}'}),'bad-prefix'),{status:400});
 assert.throws(()=>f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture(),sources:[{url:'https://other.example/report',location:'Fixture'}]}),'bad-host'),{status:400});
 const first=f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture(),artifact:undefined}),'first-brief');assert.equal(first.status,'pending_review');assert.equal(f.platform.history(f.actor('bob')).submissions.length,0);assert.equal(f.platform.gallery().length,0);
 const repeat=f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture()}),'first-brief');assert.equal(repeat.id,first.id);assert.equal(repeat.brief.cost_scenario.known_subtotal,'0.30');
 assert.throws(()=>f.tx('review',f.actor('alice'),{submission_id:first.id,decision:'accepted',reason:'Self review'}),{status:403});f.tx('review',f.actor('reviewer'),{submission_id:first.id,decision:'changes_requested',reason:'Fixture: name the proposed role more clearly.'});
 const second=f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture({recipient:'Proposed QA agriculture department'})}),'corrected-brief');assert.equal(second.version,2);assert.equal(f.platform.history(f.actor('alice')).submissions.length,2);assert.equal(f.platform.exportAccount(f.actor('alice')).submissions.find(s=>s.id===second.id).brief.recipient,'Proposed QA agriculture department');
 f.tx('review',f.actor('reviewer'),{submission_id:second.id,decision:'accepted',reason:'QA fixture structure reviewed; not a real recommendation approval.'});assert.equal(f.platform.gallery()[0].brief.recipient,'Proposed QA agriculture department');assert.equal(f.platform.gallery()[0].adoption_count,0);f.tx('adoption',f.actor('admin'),{submission_id:second.id,note:'QA workflow use only.'});assert.equal(f.platform.gallery()[0].adoption_count,1);
 f.platform.close();const reopened=new Platform(f.database);t.after(()=>reopened.close());assert.equal(reopened.gallery()[0].brief.cost_scenario.total,null);assert.equal(reopened.verifyAudit(),true);
});
test('scoped runtime contributor can submit a structured brief over HTTP but cannot accept it',async t=>{
 const f=await fixture(t),{task}=realMission(f),agent=f.agent('alice'),runtime=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','contribute'],duration_minutes:10,max_calls:20}),actor=f.platform.authenticate(runtime.token,'contribute'),claim=f.tx('claim',actor,{task_id:task.id,agent_id:agent.id},'agent-brief-claim');
 const {server}=createApp({platform:f.platform});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}/api/v1`;
 const response=await fetch(base+'/submissions',{method:'POST',headers:{Authorization:`Bearer ${runtime.token}`,'Content-Type':'application/json','Idempotency-Key':'http-brief'},body:JSON.stringify(evidence(claim,{brief:briefFixture(),artifact:undefined}))});assert.equal(response.status,201);const submission=await response.json();assert.equal(submission.brief.cost_scenario.total,null);
 const forbidden=await fetch(base+'/reviews',{method:'POST',headers:{Authorization:`Bearer ${runtime.token}`,'Content-Type':'application/json'},body:JSON.stringify({submission_id:submission.id,decision:'accepted',reason:'Agent self approval'})});assert.equal(forbidden.status,403);
 const history=await fetch(base+'/history',{headers:{Authorization:`Bearer ${runtime.token}`}});assert.equal((await history.json()).submissions[0].brief.title,'QA producer evidence decision');
});
