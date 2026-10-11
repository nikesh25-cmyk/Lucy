import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,realMission,evidence} from './helpers.js';
import {normalizeDraft} from '../src/drafts.js';
import {Platform} from '../src/platform.js';
import {createApp} from '../server.js';
const draft=claim=>({claim_id:claim.id,expected_revision:0,format:'evidence-form-v1',values:{artifact:'Incomplete private research',url_0:'',method:''}});
test('private incomplete drafts survive restart, reject stale edits and appear only in owner export',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'private-draft');
 assert.equal(f.tx('draftSave',f.actor('alice'),draft(claim)).revision,1);
 assert.equal(f.platform.history(f.actor('bob')).drafts.length,0);assert.equal(f.platform.history(f.actor('reviewer')).drafts.length,0);
 assert.throws(()=>f.tx('draftSave',f.actor('bob'),draft(claim)),{status:404});
 assert.throws(()=>f.tx('draftSave',f.actor('alice'),{...draft(claim),expected_revision:1,format:'decision-brief-form-v1'}),{status:409});
 f.advance();assert.throws(()=>f.tx('draftSave',f.actor('alice'),draft(claim)),{status:409});
 assert.equal(f.tx('draftSave',f.actor('alice'),{...draft(claim),expected_revision:1}).revision,1);
 f.tx('draftArchive',f.actor('alice'),{claim_id:claim.id,archived:true});assert.equal(f.platform.history(f.actor('alice')).drafts.length,0);assert.equal(f.platform.exportAccount(f.actor('alice')).drafts.length,1);
 f.tx('draftArchive',f.actor('alice'),{claim_id:claim.id,archived:false});f.platform.close();const reopened=new Platform(f.database,f.clock);t.after(()=>reopened.close());assert.equal(reopened.history(reopened.authenticate(f.credentials.alice.token)).drafts[0].content.values.artifact,'Incomplete private research');assert.equal(reopened.verifyAudit(),true);
});
test('expired research saves privately, resumes once when available and respects competing claims and task versions',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'expire-draft');f.tx('draftSave',f.actor('alice'),draft(claim));f.advance(21*60_000);
 f.tx('draftSave',f.actor('alice'),{...draft(claim),expected_revision:1,values:{artifact:'More work after expiry'}});
 const other=f.tx('claim',f.actor('bob'),{task_id:task.id},'competing');assert.throws(()=>f.tx('draftResume',f.actor('alice'),{claim_id:claim.id},'resume'),{status:409});f.tx('releaseClaim',f.actor('bob'),other.id);
 const result=f.tx('draftResume',f.actor('alice'),{claim_id:claim.id},'resume');assert.notEqual(result.claim.id,claim.id);assert.equal(result.draft.content.values.artifact,'More work after expiry');assert.equal(f.tx('draftResume',f.actor('alice'),{claim_id:claim.id},'resume').claim.id,result.claim.id);assert.equal(f.platform.drafts(f.actor('alice')).length,1);assert.equal(f.platform.exportAccount(f.actor('alice')).drafts.length,2);
 f.tx('releaseClaim',f.actor('alice'),result.claim.id);f.platform.run('UPDATE tasks SET version=version+1 WHERE id=?',task.id);assert.throws(()=>f.tx('draftResume',f.actor('alice'),{claim_id:result.claim.id},'changed'),{status:409});assert.equal(f.platform.verifyAudit(),true);
});
test('draft normalization accepts unfinished brief rows and rejects arbitrary credentials and excessive content',()=>{
 const value={format:'decision-brief-form-v1',values:{recipient:'',title:'Work in progress'},counts:{sources:1,findings:1,options:2,milestones:1,costs:1}};assert.deepEqual(normalizeDraft(value),value);
 assert.throws(()=>normalizeDraft({...value,values:{token:'secret'}}),{status:400});assert.throws(()=>normalizeDraft({...value,counts:{...value.counts,options:5}}),{status:400});assert.throws(()=>normalizeDraft({...value,values:{title:'x'.repeat(3001)}}),{status:400});
});
test('submission archives private drafts and account deletion removes their content',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'submitted-draft');f.tx('draftSave',f.actor('alice'),draft(claim));f.tx('submit',f.actor('alice'),evidence(claim),'submitted');assert.equal(f.platform.drafts(f.actor('alice')).length,0);assert.equal(f.platform.exportAccount(f.actor('alice')).drafts.length,1);assert.throws(()=>f.tx('draftSave',f.actor('alice'),{...draft(claim),expected_revision:1}),{status:409});f.tx('review',f.actor('reviewer'),{submission_id:f.platform.history(f.actor('alice')).submissions[0].id,decision:'changes_requested',reason:'Need fixture corrections'});assert.equal(f.platform.drafts(f.actor('alice')).length,1);f.advance();assert.equal(f.tx('draftSave',f.actor('alice'),{...draft(claim),expected_revision:1,values:{artifact:'Corrected research'}}).revision,2);f.tx('deleteAccount',f.actor('alice'));assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claim_drafts').n,0);
});
test('HTTP draft resume requires idempotency and runtime credentials cannot read or write private drafts',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'http-draft'),agent=f.agent('alice'),runtime=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','contribute'],duration_minutes:10,max_calls:20});
 const {server}=createApp({platform:f.platform});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}/api/v1`,headers={Authorization:`Bearer ${f.credentials.alice.token}`,'Content-Type':'application/json'};
 const saved=await fetch(base+'/drafts',{method:'POST',headers,body:JSON.stringify(draft(claim))});assert.equal(saved.status,200);
 for(const method of ['GET','POST'])assert.equal((await fetch(base+'/drafts',{method,headers:{Authorization:`Bearer ${runtime.token}`,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(draft(claim))}:{})})).status,403);
 f.advance(21*60_000);assert.equal((await fetch(base+'/drafts/resume',{method:'POST',headers,body:JSON.stringify({claim_id:claim.id})})).status,400);
 const resumed=await fetch(base+'/drafts/resume',{method:'POST',headers:{...headers,'Idempotency-Key':'http-resume'},body:JSON.stringify({claim_id:claim.id})});assert.equal(resumed.status,200);assert.equal((await resumed.json()).draft.content.values.artifact,'Incomplete private research');
});
