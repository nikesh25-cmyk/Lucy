import {randomUUID} from 'node:crypto';
import {CALLINGS} from './vocations.js';
import {normalizeSources} from './community.js';

// Guild projects are the practical side of a calling affiliation: a board of scoped cooperative
// work with explicit participation. A guild project is NOT a role, a calling or an account
// authority. Joining one neither grants nor requires a calling, and it never creates land, review,
// moderation or coin rights. Contributions are verified by a *different operator* and can never
// mint a coin; the coin ledger in src/coins.js is untouched.
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const text=(value,label,maximum,optional=false)=>{
 if(optional&&(value==null||value===''))return '';
 if(typeof value!=='string'||!value.trim()||value.length>maximum)fail(400,`${label} must contain ${optional?0:'1'}–${maximum} characters.`);
 return value.trim();
};
const readSlug=(value,label)=>{if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]{1,39}$/.test(value))fail(400,`${label} must be a lowercase slug of 2–40 letters, digits or dashes.`);return value;};
const date=platform=>new Date(platform.clock()).toISOString();
const visibleAgent="a.status IN ('active','paused') AND o.status='active'";

export const GUILD_IDS=Object.freeze(CALLINGS.map(calling=>calling.id));
const ids=GUILD_IDS.map(id=>`'${id}'`).join(',');
const WORKSTREAM_MAX=6,PARTICIPANT_MAX=100,PARTICIPATIONS_PER_AGENT=12,PROJECTS_PER_OPERATOR=10,CONTRIBUTION_LIMIT=200,PARTICIPANT_LIMIT=100;

// A contribution's state is the only thing that decides whether it may read as a completed outcome.
// A pledge is an intention, a submitted row is an unverified claim, and only an independently
// verified row is shown as a completed outcome — labelled as community peer verification, never
// as mission human review and never as a coin.
export const GUILD_OUTCOMES=Object.freeze({
 pledged:Object.freeze({code:'pledge',label:'A pledge: an intention to contribute, not completed work',completed:false,verified:false}),
 submitted:Object.freeze({code:'unverified_claim',label:'Submitted evidence: a claim no different operator has verified yet',completed:false,verified:false}),
 changes_requested:Object.freeze({code:'changes_requested',label:'Changes requested: this claim was not verified',completed:false,verified:false}),
 verified:Object.freeze({code:'verified',label:'Independently verified by a different operator; community peer verification, not mission review and never a coin',completed:true,verified:true}),
});
export const GUILD_ROLES=Object.freeze(['organiser','member']);
export const GUILD_STATES=Object.freeze(['active','paused']);
export const GUILD_STATUSES=Object.freeze(['open','closed','archived']);
export const GUILD_VISIBILITIES=Object.freeze(['public','private']);
export const guildName=id=>CALLINGS.find(calling=>calling.id===id)?.guild_name||'';
export const GUILD_PROJECT_POLICY=Object.freeze({
 version:1,
 workstreams_max:WORKSTREAM_MAX,
 participants_max:PARTICIPANT_MAX,
 participations_per_agent_max:PARTICIPATIONS_PER_AGENT,
 projects_per_operator:PROJECTS_PER_OPERATOR,
 visibility:GUILD_VISIBILITIES,
 participation_actions:['join','leave','pause','resume'],
 roles:GUILD_ROLES,
 coins_awarded:0,
 grants_calling:false,
 grants_land:false,
 grants_role:false,
 grants_moderator:false,
 grants_reviewer:false,
 independence:'A contribution is verified only by an operator who is neither the contributor\u2019s operator nor the project creator\u2019s operator. Several characters of one operator are not a second operator, and an organiser has no reviewer right.',
 description:'A guild project is a scoped plan for bounded cooperation. Participation is explicit and revocable, contributions are verified by a different operator, and nothing here grants a calling, an account role, a plot, building rights, moderator or reviewer authority, or a NemoCoin.',
});

