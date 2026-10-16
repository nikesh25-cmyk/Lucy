// The activity pipeline: one ordered contract that connects world activity to purposeful work, and
// the reader that says where a piece of work actually is.
//
// NemoWorld already stores every half of this path: `src/quests.js` authors and credits scoped tasks,
// `src/vocations.js` records the calling receipts, `src/guilds.js` runs bounded cooperation with
// independent peer verification, `src/community.js` runs the cooperative restoration, and
// `src/platform.js` runs the real mission claim → submission → independent review path with the
// versioned evidence library (`evidence_captures`) behind it. Nothing here replaces any of them and
// nothing here writes one of their rows. The pipeline is the ordered *contract* those modules already
// implement, plus a reader that resolves the stored rows of one activity instance into the stage that
// work has actually reached — and that refuses to describe a stage no stored row supports.
//
// The stage order is fixed and is the same for every kind:
//
//   1 discovery           the activity is listed where a resident can find it
//   2 scoped_task         one bounded task with a named output and a stated source, authored (see
//                         src/activity-authoring.js, which refuses a duplicate, vague or unanswerable
//                         task rather than letting another interchangeable template be written)
//   3 participation       the resident is enrolled, pledged or leased to that exact task
//   4 saved_contribution  one saved, attributed server fact, not a claim about one
//   5 independent_review  only where the scoped task requires it, and only by a different operator
//   6 world_effect        what the saved contribution changed in stored state
//   7 journal             the append-only record of it
//
// Two rules make the order real rather than decorative:
//
//   * A stage is only ever reported as reached when a stored row of the right kind supports it. A
//     client, a model, an operator and an author cannot mark a stage: there is no write route for one.
//   * `verifyActivityStructure` re-checks the order across a whole database and returns false when a
//     stored row implies a later stage while a required earlier stage has no evidence. That is the
//     same shape of check `verifyQuestStructure` and `verifyGuildRecords` already use.
//
// No table, column, trigger or schema version is added: every stage is derived from rows the shipped
// modules already write. Schema stays 25.

import {RESTORATION_PLAN,RESTORATION_ROLES} from './community.js';
import {ACTIVITY_TASK_FIELDS,activityTaskCorpus,validateActivityTask} from './activity-authoring.js';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
// One resident's own view: an operator session owns it, or its own runtime credential reads it.
const owned=(platform,actor,input)=>{
 if(!actor?.account||!['session','runtime'].includes(actor.kind))fail(401,'Sign in or use an owned agent runtime.');
 const agent=platform.ownedAgent(actor,input?.agent_id||actor.agent?.id);
 if(agent.status==='deleted')fail(404,'Resident not found.');
 return agent;
};

// ---- The ordered contract ---------------------------------------------------------------------
// Each stage states what evidence the pipeline accepts for it. `required` is the default, and the
// review stage is the one stage a scoped task may declare it does not need.
export const ACTIVITY_STAGES=Object.freeze([
 Object.freeze({id:'discovery',ordinal:1,label:'Discovered',required:true,
  accepts:'a published quest chain, a visible guild project, the authored restoration plan or an open mission task with an independent reviewer'}),
 Object.freeze({id:'scoped_task',ordinal:2,label:'Scoped task',required:true,
  accepts:'one bounded task with a named output, a stated source and the saved-fact kind that answers it'}),
 Object.freeze({id:'participation',ordinal:3,label:'Participation',required:true,
  accepts:'a quest enrolment, a guild participation, a restoration pledge or a leased claim — a promise, never work'}),
 Object.freeze({id:'saved_contribution',ordinal:4,label:'Saved contribution',required:true,
  accepts:'one saved, attributed server fact: a planted or gathered crop, a placed block, a placed garden object, a submitted contribution or a submitted version with its citations'}),
 Object.freeze({id:'independent_review',ordinal:5,label:'Independent review',required:false,
  accepts:'a review by a different operator: an accepted mission submission, a guild contribution verified by another operator, or an independently accepted quest step. Not required where the scoped task itself claims no review boundary.'}),
 Object.freeze({id:'world_effect',ordinal:6,label:'Visible world effect',required:true,
  accepts:'what the saved contribution actually changed in stored state — a standing block, a placed garden object, a harvested row and the resources it yielded, a verified cooperation record, or an accepted version recorded as a proposal'}),
 Object.freeze({id:'journal',ordinal:7,label:'Journal and history',required:true,
  accepts:'the append-only audit entry, the action ledger row or the contributor history read'}),
]);
export const ACTIVITY_STAGE_IDS=Object.freeze(ACTIVITY_STAGES.map(stage=>stage.id));
const ORDINAL=new Map(ACTIVITY_STAGES.map(stage=>[stage.id,stage.ordinal]));
const STAGE_LABEL=new Map(ACTIVITY_STAGES.map(stage=>[stage.id,stage.label]));

// The activity kinds, and — for each — the scope a reading of it may ever carry. `practice` is the
// whole separation: a practice activity is a game activity inside NemoWorld, and no reading of it can
// be an externally adopted recommendation, an institutional claim or a real-world outcome. The
// research kind is the only one whose reading may be a proposal, and even that is never an outcome.
export const ACTIVITY_KINDS=Object.freeze({
 cultivation:Object.freeze({id:'cultivation',label:'Cultivation',scope:'practice',module:'src/journey.js (the garden), src/quests.js (route gardening)',external:false}),
 construction:Object.freeze({id:'construction',label:'Construction',scope:'practice',module:'src/frontier.js (the finite land registry), src/quests.js (route world_building)',external:false}),
 restoration:Object.freeze({id:'restoration',label:'Cooperative restoration',scope:'practice',module:'src/community.js (the gathering-garden plan), src/spaces.js (the planned placement)',external:false}),
 cooperation:Object.freeze({id:'cooperation',label:'Guild cooperation',scope:'practice',module:'src/guilds.js (bounded cooperative work and peer verification)',external:false}),
 research:Object.freeze({id:'research',label:'Source-backed research',scope:'external_proposal',module:'src/platform.js (claim, submission, independent review), evidence_captures (the versioned library)',external:true}),
});
export const ACTIVITY_KIND_IDS=Object.freeze(Object.keys(ACTIVITY_KINDS));
// Which pipeline kind a saved-fact kind belongs to. Used when a calling receipt is traced back to the
// activity it came from: the receipt names a saved fact, and the fact names the activity.
export const KIND_BY_SOURCE_KIND=Object.freeze({
 frontier_place:'construction',path_place:'construction',frontier_expand:'construction',home_furnish:'construction',
 crop_plant:'cultivation',crop_harvest:'cultivation',craft:'cultivation',
 shared_visit:'cooperation',circle_join:'cooperation',thanks:'cooperation',project_pledge:'cooperation',event_rsvp:'cooperation',
 research_claim:'research',research_accepted:'research',
 garden_object:'restoration',
});
// The one kind whose fifth stage is real contribution review by a different human account. Every other
// kind either claims no review boundary or is verified by a different operator as an in-world peer.
export const ACTIVITY_MISSION_REVIEW_KINDS=Object.freeze(['research']);
export const ACTIVITY_PEER_REVIEW_KINDS=Object.freeze(['cooperation']);
export const ACTIVITY_REVIEW_KINDS=Object.freeze([...ACTIVITY_MISSION_REVIEW_KINDS,...ACTIVITY_PEER_REVIEW_KINDS]);

