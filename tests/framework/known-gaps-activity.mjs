#!/usr/bin/env node
// Known gaps the Wave 4 activity pipeline found and must not fix, plus one behavioural pin.
//
// This file is deliberately NOT discovered by the test runner: `node --test` discovers
// `*.test.js`/`*.test.mjs`, and this file is `known-gaps-activity.mjs` under `tests/framework/`. So
// `npm test` stays green while every defect below stays reproducible by hand:
//
//     node tests/framework/known-gaps-activity.mjs
//
// A `GAP` check is written as the invariant that *should* hold, so it fails while the defect exists
// and passes once the defect is fixed. A `PIN` check records a documented design decision as it
// behaves today: it passes while the behaviour is unchanged and must be re-read, not "fixed", if the
// policy changes. The exit code counts GAPs only: 0 means every defect is gone, 1 means at least one
// still reproduces. Each gap prints its command, its expected invariant, the observed behaviour and
// the owner of the fix.
//
// Every check opens its own disposable database through the shipped `openDatabase` path and removes
// it afterwards. The installed live product, its database, its backups and its model weights are
// never read or written.

import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Platform} from '../../src/platform.js';
import {validateDatabase, backupDatabase} from '../../src/recovery.js';
import {verifyActivityStructure} from '../../src/activity-pipeline.js';
import {verifyQuestReceipts} from '../../src/quests.js';

const ROOT=dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PASSWORD='known-gaps-password-2026';
const checks=[];
const check=(kind,name,details,run)=>checks.push({kind,name,details,run});
const source=fn=>fn.toString().replace(/\s*\/\/\s*/g,' ').replace(/\s+/g,' ');
const withPlatform=async run=>{
 const directory=await mkdtemp(join(tmpdir(),'known-gaps-activity-'));
 const platform=new Platform(join(directory,'platform.sqlite'));
 try{return await run(platform,join(directory,'platform.sqlite'));}
 finally{try{platform.close();}catch{/* a check may have closed it */}await rm(directory,{recursive:true,force:true});}
};
// One installation with an administrator, a reviewer and a contributor, on a disposable database.
async function installation(platform){
 const admin=await platform.register({name:'Admin',email:'admin@example.org',password:PASSWORD,consent:true});
 const administrator=platform.authenticate(admin.token);
 const authorization=platform.transaction(()=>platform.invite(administrator,{role:'reviewer'}));
 const reviewer=await platform.register({name:'Reviewer',email:'reviewer@example.org',password:PASSWORD,consent:true,invite:authorization.code});
 const contributor=await platform.register({name:'Contributor',email:'contributor@example.org',password:PASSWORD,consent:true});
 return{admin:administrator,reviewer:platform.authenticate(reviewer.token),contributor:platform.authenticate(contributor.token)};
}
function realMission(platform,people,rubric='Check the exact source version, its rights and the remaining uncertainty.'){
 const mission=platform.transaction(()=>platform.createMission(people.admin,{title:'A traced contribution',area:'Climate',summary:'One scoped task whose sources can be resolved to a stored version.',beneficiary:'A named beneficiary',owner_id:people.admin.account.id,reviewer_id:people.reviewer.account.id,rubric}));
 const task=platform.transaction(()=>platform.createTask(people.admin,{mission_id:mission.id,title:'Record one source',instructions:'Provide the source, its exact location, its rights and its uncertainty.',rights:'Public material with attribution.',allowed_domains:['example.org']}));
 platform.transaction(()=>platform.missionStatus(people.admin,mission.id,'open'));
 return{mission,task};
}
const bareSubmission=(claim,overrides={})=>({
 claim_id:claim.id,
 artifact:'A plain text evidence register entry with one attributed source.',
 sources:[{url:'https://example.org/plain-report',location:'Section 2, paragraph 3',date:'2026-01-01'}],
 method:'Read the published report and recorded the exact supporting section.',
 limitations:'A reproduction fixture; the facts and rights need human verification.',
 rights:'Public material recorded with attribution.',
 ...overrides});