// Authored sample plans for guild projects. Each is a complete, cooperative brief: a guild, a title,
// a purpose, and one to six workstreams with named outputs. A project is created from a plan by the
// operator, but the authored brief itself is content: it names the evidence bar and the review boundary
// (independent peer verification by a different operator) so a reviewer can judge the plan before it
// is used. Nothing here grants a calling, role, land right or coin.
export const SAMPLE_GUILD_PLANS=Object.freeze([Object.freeze({
 slug:'commons-cartography',
 guild_id:'explorer',
 title:'The Commons Cartography',
 summary:'A shared map of accessible routes through the Commons: trace one path, note one obstacle, confirm one waypoint, and verify each entry is independently checked.',
 plan:Object.freeze([
  Object.freeze({id:'trace-route',title:'Trace one accessible route',output_name:'A traced route with start and end',scope:'Walk a route through the Commons and record the tiles actually passable.'}),
  Object.freeze({id:'note-obstacle',title:'Note one obstacle',output_name:'An obstacle record with a workaround',scope:'Record one place that blocks a walker and the alternate tiles around it.'}),
  Object.freeze({id:'confirm-waypoint',title:'Confirm one waypoint',output_name:'A verified waypoint',scope:'Stand at a crossing and record what is actually there.'}),
 ]),
})]);

const jsonArray=value=>{try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:null;}catch{return null;}};
export function normalizeGuildPlan(plan){
 if(!Array.isArray(plan)||plan.length<1||plan.length>WORKSTREAM_MAX)fail(400,`Describe one to ${WORKSTREAM_MAX} planned workstreams.`);
 const seen=new Set();
 return plan.map(entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))fail(400,'Each planned workstream must be an object.');
  const id=readSlug(entry.id,'Workstream id');
  if(seen.has(id))fail(400,'Each planned workstream needs its own id.');
  seen.add(id);
  return{id,title:text(entry.title,'Workstream title',120),output_name:text(entry.output_name,'Workstream output name',160),scope:text(entry.scope,'Workstream scope',300)};
 });
}

export const GUILD_SCHEMA=`
 CREATE TABLE IF NOT EXISTS guild_projects(
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL CHECK(guild_id IN (${ids})),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  plan TEXT NOT NULL CHECK(json_valid(plan) AND json_type(plan)='array'),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','archived')),
  creator_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  management_reason TEXT NOT NULL DEFAULT ''
 );
 CREATE TABLE IF NOT EXISTS guild_participants(
  project_id TEXT NOT NULL REFERENCES guild_projects(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL CHECK(role IN ('organiser','member')),
  state TEXT NOT NULL CHECK(state IN ('active','paused')),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,agent_id)
 );
 CREATE TABLE IF NOT EXISTS guild_contributions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES guild_projects(id),
  workstream_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  commitment TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sources) AND json_type(sources)='array'),
  status TEXT NOT NULL CHECK(status IN ('pledged','submitted','verified','changes_requested')),
  review_note TEXT NOT NULL DEFAULT '',
  submitted_at TEXT,
  verified_by_agent_id TEXT REFERENCES agents(id),
  verified_by_account_id TEXT REFERENCES accounts(id),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,workstream_id,agent_id),
  CHECK((status='pledged')=(submitted_at IS NULL)),
  CHECK((status='verified')=(verified_by_account_id IS NOT NULL AND verified_by_agent_id IS NOT NULL AND verified_at IS NOT NULL))
 );
 CREATE INDEX IF NOT EXISTS guild_projects_board ON guild_projects(visibility,status,guild_id,created_at);
 CREATE INDEX IF NOT EXISTS guild_projects_creator ON guild_projects(creator_agent_id,status);
 CREATE INDEX IF NOT EXISTS guild_participants_agent ON guild_participants(agent_id,project_id);
 CREATE INDEX IF NOT EXISTS guild_contributions_project ON guild_contributions(project_id,workstream_id,status);
 CREATE INDEX IF NOT EXISTS guild_contributions_account ON guild_contributions(account_id,created_at);
 CREATE TRIGGER IF NOT EXISTS guild_projects_identity_immutable BEFORE UPDATE ON guild_projects WHEN NEW.id!=OLD.id OR NEW.guild_id!=OLD.guild_id OR NEW.creator_agent_id!=OLD.creator_agent_id OR NEW.created_at!=OLD.created_at OR (NEW.visibility!=OLD.visibility AND NOT(OLD.visibility='private' AND NEW.visibility='public')) BEGIN SELECT RAISE(ABORT,'A guild project keeps its identity, guild and visibility'); END;
 CREATE TRIGGER IF NOT EXISTS guild_projects_keep_records BEFORE DELETE ON guild_projects WHEN EXISTS(SELECT 1 FROM guild_contributions WHERE project_id=OLD.id) BEGIN SELECT RAISE(ABORT,'A guild project with contributions is archived, never deleted'); END;
`;

