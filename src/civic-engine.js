import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { agricultureSources, accessSources, STATISTICS_LICENSE } from './statistics.js';
import { mayorCountryContext, mayorConversation } from './mayor-evidence.js';
import { REGIONS, SDG_GOALS, CIVIC_CHARTER, mayorTopic } from './civic.js';
import { getWorldDefinition, move } from '../world.js';
const catalog = name => JSON.parse(readFileSync(new URL(`../catalog/${name}.json`,import.meta.url),'utf8'));
export const COUNTRIES=catalog('countries'), PROGRAMMES=catalog('programmes'), PILOT=catalog('agriculture-pilot'), SDG_TARGETS=catalog('sdg-targets');
const STATISTICS=catalog('agriculture-statistics'), ACCESS_STATISTICS=catalog('access-statistics');
// Project current evidence eligibility without rewriting historical task/adoption records.
const researchView=`(SELECT research_leads.*,CASE WHEN task_id IS NOT NULL AND (SELECT s.status FROM submissions s JOIN claims c ON c.id=s.claim_id WHERE c.task_id=research_leads.task_id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 1)='quarantined' THEN 'evidence_withheld' ELSE research_leads.status END AS current_status FROM research_leads) AS research_leads`;
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
CREATE TABLE IF NOT EXISTS mayor_conversations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),npc_id TEXT NOT NULL REFERENCES npc_mayors(id),question TEXT NOT NULL,answer TEXT NOT NULL,created_at TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'rules',country_context TEXT,source_numbers TEXT NOT NULL DEFAULT '[]');
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
        const sourceUrls=PILOT.sources.filter(source=>(task.sourceIds||PILOT.sources.map(item=>item.id)).includes(source.id)).map(source=>source.url);
        this.run('INSERT OR IGNORE INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',`pilot-tea-${index+1}`,'NP',2,'agriculture',String(task.title||task.name||`Tea research ${index+1}`).slice(0,100),['Agricultural pilot: Nepal tea exports to India.',task.question, 'Deliverables: '+(task.outputs||[]).join('; '), 'Acceptance: '+(task.rubric||[]).join('; ')].filter(Boolean).join('\n'),rubric,JSON.stringify(sourceUrls),new Date().toISOString());
        this.run("UPDATE research_leads SET instructions=?,source_urls=?,rubric=? WHERE id=? AND status='proposed' AND task_id IS NULL",['Agricultural pilot: Nepal tea exports to India.',task.question,'Deliverables: '+(task.outputs||[]).join('; '),'Acceptance: '+(task.rubric||[]).join('; ')].join('\n'),JSON.stringify(sourceUrls),rubric,`pilot-tea-${index+1}`);
      }
    });
  },
  seedCountryResearch(country){
    for(let goal=1;goal<=17;goal++)for(const stage of stages){
      const id=`${country.iso2}-${goal}-${stage.id}`;
      const statistical=goal===2&&stage.id==='baseline',accessBaseline=[7,17].includes(goal)&&stage.id==='baseline',accessRoutes=accessBaseline?accessSources(country).filter(item=>item.goals.includes(goal)):[];
      const sources=[`https://sdgs.un.org/goals/goal${goal}`,COUNTRIES.metadata.sourceUrl,...(statistical?agricultureSources(country).map(item=>item.url):[]),...accessRoutes.map(item=>item.url)];
      const instructions=`${stage.output} Scope: ${country.name}; SDG ${goal}, ${SDG_GOALS[goal-1]}. Begin with the official SDG framework, then find current country-specific primary evidence. Framework links alone do not establish country findings.`+(statistical?' Use the registered World Bank annual agriculture series for sector context, preserving observation years, percentage units, missing values and the modeled ILO employment qualifier. Dataset update is not publication. These indicators cannot establish crop demand, buyers, export eligibility, available farmland or returns. Inspect provider metadata and footnotes; identify crop-specific evidence and delivery gaps.':'')+(accessBaseline?' Use the registered World Bank annual '+(goal===7?'electricity access':'Internet-use')+' percentage series as national context only. Preserve observation years, missing values and original-provider attribution. Consult indicator metadata and country notes. These measures do not establish reliable or affordable supply, broadband coverage, skills or a local project design. A missing value is not zero and a dataset update is not an observation or publication date.':'');
      this.run('INSERT OR IGNORE INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,country.iso2,goal,stage.id,`${country.name}: ${stage.name} · SDG ${goal}`.slice(0,100),instructions,rubric,JSON.stringify(sources),new Date().toISOString());
      if(statistical||accessBaseline)this.run("UPDATE research_leads SET instructions=?,source_urls=? WHERE id=? AND status='proposed' AND task_id IS NULL",instructions,JSON.stringify(sources),id);
    }
  },
  countries(actor,input={}){
    const q=String(input.q||'').trim().toLowerCase().slice(0,80),group=String(input.group||'');
    if(group&&!['ldc','lldc','sids'].includes(group))fail(400,'Unknown country grouping.');
    const evidence=String(input.evidence||'');if(evidence&&!['retained','partial','none'].includes(evidence))fail(400,'Unknown evidence coverage filter.');
    const enriched=COUNTRIES.entries.map(country=>{const series=STATISTICS.countries.find(item=>item.country_code===country.iso2)?.series||[];return {...country,evidence:{status:series.length===3?'retained':series.length?'partial':'none',series_count:series.length,nonmissing_series:series.filter(s=>s.points.some(p=>p.value!==null)).length}};});
    const entries=enriched.filter(country=>(!evidence||country.evidence.status===evidence)&&(!group||country[group])&&(!q||`${country.name} ${country.iso2} ${country.iso3} ${country.region} ${country.subregion}`.toLowerCase().includes(q)));
    const offset=integer(input.offset,0,100000),limit=integer(input.limit,30,248);if(!limit)fail(400,'Page size must be positive.');
    return {metadata:COUNTRIES.metadata,evidence_coverage:{retained:enriched.filter(c=>c.evidence.status==='retained').length,partial:enriched.filter(c=>c.evidence.status==='partial').length,none:enriched.filter(c=>c.evidence.status==='none').length},entries:entries.slice(offset,offset+limit),total:entries.length,offset,limit,has_more:offset+limit<entries.length};
  },
  countryEvidence(actor,input={}){
    const country=COUNTRIES.entries.find(item=>item.iso2===input.country);if(!country)fail(400,'Choose a catalog country or area.');
    const sector=input.sector||'agriculture';if(!['agriculture','access'].includes(sector))fail(400,'Choose agriculture or access evidence.');
    const statistics=sector==='access'?ACCESS_STATISTICS:STATISTICS;
    return {country,sector,routes:sector==='access'?accessSources(country):agricultureSources(country),license:STATISTICS_LICENSE,metadata:statistics.metadata,collection_gaps:(statistics.metadata.unavailable||[]).filter(item=>item.country_code===country.iso2||item.country===country.name),snapshot:statistics.countries.find(item=>item.country_code===country.iso2)||null};
  },
  assembly(){return {charter:CIVIC_CHARTER,goals:SDG_GOALS,programmes:PROGRAMMES,pilot:PILOT,sdg_targets:SDG_TARGETS,stages,rubric};},
  countryResearchPlan(input={}){
    const country=COUNTRIES.entries.find(item=>item.iso2===input.country);if(!country)return null;
    const rows=this.all('SELECT goal,stage,current_status AS status,COUNT(*) AS count FROM '+researchView+' WHERE country_code=? GROUP BY goal,stage,current_status ORDER BY goal,stage,current_status',country.iso2);
    const sum=(items,status)=>items.filter(item=>!status||item.status===status).reduce((n,item)=>n+item.count,0);
    const statuses=[...new Set(rows.map(item=>item.status))].map(status=>({status,count:sum(rows,status)}));
    const goals=SDG_GOALS.map((name,index)=>{const selected=rows.filter(item=>item.goal===index+1);return {number:index+1,name,total:sum(selected),statuses:statuses.map(item=>({status:item.status,count:sum(selected,item.status)}))};});
    const stageOrder=[...stages.map(item=>({id:item.id,name:item.name})),...stages.map(item=>({id:'target-'+item.id,name:'Target-specific: '+item.name})),{id:'programme-baseline',name:'Institution-specific baseline'},{id:'programme-proposal',name:'Institution-specific recommendation'},{id:'agriculture',name:'Agriculture pilot deliverables'}];
    const stageSummary=stageOrder.map(stage=>{const selected=rows.filter(item=>item.stage===stage.id);return {...stage,total:sum(selected),statuses:statuses.map(item=>({status:item.status,count:sum(selected,item.status)}))};});
    const snapshot=STATISTICS.countries.find(item=>item.country_code===country.iso2),series=snapshot?.series||[],points=series.flatMap(item=>item.points);
    const accessSeries=ACCESS_STATISTICS.countries.find(item=>item.country_code===country.iso2)?.series||[],accessPoints=accessSeries.flatMap(item=>item.points),accessEvidence={series:accessSeries.length,reported_values:accessPoints.filter(p=>p.value!==null).length,missing_values:accessPoints.filter(p=>p.value===null).length,coverage:accessSeries.length===2?'retained':accessSeries.length?'partial':'none',limitation:ACCESS_STATISTICS.metadata.limitations};
    return {country:{name:country.name,iso2:country.iso2,iso3:country.iso3},generated_at:new Date(this.clock()).toISOString(),total:sum(rows),statuses,goals,stages:stageSummary,access_evidence:accessEvidence,agriculture_evidence:{series:series.length,records:points.length,reported_values:points.filter(item=>item.value!==null).length,missing_values:points.filter(item=>item.value===null).length,coverage:series.length===3?'retained':series.length?'partial':'none',gaps:(STATISTICS.metadata.unavailable||[]).filter(item=>item.country_code===country.iso2||item.country===country.name),limitation:'Retained annual agriculture sector observations only. Not evidence of all SDGs, crop demand, buyers, current law or completed research.'},workflow:['Choose a scoped baseline with a named beneficiary and reviewer.','Review country-specific evidence before comparing interventions.','Map responsible institutions and verified public access routes.','Prepare and independently review a decision brief; document actual adoption separately.'],limitations:'Counts describe catalog proposal workflow, not country outcomes or completed studies. Acceptance is independent review inside NemoWorld; adoption is a separately recorded declaration, not institutional endorsement. Evidence withheld means the latest submission is currently quarantined; historical review/adoption receipts are preserved but are not counted as currently available evidence. General and institution-specific stages overlap and do not imply dependencies, priority scores or automatic activation. Source dates, missing values and local applicability still require review.'};
  },
  research(actor,input={}){
    const target=input.target?SDG_TARGETS.entries.find(item=>item.code===input.target):null;if(input.target&&!target)fail(400,'Choose a catalog SDG target.');const params=[],where=[],region=input.region?REGIONS.find(item=>item.id===input.region):null;if(input.region&&!region)fail(400,'Choose a catalog research region.');if(region){where.push(`goal IN (${region.researchGoals.map(()=>'?').join(',')})`);params.push(...region.researchGoals);}
    if(target){where.push('id LIKE ?');params.push(`target-${target.code}-%`);}
    for(const [key,column] of [['country','country_code'],['goal','goal']])if(input[key]){where.push(`${column}=?`);params.push(String(input[key]).slice(0,40));}
    if(input.institution){
      const institution=PROGRAMMES.institutions.find(item=>item.id===input.institution);if(!institution)fail(400,'Choose a catalog institution.');
      where.push('id LIKE ?');params.push(`programme-${institution.id}-%`);
    }
    if(input.q){where.push('(instr(lower(title),lower(?))>0 OR instr(lower(instructions),lower(?))>0)');params.push(String(input.q).slice(0,100),String(input.q).slice(0,100));}
    // Status navigation shares every search facet, but excludes its own status and pagination.
    const scopeClause=where.length?' WHERE '+where.join(' AND '):'';
    const scopeCounts=this.all('SELECT current_status AS status,COUNT(*) AS count FROM '+researchView+scopeClause+' GROUP BY current_status ORDER BY current_status',...params);
    const workflowSummary={total:scopeCounts.reduce((sum,row)=>sum+row.count,0),statuses:scopeCounts,qualification:'Current proposal workflow within your country, goal, institution, target, region and text filters; independent of selected status and pagination. Accepted means reviewed inside NemoWorld. Recorded adoption is a declaration, not verified external implementation. Quarantined latest evidence is withheld from accepted and adopted counts.'};
    if(input.status){where.push('current_status=?');params.push(String(input.status).slice(0,40));}
    const clause=where.length?' WHERE '+where.join(' AND '):'',offset=integer(input.offset,0,1000000),limit=integer(input.limit,24,50);if(!limit)fail(400,'Page size must be positive.');
    const total=this.get('SELECT COUNT(*) AS n FROM '+researchView+clause,...params).n;
    const leads=this.all('SELECT * FROM '+researchView+clause+' ORDER BY CASE WHEN stage=\'agriculture\' THEN 0 ELSE 1 END,country_code,goal,id LIMIT ? OFFSET ?',...params,limit,offset).map(lead=>({...lead,target_code:/^target-([0-9]{1,2}\.(?:[0-9]{1,2}|[a-z]))-/.exec(lead.id)?.[1]||null,recorded_status:lead.status,status:lead.current_status,country:COUNTRIES.entries.find(country=>country.iso2===lead.country_code)?.name,source_urls:JSON.parse(lead.source_urls)}));
    return {leads,total,offset,limit,workflow_summary:workflowSummary,target_context:target?{...target,qualification:SDG_TARGETS.qualification}:null,region_context:region?{id:region.id,name:region.name,focus:region.mayor.focus,goals:region.researchGoals.map(number=>({number,name:SDG_GOALS[number-1]})),qualification:region.researchMapping}:null,has_more:offset+limit<total,country_plan:this.countryResearchPlan(input),counts:this.all('SELECT current_status AS status,COUNT(*) AS count FROM '+researchView+' GROUP BY current_status'),catalog_total:this.get('SELECT COUNT(*) AS n FROM research_leads').n};
  },
  researchGenerate(actor,input){
    human(actor,['admin','reviewer']);this.active();const country=COUNTRIES.entries.find(country=>country.iso2===input.country_code);if(!country)fail(400,'Choose a catalog country or area.');
    if(input.target_code&&input.institution_id)fail(400,'Choose a target or an institution for one generation request.');
    if(input.target_code){
      const target=SDG_TARGETS.entries.find(item=>item.code===input.target_code);if(!target)fail(400,'Choose a catalog SDG target.');let added=0;
      for(const stage of stages){const id=`target-${target.code}-${country.iso2}-${stage.id}`,sources=[target.sourceUrl+'#target-'+target.code,'https://sdgs.un.org/2030agenda',COUNTRIES.metadata.sourceUrl];
        const instructions=`${stage.output} Country: ${country.name}; SDG ${target.goal}, target ${target.code}. Editorial focus: ${target.focus}. Read the full official target at ${target.evidenceLocator}; check current indicator definitions, national priorities, source dates and country-specific evidence before making findings. Years mentioned in original target wording: ${target.originalYears.join(', ')||'none recorded'}. These are not new deadlines. Verify current measurement definitions separately, including poverty thresholds and population coverage; original target wording is not automatically a current statistical definition. Separate global objectives, national observations, proposed work, funding needs and actual support. ${SDG_TARGETS.qualification} NemoWorld proposes this research independently.`;
        added+=this.run('INSERT OR IGNORE INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,country.iso2,target.goal,'target-'+stage.id,`${country.name}: Target ${target.code} · ${stage.name}`.slice(0,100),instructions,rubric,JSON.stringify(sources),new Date().toISOString()).changes;
      }this.audit(actor.account.id,'research.target_generated',target.code+':'+country.iso2);return {country:country.name,target:target.code,added};
    }
    if(input.institution_id){
      const institution=PROGRAMMES.institutions.find(item=>item.id===input.institution_id);if(!institution)fail(400,'Choose a catalog institution.');
      let added=0;const goal=institution.sdgs[0];
      for(const stage of [stages[0],stages[3]]){
        const id=`programme-${institution.id}-${country.iso2}-${stage.id}`;
        const sources=[...new Set([institution.sourceUrl,...(institution.relatedSourceUrls||[]),...institution.sdgLinks])];
        const instructions=`${stage.output} Country: ${country.name}. Institution reference: ${institution.name}; focus: ${institution.mandate.replace(/\.$/,'')}. ${institution.sourceCheckNote?'Reference retrieval qualification: '+institution.sourceCheckNote+' ':''}Required country evidence: ${(institution.countryResearchChecks||[]).join(' ')||'Verify current country applicability and source dates.'} Proposed research: ${institution.suggestedTaskTypes.join('; ')}. Find current country evidence, latest official programme documents, responsible national institutions and a practical delivery route. Check geographic coverage, eligibility and programme dates. The source framework does not prove country findings, funding, recipient interest, consent or endorsement. NemoWorld proposes this work independently.`;
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
    const conversations=actor?.kind==='session'?this.all('SELECT * FROM mayor_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 20',actor.account.id).map(mayorConversation):[];
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
    const question=text(input.question,500,'Question'),region=REGIONS.find(region=>region.id===mayor.region_id),topic=mayorTopic(question),created_at=new Date(this.clock()).toISOString();
    const country_context=input.country_code==null||input.country_code===''?null:mayorCountryContext(this.countryEvidence(actor,{country:input.country_code}),this.countryEvidence(actor,{country:input.country_code,sector:'access'}),created_at);
    let answer=`I’m ${mayor.name}, the civic guide for ${region.name}. Our focus is ${region.mayor.focus.toLowerCase()}. Visit the World Assembly research desk to choose a country, a goal and a concrete deliverable.`;
    if(topic==='moderation')answer='Use the Safety desk to report a specific message or resident. Human moderators review evidence, decide actions, and provide an appeal route. I can guide you through the process; I cannot impose sanctions.';
    else if(topic==='assembly')answer=`World Assembly is an independent NemoWorld institution. Its reference desk contains ${PROGRAMMES.institutions.length} records covering principal organs, General Assembly committees, ECOSOC commissions, specialized agency groups, funds and other entities. It does not enumerate every UN programme or subsidiary body. UN sources inform NemoWorld proposals; NemoWorld has no UN endorsement.`;
    else if(country_context){
      const retained=country_context.sources.some(source=>source.status==='retained'),name=country_context.country.name;
      answer=`For ${name}, ${retained?'begin with the retained country baseline shown with this reply. Keep its source dates, definitions and evidence gaps visible.':'the registered baseline routes have no retained data here. Treat that as an evidence gap and consult country-specific primary sources before making findings.'} `+(topic==='agriculture'?'Choose a producer, municipality and crop, then verify local production, product standards, buyer demand, shipping costs and applicable trade requirements. Sector indicators alone cannot establish an export route.':'Define a beneficiary and a scoped research question. National agriculture, electricity access and Internet-use context cannot establish a local project design or outcomes. ')+` Use the ${name} research desk to prepare a proposal with an owner and independent reviewer. I can suggest next steps; human review is required before recommendations are used.`;
    }
    else if(topic==='agriculture')answer='Our first agriculture research starter studies Nepal tea exports to India. Verify the current applicable Tea Board India directive, product standards, buyer demand and shipment costs before recommending a route. The Assembly desk has '+PILOT.sources.length+' source records and six research proposals. No buyer or trade outcome is confirmed.';
    else if(topic==='research')answer=`For ${region.name}, explore the regional research lens for SDGs ${region.researchGoals.join(', ')}: ${region.mayor.focus.toLowerCase()}. This is NemoWorld’s editorial focus, not a country boundary or an assigned mission. Start with a proposed country research task, define a beneficiary and reviewer, then activate it as a mission. Contributors claim one task, attach sources and limitations, and submit for independent human review. ${this.get('SELECT COUNT(*) AS n FROM research_leads').n} proposals are currently in the research catalog.`;
    const source_numbers=country_context&&!['moderation','assembly'].includes(topic)?country_context.sources.filter(source=>source.status==='retained').map(source=>source.number):[];
    const id=randomUUID();this.run('INSERT INTO mayor_conversations(id,account_id,npc_id,question,answer,created_at,country_context,source_numbers) VALUES(?,?,?,?,?,?,?,?)',id,actor.account.id,mayor.id,question,answer,created_at,country_context?JSON.stringify(country_context):null,JSON.stringify(source_numbers));
    this.run('DELETE FROM mayor_conversations WHERE account_id=? AND id NOT IN (SELECT id FROM mayor_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 100)',actor.account.id,actor.account.id);
    return {id,npc_id:mayor.id,question,answer,created_at,mode:'rules',country_context,source_numbers};
  },
  mayorControl(actor,input){human(actor,['admin','moderator']);if(!['active','paused'].includes(input.status))fail(400,'Choose active or paused.');if(!this.get('SELECT id FROM npc_mayors WHERE id=?',input.npc_id))fail(404,'Mayor not found.');this.run('UPDATE npc_mayors SET status=? WHERE id=?',input.status,input.npc_id);this.audit(actor.account.id,'mayor.'+input.status,input.npc_id);return {status:input.status};},
  mayorTriage(actor){
    human(actor,['admin','moderator']);return {mode:'rules',authority:'Advisory only; human moderators decide.',reports:this.all("SELECT id,target_type,target_id,reason,created_at FROM reports WHERE status='open' ORDER BY created_at LIMIT 100").map(report=>({...report,priority:/threat|violence|private|address|danger/i.test(report.reason)?'urgent human review':'standard human review',recommendation:'Inspect the reported record and context. Preserve evidence, apply community rules proportionately, and record reasons and appeal rights.'}))};
  },
  civicExport(actor){return {conversations:this.all('SELECT * FROM mayor_conversations WHERE account_id=? ORDER BY created_at',actor.account.id).map(mayorConversation)};},
};