// The one place the two readings could be confused, named field by field. `before` is what the field
// said before this module; `guard` is what protects it now. A field is listed because a reader could
// previously have taken it for an external claim, a completed outcome or an institutional fact.
export const PRACTICE_BOUNDARY_FIELDS=Object.freeze([
 Object.freeze({field:'quest_chains.practice',before:'a stored 0/1 flag',guard:'the identity trigger keeps it immutable, chainStructureValid re-checks it, and this module refuses to read a practice instance as an external one',status:'already guarded, re-checked here'}),
 Object.freeze({field:'quest_chains.beneficiary',before:'free text, empty for a practice chain',guard:'normalizeQuestSteps refuses a practice chain that names one; assertPracticeBoundary refuses to report a practice instance that carries one',status:'already guarded, re-checked here'}),
 Object.freeze({field:'quest_steps.requires_review',before:'derived from the saved-fact kind',guard:'a practice step may never require review; assertPracticeBoundary refuses a practice instance that requires real contribution review',status:'already guarded, re-checked here'}),
 Object.freeze({field:'calling_receipts.points',before:'five cosmetic experience per saved fact',guard:'QUEST_POLICY.coins_awarded is 0 and no receipt path reaches coin_rewards; the pipeline reports the receipt as cosmetic experience beside a zero coin count',status:'already guarded, stated here'}),
 Object.freeze({field:'guild_contributions.status = verified',before:'GUILD_OUTCOMES.verified reads completed:true',guard:'the label already says community peer verification, not mission review; the pipeline reading never carries it as adopted or as an outcome, only as verified_cooperation inside NemoWorld',status:'newly guarded here'}),
 Object.freeze({field:'community_events.status = completed (restoration)',before:'the plan text says the restored structure stands as the recorded outcome',guard:'the pipeline reading for a restoration instance is practice_activity with real_world_impact:false; the completed event is a stored garden inside NemoWorld, not an external result',status:'newly guarded here'}),
 Object.freeze({field:'submissions.status = accepted',before:'an independent human acceptance',guard:'submissionState already calls acceptance a contribution review, not factual certification; the pipeline reading is proposal, never achievement',status:'already guarded, stated here'}),
 Object.freeze({field:'adoptions.submission_id',before:'a recorded adoption of an accepted version',guard:'the adoption declaration already says it is not proof of implementation, not an institutional endorsement and not a real-world outcome; the pipeline reading is recorded_declaration, with external_adoption read from the stored adoption row and institutional_claim always false',status:'already guarded, stated here'}),
 Object.freeze({field:'journey_profiles.harvests / crafts and experience.cosmetic',before:'progress counters',guard:'no coin, no scope, no role; the pipeline reads a harvested row as a harvested_crop effect inside one garden',status:'already guarded, stated here'}),
 Object.freeze({field:'land_stewardships / frontier_blocks',before:'a stewarded plot and standing blocks',guard:'a plot is finite in-world land, not a real title, and no guild, quest or restoration row grants one; the pipeline reads a standing block as a standing_block effect',status:'already guarded, stated here'}),
 Object.freeze({field:'coin_rewards',before:'the one transferable-looking ledger',guard:'COIN_POLICY.transferable is false and the only path to a receipt is an independent human acceptance of a real scoped contribution; the pipeline awards and reads no coin at all',status:'already guarded, stated here'}),
]);
export const ACTIVITY_POLICY=Object.freeze({
 version:1,
 stages:ACTIVITY_STAGE_IDS,
 kinds:ACTIVITY_KIND_IDS,
 mission_review_kinds:ACTIVITY_MISSION_REVIEW_KINDS,
 peer_review_kinds:ACTIVITY_PEER_REVIEW_KINDS,
 review_kinds:ACTIVITY_REVIEW_KINDS,
 practice_kinds:Object.freeze(ACTIVITY_KIND_IDS.filter(id=>!ACTIVITY_KINDS[id].external)),
 external_kinds:Object.freeze(ACTIVITY_KIND_IDS.filter(id=>ACTIVITY_KINDS[id].external)),
 stage_evidence:'Every stage is read from a stored row of an existing table. There is no route that sets a stage: a client, a model, an operator and an author can each only do the activity, and the server credits the stage from the saved fact.',
 practice_boundary:'A practice activity is structurally incapable of reading as an externally adopted recommendation or an institutional claim: its instance carries no external beneficiary, no real contribution review, no adoption and no coin, and its reading is practice_activity with external_adoption, institutional_claim and real_world_impact all false.',
 client_stage_claims:false,
 external_adoption_from_practice:false,
 institutional_claim_from_practice:false,
 coins_awarded:0,
 grants_role:false,
 grants_land:false,
 grants_reviewer:false,
 description:'The activity pipeline states the ordered stages discovery → scoped task → participation → saved contribution → independent review when required → visible world effect → journal, and derives the reached stage of one activity instance from the rows the world already stores. It writes nothing, grants nothing and awards nothing.',
});

// ---- Reading one instance ---------------------------------------------------------------------
const stageEntry=(id,{reached=false,required=true,evidence=[],code=null,note=''})=>({id,ordinal:ORDINAL.get(id),label:STAGE_LABEL.get(id),reached:Boolean(reached),required:Boolean(required),code,evidence,note});
// The order rule, applied to one instance. A stage counts as satisfied when it is reached or when the
// scoped task did not require it. `stage` is the furthest reached stage that no missing required stage
// precedes, so no later evidence can be reported past a missing earlier stage; `order_violation` is
// exactly that case, and it is what verifyActivityStructure refuses. Exported so the rule itself is
// unit-testable against a synthetic stage list, not only against a database.
// The three stages whose evidence asserts that work actually happened. Discovery, the scoped task and
// the journal are deliberately outside this set: the journal's whole job is to record what happened,
// including the enrolment and the pledge that precede a contribution, so a recorded join is never a
// claim that the work was done. `order_violation` is therefore "evidence of work beyond a missing
// required step of the work", which is the contradiction worth refusing.
export const ACTIVITY_ORDER_CLAIMS=Object.freeze(['participation','saved_contribution','independent_review','world_effect']);
export function activityStageOrder(stages){
 let blocked_by=null;
 for(const entry of stages){
  entry.satisfied=entry.reached||!entry.required;
  if(!entry.satisfied&&!blocked_by)blocked_by=entry.id;
 }
 const order_violation=Boolean(blocked_by)&&stages.some(entry=>entry.reached&&entry.id!==blocked_by&&ACTIVITY_ORDER_CLAIMS.includes(entry.id)&&ORDINAL.get(entry.id)>ORDINAL.get(blocked_by));
 // The reported stage is the furthest stage reached before the first missing required one, so the
 // read is contiguous: a journalled enrolment with no saved contribution reports participation, not
 // journal, and names the contribution as the thing that is actually missing.
 const ceiling=blocked_by?ORDINAL.get(blocked_by)-1:ORDINAL.size;
 const reached=stages.filter(entry=>entry.reached&&entry.ordinal<=ceiling);
 const stage=reached.length?reached[reached.length-1].id:null;
 return{stage,stage_label:stage?STAGE_LABEL.get(stage):'Not started',stage_ordinal:stage?ORDINAL.get(stage):0,
  blocked_by,blocked_by_label:blocked_by?STAGE_LABEL.get(blocked_by):null,order_violation,
  stages_complete:stages.filter(entry=>entry.satisfied).map(entry=>entry.id)};
}
// The reading of an instance: what it is, and what it is not. A practice instance can only read as
// practice_activity. The research kind reads as a claim, a proposal or a recorded declaration — never
// as an achievement and never as an outcome.
export function activityReading(instance){
 const kind=ACTIVITY_KINDS[instance.kind];
 if(!kind)fail(500,`Unknown activity kind ${String(instance.kind)}.`);
 const verified=instance.stages.find(entry=>entry.id==='independent_review')?.reached===true;
 const adopted=Boolean(instance.adopted);
 if(!kind.external)return Object.freeze({scope:'practice',code:'practice_activity',label:'A practice activity inside NemoWorld',
  completed_inside_world:verified,external_adoption:false,institutional_claim:false,real_world_impact:false,
  note:'This is a game activity. It is not an externally adopted recommendation, not an institutional claim and not evidence of any real-world outcome.'});
 return Object.freeze({scope:'external_proposal',code:adopted?'recorded_declaration':verified?'proposal':'unreviewed_claim',
  label:adopted?'A recorded adoption declaration':verified?'An accepted contribution, reported as a proposal':'A contribution awaiting independent review',
  completed_inside_world:verified,external_adoption:adopted,institutional_claim:false,real_world_impact:false,
  note:adopted
   ? 'The mission owner recorded a use of this accepted version. That is a recorded declaration with its own supporting evidence: it is not proof of implementation, not an institutional endorsement and not a real-world outcome.'
   : verified
    ? 'An independent human reviewer accepted this exact version. Acceptance is a contribution review, and the accepted version is reported as a proposal, not as an outcome.'
    : 'No different operator has accepted this version yet. Nothing here is a result.'});
}
// The structural separation guard. A practice instance that carries an external beneficiary, a real
// contribution review boundary, an adoption or an external reading is a contradiction, so it is
// refused rather than described.
export function assertPracticeBoundary(instance){
 const reading=instance.reading;
 if(!instance.practice){
  if(reading.institutional_claim)throw new Error(`Activity ${instance.instance_id} is described as an institutional claim.`);
  return reading;
 }
 const refuse=message=>{throw new Error(`Practice activity ${instance.instance_id} (${instance.kind}): ${message}`);};
 if(instance.external_beneficiary)refuse('it names a beneficiary outside NemoWorld, so it is not a practice activity');
 if(instance.requires_real_review)refuse('it requires real contribution review, so it is not a practice activity');
 if(reading.scope!=='practice'||reading.code!=='practice_activity')refuse(`it reads as ${reading.code}`);
 if(reading.external_adoption)refuse('it reads as an externally adopted recommendation');
 if(reading.institutional_claim)refuse('it reads as an institutional claim');
 if(reading.real_world_impact)refuse('it reads as a real-world outcome');
 return reading;
}
// The reading of a traced claim, built from the same one function so the booleans cannot diverge. A
// practice reading keeps its one code, `practice_activity`, and carries the in-world status of the
// traced row as `world_status`, so a verified contribution can never be read as an external result.
const readingFor=(kind,{reviewReached=false,adopted=false,world_status=null,note=''})=>{
 const base=activityReading({kind,adopted,stages:[{id:'independent_review',reached:reviewReached}]});
 return{...base,...(world_status?{world_status}:{}),...(note?{note}:{})};
};

