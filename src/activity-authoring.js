// Authoring rules for one scoped activity task: the validation that refuses a duplicate, a vague and
// an unanswerable task instead of allowing another interchangeable template to be authored.
//
// The dedupe thinking is the one `docs/handoff/task-24-proposal-generator.md` established for the
// country research generator: two candidates are the same task when they share the same *substantive
// key*, and the key is built from the concern, the subject and the scope rather than from the title.
// Task 24's key was `<concern>|<theme-or-goal>|<country_code>`. This module's key is
// `<kind>|<source_key>|<scope_key>`, and the near-duplicate rule below compares the normalised
// question and scope vocabularies so a reworded copy of the same question is refused too. There is
// deliberately no second scheme and no template catalogue here.
//
// The three rules, exactly as they behave:
//
//   duplicate        the candidate's fingerprint equals an existing task's fingerprint. Refused 409.
//                    The fingerprint is `kind|source_key|scope_key`, each normalised (lower case,
//                    punctuation removed, light stemming, stopwords dropped, tokens sorted).
//   vague            no beneficiary type, no answerable question, or no verifiable outcome. Refused
//                    400 with the one missing thing named.
//   unanswerable     the task needs data this world does not hold, needs an authority no account in
//                    this world has, or states an outcome nothing observable records. Refused 400.
//
// What these rules do NOT catch is stated in docs/ACTIVITY_PIPELINE.md and summarised in the refusal
// codes: a paraphrase that shares no vocabulary with an existing task, a task that duplicates one in
// a store this corpus does not walk, a duplicate across two different kinds, and a task whose
// declared source is honest text but whose real question is trivial.

import {QUEST_SOURCE_KINDS} from './quests.js';
import {RESTORATION_FACTS,RESTORATION_PLAN} from './community.js';

const fail=(status,message,code)=>{throw Object.assign(new Error(message),{status,code});};
const text=(value,label,minimum,maximum)=>{
 if(typeof value!=='string')fail(400,`${label} must be text.`,'vague');
 const trimmed=value.trim();
 if(trimmed.length<minimum||trimmed.length>maximum)fail(400,`${label} needs ${minimum}–${maximum} characters.`,'vague');
 return trimmed;
};

