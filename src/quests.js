import {createHash,randomUUID} from 'node:crypto';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const readText=(value,label,maximum,optional=false)=>{
 if(optional&&(value==null||value===''))return '';
 if(typeof value!=='string'||!value.trim()||value.length>maximum)fail(400,`${label} must contain ${optional?0:'1'}–${maximum} characters.`);
 return value.trim();
};
const readSlug=(value,label)=>{if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]{1,39}$/.test(value))fail(400,`${label} must be a lowercase slug of 2–40 letters, digits or dashes.`);return value;};
// One receipt proof for both calling objectives and quest steps. It is the exact tuple the append-only
// calling_receipts row stores, so a receipt written through a quest step verifies with the same function.
export const receiptProof=row=>createHash('sha256').update(JSON.stringify([row.id,row.agent_id,row.account_id,row.calling_id,row.objective_id,row.source_kind,row.source_id,row.source_at,row.selected_at,row.earned_day,row.points,row.created_at])).digest('hex');

// The saved server facts a quest step may prove itself with, per authored route. Every kind is an
// existing row of the calling_source_events registry: a placed block, a harvested crop, an accepted
// submission. There is no kind a client, a model or an author can write directly.
export const QUEST_ROUTES=Object.freeze({
 world_building:Object.freeze(['frontier_place','path_place','frontier_expand','home_furnish','shared_visit']),
 gardening:Object.freeze(['crop_plant','crop_harvest','craft']),
 evidence_research:Object.freeze(['research_claim','research_accepted']),
});
export const QUEST_ROUTE_IDS=Object.freeze(Object.keys(QUEST_ROUTES));
export const QUEST_SOURCE_KINDS=Object.freeze([...new Set(Object.values(QUEST_ROUTES).flat())]);
// The concrete next action a resident can take, in the vocabulary the interface already understands.
export const QUEST_ACTIONS=Object.freeze({
 frontier_place:{kind:'build_block',section:'world',label:'Open the frontier and place a saved block inside your operator’s plot',saved_fact:'a saved frontier block recorded by the server'},
 path_place:{kind:'build_block',section:'world',label:'Place a ground path block inside the plot your operator stewards',saved_fact:'a saved path block recorded by the server'},
 frontier_expand:{kind:'expand',section:'world',label:'Walk to an unopened frontier passage and open the neighbouring area',saved_fact:'a saved area-expansion record'},
 home_furnish:{kind:'build',section:'workshop',label:'Place an allowed saved object in your own garden or cottage',saved_fact:'a saved home object recorded by the server'},
 shared_visit:{kind:'explore',section:'explore',label:'Travel into a shared place you have not visited yet',saved_fact:'a recorded visit to a shared world'},
 crop_plant:{kind:'garden',section:'workshop',label:'Plant a crop on a farm patch inside your own garden',saved_fact:'a saved planting with its own tile and time'},
 crop_harvest:{kind:'garden',section:'workshop',label:'Tend the growing crop, then harvest it once the server says it is ready',saved_fact:'a harvested crop recorded with the growth time the server checked'},
 craft:{kind:'craft',section:'workshop',label:'Craft a recipe from resources you actually gathered',saved_fact:'a crafted keepsake recorded after the ingredients were debited'},
 research_claim:{kind:'claim',section:'missions',label:'Claim an open real mission task that has an independent reviewer',saved_fact:'a leased claim on a real task; a commitment, not an outcome'},
 research_accepted:{kind:'await_review',section:'history',label:'Submit sourced work and wait for a different, authorized operator to accept it',saved_fact:'an accepted review receipt from an independent human reviewer'},
});
export const QUEST_POLICY=Object.freeze({
 version:1,
 routes:QUEST_ROUTE_IDS,
 source_kinds:QUEST_SOURCE_KINDS,
 experience_per_step:5,
 daily_experience_limit:10,
 shared_daily_limit_with_callings:true,
 coins_awarded:0,
 client_completion:false,
 authoring_roles:['admin','reviewer'],
 description:'A quest step advances only from a saved, attributed server fact that the server can still verify. Cosmetic step experience is the same non-transferable calling experience and shares its ten-per-day limit. A quest never issues NemoCoins: only an independent human acceptance of a real scoped contribution can, through the existing coin ledger.',
});
const STEP_MIN=2,STEP_MAX=8;
const MAX_NARRATIVE=4000;
const objectiveId=(chainSlug,stepSlug)=>`quest:${chainSlug}.${stepSlug}`;
const stepId=(chainSlug,stepSlug)=>`step:${chainSlug}.${stepSlug}`;
const chainId=slug=>`chain:${slug}`;
// The authored step rules, joined into the existing calling_objective_rules view. A step rule is
// spread across every calling id because the receipt trigger checks the resident's current calling;
// the step itself is not tied to one vocation. Only published chains add rules.
export const questObjectiveRules=callingIds=>{
 if(!Array.isArray(callingIds)||!callingIds.length)throw new Error('Quest objective rules need the listed callings.');
 const callings=callingIds.map(id=>`SELECT '${id}' AS calling_id`).join(' UNION ALL ');
 return `SELECT calls.calling_id AS calling_id,'quest:'||c.slug||'.'||s.slug AS objective_id,s.source_kind AS source_kind FROM quest_steps s JOIN quest_chains c ON c.id=s.chain_id CROSS JOIN (${callings}) calls WHERE c.status='published'`;
};
export const QUEST_SCHEMA=`
 CREATE TABLE IF NOT EXISTS quest_chains(id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL,route TEXT NOT NULL CHECK(route IN (${QUEST_ROUTE_IDS.map(route=>`'${route}'`).join(',')})),summary TEXT NOT NULL,narrative TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('built_in','operator')),author_account_id TEXT REFERENCES accounts(id),status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),practice INTEGER NOT NULL CHECK(practice IN (0,1)),beneficiary TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS quest_steps(id TEXT PRIMARY KEY,chain_id TEXT NOT NULL REFERENCES quest_chains(id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND ${STEP_MAX}),slug TEXT NOT NULL,title TEXT NOT NULL,instructions TEXT NOT NULL,output_name TEXT NOT NULL,source_kind TEXT NOT NULL CHECK(source_kind IN (${QUEST_SOURCE_KINDS.map(kind=>`'${kind}'`).join(',')})),requires_review INTEGER NOT NULL DEFAULT 0 CHECK(requires_review IN (0,1)),target INTEGER NOT NULL DEFAULT 1 CHECK(target BETWEEN 1 AND 3),prerequisite_step_id TEXT REFERENCES quest_steps(id),created_at TEXT NOT NULL,UNIQUE(chain_id,slug),UNIQUE(chain_id,ordinal));
 CREATE TABLE IF NOT EXISTS quest_enrollments(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),account_id TEXT NOT NULL REFERENCES accounts(id),chain_id TEXT NOT NULL REFERENCES quest_chains(id),started_at INTEGER NOT NULL CHECK(started_at>=0),idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(agent_id,chain_id),UNIQUE(account_id,idempotency_key));
 CREATE INDEX IF NOT EXISTS quest_steps_chain ON quest_steps(chain_id,ordinal);
 CREATE INDEX IF NOT EXISTS quest_enrollments_account ON quest_enrollments(account_id,created_at);
 CREATE INDEX IF NOT EXISTS quest_chains_status ON quest_chains(status,origin,slug);
 CREATE TRIGGER IF NOT EXISTS quest_chains_identity_immutable BEFORE UPDATE ON quest_chains WHEN NEW.id!=OLD.id OR NEW.slug!=OLD.slug OR NEW.route!=OLD.route OR NEW.origin!=OLD.origin OR NEW.practice!=OLD.practice OR COALESCE(NEW.author_account_id,'')!=COALESCE(OLD.author_account_id,'') BEGIN SELECT RAISE(ABORT,'A quest chain keeps its identity, route and practice scope'); END;
 CREATE TRIGGER IF NOT EXISTS quest_steps_immutable BEFORE UPDATE ON quest_steps BEGIN SELECT RAISE(ABORT,'Published quest steps are not rewritten; author a new chain instead'); END;
 CREATE TRIGGER IF NOT EXISTS quest_chains_keep_steps BEFORE DELETE ON quest_chains WHEN EXISTS(SELECT 1 FROM quest_steps WHERE chain_id=OLD.id) BEGIN SELECT RAISE(ABORT,'A quest chain with steps is archived, never deleted'); END;`;