check('GAP',
 'GAP-1 a contribution can be accepted with no citation resolved to a stored source version',
 {
  command:'node tests/framework/known-gaps-activity.mjs',
  expected:'An accepted mission contribution resolves to at least one stored evidence_captures version, so a reviewer can check the exact version it rests on. `traceContribution` enforces this and refuses such a claim.',
  observed:'Platform.submit accepts a citation whose locator names no retained SHA-256, and Platform.review accepts that version: status becomes `accepted` and the fixed coin receipt is issued, while submission_evidence.capture_id stays NULL and the citation reads `missing`.',
  owner:'src/platform.js submit/review path — the sibling branch `framework-wave1-contract` is the natural home for the refusal.',
 },
 async()=>{
  await withPlatform(async platform=>{
   const people=await installation(platform);
   const {task}=realMission(platform,people);
   const agent=platform.transaction(()=>platform.createAgent(people.contributor,{name:'Reader',kind:'agent'}));
   const claim=platform.transaction(()=>platform.claim(people.contributor,{task_id:task.id,agent_id:agent.id},'gap1-claim'));
   const submission=platform.transaction(()=>platform.submit(people.contributor,bareSubmission(claim),'gap1-submission'));
   const review=platform.transaction(()=>platform.review(people.reviewer,{submission_id:submission.id,decision:'accepted',reason:'Accepted with no pinned version, which is the gap.'}));
   assert.equal(review.decision,'accepted');
   const citations=platform.all('SELECT source_number,state,capture_id FROM submission_evidence WHERE submission_id=?',submission.id);
   assert.ok(citations.length>0,'the submission stores its citation');
   const pinned=citations.filter(citation=>citation.capture_id);
   assert.ok(pinned.length>0,`expected at least one citation pinned to a stored source version; observed ${JSON.stringify(citations)} with submission status ${platform.get('SELECT status FROM submissions WHERE id=?',submission.id).status}`);
  });
 });

check('GAP',
 'GAP-2 the whole-database activity check is not part of backup/restore validation',
 {
  command:'node tests/framework/known-gaps-activity.mjs',
  expected:'validateDatabase refuses a stored state that verifyActivityStructure refuses, so a backup or a restore cannot carry an activity that skips a required stage.',
  observed:'A mission left in a non-discoverable state while an accepted version of it is stored makes verifyActivityStructure return false, while validateDatabase still returns a version and backupDatabase still copies the database.',
  owner:'src/recovery.js validateDatabase — src/recovery.js is outside this slice and was not edited; the schema-26 work owns it.',
 },
 async()=>{
  await withPlatform(async(platform,path)=>{
   const people=await installation(platform);
   const {mission,task}=realMission(platform,people);
   const agent=platform.transaction(()=>platform.createAgent(people.contributor,{name:'Reader',kind:'agent'}));
   const claim=platform.transaction(()=>platform.claim(people.contributor,{task_id:task.id,agent_id:agent.id},'gap2-claim'));
   const submission=platform.transaction(()=>platform.submit(people.contributor,bareSubmission(claim),'gap2-submission'));
   platform.transaction(()=>platform.review(people.reviewer,{submission_id:submission.id,decision:'accepted',reason:'Accepted for this reproduction.'}));
   assert.equal(verifyActivityStructure(platform.db),true,'the untouched state must satisfy the pipeline');
   platform.run("UPDATE missions SET status='draft' WHERE id=?",mission.id);
   assert.equal(verifyActivityStructure(platform.db),false,'the tampered state must be refused by the pipeline check');
   let validation=null,copied=null;
   try{validation=validateDatabase(path);}catch(error){validation={refused:error.message};}
   try{copied=backupDatabase(platform.db,join(dirname(path),'backups','gap2.sqlite'));}catch(error){copied={refused:error.message};}
   platform.run("UPDATE missions SET status='open' WHERE id=?",mission.id);
   assert.ok(validation&&validation.refused,`expected validateDatabase to refuse the state verifyActivityStructure refuses; observed ${JSON.stringify(validation)} and backup ${JSON.stringify(copied)}`);
  });
 });