// The declared shape of one authored activity task. Every field is required except `authority`, which
// defaults to `none`, and `notes`.
export const ACTIVITY_TASK_FIELDS=Object.freeze([
 Object.freeze({field:'kind',required:true,description:'One activity kind: cultivation, construction, restoration, research or cooperation.'}),
 Object.freeze({field:'source',required:true,description:'What the task is about: a saved-fact kind, a registered source route or the world subject. This is the source half of the fingerprint.'}),
 Object.freeze({field:'scope',required:true,description:'The bounded scope: what inside that source this task answers, and what it does not reach.'}),
 Object.freeze({field:'question',required:true,description:'One answerable question. It must read as a question and carry at least three content words.'}),
 Object.freeze({field:'beneficiary_type',required:true,description:'Who the answer is for. A practice kind may only name a beneficiary inside NemoWorld.'}),
 Object.freeze({field:'outcome',required:true,description:'{name, verification}: the verified outcome and the saved-fact kind or source route that answers it.'}),
 Object.freeze({field:'data_sources',required:true,description:'1–5 things the answer must be read from: a saved-fact kind this world records, or a host the evidence library already retains.'}),
 Object.freeze({field:'authority',required:false,description:'Who may answer it, one of the listed authorities. Anything else is refused as unanswerable.'}),
]);
// A beneficiary inside NemoWorld is practice. A beneficiary outside it is what makes a task a real,
// externally-scoped one, and only the research kind may name one.
export const BENEFICIARY_TYPES=Object.freeze([
 Object.freeze({id:'practice_self',label:'The resident’s own world record',external:false}),
 Object.freeze({id:'named_resident',label:'A named resident or circle inside NemoWorld',external:false}),
 Object.freeze({id:'world_register',label:'A shared map, register or garden inside NemoWorld',external:false}),
 Object.freeze({id:'named_community',label:'A named community with its own stated consent',external:true}),
 Object.freeze({id:'public_institution',label:'A named public institution',external:true}),
]);
// The vocabulary the world can actually answer with: the saved-fact kinds the calling and quest
// receipt trigger already verifies, the restoration plan's own facts, a pinned evidence-library
// version, and an independent peer verification. An outcome outside this vocabulary is not
// observable, so the task that states it is refused.
export const VERIFICATION_KINDS=Object.freeze([...QUEST_SOURCE_KINDS,...Object.keys(RESTORATION_FACTS),'submission_source_version','guild_verification']);
// Who may answer. Anything outside this list is an authority no account in this world has.
export const AUTHORITY_KINDS=Object.freeze([
 Object.freeze({id:'none',label:'Anyone with a resident'}),
 Object.freeze({id:'operator_session',label:'The signed-in human operator of the resident'}),
 Object.freeze({id:'independent_reviewer',label:'A different authorized human reviewer account'}),
 Object.freeze({id:'land_steward',label:'The operator that stewards the named plot'}),
 Object.freeze({id:'restoration_convenor',label:'The operator whose garden a restoration was opened on'}),
 Object.freeze({id:'circle_organiser',label:'The operator that keeps the named circle'}),
 Object.freeze({id:'admin',label:'An administrator of this installation'}),
]);
const STOPWORDS=new Set(['a','about','all','also','an','and','another','any','are','as','at','be','been','before','between','both','but','by','can','did','do','does','each','every','few','for','from','had','has','have','how','however','in','into','is','it','its','just','many','may','might','more','most','much','must','not','of','on','only','or','other','our','over','per','same','several','shall','should','so','some','such','than','that','the','their','them','then','there','these','those','this','to','under','up','was','were','what','when','where','whether','which','while','who','whom','why','will','with','within','without','would','yet','you','your']);
// A light, stated stemming rule: a trailing plural or `ed`/`ing` is dropped when at least four
// characters remain. `exported` and `export` therefore normalise together, which is what makes a
// reworded question comparable at all. It is deliberately crude and deliberately documented: it makes
// near-duplicates comparable, and it never claims to understand meaning.
const stem=token=>{
 for(const suffix of ['ing','ed','es','s'])if(token.length-suffix.length>=4&&token.endsWith(suffix))return token.slice(0,-suffix.length);
 return token;
};
export const activityTokens=value=>[...new Set(String(value||'').toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/[\s-]+/).filter(token=>token&&!STOPWORDS.has(token)).map(stem))].sort();
export function tokenOverlap(left,right){
 const a=activityTokens(left),b=activityTokens(right);
 if(!a.length||!b.length)return 0;
 const shared=a.filter(token=>b.includes(token)).length;
 return shared/(a.length+b.length-shared);
}
// The substantive key, in the shape task 24 used: concern, subject, scope — here kind, source, scope.
export function activityTaskFingerprint(task){
 const kind=String(task?.kind||'').trim().toLowerCase();
 const source=activityTokens(task?.source).join('-')||String(task?.source||'').trim().toLowerCase();
 const scope=activityTokens(task?.scope).join('-');
 return `${kind}|${source}|${scope}`;
}
const questionsRead=value=>/\?/.test(value)||/^(how|what|which|when|where|who|why|is|are|does|do|can)\b/i.test(value.trim());