// The shipped practice chain. It is deliberately cosmetic: two growth cycles and one craft, no
// beneficiary, no real-world claim, and no way to award anything but the existing cosmetic experience.
export const SEED_QUESTS=Object.freeze([Object.freeze({
 slug:'quiet-harvest',title:'The Quiet Harvest',route:'gardening',practice:true,beneficiary:'',
 summary:'A three-step practice of patience: sow a crop in your own garden, tend it and gather it, then turn the harvest into one keepsake.',
 narrative:'Nothing in this chain is promised to anyone outside NemoWorld. It is a practice of patience, written for a resident who wants to learn how the garden actually answers. Begin with a single patch of turned soil beside your own door: one row is enough, and the seed costs nothing. Then wait. A crop keeps its own time, and tending it only shortens the wait by a little, never by as much as you might hope. When the server says the row is ready, gather it and count what the ground gave you. Finally take those two resources to the workshop and make one small keepsake — a lantern, a banner, a crown of flowers. Hang it or wear it. The chain ends there, with an object in your own hands and no claim on anyone else’s life.',
 steps:Object.freeze([
  Object.freeze({slug:'first-sowing',title:'Sow a first row',instructions:'Place a crop patch in your own garden with the build palette, stand in your garden and plant herbs, fiber or wood on that exact tile.',output_name:'One planted crop in your own garden',source_kind:'crop_plant',requires_review:false,target:1,prerequisite:null}),
  Object.freeze({slug:'patient-tending',title:'Wait, tend, and gather',instructions:'Return while the crop is still growing and tend it once if you like, then harvest it after the server reports it ready. The growth time is checked on the server.',output_name:'Two gathered resources from a mature crop',source_kind:'crop_harvest',requires_review:false,target:1,prerequisite:'first-sowing'}),
  Object.freeze({slug:'keepsake',title:'Make one keepsake',instructions:'Take the resources you gathered to the workshop and craft a recipe you can afford. The ingredients are checked and debited in one transaction.',output_name:'A crafted keepsake made from your own harvest',source_kind:'craft',requires_review:false,target:1,prerequisite:'patient-tending'}),
 ]),
}),Object.freeze({
 slug:'shared-frontier-path',title:'The Shared Frontier Path',route:'world_building',practice:true,beneficiary:'',
 summary:'A four-step practice of opening and marking a shared path: place a marker, lay a path stone, open the neighbouring area, and leave a light for the next traveller.',
 narrative:'This chain is a practice of small, shared marks on the frontier. It claims nothing beyond NemoWorld and no benefit for anyone outside it. Begin beside your own stewarded ground: place one marker where the path begins. Then lay a level stone on that ground. Open the next area so the path can continue. Finally leave one small light — a lantern, a candle, a glow — where a later visitor might see it. Each step is a saved act the server records; no step can be claimed by saying it will be done. The whole path may take more than one visit, because the frontier keeps its own time and a resident can only place so much in one day.',
 steps:Object.freeze([
  Object.freeze({slug:'mark-the-pass',title:'Mark the pass',instructions:'Stand beside a tile in a stewarded plot you can build on and place one frontier block as a marker.',output_name:'A saved marker block on the frontier',source_kind:'frontier_place',requires_review:false,target:1,prerequisite:null}),
  Object.freeze({slug:'level-the-way',title:'Level the way',instructions:'On the same plot place one ground path block where a walker could stand.',output_name:'A saved path block on the ground',source_kind:'path_place',requires_review:false,target:1,prerequisite:'mark-the-pass'}),
  Object.freeze({slug:'widen-the-clearing',title:'Widen the clearing',instructions:'Walk to an unopened frontier passage next to the plot and open the neighbouring area.',output_name:'A saved area-expansion record',source_kind:'frontier_expand',requires_review:false,target:1,prerequisite:'level-the-way'}),
  Object.freeze({slug:'leave-a-light',title:'Leave a light',instructions:'Place one allowed light object in your own garden or cottage as a practice keepsake for the path.',output_name:'A saved home light object',source_kind:'home_furnish',requires_review:false,target:1,prerequisite:'widen-the-clearing'}),
 ]),
}),Object.freeze({
 slug:'commons-trail',title:'The Commons Trail',route:'evidence_research',practice:false,beneficiary:'A shared public map of verified sources',
 summary:'Carry one scoped real question from a leased claim through submission to an independent human acceptance.',
 narrative:'This is a real chain, not a practice one. It exists because some paths through the world need more than a saved block: they need a question, a source, and a different human reviewer who accepts the answer. The first step records the commitment — a leased claim on a real mission task. The second step waits for an independent acceptance of that work. No model, no contributor, and no chain author can mark the second step complete; only the saved review receipt from a different authorized operator can.',
 steps:Object.freeze([
  Object.freeze({slug:'claim-a-task',title:'Claim a scoped real task',instructions:'Claim an open real mission task that has an independent reviewer assigned.',output_name:'A leased claim on a real task',source_kind:'research_claim',requires_review:false,target:1,prerequisite:null}),
  Object.freeze({slug:'submit-and-accept',title:'Wait for independent acceptance',instructions:'Submit sourced work and wait for a different, authorized operator to accept it.',output_name:'An accepted review receipt from another human',source_kind:'research_accepted',requires_review:true,target:1,prerequisite:'claim-a-task'}),
 ]),
})]);

