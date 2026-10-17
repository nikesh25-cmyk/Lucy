import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,realMission,evidence} from './helpers.js';
import {ACTIVITY_KINDS,ACTIVITY_KIND_IDS,ACTIVITY_POLICY,PRACTICE_BOUNDARY_FIELDS,activityReading,assertPracticeBoundary,verifyActivityStructure} from '../src/activity-pipeline.js';

const catalog=JSON.parse(readFileSync(new URL('../catalog/agriculture-statistics.json',import.meta.url),'utf8'));
const worldBank=catalog.countries.flatMap(country=>country.series).find(entry=>entry.indicator&&entry.raw_file&&entry.sha256);
const position=(f,agent,x=6,y=6)=>f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',`home:${agent.id}`,x,y,agent.id);
const report=(f,agent)=>f.platform.activity(f.actor('alice'),{agent_id:agent.id});
const stagesOf=reached=>[{id:'independent_review',reached}];

test('the reading of an activity is a practice activity, a claim, a proposal or a declaration — never an achievement',async t=>{
 const unreviewed=activityReading({kind:'research',adopted:false,stages:stagesOf(false)});
 assert.equal(unreviewed.scope,'external_proposal');
 assert.equal(unreviewed.code,'unreviewed_claim');
 assert.equal(unreviewed.completed_inside_world,false);
 const proposal=activityReading({kind:'research',adopted:false,stages:stagesOf(true)});
 assert.equal(proposal.code,'proposal');
 assert.equal(proposal.completed_inside_world,true,'the contribution review succeeded inside NemoWorld');
 assert.equal(proposal.real_world_impact,false);
 assert.equal(proposal.institutional_claim,false);
 assert.match(proposal.note,/not as an outcome|reported as a proposal/);
 const declaration=activityReading({kind:'research',adopted:true,stages:stagesOf(true)});
 assert.equal(declaration.code,'recorded_declaration');
 assert.equal(declaration.external_adoption,true,'the mission owner recorded a use of the accepted version');
 assert.equal(declaration.institutional_claim,false);
 assert.equal(declaration.real_world_impact,false);
 assert.match(declaration.note,/not proof of implementation, not an institutional endorsement and not a real-world outcome/);
 // No reading any kind can produce is an achievement, an impact or an endorsement.
 for(const kind of ACTIVITY_KIND_IDS){
  for(const reached of [false,true]){
   for(const adopted of [false,true]){
    const reading=activityReading({kind,adopted,stages:[{id:'independent_review',reached}]});
    assert.equal(/achievement|impact|endorsement/.test(reading.code),false,`${kind} produced ${reading.code}`);
    assert.equal(reading.institutional_claim,false);
    assert.equal(reading.real_world_impact,false);
    if(!ACTIVITY_KINDS[kind].external){
     assert.equal(reading.scope,'practice');
     assert.equal(reading.code,'practice_activity');
     assert.equal(reading.external_adoption,false);
    }
   }
  }
 }
 assert.equal(ACTIVITY_POLICY.external_adoption_from_practice,false);
 assert.equal(ACTIVITY_POLICY.institutional_claim_from_practice,false);
});

test('every field where a practice activity could be read as an external claim is named, and each one exists',async t=>{
 const f=await fixture(t);
 const named=PRACTICE_BOUNDARY_FIELDS.map(entry=>entry.field);
 for(const required of ['quest_chains.practice','quest_chains.beneficiary','quest_steps.requires_review','calling_receipts.points','guild_contributions.status','community_events.status','submissions.status','adoptions','journey_profiles.harvests / crafts and experience.cosmetic','land_stewardships / frontier_blocks','coin_rewards']){
  assert.ok(named.some(field=>field.startsWith(required.split(' ')[0])),`${required} must be named`);
 }
 for(const entry of PRACTICE_BOUNDARY_FIELDS){
  assert.ok(entry.before.length>10&&entry.guard.length>20,`${entry.field} needs a stated before and guard`);
  assert.ok(['already guarded, re-checked here','already guarded, stated here','newly guarded here'].includes(entry.status));
  const match=/^([a-z_]+)(?:\.([a-z_]+))?/.exec(entry.field);
  if(match[2]){
   const columns=f.platform.all(`PRAGMA table_info(${match[1]})`).map(column=>column.name);
   assert.ok(columns.includes(match[2]),`${entry.field} must name a real stored column`);
  }else{
   assert.ok(f.platform.get('SELECT name FROM sqlite_master WHERE name=?',match[1]),`${entry.field} must name a real stored table`);
  }
 }
 assert.equal(named.filter(field=>field.startsWith('guild_contributions')||field.startsWith('community_events')||field.startsWith('adoptions')).length,3,'the three newly guarded fields are named');
});

