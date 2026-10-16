import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,evidence} from './helpers.js';
import {briefFixture} from './brief-fixture.js';
import {createApp} from '../server.js';
import {statisticsUrl} from '../src/statistics.js';
import {runResearch} from '../runtime/research-worker.js';
const count=(view,status)=>view.workflow_summary.statuses.find(row=>row.status===status)?.count||0;
test('workflow summary follows review and adoption inside composed facets while ignoring status and pagination',async t=>{
 const f=await fixture(t),scope={country:'NP',region:'farmlands',goal:2,q:'tea'},before=f.platform.research(null,scope),lead=before.leads[0];assert.equal(before.workflow_summary.total,6);
 const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:lead.id,beneficiary:'PRIVATE WORKFLOW BENEFICIARY',reviewer_id:f.actor('reviewer').account.id});
 let view=f.platform.research(null,{...scope,status:'accepted',limit:1,offset:100});assert.equal(view.total,0);assert.equal(view.leads.length,0);assert.equal(view.workflow_summary.total,6);assert.equal(count(view,'activated'),1);assert.equal(count(view,'proposed'),5);
 const claim=f.tx('claim',f.actor('alice'),{task_id:activated.task_id},'workflow-claim');view=f.platform.research(null,scope);assert.equal(count(view,'leased'),1);assert.equal(count(view,'activated'),0);
 const submission=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:'PRIVATE WORKFLOW ARTIFACT',sources:[{url:lead.source_urls[0],location:'Fictional workflow fixture',date:'2026-10-12'}]}),'workflow-submit');view=f.platform.research(null,scope);assert.equal(count(view,'under_review'),1);assert.equal(count(view,'leased'),0);
 f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Fictional internal review'});view=f.platform.research(null,scope);assert.equal(count(view,'accepted'),1);assert.equal(count(view,'adopted'),0);
 f.tx('adoption',f.actor('admin'),{submission_id:submission.id,note:'PRIVATE WORKFLOW DECLARATION'});view=f.platform.research(null,{...scope,status:'adopted'});assert.equal(view.total,1);assert.equal(count(view,'adopted'),1);assert.equal(count(view,'accepted'),0);assert.equal(view.workflow_summary.total,6);assert.doesNotMatch(JSON.stringify(view.workflow_summary),/PRIVATE WORKFLOW/);assert.match(view.workflow_summary.qualification,/not verified external/);
 assert.equal(f.platform.research(null,{...scope,goal:13}).workflow_summary.total,0);assert.equal(f.platform.research(null,{...scope,country:'AF'}).workflow_summary.total,0);assert.equal(f.platform.research(null,{...scope,q:"' OR 1=1"}).workflow_summary.total,0);assert.equal(f.platform.research(null,{country:'NP'}).workflow_summary.total,29);assert.equal(f.platform.verifyAudit(),true);
});
test('HTTP workflow summaries respect institution and target facets without changing saved research',async t=>{
 const f=await fixture(t);f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',target_code:'2.3'});f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:'fao'});const before=f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n;
 const app=createApp({platform:f.platform});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});const base='http://127.0.0.1:'+app.server.address().port;
 for(const [query,total]of [['country=NP&target=2.3',4],['country=NP&institution=fao',2],['country=NP&target=2.3&institution=fao',0]]){const response=await fetch(base+'/api/v1/research?'+query+'&status=accepted&limit=1&offset=10');assert.equal(response.status,200);const view=await response.json();assert.equal(view.total,0);assert.equal(view.workflow_summary.total,total);assert.equal(count(view,'proposed'),total);assert.equal(view.country_plan.total,35);assert.equal(view.catalog_total,before);}
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n,before);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.verifyAudit(),true);
});

test('both worker synthesis paths withhold numeric model prose and submit the validated register instead',async t=>{
 const f=await fixture(t),lead=f.platform.research(null,{country:'NP',goal:2,stage:'baseline'}).leads.find(item=>item.id==='NP-2-baseline'),statistics=statisticsUrl('NPL','AG.LND.ARBL.ZS'),raw=readFileSync(new URL('../catalog/statistics/NPL-AG.LND.ARBL.ZS.json',import.meta.url),'utf8');
 const registered=f.tx('researchActivate',f.actor('admin'),{lead_id:lead.id,beneficiary:'Fictional agriculture evidence users',reviewer_id:f.actor('reviewer').account.id,allowed_domains:['api.worldbank.org']});
 const mixed=f.tx('createTask',f.actor('admin'),{mission_id:registered.mission_id,title:'Mixed briefing fixture',instructions:'Qualitative sector context with one web source and registered observations.',rights:'Attribution required.',allowed_domains:['api.worldbank.org','example.org']});
 const agent=f.agent('alice'),bobAgent=f.agent('bob'),{server}=createApp({platform:f.platform});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const url=`http://127.0.0.1:${server.address().port}`,resolve=async()=>[{address:'93.184.216.34',family:4}];
 const fetchImpl=async(input,options)=>new URL(input).hostname==='127.0.0.1'?fetch(input,options):new Response(new URL(input).hostname==='api.worldbank.org'?raw:'<article><p>Fictional web source for the workflow fixture. Local applicability, buyers and costs are not established.</p></article>',{headers:{'content-type':new URL(input).hostname==='api.worldbank.org'?'application/json':'text/html'}});
 const runtime=(account='alice',id=agent.id)=>f.tx('runtime',f.actor(account),id,{scopes:['read','contribute'],minutes:5,max_calls:20}).token;
 const register=await runResearch({token:runtime(),url,taskId:registered.task_id,urls:[statistics],modelFn:async()=>JSON.stringify({claims:[{text:'Recorded land area share is 12.5 percent.',sources:[1]}],gaps:['Local soil evidence is missing.']}),resolve,fetchImpl});
 assert.equal(register.status,'pending_review');assert.equal(register.draft_status,'withheld_numeric_prose');assert.equal(register.mode,'local-model');
 const kept=f.platform.get('SELECT * FROM submissions WHERE id=?',register.submission_id);assert.match(kept.artifact,/MODEL DRAFT WITHHELD/);assert.doesNotMatch(kept.artifact,/12\.5 percent/);assert.match(kept.artifact,/2024, 12\.5831880013952 % of land area/);assert.equal(kept.status,'pending_review');
 const brief=await runResearch({token:runtime('bob',bobAgent.id),url,taskId:mixed.id,urls:[statistics,'https://example.org/report'],output:'decision-brief',briefContext:{recipient:'Proposed agriculture ministry focal point',requested_decision:'Decide which missing evidence to gather before selecting a pilot.'},modelFn:async()=>JSON.stringify(briefFixture({cost_scenario:null,findings:[{text:'The 2019 directive shapes current practice.',source_numbers:[2],qualification:'Fictional workflow source.'}]})),resolve,fetchImpl});
 assert.equal(brief.status,'pending_review');assert.equal(brief.draft_status,'withheld_numeric_prose');
 const held=f.platform.get('SELECT * FROM submissions WHERE id=?',brief.submission_id);assert.match(held.artifact,/DECISION BRIEF WITHHELD/);assert.doesNotMatch(held.artifact,/LUCY DECISION BRIEF|2019 directive/);assert.match(held.artifact,/2024, 12\.5831880013952 % of land area/);assert.equal(f.platform.get('SELECT status FROM research_leads WHERE task_id=?',registered.task_id).status,'under_review');assert.equal(f.platform.verifyAudit(),true);
});