check('GAP',
 'GAP-3 the append-only audit names the world, not the block, for a construction action',
 {
  command:'node tests/framework/known-gaps-activity.mjs',
  expected:'Every saved action has a journal entry that names it, so a reviewer can resolve one block to one append-only record.',
  observed:"frontierBuild writes an audit row whose record_id is the world id, so several blocks placed in one world share one indistinguishable journal entry. The block row's own creator_account_id carries the attribution, and the frontier_actions ledger records the action, but the audit alone cannot resolve a block.",
  owner:'src/frontier.js recordAction — its record_id could name the block or the ledger row without changing any table.',
 },
 async()=>{
  await withPlatform(async platform=>{
   const people=await installation(platform);
   const agent=platform.transaction(()=>platform.createAgent(people.admin,{name:'Builder',kind:'agent'}));
   const parcel=platform.get("SELECT * FROM land_parcels WHERE world_id='frontier:0:0' AND reserved=0 ORDER BY x,y LIMIT 1");
   assert.ok(parcel,'the seeded frontier sector must offer an unreserved parcel');
   platform.transaction(()=>platform.landAssign(people.admin,{plot_id:parcel.id,purpose:'A reproduction plot',description:'Assigned to reproduce the audit gap.'}));
   platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',parcel.world_id,parcel.x,parcel.y,agent.id);
   const built=platform.transaction(()=>platform.frontierBuild(people.admin,agent.id,{world_id:parcel.world_id,x:parcel.x+1,y:parcel.y,z:0,type:'wood'}));
   assert.equal(built.changed,true);
   assert.equal(built.plot_id,parcel.id);
   const journal=platform.all("SELECT event,record_id FROM audit WHERE event='frontier.place' ORDER BY seq DESC LIMIT 1");
   assert.equal(journal.length,1,'the build is journalled');
   assert.equal(journal[0].record_id,built.id,`expected the journal entry to name the block ${built.id}; observed record_id=${journal[0].record_id} (the world ${built.world_id}) while frontier_actions holds the action row`);
  });
 });

check('PIN',
 'PIN-2 a resident that has not started still reads the published activities available to it',
 {
  command:'node tests/framework/known-gaps-activity.mjs',
  expected:'The board lists the published activities a resident could take up, each blocked at participation and claiming no stage, so an operator can tell an available activity apart from one that is under way.',
  observed:'activityInstances lists every published gardening and world-building chain for the resident, marked `blocked_by: participation` with no credited stage, beside the restorations, claims and guild participations it actually holds.',
  owner:'src/activity-pipeline.js activityInstances — this pin records the listing rule. An unjoined chain is listed at its scoped task; an activity the resident holds is listed with its own reached stage.',
 },
 async()=>{
  await withPlatform(async platform=>{
   const people=await installation(platform);
   const agent=platform.transaction(()=>platform.createAgent(people.admin,{name:'Newcomer',kind:'agent'}));
   const view=platform.activity(people.admin,{agent_id:agent.id});
   const available=view.instances.filter(entry=>entry.stages.find(stage=>stage.id==='participation')?.reached===false);
   assert.ok(available.length>=4,`expected the published chains to be listed as available; observed instance_count=${view.instance_count}`);
   assert.ok(available.every(entry=>entry.blocked_by==='participation'));
   assert.ok(available.every(entry=>entry.stage==='scoped_task'||entry.stage==='discovery'));
   assert.equal(available.every(entry=>entry.order_violation===false),true);
   assert.equal(view.under_way_count,0,'nothing is under way for a resident that has not started');
   assert.equal(view.next_action,null);
  });
 });

check('PIN',
 'PIN-1 a calling whose own objectives answer the same saved facts spends the shared daily credit first',
 {
  command:'node tests/framework/known-gaps-activity.mjs',
  expected:'Calling objectives are reconciled before enrolled quest steps and share one ten-a-day cosmetic allowance, so a calling that answers a fact the chain also uses spends the allowance first. The work is still saved and the pipeline still reports it; only the cosmetic credit is limited. The pipeline reports the work and the credit separately for exactly this reason.',
  observed:'After one recorded visit to a shared world (an Explorer calling objective, `shared_visit`) and one frontier build (`frontier_place`), the day holds ten points: five on `explorer.shared_visit` and five on the enrolled chain’s first step. The chain’s remaining steps wait for the next UTC day.',
  owner:'src/vocations.js and src/quests.js policy — a design decision. This pin records it; changing the policy means rewriting this pin, not deleting it silently.',
 },
 async()=>{
  await withPlatform(async platform=>{
   const people=await installation(platform);
   const agent=platform.transaction(()=>platform.createAgent(people.admin,{name:'Explorer',kind:'agent'}));
   platform.transaction(()=>platform.callingSelect(people.admin,{agent_id:agent.id,calling_id:'explorer'}));
   platform.transaction(()=>platform.questJoin(people.admin,{agent_id:agent.id,chain_id:'shared-frontier-path'},'pin1-join'));
   const now=platform.clock(),stamp=new Date(now).toISOString();
   platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?','frontier:0:0',24,24,agent.id);
   platform.run('INSERT INTO journey_visits(agent_id,world_id,visited_at) VALUES(?,?,?)',agent.id,'frontier:0:0',now);
   platform.run("INSERT INTO frontier_actions(id,account_id,agent_id,world_id,action,created_at) VALUES('pin1-action',?,?,'frontier:0:0','place',?)",people.admin.account.id,agent.id,stamp);
   const board=platform.quests(people.admin,{agent_id:agent.id});
   const chain=board.chains.find(entry=>entry.slug==='shared-frontier-path');
   const receipts=platform.all('SELECT objective_id,points FROM calling_receipts WHERE agent_id=? ORDER BY created_at',agent.id);
   assert.equal(chain.steps[0].state,'complete','the saved placement is credited to its authored step');
   assert.equal(chain.steps[1].state,'available','the chain’s second step is waiting, not credited');
   assert.deepEqual(receipts.map(entry=>entry.objective_id),['explorer.shared_visit','quest:shared-frontier-path.mark-the-pass']);
   assert.equal(receipts.reduce((total,entry)=>total+entry.points,0),10,'the shared daily allowance is exactly spent');
   const activity=platform.activity(people.admin,{agent_id:agent.id});
   const instance=activity.instances.find(entry=>entry.instance_id==='quest:shared-frontier-path');
   assert.equal(instance.stages.find(entry=>entry.id==='saved_contribution').reached,true,'the saved work is reported even when the credit is not');
   assert.equal(instance.credited,true);
  });
 });

