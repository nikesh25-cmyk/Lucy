import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { agricultureSources, accessSources, STATISTICS_LICENSE } from './statistics.js';
import { ambassadorCountryContext, ambassadorConversation, mayorConversation } from './mayor-evidence.js';
import { REGIONS, SDG_GOALS, CIVIC_CHARTER, AMBASSADOR_REMIT, mayorTopic } from './civic.js';
import { getWorldDefinition, move } from '../world.js';
import content from './content.js';
const catalog = name => JSON.parse(readFileSync(new URL(`../catalog/${name}.json`,import.meta.url),'utf8'));
export const COUNTRIES=catalog('countries'), PROGRAMMES=catalog('programmes'), PILOT=catalog('agriculture-pilot'), SDG_TARGETS=catalog('sdg-targets');
const STATISTICS=catalog('agriculture-statistics'), ACCESS_STATISTICS=catalog('access-statistics');
// The concern model and theme map replace the interchangeable (goal × stage) templates Task 12 found
// byte-identical across the 44 LDC seeds. Every generated country proposal belongs to exactly one
// concern, and two candidate proposals answered by the same evidence are consolidated into one row.
const RESEARCH_MODEL=catalog('research-concerns');
export const RESEARCH_CONCERNS=RESEARCH_MODEL.concerns, RESEARCH_THEMES=RESEARCH_MODEL.themes;
const CONCERN_BY_ID=new Map(RESEARCH_CONCERNS.map(item=>[item.id,item]));
const CONCERN_ORDER=RESEARCH_CONCERNS.map(item=>item.id);
const APPLIED_CONCERNS=CONCERN_ORDER.filter(id=>id!=='baseline');
// Project current evidence eligibility without rewriting historical task/adoption records.
const researchView=`(SELECT research_leads.*,CASE WHEN task_id IS NOT NULL AND (SELECT s.status FROM submissions s JOIN claims c ON c.id=s.claim_id WHERE c.task_id=research_leads.task_id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 1)='quarantined' THEN 'evidence_withheld' WHEN research_leads.status='proposed' AND task_id IS NULL AND EXISTS(SELECT 1 FROM research_lead_consolidations r WHERE r.consolidated_id=research_leads.id) THEN CASE WHEN COALESCE((SELECT canonical_id FROM research_lead_consolidations r WHERE r.consolidated_id=research_leads.id LIMIT 1),'')='' THEN 'retired' ELSE 'consolidated' END ELSE research_leads.status END AS current_status,(SELECT canonical_id FROM research_lead_consolidations r WHERE r.consolidated_id=research_leads.id LIMIT 1) AS replacement_id,(SELECT reason FROM research_lead_consolidations r WHERE r.consolidated_id=research_leads.id LIMIT 1) AS consolidation_reason FROM research_leads) AS research_leads`;
// The guide sprite sheets are the sealed civic appearances, in roster order; each appearance keeps
// its own sheet number, which is the numeric `sprite` the client loads. The same 20 sheets serve the
// historic regional guides and the country ambassadors: 20 sheets repeat across 248 ambassadors, so
// several countries share a portrait. No new art is introduced.
const guideAppearances = content.appearancesFor('civic-mayor');
const ambassadorAppearances = content.appearancesFor('civic-ambassador');
const mayorAppearances = guideAppearances.length ? guideAppearances : ambassadorAppearances;
const roster = mayorAppearances.map((definition) => definition.appearance.sprite);
export const AMBASSADOR_SPRITES = Object.freeze([...roster]);
// A stand inside the venue plaza, addressed by catalog position so that two ambassadors never share
// a position even inside the same coordinate space. src/world.js paints exactly this plaza walkable.
const VENUE = Object.freeze({ x: 12, y: 8, width: 16, height: 16 });
const ambassadorId = (iso3) => `amb-${iso3}`;
const standFor = (index) => ({ x: VENUE.x + (index % VENUE.width), y: VENUE.y + Math.floor(index / VENUE.width) });
function ambassadorView(row) {
  const groups = { ldc: Boolean(row.ldc), lldc: Boolean(row.lldc), sids: Boolean(row.sids) };
  const labels = [groups.ldc ? 'LDC' : null, groups.lldc ? 'LLDC' : null, groups.sids ? 'SIDS' : null].filter(Boolean);
  return { id: row.id, kind: 'npc', iso2: row.iso2, iso3: row.iso3, m49: row.m49, name: row.name, region: row.region, subregion: row.subregion,
    groups, country_group: labels.join(' · ') || 'No special grouping', world_id: row.world_id, sprite: row.sprite, x: row.x, y: row.y,
    status: row.status, presence: row.status === 'active' ? 'resident' : 'paused', mode: 'rules', title: `Country ambassador · ${row.name}`, focus: `Source-based research guidance for ${row.name}.` };
}
// The compatibility mapping is deterministic and arbitrary by design: the historic guides described
// ecological territories, not countries. Region index i maps to catalog position floor(i*248/20), so
// the alias is stable, recorded in ambassador_legacy_map and readable through the API.
const legacyCountryFor = (index) => COUNTRIES.entries[Math.floor(index * COUNTRIES.entries.length / REGIONS.length)];
const stages=[
  {id:'baseline',name:'Establish the baseline',output:'A dated country baseline with indicators, geography, definitions and evidence gaps.'},
  {id:'evidence',name:'Compare practical interventions',output:'An evidence matrix comparing at least three interventions, costs, prerequisites and uncertainties.'},
  {id:'partners',name:'Map delivery routes',output:'An institutional map of public remits, published contact routes, eligibility and access barriers.'},
  {id:'proposal',name:'Draft an implementation recommendation',output:'A sourced decision brief with beneficiaries, milestones, budget assumptions, risks and measurable outcomes.'},
];
const rubric='Every factual claim needs a dated primary source and supporting location. Separate facts, estimates and proposals. Record access and reuse rights. Identify local applicability, uncertainty and evidence gaps. No recipient consent, buyer demand, endorsement or adoption may be presumed.';
// ---- Concern-based country research generation ------------------------------------------------
// Every proposal names what it is about. The country baseline collects context and dated statistics;
// the three applied concerns are the product/destination question, the institution mapping and the
// intervention comparison. They are separate proposals, not interchangeable (goal × stage) templates.
const fill=(value,ctx)=>{let out=String(value);for(let pass=0;pass<2;pass++)out=out.replaceAll('{country}',ctx.country.name).replaceAll('{goal}',String(ctx.goal)).replaceAll('{goalName}',SDG_GOALS[ctx.goal-1]).replaceAll('{subject}',ctx.theme?.subject||'subject').replaceAll('{subjectBasis}',ctx.theme?.subjectBasis||'');return out;};
const statisticalGoal=goal=>goal===2;
const accessGoal=goal=>goal===7||goal===17;
const agricultureRetained=country=>STATISTICS.countries.some(item=>item.country_code===country.iso2&&(item.series||[]).length>0);
// A theme's applied concerns are emitted only where the theme's registered subject evidence exists
// for that country: a retained agriculture series, or (for LDC cooperation instruments) a
// catalog-recorded LDC status. A theme gated with `none` needs no country-specific evidence.
const themeApplies=(country,theme)=>{
  if(theme.evidenceGate==='agriculture-series')return agricultureRetained(country);
  if(theme.evidenceGate==='ldc-status')return Boolean(country.ldc);
  return true;
};
const themeForGoal=goal=>RESEARCH_THEMES.find(theme=>theme.goals.includes(goal));
// The goal-specific guidance is retained from the previous generator so the modeled ILO qualifier,
// the original-provider attribution and the dataset-update caveat are not lost.
const goalGuidance=(country,goal)=>['Begin with the official SDG framework, then find current country-specific primary evidence. Framework links alone do not establish country findings.',
  statisticalGoal(goal)?'Use the registered World Bank annual agriculture series for sector context, preserving observation years, percentage units, missing values and the modeled ILO employment qualifier. Dataset update is not publication. These indicators cannot establish crop demand, buyers, export eligibility, available farmland or returns. Inspect provider metadata and footnotes; identify crop-specific evidence and delivery gaps.':'',
  accessGoal(goal)?`Use the registered World Bank annual ${goal===7?'electricity access':'Internet-use'} percentage series as national context only. Preserve observation years, missing values and original-provider attribution. Consult indicator metadata and country notes. These measures do not establish reliable or affordable supply, broadband coverage, skills or a local project design. A missing value is not zero and a dataset update is not an observation or publication date.`:''].filter(Boolean).join(' ');
