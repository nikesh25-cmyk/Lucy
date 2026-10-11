import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { REGIONS, SDG_GOALS, CIVIC_CHARTER } from './civic.js';
import { getWorldDefinition, move } from '../world.js';
const catalog = name => JSON.parse(readFileSync(new URL(`../catalog/${name}.json`,import.meta.url),'utf8'));
export const COUNTRIES=catalog('countries'), PROGRAMMES=catalog('programmes'), PILOT=catalog('agriculture-pilot');
const roster=[1,2,3,5,6,7,9,10,11,12,13,14,15,16,17,18,19,20,21,22];
const stages=[
  {id:'baseline',name:'Establish the baseline',output:'A dated country baseline with indicators, geography, definitions and evidence gaps.'},
  {id:'evidence',name:'Compare practical interventions',output:'An evidence matrix comparing at least three interventions, costs, prerequisites and uncertainties.'},
  {id:'partners',name:'Map delivery routes',output:'An institutional map of public remits, published contact routes, eligibility and access barriers.'},
  {id:'proposal',name:'Draft an implementation recommendation',output:'A sourced decision brief with beneficiaries, milestones, budget assumptions, risks and measurable outcomes.'},
];
const rubric='Every factual claim needs a dated primary source and supporting location. Separate facts, estimates and proposals. Record access and reuse rights. Identify local applicability, uncertainty and evidence gaps. No recipient consent, buyer demand, endorsement or adoption may be presumed.';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const human=(actor,roles)=>{if(actor?.kind!=='session'||!roles.includes(actor.account.role))fail(403,'An authorized human account is required.');};
const text=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail(400,`${label} must contain 1–${max} characters.`);return value.trim();};
const integer=(value,fallback,max)=>{if(value==null||value==='')return fallback;const n=Number(value);if(!Number.isInteger(n)||n<0||n>max)fail(400,'Invalid pagination.');return n;};
export const CIVIC_SCHEMA=`
CREATE TABLE IF NOT EXISTS npc_mayors(id TEXT PRIMARY KEY,region_id TEXT NOT NULL,world_id TEXT NOT NULL,name TEXT NOT NULL,sprite INTEGER NOT NULL,x INTEGER NOT NULL,y INTEGER NOT NULL,direction TEXT NOT NULL DEFAULT 'down',status TEXT NOT NULL DEFAULT 'active',ticks INTEGER NOT NULL DEFAULT 0,last_tick INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mayor_conversations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),npc_id TEXT NOT NULL REFERENCES npc_mayors(id),question TEXT NOT NULL,answer TEXT NOT NULL,created_at TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'rules');
CREATE INDEX IF NOT EXISTS mayor_conversations_account ON mayor_conversations(account_id,created_at);
CREATE TABLE IF NOT EXISTS research_leads(id TEXT PRIMARY KEY,country_code TEXT NOT NULL,goal INTEGER NOT NULL,stage TEXT NOT NULL,title TEXT NOT NULL,instructions TEXT NOT NULL,rubric TEXT NOT NULL,source_urls TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',mission_id TEXT REFERENCES missions(id),task_id TEXT REFERENCES tasks(id),created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS research_leads_filters ON research_leads(country_code,goal,status);
CREATE TRIGGER IF NOT EXISTS research_task_status AFTER UPDATE OF status ON tasks BEGIN
UPDATE research_leads SET status=CASE NEW.status WHEN 'open' THEN 'activated' ELSE NEW.status END WHERE task_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS research_adoption AFTER INSERT ON adoptions BEGIN
UPDATE research_leads SET status='adopted' WHERE task_id=(SELECT c.task_id FROM submissions s JOIN claims c ON c.id=s.claim_id WHERE s.id=NEW.submission_id);
END;
`;
export const civicMethods={
  initCivic(){
    this.transaction(()=>{
      this.recoverWorkerJobs();
      REGIONS.forEach((region,index)=>this.run('INSERT OR IGNORE INTO npc_mayors(id,region_id,world_id,name,sprite,x,y) VALUES(?,?,?,?,?,?,?)',region.mayor.id,region.id,`district:${region.id}`,region.mayor.name,roster[index],24,18));
      for(const country of COUNTRIES.entries.filter(country=>country.ldc))this.seedCountryResearch(country);
      for(const [index,task] of (PILOT.tasks||[]).entries()){
        this.run('INSERT OR IGNORE INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',`pilot-tea-${index+1}`,'NP',2,'agriculture',String(task.title||task.name||`Tea research ${index+1}`).slice(0,100),['Agricultural pilot: Nepal tea exports to India.',task.question, 'Deliverables: '+(task.outputs||[]).join('; '), 'Acceptance: '+(task.rubric||[]).join('; ')].filter(Boolean).join('\n'),rubric,JSON.stringify(PILOT.sources.map(source=>source.url)),new Date().toISOString());
        this.run("UPDATE research_leads SET instructions=? WHERE id=? AND status='proposed'",['Agricultural pilot: Nepal tea exports to India.',task.question,'Deliverables: '+(task.outputs||[]).join('; '),'Acceptance: '+(task.rubric||[]).join('; ')].join('\n'),`pilot-tea-${index+1}`);
      }
    });
  },
  seedCountryResearch(country){
    for(let goal=1;goal<=17;goal++)for(const stage of stages){
      const id=`${country.iso2}-${goal}-${stage.id}`;
      this.run('INSERT OR IGNORE INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,country.iso2,goal,stage.id,`${country.name}: ${stage.name} · SDG ${goal}`.slice(0,100),`${stage.output} Scope: ${country.name}; SDG ${goal}, ${SDG_GOALS[goal-1]}. Begin with the official SDG framework, then find current country-specific primary evidence. Framework links alone do not establish country findings.`,rubric,JSON.stringify([`https://sdgs.un.org/goals/goal${goal}`,COUNTRIES.metadata.sourceUrl]),new Date().toISOString());
    }
  },
  countries(actor,input={}){
    const q=String(input.q||'').trim().toLowerCase().slice(0,80),group=String(input.group||'');
    if(group&&!['ldc','lldc','sids'].includes(group))fail(400,'Unknown country grouping.');
    const entries=COUNTRIES.entries.filter(country=>(!group||country[group])&&(!q||`${country.name} ${country.iso2} ${country.iso3} ${country.region} ${country.subregion}`.toLowerCase().includes(q)));
    const offset=integer(input.offset,0,100000),limit=integer(input.limit,30,248);if(!limit)fail(400,'Page size must be positive.');
    return {metadata:COUNTRIES.metadata,entries:entries.slice(offset,offset+limit),total:entries.length,offset,limit,has_more:offset+limit<entries.length};
  },
  assembly(){return {charter:CIVIC_CHARTER,goals:SDG_GOALS,programmes:PROGRAMMES,pilot:PILOT,stages,rubric};},
  research(actor,input={}){
    const params=[],where=[];
    for(const [key,column] of [['country','country_code'],['goal','goal'],['status','status']])if(input[key]){where.push(`${column}=?`);params.push(String(input[key]).slice(0,40));}
    if(input.institution){
      const institution=PROGRAMMES.institutions.find(item=>item.id===input.institution);if(!institution)fail(400,'Choose a catalog institution.');
      where.push('id LIKE ?');params.push(`programme-${institution.id}-%`);
    }
    if(input.q){where.push('(instr(lower(title),lower(?))>0 OR instr(lower(instructions),lower(?))>0)');params.push(String(input.q).slice(0,100),String(input.q).slice(0,100));}
    const clause=where.length?' WHERE '+where.join(' AND '):'',offset=integer(input.offset,0,1000000),limit=integer(input.limit,24,50);if(!limit)fail(400,'Page size must be positive.');
    const total=this.get('SELECT COUNT(*) AS n FROM research_leads'+clause,...params).n;
    const leads=this.all('SELECT * FROM research_leads'+clause+' ORDER BY CASE WHEN stage=\'agriculture\' THEN 0 ELSE 1 END,country_code,goal,id LIMIT ? OFFSET ?',...params,limit,offset).map(lead=>({...lead,country:COUNTRIES.entries.find(country=>country.iso2===lead.country_code)?.name,source_urls:JSON.parse(lead.source_urls)}));
    return {leads,total,offset,limit,has_more:offset+limit<total,counts:this.all('SELECT status,COUNT(*) AS count FROM research_leads GROUP BY status'),catalog_total:this.get('SELECT COUNT(*) AS n FROM research_leads').n};
  },
  researchGenerate(actor,input){
    human(actor,['admin','reviewer']);this.active();const country=COUNTRIES.entries.find(country=>country.iso2===input.country_code);if(!country)fail(400,'Choose a catalog country or area.');
    if(input.institution_id){
      const institution=PROGRAMMES.institutions.find(item=>item.id===input.institution_id);if(!institution)fail(400,'Choose a catalog institution.');
      let added=0;const goal=institution.sdgs[0];
      for(const stage of [stages[0],stages[3]]){
        const id=`programme-${institution.id}-${country.iso2}-${stage.id}`;
        const sources=[institution.sourceUrl,...institution.sdgLinks];
        const instructions=`${stage.output} Country: ${country.name}. Institution reference: ${institution.name}; focus: ${institution.mandate}. Proposed research: ${institution.suggestedTaskTypes.join('; ')}. Find current country evidence, latest official programme documents, responsible national institutions and a practical delivery route. Check geographic coverage, eligibility and programme dates. The source framework does not prove country findings, funding, recipient interest, consent or endorsement. Lucy proposes this work independently.`;
        added+=this.run('INSERT OR IGNORE INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,country.iso2,goal,`programme-${stage.id}`,`${country.name}: ${stage.name} · ${institution.name}`.slice(0,100),instructions,rubric,JSON.stringify(sources),new Date().toISOString()).changes;
      }
      this.audit(actor.account.id,'research.programme_generated',institution.id+':'+country.iso2);
      return {country:country.name,institution:institution.name,added};
    }
    const before=this.get('SELECT COUNT(*) AS n FROM research_leads WHERE country_code=?',country.iso2).n;this.seedCountryResearch(country);this.audit(actor.account.id,'research.generated',country.iso2);
    return {country:country.name,added:this.get('SELECT COUNT(*) AS n FROM research_leads WHERE country_code=?',country.iso2).n-before};
  },
  researchActivate(actor,input){
    human(actor,['admin','reviewer']);this.active();const lead=this.get('SELECT * FROM research_leads WHERE id=?',input.lead_id);if(!lead)fail(404,'Research proposal not found.');if(lead.task_id)return {mission_id:lead.mission_id,task_id:lead.task_id,status:'activated'};
    const beneficiary=text(input.beneficiary,2000,'Intended beneficiary');
    const mission=this.createMission(actor,{title:lead.title,area:lead.stage==='agriculture'?'Agriculture':'Development',summary:lead.instructions.slice(0,2000),beneficiary,owner_id:input.owner_id,reviewer_id:input.reviewer_id,rubric:lead.rubric});
    const domains=input.allowed_domains || [...new Set(JSON.parse(lead.source_urls).map(url=>new URL(url).hostname))];
    const task=this.createTask(actor,{mission_id:mission.id,title:lead.title,instructions:(lead.instructions+'\n'+lead.rubric).slice(0,2000),rights:'Paraphrase with attribution; inspect each source reuse terms. No full protected content or logos. Public contact routes are research only; no outreach authorization.',allowed_domains:domains});
    this.missionStatus(actor,mission.id,'open');
    this.run("UPDATE research_leads SET status='activated',mission_id=?,task_id=? WHERE id=?",mission.id,task.id,lead.id);this.audit(actor.account.id,'research.activated',lead.id);
    return {mission_id:mission.id,task_id:task.id,status:'activated'};
  },
  mayors(actor,input={}){
    this.tickMayors();const residents=this.all('SELECT * FROM npc_mayors ORDER BY region_id').map(mayor=>({...mayor,kind:'npc',mode:'rules',focus:REGIONS.find(region=>region.id===mayor.region_id).mayor.focus,title:`Mayor of ${REGIONS.find(region=>region.id===mayor.region_id).name}`,presence:mayor.status==='active'?'resident':'paused',color:'#397f79',symbol:'✦'}));
    const conversations=actor?.kind==='session'?this.all('SELECT * FROM mayor_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 20',actor.account.id):[];
    return {mayors:input.world_id?residents.filter(mayor=>mayor.world_id===input.world_id):residents,conversations,mode:'Scripted civic residents; responses follow published rules and catalog evidence.'};
  },
  tickMayors(){
    if(this.get("SELECT value FROM settings WHERE key='paused'").value==='true')return;
    for(const mayor of this.all("SELECT * FROM npc_mayors WHERE status='active'")){
      if(this.clock()-mayor.last_tick<2500)continue;
      const direction=['right','down','left','up'][Math.floor(mayor.ticks/4)%4];
      const next=move(mayor,direction,getWorldDefinition(mayor.world_id));
      this.run('UPDATE npc_mayors SET x=?,y=?,direction=?,ticks=ticks+1,last_tick=? WHERE id=?',next.x,next.y,direction,this.clock(),mayor.id);
    }
  },
  mayorTalk(actor,input){
    human(actor,['admin','member','moderator','reviewer']);this.active();const mayor=this.get("SELECT * FROM npc_mayors WHERE id=? AND status='active'",input.npc_id);if(!mayor)fail(404,'Active mayor not found.');
    const last=this.get('SELECT created_at FROM mayor_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 1',actor.account.id);if(last&&this.clock()-Date.parse(last.created_at)<1500)fail(429,'Please allow the mayor to finish.');
    const question=text(input.question,500,'Question'),region=REGIONS.find(region=>region.id===mayor.region_id);
    let answer=`I’m ${mayor.name}, the civic guide for ${region.name}. Our focus is ${region.mayor.focus.toLowerCase()}. Visit the World Assembly research desk to choose a country, a goal and a concrete deliverable.`;
    if(/report|abuse|harass|moder|unsafe|spam/i.test(question))answer='Use the Safety desk to report a specific message or resident. Human moderators review evidence, decide actions, and provide an appeal route. I can guide you through the process; I cannot impose sanctions.';
    else if(/tea|export|agric|farm|buyer|trade/i.test(question))answer='Our first agriculture pilot studies Nepal tea exports to India. Verify the newest Tea Board India directive, product standards, buyer demand and shipment costs before recommending a route. The Assembly desk has ten source records and six research proposals. No buyer or trade outcome is confirmed.';
    else if(/united nations|\bun\b|assembly|committee/i.test(question))answer=`World Assembly is an independent Lucy institution. Its reference desk contains ${PROGRAMMES.institutions.length} records covering principal organs, General Assembly committees, ECOSOC commissions, specialized agency groups, funds and other entities. It does not enumerate every UN programme or subsidiary body. UN sources inform Lucy proposals; Lucy has no UN endorsement.`;
    else if(/task|work|research|help|goal/i.test(question))answer=`Start with a proposed country research task, define a beneficiary and reviewer, then activate it as a mission. Contributors claim one task, attach sources and limitations, and submit for independent human review. ${this.get('SELECT COUNT(*) AS n FROM research_leads').n} proposals are currently in the research catalog.`;
    const id=randomUUID(),created_at=new Date(this.clock()).toISOString();this.run('INSERT INTO mayor_conversations(id,account_id,npc_id,question,answer,created_at) VALUES(?,?,?,?,?,?)',id,actor.account.id,mayor.id,question,answer,created_at);
    this.run('DELETE FROM mayor_conversations WHERE account_id=? AND id NOT IN (SELECT id FROM mayor_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 100)',actor.account.id,actor.account.id);
    return {id,npc_id:mayor.id,question,answer,created_at,mode:'rules'};
  },
  mayorControl(actor,input){human(actor,['admin','moderator']);if(!['active','paused'].includes(input.status))fail(400,'Choose active or paused.');if(!this.get('SELECT id FROM npc_mayors WHERE id=?',input.npc_id))fail(404,'Mayor not found.');this.run('UPDATE npc_mayors SET status=? WHERE id=?',input.status,input.npc_id);this.audit(actor.account.id,'mayor.'+input.status,input.npc_id);return {status:input.status};},
  mayorTriage(actor){
    human(actor,['admin','moderator']);return {mode:'rules',authority:'Advisory only; human moderators decide.',reports:this.all("SELECT id,target_type,target_id,reason,created_at FROM reports WHERE status='open' ORDER BY created_at LIMIT 100").map(report=>({...report,priority:/threat|violence|private|address|danger/i.test(report.reason)?'urgent human review':'standard human review',recommendation:'Inspect the reported record and context. Preserve evidence, apply community rules proportionately, and record reasons and appeal rights.'}))};
  },
  civicExport(actor){return {conversations:this.all('SELECT * FROM mayor_conversations WHERE account_id=? ORDER BY created_at',actor.account.id)};},
};
