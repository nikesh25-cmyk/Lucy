import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './helpers.js';
import {TRACE_CLAIM_KINDS,traceContribution} from '../src/activity-pipeline.js';

const catalog=JSON.parse(readFileSync(new URL('../catalog/agriculture-statistics.json',import.meta.url),'utf8'));
const worldBank=catalog.countries.flatMap(country=>country.series).find(entry=>entry.indicator&&entry.raw_file&&entry.sha256);
const refusalOf=fn=>{try{fn();return null;}catch(error){return error;}};
// A real, non-demo mission whose task approves exactly the host the evidence library retains.
function registeredMission(f,{domains=['api.worldbank.org']}={}){
 const mission=f.tx('createMission',f.actor('admin'),{title:'A registered national baseline',area:'Agriculture',summary:'Record one registered indicator with its exact location and rights.',beneficiary:'A named public beneficiary',owner_id:f.actor('admin').account.id,reviewer_id:f.actor('reviewer').account.id,rubric:'Check the exact source, its version, its rights and the remaining uncertainty.'});
 const task=f.tx('createTask',f.actor('admin'),{mission_id:mission.id,title:'Record one registered indicator',instructions:'Read the registered series and record the exact row, its rights and the uncertainty.',rights:'Public material with attribution.',allowed_domains:domains});
 f.tx('missionStatus',f.actor('admin'),mission.id,'open');
 const second=f.tx('createTask',f.actor('admin'),{mission_id:mission.id,title:'Record a second registered indicator',instructions:'A second scoped task so a second claim can be leased.',rights:'Public material with attribution.',allowed_domains:domains});
 return{mission,task,second};
}
const citation=url=>({url,location:`Retained raw response; SHA256 ${worldBank.sha256}`,date:'2026-10-11'});
const dossier=f=>({artifact:'A registered baseline record with its exact supporting location.',sources:[citation(worldBank.url)],method:'Read the retained response and recorded the exact row.',limitations:'A fixture; the facts and rights still need human verification.',rights:'Public material recorded with attribution.'});

test('a genuine contribution resolves to its stored row, its version and the exact source version it cited',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const {task}=registeredMission(f);
 const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'trace-claim');
 const submitted=f.tx('submit',f.actor('alice'),{claim_id:claim.id,...dossier(f)},'trace-submission');
 const trace=f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:submitted.id});
 assert.equal(trace.claim.kind,'submission');
 assert.equal(trace.claim.id,submitted.id);
 assert.equal(trace.claim.attribution.account_id,f.actor('alice').account.id,'the claim resolves to the acting account');
 assert.equal(trace.claim.attribution.agent_id,agent.id);
 assert.equal(trace.action.table,'submissions');
 assert.equal(trace.action.version,1,'the exact version is reported, not a summary');
 assert.equal(trace.action.status,'pending_review');
 assert.equal(trace.action.claim_id,claim.id);
 assert.equal(trace.subject.task_version,1);
 assert.equal(trace.citations.length,1);
 assert.equal(trace.citations[0].state,'captured');
 assert.equal(trace.citations[0].capture.sha256,worldBank.sha256);
 assert.equal(trace.citations[0].capture.retained,true);
 assert.equal(trace.resolution.exact_version,true);
 assert.equal(trace.resolution.stored_action,true);
 assert.equal(trace.resolution.pinned_versions.length,1);
 assert.equal(trace.resolution.pinned_versions[0].sha256,worldBank.sha256);
 assert.equal(trace.resolution.pinned_versions[0].capture_id,trace.citations[0].capture.id);
 assert.deepEqual(trace.resolution.unresolved,[]);
 assert.equal(trace.reading.code,'unreviewed_claim');
 assert.equal(trace.reading.real_world_impact,false);
 assert.equal(trace.review.independent,false);
 // The reviewer's acceptance is recorded and the reading becomes a proposal — never an outcome.
 f.tx('review',f.actor('reviewer'),{submission_id:submitted.id,decision:'accepted',reason:'Checked the cited version and its location independently.'});
 const accepted=f.platform.traceContribution(f.actor('reviewer'),{claim_kind:'submission',claim_id:submitted.id});
 assert.equal(accepted.action.status,'accepted');
 assert.equal(accepted.review.independent,true);
 assert.equal(accepted.reading.code,'proposal');
 assert.equal(accepted.reading.external_adoption,false);
 assert.equal(accepted.reading.real_world_impact,false);
 assert.match(accepted.note,/proposal|resolves/);
 // Only the mission owner may record a use of it, and the reading then says declaration, not outcome.
 f.tx('adoption',f.actor('admin'),{submission_id:submitted.id,note:'Cited in the mission register.',evidence:'A recorded statement by the mission owner.'});
 const adopted=f.platform.traceContribution(f.actor('reviewer'),{claim_kind:'submission',claim_id:submitted.id});
 assert.equal(adopted.review.adoptions.length,1);
 assert.equal(adopted.reading.code,'recorded_declaration');
 assert.equal(adopted.reading.external_adoption,true);
 assert.equal(adopted.reading.institutional_claim,false);
 assert.equal(adopted.reading.real_world_impact,false);
 assert.equal(TRACE_CLAIM_KINDS.includes('submission'),true);
});