// ---- Per-kind evidence ------------------------------------------------------------------------
// The audit table is keyed by `seq`, so the pipeline reports that as the journal id rather than
// inventing a second identity for one row.
const audit=(store,accountId,events,sinceMs=0,limit=20)=>store.all(`SELECT seq,event,record_id,created_at FROM audit WHERE actor=? AND event IN (${events.map(()=>'?').join(',')}) ORDER BY seq DESC LIMIT ?`,accountId,...events,limit)
 .filter(row=>Date.parse(row.created_at)>=sinceMs)
 .map(row=>({id:row.seq,event:row.event,record_id:row.record_id,created_at:row.created_at}));
const sourceEvent=(store,receipt)=>store.get('SELECT agent_id,source_kind,source_id,occurred_at FROM calling_source_events WHERE agent_id=? AND source_kind=? AND source_id=?',receipt.agent_id,receipt.source_kind,receipt.source_id)||null;
const receiptSummary=(store,receipt)=>({id:receipt.id,objective_id:receipt.objective_id,source_kind:receipt.source_kind,source_id:receipt.source_id,earned_day:receipt.earned_day,points:receipt.points,proof_hash:receipt.proof_hash,source:sourceEvent(store,receipt)});

// discovery + scoped_task + participation + saved_contribution + review + world_effect + journal for
// one authored quest chain: the cultivation and construction kinds are the same shape over different
// saved-fact routes.
function questInstance(store,kind,chain,agent){
 const steps=store.all('SELECT * FROM quest_steps WHERE chain_id=? ORDER BY ordinal',chain.id);
 const enrolment=store.get('SELECT * FROM quest_enrollments WHERE agent_id=? AND chain_id=?',agent.id,chain.id)||null;
 const receipts=store.all('SELECT * FROM calling_receipts WHERE agent_id=? AND objective_id LIKE ? ORDER BY created_at,id',agent.id,`quest:${chain.slug}.%`)
  .filter(receipt=>receipt.objective_id.startsWith(`quest:${chain.slug}.`));
 const credits=receipts.map(receipt=>receiptSummary(store,receipt));
 const earned=receipts.reduce((total,receipt)=>total+receipt.points,0);
 // The saved facts of this chain's own kinds, read from the same `calling_source_events` view the
 // calling and quest receipt trigger reads. The contribution stage is derived from the stored facts,
 // never from the cosmetic credit: the work is saved whether or not the ten-a-day accounting budget
 // has a point left for it, so no legitimate read order can show an effect without its own saved fact.
 const stepKinds=[...new Set(steps.map(step=>step.source_kind))];
 const allFacts=stepKinds.length?store.all(`SELECT source_kind,source_id,occurred_at,occurred_ms FROM calling_source_events WHERE agent_id=? AND source_kind IN (${stepKinds.map(()=>'?').join(',')}) ORDER BY occurred_ms,source_id`,agent.id,...stepKinds):[];
 // The activity's own time boundary: the enrolment that asked for the work, or — when a resident has
 // left the chain and the enrolment row is gone — the earliest saved fact of this chain's kinds. Every
 // world effect and journal row is measured from it, so a row saved before this activity began is
 // never credited to it.
 const boundary=enrolment?.started_at??(allFacts.length?Math.min(...allFacts.map(fact=>fact.occurred_ms)):Number.POSITIVE_INFINITY);
 const facts=allFacts.filter(fact=>fact.occurred_ms>=boundary);
 const creditOf=fact=>receipts.find(receipt=>receipt.source_kind===fact.source_kind&&receipt.source_id===fact.source_id)||null;
 const reviewStep=steps.find(step=>step.requires_review===1)||null;
 let effects=[];
 let effectCode='standing_block';
 if(kind==='cultivation'){
  effectCode='harvested_crop';
  const harvested=store.all('SELECT x,y,kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND harvested_at IS NOT NULL ORDER BY harvested_at DESC LIMIT 10',agent.id)
   .filter(crop=>crop.harvested_at>=boundary);
  const kinds=[...new Set(harvested.map(crop=>crop.kind))];
  const gathered=kinds.length?store.all(`SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND kind IN (${kinds.map(()=>'?').join(',')})`,agent.id,...kinds):[];
  // The effect is what the saved contribution actually produced: the gathered crop and the resources
  // it yielded. A prepared farm patch is deliberately not listed here — it is ground made ready, not
  // the outcome of a saved fact, and listing it would report an effect without a contribution.
  effects=[
   ...harvested.map(crop=>({code:'harvested_crop',table:'journey_crops',id:`${crop.kind}@${crop.x},${crop.y}`,detail:`A ${crop.kind} crop was gathered from ${crop.x},${crop.y}.`})),
   ...gathered.map(item=>({code:'gathered_resources',table:'journey_inventory',id:item.kind,detail:`The shelf holds ${item.quantity} ${item.kind}.`})),
  ];
 }else{
  const blocks=store.all('SELECT id,x,y,z,type,plot_id,created_at FROM frontier_blocks WHERE creator_agent_id=? ORDER BY created_at DESC,id LIMIT 20',agent.id)
   .filter(block=>Date.parse(block.created_at)>=boundary);
  effects=blocks.map(block=>({code:'standing_block',table:'frontier_blocks',id:block.id,detail:`A ${block.type} block stands at ${block.x},${block.y},z=${block.z}${block.plot_id?` inside ${block.plot_id}`:''}.`}));
 }
 const journal=audit(store,enrolment?.account_id||agent.operator_id,kind==='cultivation'?['journey.plant','journey.tend','journey.harvest','journey.crafted']:['frontier.place','frontier.remove','frontier.expand'],boundary);
 // The construction journal also carries the operator's own build ledger, which is the appended action
 // record frontier building already writes. It is history, not an effect: the standing blocks above
 // are the effect.
 const ledger=kind==='construction'?store.all('SELECT id,action,world_id,created_at FROM frontier_actions WHERE agent_id=? ORDER BY created_at DESC,id LIMIT 20',agent.id).filter(row=>Date.parse(row.created_at)>=boundary):[];
 const stages=[
  stageEntry('discovery',{reached:true,evidence:[{chain_slug:chain.slug,title:chain.title,route:chain.route}],note:'The chain is published and listed in the quest catalogue.'}),
  stageEntry('scoped_task',{reached:steps.length>0,evidence:steps.map(step=>({step_id:step.id,slug:step.slug,title:step.title,output_name:step.output_name,source_kind:step.source_kind,requires_review:Boolean(step.requires_review),target:step.target})),note:'The authored ordered steps are the scoped task.'}),
  stageEntry('participation',{reached:Boolean(enrolment)||facts.length>0,
   evidence:enrolment?[{id:enrolment.id,account_id:enrolment.account_id,started_at:enrolment.started_at}]:[{withdrawn:true,recorded_facts:facts.length,note:'The enrolment was withdrawn; the saved facts of this chain’s own kinds prove the participation happened and stay historical.'}],
   note:'An enrolment is a promise to follow the chain, not work.'}),
  stageEntry('saved_contribution',{reached:facts.length>0,
   evidence:facts.map(fact=>({source_kind:fact.source_kind,source_id:fact.source_id,occurred_at:fact.occurred_at,credited_to:creditOf(fact)?.objective_id||null,points:creditOf(fact)?.points||0})),
   note:'Each entry is a saved server fact of a kind this chain accepts, read from the same source view the receipt trigger reads. A fact the ten-a-day cosmetic budget has not credited yet is still saved work, so the stage reports the work and the credit separately.'}),
  stageEntry('independent_review',{reached:reviewStep?accepted.length>0:false,required:Boolean(reviewStep),
   evidence:credits.filter(credit=>credit.objective_id===`quest:${chain.slug}.${reviewStep?.slug}`),
   code:reviewStep?'independent_human_acceptance':'not_required',
   note:reviewStep?'This chain ends in an independently accepted contribution, so a different authorized operator is required.':'This chain claims no review boundary, so no independent review is required.'}),
  stageEntry('world_effect',{reached:effects.length>0,evidence:effects,code:effectCode,
   note:kind==='cultivation'
    ? 'The harvested crop row and the resources that harvest yielded.'
    : 'The blocks actually standing in stored state.'}),
  stageEntry('journal',{reached:journal.length+ledger.length>0,evidence:[...journal,...ledger.map(row=>({id:row.id,event:`frontier.action.${row.action}`,record_id:row.world_id,created_at:row.created_at}))],note:'The append-only audit record of the saved acts, and for construction the operator’s own build ledger.'}),
 ];
 return finish({kind,instance_id:`quest:${chain.slug}`,title:chain.title,
  subject:{table:'quest_chains',id:chain.id,slug:chain.slug,route:chain.route,origin:chain.origin,status:chain.status,practice:Boolean(chain.practice)},
  practice:Boolean(chain.practice),external_beneficiary:Boolean(chain.practice)&&Boolean(chain.beneficiary),adopted:false,
  credited:credits.length>0,credited_steps:credits.map(credit=>credit.objective_id),cosmetic_experience:earned,
  attribution:{account_id:enrolment?.account_id||agent.operator_id,agent_id:agent.id},stages});
}
// The instance envelope: order, reading, practice guard, and the concrete next thing to do.
function finish(instance){
 const order=activityStageOrder(instance.stages);
 const complete={...instance,...order};
 complete.requires_real_review=ACTIVITY_MISSION_REVIEW_KINDS.includes(instance.kind);
 complete.reading=activityReading(complete);
 assertPracticeBoundary(complete);
 complete.scope=ACTIVITY_KINDS[instance.kind].scope;
 complete.external_adoption_possible=ACTIVITY_KINDS[instance.kind].external;
 complete.next_action=complete.blocked_by?{stage:complete.blocked_by,label:complete.blocked_by_label,instructions:instance.stages.find(entry=>entry.id===complete.blocked_by)?.note||''}:null;
 return complete;
}
function restorationInstance(store,event,agent){
 const site=event.world_id;
 const pledges=store.all('SELECT * FROM community_rsvps WHERE event_id=? ORDER BY created_at',event.id);
 const mine=pledges.find(pledge=>pledge.agent_id===agent.id)||null;
 const prefix=`${event.id}|${agent.id}|`;
 const placed=store.all('SELECT seq AS id,event,record_id,created_at FROM audit WHERE event=? AND substr(record_id,1,?)=? ORDER BY seq','restoration.placed',prefix.length,prefix);
 const objects=placed.map(row=>{
  const [coords,type]=row.record_id.slice(prefix.length).split('|');
  const [x,y]=String(coords||'').split(',').map(Number);
  const stored=store.get('SELECT id,world_id,type,x,y,created_at FROM world_objects WHERE world_id=? AND x=? AND y=?',site,x,y)||null;
  return{audit_id:row.id,record_id:row.record_id,recorded_at:row.created_at,planned:{x,y,type},stored};
 });
 const contributions=store.all("SELECT seq AS id,event,record_id,created_at FROM audit WHERE event='restoration.contributed' AND substr(record_id,1,?)=? ORDER BY seq",`${event.id}|`.length,`${event.id}|`);
 const occurrence=store.get('SELECT id,status,starts_at,ends_at,capacity FROM community_events WHERE id=?',event.id)||{};
 const worked=objects.length+contributions.length>0;
 const stages=[
  stageEntry('discovery',{reached:true,evidence:[{event_id:event.id,world_id:site,plan:RESTORATION_PLAN.slug}],note:'The authored plan and this occurrence are listed together.'}),
  stageEntry('scoped_task',{reached:true,evidence:RESTORATION_PLAN.steps.map(step=>({step_id:step.id,title:step.title,output_name:step.output_name,fact:step.fact,target:step.target,role:RESTORATION_ROLES[step.role].label})),note:'The authored plan steps are fixed content, so every participant reads the same four steps.'}),
  stageEntry('participation',{reached:Boolean(mine)||worked,
   evidence:mine?[{event_id:event.id,agent_id:mine.agent_id,created_at:mine.created_at}]:[{withdrawn:true,saved_work:objects.length+contributions.length,note:'The pledge was withdrawn; the saved work proves the participation happened and stays historical.'}],
   note:'A pledge appears in the participant list and advances no step.'}),
  stageEntry('saved_contribution',{reached:worked,
   evidence:[...objects.map(entry=>({kind:'garden_object',record_id:entry.record_id,recorded_at:entry.recorded_at})),...contributions.map(entry=>({kind:'recorded_contribution',record_id:entry.record_id,recorded_at:entry.created_at}))],
   note:'Each credited step is a saved world object or a saved fact the world already held.'}),
  stageEntry('independent_review',{required:false,code:'not_required',reached:false,note:'The plan names no review boundary: the saved rows themselves are the credit.'}),
  stageEntry('world_effect',{reached:objects.some(entry=>entry.stored),code:'placed_garden_object',
   evidence:objects.map(entry=>({code:entry.stored?'placed_garden_object':'missing_stored_object',record_id:entry.record_id,stored:entry.stored?{id:entry.stored.id,type:entry.stored.type,x:entry.stored.x,y:entry.stored.y}:null})),
   note:'The recorded objects stand in the restored garden’s stored world objects.'}),
  stageEntry('journal',{reached:placed.length+contributions.length>0,evidence:[...placed,...contributions].map(row=>({id:row.id,event:row.event,record_id:row.record_id,created_at:row.created_at})),note:'The append-only audit entry is the record; it is never rewritten.'}),
 ];
 return finish({kind:'restoration',instance_id:`restoration:${event.id}`,title:`${RESTORATION_PLAN.title} in ${site}`,
  subject:{table:'community_events',id:event.id,world_id:site,status:occurrence.status||null,starts_at:occurrence.starts_at||null,ends_at:occurrence.ends_at||null,plan:RESTORATION_PLAN.slug},
  practice:true,external_beneficiary:false,adopted:false,
  attribution:{account_id:agent.operator_id,agent_id:agent.id},stages});
}
function researchInstance(store,claim){
 const task=store.get('SELECT t.*,m.id AS mission_id,m.title AS mission_title,m.area,m.summary AS mission_summary,m.beneficiary,m.reviewer_id,m.owner_id,m.status AS mission_status,m.demo AS mission_demo FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE t.id=?',claim.task_id)||null;
 const submissions=store.all('SELECT * FROM submissions WHERE claim_id=? ORDER BY version,created_at',claim.id);
 const ids=submissions.map(submission=>submission.id);
 const reviews=ids.length?store.all(`SELECT * FROM reviews WHERE submission_id IN (${ids.map(()=>'?').join(',')}) ORDER BY created_at`,...ids):[];
 const adoptions=ids.length?store.all(`SELECT * FROM adoptions WHERE submission_id IN (${ids.map(()=>'?').join(',')}) ORDER BY created_at`,...ids):[];
 const accepted=submissions.filter(submission=>submission.status==='accepted');
 const cited=submissions.flatMap(submission=>store.all('SELECT * FROM submission_evidence WHERE submission_id=? ORDER BY source_number',submission.id).map(cite=>({submission_id:submission.id,version:submission.version,...cite})));
 const captureIds=[...new Set(cited.map(cite=>cite.capture_id).filter(Boolean))];
 const captures=captureIds.length?store.all(`SELECT id,source_key,sha256,retained,retrieved_at,evidence_kind,unit,title,origin FROM evidence_captures WHERE id IN (${captureIds.map(()=>'?').join(',')})`,...captureIds):[];
 const captureById=new Map(captures.map(capture=>[capture.id,capture]));
 const journalRows=store.all("SELECT seq,actor,event,record_id,created_at FROM audit WHERE event IN ('claim.created','submission.created','review.accepted','review.changes_requested','review.rejected','adoption.recorded') ORDER BY seq DESC LIMIT 60");
 // The journal includes the *reviewer's* acceptance, not only the contributor's own rows, so it is
 // scoped by the ids this claim actually owns rather than by one actor.
 const relevant=new Set([claim.id,...ids,...reviews.map(review=>review.id),...adoptions.map(adoption=>adoption.id)]);
 const journal=journalRows.filter(row=>relevant.has(row.record_id)).map(row=>({id:row.seq,event:row.event,record_id:row.record_id,created_at:row.created_at,actor:row.actor}));
 const stages=[
  stageEntry('discovery',{reached:Boolean(task&&task.mission_status!=='draft'),evidence:task?[{mission_id:task.mission_id,mission_title:task.mission_title,area:task.area,demo:Boolean(task.mission_demo),reviewer_id:task.reviewer_id,status:task.mission_status}]:[],note:'The mission task was listed with its independent reviewer. Its mission moves on to leased, under review and accepted as the work proceeds, so this stage records that the task was discoverable rather than that it is still open.'}),
  stageEntry('scoped_task',{reached:Boolean(task),evidence:task?[{task_id:task.id,title:task.title,version:task.version,allowed_domains:JSON.parse(task.allowed_domains||'[]'),rights:task.rights,instructions:task.instructions}]:[],note:'The mission task is the scoped task; its version pins what a submission answers.'}),
  stageEntry('participation',{reached:Boolean(claim),evidence:[{claim_id:claim.id,status:claim.status,task_version:claim.task_version,created_at:claim.created_at}],note:'A lease is a commitment to answer the task, not an answer.'}),
  stageEntry('saved_contribution',{reached:submissions.length>0,code:'submitted_version',evidence:submissions.map(submission=>({submission_id:submission.id,version:submission.version,status:submission.status,created_at:submission.created_at,citations:cited.filter(cite=>cite.submission_id===submission.id).map(cite=>({source_number:cite.source_number,url:cite.url,locator:cite.locator,capture_id:cite.capture_id,capture:captureById.get(cite.capture_id)||null}))})),note:'Each submitted version is pinned to the library capture each citation names.'}),
  stageEntry('independent_review',{reached:reviews.some(review=>review.decision==='accepted'),required:true,evidence:reviews.map(review=>({review_id:review.id,submission_id:review.submission_id,decision:review.decision,reviewer_id:review.reviewer_id,created_at:review.created_at})),code:'independent_human_acceptance',note:'Only a different authorized human account can accept a submitted version.'}),
  stageEntry('world_effect',{reached:accepted.length>0,code:adoptions.length?'recorded_declaration':'proposal',
   evidence:[...accepted.map(submission=>({submission_id:submission.id,version:submission.version,status:submission.status})),...adoptions.map(adoption=>({adoption_id:adoption.id,submission_id:adoption.submission_id,created_at:adoption.created_at}))],
   note:'A source-backed research activity changes no world object. What it produces is a dated, accepted proposal — and, only if the mission owner records one, a recorded adoption declaration. Neither is an outcome.'}),
  stageEntry('journal',{reached:journal.length>0,evidence:journal,note:'The claim, submission, review and adoption rows are the contributor and reviewer history.'}),
 ];
 return finish({kind:'research',instance_id:`claim:${claim.id}`,title:task?task.title:'Mission task',
  subject:{table:'claims',id:claim.id,task_id:claim.task_id,task_version:claim.task_version,mission_id:task?.mission_id||null,account_id:claim.account_id,agent_id:claim.agent_id,status:claim.status},
  practice:false,external_beneficiary:Boolean(task?.beneficiary),adopted:adoptions.length>0,
  attribution:{account_id:claim.account_id,agent_id:claim.agent_id},stages});
}
function cooperationInstance(store,project,agent){
 const plan=(()=>{try{const parsed=JSON.parse(project.plan);return Array.isArray(parsed)?parsed:[];}catch{return[];}})();
 const participant=store.get('SELECT * FROM guild_participants WHERE project_id=? AND agent_id=?',project.id,agent.id)||null;
 const contributions=store.all('SELECT * FROM guild_contributions WHERE project_id=? AND agent_id=? ORDER BY created_at',project.id,agent.id);
 const submitted=contributions.filter(row=>['submitted','verified','changes_requested'].includes(row.status));
 const verified=contributions.filter(row=>row.status==='verified');
 const sources=submitted.flatMap(row=>{try{return JSON.parse(row.sources||'[]').map((source,index)=>({contribution_id:row.id,source_number:index+1,url:source.url,location:source.location}));}catch{return[];}});
 const journal=audit(store,agent.operator_id,['guild.joined','guild.pledged','guild.submitted','guild.verified','guild.contribution.approve','guild.project.created'],0,20).filter(row=>row.record_id===project.id);
 const stages=[
  stageEntry('discovery',{reached:true,evidence:[{project_id:project.id,title:project.title,visibility:project.visibility,status:project.status,guild_id:project.guild_id}],note:'The project is on the guild board where this resident can read it.'}),
  stageEntry('scoped_task',{reached:plan.length>0,evidence:plan.map(workstream=>({workstream_id:workstream.id,title:workstream.title,output_name:workstream.output_name,scope:workstream.scope}))}),
  stageEntry('participation',{reached:Boolean(participant)||contributions.length>0,
   evidence:participant?[{project_id:project.id,agent_id:participant.agent_id,role:participant.role,state:participant.state,joined_at:participant.joined_at}]:[{withdrawn:true,recorded_contributions:contributions.length,note:'The participation was withdrawn; the recorded contributions prove it happened and stay attributed.'}],
   note:'Joining is participation only; it grants no calling, role, plot or reviewer right.'}),
  stageEntry('saved_contribution',{reached:submitted.length>0,evidence:[...contributions.map(row=>({contribution_id:row.id,workstream_id:row.workstream_id,status:row.status,commitment:row.commitment,submitted_at:row.submitted_at})),...sources],note:'A pledge is an intention and a submission is an unverified claim; each cited source is resolved live against the library by traceContribution.'}),
  stageEntry('independent_review',{reached:verified.length>0,required:true,evidence:verified.map(row=>({contribution_id:row.id,verified_by_account_id:row.verified_by_account_id,verified_at:row.verified_at,review_note:row.review_note})),code:'different_operator_peer_verification',note:'Only a different operator’s verification makes a contribution read as complete. It is community peer verification inside NemoWorld, never mission review.'}),
  stageEntry('world_effect',{reached:verified.length>0,code:'recorded_cooperation',
   evidence:verified.map(row=>({contribution_id:row.id,workstream_id:row.workstream_id,verified_at:row.verified_at})),
   note:'A verified cooperation record is a stored record of bounded cooperation inside NemoWorld. It changes no world object and is not an external claim.'}),
  stageEntry('journal',{reached:journal.length>0,evidence:journal.map(row=>({id:row.id,event:row.event,record_id:row.record_id,created_at:row.created_at})),note:'The append-only audit record and the contribution row are the history.'}),
 ];
 return finish({kind:'cooperation',instance_id:`guild:${project.id}`,title:project.title,
  subject:{table:'guild_projects',id:project.id,guild_id:project.guild_id,visibility:project.visibility,status:project.status,creator_agent_id:project.creator_agent_id},
  practice:true,external_beneficiary:false,adopted:false,
  attribution:{account_id:agent.operator_id,agent_id:agent.id},stages});
}