const day=platform=>new Date(platform.clock()).toISOString().slice(0,10);
function owned(platform,actor,input,mutate=false){
 if(!actor?.account||!['session','runtime'].includes(actor.kind))fail(401,'Sign in or use an owned agent runtime.');
 const agent=platform.ownedAgent(actor,input?.agent_id||actor.agent?.id);
 if(agent.status==='deleted')fail(404,'Resident not found.');
 if(mutate){platform.active();if(agent.status!=='active')fail(403,'Resume your resident before changing quest progress.');}
 return agent;
}
export function normalizeQuestSteps(steps,route,practice){
 if(!Array.isArray(steps)||steps.length<STEP_MIN||steps.length>STEP_MAX)fail(400,`Author ${STEP_MIN}–${STEP_MAX} ordered quest steps.`);
 const allowed=QUEST_ROUTES[route],seen=new Set();
 const normalized=steps.map((step,index)=>{
  if(!step||typeof step!=='object'||Array.isArray(step))fail(400,'Each quest step must be an object.');
  const slug=readSlug(step.slug,'Step slug');
  if(seen.has(slug))fail(400,'Each quest step needs its own slug.');
  seen.add(slug);
  const source_kind=step.source_kind;
  if(!allowed.includes(source_kind))fail(400,`A ${route.replaceAll('_',' ')} chain may only use ${allowed.join(', ')}.`);
  const ordinal=step.ordinal===undefined?index+1:Number(step.ordinal);
  if(!Number.isInteger(ordinal)||ordinal!==index+1)fail(400,'Quest steps must be numbered from one without gaps.');
  const requiresReview=source_kind==='research_accepted';
  if(step.requires_review!==undefined&&Boolean(step.requires_review)!==requiresReview)fail(400,'The review boundary is set by the saved fact: only an independently accepted submission requires human review.');
  const target=step.target===undefined?1:Number(step.target);
  if(!Number.isInteger(target)||target<1||target>3)fail(400,'A quest step needs one to three saved facts.');
  const prerequisiteSlug=step.prerequisite===undefined||step.prerequisite===null?(index===0?null:steps[index-1].slug):step.prerequisite;
  if(prerequisiteSlug!==null&&!seen.has(prerequisiteSlug))fail(400,'A quest step prerequisite must name an earlier step in the same chain.');
  return Object.freeze({ordinal,slug,title:readText(step.title,'Step title',80),instructions:readText(step.instructions,'Step instructions',400),output_name:readText(step.output_name,'Step output name',120),source_kind,requires_review:requiresReview?1:0,target,prerequisite:prerequisiteSlug});
 });
 if(route==='evidence_research'&&practice)fail(400,'Real evidence work is never a practice chain.');
 if(practice&&!normalized.every(step=>step.requires_review===0))fail(400,'A practice chain cannot require real contribution review.');
 if(!practice&&normalized[normalized.length-1].source_kind!=='research_accepted')fail(400,'A real evidence chain must end with an independently accepted submission.');
 return normalized;
}
function insertChain(platform,spec,{origin,author,status}){
 const route=spec.route;if(!QUEST_ROUTE_IDS.includes(route))fail(400,'Choose a world-building, gardening or evidence-research route.');
 const practice=Boolean(spec.practice);const beneficiary=practice?'':readText(spec.beneficiary,'Named beneficiary',120);
 if(!practice&&!beneficiary)fail(400,'A real chain must name the beneficiary it is scoped for.');
 const slug=readSlug(spec.slug,'Chain slug');
 if(platform.get('SELECT id FROM quest_chains WHERE slug=? OR id=?',slug,chainId(slug)))fail(409,'A quest chain already uses that slug.');
 const steps=normalizeQuestSteps(spec.steps,route,practice);
 const created=new Date(platform.clock()).toISOString();
 platform.run('INSERT INTO quest_chains VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',chainId(slug),slug,readText(spec.title,'Chain title',80),route,readText(spec.summary,'Chain summary',300),readText(spec.narrative,'Chain narrative',MAX_NARRATIVE),origin,author,status,practice?1:0,beneficiary,created,created);
 for(const step of steps)platform.run('INSERT INTO quest_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',stepId(slug,step.slug),chainId(slug),step.ordinal,step.slug,step.title,step.instructions,step.output_name,step.source_kind,step.requires_review,step.target,step.prerequisite===null?null:stepId(slug,step.prerequisite),created);
 return platform.get('SELECT * FROM quest_chains WHERE id=?',chainId(slug));
}
function chainSteps(platform,chain){return platform.all('SELECT * FROM quest_steps WHERE chain_id=? ORDER BY ordinal',chain.id);}
// An evidence chain's acceptance answers the most recent claim step before it. The claim receipt
// stores a claim ID, which itself pins the exact task and task version. A review of any other claim
// can still be valid real work, but it cannot complete this chain's scoped question.
function creditedClaimStep(steps,step){
 if(step.source_kind!=='research_accepted')return null;
 return steps.filter(candidate=>candidate.ordinal<step.ordinal&&candidate.source_kind==='research_claim').at(-1)||null;
}
export function chainView(platform,chain,{steps=true}={}){
 const view={id:chain.id,slug:chain.slug,title:chain.title,route:chain.route,summary:chain.summary,narrative:chain.narrative,origin:chain.origin,status:chain.status,practice:Boolean(chain.practice),beneficiary:chain.beneficiary,author_account_id:chain.author_account_id,created_at:chain.created_at,updated_at:chain.updated_at};
 if(steps)view.steps=chainSteps(platform,chain).map(step=>({slug:step.slug,ordinal:step.ordinal,title:step.title,instructions:step.instructions,output:{name:step.output_name,source_kind:step.source_kind,requires_review:Boolean(step.requires_review),target:step.target},prerequisite:step.prerequisite_step_id?step.prerequisite_step_id.split('.').pop():null,action:QUEST_ACTIONS[step.source_kind]}));
 return view;
}
function receiptAvailable(platform,receipt){return receipt.source_kind!=='research_accepted'||Boolean(platform.get("SELECT source_id FROM calling_source_events WHERE agent_id=? AND source_kind='research_accepted' AND source_id=?",receipt.agent_id,receipt.source_id));}
function chainProgress(platform,agent,chain){
 const enrollment=platform.get('SELECT * FROM quest_enrollments WHERE agent_id=? AND chain_id=?',agent.id,chain.id)||null;
 const steps=chainSteps(platform,chain);
 const receipts=platform.all('SELECT * FROM calling_receipts WHERE agent_id=? AND objective_id LIKE ? ORDER BY created_at,rowid',agent.id,`quest:${chain.slug}.%`).filter(receipt=>receipt.objective_id.startsWith(`quest:${chain.slug}.`));
 const own=step=>receipts.filter(receipt=>receipt.objective_id===objectiveId(chain.slug,step.slug));
 const views=steps.map(step=>{
  const prerequisite=step.prerequisite_step_id?steps.find(candidate=>candidate.id===step.prerequisite_step_id)||null:null;
  const settled=own(step),have=settled.length,complete=have>=step.target;
  const prerequisiteStep=prerequisite?own(prerequisite).length>=prerequisite.target:true;
  return{step,prerequisite,have,complete,state:complete?'complete':prerequisiteStep?'available':'locked',receipts:settled};
 });
 const next=views.find(view=>view.state==='available')||null;
 const locked=views.find(view=>view.state==='locked')||null;
 return{
  enrolled:Boolean(enrollment),started_at:enrollment?.started_at??null,
  complete:views.every(view=>view.complete),
  steps:views.map(view=>({
   slug:view.step.slug,ordinal:view.step.ordinal,title:view.step.title,instructions:view.step.instructions,state:view.state,
   output:{name:view.step.output_name,source_kind:view.step.source_kind,requires_review:Boolean(view.step.requires_review),target:view.step.target},
   prerequisite:view.prerequisite?{slug:view.prerequisite.slug,title:view.prerequisite.title,ordinal:view.prerequisite.ordinal}:null,
   progress:{have:view.have,target:view.step.target,complete:view.complete},
   action:QUEST_ACTIONS[view.step.source_kind],
   saved_facts:view.receipts.map(receipt=>({source_kind:receipt.source_kind,source_id:receipt.source_id,earned_day:receipt.earned_day,points:receipt.points,available:receiptAvailable(platform,receipt)})),
  })),
  next_action:next?{
   chain_slug:chain.slug,chain_title:chain.title,step_slug:next.step.slug,step_title:next.step.title,ordinal:next.step.ordinal,instructions:next.step.instructions,
   output:{name:next.step.output_name,source_kind:next.step.source_kind,requires_review:Boolean(next.step.requires_review),target:next.step.target},
   progress:{have:next.have,target:next.step.target},action:QUEST_ACTIONS[next.step.source_kind],requires_human_review:Boolean(next.step.requires_review),
  }:null,
  blocked_by:locked?{step_slug:locked.step.slug,title:locked.step.title,prerequisite:locked.prerequisite?{slug:locked.prerequisite.slug,title:locked.prerequisite.title}:null}:null,
 };
}
// Progression: the only writer of a quest step is this function, and it writes exactly the receipt
// the existing calling_receipts constraints already deduplicate on (agent_id, source_kind, source_id)
// and (agent_id, earned_day, objective_id). No client, model or author input reaches it.
export function reconcileQuests(platform,agent,selection){
 const today=day(platform);
 let used=platform.get('SELECT COALESCE(SUM(points),0) AS n FROM calling_receipts WHERE agent_id=? AND earned_day=?',agent.id,today).n;
 if(used>=10)return;
 const chains=platform.all("SELECT c.* FROM quest_enrollments e JOIN quest_chains c ON c.id=e.chain_id WHERE e.agent_id=? AND c.status='published' ORDER BY c.slug",agent.id);
 for(const chain of chains){
  const enrollment=platform.get('SELECT * FROM quest_enrollments WHERE agent_id=? AND chain_id=?',agent.id,chain.id);
  const steps=chainSteps(platform,chain);
  for(const step of steps){
   if(used>=10)return;
   const settled=platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=? AND objective_id=?',agent.id,objectiveId(chain.slug,step.slug)).n;
   if(settled>=step.target)continue;
   if(step.prerequisite_step_id){
    const prerequisite=platform.get('SELECT * FROM quest_steps WHERE id=?',step.prerequisite_step_id);
    const available=prerequisite&&platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=? AND objective_id=?',agent.id,objectiveId(chain.slug,prerequisite.slug)).n>=prerequisite.target;
    if(!available)break;
   }
   // A saved, attributed server fact from this chain's own enrolment onward. A source already used
   // for any other receipt cannot be credited twice, and facts recorded before joining never count.
   const claimStep=chain.route==='evidence_research'?creditedClaimStep(steps,step):null;
   const linkedClaim=claimStep?`AND EXISTS (
     SELECT 1 FROM reviews accepted JOIN submissions answer ON answer.id=accepted.submission_id
     JOIN claims credited ON credited.id=answer.claim_id
     JOIN calling_receipts claim_receipt ON claim_receipt.agent_id=e.agent_id
       AND claim_receipt.source_kind='research_claim' AND claim_receipt.source_id=credited.id
     WHERE accepted.id=e.source_id AND claim_receipt.objective_id=?
   )`:'';
   const event=platform.get(`SELECT e.* FROM calling_source_events e WHERE e.agent_id=? AND e.source_kind=? AND e.occurred_ms>=? AND substr(e.occurred_at,1,10)=? AND NOT EXISTS(SELECT 1 FROM calling_receipts r WHERE r.agent_id=e.agent_id AND r.source_kind=e.source_kind AND r.source_id=e.source_id) ${linkedClaim} ORDER BY e.occurred_at,e.source_id LIMIT 1`,
    agent.id,step.source_kind,Math.max(selection.selected_at,enrollment.started_at),today,...(claimStep?[objectiveId(chain.slug,claimStep.slug)]:[]));
   if(!event)break;
   const row={id:randomUUID(),agent_id:agent.id,account_id:agent.operator_id,calling_id:selection.calling_id,objective_id:objectiveId(chain.slug,step.slug),source_kind:event.source_kind,source_id:event.source_id,source_at:event.occurred_at,selected_at:selection.selected_at,earned_day:today,points:5,created_at:new Date(platform.clock()).toISOString()};
   row.proof_hash=receiptProof(row);
   platform.run('INSERT INTO calling_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',row.id,row.agent_id,row.account_id,row.calling_id,row.objective_id,row.source_kind,row.source_id,row.source_at,row.selected_at,row.earned_day,row.points,row.created_at,row.proof_hash);
   used+=5;
  }
 }
}
// Resolve one receipt objective back to its authored step. Used by the receipt integrity check.
export function questStepFor(db,objective){
 if(typeof objective!=='string'||!objective.startsWith('quest:'))return null;
 const parts=objective.slice(6).split('.');
 if(parts.length!==2)return null;
 return db.prepare('SELECT s.*,c.slug AS chain_slug,c.status AS chain_status,c.practice AS chain_practice,c.route AS chain_route,c.origin AS chain_origin FROM quest_steps s JOIN quest_chains c ON c.id=s.chain_id WHERE c.slug=? AND s.slug=?').get(parts[0],parts[1])||null;
}
export function verifyQuestReceipts(db,agentId=null){
 const rows=db.prepare(`SELECT * FROM calling_receipts WHERE objective_id LIKE 'quest:%'${agentId?' AND agent_id=?':''}`).all(...(agentId?[agentId]:[]));
 for(const row of rows){
  const step=questStepFor(db,row.objective_id);
  if(!step||step.source_kind!==row.source_kind||row.points!==5)return false;
  const enrollment=db.prepare('SELECT * FROM quest_enrollments WHERE agent_id=? AND chain_id=?').get(row.agent_id,step.chain_id);
  if(!enrollment||enrollment.account_id!==row.account_id)return false;
  // The credited fact must be recorded at or after the enrolment that asked for it.
  if(db.prepare('SELECT r.id FROM calling_receipts r WHERE r.id=? AND CAST(round((julianday(r.source_at)-2440587.5)*86400000) AS INTEGER)<COALESCE((SELECT started_at FROM quest_enrollments WHERE agent_id=r.agent_id AND chain_id=?),0)').get(row.id,step.chain_id))return false;
  // This verifier also runs against existing schema-22 databases. Before claim linkage was
  // enforced, a valid accepted review of a different claim could earn this receipt. Such saved
  // history must remain readable; reconcileQuests prevents new mismatches. A later schema
  // migration can mark grandfathered receipts before enforcing this relationship retroactively.
 }
 return true;
}
export function verifyQuestStructure(db){
 const chains=db.prepare('SELECT * FROM quest_chains').all();
 for(const chain of chains)if(!chainStructureValid(db,chain))return false;
 for(const enrollment of db.prepare('SELECT * FROM quest_enrollments').all()){
  const agent=db.prepare('SELECT * FROM agents WHERE id=?').get(enrollment.agent_id);
  if(!agent||agent.operator_id!==enrollment.account_id)return false;
  if(!db.prepare("SELECT id FROM quest_chains WHERE id=? AND status!='draft'").get(enrollment.chain_id))return false;
 }
 return verifyQuestReceipts(db);
}
// One chain's authored shape: identity, route, practice scope, contiguous ordinals, earlier
// prerequisites and the route's own saved-fact kinds. Publishing re-checks it on the chain itself.
export function chainStructureValid(db,chain){
 if(!chain)return false;
 if(chain.id!==chainId(chain.slug)||!QUEST_ROUTE_IDS.includes(chain.route)||!['built_in','operator'].includes(chain.origin)||![0,1].includes(chain.practice)||!['draft','published','archived'].includes(chain.status))return false;
 if(chain.origin==='built_in'?(chain.author_account_id!==null):(chain.author_account_id===null))return false;
 if(chain.practice?Boolean(chain.beneficiary):!chain.beneficiary.trim())return false;
 if(chain.practice&&chain.route==='evidence_research')return false;
 const steps=db.prepare('SELECT * FROM quest_steps WHERE chain_id=? ORDER BY ordinal').all(chain.id);
 if(steps.length<STEP_MIN||steps.length>STEP_MAX)return false;
 if(!steps.every((step,index)=>step.ordinal===index+1))return false;
 if(new Set(steps.map(step=>step.slug)).size!==steps.length)return false;
 const allowed=QUEST_ROUTES[chain.route];
 for(const step of steps){
  if(step.id!==stepId(chain.slug,step.slug)||!allowed.includes(step.source_kind)||![0,1].includes(step.requires_review)||step.target<1||step.target>3)return false;
  if(Boolean(step.requires_review)!==(step.source_kind==='research_accepted'))return false;
  if(step.prerequisite_step_id!==null){
   const prerequisite=steps.find(candidate=>candidate.id===step.prerequisite_step_id);
   if(!prerequisite||prerequisite.ordinal>=step.ordinal)return false;
  } else if(step.ordinal!==1)return false;
 }
 if(!Boolean(chain.practice)&&steps[steps.length-1].source_kind!=='research_accepted')return false;
 return true;
}
export const questMethods={
 // The shipped practice chain is inserted once, exactly like the seeded practice missions: it is a
 // built-in authored chain with no author account and no authority over anything.
 initQuests(){
  // Install each built-in chain exactly once, so adding a new chain to SEED_QUESTS seeds it into an
  // existing world that already has other built-in chains. Identity is the slug; nothing else changes.
  this.transaction(()=>{for(const chain of SEED_QUESTS){if(!this.get('SELECT id FROM quest_chains WHERE slug=?',chain.slug))insertChain(this,chain,{origin:'built_in',author:null,status:'published'});}});
 },
 questAuthor(actor,input){
  if(actor?.kind!=='session'||!['admin','reviewer'].includes(actor.account.role))fail(403,'Authoring a quest chain requires an authorized human reviewer account.');
  this.active();
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Provide a quest chain.');
  const chain=insertChain(this,input,{origin:'operator',author:actor.account.id,status:'draft'});
  this.audit(actor.account.id,'quest.authored',chain.id);
  return chainView(this,chain);
 },
 questManage(actor,input){
  if(actor?.kind!=='session'||!['admin','reviewer'].includes(actor.account.role))fail(403,'Managing a quest chain requires an authorized human reviewer account.');
  const chain=this.get('SELECT * FROM quest_chains WHERE id=? OR slug=?',input?.chain_id||'',input?.chain_id||input?.slug||'');
  if(!chain)fail(404,'Quest chain not found.');
  if(chain.origin==='built_in'&&actor.account.role!=='admin')fail(403,'Only an administrator can manage a shipped practice chain.');
  if(chain.origin==='operator'&&actor.account.role!=='admin'&&chain.author_account_id!==actor.account.id)fail(403,'Only the authoring operator or an administrator can manage this chain.');
  const status={publish:'published',draft:'draft',archive:'archived'}[input?.action];
  if(!status)fail(400,'Choose publish, draft or archive.');
  if(status==='published'){
   const steps=chainSteps(this,chain);
   if(!steps.length)fail(409,'Author at least two ordered steps before publishing.');
   if(!chainStructureValid(this.db,chain))fail(409,'This chain is incomplete; check its ordered steps, route and prerequisites.');
  }
  this.run('UPDATE quest_chains SET status=?,updated_at=? WHERE id=?',status,new Date(this.clock()).toISOString(),chain.id);
  this.audit(actor.account.id,`quest.${status}`,chain.id);
  return chainView(this,this.get('SELECT * FROM quest_chains WHERE id=?',chain.id));
 },
 questJoin(actor,input,key){
  if(actor?.kind!=='session')fail(403,'Only the signed-in human operator can begin a quest chain for a resident.');
  const agent=owned(this,actor,input,true);
  readText(key,'Idempotency key',100);
  const chain=this.get('SELECT * FROM quest_chains WHERE id=? OR slug=?',input?.chain_id||'',input?.chain_id||input?.slug||'');
  if(!chain)fail(404,'Quest chain not found.');
  if(chain.status!=='published')fail(409,'This quest chain is not open.');
  const previous=this.get('SELECT * FROM quest_enrollments WHERE account_id=? AND idempotency_key=?',actor.account.id,key);
  if(previous){if(previous.agent_id!==agent.id||previous.chain_id!==chain.id)fail(409,'This idempotency key was used for another quest chain.');return{...chainProgress(this,agent,chain),chain_id:chain.id,repeated:true};}
  const existing=this.get('SELECT * FROM quest_enrollments WHERE agent_id=? AND chain_id=?',agent.id,chain.id);
  if(!existing)this.run('INSERT INTO quest_enrollments VALUES(?,?,?,?,?,?,?)',randomUUID(),agent.id,actor.account.id,chain.id,this.clock(),key,new Date(this.clock()).toISOString());
  this.audit(actor.account.id,'quest.joined',chain.id);
  return{...chainProgress(this,agent,chain),chain_id:chain.id,repeated:Boolean(existing)};
 },
 questLeave(actor,input){
  if(actor?.kind!=='session')fail(403,'Only the signed-in human operator can leave a quest chain for a resident.');
  const agent=owned(this,actor,input,true);
  const chain=this.get('SELECT * FROM quest_chains WHERE id=? OR slug=?',input?.chain_id||'',input?.chain_id||input?.slug||'');
  if(!chain)fail(404,'Quest chain not found.');
  const result=this.run('DELETE FROM quest_enrollments WHERE agent_id=? AND chain_id=?',agent.id,chain.id);
  this.audit(actor.account.id,'quest.left',chain.id);
  return{chain_id:chain.id,left:result.changes>0,note:'Recorded step receipts stay historical, exactly like calling receipts.'};
 },
 // Deliberately refused. A quest step has no completion endpoint: the receipt is written only by the
 // server, from a saved fact. This route exists so the boundary is explicit and testable.
 questComplete(actor,input={}){
  if(!actor?.account)fail(401,'Sign in to record progress.');
  if(input.agent_id)owned(this,actor,input);
  this.audit(actor.account.id,'quest.completion_refused',typeof input.chain_id==='string'?input.chain_id.slice(0,80):'');
  fail(400,'A quest step advances only from a saved server fact. Do the activity in the world or through the mission workflow and the server credits the step once; a client, a model or a chain author cannot mark it complete.');
 },
 quests(actor,input={}){
  const agent=owned(this,actor,input);
  // One shared cosmetic pass: the resident's calling objectives are reconciled first and the enrolled
  // quest steps after them, exactly as the calling view does, so both endpoints always agree.
  this.callings(actor,{agent_id:agent.id});
  const visible=this.all("SELECT * FROM quest_chains WHERE status='published' OR (origin='operator' AND author_account_id=?) ORDER BY CASE origin WHEN 'built_in' THEN 0 ELSE 1 END,slug",actor.account.id);
  const chains=visible.map(chain=>({...chainView(this,chain),...chainProgress(this,agent,chain)}));
  const enrolled=chains.filter(chain=>chain.enrolled);
  return{agent_id:agent.id,chains,enrolled_count:enrolled.length,
   next_action:enrolled.find(chain=>chain.next_action)?.next_action||null,
   progress:enrolled.map(chain=>({chain_slug:chain.slug,chain_title:chain.title,complete:chain.complete,steps:chain.steps.map(step=>({slug:step.slug,ordinal:step.ordinal,state:step.state,have:step.progress.have,target:step.progress.target,saved_fact_count:step.saved_facts.length}))})),
   can_author:actor.kind==='session'&&['admin','reviewer'].includes(actor.account.role),
   policy:QUEST_POLICY,server_time:this.clock()};
 },
 questCatalog(input={}){
  const limit=input.limit===undefined?20:Number(input.limit),offset=input.offset===undefined?0:Number(input.offset),query=typeof input.q==='string'?input.q.trim().slice(0,80):'';
  if(!Number.isInteger(limit)||limit<1||limit>20||!Number.isInteger(offset)||offset<0||offset>100000)fail(400,'Use a quest page of one to twenty chains.');
  const match=`status='published'${query?' AND (title LIKE ? OR summary LIKE ? OR slug LIKE ?)':''}`,args=query?[`%${query}%`,`%${query}%`,`%${query}%`]:[];
  const chains=this.all(`SELECT * FROM quest_chains WHERE ${match} ORDER BY slug LIMIT ? OFFSET ?`,...args,limit,offset);
  const total=this.get(`SELECT COUNT(*) AS n FROM quest_chains WHERE ${match}`,...args).n;
  return{chains:chains.map(chain=>chainView(this,chain)),total,offset,limit,has_more:offset+limit<total,routes:QUEST_ROUTE_IDS,policy:QUEST_POLICY};
 },
 questExport(actor){
  if(actor?.kind!=='session')fail(403,'Only your operator can export quest records.');
  const chainIds=JSON.stringify(this.all('SELECT id FROM quest_chains WHERE author_account_id=?',actor.account.id).map(row=>row.id));
  return{
   enrollments:this.all('SELECT e.* FROM quest_enrollments e JOIN agents a ON a.id=e.agent_id WHERE a.operator_id=? ORDER BY e.created_at',actor.account.id),
   receipts:this.all('SELECT * FROM calling_receipts WHERE account_id=? AND objective_id LIKE \'quest:%\' ORDER BY created_at',actor.account.id),
   authored:this.all('SELECT * FROM quest_chains WHERE id IN (SELECT value FROM json_each(?)) ORDER BY slug',chainIds).map(chain=>({...chainView(this,chain),author_account_id:chain.author_account_id})),
  };
 },
 deleteQuests(actor){
  if(actor?.kind!=='session')fail(403,'Only your operator can delete quest records.');
  // Step receipts are part of the calling receipts the operator already deletes. An authored chain is
  // archived rather than deleted so another resident's recorded progress keeps its reference.
  this.run('DELETE FROM quest_enrollments WHERE agent_id IN (SELECT id FROM agents WHERE operator_id=?)',actor.account.id);
  this.run("UPDATE quest_chains SET status='archived',updated_at=? WHERE origin='operator' AND author_account_id=? AND status!='archived'",new Date(this.clock()).toISOString(),actor.account.id);
  return{deleted:true};
 },
};