test('a claim citing nothing, or citing a version the library does not hold, is refused',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),other=f.agent('bob');
 const {task,second}=registeredMission(f);
 // (a) A claim with no id at all.
 const noId=refusalOf(()=>f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission'}));
 assert.equal(noId.status,400);
 assert.match(noId.message,/must name the stored row/);
 assert.equal(refusalOf(()=>f.platform.traceContribution(f.actor('alice'),{claim_kind:'alchemy',claim_id:'x'})).status,400);
 // (b) A claim that is not stored.
 const missing=refusalOf(()=>f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:'not-a-submission'}));
 assert.equal(missing.status,404);
 assert.match(missing.message,/not stored/);
 // (c) A citation whose named version the library does not hold, and a bare link with no version.
 const bare=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'trace-bare-claim');
 const bareSubmitted=f.tx('submit',f.actor('alice'),{claim_id:bare.id,...dossier(f),sources:[{url:worldBank.url,location:'Section 2, paragraph 3; SHA256 '+'f'.repeat(64),date:'2026-10-12'}]},'trace-bare-submission');
 const held=refusalOf(()=>f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:bareSubmitted.id}));
 assert.equal(held.status,409);
 assert.match(held.message,/None of this claim’s 1 citation\(s\) resolve to a stored source version/);
 assert.equal(held.code,undefined);
 // (d) A caller cannot turn an unresolved citation into evidence by naming any real capture.
 assert.equal(refusalOf(()=>f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:bareSubmitted.id,capture_id:'no-such-capture'})).status,404);
 const genuine=f.platform.get('SELECT id FROM evidence_captures WHERE sha256=? AND retained=1',worldBank.sha256).id;
 const unbound=refusalOf(()=>f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:bareSubmitted.id,capture_id:genuine}));
 assert.equal(unbound.status,409);
 assert.match(unbound.message,/not pinned/);
 // (e) A version that names another claim's submission is refused.
 const otherClaim=f.tx('claim',f.actor('bob'),{task_id:second.id,agent_id:other.id},'trace-second-claim');
 const otherSubmission=f.tx('submit',f.actor('bob'),{claim_id:otherClaim.id,...dossier(f)},'trace-second-submission');
 const borrowed=refusalOf(()=>f.platform.traceContribution(f.actor('bob'),{claim_kind:'submission',claim_id:otherSubmission.id,version_id:bareSubmitted.id}));
 assert.equal(borrowed.status,404);
 assert.match(borrowed.message,/does not exist/);
 // A version that really belongs to the same claim resolves.
 const ownVersion=f.platform.traceContribution(f.actor('bob'),{claim_kind:'submission',claim_id:otherSubmission.id,version_id:otherSubmission.id});
 assert.equal(ownVersion.action.version,otherSubmission.version);
 assert.equal(ownVersion.action.id,otherSubmission.id);
});