// Every activity instance this resident actually has, discovered by walking the stores that already
// hold its participation. A published chain the resident has not joined is listed too, so an operator
// can tell an available activity apart from one that is under way.
export function activityInstances(store,agent,{kinds=ACTIVITY_KIND_IDS,limit=60}={}){
 // The caller may hold a partial agent row (a runtime credential, a directory payload), so the
 // operator that owns the resident is always re-read here rather than trusted from the argument.
 const resident=store.get('SELECT * FROM agents WHERE id=?',agent?.id)||agent;
 if(!resident?.id||!resident.operator_id)fail(404,'Resident not found.');
 const instances=[];
 if(kinds.includes('cultivation')||kinds.includes('construction')){
  const routes=[];
  if(kinds.includes('cultivation'))routes.push(['cultivation','gardening']);
  if(kinds.includes('construction'))routes.push(['construction','world_building']);
  for(const [kind,route] of routes){
   for(const chain of store.all("SELECT * FROM quest_chains WHERE route=? AND status='published' ORDER BY slug",route)){
    const unjoined=!store.get('SELECT id FROM quest_enrollments WHERE agent_id=? AND chain_id=?',resident.id,chain.id);
    if(unjoined&&instances.filter(instance=>instance.kind===kind).length>=8)continue;
    instances.push(questInstance(store,kind,chain,resident));
   }
  }
 }
 if(kinds.includes('restoration')){
  const worldId=`home:${resident.id}`;
  for(const event of store.all("SELECT * FROM community_events WHERE substr(id,1,?)=? AND (world_id=? OR id IN (SELECT event_id FROM community_rsvps WHERE agent_id=?)) ORDER BY starts_at DESC,id LIMIT ?",'restoration:'.length,'restoration:',worldId,resident.id,8)){
   instances.push(restorationInstance(store,event,resident));
  }
 }
 if(kinds.includes('research')){
  for(const claim of store.all('SELECT * FROM claims WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT 12',resident.operator_id))instances.push(researchInstance(store,claim));
 }
 if(kinds.includes('cooperation')){
  for(const project of store.all('SELECT p.* FROM guild_participants g JOIN guild_projects p ON p.id=g.project_id WHERE g.agent_id=? ORDER BY g.joined_at DESC LIMIT 12',resident.id))instances.push(cooperationInstance(store,project,resident));
 }
 return instances.slice(0,limit);
}
// One instance by its id. A missing instance is an answer, not an error: the caller is asking where a
// piece of work is.
export function activityInstance(store,agent,{kind=null,instance_id=null}={}){
 if(!instance_id)fail(400,'Choose an activity instance.');
 const kinds=kind?(ACTIVITY_KIND_IDS.includes(kind)?[kind]:fail(400,`Choose one of ${ACTIVITY_KIND_IDS.join(', ')}.`)):ACTIVITY_KIND_IDS;
 const match=activityInstances(store,agent,{kinds}).find(instance=>instance.instance_id===instance_id);
 if(!match)fail(404,'This resident has no such activity instance.');
 return match;
}