// Every existing task this world can compare against, read from the stores that already hold them.
// A stored row has no authoring form, so its question is derived from its own title, summary and
// scope text: the corpus is best-effort, and that limit is stated in the handoff.
export function activityTaskCorpus(platform){
 if(!platform?.all)fail(500,'The task corpus needs a readable platform.','internal');
 const entries=[];
 for(const chain of platform.all('SELECT c.*,s.slug AS step_slug,s.title AS step_title,s.instructions AS step_instructions,s.output_name AS step_output,s.source_kind FROM quest_chains c LEFT JOIN quest_steps s ON s.chain_id=c.id ORDER BY c.slug,s.ordinal')){
  const kind=chain.route==='gardening'?'cultivation':chain.route==='world_building'?'construction':'research';
  entries.push({kind,origin:{table:'quest_chains',id:chain.id,slug:chain.slug,step_slug:chain.step_slug||null},
   title:chain.step_title?`${chain.title} · ${chain.step_title}`:chain.title,
   source:chain.step_slug?`${chain.route} ${chain.source_kind}`:`${chain.route} quest chain`,
   scope:chain.step_instructions||chain.summary,
   question:`${chain.step_title||chain.title}. ${chain.step_instructions||''}`,
   status:chain.status,beneficiary:chain.beneficiary,practice:Boolean(chain.practice)});
 }
 for(const row of platform.all('SELECT p.id,p.guild_id,p.title AS project_title,p.status,g.value AS workstream FROM guild_projects p JOIN json_each(p.plan) AS g ORDER BY p.id')){
  let workstream=null;
  try{workstream=JSON.parse(row.workstream);}catch{continue;}
  if(!workstream||typeof workstream!=='object'||!workstream.id)continue;
  entries.push({kind:'cooperation',origin:{table:'guild_projects',id:row.id,workstream_id:workstream.id},title:`${row.project_title} · ${workstream.title}`,source:`guild ${row.guild_id}`,scope:workstream.scope,question:`${workstream.title}. ${workstream.scope||''}`,status:row.status,beneficiary:'',practice:true});
 }
 for(const task of platform.all('SELECT t.*,m.title AS mission_title,m.beneficiary,m.status AS mission_status FROM tasks t JOIN missions m ON m.id=t.mission_id ORDER BY t.id')){
  entries.push({kind:'research',origin:{table:'tasks',id:task.id,mission_id:task.mission_id},title:task.title,source:`mission task ${task.mission_id}`,scope:task.instructions,question:`${task.title}. ${task.instructions}`,status:task.mission_status,beneficiary:task.beneficiary,practice:Boolean(task.demo)});
 }
 for(const step of RESTORATION_PLAN.steps){
  entries.push({kind:'restoration',origin:{table:'restoration_plan',id:step.id},title:step.title,source:`restoration plan ${RESTORATION_PLAN.slug}`,scope:step.instructions,question:`${step.title}. ${step.instructions}`,status:'authored',beneficiary:'',practice:true});
 }
 return entries;
}
// The duplicate comparison, returned as a list so a caller can show every collision rather than only
// the first. An exact fingerprint match is a duplicate; a same-kind question or scope that shares
// enough vocabulary is a near-duplicate, and both name the existing task they collide with.
export function duplicateActivityTasks(fingerprint,kind,question,scope,existing){
 const collisions=[];
 for(const entry of existing||[]){
  if(!entry)continue;
  if(activityTaskFingerprint(entry)===fingerprint){collisions.push({code:'duplicate',match:entry,reason:'identical kind, source and scope'});continue;}
  if(entry.kind!==kind)continue;
  const question_overlap=tokenOverlap(question,entry.question||'');
  const scope_overlap=tokenOverlap(scope,entry.scope||'');
  if(question_overlap>=0.7)collisions.push({code:'near_duplicate',match:entry,reason:question_overlap===1?'the same question':`the same question reworded (${Math.round(question_overlap*100)}% shared content words)`,question_overlap,scope_overlap});
  else if(scope_overlap>=0.8)collisions.push({code:'near_duplicate',match:entry,reason:scope_overlap===1?'the same scope':`the same scope reworded (${Math.round(scope_overlap*100)}% shared content words)`,question_overlap,scope_overlap});
 }
 return collisions;
}
// The normalised, validated task. Every refusal names the one thing that failed.
export function normalizeActivityTask(task,{kinds}={}){
 if(!task||typeof task!=='object'||Array.isArray(task))fail(400,'Provide an activity task object.','vague');
 const kind=String(task.kind||'').trim().toLowerCase();
 if(!Array.isArray(kinds)||!kinds.includes(kind))fail(400,`Choose an activity kind: ${(kinds||[]).join(', ')}.`,'vague');
 const source=text(task.source,'Task source',4,200);
 const scope=text(task.scope,'Task scope',10,600);
 const question=text(task.question,'Task question',20,400);
 if(!questionsRead(question))fail(400,'A task question must read as a question: end it with a question mark or open it with a question word.','vague');
 if(activityTokens(question).length<3)fail(400,'A task question needs at least three content words, so a placeholder is refused.','vague');
 const beneficiary=BENEFICIARY_TYPES.find(entry=>entry.id===String(task.beneficiary_type||''));
 if(!beneficiary)fail(400,`Name a beneficiary type: ${BENEFICIARY_TYPES.map(entry=>entry.id).join(', ')}.`,'vague');
 if(kind!=='research'&&beneficiary.external)fail(400,`Only a source-backed research task may name a beneficiary outside NemoWorld; a ${kind} task is practice.`,'vague');
 const outcome=task.outcome;
 if(!outcome||typeof outcome!=='object'||Array.isArray(outcome))fail(400,'Name the verified outcome: {name, verification}.','vague');
 const outcomeName=text(outcome.name,'Outcome name',10,200);
 const verification=String(outcome.verification||'').trim();
 if(!VERIFICATION_KINDS.includes(verification))fail(400,`An outcome must be verifiable from something this world records: choose one of ${VERIFICATION_KINDS.join(', ')}. A claim with no observable outcome is refused.`,'vague');
 const declared=Array.isArray(task.data_sources)?task.data_sources:[];
 if(!declared.length||declared.length>5)fail(400,'Name one to five data sources the answer is read from.','unanswerable');
 const dataSources=declared.map(entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))fail(400,'Each data source must be {kind, id}.','unanswerable');
  const dataKind=String(entry.kind||'').trim();
  const id=String(entry.id||'').trim();
  if(!['saved_fact','registered_source'].includes(dataKind))fail(400,`A data source must be a saved fact this world records or a host the evidence library already retains; \`${dataKind||'unspecified'}\` is not one, so no account in this world holds that data.`,'unanswerable');
  if(!id)fail(400,'Each data source needs its saved-fact kind or its registered host.','unanswerable');
  return{kind:dataKind,id};
 });
 const authorityId=task.authority===undefined||task.authority===null||task.authority===''?'none':String(task.authority).trim();
 const authority=AUTHORITY_KINDS.find(entry=>entry.id===authorityId);
 if(!authority)fail(400,`Name an authority this world has: ${AUTHORITY_KINDS.map(entry=>entry.id).join(', ')}. \`${authorityId}\` is not one, so the task requires an authority no one holds and cannot be answered.`,'unanswerable');
 return{kind,source,scope,question,beneficiary_type:beneficiary.id,beneficiary_external:beneficiary.external,outcome:{name:outcomeName,verification},data_sources:dataSources,authority:authority.id,
  practice:kind!=='research'};
}
// The unanswerable half that needs the database: a declared data source must resolve to a saved-fact
// kind this world records, or to a host the evidence library already retains. Nothing else is data
// anyone here has, so it is refused before the task is stored.
function dataRefusals(task,hosts){
 const refusals=[];
 for(const entry of task.data_sources){
  if(entry.kind==='saved_fact'){
   if(!VERIFICATION_KINDS.includes(entry.id))refusals.push({code:'unanswerable',message:`\`${entry.id}\` is not a saved fact this world records, so no resident can produce it. Known kinds: ${VERIFICATION_KINDS.join(', ')}.`});
   continue;
  }
  const host=entry.id.toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'');
  if(!Array.isArray(hosts)||!hosts.map(value=>String(value).toLowerCase()).includes(host))refusals.push({code:'unanswerable',message:`The evidence library retains nothing from \`${entry.id}\`, and an operator typing a URL is not a source. Capture the source through an approved task, or name a saved fact.`});
 }
 return refusals;
}
// Every refusal for one candidate, in rule order, so a caller can show them all. `validateActivityTask`
// refuses the first one; this is the enumeration the tests use.
export function activityTaskRefusals(task,{kinds,existing=[],hosts=[]}={}){
 const refusals=[];
 let normalized;
 try{normalized=normalizeActivityTask(task,{kinds});}
 catch(error){return[{code:error.code||'vague',message:error.message}];}
 refusals.push(...dataRefusals(normalized,hosts));
 const fingerprint=activityTaskFingerprint(normalized);
 for(const collision of duplicateActivityTasks(fingerprint,normalized.kind,normalized.question,normalized.scope,existing)){
  refusals.push({code:collision.code,message:`This task already exists (${collision.reason}): ${collision.match.title||collision.match.question||collision.match.origin?.id} in ${collision.match.origin?.table||'the corpus'}. Author the question that is actually missing, or record the existing task as the one that answers it.`,match:collision.match,question_overlap:collision.question_overlap??null,scope_overlap:collision.scope_overlap??null});
 }
 return refusals;
}
// The one callable validator. It returns the normalised task with its fingerprint, or refuses with a
// reason: 409 for a duplicate or near-duplicate, 400 for a vague or unanswerable task.
export function validateActivityTask(task,{kinds,existing=[],hosts=[]}={}){
 const refusals=activityTaskRefusals(task,{kinds,existing,hosts});
 if(refusals.length){
  const first=refusals[0];
  fail(first.code==='duplicate'||first.code==='near_duplicate'?409:400,first.message,first.code);
 }
 const normalized=normalizeActivityTask(task,{kinds});
 return{...normalized,fingerprint:activityTaskFingerprint(normalized),refusals:[],existing_tasks:existing.length};
}