test('a guild contribution that cites nothing is refused, and a submitted one resolves to its row and sources',async t=>{
 const f=await fixture(t),organiser=f.agent('alice'),contributor=f.agent('bob');
 const project=f.tx('guildProjectCreate',f.actor('alice'),{agent_id:organiser.id,guild_id:'explorer',title:'A traced cooperation',summary:'One bounded workstream for the trace fixture.',visibility:'public',plan:[{id:'walk',title:'Trace one accessible route',output_name:'A traced route with start and end',scope:'Walk a route through the Commons and record the tiles actually passable.'}]});
 f.tx('guildParticipation',f.actor('bob'),{agent_id:contributor.id,project_id:project.id,action:'join'});
 const pledged=f.tx('guildContribution',f.actor('bob'),{agent_id:contributor.id,project_id:project.id,workstream_id:'walk',action:'pledge',commitment:'I will walk and record one route.'});
 const pledgeId=f.platform.get('SELECT id FROM guild_contributions WHERE project_id=? AND agent_id=?',project.id,contributor.id).id;
 const noCitation=refusalOf(()=>f.platform.traceContribution(f.actor('bob'),{claim_kind:'guild_contribution',claim_id:pledgeId}));
 assert.equal(noCitation.status,409);
 assert.match(noCitation.message,/cites nothing/);
 assert.equal(pledged.contributions[0].status,'pledged');
 f.tx('guildContribution',f.actor('bob'),{agent_id:contributor.id,project_id:project.id,workstream_id:'walk',action:'submit',evidence:'A recorded route with the tiles that blocked it.',sources:[{url:worldBank.url,location:`Row 1; SHA256 ${worldBank.sha256}`}]});
 const submitted=f.platform.get('SELECT id,status FROM guild_contributions WHERE project_id=? AND agent_id=?',project.id,contributor.id);
 assert.equal(submitted.status,'submitted');
 const trace=f.platform.traceContribution(f.actor('bob'),{claim_kind:'guild_contribution',claim_id:submitted.id});
 assert.equal(trace.action.table,'guild_contributions');
 assert.equal(trace.action.status,'submitted');
 assert.equal(trace.subject.workstream.id,'walk');
 assert.equal(trace.subject.project_title,'A traced cooperation');
 assert.equal(trace.citations.length,1);
 assert.equal(trace.citations[0].state,'captured');
 assert.equal(trace.resolution.pinned_versions[0].sha256,worldBank.sha256);
 assert.equal(trace.reading.scope,'practice');
 assert.equal(trace.reading.code,'practice_activity');
 assert.equal(trace.reading.world_status,'unverified_claim');
 assert.equal(trace.reading.external_adoption,false);
 assert.equal(trace.reading.real_world_impact,false);
 assert.equal(trace.review.independent,false);
 // The independent verification is the review row, and it is the only thing that reads as complete.
 f.tx('guildVerify',f.actor('moderator'),{agent_id:f.agent('moderator').id,project_id:project.id,contribution_id:submitted.id,action:'approve',reason:'Checked the recorded route independently.'});
 const verified=f.platform.traceContribution(f.actor('bob'),{claim_kind:'guild_contribution',claim_id:submitted.id});
 assert.equal(verified.action.status,'verified');
 assert.equal(verified.review.independent,true);
 assert.equal(verified.reading.code,'practice_activity');
 assert.equal(verified.reading.world_status,'verified_cooperation');
 assert.notEqual(verified.reading.code,'proposal','peer verification is not an external proposal');
 assert.equal(verified.reading.external_adoption,false);
 assert.equal(verified.reading.real_world_impact,false);
});

