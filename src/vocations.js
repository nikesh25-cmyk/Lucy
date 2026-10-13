import {randomUUID,createHash} from 'node:crypto';
import {contributionSource,contributionEligibility} from './journey.js';
import {getWorldDefinition,walkable} from '../world.js';
import {receiptProof,questObjectiveRules,reconcileQuests,questStepFor} from './quests.js';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const objective=(kind,title,instructions,action)=>Object.freeze({id:kind,source_kind:kind,title,instructions,action_hint:action,target:1,experience:5});
const calling=(id,name,guild,purpose,objectives)=>Object.freeze({id,name,guild_name:guild,purpose,charter:'Offer peaceful help, respect other residents and human decisions, preserve shared access, and credit evidence honestly. A calling grants no account role or action permission.',objectives:Object.freeze(objectives)});
export const CALLINGS=Object.freeze([
 calling('explorer','Explorer','Wayfarers','Discover shared places and introduce yourself to their communities.',[objective('shared_visit','Discover a shared place','Walk into a shared place you have not previously visited. Looking at its map does not count.','travel'),objective('circle_join','Join a neighbor’s circle','Join an active circle created by another operator. Membership is participation, not proof of a project outcome.','circle')]),
 calling('builder','Builder','Peaceful Builders','Make welcoming, accessible places with saved construction.',[objective('frontier_place','Place a saved frontier block','Build a permitted block inside your operator’s assigned plot. Keep shared passages and residents clear.','build_block'),objective('home_furnish','Furnish your own home','Place an allowed object in your own garden or cottage. Existing furniture from before this calling does not count.','build')]),
 calling('cultivator','Cultivator','Living Gardens','Care for growing plants and turn patience into useful resources.',[objective('crop_plant','Plant a garden crop','Plant a crop on an owned farm patch through the garden controls.','garden'),objective('crop_harvest','Harvest a mature crop','Wait for a planted crop to mature, then harvest it. The server checks its growth time.','garden')]),
 calling('researcher','Researcher','Evidence Keepers','Build knowledge that can withstand independent inspection.',[objective('research_claim','Claim a scoped real task','Claim an open real mission task with a beneficiary and independent reviewer. Practice tasks do not count.','claim'),objective('research_accepted','Earn independent acceptance','Submit sourced work on the scoped task and wait for an independent human reviewer. You cannot approve it yourself.','await_review')]),
 calling('steward','Steward','Common Ground','Keep a finite world connected and welcoming.',[objective('frontier_expand','Open an adjacent area','Walk to an unopened frontier passage and open the existing neighboring area inside the finite perimeter.','expand'),objective('path_place','Save a path in your plot','Place a ground path inside the plot your operator stewards. It must be an actual saved placement.','build_block')]),
 calling('mediator','Mediator','Kindred Circle','Offer specific appreciation and make cooperative commitments.',[objective('thanks','Offer specific thanks','Thank a resident controlled by a different operator for a specific contribution. This records appreciation, not a verified external outcome.','thanks'),objective('project_pledge','Join a cooperative project','Pledge a clear contribution to another operator’s active project. A promise is not completed work.','pledge')]),
 calling('artisan','Artisan','Makers’ Hearth','Create useful keepsakes and thoughtful home spaces.',[objective('craft','Craft a keepsake','Use resources earned through gardening to craft a supported recipe. The server checks the ingredients.','craft'),objective('home_furnish','Place a home object','Place an allowed saved object in your own garden or cottage.','build')]),
 calling('host','Host','Open Hearth','Welcome neighbors by joining their shared invitations and communities.',[objective('event_rsvp','Pledge to join a neighbor’s gathering','Reserve a place at a future gathering created by another operator. An RSVP is an attendance pledge, not proof of attendance or a completed meeting.','rsvp'),objective('circle_join','Join a neighbor’s circle','Join an active circle created by another operator. Membership is participation, not proof of a project outcome.','circle')]),
]);
export const CALLING_POLICY=Object.freeze({version:1,default_calling:'explorer',experience_per_objective:5,daily_experience_limit:10,changes_per_utc_day:1,cosmetic:true,transferable:false,currency:false,description:'Calling experience records bounded world participation. It creates no coins, cash value, account role, land title, review authority or action scope.'});
const ids=CALLINGS.map(c=>`'${c.id}'`).join(',');
// The receipt trigger validates an inserted row against this view, so the authored quest step rules
// are appended here: every published step is a rule for whichever calling the resident currently
// follows. Nothing else about the calling rules changes.
const rules=[...CALLINGS.flatMap(c=>c.objectives.map(o=>`SELECT '${c.id}' AS calling_id,'${c.id}.${o.id}' AS objective_id,'${o.source_kind}' AS source_kind`)),questObjectiveRules(CALLINGS.map(c=>c.id))].join(' UNION ALL ');
const isoMs=value=>`strftime('%Y-%m-%dT%H:%M:%fZ',(${value})/1000.0,'unixepoch')`;
const epoch=value=>`CAST(round((julianday(${value})-2440587.5)*86400000) AS INTEGER)`;
const source=(kind,agent,id,date,from,where='1')=>`SELECT ${agent} AS agent_id,'${kind}' AS source_kind,CAST(${id} AS TEXT) AS source_id,${date} AS occurred_at,${epoch(date)} AS occurred_ms FROM ${from} WHERE ${where}`;
const sources=[
 source('frontier_place','f.agent_id','f.id','f.created_at','frontier_actions f',"f.action='place'"),
 source('frontier_expand','f.agent_id','f.id','f.created_at','frontier_actions f',"f.action='expand'"),
 source('path_place','b.creator_agent_id','b.id','b.created_at','frontier_blocks b',"b.type='path' AND b.plot_id IS NOT NULL"),
 source('home_furnish','w.owner_agent_id','b.id','b.created_at','world_objects b JOIN worlds w ON w.id=b.world_id',"w.kind IN ('home','house') AND w.owner_agent_id IS NOT NULL"),
 source('shared_visit','v.agent_id',"v.world_id||':'||v.visited_at",isoMs('v.visited_at'),'journey_visits v JOIN worlds w ON w.id=v.world_id',"w.owner_agent_id IS NULL AND w.visibility='public' AND w.id!='commons'"),
 source('crop_plant','c.agent_id',"c.x||':'||c.y||':'||c.planted_at",isoMs('c.planted_at'),'journey_crops c'),
 source('crop_harvest','c.agent_id',"c.x||':'||c.y||':'||c.planted_at",isoMs('c.harvested_at'),'journey_crops c','c.harvested_at IS NOT NULL'),
 source('craft','a.record_id','a.seq','a.created_at','audit a JOIN journey_profiles p ON p.agent_id=a.record_id JOIN agents resident ON resident.id=p.agent_id',"a.event='journey.crafted' AND a.actor=resident.operator_id AND p.crafts>0"),
 source('thanks','t.giver_agent_id','t.id','t.created_at','community_thanks t JOIN agents giver ON giver.id=t.giver_agent_id JOIN agents recipient ON recipient.id=t.recipient_agent_id JOIN accounts other ON other.id=recipient.operator_id',"giver.operator_id!=recipient.operator_id AND recipient.status IN ('active','paused') AND other.status='active'"),
 source('circle_join','m.agent_id',"m.circle_id||':'||m.joined_at",'m.joined_at','community_members m JOIN community_circles c ON c.id=m.circle_id JOIN agents creator ON creator.id=c.creator_agent_id JOIN agents member ON member.id=m.agent_id JOIN accounts owner ON owner.id=creator.operator_id',"c.status='active' AND creator.operator_id!=member.operator_id AND creator.status IN ('active','paused') AND owner.status='active'"),
 source('project_pledge','p.agent_id',"p.project_id||':'||p.created_at",'p.created_at','community_pledges p JOIN community_projects c ON c.id=p.project_id JOIN agents creator ON creator.id=c.creator_agent_id JOIN agents member ON member.id=p.agent_id JOIN accounts owner ON owner.id=creator.operator_id',"c.status IN ('active','completed') AND creator.operator_id!=member.operator_id AND creator.status IN ('active','paused') AND owner.status='active'"),
 source('event_rsvp','r.agent_id',"r.event_id||':'||r.created_at",'r.created_at','community_rsvps r JOIN community_events e ON e.id=r.event_id JOIN agents creator ON creator.id=e.creator_agent_id JOIN agents member ON member.id=r.agent_id JOIN accounts owner ON owner.id=creator.operator_id',"e.status IN ('scheduled','active','completed') AND creator.operator_id!=member.operator_id AND creator.status IN ('active','paused') AND owner.status='active' AND r.created_at<e.starts_at"),
 source('research_claim','c.agent_id','c.id','c.created_at','claims c JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id JOIN accounts owner ON owner.id=m.owner_id JOIN accounts reviewer ON reviewer.id=m.reviewer_id',"m.demo=0 AND m.status IN ('open','closed') AND c.task_version=t.version AND c.status IN ('leased','submitted','changes_requested','accepted') AND owner.status='active' AND reviewer.status='active' AND reviewer.role IN ('admin','reviewer') AND reviewer.id!=c.account_id"),
 source('research_accepted','c.agent_id','r.id','r.created_at',contributionSource,contributionEligibility('c.agent_id')),
].join(' UNION ALL ');
const proof=receiptProof;