check('GAP',
 'GAP-5 the receipt verifier documents a claim linkage it does not re-check for stored rows',
 {
  command:'node tests/framework/known-gaps-activity.mjs',
  expected:'A receipt for an independently accepted step resolves to a claim on the same task and version, and verifyQuestReceipts refuses one that does not.',
  observed:'verifyQuestReceipts carries a deliberate grandfather clause: it does not re-check claim linkage for rows stored before the linkage was enforced, so a historical research_accepted receipt that answers a different claim is still accepted as valid. reconcileQuests prevents new mismatches; stored ones are neither detected nor marked.',
  owner:'src/quests.js verifyQuestReceipts — its own comment names a later schema migration as the fix, and schema 26 belongs to a sibling branch.',
 },
 async()=>{
  await withPlatform(async platform=>{
   const text=source(verifyQuestReceipts);
   assert.match(text,/This verifier also runs against existing schema-22 databases/,'the grandfather clause is stated in the verifier');
   assert.match(text,/Such saved history must remain readable/,'the verifier states that mismatched history stays readable');
   assert.match(text,/reconcileQuests prevents new mismatches/,'the verifier names the prevention it relies on');
   assert.match(text,/A later schema migration can mark grandfathered receipts/,'the verifier names the migration that would close the gap');
   assert.match(text,/scopedAcceptanceSql/,`expected verifyQuestReceipts to re-check the claim linkage the comment describes; observed no such check in the verifier body, so a stored research_accepted receipt that answers a different claim is still accepted as valid (body length ${text.length})`);
  });
 });

let gaps=0,pins=0,failures=0;
console.log('NemoWorld Wave 4 activity pipeline — known gaps');
console.log(`  ${checks.length} checks: ${checks.filter(entry=>entry.kind==='GAP').length} gaps (fail while the defect exists) and ${checks.filter(entry=>entry.kind==='PIN').length} pin (passes while the documented behaviour holds)`);
console.log('');
for(const entry of checks){
 try{
  await entry.run();
  if(entry.kind==='PIN')pins+=1;
  console.log(`PASS  ${entry.name}`);
 }catch(error){
  if(entry.kind==='GAP')gaps+=1;else failures+=1;
  console.log(`${entry.kind==='PIN'?'PIN-CHANGED':'FAIL'}  ${entry.name}`);
  console.log(`      command   ${entry.details.command}`);
  console.log(`      expected  ${entry.details.expected}`);
  console.log(`      observed  ${entry.details.observed}`);
  console.log(`      owner     ${entry.details.owner}`);
  console.log(`      assertion ${String(error.message).split('\n')[0]}`);
 }
}
console.log('');
console.log(`SUMMARY  ${gaps} gap(s) reproduced, ${pins} pin(s) unchanged, ${failures} pin(s) changed`);
console.log('  these checks are not run by `npm test`: the file is not named *.test.mjs');
console.log('  the disposable databases created here are removed; the installed product is never opened');
process.exitCode=gaps+failures?1:0;