const themeSources=(country,theme)=>theme.id==='agriculture-market-access'?agricultureSources(country).map(item=>item.url)
  :theme.id==='ldc-cooperation'?[PROGRAMMES.frameworks.find(item=>item.id==='dpoa')?.sourceUrl,...['un-ohrlls','technology-bank','unctad','itc'].map(id=>PROGRAMMES.institutions.find(item=>item.id===id)?.sourceUrl)].filter(Boolean):[];
const concernSections=(concern,ctx)=>{const f=item=>fill(item,ctx);return [`Outputs: ${concern.outputs.map(f).join(' ')}`,`Acceptance: ${concern.acceptance.map(f).join(' ')}`,`Source prerequisites: ${concern.prerequisites.map(f).join(' ')}`,
  `Dependencies: ${concern.dependencies.length?concern.dependencies.map(f).join(' '):'None; this concern can start from the registered country context.'}`,`Primary source categories: ${concern.source_categories.map(f).join('; ')}`,`Rights: ${f(concern.rights)}`];};
function baselineLead(country,goal){
  const concern=CONCERN_BY_ID.get('baseline'),theme=themeForGoal(goal),available=Boolean(theme&&themeApplies(country,theme));
  const sources=[`https://sdgs.un.org/goals/goal${goal}`,COUNTRIES.metadata.sourceUrl];
  if(statisticalGoal(goal))sources.push(...agricultureSources(country).map(item=>item.url));
  if(accessGoal(goal))sources.push(...accessSources(country).filter(item=>item.goals.includes(goal)).map(item=>item.url));
  const context=statisticalGoal(goal)?'The three registered annual agriculture series are listed in the sources as national sector context. Province- or crop-level production, current rules and delivery bodies still have to be located.'
    :accessGoal(goal)?`The registered ${goal===7?'electricity-access':'Internet-use'} series is listed in the sources as national context only.`:"No registered statistical series is held for this goal; the baseline depends on the country's official national sources.";
  const scopeChoices=!theme?`No scoped theme is registered for SDG ${goal}; select and register a named subject before any applied research is scoped.`
    :!available?`The registered theme "${theme.title}" has no retained subject evidence for ${country.name}; record that collection gap before scoping it.`
    :`Applied concerns available for this theme (${theme.title}): ${APPLIED_CONCERNS.map(id=>CONCERN_BY_ID.get(id).name).join('; ')}. Each is emitted as its own proposal and each needs the ${theme.id==='agriculture-market-access'?'commodity and destination':'instrument'} selection first.`;
  return {id:`${country.iso2}-${goal}-baseline`,country_code:country.iso2,goal,stage:'baseline',title:`${country.name}: ${concern.name} · SDG ${goal}`.slice(0,100),substantive_key:`baseline|${country.iso2}|${goal}`,
    instructions:[fill(concern.question,{country,goal,theme}),`Scope: country=${country.name} (${country.iso2}); SDG ${goal}, ${SDG_GOALS[goal-1]}; concern=country-baseline.`,context,`Open scope choices: ${scopeChoices}`,...concernSections(concern,{country,goal,theme}),goalGuidance(country,goal)].join('\n'),
    rubric:concern.acceptance.join(' '),source_urls:sources};
}
function appliedLead(country,goal,theme,concernId){
  const concern=CONCERN_BY_ID.get(concernId);
  const sources=[...new Set([`https://sdgs.un.org/goals/goal${goal}`,COUNTRIES.metadata.sourceUrl,...themeSources(country,theme)])];
  return {id:`${country.iso2}-${goal}-${concernId}`,country_code:country.iso2,goal,stage:concernId,title:`${country.name}: ${concern.name} · SDG ${goal}`.slice(0,100),substantive_key:`${concernId}|${theme.id}|${country.iso2}`,
    instructions:[fill(concern.question,{country,goal,theme}),`Scope: country=${country.name} (${country.iso2}); SDG ${goal}, ${SDG_GOALS[goal-1]}; theme=${theme.title}; concern=${concern.kind}.`,
      `Subject: ${fill(theme.subject,{country,goal,theme})}. Subject basis: ${fill(theme.subjectBasis,{country,goal,theme})}. Theme limit: ${theme.limit}`,
      `Open scope choices: ${theme.openScopeChoices.map(item=>fill(item,{country,goal,theme})).join(' ')}`,...concernSections(concern,{country,goal,theme}),goalGuidance(country,goal)].join('\n'),
    rubric:concern.acceptance.join(' '),source_urls:sources};
}
// Pure planner: deterministic ids and a substantive key per candidate. Two candidates with the same
// key are the same proposal, so only the first is emitted and the rest are recorded as consolidations.
export function planCountryResearch(country,themes=RESEARCH_THEMES){
  const leads=[],consolidations=[],seen=new Map();
  const add=(lead,key)=>{if(seen.has(key)){consolidations.push({dedupe_key:key,country_code:country.iso2,canonical_id:seen.get(key),consolidated_id:lead.id,reason:'same substantive question'});return;}seen.set(key,lead.id);leads.push(lead);};
  for(let goal=1;goal<=17;goal++)add(baselineLead(country,goal),`baseline|${country.iso2}|${goal}`);
  for(const theme of themes)for(const goal of theme.goals){if(!themeApplies(country,theme))continue;for(const concernId of APPLIED_CONCERNS)add(appliedLead(country,goal,theme,concernId),`${concernId}|${theme.id}|${country.iso2}`);}
  return {leads,consolidations};
}
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const human=(actor,roles)=>{if(actor?.kind!=='session'||!roles.includes(actor.account.role))fail(403,'An authorized human account is required.');};
const text=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail(400,`${label} must contain 1–${max} characters.`);return value.trim();};
const integer=(value,fallback,max)=>{if(value==null||value==='')return fallback;const n=Number(value);if(!Number.isInteger(n)||n<0||n>max)fail(400,'Invalid pagination.');return n;};
// The one identity sentence a country ambassador always opens with. It is authored once here and
// returned byte-identically wherever an ambassador speaks or is described, so no other module re-types
// its wording.
export function ambassadorIdentity(country){return `I’m the NemoWorld country ambassador for ${country.name}. I am a fictional research guide: I do not represent ${country.name}, any government or the United Nations. My remit is source-based research for this country or area.`;}
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
CREATE TABLE IF NOT EXISTS npc_ambassadors(id TEXT PRIMARY KEY,iso2 TEXT NOT NULL,iso3 TEXT NOT NULL UNIQUE,m49 TEXT NOT NULL,name TEXT NOT NULL,region TEXT NOT NULL DEFAULT '',subregion TEXT NOT NULL DEFAULT '',ldc INTEGER NOT NULL DEFAULT 0,lldc INTEGER NOT NULL DEFAULT 0,sids INTEGER NOT NULL DEFAULT 0,world_id TEXT NOT NULL,sprite INTEGER NOT NULL,x INTEGER NOT NULL,y INTEGER NOT NULL,direction TEXT NOT NULL DEFAULT 'down',status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS npc_ambassadors_status ON npc_ambassadors(status,name);
CREATE INDEX IF NOT EXISTS npc_ambassadors_world ON npc_ambassadors(world_id);
CREATE TABLE IF NOT EXISTS ambassador_legacy_map(guide_id TEXT PRIMARY KEY,region_id TEXT NOT NULL,ambassador_id TEXT NOT NULL REFERENCES npc_ambassadors(id),created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ambassador_legacy_map_ambassador ON ambassador_legacy_map(ambassador_id);
CREATE TABLE IF NOT EXISTS ambassador_conversations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),ambassador_id TEXT NOT NULL REFERENCES npc_ambassadors(id),question TEXT NOT NULL,answer TEXT NOT NULL,created_at TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'rules',country_context TEXT,source_numbers TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS ambassador_conversations_account ON ambassador_conversations(account_id,created_at);
CREATE TABLE IF NOT EXISTS research_lead_versions(id TEXT PRIMARY KEY,lead_id TEXT NOT NULL REFERENCES research_leads(id),revision INTEGER NOT NULL,title TEXT NOT NULL,instructions TEXT NOT NULL,rubric TEXT NOT NULL,source_urls TEXT NOT NULL,substantive_key TEXT,revision_reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(lead_id,revision));
CREATE INDEX IF NOT EXISTS research_lead_versions_lead ON research_lead_versions(lead_id,revision);
CREATE TABLE IF NOT EXISTS research_lead_consolidations(dedupe_key TEXT PRIMARY KEY,country_code TEXT NOT NULL,canonical_id TEXT NOT NULL,consolidated_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS research_lead_consolidations_country ON research_lead_consolidations(country_code);
CREATE INDEX IF NOT EXISTS research_lead_consolidations_retired ON research_lead_consolidations(consolidated_id);
`;
export const civicMethods={
  initCivic(){
    this.transaction(()=>{
      this.recoverWorkerJobs();
      REGIONS.forEach((region,index)=>this.run('INSERT OR IGNORE INTO npc_mayors(id,region_id,world_id,name,sprite,x,y) VALUES(?,?,?,?,?,?,?)',region.mayor.id,region.id,`district:${region.id}`,region.mayor.name,roster[index],24,18));
      this.seedAmbassadors();
      for(const country of COUNTRIES.entries.filter(country=>country.ldc))this.seedCountryResearch(country);
      // Older installations may already contain applied leads generated before the
      // country evidence gates existed. Retire only untouched proposals; retain
      // activated work and every stored row for its audit history.
      for(const row of this.all("SELECT DISTINCT country_code FROM research_leads WHERE status='proposed' AND task_id IS NULL AND stage IN ('destination','institutions','interventions')")){
        const country=COUNTRIES.entries.find(item=>item.iso2===row.country_code);
        if(country)this.retireUnsupportedApplied(country);
      }
      for(const [index,task] of (PILOT.tasks||[]).entries()){
        const sourceUrls=PILOT.sources.filter(source=>(task.sourceIds||PILOT.sources.map(item=>item.id)).includes(source.id)).map(source=>source.url);
        this.run('INSERT OR IGNORE INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',`pilot-tea-${index+1}`,'NP',2,'agriculture',String(task.title||task.name||`Tea research ${index+1}`).slice(0,100),['Agricultural pilot: Nepal tea exports to India.',task.question, 'Deliverables: '+(task.outputs||[]).join('; '), 'Acceptance: '+(task.rubric||[]).join('; ')].filter(Boolean).join('\n'),rubric,JSON.stringify(sourceUrls),new Date().toISOString());
        this.run("UPDATE research_leads SET instructions=?,source_urls=?,rubric=? WHERE id=? AND status='proposed' AND task_id IS NULL",['Agricultural pilot: Nepal tea exports to India.',task.question,'Deliverables: '+(task.outputs||[]).join('; '),'Acceptance: '+(task.rubric||[]).join('; ')].join('\n'),JSON.stringify(sourceUrls),rubric,`pilot-tea-${index+1}`);
      }
    });
  },
  // A proposal is created or revised through this one path. Every revision archives the content it
  // replaces, so a previous version is never lost; only a lead still in `proposed` with no task is
  // eligible, so an activated, leased or accepted lead is never rewritten and keeps its history.
  recordLead(lead){
    const created_at=new Date(this.clock()).toISOString(),source_urls=JSON.stringify(lead.source_urls);
    const existing=this.get('SELECT id,status,task_id,title,instructions,rubric,source_urls FROM research_leads WHERE id=?',lead.id);
    if(!existing){
      this.run('INSERT INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',lead.id,lead.country_code,lead.goal,lead.stage,lead.title,lead.instructions,lead.rubric,source_urls,created_at);
      return 1;
    }
    if(existing.status!=='proposed'||existing.task_id)return 0;
    if(existing.title===lead.title&&existing.instructions===lead.instructions&&existing.rubric===lead.rubric&&existing.source_urls===source_urls)return 0;
    const revision=this.get('SELECT COALESCE(MAX(revision),0)+1 AS n FROM research_lead_versions WHERE lead_id=?',lead.id).n;
    this.recordRevision({id:lead.id,substantive_key:lead.substantive_key,title:existing.title,instructions:existing.instructions,rubric:existing.rubric,source_urls:existing.source_urls},revision,'superseded');
    this.run("UPDATE research_leads SET title=?,instructions=?,rubric=?,source_urls=? WHERE id=? AND status='proposed' AND task_id IS NULL",lead.title,lead.instructions,lead.rubric,source_urls,lead.id);
    return 1;
  },
  recordRevision(version,revision,reason){
    const source_urls=typeof version.source_urls==='string'?version.source_urls:JSON.stringify(version.source_urls);
    this.run('INSERT INTO research_lead_versions(id,lead_id,revision,title,instructions,rubric,source_urls,substantive_key,revision_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',randomUUID(),version.id,revision,version.title,version.instructions,version.rubric,source_urls,version.substantive_key||null,reason,new Date(this.clock()).toISOString());
  },
  recordConsolidation(item){this.run('INSERT OR IGNORE INTO research_lead_consolidations(dedupe_key,country_code,canonical_id,consolidated_id,reason,created_at) VALUES(?,?,?,?,?,?)',item.dedupe_key,item.country_code,item.canonical_id,item.consolidated_id,item.reason,new Date(this.clock()).toISOString());},
  // The current proposal plus every archived version, newest first. The live row is the current
  // revision; the archived rows are the contents that later revisions replaced.
  researchLeadVersions(id){
    const lead=this.get('SELECT * FROM research_leads WHERE id=?',String(id||''));if(!lead)return null;
    const versions=this.all('SELECT * FROM research_lead_versions WHERE lead_id=? ORDER BY revision DESC',lead.id);
    return {lead_id:lead.id,status:lead.status,current_revision:versions.length+1,current:{title:lead.title,instructions:lead.instructions,rubric:lead.rubric,source_urls:JSON.parse(lead.source_urls)},
      versions:versions.map(item=>({...item,source_urls:JSON.parse(item.source_urls)}))};
  },
  // One baseline per country and goal (country context and dated statistics) plus one proposal per
  // applied concern for each theme the catalog has scoped and the country has subject evidence for.
  seedCountryResearch(country,themes=RESEARCH_THEMES){
    const plan=planCountryResearch(country,themes);
    for(const lead of plan.leads)this.recordLead(lead);
    for(const item of plan.consolidations)this.recordConsolidation(item);
    this.retireInterchangeable(country);
    this.retireUnsupportedApplied(country,themes);
    return plan;
  },
  retireUnsupportedApplied(country,themes=RESEARCH_THEMES){
    for(const theme of themes){
      if(themeApplies(country,theme))continue;
      for(const goal of theme.goals)for(const stage of APPLIED_CONCERNS){
        const id=`${country.iso2}-${goal}-${stage}`;
        const row=this.get("SELECT id FROM research_leads WHERE id=? AND country_code=? AND goal=? AND stage=? AND status='proposed' AND task_id IS NULL",id,country.iso2,goal,stage);
        if(!row)continue;
        this.recordConsolidation({dedupe_key:`unsupported|${id}`,country_code:country.iso2,canonical_id:'',consolidated_id:id,
          reason:`The ${theme.title} applied concern is retired because its country evidence gate is not met. The stored proposal is preserved; collect the missing evidence and author a scoped concern before activation.`});
      }
    }
  },
  // An installation seeded by an older generator still holds the retired interchangeable stage rows
  // (evidence, partners, proposal). Nothing is deleted or rewritten: each such still-proposed row is
  // recorded as consolidated into the concern row that replaced it, so the desk can say so.
  retiredSuccessor:{evidence:'interventions',partners:'institutions',proposal:'destination'},
  retireInterchangeable(country){
    const rows=this.all("SELECT id,goal,stage FROM research_leads WHERE country_code=? AND status='proposed' AND task_id IS NULL AND stage IN ('evidence','partners','proposal')",country.iso2);
    for(const row of rows){
      const successor=`${country.iso2}-${row.goal}-${this.retiredSuccessor[row.stage]}`;
      const replacement=this.get('SELECT id FROM research_leads WHERE id=?',successor);
      if(!replacement){this.recordConsolidation({dedupe_key:`retired|${row.id}`,country_code:country.iso2,canonical_id:'',consolidated_id:row.id,reason:'This interchangeable template is retired without a scoped replacement. Collect dated country baseline evidence and author a scoped applied concern first.'});continue;}
      this.recordConsolidation({dedupe_key:`retired|${row.id}`,country_code:country.iso2,canonical_id:successor,consolidated_id:row.id,reason:`The interchangeable ${row.stage} template named no commodity, instrument or route and is superseded by the ${this.retiredSuccessor[row.stage]} concern.`});
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
  assembly(){return {charter:CIVIC_CHARTER,goals:SDG_GOALS,programmes:PROGRAMMES,pilot:PILOT,sdg_targets:SDG_TARGETS,stages,rubric,concerns:RESEARCH_CONCERNS,research_themes:RESEARCH_THEMES,research_dedupe_rule:RESEARCH_MODEL.dedupe_rule};},
  countryResearchPlan(input={}){
    const country=COUNTRIES.entries.find(item=>item.iso2===input.country);if(!country)return null;
    const rows=this.all('SELECT goal,stage,current_status AS status,COUNT(*) AS count FROM '+researchView+' WHERE country_code=? GROUP BY goal,stage,current_status ORDER BY goal,stage,current_status',country.iso2);
    const sum=(items,status)=>items.filter(item=>!status||item.status===status).reduce((n,item)=>n+item.count,0);
    const statuses=[...new Set(rows.map(item=>item.status))].map(status=>({status,count:sum(rows,status)}));
    const goals=SDG_GOALS.map((name,index)=>{const selected=rows.filter(item=>item.goal===index+1);return {number:index+1,name,total:sum(selected),statuses:statuses.map(item=>({status:item.status,count:sum(selected,item.status)}))};});
    const stageOrder=[...RESEARCH_CONCERNS.map(item=>({id:item.id,name:item.name,kind:item.kind})),...stages.map(item=>({id:'target-'+item.id,name:'Target-specific: '+item.name})),{id:'programme-baseline',name:'Institution-specific baseline'},{id:'programme-proposal',name:'Institution-specific recommendation'},{id:'agriculture',name:'Agriculture pilot deliverables'}];
    const stageSummary=stageOrder.map(stage=>{const selected=rows.filter(item=>item.stage===stage.id);return {...stage,total:sum(selected),statuses:statuses.map(item=>({status:item.status,count:sum(selected,item.status)}))};});
    const concerns=RESEARCH_CONCERNS.map(item=>{const stage=stageSummary.find(entry=>entry.id===item.id);return {id:item.id,name:item.name,kind:item.kind,total:stage?.total||0};});
    const dedupe={rule:RESEARCH_MODEL.dedupe_rule,consolidations:this.get('SELECT COUNT(*) AS n FROM research_lead_consolidations WHERE country_code=?',country.iso2).n,distinct_questions:sum(rows.filter(item=>!['consolidated','retired'].includes(item.status)))};
    const snapshot=STATISTICS.countries.find(item=>item.country_code===country.iso2),series=snapshot?.series||[],points=series.flatMap(item=>item.points);
    const accessSeries=ACCESS_STATISTICS.countries.find(item=>item.country_code===country.iso2)?.series||[],accessPoints=accessSeries.flatMap(item=>item.points),accessEvidence={series:accessSeries.length,reported_values:accessPoints.filter(p=>p.value!==null).length,missing_values:accessPoints.filter(p=>p.value===null).length,coverage:accessSeries.length===2?'retained':accessSeries.length?'partial':'none',limitation:ACCESS_STATISTICS.metadata.limitations};
    return {country:{name:country.name,iso2:country.iso2,iso3:country.iso3},generated_at:new Date(this.clock()).toISOString(),total:sum(rows),statuses,goals,stages:stageSummary,concerns,dedupe,access_evidence:accessEvidence,agriculture_evidence:{series:series.length,records:points.length,reported_values:points.filter(item=>item.value!==null).length,missing_values:points.filter(item=>item.value===null).length,coverage:series.length===3?'retained':series.length?'partial':'none',gaps:(STATISTICS.metadata.unavailable||[]).filter(item=>item.country_code===country.iso2||item.country===country.name),limitation:'Retained annual agriculture sector observations only. Not evidence of all SDGs, crop demand, buyers, current law or completed research.'},workflow:['Choose a scoped baseline with a named beneficiary and reviewer.','Review country-specific evidence before comparing interventions.','Map responsible institutions and verified public access routes.','Prepare and independently review a decision brief; document actual adoption separately.'],limitations:'Counts describe catalog proposal workflow, not country outcomes or completed studies. Acceptance is independent review inside NemoWorld; adoption is a separately recorded declaration, not institutional endorsement. Evidence withheld means the latest submission is currently quarantined; historical review/adoption receipts are preserved but are not counted as currently available evidence. General and institution-specific stages overlap and do not imply dependencies, priority scores or automatic activation. Source dates, missing values and local applicability still require review.'};
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
    return {leads,total,offset,limit,workflow_summary:workflowSummary,target_context:target?{...target,qualification:SDG_TARGETS.qualification}:null,region_context:region?{id:region.id,name:region.name,focus:region.mayor.focus,goals:region.researchGoals.map(number=>({number,name:SDG_GOALS[number-1]})),qualification:region.researchMapping}:null,has_more:offset+limit<total,country_plan:this.countryResearchPlan(input),counts:this.all('SELECT current_status AS status,COUNT(*) AS count FROM '+researchView+' GROUP BY current_status'),catalog_total:this.get("SELECT COUNT(*) AS n FROM "+researchView+" WHERE current_status NOT IN ('consolidated','retired')").n,retained_total:this.get('SELECT COUNT(*) AS n FROM research_leads').n};
  },
  researchGenerate(actor,input){
    human(actor,['admin','reviewer']);this.active();const country=COUNTRIES.entries.find(country=>country.iso2===input.country_code);if(!country)fail(400,'Choose a catalog country or area.');
    if(input.target_code&&input.institution_id)fail(400,'Choose a target or an institution for one generation request.');
    if(input.target_code){
      const target=SDG_TARGETS.entries.find(item=>item.code===input.target_code);if(!target)fail(400,'Choose a catalog SDG target.');let added=0;
      for(const stage of stages){const id=`target-${target.code}-${country.iso2}-${stage.id}`,sources=[target.sourceUrl+'#target-'+target.code,'https://sdgs.un.org/2030agenda',COUNTRIES.metadata.sourceUrl];
        const instructions=`${stage.output} Country: ${country.name}; SDG ${target.goal}, target ${target.code}. Editorial focus: ${target.focus}. Read the full official target at ${target.evidenceLocator}; check current indicator definitions, national priorities, source dates and country-specific evidence before making findings. Years mentioned in original target wording: ${target.originalYears.join(', ')||'none recorded'}. These are not new deadlines. Verify current measurement definitions separately, including poverty thresholds and population coverage; original target wording is not automatically a current statistical definition. Separate global objectives, national observations, proposed work, funding needs and actual support. ${SDG_TARGETS.qualification} NemoWorld proposes this research independently.`;
        added+=this.recordLead({id,country_code:country.iso2,goal:target.goal,stage:'target-'+stage.id,title:`${country.name}: Target ${target.code} · ${stage.name}`.slice(0,100),instructions,rubric,source_urls:sources,substantive_key:`target-${stage.id}|${target.code}|${country.iso2}`});
      }this.audit(actor.account.id,'research.target_generated',target.code+':'+country.iso2);return {country:country.name,target:target.code,added};
    }
    if(input.institution_id){
      const institution=PROGRAMMES.institutions.find(item=>item.id===input.institution_id);if(!institution)fail(400,'Choose a catalog institution.');
      let added=0;const goal=institution.sdgs[0];
      for(const stage of [stages[0],stages[3]]){
        const id=`programme-${institution.id}-${country.iso2}-${stage.id}`;
        const sources=[...new Set([institution.sourceUrl,...(institution.relatedSourceUrls||[]),...institution.sdgLinks])];
        const instructions=`${stage.output} Country: ${country.name}. Institution reference: ${institution.name}; focus: ${institution.mandate.replace(/\.$/,'')}. ${institution.sourceCheckNote?'Reference retrieval qualification: '+institution.sourceCheckNote+' ':''}Required country evidence: ${(institution.countryResearchChecks||[]).join(' ')||'Verify current country applicability and source dates.'} Proposed research: ${institution.suggestedTaskTypes.join('; ')}. Find current country evidence, latest official programme documents, responsible national institutions and a practical delivery route. Check geographic coverage, eligibility and programme dates. The source framework does not prove country findings, funding, recipient interest, consent or endorsement. NemoWorld proposes this work independently.`;
        added+=this.recordLead({id,country_code:country.iso2,goal,stage:`programme-${stage.id}`,title:`${country.name}: ${stage.name} · ${institution.name}`.slice(0,100),instructions,rubric,source_urls:sources,substantive_key:`programme-${stage.id}|${institution.id}|${country.iso2}`});
      }
      this.audit(actor.account.id,'research.programme_generated',institution.id+':'+country.iso2);
      return {country:country.name,institution:institution.name,added};
    }
    const before=this.get('SELECT COUNT(*) AS n FROM research_leads WHERE country_code=?',country.iso2).n;this.seedCountryResearch(country);this.audit(actor.account.id,'research.generated',country.iso2);
    return {country:country.name,added:this.get('SELECT COUNT(*) AS n FROM research_leads WHERE country_code=?',country.iso2).n-before};
  },
  researchActivate(actor,input){
    human(actor,['admin','reviewer']);this.active();const lead=this.get('SELECT * FROM research_leads WHERE id=?',input.lead_id);if(!lead)fail(404,'Research proposal not found.');if(lead.task_id)return {mission_id:lead.mission_id,task_id:lead.task_id,status:lead.status};
    const consolidation=this.get('SELECT canonical_id FROM research_lead_consolidations WHERE consolidated_id=? LIMIT 1',lead.id);
    if(consolidation)fail(409,consolidation.canonical_id?`This proposal was consolidated; scope its replacement ${consolidation.canonical_id} instead.`:'This template is retired without a scoped replacement. Collect baseline evidence and author a scoped applied concern first.');
    const beneficiary=text(input.beneficiary,2000,'Intended beneficiary');
    const mission=this.createMission(actor,{title:lead.title,area:lead.stage==='agriculture'?'Agriculture':'Development',summary:lead.instructions.slice(0,2000),beneficiary,owner_id:input.owner_id,reviewer_id:input.reviewer_id,rubric:lead.rubric});
    const domains=input.allowed_domains || [...new Set(JSON.parse(lead.source_urls).map(url=>new URL(url).hostname))];
    const task=this.createTask(actor,{mission_id:mission.id,title:lead.title,instructions:(lead.instructions+'\n'+lead.rubric).slice(0,2000),rights:'Paraphrase with attribution; inspect each source reuse terms. No full protected content or logos. Public contact routes are research only; no outreach authorization.',allowed_domains:domains});
    this.missionStatus(actor,mission.id,'open');
    this.run("UPDATE research_leads SET status='activated',mission_id=?,task_id=? WHERE id=?",mission.id,task.id,lead.id);this.audit(actor.account.id,'research.activated',lead.id);
    return {mission_id:mission.id,task_id:task.id,status:'activated'};
  },
  // Idempotent per-boot seeding: exactly one ambassador row per catalog entry, one generated venue
  // world per row, and the historic guide mapping. Re-running it changes nothing.
  seedAmbassadors(){
    const created_at=new Date(this.clock()).toISOString();
    COUNTRIES.entries.forEach((country,index)=>{
      const id=ambassadorId(country.iso3),world_id=`country:${country.iso3}`,stand=standFor(index);
      this.run("INSERT OR IGNORE INTO worlds VALUES(?,?,?,NULL,'public',?,?,?)",world_id,`${country.name} research venue`,'country',40,28,created_at);
      this.run('INSERT OR IGNORE INTO npc_ambassadors(id,iso2,iso3,m49,name,region,subregion,ldc,lldc,sids,world_id,sprite,x,y,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,country.iso2,country.iso3,country.m49,country.name,country.region||'',country.subregion||'',country.ldc?1:0,country.lldc?1:0,country.sids?1:0,world_id,roster[index%roster.length],stand.x,stand.y,created_at);
    });
    REGIONS.forEach((region,index)=>{
      const country=legacyCountryFor(index),mapped=ambassadorId(country.iso3);
      const inserted=this.run('INSERT OR IGNORE INTO ambassador_legacy_map(guide_id,region_id,ambassador_id,created_at) VALUES(?,?,?,?)',region.mayor.id,region.id,mapped,created_at).changes;
      // A paused historic guide hands its paused state to its replacement exactly once, when the
      // mapping is first recorded, so a later manual resume is not undone by the next boot.
      if(inserted&&this.get("SELECT status FROM npc_mayors WHERE id=?",region.mayor.id)?.status==='paused')this.run("UPDATE npc_ambassadors SET status='paused' WHERE id=?",mapped);
    });
  },
  ambassadorRow(id){const row=this.get('SELECT * FROM npc_ambassadors WHERE id=?',String(id||''));if(!row)fail(404,'Country ambassador not found.');return row;},
  ambassadorContext(country,capturedAt){
    const agriculture=this.countryEvidence(null,{country:country.iso2}),access=this.countryEvidence(null,{country:country.iso2,sector:'access'});
    return ambassadorCountryContext(agriculture,access,capturedAt);
  },
  ambassadors(actor,input={}){
    const q=String(input.q||'').trim().toLowerCase().slice(0,80),group=String(input.group||'');
    if(group&&!['ldc','lldc','sids'].includes(group))fail(400,'Unknown country grouping.');
    const privileged=actor?.kind==='session'&&['admin','moderator'].includes(actor.account.role);
    const includePaused=privileged&&['1','true'].includes(String(input.include_paused||''));
    const status=includePaused?String(input.status||'all'):'active';
    if(!['active','paused','all'].includes(status))fail(400,'Choose active, paused or all.');
    const offset=integer(input.offset,0,100000),limit=integer(input.limit,20,50);if(!limit)fail(400,'Page size must be positive.');
    const matches=ambassador=>(!group||Boolean(ambassador[group]))&&(!q||`${ambassador.name} ${ambassador.iso2} ${ambassador.iso3} ${ambassador.m49} ${ambassador.region} ${ambassador.subregion}`.toLowerCase().includes(q));
    const rows=this.all('SELECT * FROM npc_ambassadors ORDER BY name,iso3'),filtered=rows.filter(matches),visible=filtered.filter(row=>status==='all'||row.status===status);
    return {catalog:{name:'Countries & areas',total:rows.length,source:COUNTRIES.metadata.sourceUrl,note:'A statistical catalog of countries or areas, not a list of sovereign states or UN members.'},
      entries:visible.slice(offset,offset+limit).map(ambassadorView),total:visible.length,offset,limit,has_more:offset+limit<visible.length,status,
      counts:{active:rows.filter(row=>row.status==='active').length,paused:rows.filter(row=>row.status==='paused').length,ldc:rows.filter(row=>row.ldc).length,lldc:rows.filter(row=>row.lldc).length,sids:rows.filter(row=>row.sids).length},
      excluded:{not_shown:filtered.length-visible.length,reason:'Paused ambassadors are withheld from the public directory; a signed-in moderator can request include_paused=1.'},
      remit:AMBASSADOR_REMIT,mode:'Scripted country ambassadors; responses follow published rules and catalog evidence.'};
  },
  ambassador(actor,input={}){
    const row=this.ambassadorRow(input.id||input.ambassador_id),country=COUNTRIES.entries.find(item=>item.iso3===row.iso3),captured_at=new Date(this.clock()).toISOString();
    const context=this.ambassadorContext(country,captured_at);
    const legacy=this.get('SELECT guide_id,region_id FROM ambassador_legacy_map WHERE ambassador_id=?',row.id);
    const conversations=actor?.kind==='session'?this.all('SELECT * FROM ambassador_conversations WHERE account_id=? AND ambassador_id=? ORDER BY created_at DESC LIMIT 20',actor.account.id,row.id).map(ambassadorConversation):[];
    const legacy_conversations=actor?.kind==='session'&&legacy?this.all('SELECT * FROM mayor_conversations WHERE account_id=? AND npc_id=? ORDER BY created_at DESC LIMIT 20',actor.account.id,legacy.guide_id).map(mayorConversation):[];
    return {ambassador:ambassadorView(row),
      country:{name:country.name,iso2:country.iso2,iso3:country.iso3,m49:country.m49,region:country.region,subregion:country.subregion,groups:{ldc:country.ldc,lldc:country.lldc,sids:country.sids},source:COUNTRIES.metadata.sourceUrl},
      remit:AMBASSADOR_REMIT,
      venue:{world_id:row.world_id,name:`${country.name} research venue`,kind:'country',x:row.x,y:row.y,columns:40,rows:28,route:`GET /api/v1/world?world_id=${row.world_id}; the venue is generated and holds no frontier land.`},
      country_context:context,
      research:{leads:this.all('SELECT id,goal,stage,title,status,country_code FROM research_leads WHERE country_code=? ORDER BY goal,stage,id LIMIT 20',country.iso2),lead_total:this.get('SELECT COUNT(*) AS n FROM research_leads WHERE country_code=?',country.iso2).n,
        evidence_routes:context.sources.map(source=>({number:source.number,sector:source.sector,indicator:source.indicator,name:source.name,status:source.status,url:source.url,definition_url:source.definition_url,metadata_url:source.metadata_url}))},
      legacy:legacy?{...legacy,region_name:REGIONS.find(region=>region.id===legacy.region_id)?.name||null}:null,
      conversations,legacy_conversations,mode:'Scripted country ambassadors; responses follow published rules and catalog evidence.'};
  },
  ambassadorTalk(actor,input={}, {legacyWithoutContext=false}={}){
    human(actor,['admin','member','moderator','reviewer']);this.active();
    if(Object.hasOwn(input,'context'))fail(400,'The assigned country context cannot be overridden.');
    const row=this.get("SELECT * FROM npc_ambassadors WHERE id=? AND status='active'",String(input.ambassador_id||input.id||input.npc_id||''));
    if(!row)fail(404,'Active country ambassador not found.');
    // Ordinary research conversations remain account-level. A first-play encounter names an owned
    // active character and must happen while that character stands near this visible ambassador;
    // only then can the saved conversation count as an in-world meeting for that character.
    const meetingAgent=input.agent_id===undefined?null:this.ownedAgent(actor,input.agent_id);
    if(meetingAgent){
      if(meetingAgent.status!=='active')fail(403,'Resume this character before meeting the ambassador.');
      if(meetingAgent.world_id!==row.world_id||Math.abs(meetingAgent.x-row.x)+Math.abs(meetingAgent.y-row.y)>6)fail(409,'Walk this character within six tiles of the ambassador in its country venue before asking a first-play question.');
    }
    const supplied=String(input.country_code??'').trim().toUpperCase();
    if(supplied&&![row.iso2.toUpperCase(),row.iso3.toUpperCase(),row.m49].includes(supplied))fail(400,`Country mismatch: this ambassador answers only for ${row.name} (${row.iso3}).`);
    const last=this.get('SELECT created_at FROM ambassador_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 1',actor.account.id);if(last&&this.clock()-Date.parse(last.created_at)<1500)fail(429,'Please allow the ambassador to finish.');
    const country=COUNTRIES.entries.find(item=>item.iso3===row.iso3),question=text(input.question,500,'Question'),topic=mayorTopic(question),created_at=new Date(this.clock()).toISOString();
    // The canonical route always attaches the ambassador's assigned country context. The legacy alias
    // uses an internal option for a general question; request fields cannot disable context.
    const withContext=!legacyWithoutContext,country_context=withContext?this.ambassadorContext(country,created_at):null;
    const retained=country_context?country_context.sources.filter(source=>source.status==='retained').length:0;
    let answer=ambassadorIdentity(country);
    if(topic==='moderation')answer+=' Use the Safety desk to report a specific message or resident. Human moderators review evidence, decide actions, and provide an appeal route. I can guide you through the process; I cannot impose sanctions.';
    else if(topic==='assembly')answer+=` World Assembly is an independent NemoWorld institution. Its reference desk contains ${PROGRAMMES.institutions.length} records covering principal organs, General Assembly committees, ECOSOC commissions, specialized agency groups, funds and other entities. It does not enumerate every UN programme or subsidiary body. UN sources inform NemoWorld proposals; NemoWorld has no UN endorsement.`;
    else if(!withContext)answer+=` Choose a country or area to attach its registered country context and numbered sources before making findings.`;
    else if(retained){answer+=` ${retained} registered ${retained===1?'series is':'series are'} retained for ${country.name}; the numbered cards below carry the exact values, observation years and source dates. Define a beneficiary and a scoped question, keep the evidence gaps visible, and treat national indicators as context only — they cannot establish current rules, buyers, prices or local feasibility. Register work as a proposal with an owner and an independent reviewer before it is used.`;}
    else{answer+=` No registered baseline series is retained for ${country.name}. Treat that as an evidence gap: work with country-specific primary sources and record access and reuse rights before making findings. Register work as a proposal with an owner and an independent reviewer.`;}
    if(withContext&&topic==='agriculture'&&retained)answer+=' Choose a producer, a municipality and a crop, then verify local production, product standards, buyer demand, shipping costs and applicable trade requirements separately.';
    const source_numbers=!country_context||['moderation','assembly'].includes(topic)?[]:country_context.sources.filter(source=>source.status==='retained').map(source=>source.number);
    const id=randomUUID();
    this.run('INSERT INTO ambassador_conversations(id,account_id,ambassador_id,question,answer,created_at,country_context,source_numbers) VALUES(?,?,?,?,?,?,?,?)',id,actor.account.id,row.id,question,answer,created_at,country_context?JSON.stringify(country_context):null,JSON.stringify(source_numbers));
    if(meetingAgent)this.audit(actor.account.id,'firstplay.ambassador_met',`${meetingAgent.id}|${id}`);
    this.run('DELETE FROM ambassador_conversations WHERE account_id=? AND id NOT IN (SELECT id FROM ambassador_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 100)',actor.account.id,actor.account.id);
    return {id,ambassador_id:row.id,country:{name:country.name,iso2:country.iso2,iso3:country.iso3,m49:country.m49},question,answer,created_at,mode:'rules',country_context,source_numbers};
  },
  // Pausing an ambassador also pauses its mapped historic guide, so the legacy patrol stops with it.
  ambassadorControl(actor,input={}){human(actor,['admin','moderator']);if(!['active','paused'].includes(input.status))fail(400,'Choose active or paused.');const row=this.ambassadorRow(input.ambassador_id||input.id||input.npc_id);this.run('UPDATE npc_ambassadors SET status=? WHERE id=?',input.status,row.id);this.run('UPDATE npc_mayors SET status=? WHERE id IN (SELECT guide_id FROM ambassador_legacy_map WHERE ambassador_id=?)',input.status,row.id);this.audit(actor.account.id,'ambassador.'+input.status,row.id);return {status:input.status,ambassador_id:row.id};},
  ambassadorResidents(worldId){return this.all("SELECT * FROM npc_ambassadors WHERE world_id=? AND status='active' ORDER BY name,iso3",worldId).map(ambassadorView);},
  // Legacy listing: the 20 historic regional guides remain readable with their own patrol state,
  // each annotated with the replacement country ambassador it is mapped to. New conversations are
  // read from the ambassador store; the historic store is returned separately as legacy_conversations.
  mayors(actor,input={}){
    this.tickMayors();
    const rows=this.all('SELECT * FROM npc_mayors ORDER BY region_id');
    const residents=rows.map(mayor=>{
      const region=REGIONS.find(region=>region.id===mayor.region_id);
      const mapped=this.get('SELECT m.ambassador_id,a.name AS ambassador_name,a.iso3,a.iso2,a.world_id AS ambassador_world FROM ambassador_legacy_map m JOIN npc_ambassadors a ON a.id=m.ambassador_id WHERE m.guide_id=?',mayor.id);
      return {...mayor,kind:'npc',mode:'rules',focus:region.mayor.focus,title:`Regional guide of ${region.name}`,legacy:true,presence:mayor.status==='active'?'resident':'paused',color:'#397f79',symbol:'✦',ambassador_id:mapped?.ambassador_id||null,ambassador:mapped?{id:mapped.ambassador_id,name:mapped.ambassador_name,iso2:mapped.iso2,iso3:mapped.iso3,world_id:mapped.ambassador_world}:null};
    });
    const conversations=actor?.kind==='session'?this.all('SELECT c.*,(SELECT guide_id FROM ambassador_legacy_map m WHERE m.ambassador_id=c.ambassador_id) AS guide_id FROM ambassador_conversations c WHERE c.account_id=? ORDER BY c.created_at DESC LIMIT 20',actor.account.id).map(record=>({...ambassadorConversation(record),npc_id:record.guide_id})).map(({guide_id,...turn})=>turn):[];
    const legacy_conversations=actor?.kind==='session'?this.all('SELECT * FROM mayor_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 20',actor.account.id).map(mayorConversation):[];
    return {mayors:input.world_id?residents.filter(mayor=>mayor.world_id===input.world_id):residents,conversations,legacy_conversations,legacy_alias:true,mode:'Scripted country ambassadors; responses follow published rules and catalog evidence.'};
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
  // Legacy alias: the historic guide id is recorded in the mapping, and a supplied country_code keeps
  // its historical meaning by selecting that country's ambassador. The new /ambassadors/talk route is
  // the one that refuses a country mismatch; this alias preserves the documented legacy behaviour.
  mayorTalk(actor,input={}){
    human(actor,['admin','member','moderator','reviewer']);this.active();
    const guide=this.get('SELECT id FROM npc_mayors WHERE id=?',String(input.npc_id||''));
    if(!guide)fail(404,'Active ambassador not found.');
    const requested=input.country_code==null||input.country_code===''?null:COUNTRIES.entries.find(country=>[country.iso2,country.iso3,country.m49].includes(String(input.country_code).trim().toUpperCase()));
    if(input.country_code!=null&&input.country_code!==''&&!requested)fail(400,'Choose a catalog country or area.');
    const mapped=this.get('SELECT ambassador_id FROM ambassador_legacy_map WHERE guide_id=?',guide.id);
    const ambassador=requested?ambassadorId(requested.iso3):mapped?.ambassador_id;
    if(!ambassador)fail(404,'Active ambassador not found.');
    const result=this.ambassadorTalk(actor,{ambassador_id:ambassador,question:input.question,country_code:requested?requested.iso2:undefined},{legacyWithoutContext:!requested});
    return {...result,npc_id:guide.id,legacy_alias:true};
  },
  // Legacy alias: pausing through the historic guide delegates to the ambassador control, which also
  // stops the historic patrol row so the old listing and the new directory stay consistent.
  mayorControl(actor,input={}){
    human(actor,['admin','moderator']);
    const guide=this.get('SELECT id FROM npc_mayors WHERE id=?',String(input.npc_id||''));
    if(!guide)fail(404,'Ambassador not found.');
    const mapped=this.get('SELECT ambassador_id FROM ambassador_legacy_map WHERE guide_id=?',guide.id);
    const result=mapped?this.ambassadorControl(actor,{ambassador_id:mapped.ambassador_id,status:input.status}):{status:input.status};
    return {...result,npc_id:guide.id,legacy_alias:true};
  },
  mayorTriage(actor){
    human(actor,['admin','moderator']);return {mode:'rules',authority:'Advisory only; human moderators decide.',reports:this.all("SELECT id,target_type,target_id,reason,created_at FROM reports WHERE status='open' ORDER BY created_at LIMIT 100").map(report=>({...report,priority:/threat|violence|private|address|danger/i.test(report.reason)?'urgent human review':'standard human review',recommendation:'Inspect the reported record and context. Preserve evidence, apply community rules proportionately, and record reasons and appeal rights.'}))};
  },
  civicExport(actor){return {conversations:this.all('SELECT * FROM ambassador_conversations WHERE account_id=? ORDER BY created_at',actor.account.id).map(ambassadorConversation),
    legacy_conversations:this.all('SELECT * FROM mayor_conversations WHERE account_id=? ORDER BY created_at',actor.account.id).map(mayorConversation),
    ambassadors:this.all('SELECT id,iso2,iso3,name,world_id,sprite,status FROM npc_ambassadors WHERE id IN (SELECT ambassador_id FROM ambassador_conversations WHERE account_id=?) ORDER BY name',actor.account.id)};},
};