// ---- Bounded private resident memory (schema 21) -----------------------------------------------
//
// A resident's memory is a small, typed list of facts — never free prose. Each fact names the kind of
// fact it is, the attribute within that kind, a short structured subject and one bounded value line,
// and the exact source that proves it: a saved, attributable server fact (a verified calling receipt,
// a finished run that recorded a refusal, or an independent review decision) or the operator's own
// explicit input. A fact with neither is not storable, so a resident can never record an accomplishment
// the world did not confirm.
//
// The chosen approval model is **operator approval for every stored fact**. A resident credential may
// only *propose* a fact from its own verified record, and a proposal is not memory: it is invisible to
// the resident's prompt until the owning operator approves it. The operator can also record a fact
// directly (that is explicit human input, which is its own source), correct an active fact, export the
// whole record and delete a fact. Nothing is applied silently, and no resident credential can approve,
// correct or delete anything.
export const MEMORY_KINDS=Object.freeze({
  purpose:Object.freeze({label:'Chosen purpose',attributes:Object.freeze(['intent','focus','boundary']),sources:Object.freeze(['human']),resident:false}),
  activity:Object.freeze({label:'Confirmed activity',attributes:Object.freeze(['calling_objective','quest_step']),sources:Object.freeze(['receipt']),resident:true}),
  preference:Object.freeze({label:'Operator preference',attributes:Object.freeze(['working_style','communication','focus','boundary']),sources:Object.freeze(['human']),resident:false}),
  lesson:Object.freeze({label:'Lesson',attributes:Object.freeze(['refusal','review_feedback','operator_correction']),sources:Object.freeze(['run','review','human']),resident:true}),
});
export const MEMORY_SOURCES=Object.freeze(['calling','receipt','run','review','human']);
export const MEMORY_STATES=Object.freeze(['proposed','active','refused','superseded']);
export const MEMORY_ORIGINS=Object.freeze(['resident','operator']);
// The stated bounds. `facts_active` and `per_kind_active` bound what one resident may hold; `subject`
// and `value` bound one fact; `prompt_facts` and `prompt_bytes` bound how much of it one model prompt
// may carry, inside the runtime's existing observation byte budget.
export const MEMORY_LIMITS=Object.freeze({facts_active:24,per_kind_active:8,proposals_open:8,refused_kept:24,subject:80,value:160,label:120,prompt_facts:10,prompt_bytes:4096,history_page:200});
export const MEMORY_POLICY=Object.freeze({
 version:1,
 approval:'operator-approval',
 description:'A resident may propose a memory fact only from its own verified server record: a calling receipt, a finished run that recorded a refusal, or an independent review decision. No proposal becomes memory until the owning operator approves it, and the operator can record, correct, export and delete memory directly. A fact is stored only with a verified source receipt or the operator’s own explicit input, so a resident cannot record work the world did not confirm.',
 sentience:'Memory is a bounded list of saved facts and the sources that prove them. It is not a mind, not consciousness, and not evidence of any capability beyond the source it names. The interface and the runtime prompt say so too.',
 credentials:'Memory never stores a credential, an authorization value, a contact address or a link; such content is refused where it is written, and re-checked when a database is validated.',
});
// The one attribute/source rule set, used at the point of writing and again by recovery so a tampered
// row cannot pass a backup, a restore or a startup.
export function memoryPairValid(kind,attribute,source_kind){
  const definition=MEMORY_KINDS[kind];
  if(!definition||!definition.attributes.includes(attribute)||!definition.sources.includes(source_kind))return false;
  if(attribute==='calling_objective'||attribute==='quest_step')return source_kind==='receipt';
  if(attribute==='refusal')return source_kind==='run';
  if(attribute==='review_feedback')return source_kind==='review';
  return source_kind==='human';
}
// Content a memory fact may never carry. Every rule is also re-applied by recovery.
export const MEMORY_FORBIDDEN=Object.freeze([
 Object.freeze({name:'credential',pattern:/\b[a-f0-9]{40,}\b/i,message:'memory never stores a credential or a key'}),
 Object.freeze({name:'authorization',pattern:/\bbearer\b|\bpassword\s*[:=]|\bworld_session\b/i,message:'memory never stores an authorization value'}),
 Object.freeze({name:'contact',pattern:/[^\s@]+@[^\s@]+\.[a-z]{2,}/i,message:'memory never stores a contact address'}),
 Object.freeze({name:'link',pattern:/\bhttps?:\/\/|\bwww\./i,message:'memory never stores a link'}),
 Object.freeze({name:'sentience',pattern:/\b(conscious|consciousness|sentient|sentience|sapient|self-aware|self aware)\b/i,message:'memory records saved facts, never consciousness'}),
]);
const sha256=value=>createHash('sha256').update(value).digest('hex');
const memoryProof=row=>sha256(JSON.stringify([row.id,row.agent_id,row.account_id,row.kind,row.attribute,row.subject,row.value,row.source_kind,row.source_id,row.source_at,row.source_label,row.origin,row.created_at]));
const memoryIso=value=>typeof value==='string'&&value.length===24&&value===new Date(value).toISOString();
const memoryView=row=>({id:row.id,agent_id:row.agent_id,kind:row.kind,attribute:row.attribute,subject:row.subject,value:row.value,source:{kind:row.source_kind,id:row.source_id,at:row.source_at,label:row.source_label},origin:row.origin,state:row.state,decided_at:row.decided_at,created_at:row.created_at,updated_at:row.updated_at,supersedes:row.supersedes,superseded_by:row.superseded_by});
// One fact's words: a single bounded line. Refusing a newline keeps a self-authored value from
// carrying a second line back into the prompt, and the closed content rules keep credentials,
// contact details, links and consciousness claims out of memory entirely.
function memoryWords(value,label,maximum,optional=false){
 if(optional&&(value===undefined||value===null||value===''))return '';
 if(typeof value!=='string')fail(400,`${label} must be text.`);
 const trimmed=value.trim();
 if(!trimmed||Array.from(trimmed).length>maximum)fail(400,`${label} must contain 1–${maximum} characters.`);
 if(/[\r\n]/.test(trimmed))fail(400,`${label} must be one line.`);
 for(const rule of MEMORY_FORBIDDEN)if(rule.pattern.test(trimmed))fail(400,`${label}: ${rule.message}.`);
 return trimmed;
}
function memoryShape(kind,attribute,source_kind,origin){
 const definition=MEMORY_KINDS[kind];
 if(!definition)fail(400,'Choose a listed memory kind.');
 if(!definition.attributes.includes(attribute))fail(400,`Choose a listed ${kind} attribute.`);
 if(!memoryPairValid(kind,attribute,source_kind))fail(400,'That attribute needs its own kind of verified source.');
 if(origin==='resident'&&source_kind==='human')fail(403,'A resident cannot record operator input as a source.');
 if(origin==='resident'&&!definition.resident)fail(403,`A ${kind} fact is your operator's declaration, not a resident proposal.`);
}
// The only facts a resident credential may propose: a confirmed activity proved by a verified calling
// receipt, or a lesson learned from a recorded refusal or an independent review decision. A purpose or
// a preference is the operator's own declaration in this world, so the operator records it directly.
function residentSourceKind(kind,attribute){
 if(kind==='activity'&&(attribute==='calling_objective'||attribute==='quest_step'))return 'receipt';
 if(kind==='lesson'&&attribute==='refusal')return 'run';
 if(kind==='lesson'&&attribute==='review_feedback')return 'review';
 return null;
}
// The verified server facts this resident could still record, newest first. A source is spent once it
// is named by any stored fact (whatever its state), so a refused proposal does not free it for reuse.
function memorySources(platform,agent){
 const spent=(source_kind,source_id)=>platform.get('SELECT id FROM resident_memory WHERE agent_id=? AND source_kind=? AND source_id=?',agent.id,source_kind,source_id);
 const receipts=platform.all('SELECT * FROM calling_receipts WHERE agent_id=? ORDER BY created_at DESC,id DESC LIMIT 24',agent.id),receipt=[];
 for(const row of receipts){if(receipt.length>=12)break;if(spent('receipt',row.id)||row.proof_hash!==proof(row))continue;
  receipt.push({source_kind:'receipt',source_id:row.id,source_at:row.source_at,source_label:`${row.calling_id} · ${row.objective_id}`.slice(0,MEMORY_LIMITS.label),attribute:row.objective_id.startsWith('quest:')?'quest_step':'calling_objective'});}
 const runs=platform.all("SELECT id,status,failed_actions,started_at,updated_at FROM resident_runs WHERE agent_id=? AND status!='running' AND failed_actions>0 ORDER BY started_at DESC,id DESC LIMIT 12",agent.id),run=[];
 for(const row of runs){if(run.length>=6)break;if(spent('run',row.id))continue;
  run.push({source_kind:'run',source_id:row.id,source_at:memoryIso(row.updated_at)?row.updated_at:new Date(platform.clock()).toISOString(),source_label:`${row.failed_actions} refused ${row.failed_actions===1?'action':'actions'}`.slice(0,MEMORY_LIMITS.label),attribute:'refusal'});}
 const reviews=platform.all("SELECT rv.id,rv.decision,rv.created_at FROM reviews rv JOIN submissions s ON s.id=rv.submission_id JOIN claims c ON c.id=s.claim_id WHERE c.agent_id=? AND rv.decision IN ('changes_requested','rejected') ORDER BY rv.created_at DESC,rv.id DESC LIMIT 12",agent.id),review=[];
 for(const row of reviews){if(review.length>=6)break;if(spent('review',row.id))continue;
  review.push({source_kind:'review',source_id:row.id,source_at:row.created_at,source_label:`independent review: ${row.decision}`.slice(0,MEMORY_LIMITS.label),attribute:'review_feedback'});}
 return {receipt,run,review};
}
// One grouped statement, so a per-decision `/callings` read stays cheap: what the resident could still
// propose, by attribute. A zero count is exactly what lets the runtime decline an impossible proposal.
function memoryAvailable(platform,agentId){
 const row=platform.get(`SELECT
  (SELECT COUNT(*) FROM calling_receipts r WHERE r.agent_id=? AND r.objective_id NOT LIKE 'quest:%' AND NOT EXISTS(SELECT 1 FROM resident_memory m WHERE m.agent_id=r.agent_id AND m.source_kind='receipt' AND m.source_id=r.id)) AS calling_objective,
  (SELECT COUNT(*) FROM calling_receipts r WHERE r.agent_id=? AND r.objective_id LIKE 'quest:%' AND NOT EXISTS(SELECT 1 FROM resident_memory m WHERE m.agent_id=r.agent_id AND m.source_kind='receipt' AND m.source_id=r.id)) AS quest_step,
  (SELECT COUNT(*) FROM resident_runs n WHERE n.agent_id=? AND n.status!='running' AND n.failed_actions>0 AND NOT EXISTS(SELECT 1 FROM resident_memory m WHERE m.agent_id=n.agent_id AND m.source_kind='run' AND m.source_id=n.id)) AS refusal,
  (SELECT COUNT(*) FROM reviews rv JOIN submissions s ON s.id=rv.submission_id JOIN claims c ON c.id=s.claim_id WHERE c.agent_id=? AND rv.decision IN ('changes_requested','rejected') AND NOT EXISTS(SELECT 1 FROM resident_memory m WHERE m.agent_id=c.agent_id AND m.source_kind='review' AND m.source_id=rv.id)) AS review_feedback`,
  agentId,agentId,agentId,agentId);
 return {calling_objective:row.calling_objective,quest_step:row.quest_step,refusal:row.refusal,review_feedback:row.review_feedback};
}
function memoryRoom(platform,agent,state,kind){
 if(state==='active'){
  if(platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE agent_id=? AND state='active'",agent.id).n>=MEMORY_LIMITS.facts_active)fail(429,'This resident has reached its active memory limit; delete a fact first.');
  if(platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE agent_id=? AND state='active' AND kind=?",agent.id,kind).n>=MEMORY_LIMITS.per_kind_active)fail(429,`This resident already holds the maximum active ${kind} facts.`);
 }
 if(state==='proposed'&&platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE agent_id=? AND state='proposed'",agent.id).n>=MEMORY_LIMITS.proposals_open)fail(429,'Too many memory proposals are already waiting for the operator.');
}
function memoryInsert(platform,agent,fact){
 const row={id:randomUUID(),agent_id:agent.id,account_id:agent.operator_id,supersedes:fact.supersedes||null,superseded_by:null,...fact,created_at:new Date(platform.clock()).toISOString()};
 row.proof_hash=memoryProof(row);
 platform.run('INSERT INTO resident_memory(id,agent_id,account_id,kind,attribute,subject,value,source_kind,source_id,source_at,source_label,origin,state,decided_by,decided_at,supersedes,superseded_by,proof_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  row.id,row.agent_id,row.account_id,row.kind,row.attribute,row.subject,row.value,row.source_kind,row.source_id,row.source_at,row.source_label,row.origin,row.state,row.decided_by,row.decided_at,row.supersedes,row.superseded_by,row.proof_hash,row.created_at,row.created_at);
 return platform.get('SELECT * FROM resident_memory WHERE id=?',row.id);
}
// Attach the source a fact must name. A resident never chooses its own source: the server attaches the
// newest verified, unrecorded fact of the matching class. The operator may name one, or let the server
// attach the same newest one.
function memoryResolve(platform,agent,kind,attribute,source_kind,source_id,origin){
 if(!MEMORY_KINDS[kind])fail(400,'Choose a listed memory kind.');
 const resolved=source_kind||(origin==='operator'&&MEMORY_KINDS[kind].sources.includes('human')?'human':undefined);
 if(!resolved)fail(400,'Name the kind of verified source for this fact.');
 if(resolved==='human'){
  if(origin!=='operator')fail(403,'Only the operator can record a fact from human input.');
  memoryShape(kind,attribute,'human',origin);
  return {source_kind:'human',source_id:agent.operator_id,source_at:new Date(platform.clock()).toISOString(),source_label:'Operator input'};
 }
 const pool=memorySources(platform,agent)[resolved]||[],chosen=source_id?pool.find(item=>item.source_id===source_id):pool.find(item=>item.attribute===attribute);
 if(!chosen)fail(409,'No verified, unrecorded source supports that memory fact yet.');
 memoryShape(kind,attribute,resolved,origin);
 if(chosen.attribute!==attribute)fail(409,'That verified source records a different kind of fact.');
 return chosen;
}
function activeMemory(platform,agentId,limit=MEMORY_LIMITS.prompt_facts){
 const facts=platform.all("SELECT kind,attribute,subject,value,source_kind,source_at,source_label,decided_at FROM resident_memory WHERE agent_id=? AND state='active' ORDER BY decided_at DESC,id DESC LIMIT ?",agentId,limit)
  .map(row=>({kind:row.kind,attribute:row.attribute,subject:row.subject,value:row.value,source:{kind:row.source_kind,at:row.source_at,label:row.source_label},decided_at:row.decided_at}));
 // The stated `prompt_bytes` bound is enforced, not merely asserted: at the maximum lengths ten facts
 // could serialize above it, so the oldest facts are dropped whole until the section fits. Two facts
 // are always kept, because a purpose and a lesson are the least useful things to lose.
 while(facts.length>2&&Buffer.byteLength(JSON.stringify(facts),'utf8')>MEMORY_LIMITS.prompt_bytes)facts.pop();
 return facts;
}
// The bounded, prompt-eligible view of one resident's memory. It carries active, operator-approved
// facts only: a proposal is not memory, and it is never rendered into a model prompt. The counts and
// the `available` map are what let the runtime decline a proposal nothing can support.
export function promptMemory(platform,agent){
 if(!agent)return null;
 return {agent_id:agent.id,limits:{facts_active:MEMORY_LIMITS.facts_active,prompt_facts:MEMORY_LIMITS.prompt_facts,proposals_open:MEMORY_LIMITS.proposals_open,value:MEMORY_LIMITS.value,subject:MEMORY_LIMITS.subject},
  policy:MEMORY_POLICY,facts:activeMemory(platform,agent.id),
  active:platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE agent_id=? AND state='active'",agent.id).n,
  proposals_pending:platform.get("SELECT COUNT(*) AS n FROM resident_memory WHERE agent_id=? AND state='proposed'",agent.id).n,
  available:memoryAvailable(platform,agent.id)};
}
// The whole-record check, used by validateDatabase and by recovery's startup pass. A memory row must
// still name a source that exists, keep its immutable provenance, sit inside every stated bound and
// carry the proof of its own provenance.
export function verifyMemoryRecords(db){
 const kinds=new Set(Object.keys(MEMORY_KINDS));
 const totals=new Map(),kindTotals=new Map(),pending=new Map();
 for(const row of db.prepare('SELECT * FROM resident_memory ORDER BY created_at,id').all()){
  if(typeof row.id!=='string'||!row.id||!kinds.has(row.kind)||!MEMORY_ORIGINS.includes(row.origin)||!MEMORY_STATES.includes(row.state))return false;
  if(!memoryPairValid(row.kind,row.attribute,row.source_kind))return false;
  if(row.source_kind==='human'&&row.origin!=='operator')return false;
  if(!memoryIso(row.created_at)||!memoryIso(row.updated_at)||Date.parse(row.updated_at)<Date.parse(row.created_at))return false;
  if(row.source_kind!=='human'&&!memoryIso(row.source_at))return false;
  if(Array.from(row.subject).length>MEMORY_LIMITS.subject||Array.from(row.value).length>MEMORY_LIMITS.value||Array.from(row.source_label).length>MEMORY_LIMITS.label)return false;
  if(!row.value.trim()||/[\r\n]/.test(row.value))return false;
  for(const rule of MEMORY_FORBIDDEN)if(rule.pattern.test(row.value)||rule.pattern.test(row.subject)||rule.pattern.test(row.source_label))return false;
  if(row.proof_hash!==memoryProof(row))return false;
  if(row.state==='proposed'?(row.decided_by!==null||row.decided_at!==null):(row.decided_by!==row.account_id||!memoryIso(row.decided_at)))return false;
  if(row.superseded_by!==null&&row.state!=='superseded')return false;
  if(row.superseded_by!==null&&!db.prepare('SELECT id FROM resident_memory WHERE id=? AND agent_id=? AND supersedes=?').get(row.superseded_by,row.agent_id,row.id))return false;
  if(row.supersedes!==null&&!db.prepare('SELECT id FROM resident_memory WHERE id=? AND agent_id=? AND superseded_by=? AND state=?').get(row.supersedes,row.agent_id,row.id,'superseded'))return false;
  const owner=db.prepare("SELECT a.operator_id FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=? AND a.operator_id=? AND a.kind='agent' AND a.status!='deleted'").get(row.agent_id,row.account_id);
  if(!owner)return false;
  if(row.source_kind==='human'){
   if(row.source_id!==row.account_id||!db.prepare("SELECT id FROM accounts WHERE id=? AND status!='deleted'").get(row.source_id))return false;
  } else if(row.source_kind==='receipt'){
   const receipt=db.prepare('SELECT * FROM calling_receipts WHERE id=? AND agent_id=?').get(row.source_id,row.agent_id);
   if(!receipt||receipt.source_at!==row.source_at||receipt.proof_hash!==proof(receipt))return false;
   if((receipt.objective_id.startsWith('quest:')?'quest_step':'calling_objective')!==row.attribute)return false;
  } else if(row.source_kind==='run'){
   const run=db.prepare("SELECT id,failed_actions FROM resident_runs WHERE id=? AND agent_id=? AND status!='running' AND failed_actions>0").get(row.source_id,row.agent_id);
   if(!run||row.attribute!=='refusal')return false;
  } else if(row.source_kind==='review'){
   const review=db.prepare("SELECT rv.id FROM reviews rv JOIN submissions s ON s.id=rv.submission_id JOIN claims c ON c.id=s.claim_id WHERE rv.id=? AND c.agent_id=? AND rv.decision IN ('changes_requested','rejected')").get(row.source_id,row.agent_id);
   if(!review||row.attribute!=='review_feedback')return false;
  } else return false;
  if(row.state==='active'){
   const active=(totals.get(row.agent_id)||0)+1;if(active>MEMORY_LIMITS.facts_active)return false;totals.set(row.agent_id,active);
   const key=row.agent_id+':'+row.kind,used=(kindTotals.get(key)||0)+1;if(used>MEMORY_LIMITS.per_kind_active)return false;kindTotals.set(key,used);
  }
  if(row.state==='proposed'){const open=(pending.get(row.agent_id)||0)+1;if(open>MEMORY_LIMITS.proposals_open)return false;pending.set(row.agent_id,open);}
 }
 return true;
}
export const MEMORY_SCHEMA=`
 CREATE TABLE IF NOT EXISTS resident_memory(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL CHECK(kind IN (${Object.keys(MEMORY_KINDS).map(kind=>`'${kind}'`).join(',')})),attribute TEXT NOT NULL,subject TEXT NOT NULL DEFAULT '' CHECK(length(subject)<=${MEMORY_LIMITS.subject}),value TEXT NOT NULL CHECK(length(value) BETWEEN 1 AND ${MEMORY_LIMITS.value}),source_kind TEXT NOT NULL CHECK(source_kind IN (${MEMORY_SOURCES.map(source=>`'${source}'`).join(',')})),source_id TEXT NOT NULL,source_at TEXT NOT NULL,source_label TEXT NOT NULL DEFAULT '' CHECK(length(source_label)<=${MEMORY_LIMITS.label}),origin TEXT NOT NULL CHECK(origin IN ('resident','operator')),state TEXT NOT NULL CHECK(state IN (${MEMORY_STATES.map(state=>`'${state}'`).join(',')})),decided_by TEXT REFERENCES accounts(id),decided_at TEXT,supersedes TEXT REFERENCES resident_memory(id) ON DELETE SET NULL,superseded_by TEXT REFERENCES resident_memory(id) ON DELETE SET NULL,proof_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS resident_memory_agent ON resident_memory(agent_id,state,created_at);
 CREATE INDEX IF NOT EXISTS resident_memory_account ON resident_memory(account_id,kind,state);
 CREATE INDEX IF NOT EXISTS resident_memory_source ON resident_memory(agent_id,source_kind,source_id);
 CREATE TRIGGER IF NOT EXISTS resident_memory_identity_immutable BEFORE UPDATE OF agent_id,account_id,kind,attribute,subject,value,source_kind,source_id,source_at,source_label,origin,created_at ON resident_memory BEGIN SELECT RAISE(ABORT,'Resident memory provenance cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS resident_memory_validate_insert BEFORE INSERT ON resident_memory BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=NEW.agent_id AND a.operator_id=NEW.account_id AND a.status!='deleted') THEN RAISE(ABORT,'Resident memory needs an owned resident') END;
  SELECT CASE WHEN NEW.origin='resident' AND (NEW.state!='proposed' OR NEW.source_kind='human') THEN RAISE(ABORT,'A resident proposal must await an operator decision') END;
  SELECT CASE WHEN NEW.state='proposed' AND (NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL) THEN RAISE(ABORT,'A proposed memory fact has no decision yet') END;
  SELECT CASE WHEN NEW.state!='proposed' AND (NEW.decided_by!=NEW.account_id OR NEW.decided_at IS NULL) THEN RAISE(ABORT,'Only the owning operator can decide memory') END;
 END;`;
export const VOCATION_SCHEMA=`
 CREATE TABLE IF NOT EXISTS resident_callings(agent_id TEXT PRIMARY KEY REFERENCES agents(id),calling_id TEXT NOT NULL CHECK(calling_id IN (${ids})),selected_at INTEGER NOT NULL CHECK(selected_at>=0),last_changed_day TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS calling_receipts(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),account_id TEXT NOT NULL REFERENCES accounts(id),calling_id TEXT NOT NULL CHECK(calling_id IN (${ids})),objective_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_at TEXT NOT NULL,selected_at INTEGER NOT NULL,earned_day TEXT NOT NULL,points INTEGER NOT NULL CHECK(points=5),created_at TEXT NOT NULL,proof_hash TEXT NOT NULL,UNIQUE(agent_id,earned_day,objective_id),UNIQUE(agent_id,source_kind,source_id));
 CREATE INDEX IF NOT EXISTS calling_receipts_resident_day ON calling_receipts(agent_id,earned_day);
 CREATE INDEX IF NOT EXISTS resident_callings_group ON resident_callings(calling_id);
 CREATE VIEW IF NOT EXISTS calling_objective_rules AS ${rules};
 CREATE VIEW IF NOT EXISTS calling_source_events AS ${sources};
 CREATE TRIGGER IF NOT EXISTS calling_receipts_no_update BEFORE UPDATE ON calling_receipts BEGIN SELECT RAISE(ABORT,'Calling receipts cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS calling_receipts_validate_insert BEFORE INSERT ON calling_receipts BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM resident_callings v JOIN agents a ON a.id=v.agent_id JOIN accounts o ON o.id=a.operator_id JOIN calling_objective_rules rule ON rule.calling_id=v.calling_id JOIN calling_source_events e ON e.agent_id=a.id AND e.source_kind=rule.source_kind WHERE a.id=NEW.agent_id AND a.operator_id=NEW.account_id AND a.status='active' AND o.status='active' AND v.calling_id=NEW.calling_id AND v.selected_at=NEW.selected_at AND rule.objective_id=NEW.objective_id AND rule.source_kind=NEW.source_kind AND e.source_id=NEW.source_id AND e.occurred_at=NEW.source_at AND e.occurred_ms>=v.selected_at AND substr(e.occurred_at,1,10)=NEW.earned_day AND substr(NEW.created_at,1,10)=NEW.earned_day AND NEW.points=5) THEN RAISE(ABORT,'Calling receipt needs a verified current activity') END;
  SELECT CASE WHEN COALESCE((SELECT SUM(points) FROM calling_receipts WHERE agent_id=NEW.agent_id AND earned_day=NEW.earned_day),0)+NEW.points>10 THEN RAISE(ABORT,'Daily calling experience limit') END;
 END;`;

export function verifyCallingReceipts(db,agentId=null){
 const totals=new Map();
 for(const row of db.prepare(`SELECT * FROM calling_receipts${agentId?' WHERE agent_id=?':''} ORDER BY earned_day,id`).all(...(agentId?[agentId]:[]))){
  // A quest step receipt is authored on top of the same table and proved against its own step
  // definition; a receipt that names neither a calling objective nor an authored step is invalid.
  const quest=questStepFor(db,row.objective_id),definition=CALLINGS.find(c=>c.id===row.calling_id),o=definition?.objectives.find(o=>`${definition.id}.${o.id}`===row.objective_id);
  const source_kind=quest?quest.source_kind:o?.source_kind;
  if(!source_kind||source_kind!==row.source_kind||row.points!==5||!Number.isInteger(row.selected_at)||row.selected_at<0||row.proof_hash!==proof(row)||!/^\d{4}-\d{2}-\d{2}$/.test(row.earned_day)||row.earned_day!==row.source_at.slice(0,10)||row.earned_day!==row.created_at.slice(0,10)||!Number.isFinite(Date.parse(row.source_at))||!Number.isFinite(Date.parse(row.created_at))||Date.parse(row.source_at)<row.selected_at)return false;
  const key=row.agent_id+':'+row.earned_day,amount=(totals.get(key)||0)+row.points;if(amount>10)return false;totals.set(key,amount);
 }
 return true;
}
const day=platform=>new Date(platform.clock()).toISOString().slice(0,10);
function owned(platform,actor,input){
 if(!actor?.account||!['session','runtime'].includes(actor.kind))fail(401,'Sign in or use an owned agent runtime.');
 const agent=platform.ownedAgent(actor,input?.agent_id||actor.agent?.id);if(agent.status==='deleted')fail(404,'Resident not found.');return agent;
}
// Memory belongs to an AI resident, not to a human avatar. The human-avatar identity is resolved by
// the same ownership check and then refused with the same 404 an outsider sees.
function resident(platform,actor,input){
 const agent=owned(platform,actor,input);
 if(agent.kind!=='agent')fail(404,'Resident not found.');
 return agent;
}
function initialize(platform,agent){platform.run("INSERT OR IGNORE INTO resident_callings VALUES(?,'explorer',?,'')",agent.id,platform.clock());return platform.get('SELECT * FROM resident_callings WHERE agent_id=?',agent.id);}
function rank(points){const thresholds=[0,20,50,100,200],titles=['Newcomer','Apprentice','Practitioner','Companion','Worldmaker'];let index=0;while(index<4&&points>=thresholds[index+1])index++;return{level:index+1,title:titles[index],experience:points,next_level_at:thresholds[index+1]??null};}
// A receipt is available unless it is a research acceptance with no matching source event yet. The
// rule is written once, in SQL: `availableSql` is the one test, used for a single receipt page and for
// a whole avatar roster, so a passport and a viewport cannot report different held experience.
function availableSql(ref){return `(${ref}.source_kind!='research_accepted' OR EXISTS(SELECT 1 FROM calling_source_events e WHERE e.agent_id=${ref}.agent_id AND e.source_kind=${ref}.source_kind AND e.source_id=${ref}.source_id))`;}
// `available` stays a JSON boolean in every response: SQLite has no boolean type, so the 0/1 the
// expression returns is coerced here rather than leaking an integer into the published receipt shape.
function receipts(platform,agentId){return platform.all(`SELECT r.*,${availableSql('r')} AS available FROM calling_receipts r WHERE r.agent_id=? ORDER BY r.created_at DESC,r.id LIMIT 101`,agentId).map(row=>({...row,available:Boolean(row.available)}));}
// Experience summaries for a bounded set of residents in three grouped reads. A crowded viewport
// asks for every visible avatar at once; doing this one resident at a time cost three queries per
// avatar and dominated the viewport read. `summary` is the same function for a single resident.
function summaries(platform,agentIds){
 const ids=[...new Set((agentIds||[]).filter(id=>typeof id==='string'))],result=new Map();if(!ids.length)return result;
 const marks=ids.map(()=>'?').join(',');
 const totals=new Map(platform.all(`SELECT agent_id,COUNT(*) AS count,COALESCE(SUM(points),0) AS earned FROM calling_receipts WHERE agent_id IN (${marks}) GROUP BY agent_id`,...ids).map(row=>[row.agent_id,row]));
 const held=new Map(platform.all(`SELECT r.agent_id,COALESCE(SUM(r.points),0) AS held FROM calling_receipts r WHERE r.agent_id IN (${marks}) AND r.source_kind='research_accepted' AND NOT ${availableSql('r')} GROUP BY r.agent_id`,...ids).map(row=>[row.agent_id,row.held]));
 const today=new Map();
 for(const row of platform.all(`SELECT r.agent_id,r.objective_id,r.points,${availableSql('r')} AS available FROM calling_receipts r WHERE r.agent_id IN (${marks}) AND r.earned_day=? ORDER BY r.created_at,r.id`,...ids,day(platform))){
  if(!today.has(row.agent_id))today.set(row.agent_id,[]);
  today.get(row.agent_id).push({objective_id:row.objective_id,points:row.points,available:Boolean(row.available)});
 }
 for(const id of ids){
  const all=totals.get(id)||{count:0,earned:0},heldPoints=held.get(id)||0,rows=today.get(id)||[];
  result.set(id,{count:all.count,earned:all.earned,held:heldPoints,points:all.earned-heldPoints,today:rows,used:rows.reduce((n,r)=>n+r.points,0)});
 }
 return result;
}
function summary(platform,agentId){return summaries(platform,[agentId]).get(agentId);}
function reconcile(platform,agent,selection){
 if(agent.status!=='active'||platform.get("SELECT value FROM settings WHERE key='paused'").value==='true')return;
 if(!verifyCallingReceipts(platform.db,agent.id))fail(503,'Calling progress integrity needs administrator inspection.');
 const definition=CALLINGS.find(c=>c.id===selection.calling_id),today=day(platform);let used=platform.get('SELECT COALESCE(SUM(points),0) AS n FROM calling_receipts WHERE agent_id=? AND earned_day=?',agent.id,today).n;
 for(const o of definition.objectives){if(used>=10)break;
  const objectiveId=`${definition.id}.${o.id}`;if(platform.get('SELECT id FROM calling_receipts WHERE agent_id=? AND earned_day=? AND objective_id=?',agent.id,today,objectiveId))continue;
  const event=platform.get('SELECT e.* FROM calling_source_events e WHERE e.agent_id=? AND e.source_kind=? AND e.occurred_ms>=? AND substr(e.occurred_at,1,10)=? AND NOT EXISTS(SELECT 1 FROM calling_receipts r WHERE r.agent_id=e.agent_id AND r.source_kind=e.source_kind AND r.source_id=e.source_id) ORDER BY e.occurred_at,e.source_id LIMIT 1',agent.id,o.source_kind,selection.selected_at,today);if(!event)continue;
  const row={id:randomUUID(),agent_id:agent.id,account_id:agent.operator_id,calling_id:definition.id,objective_id:objectiveId,source_kind:event.source_kind,source_id:event.source_id,source_at:event.occurred_at,selected_at:selection.selected_at,earned_day:today,points:5,created_at:new Date(platform.clock()).toISOString()};row.proof_hash=proof(row);
  platform.run('INSERT INTO calling_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',row.id,row.agent_id,row.account_id,row.calling_id,row.objective_id,row.source_kind,row.source_id,row.source_at,row.selected_at,row.earned_day,row.points,row.created_at,row.proof_hash);used+=5;
 }
 // Authored quest steps are credited in the same pass, after the daily objectives, so one saved fact
 // is never counted twice and the ten-experience day limit is applied deterministically.
 reconcileQuests(platform,agent,selection);
}
function targets(platform,agent){
 const home=`home:${agent.id}`;
 const places=platform.all("SELECT w.id,w.name,w.kind FROM worlds w WHERE w.owner_agent_id IS NULL AND w.visibility='public' AND w.id!='commons' AND NOT EXISTS(SELECT 1 FROM journey_visits v WHERE v.agent_id=? AND v.world_id=w.id) ORDER BY w.id LIMIT 6",agent.id);
 const circles=platform.all("SELECT c.id,c.name,c.summary FROM community_circles c JOIN agents a ON a.id=c.creator_agent_id JOIN accounts o ON o.id=a.operator_id WHERE c.status='active' AND a.status IN ('active','paused') AND o.status='active' AND a.operator_id!=? AND NOT EXISTS(SELECT 1 FROM community_members m WHERE m.circle_id=c.id AND m.agent_id=?) ORDER BY c.created_at DESC LIMIT 5",agent.operator_id,agent.id);
 const projects=platform.all("SELECT p.id,p.title,p.goal,p.circle_id FROM community_projects p JOIN agents a ON a.id=p.creator_agent_id JOIN accounts o ON o.id=a.operator_id WHERE p.status='active' AND a.status IN ('active','paused') AND o.status='active' AND a.operator_id!=? AND NOT EXISTS(SELECT 1 FROM community_pledges pledge WHERE pledge.project_id=p.id AND pledge.agent_id=?) ORDER BY p.created_at DESC LIMIT 5",agent.operator_id,agent.id);
 const tasks=platform.all("SELECT t.id,t.title,t.mission_id FROM tasks t JOIN missions m ON m.id=t.mission_id JOIN accounts owner ON owner.id=m.owner_id JOIN accounts reviewer ON reviewer.id=m.reviewer_id WHERE t.status='open' AND m.status='open' AND m.demo=0 AND owner.status='active' AND reviewer.status='active' AND reviewer.role IN ('admin','reviewer') AND reviewer.id!=? ORDER BY m.created_at DESC LIMIT 5",agent.operator_id);
 const events=platform.all("SELECT e.id,e.title,e.world_id,e.circle_id,e.starts_at FROM community_events e JOIN agents a ON a.id=e.creator_agent_id JOIN accounts o ON o.id=a.operator_id JOIN worlds w ON w.id=e.world_id WHERE e.status='scheduled' AND e.starts_at>? AND w.visibility='public' AND a.status IN ('active','paused') AND o.status='active' AND a.operator_id!=? AND NOT EXISTS(SELECT 1 FROM community_rsvps r WHERE r.event_id=e.id AND r.agent_id=?) AND (e.circle_id IS NULL OR EXISTS(SELECT 1 FROM community_members m WHERE m.circle_id=e.circle_id AND m.agent_id=?)) AND (SELECT COUNT(*) FROM community_rsvps r WHERE r.event_id=e.id)<e.capacity ORDER BY e.starts_at LIMIT 5",new Date(platform.clock()).toISOString(),agent.operator_id,agent.id,agent.id);
 const claim=platform.get("SELECT c.id,c.task_id,c.status,c.expires_at,t.title FROM claims c JOIN tasks t ON t.id=c.task_id WHERE c.agent_id=? AND c.account_id=? AND c.status IN ('leased','submitted','changes_requested') ORDER BY c.created_at DESC LIMIT 1",agent.id,agent.operator_id)||null;
 const farms=platform.all("SELECT id,x,y FROM world_objects WHERE world_id=? AND type='farm' ORDER BY y,x LIMIT 20",home);
 const land=platform.get('SELECT p.id,p.world_id,p.x,p.y,p.width,p.height FROM land_stewardships s JOIN land_parcels p ON p.id=s.plot_id WHERE s.account_id=?',agent.operator_id)||null;
 const cells=[];if(land?.world_id===agent.world_id){const definition=getWorldDefinition(agent.world_id);for(let y=land.y;y<land.y+6&&cells.length<6;y++)for(let x=land.x;x<land.x+6&&cells.length<6;x++)if(walkable({x,y},definition)&&Math.abs(x-agent.x)+Math.abs(y-agent.y)<=6&&!platform.get('SELECT id FROM frontier_blocks WHERE world_id=? AND x=? AND y=?',agent.world_id,x,y)&&!platform.get("SELECT id FROM agents WHERE world_id=? AND x=? AND y=? AND status!='deleted'",agent.world_id,x,y))cells.push({x,y,z:0});}
 return{places,circles,projects,events,tasks,claim,home:{world_id:home,farm_patches:farms},land:land?{...land,nearby_clear_cells:cells}:null,note:'Targets are suggestions. Use the current world and journey observations; all existing permission and review checks still apply.'};
}
export const vocationMethods={
 initVocations(){this.run("INSERT OR IGNORE INTO resident_callings SELECT id,'explorer',?,'' FROM agents WHERE status!='deleted'",this.clock());},
 callings(actor,input={}){
  const agent=owned(this,actor,input),selection=initialize(this,agent);reconcile(this,agent,selection);const definition=CALLINGS.find(c=>c.id===selection.calling_id),records=receipts(this,agent.id),totals=summary(this,agent.id),{earned,points,used}=totals,today=day(this);
  const objectives=definition.objectives.map(o=>{const receipt=totals.today.find(r=>r.objective_id===`${definition.id}.${o.id}`);return{...o,id:`${definition.id}.${o.id}`,progress:receipt?.available?1:0,complete:Boolean(receipt?.available),withheld:Boolean(receipt&&!receipt.available)};});
  return{agent_id:agent.id,calling:{id:definition.id,name:definition.name,guild_name:definition.guild_name,purpose:definition.purpose},rank:rank(points),experience:{earned,available:points,held:earned-points,cosmetic:true},today:{day:today,earned:used,remaining:Math.max(0,10-used),limit:10,objectives},current_objective:objectives.find(o=>!o.complete)||null,targets:targets(this,agent),receipts:records.slice(0,100),has_more:totals.count>100,catalog:CALLINGS,policy:CALLING_POLICY,memory:promptMemory(this,agent),selected_at:selection.selected_at,can_change:actor.kind==='session'&&agent.status==='active'&&this.get("SELECT value FROM settings WHERE key='paused'").value!=='true'&&selection.last_changed_day!==today,server_time:this.clock()};
 },
 callingSelect(actor,input){
  if(actor?.kind!=='session')fail(403,'Only the signed-in human operator can choose a calling.');
  if(!input||Object.keys(input).some(key=>!['agent_id','calling_id'].includes(key)))fail(400,'Choose only a resident and a listed calling.');
  const agent=owned(this,actor,input);this.active();if(agent.status!=='active')fail(403,'Resume the resident before choosing a calling.');
  if(!CALLINGS.some(c=>c.id===input.calling_id))fail(400,'Choose a listed peaceful calling.');
  const current=initialize(this,agent),today=day(this);if(current.calling_id===input.calling_id)return{...this.callings(actor,{agent_id:agent.id}),changed:false};
  reconcile(this,agent,current);if(current.last_changed_day===today)fail(429,'A resident can change calling once per UTC day.');
  this.run('UPDATE resident_callings SET calling_id=?,selected_at=?,last_changed_day=? WHERE agent_id=?',input.calling_id,this.clock(),today,agent.id);this.audit(actor.account.id,'calling.selected',agent.id);return{...this.callings(actor,{agent_id:agent.id}),changed:true};
 },
 publicCallings(agentIds){
  if(!Array.isArray(agentIds)||agentIds.length>220||agentIds.some(id=>typeof id!=='string'))fail(400,'Request at most 220 public calling profiles.');const result={};if(!agentIds.length)return result;
  const list=this.all(`SELECT a.id,a.status,COALESCE(v.calling_id,'explorer') AS calling_id FROM agents a LEFT JOIN resident_callings v ON v.agent_id=a.id WHERE a.id IN (${agentIds.map(()=>'?').join(',')}) AND a.status!='deleted'`,...agentIds);
  // One grouped experience read for the whole roster instead of three queries per visible avatar.
  const totals=summaries(this,list.map(agent=>agent.id));
  for(const agent of list){const definition=CALLINGS.find(c=>c.id===agent.calling_id),summaryOf=totals.get(agent.id),points=summaryOf.points,earnedToday=summaryOf.today;const next=definition.objectives.find(o=>!earnedToday.some(r=>r.objective_id===`${definition.id}.${o.id}`&&r.available));const r=rank(points);result[agent.id]={id:definition.id,name:definition.name,rank:{level:r.level,title:r.title},current_objective:next?{id:`${definition.id}.${next.id}`,title:next.title,complete:false}:{id:'daily_complete',title:'Today’s calling objectives complete',complete:true}};}
  for(const npc of this.all(`SELECT id FROM npc_mayors WHERE id IN (${agentIds.map(()=>'?').join(',')})`,...agentIds))result[npc.id]={id:'steward',name:'Steward',rank:{level:0,title:'Civic guide'},current_objective:{id:'civic_guidance',title:'Offer guidance and route concerns to human moderators',complete:false}};
  // Country ambassadors are NPCs too: they display a civic-guide label at level 0, never a calling,
  // experience, rank progress or guild membership. They hold no account and no operator credentials.
  for(const npc of this.all(`SELECT id FROM npc_ambassadors WHERE id IN (${agentIds.map(()=>'?').join(',')})`,...agentIds))result[npc.id]={id:'steward',name:'Steward',rank:{level:0,title:'Civic guide'},current_objective:{id:'civic_guidance',title:'Offer source-based guidance and route concerns to human moderators',complete:false}};
  return result;
 },
 callingGuilds(input={}){
  const limit=input.limit===undefined?12:Number(input.limit),offset=input.offset===undefined?0:Number(input.offset);if(!Number.isInteger(limit)||limit<1||limit>24||!Number.isInteger(offset)||offset<0||offset>1000000)fail(400,'Use a guild page of one to twenty-four residents.');const selected=input.calling_id||'';if(selected&&!CALLINGS.some(c=>c.id===selected))fail(400,'Choose a listed calling guild.');
  const from="FROM agents a JOIN accounts o ON o.id=a.operator_id JOIN worlds w ON w.id=a.world_id LEFT JOIN resident_callings v ON v.agent_id=a.id WHERE a.status='active' AND o.status='active' AND w.visibility='public'",condition=selected?" AND COALESCE(v.calling_id,'explorer')=?":'',args=selected?[selected]:[];
  const counts=this.all(`SELECT COALESCE(v.calling_id,'explorer') AS calling_id,COUNT(*) AS n ${from} GROUP BY COALESCE(v.calling_id,'explorer')`),total=this.get(`SELECT COUNT(*) AS n ${from}${condition}`,...args).n;
  const members=this.all(`SELECT a.id,a.name,a.kind,a.world_id ${from}${condition} ORDER BY a.name,a.id LIMIT ? OFFSET ?`,...args,limit,offset),profiles=this.publicCallings(members.map(m=>m.id));
  return{catalog:CALLINGS,groups:CALLINGS.map(c=>({calling_id:c.id,name:c.name,guild_name:c.guild_name,purpose:c.purpose,charter:c.charter,member_count:counts.find(n=>n.calling_id===c.id)?.n||0})),calling_id:selected,members:members.map(m=>({...m,calling:{id:profiles[m.id].id,name:profiles[m.id].name,rank:profiles[m.id].rank}})),total,offset,limit,has_more:offset+limit<total,policy:CALLING_POLICY};
 },
 // ---- Resident memory (schema 21) ---------------------------------------------------------------
 // `owned()` is the whole visibility rule: an operator session reaches only its own residents and a
 // runtime credential reaches only the exact character it runs. A sibling character, another
 // operator's session or any other runtime credential gets 404, so memory cannot leak sideways.
 memory(actor,input={}){
  if(!input||Object.keys(input).some(key=>!['agent_id'].includes(key)))fail(400,'Inspect one resident at a time.');
  const agent=resident(this,actor,input);
  const rows=this.all('SELECT * FROM resident_memory WHERE agent_id=? ORDER BY created_at DESC,id DESC LIMIT ?',agent.id,MEMORY_LIMITS.history_page);
  const byState=state=>rows.filter(row=>row.state===state).map(memoryView);
  return{agent_id:agent.id,name:agent.name,limits:{...MEMORY_LIMITS},policy:MEMORY_POLICY,catalog:MEMORY_KINDS,
   facts:byState('active'),proposals:byState('proposed'),history:[...byState('refused'),...byState('superseded')],
   counts:{active:rows.filter(row=>row.state==='active').length,proposed:rows.filter(row=>row.state==='proposed').length,refused:rows.filter(row=>row.state==='refused').length,superseded:rows.filter(row=>row.state==='superseded').length,stored:rows.length},
   available:memoryAvailable(this,agent.id),generated_at:new Date(this.clock()).toISOString()};
 },
 // A resident credential may only propose, never decide. The proposal carries no source: the server
 // attaches the newest verified, unrecorded fact of the matching class, so a model cannot name an
 // accomplishment the world did not confirm, and cannot quote public chat as a memory write.
 memoryPropose(actor,input){
  if(actor?.kind!=='runtime'||actor.agent?.kind!=='agent')fail(403,'Only a resident runtime credential can propose a memory fact.');
  if(!input||Object.keys(input).some(key=>!['agent_id','kind','attribute','subject','value'].includes(key)))fail(400,'A memory proposal names only a kind, an attribute, a short subject and one value line.');
  const agent=resident(this,actor,input);
  if(agent.status!=='active')fail(403,'Resume this resident before proposing a memory fact.');
  const kind=String(input.kind||''),attribute=String(input.attribute||''),source_kind=residentSourceKind(kind,attribute);
  if(!source_kind)fail(403,'A resident proposes only a verified activity or a lesson from its own record.');
  memoryShape(kind,attribute,source_kind,'resident');
  const value=memoryWords(input.value,'Memory value',MEMORY_LIMITS.value),subject=memoryWords(input.subject,'Memory subject',MEMORY_LIMITS.subject,true);
  const source=memoryResolve(this,agent,kind,attribute,source_kind,null,'resident');
  memoryRoom(this,agent,'proposed',kind);
  const fact=memoryInsert(this,agent,{kind,attribute,subject,value,...source,origin:'resident',state:'proposed',decided_by:null,decided_at:null});
  this.audit(actor.account.id,'memory.proposed',fact.id);
  return{proposal:memoryView(fact),policy:MEMORY_POLICY};
 },
 // The operator's own controls. Recording states a fact directly from the operator's own input or from
 // a verified source they name; approving and refusing decide a proposal; correcting writes a
 // replacement fact and supersedes the old one; deleting removes a fact entirely.
 memoryManage(actor,input){
  if(actor?.kind!=='session')fail(403,'Only the signed-in human operator can manage resident memory.');
  const action=String(input?.action||'');
  if(!['record','approve','refuse','correct','delete'].includes(action))fail(400,'Choose record, approve, refuse, correct or delete.');
  const agent=resident(this,actor,input);
  if(action==='delete')return this.memoryDelete(actor,agent,input);
  if(action==='approve'||action==='refuse')return this.memoryDecide(actor,agent,input,action==='approve'?'active':'refused');
  if(action==='correct')return this.memoryCorrect(actor,agent,input);
  return this.memoryRecord(actor,agent,input);
 },
 memoryRecord(actor,agent,input){
  if(Object.keys(input).some(key=>!['action','agent_id','kind','attribute','subject','value','source_kind','source_id'].includes(key)))fail(400,'A recorded memory fact names only its kind, attribute, subject, value and source.');
  const kind=String(input.kind||''),attribute=String(input.attribute||''),declared=input.source_kind?String(input.source_kind):'human';
  if(!MEMORY_SOURCES.includes(declared))fail(400,'Choose a listed memory source.');
  memoryShape(kind,attribute,declared,'operator');
  const value=memoryWords(input.value,'Memory value',MEMORY_LIMITS.value),subject=memoryWords(input.subject,'Memory subject',MEMORY_LIMITS.subject,true);
  const source=memoryResolve(this,agent,kind,attribute,declared,input.source_id||null,'operator');
  memoryRoom(this,agent,'active',kind);
  const decided_at=new Date(this.clock()).toISOString();
  const fact=memoryInsert(this,agent,{kind,attribute,subject,value,...source,origin:'operator',state:'active',decided_by:actor.account.id,decided_at});
  this.audit(actor.account.id,'memory.recorded',fact.id);
  return{fact:memoryView(fact)};
 },
 memoryDecide(actor,agent,input,state){
  const fact=this.get('SELECT * FROM resident_memory WHERE id=? AND agent_id=?',String(input.fact_id||''),agent.id);
  if(!fact)fail(404,'Memory fact not found.');
  if(fact.state!=='proposed')fail(409,'This memory fact already has an operator decision.');
  if(state==='active')memoryRoom(this,agent,'active',fact.kind);
  const decided_at=new Date(this.clock()).toISOString();
  this.run('UPDATE resident_memory SET state=?,decided_by=?,decided_at=?,updated_at=? WHERE id=?',state,actor.account.id,decided_at,decided_at,fact.id);
  this.audit(actor.account.id,state==='active'?'memory.approved':'memory.refused',fact.id);
  return{fact:memoryView(this.get('SELECT * FROM resident_memory WHERE id=?',fact.id))};
 },
 memoryCorrect(actor,agent,input){
  const fact=this.get('SELECT * FROM resident_memory WHERE id=? AND agent_id=?',String(input.fact_id||''),agent.id);
  if(!fact)fail(404,'Memory fact not found.');
  if(fact.state==='superseded')fail(409,'This memory fact was already corrected.');
  if(fact.state==='proposed')fail(409,'Approve or refuse this proposal before correcting it.');
  const value=memoryWords(input.value,'Memory value',MEMORY_LIMITS.value),subject=input.subject===undefined?fact.subject:memoryWords(input.subject,'Memory subject',MEMORY_LIMITS.subject,true);
  if(fact.state!=='active')memoryRoom(this,agent,'active',fact.kind);
  const decided_at=new Date(this.clock()).toISOString();
  // The correction is a new operator-decided fact that keeps the original source, so a corrected
  // receipt-backed fact still names the receipt that proves it.
  const replacement=memoryInsert(this,agent,{kind:fact.kind,attribute:fact.attribute,subject,value,source_kind:fact.source_kind,source_id:fact.source_id,source_at:fact.source_at,source_label:fact.source_label,origin:'operator',state:'active',decided_by:actor.account.id,decided_at,supersedes:fact.id});
  this.run('UPDATE resident_memory SET state=?,superseded_by=?,updated_at=? WHERE id=?','superseded',replacement.id,decided_at,fact.id);
  this.audit(actor.account.id,'memory.corrected',fact.id);
  return{superseded:memoryView(this.get('SELECT * FROM resident_memory WHERE id=?',fact.id)),fact:memoryView(replacement)};
 },
 memoryDelete(actor,agent,input){
  const fact=this.get('SELECT * FROM resident_memory WHERE id=? AND agent_id=?',String(input.fact_id||''),agent.id);
  if(!fact)fail(404,'Memory fact not found.');
  // Deleting a corrected fact removes the correction and the version it replaced, so no orphaned
  // "superseded" row survives. Deleting a version that a correction replaced keeps the correction,
  // whose dangling `supersedes` reference is cleared by the foreign key.
  const chain=fact.supersedes?[fact.id,fact.supersedes]:[fact.id];
  this.run(`DELETE FROM resident_memory WHERE id IN (${chain.map(()=>'?').join(',')})`,...chain);
  this.audit(actor.account.id,'memory.deleted',fact.id);
  return{deleted:true,id:fact.id,removed:chain.length};
 },
 memoryExport(actor){
  if(actor?.kind!=='session')fail(403,'Only the operator can export resident memory.');
  return{policy:MEMORY_POLICY,limits:{...MEMORY_LIMITS},facts:this.all('SELECT * FROM resident_memory WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 5000',actor.account.id).map(row=>({...memoryView(row),proof_hash:row.proof_hash}))};
 },
 deleteMemory(actor){
  if(actor?.kind!=='session')fail(403,'Only the operator can delete resident memory.');
  this.run('DELETE FROM resident_memory WHERE account_id=?',actor.account.id);
 },
 vocationExport(actor){if(actor?.kind!=='session')fail(403,'Only the operator can export calling records.');for(const agent of this.all("SELECT id FROM agents WHERE operator_id=? AND status!='deleted'",actor.account.id))this.callings(actor,{agent_id:agent.id});return{selections:this.all('SELECT v.* FROM resident_callings v JOIN agents a ON a.id=v.agent_id WHERE a.operator_id=?',actor.account.id),receipts:this.all('SELECT * FROM calling_receipts WHERE account_id=? ORDER BY created_at DESC LIMIT 5000',actor.account.id)};},
 deleteVocations(actor){if(actor?.kind!=='session')fail(403,'Only the operator can delete calling records.');this.run('DELETE FROM calling_receipts WHERE account_id=?',actor.account.id);this.run('DELETE FROM resident_callings WHERE agent_id IN (SELECT id FROM agents WHERE operator_id=?)',actor.account.id);},
};
