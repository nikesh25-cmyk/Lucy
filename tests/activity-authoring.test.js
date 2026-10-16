import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './helpers.js';
import {ACTIVITY_KIND_IDS} from '../src/activity-pipeline.js';
import {ACTIVITY_TASK_FIELDS,AUTHORITY_KINDS,BENEFICIARY_TYPES,VERIFICATION_KINDS,activityTaskCorpus,activityTaskFingerprint,activityTaskRefusals,duplicateActivityTasks,tokenOverlap,validateActivityTask} from '../src/activity-authoring.js';

const catalog=JSON.parse(readFileSync(new URL('../catalog/agriculture-statistics.json',import.meta.url),'utf8'));
const series=catalog.countries.find(country=>country.country_code==='AF').series.find(entry=>entry.indicator==='NV.AGR.TOTL.ZS');
const kindOption={kinds:ACTIVITY_KIND_IDS};
const refusalOf=fn=>{try{fn();return null;}catch(error){return error;}};
// The one authored shape both the tests and the platform use.
const task=(overrides={})=>({
 kind:'cultivation',
 source:'gardening crop_plant',
 scope:'Place a crop patch in your own garden and plant one crop on that exact tile.',
 question:'Which crop was sown on the resident’s own garden patch, and when did the server record it?',
 beneficiary_type:'practice_self',
 outcome:{name:'One saved sowing inside the resident’s own garden',verification:'crop_plant'},
 data_sources:[{kind:'saved_fact',id:'crop_plant'}],
 authority:'operator_session',
 ...overrides});
const rewording={source:'gardening crop_plant soil',scope:'Place a crop bed in your own garden and plant one crop on that exact tile.',question:'What did the ground give the resident this season?'};
const chapterWrite=(overrides={})=>({
 slug:'herb-sowing',title:'The Herb Sowing',route:'gardening',practice:true,
 summary:'Two saved garden facts: one sowing on a patch of your own, then one gathering.',
 narrative:'A short practice chain authored for this fixture. The first step leaves a real sowing in the resident’s own garden and the second gathers it once the server says the crop is ready. Neither step is promised to anyone outside NemoWorld.',
 steps:[
  {slug:'sow',title:'Sow one patch',instructions:'Place a crop patch in your own garden and plant one crop on that exact tile.',output_name:'One planted crop',source_kind:'crop_plant'},
  {slug:'gather',title:'Gather it',instructions:'Harvest the mature crop after the server says it is ready.',output_name:'A gathered crop',source_kind:'crop_harvest',prerequisite:'sow'},
 ],
 ...overrides});

test('the authored task shape is stated, and its vocabulary comes from the existing saved facts',async t=>{
 assert.deepEqual(ACTIVITY_TASK_FIELDS.map(entry=>entry.field),['kind','source','scope','question','beneficiary_type','outcome','data_sources','authority']);
 assert.ok(ACTIVITY_TASK_FIELDS.every(entry=>entry.description&&typeof entry.required==='boolean'));
 assert.deepEqual(BENEFICIARY_TYPES.filter(entry=>entry.external).map(entry=>entry.id),['named_community','public_institution']);
 assert.ok(VERIFICATION_KINDS.includes('crop_plant')&&VERIFICATION_KINDS.includes('frontier_place')&&VERIFICATION_KINDS.includes('research_accepted'));
 assert.ok(VERIFICATION_KINDS.includes('submission_source_version')&&VERIFICATION_KINDS.includes('guild_verification'));
 assert.equal(VERIFICATION_KINDS.includes('community wellbeing'),false);
 assert.ok(AUTHORITY_KINDS.every(entry=>entry.label));
 // The substantive key is task 24's shape over kind, source and scope, and the title is not in it.
 const fingerprint=activityTaskFingerprint(task());
 assert.equal(fingerprint.startsWith('cultivation|'),true);
 assert.equal(fingerprint,activityTaskFingerprint({...task(),title:'A completely different title'}));
 assert.notEqual(fingerprint,activityTaskFingerprint(task({kind:'construction'})));
 assert.notEqual(fingerprint,activityTaskFingerprint(task({source:'gardening crop_harvest'})));
 assert.equal(tokenOverlap('Which crop was sown on the garden patch?','When was the crop sown on the garden patch?'),1,'a reordered question is the same question');
});