// One whole-database check, called by validateDatabase: every stored guild row must still satisfy
// the rules this module enforces at write time, including the distinct-operator verification rule.
export function verifyGuildRecords(db){
 const planValid=db.prepare(`SELECT p.id FROM guild_projects p WHERE p.guild_id NOT IN (${ids}) OR p.visibility NOT IN ('public','private') OR p.status NOT IN ('open','closed','archived') OR p.plan IS NULL OR NOT json_valid(p.plan) OR json_type(p.plan)!='array' OR length(p.title)NOT BETWEEN 1 AND 100 OR length(p.summary)NOT BETWEEN 1 AND 1200`).get();
 if(planValid)return false;
 if(db.prepare("SELECT g.project_id FROM guild_participants g LEFT JOIN guild_projects p ON p.id=g.project_id LEFT JOIN agents a ON a.id=g.agent_id WHERE p.id IS NULL OR a.id IS NULL OR g.role NOT IN ('organiser','member') OR g.state NOT IN ('active','paused')").get())return false;
 if(db.prepare("SELECT c.id FROM guild_contributions c LEFT JOIN guild_projects p ON p.id=c.project_id LEFT JOIN agents a ON a.id=c.agent_id WHERE p.id IS NULL OR a.id IS NULL OR c.account_id!=a.operator_id OR c.status NOT IN ('pledged','submitted','verified','changes_requested') OR NOT json_valid(c.sources) OR json_type(c.sources)!='array' OR (c.status='pledged')!=(c.submitted_at IS NULL) OR (c.status='verified')!=(c.verified_by_account_id IS NOT NULL)").get())return false;
 // An independent verification is structural: the verifying operator is neither the contributor's
 // operator nor the project creator's operator, so the rule survives a backup and a restore.
 if(db.prepare("SELECT c.id FROM guild_contributions c JOIN guild_projects p ON p.id=c.project_id JOIN agents creator ON creator.id=p.creator_agent_id WHERE c.status='verified' AND (c.verified_by_account_id=c.account_id OR c.verified_by_account_id=creator.operator_id)").get())return false;
 return true;
}

const pagination=(value,fallback,max)=>{
 if(value===undefined||value==='')return fallback;
 const number=Number(value);
 if(!Number.isInteger(number)||number<0||number>max)fail(400,'Invalid guild project page size or offset.');
 return number;
};

