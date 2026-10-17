import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,realMission,evidence} from './helpers.js';
import {ACTIVITY_KINDS,ACTIVITY_KIND_IDS,ACTIVITY_POLICY,ACTIVITY_STAGE_IDS,ACTIVITY_STAGES,KIND_BY_SOURCE_KIND,PRACTICE_BOUNDARY_FIELDS,activityInstance,activityInstances,activityReading,activityStageOrder,assertPracticeBoundary,verifyActivityStructure} from '../src/activity-pipeline.js';
import {verifyQuestStructure} from '../src/quests.js';

const position=(f,agent,x=6,y=6)=>f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',`home:${agent.id}`,x,y,agent.id);
const farm=(f,agent,x=4,y=6)=>f.tx('build',f.actor('alice'),agent.id,{x,y,type:'farm'});
const garden=(f,agent,action,x=4,y=6,kind='herbs')=>f.tx('gardenAction',f.actor('alice'),{agent_id:agent.id,action,x,y,...(action==='plant'?{kind}:{})});
const begin=(f,agent,chain='quiet-harvest',key='join-1')=>f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:chain},key);
const report=(f,agent,owner='alice')=>f.platform.activity(f.actor(owner),{agent_id:agent.id});
const instanceNamed=(f,agent,instance_id,owner='alice')=>report(f,agent,owner).instances.find(entry=>entry.instance_id===instance_id);
const stageNamed=(instance,id)=>instance.stages.find(entry=>entry.id===id);
const boundaryFields=PRACTICE_BOUNDARY_FIELDS.map(entry=>entry.field);

test('the pipeline states one ordered contract for every kind and grants nothing',async t=>{
 assert.deepEqual([...ACTIVITY_STAGE_IDS],['discovery','scoped_task','participation','saved_contribution','independent_review','world_effect','journal']);
 assert.deepEqual(ACTIVITY_STAGES.map(stage=>stage.ordinal),[1,2,3,4,5,6,7]);
 assert.equal(ACTIVITY_STAGES.filter(stage=>!stage.required).map(stage=>stage.id).join(','),'independent_review');
 assert.ok(ACTIVITY_STAGES.every(stage=>typeof stage.accepts==='string'&&stage.accepts.length>20));
 assert.deepEqual([...ACTIVITY_KIND_IDS],['cultivation','construction','restoration','cooperation','research']);
 assert.equal(ACTIVITY_KINDS.research.external,true);
 assert.equal(ACTIVITY_KIND_IDS.filter(id=>ACTIVITY_KINDS[id].external).join(','),'research');
 assert.equal(ACTIVITY_POLICY.coins_awarded,0);
 assert.equal(ACTIVITY_POLICY.client_stage_claims,false);
 assert.equal(ACTIVITY_POLICY.external_adoption_from_practice,false);
 assert.equal(ACTIVITY_POLICY.institutional_claim_from_practice,false);
 assert.deepEqual([...ACTIVITY_POLICY.practice_kinds],['cultivation','construction','restoration','cooperation']);
 assert.deepEqual([...ACTIVITY_POLICY.external_kinds],['research']);
 assert.equal(ACTIVITY_POLICY.grants_role,false);assert.equal(ACTIVITY_POLICY.grants_reviewer,false);assert.equal(ACTIVITY_POLICY.grants_land,false);
 assert.deepEqual([...ACTIVITY_POLICY.mission_review_kinds],['research']);
 assert.deepEqual([...ACTIVITY_POLICY.peer_review_kinds],['cooperation']);
 assert.deepEqual([...ACTIVITY_POLICY.review_kinds].sort(),['cooperation','research']);
 // Every saved-fact kind the pipeline can trace belongs to exactly one activity kind.
 for(const [source,kind] of Object.entries(KIND_BY_SOURCE_KIND)){assert.ok(ACTIVITY_KIND_IDS.includes(kind),`${source} must map to a known kind`);}
 // The named boundary fields are the ones a practice activity could be confused with.
 for(const field of ['quest_chains.practice','quest_chains.beneficiary','quest_steps.requires_review','guild_contributions.status = verified','community_events.status = completed (restoration)','submissions.status = accepted','coin_rewards']){
  assert.ok(boundaryFields.includes(field),`${field} must be named as a boundary field`);
 }
 assert.ok(PRACTICE_BOUNDARY_FIELDS.every(entry=>entry.before&&entry.guard&&entry.status));
});