test('a completed practice activity reads as practice and mints nothing, through its whole pipeline',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:'quiet-harvest'},'separation-join');
 position(f,agent);
 f.tx('build',f.actor('alice'),agent.id,{x:4,y:6,type:'farm'});
 f.tx('gardenAction',f.actor('alice'),{agent_id:agent.id,action:'plant',x:4,y:6,kind:'herbs'});
 f.advance(25*60000);
 f.tx('gardenAction',f.actor('alice'),{agent_id:agent.id,action:'harvest',x:4,y:6});
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 const instance=report(f,agent).instances.find(entry=>entry.instance_id==='quest:quiet-harvest');
 assert.equal(instance.stage,'journal');
 assert.equal(instance.reading.scope,'practice');
 assert.equal(instance.reading.code,'practice_activity');
 assert.equal(instance.reading.external_adoption,false);
 assert.equal(instance.reading.institutional_claim,false);
 assert.equal(instance.reading.real_world_impact,false);
 assert.equal(instance.external_adoption_possible,false);
 assert.equal(instance.subject.practice,true);
 assert.equal(instance.credited,true);
 assert.equal(instance.cosmetic_experience,10);
 // The pipeline's own payload never presents the finished activity as anything external.
 const payload=JSON.stringify(instance);
 for(const forbidden of ['"code":"achievement','"code":"impact','"code":"endorsement','"external_adoption":true','"real_world_impact":true','"institutional_claim":true'])assert.equal(payload.includes(forbidden),false,`${forbidden} must not appear`);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'a practice activity never mints a coin');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n,0,'a practice activity can never be adopted');
 assert.equal(verifyActivityStructure(f.platform.db),true);
 const cleared=activityReading({kind:'cultivation',adopted:false,stages:[{id:'independent_review',reached:false}]});
 assert.equal(cleared.note.includes('game activity'),true);
});

test('an externally scoped research activity reads as a proposal and only its acceptance mints the fixed receipt',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const {task}=realMission(f);
 const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'separation-claim');
 const submitted=f.tx('submit',f.actor('alice'),{claim_id:claim.id,...evidence(claim)},'separation-submission');
 const pending=report(f,agent).instances.find(entry=>entry.instance_id===`claim:${claim.id}`);
 assert.equal(pending.kind,'research');
 assert.equal(pending.scope,'external_proposal');
 assert.equal(pending.reading.code,'unreviewed_claim');
 assert.equal(pending.reading.real_world_impact,false);
 assert.equal(pending.external_adoption_possible,true);
 assert.equal(pending.blocked_by,'independent_review');
 f.tx('review',f.actor('reviewer'),{submission_id:submitted.id,decision:'accepted',reason:'Checked the cited version independently.'});
 const accepted=report(f,agent).instances.find(entry=>entry.instance_id===`claim:${claim.id}`);
 assert.equal(accepted.reading.code,'proposal');
 assert.equal(accepted.reading.real_world_impact,false);
 assert.equal(accepted.reading.institutional_claim,false);
 assert.equal(accepted.reading.external_adoption,false,'a contribution review is not an adoption');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1,'the one accepted real contribution earns the fixed receipt');
 assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n,10);
 const wallets={practice:report(f,agent).instances.filter(entry=>entry.reading.scope==='practice').length,external:report(f,agent).instances.filter(entry=>entry.reading.scope==='external_proposal').length};
 assert.equal(wallets.external,1);
 assert.ok(wallets.practice>=4);
 f.tx('adoption',f.actor('admin'),{submission_id:submitted.id,note:'Cited in the mission register.',evidence:'A recorded statement by the mission owner.'});
 const adopted=report(f,agent).instances.find(entry=>entry.instance_id===`claim:${claim.id}`);
 assert.equal(adopted.reading.code,'recorded_declaration');
 assert.equal(adopted.reading.external_adoption,true);
 assert.equal(adopted.reading.real_world_impact,false,'even a recorded use is not a real-world outcome');
 assert.equal(verifyActivityStructure(f.platform.db),true);
});

test('the separation guard refuses every way a practice activity could be read as an external one',async t=>{
 const base={kind:'cultivation',instance_id:'quest:synthetic',practice:true,external_beneficiary:false,requires_real_review:false,reading:activityReading({kind:'cultivation',stages:[{id:'independent_review',reached:false}]})};
 assert.equal(assertPracticeBoundary(base).code,'practice_activity');
 const refuses=(overrides,pattern)=>assert.throws(()=>assertPracticeBoundary({...base,...overrides}),pattern);
 refuses({external_beneficiary:true},/names a beneficiary outside NemoWorld/);
 refuses({requires_real_review:true},/requires real contribution review/);
 refuses({reading:{...base.reading,scope:'external_proposal',code:'proposal'}},/reads as proposal/);
 refuses({reading:{...base.reading,external_adoption:true}},/externally adopted recommendation/);
 refuses({reading:{...base.reading,institutional_claim:true}},/institutional claim/);
 refuses({reading:{...base.reading,real_world_impact:true}},/real-world outcome/);
 // A non-practice activity is held to the one rule that applies to it.
 assert.equal(assertPracticeBoundary({kind:'research',instance_id:'claim:synthetic',practice:false,reading:activityReading({kind:'research',adopted:false,stages:[{id:'independent_review',reached:true}]})}).code,'proposal');
 assert.throws(()=>assertPracticeBoundary({kind:'research',instance_id:'claim:synthetic',practice:false,reading:{...activityReading({kind:'research',adopted:false,stages:[{id:'independent_review',reached:true}]}),institutional_claim:true}}),/institutional claim/);
});