test('a duplicate and a near-duplicate task are refused with the collision named',async t=>{
 const f=await fixture(t),reviewer=f.actor('reviewer');
 const authored=f.tx('activityAuthor',reviewer,{task:task(),write:chapterWrite()});
 assert.equal(authored.accepted,true);
 assert.equal(authored.created.status,'draft');
 const corpus=activityTaskCorpus(f.platform);
 assert.ok(corpus.some(entry=>entry.origin.slug==='herb-sowing'),'the created chain is in the corpus');
 assert.ok(corpus.some(entry=>entry.origin.table==='restoration_plan'));
 assert.ok(corpus.every(entry=>entry.kind&&entry.title&&entry.origin&&entry.origin.table));
 // The exact same substantive key is refused as a duplicate, and nothing is written.
 const before=f.platform.get('SELECT COUNT(*) AS n FROM quest_chains').n;
 const duplicate=refusalOf(()=>f.tx('activityAuthor',reviewer,{task:task(),write:chapterWrite({slug:'copy-sowing'})}));
 assert.equal(duplicate.status,409);
 assert.equal(duplicate.code,'duplicate');
 assert.match(duplicate.message,/already exists/i);
 assert.match(duplicate.message,/identical kind, source and scope/);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM quest_chains').n,before,'a refused duplicate writes no chain');
 // The same scope reworded is a near-duplicate, and the refusal names the task it collides with.
 const nearDuplicate=refusalOf(()=>f.platform.activityTaskCheck(reviewer,{task:task(rewording)}));
 assert.equal(nearDuplicate.status,409);
 assert.equal(nearDuplicate.code,'near_duplicate');
 assert.match(nearDuplicate.message,/the same scope reworded/i);
 assert.match(nearDuplicate.message,/The Herb Sowing/,'the refusal names the existing task');
 const enumerated=activityTaskRefusals(task(rewording),{...kindOption,existing:activityTaskCorpus(f.platform),hosts:[]});
 assert.equal(enumerated.length,1);
 assert.equal(enumerated[0].code,'near_duplicate');
 assert.ok(enumerated[0].scope_overlap>=0.8);
 assert.equal(enumerated[0].question_overlap<0.7,true,'the question is genuinely different; the scope is what collides');
 // A corpus question derived from authored content is a step title plus its instructions, so the
 // collision a real chain produces is the scope. A hand-written entry with a well-formed question
 // shows the question branch, which is the one a mission task reaches.
 const questionCollision=refusalOf(()=>validateActivityTask(task(),{...kindOption,hosts:[],existing:[{kind:'cultivation',source:'gardening crop_plant',scope:'A different scope with its own wording entirely.',question:'Which crop was sown on the resident’s own garden patch, and when did the server record it?',title:'A hand-written duplicate'}]}));
 assert.equal(questionCollision.code,'near_duplicate');
 assert.match(questionCollision.message,/the same question/);
 // The same scope with a genuinely different question is the scope collision, named as such.
 const sameScope=refusalOf(()=>f.platform.activityTaskCheck(reviewer,{task:task({source:'gardening crop_plant soil',question:'What did the ground give the resident this season?'})}));
 assert.equal(sameScope.code,'near_duplicate');
 assert.match(sameScope.message,/the same scope/);
 assert.equal(duplicateActivityTasks('x|y|z','cultivation','a question','a scope',[{kind:'cooperation',source:'other',scope:'unrelated'}]).length,0,'a different kind never collides');
 assert.equal(duplicateActivityTasks('x|y|z','cultivation','a question','a scope',[]).length,0);
});