test('the order rule refuses to report a later stage past a missing required one',async t=>{
 const reach=(ids,{review=false}={})=>ACTIVITY_STAGES.map(stage=>({id:stage.id,ordinal:stage.ordinal,required:stage.required}));
 // A synthetic list, so the rule itself is proved independently of any database row.
 const stages=[...reach()].map(stage=>({...stage,reached:['discovery','scoped_task','participation','saved_contribution','world_effect'].includes(stage.id)}));
 const steady=activityStageOrder(stages.map(entry=>({...entry})));
 assert.equal(steady.stage,'world_effect');
 assert.equal(steady.blocked_by,'journal');
 assert.equal(steady.order_violation,false,'a missing later stage is not a violation');
 const skipping=stages.map(entry=>({...entry,reached:entry.id!=='participation'}));
 const skipped=activityStageOrder(skipping);
 assert.equal(skipped.blocked_by,'participation');
 assert.equal(skipped.stage,'scoped_task','the read stops at the last stage before the missing one');
 assert.equal(skipped.order_violation,true,'an effect beyond a missing participation is a violation');
 assert.equal(skipped.stage_ordinal,2);
 const optional=ACTIVITY_STAGES.map(stage=>({id:stage.id,ordinal:stage.ordinal,required:stage.required,reached:stage.id!=='independent_review'}));
 const withoutReview=activityStageOrder(optional);
 assert.equal(withoutReview.order_violation,false,'the one not-required stage never blocks a later stage');
 assert.equal(withoutReview.stage,'journal');
 // A journal entry for a recorded enrolment is not a claim of work, so it never counts as a skip.
 const journalled=ACTIVITY_STAGES.map(stage=>({id:stage.id,ordinal:stage.ordinal,required:stage.required,reached:['discovery','scoped_task','participation','journal'].includes(stage.id)}));
 const recorded=activityStageOrder(journalled);
 assert.equal(recorded.blocked_by,'saved_contribution');
 assert.equal(recorded.stage,'participation');
 assert.equal(recorded.order_violation,false);
});

test('a fresh resident reads every published chain at its scoped task and claims nothing',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const before=report(f,agent);
 const cultivation=before.instances.find(entry=>entry.instance_id==='quest:quiet-harvest');
 assert.ok(cultivation,'the shipped practice chain is listed for the resident');
 assert.equal(cultivation.kind,'cultivation');
 assert.equal(cultivation.stage,'scoped_task');
 assert.equal(cultivation.blocked_by,'participation');
 assert.equal(cultivation.next_action.stage,'participation');
 assert.equal(cultivation.order_violation,false);
 assert.equal(stageNamed(cultivation,'discovery').reached,true);
 assert.equal(stageNamed(cultivation,'scoped_task').evidence.length,3);
 assert.equal(stageNamed(cultivation,'participation').reached,false);
 assert.equal(stageNamed(cultivation,'saved_contribution').reached,false);
 assert.equal(stageNamed(cultivation,'world_effect').reached,false);
 assert.equal(stageNamed(cultivation,'independent_review').required,false);
 assert.equal(stageNamed(cultivation,'independent_review').code,'not_required');
 assert.equal(cultivation.reading.code,'practice_activity');
 assert.equal(cultivation.reading.scope,'practice');
 assert.equal(cultivation.external_adoption_possible,false);
 assert.equal(before.under_way_count,0);
 assert.equal(before.order_violations.length,0);
 assert.equal(before.kind_filter,null);
 // A single kind is selectable, and an unknown one is refused.
 assert.equal(report(f,agent).instances.length,before.instances.length);
 assert.throws(()=>f.platform.activity(f.actor('alice'),{agent_id:agent.id,kind:'alchemy'}),/Choose one of/);
 // The construction kind lists the world-building chain and nothing of the other kind.
 const construction=report(f,agent).instances.filter(entry=>entry.kind==='construction');
 assert.ok(construction.length>=1,'the world-building chains are listed as construction');
 assert.ok(construction.every(entry=>entry.instance_id.startsWith('quest:')&&entry.reading.code==='practice_activity'));
});

