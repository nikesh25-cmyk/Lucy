import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,evidence} from './helpers.js';
import {createApp} from '../server.js';
const count=(view,status)=>view.workflow_summary.statuses.find(row=>row.status===status)?.count||0;
test('workflow summary follows review and adoption inside composed facets while ignoring status and pagination',async t=>{
 const f=await fixture(t),scope={country:'NP',region:'farmlands',goal:2,q:'tea'},before=f.platform.research(null,scope),lead=before.leads[0];assert.equal(before.workflow_summary.total,6);
 const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:lead.id,beneficiary:'PRIVATE WORKFLOW BENEFICIARY',reviewer_id:f.actor('reviewer').account.id});
 let view=f.platform.research(null,{...scope,status:'accepted',limit:1,offset:100});assert.equal(view.total,0);assert.equal(view.leads.length,0);assert.equal(view.workflow_summary.total,6);assert.equal(count(view,'activated'),1);assert.equal(count(view,'proposed'),5);
 const claim=f.tx('claim',f.actor('alice'),{task_id:activated.task_id},'workflow-claim');view=f.platform.research(null,scope);assert.equal(count(view,'leased'),1);assert.equal(count(view,'activated'),0);
 const submission=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:'PRIVATE WORKFLOW ARTIFACT',sources:[{url:lead.source_urls[0],location:'Fictional workflow fixture',date:'2026-10-12'}]}),'workflow-submit');view=f.platform.research(null,scope);assert.equal(count(view,'under_review'),1);assert.equal(count(view,'leased'),0);
 f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Fictional internal review'});view=f.platform.research(null,scope);assert.equal(count(view,'accepted'),1);assert.equal(count(view,'adopted'),0);
 f.tx('adoption',f.actor('admin'),{submission_id:submission.id,note:'PRIVATE WORKFLOW DECLARATION'});view=f.platform.research(null,{...scope,status:'adopted'});assert.equal(view.total,1);assert.equal(count(view,'adopted'),1);assert.equal(count(view,'accepted'),0);assert.equal(view.workflow_summary.total,6);assert.doesNotMatch(JSON.stringify(view.workflow_summary),/PRIVATE WORKFLOW/);assert.match(view.workflow_summary.qualification,/not verified external/);
 assert.equal(f.platform.research(null,{...scope,goal:13}).workflow_summary.total,0);assert.equal(f.platform.research(null,{...scope,country:'AF'}).workflow_summary.total,0);assert.equal(f.platform.research(null,{...scope,q:"' OR 1=1"}).workflow_summary.total,0);assert.equal(f.platform.research(null,{country:'NP'}).workflow_summary.total,74);assert.equal(f.platform.verifyAudit(),true);
});
test('HTTP workflow summaries respect institution and target facets without changing saved research',async t=>{
 const f=await fixture(t);f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',target_code:'2.3'});f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:'fao'});const before=f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n;
 const app=createApp({platform:f.platform});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});const base='http://127.0.0.1:'+app.server.address().port;
 for(const [query,total]of [['country=NP&target=2.3',4],['country=NP&institution=fao',2],['country=NP&target=2.3&institution=fao',0]]){const response=await fetch(base+'/api/v1/research?'+query+'&status=accepted&limit=1&offset=10');assert.equal(response.status,200);const view=await response.json();assert.equal(view.total,0);assert.equal(view.workflow_summary.total,total);assert.equal(count(view,'proposed'),total);assert.equal(view.country_plan.total,80);assert.equal(view.catalog_total,before);}
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n,before);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.verifyAudit(),true);
});