// ---- The whole-database invariant check ---------------------------------------------------------
// The same shape as verifyQuestStructure: every stored row that implies an activity instance must still
// satisfy the stage order and the practice boundary. Called by the tests and by an operator diagnostic
// read; it writes nothing.
export function verifyActivityStructure(db){
 const store={get:(sql,...args)=>db.prepare(sql).get(...args),all:(sql,...args)=>db.prepare(sql).all(...args)};
 const instances=[];
 try{
  for(const agent of store.all("SELECT * FROM agents WHERE status!='deleted'"))instances.push(...activityInstances(store,agent));
 }catch{return false;}
 for(const instance of instances){
  if(!ACTIVITY_KINDS[instance.kind])return false;
  if(instance.order_violation)return false;
  try{assertPracticeBoundary(instance);}catch{return false;}
  if(ACTIVITY_KINDS[instance.kind].external&&instance.practice)return false;
  if(!ACTIVITY_KINDS[instance.kind].external&&instance.scope!=='practice')return false;
 }
 return true;
}

// ---- Reviewer traceability ---------------------------------------------------------------------
// A reviewer holding a claimed contribution resolves it to the exact stored row, its version, and — for
// a source-backed claim — the library capture its citations are pinned to. The resolver never
// summarises and never accepts a template, and it computes the citation states live from the library
// rather than trusting the stored citation string.
const CLAIM_TABLES=Object.freeze({submission:'submissions',guild_contribution:'guild_contributions',calling_receipt:'calling_receipts',quest_step:'calling_receipts',restoration_placement:'world_objects',frontier_block:'frontier_blocks',guild_project:'guild_projects',mission_task:'tasks'});
export const TRACE_CLAIM_KINDS=Object.freeze(Object.keys(CLAIM_TABLES));
// One citation set resolves only when something in it is a stored version. A claim that cites nothing,
// or cites only links and hashes the library does not hold, is refused with the reason.
function resolveCitations(citations,explicitCaptureId,store){
 if(explicitCaptureId&&!store.get('SELECT id FROM evidence_captures WHERE id=?',explicitCaptureId))fail(404,'That source version is not stored in the evidence library.');
 if(!citations.length)fail(409,'This claim cites nothing, so a reviewer cannot resolve it to a stored row or source version.');
 const pinned=citations.filter(citation=>citation.capture);
 if(explicitCaptureId&&!pinned.some(citation=>citation.capture.id===explicitCaptureId))fail(409,'That stored source version is not pinned by this contribution’s citations. A caller cannot attach unrelated evidence during a trace.');
 if(!pinned.length)fail(409,`None of this claim’s ${citations.length} citation(s) resolve to a stored source version: a link or a contributor-declared hash alone is not evidence.`);
 return{exact_version:true,stored_action:true,citation_count:citations.length,
  pinned_versions:pinned.map(citation=>({capture_id:citation.capture.id,sha256:citation.capture.sha256,retrieved_at:citation.capture.retrieved_at,evidence_kind:citation.capture.evidence_kind,source_key:citation.source_key||null,state:citation.state})),
  unresolved:citations.filter(citation=>!citation.capture).map(citation=>({source_number:citation.source_number,url:citation.url,state:citation.state||null,reason:citation.state_note||'not pinned to a stored version'}))};
}
export function traceContribution(platform,actor,input={}){
 if(!actor?.account)fail(401,'Sign in or use an owned agent runtime.');
 const kind=typeof input.claim_kind==='string'?input.claim_kind:'';
 if(!TRACE_CLAIM_KINDS.includes(kind))fail(400,`Choose one of ${TRACE_CLAIM_KINDS.join(', ')}.`);
 const id=typeof input.claim_id==='string'&&input.claim_id?input.claim_id:'';
 if(!id)fail(400,'A claim must name the stored row it is about: a submission id, a contribution id, a receipt id, a task id or a saved row id.');
 const store={get:(sql,...args)=>platform.get(sql,...args),all:(sql,...args)=>platform.all(sql,...args)};
 const reviewer=actor.kind==='session'&&['admin','reviewer'].includes(actor.account.role);
 const mine=owner=>Boolean(owner)&&owner===actor.account.id;
 const visible=owner=>mine(owner)||reviewer;
 if(kind==='submission'){
  let submission=store.get('SELECT * FROM submissions WHERE id=?',id);
  if(!submission)fail(404,'This claimed contribution is not stored.');
  const claim=store.get('SELECT * FROM claims WHERE id=?',submission.claim_id);
  if(!visible(claim?.account_id))fail(404,'This claimed contribution is not stored.');
  if(input.version_id){
   const version=store.get('SELECT * FROM submissions WHERE id=? AND claim_id=?',input.version_id,submission.claim_id);
   if(!version)fail(404,'That submission version of this claim does not exist.');
   submission=version;
  }
  const task=store.get('SELECT t.id,t.title,t.version,t.instructions,t.rights,t.allowed_domains,m.id AS mission_id,m.title AS mission_title,m.beneficiary FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE t.id=?',claim.task_id)||null;
  const citations=platform.submissionEvidence(submission.id)||[];
  const resolution=resolveCitations(citations,input.capture_id,store);
  const review=store.all('SELECT id,decision,reviewer_id,created_at FROM reviews WHERE submission_id=? ORDER BY created_at',submission.id);
  const adoptions=store.all('SELECT id,owner_id,note,created_at FROM adoptions WHERE submission_id=? ORDER BY created_at',submission.id);
  const accepted=submission.status==='accepted';
  return{claim:{kind,id:submission.id,attribution:{account_id:claim.account_id,agent_id:claim.agent_id},created_at:submission.created_at,status:submission.status},
   action:{table:'submissions',id:submission.id,claim_id:submission.claim_id,task_id:claim.task_id,version:submission.version,status:submission.status,created_at:submission.created_at,artifact_characters:String(submission.artifact||'').length},
   subject:{task_id:task?.id||null,task_version:task?.version||null,mission_id:task?.mission_id||null,mission_title:task?.mission_title||null,beneficiary:task?.beneficiary||null},
   citations,resolution,
   review:{rows:review,independent:review.some(row=>row.reviewer_id!==claim.account_id),adoptions},
   reading:readingFor('research',{reviewReached:accepted,adopted:adoptions.length>0}),
   note:'The claim resolves to one stored submission row at its own version, and each citation to the library capture it is pinned to. An unresolved citation is named rather than summarised away.'};
 }
 if(kind==='guild_contribution'){
  const contribution=store.get('SELECT * FROM guild_contributions WHERE id=?',id);
  if(!contribution)fail(404,'This claimed contribution is not stored.');
  if(!visible(contribution.account_id))fail(404,'This claimed contribution is not stored.');
  const project=store.get('SELECT id,title,plan,guild_id,creator_agent_id,status FROM guild_projects WHERE id=?',contribution.project_id)||null;
  let plan=[];try{plan=JSON.parse(project?.plan||'[]')||[];}catch{plan=[];}
  const workstream=plan.find(item=>item.id===contribution.workstream_id)||null;
  let sources=[];try{sources=JSON.parse(contribution.sources||'[]');}catch{sources=[];}
  if(!sources.length&&!String(contribution.evidence||'').trim())fail(409,'This contribution cites nothing, so no reviewer can resolve it to a stored row or source version. Submit the saved fact or a source first.');
  if(!sources.length)fail(409,'This contribution names no source to resolve, so a reviewer cannot check it against a stored version. Add the source, then ask for verification.');
  const citations=sources.map((source,index)=>platform.resolveCitation({url:source.url,location:source.location||'',date:source.date||''},index+1));
  const resolution=resolveCitations(citations,input.capture_id,store);
  const verified=contribution.status==='verified';
  return{claim:{kind,id:contribution.id,attribution:{account_id:contribution.account_id,agent_id:contribution.agent_id},created_at:contribution.created_at,status:contribution.status},
   action:{table:'guild_contributions',id:contribution.id,project_id:contribution.project_id,workstream_id:contribution.workstream_id,status:contribution.status,commitment:contribution.commitment,submitted_at:contribution.submitted_at,verified_by_account_id:contribution.verified_by_account_id,verified_at:contribution.verified_at},
   subject:{project_id:project?.id||null,project_title:project?.title||null,guild_id:project?.guild_id||null,status:project?.status||null,workstream},citations,resolution,
   review:{rows:contribution.verified_by_account_id?[{decision:contribution.status,reviewer_id:contribution.verified_by_account_id,created_at:contribution.verified_at,note:contribution.review_note}]:[],
    independent:Boolean(contribution.verified_by_account_id&&contribution.verified_by_account_id!==contribution.account_id)},
   reading:readingFor('cooperation',{reviewReached:verified,world_status:verified?'verified_cooperation':'unverified_claim'}),
   note:'The claim resolves to one stored contribution row and its workstream; each source is resolved live against the evidence library.'};
 }
 if(kind==='calling_receipt'||kind==='quest_step'){
  const receipt=store.get('SELECT * FROM calling_receipts WHERE id=?',id);
  if(!receipt)fail(404,'This claimed receipt is not stored.');
  if(!visible(receipt.account_id))fail(404,'This claimed receipt is not stored.');
  const source=sourceEvent(store,receipt);
  if(!source)fail(409,'This receipt cites a saved action that this world does not hold, so it cannot be resolved.');
  return{claim:{kind,id:receipt.id,attribution:{account_id:receipt.account_id,agent_id:receipt.agent_id},created_at:receipt.created_at,status:'recorded'},
   action:{table:'calling_receipts',id:receipt.id,objective_id:receipt.objective_id,source_kind:receipt.source_kind,source_id:receipt.source_id,source_at:receipt.source_at,points:receipt.points,points_kind:'cosmetic_calling_experience',coins:0,proof_hash:receipt.proof_hash},
   subject:{objective_id:receipt.objective_id},citations:[],
   resolution:{exact_version:true,stored_action:true,citation_count:0,pinned_versions:[{table:'calling_source_events',source_kind:source.source_kind,source_id:source.source_id,occurred_at:source.occurred_at}],unresolved:[]},
   review:{rows:[],independent:false},
   reading:readingFor(KIND_BY_SOURCE_KIND[receipt.source_kind]||'cultivation',{reviewReached:receipt.source_kind==='research_accepted'}),
   note:'The receipt resolves to the exact saved server fact it was derived from.'};
 }
 if(kind==='guild_project'){
  const project=store.get('SELECT * FROM guild_projects WHERE id=?',id);
  if(!project)fail(404,'This claimed project is not stored.');
  const creator=store.get('SELECT operator_id FROM agents WHERE id=?',project.creator_agent_id)?.operator_id||'';
  if(!visible(creator))fail(404,'This claimed project is not stored.');
  return{claim:{kind,id:project.id,attribution:{account_id:creator,agent_id:project.creator_agent_id},created_at:project.created_at,status:project.status},
   action:{table:'guild_projects',id:project.id,title:project.title,status:project.status,visibility:project.visibility},
   subject:{plan:project.plan},citations:[],
   resolution:{exact_version:true,stored_action:true,citation_count:0,pinned_versions:[{table:'guild_projects',id:project.id}],unresolved:[]},
   review:{rows:[],independent:false},
   reading:readingFor('cooperation',{}),
   note:'The claim resolves to the stored project row and its plan.'};
 }
 if(kind==='restoration_placement'){
  const row=store.get('SELECT * FROM world_objects WHERE id=?',id);
  if(!row)fail(404,'This claimed saved action is not stored.');
  const suffix=`|${row.x},${row.y}|${row.type}`;
  const recorded=store.all("SELECT seq AS id,actor,event,record_id,created_at FROM audit WHERE event='restoration.placed' AND substr(record_id,-?)=? ORDER BY seq DESC LIMIT 1",suffix.length,suffix);
  if(!recorded.length)fail(409,'This saved object has no recorded restoration placement, so it cannot be resolved to the action that made it.');
  if(!visible(recorded[0].actor))fail(404,'This claimed saved action is not stored.');
  return{claim:{kind,id:row.id,attribution:{account_id:recorded[0].actor,agent_id:String(recorded[0].record_id).split('|')[1]||null},created_at:row.created_at,status:'saved'},
   action:{table:'world_objects',id:row.id,world_id:row.world_id,type:row.type,x:row.x,y:row.y,created_at:row.created_at},
   subject:{world_id:row.world_id,placement:recorded[0].record_id},citations:[],
   resolution:{exact_version:true,stored_action:true,citation_count:0,pinned_versions:[{table:'world_objects',id:row.id},{table:'audit',id:recorded[0].id}],unresolved:[]},
   review:{rows:[],independent:false},reading:readingFor('restoration',{}),
   note:'The claim resolves to the stored world object and to the append-only journal entry that recorded it.'};
 }
 if(kind==='frontier_block'){
  const row=store.get('SELECT * FROM frontier_blocks WHERE id=?',id);
  if(!row)fail(404,'This claimed saved action is not stored.');
  if(!visible(row.creator_account_id))fail(404,'This claimed saved action is not stored.');
  const journal=store.all('SELECT seq AS id,event,record_id,created_at FROM audit WHERE actor=? AND event IN (?,?) ORDER BY seq DESC LIMIT 5',row.creator_account_id,'frontier.place','frontier.remove');
  const ledger=store.all('SELECT id,action,world_id,created_at FROM frontier_actions WHERE account_id=? AND world_id=? ORDER BY created_at DESC LIMIT 5',row.creator_account_id,row.world_id);
  return{claim:{kind,id:row.id,attribution:{account_id:row.creator_account_id,agent_id:row.creator_agent_id},created_at:row.created_at,status:'saved'},
   action:{table:'frontier_blocks',id:row.id,world_id:row.world_id,type:row.type,x:row.x,y:row.y,z:row.z,plot_id:row.plot_id,created_at:row.created_at},
   subject:{world_id:row.world_id,plot_id:row.plot_id},citations:[],
   resolution:{exact_version:true,stored_action:true,citation_count:0,pinned_versions:[{table:'frontier_blocks',id:row.id},...ledger.map(entry=>({table:'frontier_actions',id:entry.id}))],unresolved:[]},
   review:{rows:[],independent:false},reading:readingFor('construction',{}),
   journal:{audit:journal,ledger},
   note:'The claim resolves to the stored block, the operator’s build ledger rows in that world, and the audit entries for that operator. The block row itself carries the attribution.'};
 }
 const task=store.get('SELECT t.*,m.title AS mission_title,m.reviewer_id,m.owner_id,m.beneficiary FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE t.id=?',id);
 if(!task)fail(404,'This claimed task is not stored.');
 if(!visible(task.reviewer_id)&&!mine(task.owner_id))fail(404,'This claimed task is not stored.');
 return{claim:{kind,id:task.id,attribution:{account_id:task.owner_id,agent_id:null},created_at:null,status:task.status},
  action:{table:'tasks',id:task.id,version:task.version,status:task.status,title:task.title,allowed_domains:JSON.parse(task.allowed_domains||'[]')},
  subject:{mission_id:task.mission_id,mission_title:task.mission_title,beneficiary:task.beneficiary},citations:[],
  resolution:{exact_version:true,stored_action:true,citation_count:0,pinned_versions:[{table:'tasks',id:task.id,version:task.version}],unresolved:[]},
  review:{rows:[],independent:false},reading:readingFor('research',{}),
  note:'The claim resolves to the stored task row at its own version. A scoped task is a question, not an answer.'};
}