test('a vague task is refused: no beneficiary type, no answerable question, no verifiable outcome',async t=>{
 const f=await fixture(t),reviewer=f.actor('reviewer');
 const check=overrides=>refusalOf(()=>f.platform.activityTaskCheck(reviewer,{task:task(overrides)}));
 const cases=[
  [{beneficiary_type:undefined},/Name a beneficiary type/],
  [{beneficiary_type:'whoever benefits'},/Name a beneficiary type/],
  [{question:'Improve the garden somehow'},/must read as a question/],
  [{question:'Is this the one that it was?'},/at least three content words/],
  [{question:'Is it in the garden or not?'},/at least three content words/],
  [{outcome:undefined},/Name the verified outcome/],
  [{outcome:{name:'A better garden'}},/must be verifiable from something this world records/],
  [{outcome:{name:'A better garden',verification:'community wellbeing'}},/must be verifiable from something this world records/],
  [{outcome:{name:'ok',verification:'crop_plant'}},/Outcome name needs 10/],
  [{source:''},/Task source needs 4/],
  [{scope:'small'},/Task scope needs 10/],
  [{kind:'alchemy'},/Choose an activity kind/],
 ];
 for(const [overrides,pattern] of cases){
  const error=check(overrides);
  assert.ok(error,`${JSON.stringify(overrides)} must be refused`);
  assert.equal(error.status,400,`${JSON.stringify(overrides)} is a vague task, not a conflict`);
  assert.match(error.message,pattern);
 }
 // Only a source-backed research task may name a beneficiary outside NemoWorld.
 const external=check({beneficiary_type:'public_institution'});
 assert.equal(external.status,400);
 assert.match(external.message,/Only a source-backed research task may name a beneficiary outside NemoWorld/);
 // The same shape with the research kind is accepted, and it is the only kind that can be external.
 const research={
  kind:'research',beneficiary_type:'named_community',source:'World Bank WDI agricultural share of GDP',
  scope:'Record the registered national baseline for one indicator.',
  question:'What share of Afghan GDP did agriculture contribute in the latest retained year?',
  outcome:{name:'A cited registered national baseline',verification:'submission_source_version'},
  data_sources:[{kind:'registered_source',id:'api.worldbank.org'}],authority:'independent_reviewer'};
 const accepted=f.platform.activityTaskCheck(reviewer,{task:research});
 assert.equal(accepted.accepted,true);
 assert.equal(accepted.task.practice,false);
 assert.equal(accepted.task.beneficiary_external,true);
 assert.equal(accepted.corpus_size>=5,true);
 assert.equal(accepted.fields.length,ACTIVITY_TASK_FIELDS.length);
 // A refused check writes nothing at all.
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM quest_chains').n,5);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM tasks').n,3);
});

test('an unanswerable task is refused: data no one has, authority no one has, outcome nothing records',async t=>{
 const f=await fixture(t),reviewer=f.actor('reviewer');
 const check=overrides=>refusalOf(()=>f.platform.activityTaskCheck(reviewer,{task:task(overrides)}));
 const many=[{kind:'saved_fact',id:'crop_plant'},{kind:'saved_fact',id:'crop_harvest'},{kind:'saved_fact',id:'craft'},{kind:'saved_fact',id:'frontier_place'},{kind:'saved_fact',id:'path_place'},{kind:'saved_fact',id:'home_furnish'}];
 const cases=[
  [{data_sources:[{kind:'registered_source',id:'tea-board.example.org'}]},/evidence library retains nothing from/],
  [{data_sources:[{kind:'registered_source',id:'example.org'}]},/evidence library retains nothing from/],
  [{data_sources:[{kind:'saved_fact',id:'tea_export_volume'}]},/is not a saved fact this world records/],
  [{data_sources:[{kind:'field_survey',id:'crop_plant'}]},/is not one, so no account in this world holds that data/],
  [{data_sources:[]},/Name one to five data sources/],
  [{data_sources:many},/Name one to five data sources/],
  [{authority:'ministry_of_agriculture'},/Name an authority this world has/],
  [{authority:'the_tea_board'},/requires an authority no one holds/],
 ];
 for(const [overrides,pattern] of cases){
  const error=check(overrides);
  assert.ok(error,`${JSON.stringify(overrides)} must be refused`);
  assert.equal(error.status,400);
  assert.match(error.message,pattern);
 }
 // The registered evidence host the world already retains is data someone actually has.
 const retained=f.platform.activityTaskCheck(reviewer,{task:task({data_sources:[{kind:'registered_source',id:new URL(series.url).hostname},{kind:'saved_fact',id:'crop_plant'}]})});
 assert.equal(retained.accepted,true);
 assert.deepEqual(retained.task.data_sources,[{kind:'registered_source',id:'api.worldbank.org'},{kind:'saved_fact',id:'crop_plant'}]);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM quest_chains').n,5);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM tasks').n,3);
});