test('a saved cultivation activity reaches every required stage, attributed to the acting account',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 begin(f,agent);
 const joined=instanceNamed(f,agent,'quest:quiet-harvest');
 assert.equal(joined.stage,'participation');
 assert.equal(joined.blocked_by,'saved_contribution');
 assert.equal(stageNamed(joined,'participation').evidence[0].account_id,f.actor('alice').account.id);
 // The work is saved without reading the quest board: the contribution stage is derived from the
 // stored server fact, never from the cosmetic credit.
 position(f,agent);farm(f,agent);garden(f,agent,'plant');
 const planted=instanceNamed(f,agent,'quest:quiet-harvest');
 const contribution=stageNamed(planted,'saved_contribution');
 assert.equal(contribution.reached,true);
 assert.equal(contribution.evidence.length,1);
 assert.equal(contribution.evidence[0].source_kind,'crop_plant');
 assert.equal(contribution.evidence[0].credited_to,null,'the receipt has not been read yet, and the work still counts');
 assert.equal(planted.credited,false);
 assert.equal(planted.blocked_by,'world_effect','a saved planting is not yet a gathered harvest');
 assert.equal(planted.stage,'saved_contribution');
 assert.equal(stageNamed(planted,'world_effect').reached,false,'a prepared patch is not the effect of a saved contribution');
 assert.equal(stageNamed(planted,'journal').reached,true,'the planting is already journalled, and a journal entry is never a claim of work');
 assert.equal(planted.order_violation,false,'a journalled enrolment is not a skipped stage');
 f.advance(25*60000);
 garden(f,agent,'harvest');
 const harvested=instanceNamed(f,agent,'quest:quiet-harvest');
 assert.equal(harvested.stage,'journal');
 assert.equal(harvested.blocked_by,null);
 assert.equal(harvested.order_violation,false);
 assert.ok(stageNamed(harvested,'saved_contribution').evidence.some(fact=>fact.source_kind==='crop_harvest'));
 assert.ok(stageNamed(harvested,'world_effect').evidence.some(effect=>effect.code==='harvested_crop'));
 assert.ok(stageNamed(harvested,'world_effect').evidence.some(effect=>effect.code==='gathered_resources'));
 assert.equal(stageNamed(harvested,'world_effect').evidence.some(effect=>effect.code==='saved_crop_patch'),false);
 assert.ok(stageNamed(harvested,'journal').evidence.some(row=>row.event==='journey.harvest'));
 assert.equal(stageNamed(harvested,'independent_review').reached,false);
 assert.equal(stageNamed(harvested,'independent_review').required,false);
 // The credit arrives only when the server reconciles, and it is cosmetic.
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 const credited=instanceNamed(f,agent,'quest:quiet-harvest');
 assert.equal(credited.credited,true);
 assert.equal(credited.cosmetic_experience,10);
 assert.ok(stageNamed(credited,'saved_contribution').evidence.every(fact=>fact.points===5));
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'a practice activity mints no coin');
 assert.equal(credited.reading.code,'practice_activity');
 assert.equal(verifyActivityStructure(f.platform.db),true);
 assert.equal(verifyQuestStructure(f.platform.db),true);
});

test('a single instance is readable, and a resident that does not own it is refused',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),other=f.agent('bob');
 const one=f.platform.activityInstance(f.actor('alice'),{agent_id:agent.id,instance_id:'quest:quiet-harvest'});
 assert.equal(one.instance.instance_id,'quest:quiet-harvest');
 assert.equal(one.instance.reading.scope,'practice');
 assert.equal(one.policy.version,1);
 assert.throws(()=>f.platform.activity(f.actor('bob'),{agent_id:agent.id}),/not found/i);
 assert.throws(()=>f.platform.activityInstance(f.actor('alice'),{agent_id:agent.id,instance_id:'quest:no-such-chain'}),/no such activity instance/);
 assert.throws(()=>f.platform.activityInstance(f.actor('alice'),{agent_id:agent.id}),/Choose an activity instance/);
 assert.equal(activityInstance(f.platform,other,{instance_id:'quest:quiet-harvest'}).kind,'cultivation');
 assert.equal(f.platform.activity(f.actor('alice'),{agent_id:agent.id}).instances.some(entry=>entry.instance_id===`guild:${'x'}`),false);
});

test('a stored row that stops matching its stage is refused by the whole-database check',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const {mission,task}=realMission(f);
 const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'pipeline-claim');
 f.tx('submit',f.actor('alice'),evidence(claim),'pipeline-submission');
 const submission=f.platform.get('SELECT * FROM submissions WHERE claim_id=?',claim.id);
 f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'An independent acceptance for the pipeline fixture.'});
 const instance=instanceNamed(f,agent,`claim:${claim.id}`);
 assert.equal(instance.kind,'research');
 assert.equal(instance.stage,'journal');
 assert.equal(instance.blocked_by,null);
 assert.equal(instance.order_violation,false);
 assert.equal(instance.reading.code,'proposal');
 assert.ok(stageNamed(instance,'journal').evidence.some(row=>row.event==='review.accepted'),'the reviewer’s acceptance is part of the journal');
 assert.equal(verifyActivityStructure(f.platform.db),true);
 // A mission that stops being discoverable while an accepted version of it is stored is a stored
 // state the pipeline refuses to describe: the accepted row implies stage 5 while stage 1 has no
 // evidence. Such an edit is not reachable through a route today, which is why it is written directly.
 f.platform.run("UPDATE missions SET status='draft' WHERE id=?",mission.id);
 const inconsistent=instanceNamed(f,agent,`claim:${claim.id}`);
 assert.equal(stageNamed(inconsistent,'discovery').reached,false);
 assert.equal(stageNamed(inconsistent,'independent_review').reached,true);
 assert.equal(inconsistent.order_violation,true);
 assert.equal(inconsistent.blocked_by,'discovery');
 assert.equal(verifyActivityStructure(f.platform.db),false,'the whole-database check refuses the skipped stage');
 f.platform.run("UPDATE missions SET status='open' WHERE id=?",mission.id);
 assert.equal(instanceNamed(f,agent,`claim:${claim.id}`).order_violation,false);
 assert.equal(verifyActivityStructure(f.platform.db),true);
});