// ---- Platform methods --------------------------------------------------------------------------
export const activityMethods={
 // The readable stage of every activity this resident has. Nothing is written and nothing is cached:
 // the stage is derived from the stored rows on every read, exactly as the quest board is.
 activity(actor,input={}){
  const agent=owned(this,actor,input);
  const kinds=input.kind?(ACTIVITY_KIND_IDS.includes(input.kind)?[input.kind]:fail(400,`Choose one of ${ACTIVITY_KIND_IDS.join(', ')}.`)):ACTIVITY_KIND_IDS;
  const instances=activityInstances(this,agent,{kinds});
  const underWay=instances.filter(instance=>instance.stages.find(entry=>entry.id==='participation')?.reached);
  return{agent_id:agent.id,kind_filter:kinds.length===ACTIVITY_KIND_IDS.length?null:input.kind,
   pipeline:{stages:ACTIVITY_STAGES.map(stage=>({id:stage.id,ordinal:stage.ordinal,label:stage.label,required:stage.required,accepts:stage.accepts})),kinds:ACTIVITY_KIND_IDS},
   instances,instance_count:instances.length,under_way_count:underWay.length,
   order_violations:instances.filter(instance=>instance.order_violation).map(instance=>instance.instance_id),
   next_action:underWay.find(instance=>instance.next_action)?.next_action||null,
   reading_counts:instances.reduce((counts,instance)=>{counts[instance.reading.code]=(counts[instance.reading.code]||0)+1;return counts;},{}),
   policy:ACTIVITY_POLICY,server_time:this.clock()};
 },
 activityInstance(actor,input={}){
  const agent=owned(this,actor,input);
  return{agent_id:agent.id,instance:activityInstance(this,agent,{kind:input.kind||null,instance_id:input.instance_id||null}),policy:ACTIVITY_POLICY};
 },
 // Reviewer traceability: resolve a claimed contribution to the exact saved action or source version.
 traceContribution(actor,input={}){return traceContribution(this,actor,input);},
 // The authoring front door. It validates the task and then delegates to the module that already owns
 // that kind of write, so there is exactly one writer per kind and no second authoring scheme.
 activityTaskCheck(actor,input={}){
  if(actor?.kind!=='session')fail(403,'Authoring an activity task requires the signed-in human operator session.');
  const existing=activityTaskCorpus(this);
  const task=validateActivityTask(input.task||input,{kinds:ACTIVITY_KIND_IDS,existing,hosts:this.all('SELECT DISTINCT host FROM evidence_sources').map(row=>row.host)});
  return{accepted:true,task,fingerprint:task.fingerprint,corpus_size:existing.length,fields:ACTIVITY_TASK_FIELDS};
 },
 activityAuthor(actor,input={}){
  this.active();
  const existing=activityTaskCorpus(this);
  const hosts=this.all('SELECT DISTINCT host FROM evidence_sources').map(row=>row.host);
  const task=validateActivityTask(input.task||input,{kinds:ACTIVITY_KIND_IDS,existing,hosts});
  const write=input.write||{};
  let created;
  if(task.kind==='cultivation'||task.kind==='construction'){
   created=this.questAuthor(actor,{...write,route:task.kind==='cultivation'?'gardening':'world_building',practice:true,beneficiary:''});
  }else if(task.kind==='cooperation'){
   created=this.guildProjectCreate(actor,write);
  }else if(task.kind==='research'){
   const domains=Array.isArray(write.allowed_domains)?write.allowed_domains:[];
   for(const source of task.data_sources){
    if(source.kind!=='registered_source')continue;
    const host=source.id.toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'');
    if(!domains.map(value=>String(value).toLowerCase()).includes(host))fail(400,`The scoped task must approve the host it reads from: add \`${host}\` to allowed_domains. An answer that reads from an unapproved host cannot be delivered.`);
   }
   created=this.createTask(actor,{...write,title:write.title||task.question.slice(0,100)});
  }else{
   fail(400,'The cooperative restoration plan is authored content, not operator-authored data: its four steps are fixed by the world so every participant reads the same plan. Point a restoration activity at the plan’s own steps instead of authoring a second one.');
  }
  this.audit(actor.account.id,'activity.task.authored',`${task.kind}:${task.fingerprint}`);
  return{accepted:true,task,fingerprint:task.fingerprint,created};
 },
};