test('the validator is callable on its own, and its stated limit is the limit it has',async t=>{
 const f=await fixture(t);
 const existing=activityTaskCorpus(f.platform);
 const first=validateActivityTask(task(),{...kindOption,existing,hosts:[]});
 assert.equal(first.fingerprint,activityTaskFingerprint(first));
 assert.deepEqual(first.refusals,[]);
 assert.equal(first.existing_tasks,existing.length);
 // A paraphrase that shares no content vocabulary with the question it duplicates is NOT caught, and
 // this test states that limit rather than hiding it.
 const paraphrase='What did the ground give the resident this season?';
 const overlap=tokenOverlap(paraphrase,'Which crop was sown on the resident’s own garden patch, and when did the server record it?');
 assert.ok(overlap<0.5,`the paraphrase shares ${overlap.toFixed(2)} of its vocabulary, below the refusal threshold`);
 const accepted=validateActivityTask(task({question:paraphrase,scope:'Copy the patch and the seed into the register.'}),{...kindOption,existing,hosts:[]});
 assert.equal(accepted.question,paraphrase);
 // The same question in different words IS caught, which is what makes the limit a threshold.
 const handWritten=[...existing,{kind:'cultivation',source:'gardening crop_plant',scope:'Place a crop patch in your own garden and plant one crop on that exact tile.',question:'Which crop was sown on the resident’s own garden patch, and when did the server record it?',title:'A hand-written duplicate'}];
 const caught=refusalOf(()=>validateActivityTask(task(),{...kindOption,existing:handWritten,hosts:[]}));
 assert.equal(caught.code,'duplicate');
 assert.equal(caught.status,409);
 const near=refusalOf(()=>validateActivityTask(task({question:'When did the server record the crop sown on the resident’s own garden patch?'}),{...kindOption,existing:handWritten,hosts:[]}));
 assert.ok(['near_duplicate','duplicate'].includes(near.code));
});

test('the authoring front door delegates to the existing writer and never authors a restoration step',async t=>{
 const f=await fixture(t),reviewer=f.actor('reviewer'),alice=f.actor('alice');
 const agent=f.agent('alice');
 const chains=f.platform.get('SELECT COUNT(*) AS n FROM quest_chains').n;
 const authored=f.tx('activityAuthor',reviewer,{task:task(),write:chapterWrite()});
 assert.equal(authored.created.slug,'herb-sowing');
 assert.equal(authored.created.route,'gardening');
 assert.equal(authored.created.practice,true);
 assert.equal(authored.created.beneficiary,'');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM quest_chains').n,chains+1);
 const auditRow=f.platform.get('SELECT record_id FROM audit WHERE event=?','activity.task.authored');
 assert.equal(auditRow.record_id,`cultivation:${authored.fingerprint}`);
 // The world's own cooperative restoration plan is authored content, not operator data.
 const restoration=refusalOf(()=>f.tx('activityAuthor',reviewer,{task:task({kind:'restoration',source:'restoration plan gathering-garden',scope:'Lay the gathering ground in the restored garden.',question:'Which planned tiles of the gathering ground are filled?',outcome:{name:'A placed garden object on its planned tile',verification:'garden_object'},data_sources:[{kind:'saved_fact',id:'garden_object'}]}),write:{}}));
 assert.equal(restoration.status,400);
 assert.match(restoration.message,/authored content, not operator-authored data/);
 // A research task must approve the host it reads from, because the answer is read from that host.
 const researchTask=task({kind:'research',beneficiary_type:'named_community',source:'World Bank WDI agricultural share of GDP',scope:'Record the registered national baseline for one indicator.',question:'What share of Afghan GDP did agriculture contribute in the latest retained year?',outcome:{name:'A cited registered national baseline',verification:'submission_source_version'},data_sources:[{kind:'registered_source',id:'api.worldbank.org'}],authority:'independent_reviewer'});
 const researchWrite={mission_id:'x',title:'Record the registered baseline',instructions:'Read the registered series and record the exact location, rights and uncertainty.',rights:'Public material with attribution.',allowed_domains:['example.org']};
 const missingHost=refusalOf(()=>f.tx('activityAuthor',reviewer,{task:researchTask,write:researchWrite}));
 assert.equal(missingHost.status,400);
 assert.match(missingHost.message,/must approve the host it reads from/);
 assert.match(missingHost.message,/api\.worldbank\.org/);
 // A runtime cannot author through the front door, and an ordinary member cannot either.
 const session=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','contribute'],duration_minutes:5,max_calls:5});
 assert.equal(refusalOf(()=>f.platform.activityTaskCheck(f.platform.authenticate(session.token),{task:task({source:'gardening crop_harvest',scope:'Gather one mature crop the server has confirmed as ready.',question:'Which crop did the resident gather, and on which day was it ready?'})})).status,403);
 const memberTask=task({source:'gardening crop_harvest',scope:'Gather one mature crop the server has confirmed as ready.',question:'Which crop did the resident gather, and on which day was it ready?'});
 assert.equal(refusalOf(()=>f.platform.activityAuthor(alice,{task:memberTask,write:chapterWrite({slug:'alice-sowing'})})).status,403);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM quest_chains').n,chains+1,'a refused author writes nothing');
});