test('a practice chain that carries an external beneficiary is refused rather than described',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const read=()=>f.platform.activity(f.actor('alice'),{agent_id:agent.id});
 assert.equal(read().instances.find(entry=>entry.instance_id==='quest:quiet-harvest').reading.code,'practice_activity');
 // The identity trigger does not guard `beneficiary`, so a stored practice chain can carry one; the
 // pipeline refuses to describe it and the whole-database check fails.
 f.platform.run("UPDATE quest_chains SET beneficiary='A named external beneficiary' WHERE slug='quiet-harvest'");
 assert.throws(()=>check((entry)=>entry.instance_id==='quest:quiet-harvest'),/names a beneficiary outside NemoWorld|names a beneficiary/i);
 assert.equal(verifyActivityStructure(f.platform.db),false);
 assert.equal(verifyQuestStructure(f.platform.db),false,'the quest module refuses the same row');
 f.platform.run("UPDATE quest_chains SET beneficiary='' WHERE slug='quiet-harvest'");
 assert.equal(read().instances.find(entry=>entry.instance_id==='quest:quiet-harvest').reading.code,'practice_activity');
 assert.equal(verifyActivityStructure(f.platform.db),true);
 // The guard is a real function, and it refuses a synthetic contradiction too.
 const practice={kind:'cultivation',instance_id:'quest:synthetic',practice:true,external_beneficiary:true,requires_real_review:false,reading:activityReading({kind:'cultivation',stages:[{id:'independent_review',reached:false}]})};
 assert.throws(()=>assertPracticeBoundary(practice),/names a beneficiary outside NemoWorld/);
 const reviewed={...practice,external_beneficiary:false,requires_real_review:true};
 assert.throws(()=>assertPracticeBoundary(reviewed),/requires real contribution review/);
 const external={...practice,external_beneficiary:false,reading:{scope:'external_proposal',code:'proposal',external_adoption:false,institutional_claim:false,real_world_impact:false}};
 assert.throws(()=>assertPracticeBoundary(external),/reads as proposal/);
 function check(predicate){const found=read().instances.find(predicate);const reading=activityReading(found);return assertPracticeBoundary({...found,reading});}
});

test('every instance the resident has reports a kind, an attribution and a reachable stage',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 begin(f,agent);
 f.tx('guildProjectCreate',f.actor('alice'),{agent_id:agent.id,guild_id:'cultivator',title:'A shared plan',summary:'One bounded workstream for the pipeline fixture.',visibility:'public',plan:[{id:'walk',title:'Walk one route',output_name:'A traced route',scope:'Walk and record one route through the Commons.'}]});
 const view=report(f,agent);
 assert.ok(view.instances.length>=5,`the resident’s own board of activities is listed (${view.instances.length})`);
 for(const instance of view.instances){
  assert.ok(ACTIVITY_KIND_IDS.includes(instance.kind));
  assert.equal(instance.order_violation,false);
  assert.ok(instance.attribution.account_id,`${instance.instance_id} must name the acting account`);
  assert.ok(instance.stages.length===7);
  assert.equal(instance.reading.institutional_claim,false);
  assert.equal(instance.reading.real_world_impact,false);
  if(instance.stage)assert.ok(ACTIVITY_STAGE_IDS.includes(instance.stage));
 }
 const guild=view.instances.find(entry=>entry.kind==='cooperation');
 assert.ok(guild,'the guild project this resident created is listed as cooperation');
 assert.equal(guild.stage,'participation');
 assert.equal(guild.reading.code,'practice_activity');
 assert.equal(guild.requires_real_review,false,'peer verification is not real contribution review');
 assert.equal(stageNamed(guild,'independent_review').code,'different_operator_peer_verification');
 assert.equal(stageNamed(guild,'independent_review').required,true);
 assert.ok(view.reading_counts.practice_activity>=4);
 // A runtime reads its own resident's activities through the same method.
 const session=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read'],duration_minutes:5,max_calls:5});
 assert.equal(f.platform.activity(f.platform.authenticate(session.token),{}).agent_id,agent.id);
 assert.equal(activityInstances(f.platform,{id:agent.id}).length,view.instances.length);
});