test('a calling receipt and a quest step resolve to the exact saved server fact',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:'quiet-harvest'},'trace-join');
 f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',`home:${agent.id}`,6,6,agent.id);
 f.tx('build',f.actor('alice'),agent.id,{x:4,y:6,type:'farm'});
 f.tx('gardenAction',f.actor('alice'),{agent_id:agent.id,action:'plant',x:4,y:6,kind:'herbs'});
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 f.platform.callings(f.actor('alice'),{agent_id:agent.id});
 const receipt=f.platform.get("SELECT * FROM calling_receipts WHERE agent_id=? AND objective_id LIKE 'quest:%'",agent.id);
 assert.ok(receipt,'the saved planting is credited to its authored step');
 const trace=f.platform.traceContribution(f.actor('alice'),{claim_kind:'quest_step',claim_id:receipt.id});
 assert.equal(trace.claim.attribution.account_id,f.actor('alice').account.id);
 assert.equal(trace.action.table,'calling_receipts');
 assert.equal(trace.action.objective_id,'quest:quiet-harvest.first-sowing');
 assert.equal(trace.action.source_kind,'crop_plant');
 assert.equal(trace.action.points,5);
 assert.equal(trace.action.points_kind,'cosmetic_calling_experience');
 assert.equal(trace.action.coins,0);
 assert.equal(trace.action.proof_hash,receipt.proof_hash);
 assert.equal(trace.resolution.pinned_versions[0].table,'calling_source_events');
 assert.equal(trace.resolution.pinned_versions[0].source_kind,'crop_plant');
 assert.equal(trace.resolution.pinned_versions[0].source_id,trace.action.source_id);
 assert.equal(trace.reading.scope,'practice');
 assert.equal(trace.reading.code,'practice_activity');
 assert.equal(trace.reading.real_world_impact,false);
 // A receipt naming a saved fact the world no longer holds is refused rather than summarised.
 f.platform.run('DELETE FROM journey_crops WHERE agent_id=? AND x=4 AND y=6',agent.id);
 const orphaned=refusalOf(()=>f.platform.traceContribution(f.actor('alice'),{claim_kind:'quest_step',claim_id:receipt.id}));
 assert.equal(orphaned.status,409);
 assert.match(orphaned.message,/does not hold/);
});

test('a trace is readable by the contributor, its own operator and a reviewer, and by nobody else',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const {task}=registeredMission(f);
 const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'trace-permission-claim');
 const submitted=f.tx('submit',f.actor('alice'),{claim_id:claim.id,...dossier(f)},'trace-permission-submission');
 assert.equal(f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:submitted.id}).action.id,submitted.id);
 assert.equal(f.platform.traceContribution(f.actor('admin'),{claim_kind:'submission',claim_id:submitted.id}).action.id,submitted.id);
 assert.equal(f.platform.traceContribution(f.actor('reviewer'),{claim_kind:'submission',claim_id:submitted.id}).action.id,submitted.id);
 // A different ordinary member gets the same 404 an unreadable row gets, so nothing is confirmed.
 const outsider=refusalOf(()=>f.platform.traceContribution(f.actor('bob'),{claim_kind:'submission',claim_id:submitted.id}));
 assert.equal(outsider.status,404);
 assert.equal(refusalOf(()=>f.platform.traceContribution(null,{claim_kind:'submission',claim_id:submitted.id})).status,401);
 // A runtime resolves only its own resident's claim.
 const session=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read'],duration_minutes:5,max_calls:5});
 assert.equal(traceContribution(f.platform,f.platform.authenticate(session.token),{claim_kind:'submission',claim_id:submitted.id}).action.id,submitted.id);
});

test('selecting a stored submission version traces that version and its own citations', async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const {task}=registeredMission(f);
 const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'trace-version-claim');
 const first=f.tx('submit',f.actor('alice'),{claim_id:claim.id,...dossier(f)},'trace-version-one');
 f.tx('review',f.actor('reviewer'),{submission_id:first.id,decision:'changes_requested',reason:'Please clarify the limitation in a new stored version.'});
 const second=f.tx('submit',f.actor('alice'),{claim_id:claim.id,...dossier(f),artifact:'A revised baseline with a clearly stated limitation and retained evidence.'},'trace-version-two');
 const old=f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:second.id,version_id:first.id});
 assert.equal(old.action.id,first.id);
 assert.equal(old.action.version,1);
 const current=f.platform.traceContribution(f.actor('alice'),{claim_kind:'submission',claim_id:first.id,version_id:second.id});
 assert.equal(current.action.id,second.id);
 assert.equal(current.action.version,2);
 assert.equal(current.action.artifact_characters,'A revised baseline with a clearly stated limitation and retained evidence.'.length);
});