export const guildMethods={
 initGuilds(){this.db.exec(GUILD_SCHEMA);},
 // The visibility rule is the whole privacy boundary: a private project exists only for the
 // operator whose resident created it (and for an administrator reviewing the installation).
 guildProjectRecord(projectId,actor,{active=true}={}){
  const record=this.get('SELECT p.*,a.name AS creator_name,a.status AS creator_status,o.status AS creator_operator_status,a.operator_id AS creator_operator_id FROM guild_projects p JOIN agents a ON a.id=p.creator_agent_id JOIN accounts o ON o.id=a.operator_id WHERE p.id=?',projectId||'');
  if(!record)fail(404,'This guild project is unavailable.');
  const administrator=actor?.kind==='session'&&actor.account.role==='admin';
  const creator=actor?.kind==='session'&&record.creator_operator_id===actor.account.id;
  if(record.visibility==='private'&&!creator&&!administrator)fail(404,'This guild project is unavailable.');
  if(active&&record.status==='archived')fail(404,'This guild project is unavailable.');
  return record;
 },
 guildProjectView(record,viewerAgentId=''){
  const {creator_operator_id,creator_operator_status,...safe}=record;
  const plan=jsonArray(record.plan)||[];
  const participants=this.all(`SELECT p.agent_id,a.name,a.kind,p.role,p.state,p.joined_at FROM guild_participants p JOIN agents a ON a.id=p.agent_id JOIN accounts o ON o.id=a.operator_id WHERE p.project_id=? AND ${visibleAgent} ORDER BY p.joined_at,p.agent_id LIMIT ?`,record.id,PARTICIPANT_LIMIT);
  const contributions=this.all(`SELECT c.*,a.name AS agent_name,a.kind AS agent_kind FROM guild_contributions c JOIN agents a ON a.id=c.agent_id WHERE c.project_id=? ORDER BY c.created_at,c.workstream_id LIMIT ?`,record.id,CONTRIBUTION_LIMIT);
  const viewer=viewerAgentId?this.get('SELECT role,state FROM guild_participants WHERE project_id=? AND agent_id=?',record.id,viewerAgentId)||null:null;
  // A contribution's own participation state is read from its row, not from the visible participant
  // list, so a hidden or suspended participant is never mislabelled as having left.
  const stateOf=new Map(this.all('SELECT agent_id,role,state FROM guild_participants WHERE project_id=?',record.id).map(item=>[item.agent_id,item]));
  const view=contributions.map(contribution=>({
   id:contribution.id,workstream_id:contribution.workstream_id,workstream_title:plan.find(item=>item.id===contribution.workstream_id)?.title||null,
   agent_id:contribution.agent_id,agent_name:contribution.agent_name,agent_kind:contribution.agent_kind,
   participant:{role:stateOf.get(contribution.agent_id)?.role||null,state:stateOf.get(contribution.agent_id)?.state||'left'},
   commitment:contribution.commitment,evidence:contribution.evidence,sources:jsonArray(contribution.sources)||[],review_note:contribution.review_note,
   status:contribution.status,outcome:GUILD_OUTCOMES[contribution.status],
   committed_at:contribution.created_at,submitted_at:contribution.submitted_at,verified_at:contribution.verified_at,
   verified_by:contribution.verified_by_agent_id?this.get("SELECT name FROM agents WHERE id=? AND status IN ('active','paused')",contribution.verified_by_agent_id)?.name||'A former participant':null,
  }));
  const workstreams=plan.map(workstream=>{
   const rows=view.filter(item=>item.workstream_id===workstream.id);
   return{...workstream,committed:rows.filter(r=>r.status==='pledged').length,claimed:rows.filter(r=>r.status==='submitted'||r.status==='changes_requested').length,verified:rows.filter(r=>r.status==='verified').length};
  });
  const verifiedWorkstreams=workstreams.filter(workstream=>workstream.verified>0).length;
  return{
   ...safe,plan,guild_name:guildName(record.guild_id),
   participation:{count:participants.length,active:participants.filter(item=>item.state==='active').length,paused:participants.filter(item=>item.state==='paused').length,organisers:participants.filter(item=>item.role==='organiser').length,joined:Boolean(viewer),role:viewer?.role||null,state:viewer?.state||null},
   participants:participants.map(item=>({id:item.agent_id,name:item.name,kind:item.kind,role:item.role,state:item.state,joined_at:item.joined_at})),
   contributions:view,
   shared_status:{
    workstreams,
    totals:{planned_workstreams:workstreams.length,commitments:view.filter(r=>r.status==='pledged').length,claims:view.filter(r=>r.status==='submitted'||r.status==='changes_requested').length,verified_contributions:view.filter(r=>r.status==='verified').length,participants:participants.length,active_participants:participants.filter(item=>item.state==='active').length,paused_participants:participants.filter(item=>item.state==='paused').length},
    verified_workstreams:verifiedWorkstreams,all_workstreams_verified:workstreams.length>0&&verifiedWorkstreams===workstreams.length,
    note:'A pledge is an intention and a submitted contribution is an unverified claim; neither is a completed outcome. Only an independently verified contribution is shown as completed, and that is community peer verification: it is not mission human review and it never issues a NemoCoin.',
   },
   policy:GUILD_PROJECT_POLICY,
  };
 },
 guilds(actor,input={}){
  const limit=pagination(input.limit,12,24),offset=pagination(input.offset,0,1000000);
  if(!limit)fail(400,'Guild project page size must be positive.');
  const query=input.q==null?'':text(input.q,'Guild project search',80,true);
  const guildId=input.guild_id||'';
  if(guildId&&!GUILD_IDS.includes(guildId))fail(400,'Choose a listed guild.');
  let viewerAgentId=actor?.kind==='runtime'?actor.agent.id:'';
  if(input.agent_id){if(!actor)fail(401,'Sign in to select your character.');viewerAgentId=this.ownedAgent(actor,input.agent_id).id;}
  const clauses=["(p.visibility='public' OR p.creator_agent_id IN (SELECT id FROM agents WHERE operator_id=?))","p.status!='archived'"],values=[actor?.account?.id||''];
  if(guildId){clauses.push('p.guild_id=?');values.push(guildId);}
  if(query){clauses.push('(instr(lower(p.title),lower(?))>0 OR instr(lower(p.summary),lower(?))>0)');values.push(query,query);}
  const where=clauses.join(' AND ');
  const total=this.get(`SELECT COUNT(*) AS n FROM guild_projects p WHERE ${where}`,...values).n;
  const projects=this.all(`SELECT p.*,a.name AS creator_name FROM guild_projects p JOIN agents a ON a.id=p.creator_agent_id WHERE ${where} ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?`,...values,limit,offset);
  return{
   guilds:CALLINGS.map(calling=>({guild_id:calling.id,name:calling.name,guild_name:calling.guild_name,purpose:calling.purpose,charter:calling.charter})),
   projects:projects.map(project=>this.guildProjectView(project,viewerAgentId)),
   guild_id:guildId,total,offset,limit,has_more:offset+limit<total,viewer_agent_id:viewerAgentId||null,policy:GUILD_PROJECT_POLICY,
  };
 },
 guildProject(actor,input={}){
  const record=this.guildProjectRecord(input.id||input.project_id,actor);
  const viewerAgentId=actor?.kind==='runtime'?actor.agent.id:input.agent_id&&actor?.kind==='session'?this.ownedAgent(actor,input.agent_id).id:'';
  return this.guildProjectView(record,viewerAgentId);
 },
 guildProjectCreate(actor,input){
  if(actor?.kind!=='session')fail(403,'Only the signed-in human operator can start a guild project for a resident.');
  const agent=this.communityAgent(actor,input);
  const existing=this.get("SELECT COUNT(*) AS n FROM guild_projects p JOIN agents a ON a.id=p.creator_agent_id WHERE a.operator_id=? AND p.status!='archived'",agent.operator_id).n;
  if(existing>=PROJECTS_PER_OPERATOR)fail(429,'This operator has reached the active guild project limit.');
  if(!GUILD_IDS.includes(input.guild_id))fail(400,'Choose a listed guild for this project.');
  const visibility=input.visibility===undefined?'public':input.visibility;
  if(!GUILD_VISIBILITIES.includes(visibility))fail(400,'Choose public or private visibility.');
  const plan=normalizeGuildPlan(input.plan),id=randomUUID(),created=date(this);
  this.run('INSERT INTO guild_projects VALUES(?,?,?,?,?,?,?,?,?,?)',id,input.guild_id,text(input.title,'Guild project title',100),text(input.summary,'Guild project purpose',1200),JSON.stringify(plan),visibility,'open',agent.id,created,'');
  // The creating resident is the organiser. That is a project membership role only: it grants no
  // account role, no moderator or reviewer authority, no plot and no building right.
  this.run('INSERT INTO guild_participants VALUES(?,?,?,?,?,?)',id,agent.id,'organiser','active',created,created);
  this.audit(actor.account.id,'guild.project.created',id);
  return this.guildProjectView(this.guildProjectRecord(id,actor),agent.id);
 },
 guildParticipation(actor,input){
  const agent=this.communityAgent(actor,input);
  const project=this.guildProjectRecord(input.project_id,actor);
  if(!['join','leave','pause','resume'].includes(input.action))fail(400,'Choose join, leave, pause or resume.');
  const existing=this.get('SELECT * FROM guild_participants WHERE project_id=? AND agent_id=?',project.id,agent.id);
  if(input.action==='join'){
   if(project.status!=='open')fail(409,'This guild project is not open to new participants.');
   if(!existing){
    if(this.get('SELECT COUNT(*) AS n FROM guild_participants WHERE project_id=?',project.id).n>=PARTICIPANT_MAX)fail(409,'This guild project has reached its participant limit.');
    if(this.get('SELECT COUNT(*) AS n FROM guild_participants WHERE agent_id=?',agent.id).n>=PARTICIPATIONS_PER_AGENT)fail(429,`A character can join ${PARTICIPATIONS_PER_AGENT} guild projects.`);
    const now=date(this);
    this.run('INSERT INTO guild_participants VALUES(?,?,?,?,?,?)',project.id,agent.id,'member','active',now,now);
    this.audit(actor.account.id,'guild.joined',project.id);
   }
   return{project_id:project.id,joined:true,state:existing?.state||'active',role:existing?.role||'member',note:'Joining is participation only. It grants no calling, role, plot, building right, moderator or reviewer authority.'};
  }
  if(!existing)fail(404,'This resident is not a participant of that guild project.');
  if(input.action==='pause'){
   if(existing.state!=='paused'){this.run("UPDATE guild_participants SET state='paused',updated_at=? WHERE project_id=? AND agent_id=?",date(this),project.id,agent.id);this.audit(actor.account.id,'guild.paused',project.id);}
   return{project_id:project.id,paused:true,state:'paused',note:'Standing commitments stay recorded and are shown as paused; a paused participant cannot submit new evidence.'};
  }
  if(input.action==='resume'){
   if(project.status!=='open')fail(409,'This guild project is not open; ask its organiser to reopen it before resuming.');
   if(existing.state!=='active'){this.run("UPDATE guild_participants SET state='active',updated_at=? WHERE project_id=? AND agent_id=?",date(this),project.id,agent.id);this.audit(actor.account.id,'guild.resumed',project.id);}
   return{project_id:project.id,resumed:true,state:'active'};
  }
  // Leaving withdraws every unsubmitted commitment so the plan stops counting a resident who is no
  // longer participating. Submitted and verified contributions stay recorded as attributed history.
  const withdrawn=this.run("DELETE FROM guild_contributions WHERE project_id=? AND agent_id=? AND status='pledged'",project.id,agent.id).changes;
  this.run('DELETE FROM guild_participants WHERE project_id=? AND agent_id=?',project.id,agent.id);
  this.audit(actor.account.id,'guild.left',project.id);
  return{project_id:project.id,left:true,withdrawn_commitments:withdrawn,note:'Unsubmitted commitments were withdrawn. Submitted and verified contributions stay recorded as history.'};
 },
 guildContribution(actor,input){
  const agent=this.communityAgent(actor,input);
  const project=this.guildProjectRecord(input.project_id,actor);
  if(!['pledge','submit','withdraw'].includes(input.action))fail(400,'Choose pledge, submit or withdraw.');
  const workstream=(jsonArray(project.plan)||[]).find(item=>item.id===input.workstream_id);
  if(!workstream)fail(404,'Choose a planned workstream of this guild project.');
  const participant=this.get('SELECT * FROM guild_participants WHERE project_id=? AND agent_id=?',project.id,agent.id);
  if(!participant)fail(403,'Join this guild project before contributing.');
  if(input.action!=='withdraw'&&project.status!=='open')fail(409,'This guild project is not open for new contributions.');
  if(input.action!=='withdraw'&&participant.state!=='active')fail(403,'Resume your participation before contributing.');
  const existing=this.get('SELECT * FROM guild_contributions WHERE project_id=? AND workstream_id=? AND agent_id=?',project.id,workstream.id,agent.id);
  const now=date(this);
  if(input.action==='pledge'){
   if(existing&&['submitted','verified'].includes(existing.status))fail(409,'This workstream contribution is already submitted and cannot be re-pledged.');
   const commitment=text(input.commitment,'Contribution commitment',500);
   if(existing)this.run("UPDATE guild_contributions SET commitment=?,status='pledged',evidence='',sources='[]',review_note='',submitted_at=NULL,verified_by_agent_id=NULL,verified_by_account_id=NULL,verified_at=NULL,updated_at=? WHERE id=?",commitment,now,existing.id);
   else this.run('INSERT INTO guild_contributions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),project.id,workstream.id,agent.id,agent.operator_id,commitment,'','[]','pledged','',null,null,null,null,now,now);
   this.audit(actor.account.id,'guild.pledged',project.id);
  } else if(input.action==='submit'){
   if(!existing||!['pledged','changes_requested'].includes(existing.status))fail(409,'Pledge this workstream before submitting evidence.');
   const evidence=text(input.evidence,'Contribution evidence',4000),sources=normalizeSources(input.sources||[]);
   this.run("UPDATE guild_contributions SET status='submitted',evidence=?,sources=?,review_note='',submitted_at=?,verified_by_agent_id=NULL,verified_by_account_id=NULL,verified_at=NULL,updated_at=? WHERE id=?",evidence,JSON.stringify(sources),now,now,existing.id);
   this.audit(actor.account.id,'guild.submitted',project.id);
  } else {
   if(!existing||existing.status!=='pledged')fail(409,'Only an unsubmitted commitment can be withdrawn.');
   this.run('DELETE FROM guild_contributions WHERE id=?',existing.id);
   this.audit(actor.account.id,'guild.withdrawn',project.id);
  }
  return this.guildProjectView(this.guildProjectRecord(project.id,actor),agent.id);
 },
 guildVerify(actor,input){
  const verifier=this.communityAgent(actor,input);
  const project=this.guildProjectRecord(input.project_id,actor);
  if(!['approve','changes_requested'].includes(input.action))fail(400,'Choose approve or changes_requested.');
  const contribution=this.get('SELECT * FROM guild_contributions WHERE id=? AND project_id=?',input.contribution_id||'',project.id);
  if(!contribution)fail(404,'Guild contribution not found.');
  if(contribution.status!=='submitted')fail(409,'This contribution is not awaiting verification.');
  const contributor=this.get('SELECT a.operator_id,a.status,o.status AS operator_status FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=?',contribution.agent_id);
  if(!contributor||!['active','paused'].includes(contributor.status)||contributor.operator_status!=='active')fail(409,'The contributing character is unavailable.');
  // The same distinct-operator rule the milestone peer confirmation uses: independence is decided by
  // operator, never by character, and an organiser has no reviewer right inside its own project.
  if([contributor.operator_id,project.creator_operator_id].includes(actor.account.id))fail(403,'A different operator must verify this contribution.');
  const reason=text(input.reason,'Verification reason',1000),now=date(this);
  if(input.action==='approve')this.run("UPDATE guild_contributions SET status='verified',review_note=?,verified_by_agent_id=?,verified_by_account_id=?,verified_at=?,updated_at=? WHERE id=?",reason,verifier.id,actor.account.id,now,now,contribution.id);
  else this.run("UPDATE guild_contributions SET status='changes_requested',review_note=?,verified_by_agent_id=NULL,verified_by_account_id=NULL,verified_at=NULL,updated_at=? WHERE id=?",reason,now,contribution.id);
  this.audit(actor.account.id,`guild.contribution.${input.action}`,project.id);
  return this.guildProjectView(this.guildProjectRecord(project.id,actor),verifier.id);
 },
 guildProjectManage(actor,input){
  if(!actor||actor.kind!=='session')fail(403,'A human operator session is required.');
  if(!['share','close','reopen','archive'].includes(input.action))fail(400,'Choose share, close, reopen or archive.');
  const record=this.get('SELECT p.*,a.operator_id AS creator_operator_id FROM guild_projects p JOIN agents a ON a.id=p.creator_agent_id WHERE p.id=?',input.id||input.project_id||'');
  if(!record)fail(404,'Guild project not found.');
  if(record.creator_operator_id!==actor.account.id&&!['admin','moderator'].includes(actor.account.role))fail(403,'Only the creating operator or a moderator can manage this guild project.');
  const reason=text(input.reason,'Guild project management reason',500);
  if(input.action==='share'){
   if(record.visibility==='public')return{id:record.id,visibility:'public',status:record.status,shared:false};
   this.run("UPDATE guild_projects SET visibility='public' WHERE id=?",record.id);
   this.audit(actor.account.id,'guild.project.shared',record.id);
   return{id:record.id,visibility:'public',status:record.status,shared:true};
  }
  const status={close:'closed',reopen:'open',archive:'archived'}[input.action];
  this.run('UPDATE guild_projects SET status=?,management_reason=? WHERE id=?',status,reason,record.id);
  this.audit(actor.account.id,`guild.project.${status}`,record.id);
  return{id:record.id,visibility:record.visibility,status,reason};
 },
 guildExport(actor){
  if(!actor||actor.kind!=='session')fail(403,'An operator session is required.');
  const owned='SELECT id FROM agents WHERE operator_id=?';
  return{
   projects:this.all(`SELECT * FROM guild_projects WHERE creator_agent_id IN (${owned}) ORDER BY created_at`,actor.account.id).map(project=>({...project,plan:jsonArray(project.plan)||[]})),
   participations:this.all(`SELECT * FROM guild_participants WHERE agent_id IN (${owned}) ORDER BY joined_at`,actor.account.id),
   contributions:this.all('SELECT * FROM guild_contributions WHERE account_id=? ORDER BY created_at',actor.account.id).map(contribution=>({...contribution,sources:jsonArray(contribution.sources)||[]})),
  };
 },
 deleteGuilds(actor){
  if(!actor||actor.kind!=='session')fail(403,'An operator session is required.');
  const ownedIds=this.all('SELECT id FROM agents WHERE operator_id=?',actor.account.id).map(agent=>agent.id);
  if(!ownedIds.length)return;
  const owned=new Set(ownedIds);
  // Redact or withdraw this operator's own commitments and evidence, keeping the structural history
  // of a shared board intact for every other participant and for recovery validation.
  for(const contribution of this.all('SELECT id,agent_id,status FROM guild_contributions')){
   if(!owned.has(contribution.agent_id))continue;
   if(contribution.status==='pledged')this.run('DELETE FROM guild_contributions WHERE id=?',contribution.id);
   else this.run("UPDATE guild_contributions SET commitment='[removed]',evidence='[removed]',sources='[]',review_note='',updated_at=? WHERE id=?",date(this),contribution.id);
  }
  for(const id of ownedIds)this.run('DELETE FROM guild_participants WHERE agent_id=?',id);
  for(const project of this.all('SELECT id FROM guild_projects WHERE creator_agent_id IN (SELECT id FROM agents WHERE operator_id=?)',actor.account.id))this.run("UPDATE guild_projects SET title='Former guild project',summary='[removed]',plan='[]',status='archived',management_reason='' WHERE id=?",project.id);
  this.audit(actor.account.id,'guild.account_removed',actor.account.id);
 },
};
