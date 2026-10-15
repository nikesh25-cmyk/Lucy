import {verifyCoinLedger} from './coins.js';
import { verifyKarmaLedger } from './karma.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, copyFileSync, renameSync, lstatSync, constants } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMMUNITY_TABLES } from './community.js';
import { JOURNEY_TABLES } from './journey.js';
import { verifyCallingReceipts, verifyMemoryRecords } from './vocations.js';
import { vaultSchemaPresent, verifyVaultRecords } from './vault.js';
import { verifyQuestReceipts, verifyQuestStructure } from './quests.js';
import { verifyGuildRecords } from './guilds.js';
import { REGIONS } from './civic.js';
import { GARDEN_PALETTE,HOUSE_PALETTE } from './placement-policy.js';
import { GRANT_SCOPE_LIMITS, grantScopeNarrow, grantScopeValue } from './frontier.js';
import { tradeSchemaPresent, verifyTradeRecords, verifyTradeSchema } from './trade-board.js';
import { worldContentChecksCurrent } from './schema24.js';
import { worldContentChecksUpgradeable, WORLD_CONTENT_SCHEMA_VERSION } from './schema27.js';

const countryCatalog=JSON.parse(readFileSync(new URL('../catalog/countries.json',import.meta.url),'utf8')).entries;

// The bounded evidence library's own numbers (schema 22). They are the quota a capture write is held
// to and the bound the recovery pass re-checks. Stated in docs/handoff/task-25-evidence-library.md.
export const EVIDENCE_KINDS = Object.freeze(['web-excerpt','normalized-statistics','trade-preview','global-target-framework','reviewed-pdf','plain-text']);
export const EVIDENCE_LIMITS = Object.freeze({
  schema_version: 22,
  // Retained records: at most this many sources and captures overall, and this many versions of any
  // one source. A capture counts whether it references retained bytes or only a contributor hash.
  max_sources: 2048,
  max_captures: 8192,
  max_captures_per_source: 8,
  // Retained bytes: the summed size of capture records that reference bytes under catalog/. The 228
  // retained catalog responses are about 0.9 MiB, far inside this ceiling.
  max_retained_bytes: 96 * 1024 * 1024,
  max_excerpt_characters: 400,
  // Per-artifact evidence limit: one submission may cite the same 1–10 sources it has always allowed.
  per_artifact_evidence: 10,
  // Retention/eviction rule. Cited evidence is never deleted; the library refuses instead.
  eviction_rule: 'A new capture may evict the oldest retained version of a source that no submission cites. A version a submission cites is never evicted, so a capture that would exceed a quota while every candidate is cited fails closed instead of deleting cited evidence.',
  capture_rule: 'A capture records bytes retained under catalog/ or the SHA-256 a contributor reader computed. The library performs no network fetch of its own.',
});

// Recompute the identity an evidence source is addressed by: host, path and the query parameters in
// sorted order. Two captures of the same series or the same bounded API query share one identity.
export function evidenceSourceKey(value){const url=new URL(value),params=[...url.searchParams].map(([name,item])=>`${name}=${item}`).sort().join('&');return `${url.hostname}${url.pathname}${params?`?${params}`:''}`;}
const evidenceStamp=(value)=>typeof value==='string'&&(isoTime(value)||/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value);
const evidenceDate=(value)=>value===''||(/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value);
// Every stored evidence row must still satisfy the rules that created it. A rewritten capture, a
// source re-pointed at a different identity, a citation that no longer names its own capture, or a
// capture past its quotas all fail here, so a backup, a restore or a startup refuses them.
export function verifyEvidenceRecords(db){
  const sources=db.prepare('SELECT * FROM evidence_sources').all();
  if(sources.length>EVIDENCE_LIMITS.max_sources)return false;
  const sourceById=new Map();
  for(const source of sources){
    let url;try{url=new URL(source.url);}catch{return false;}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return false;
    if(source.source_key!==evidenceSourceKey(source.url)||source.host!==url.hostname||source.path!==url.pathname)return false;
    if(!['active','withdrawn'].includes(source.status))return false;
    if(source.status==='withdrawn'?!source.withdrawn_reason.trim():source.withdrawn_reason!=='')return false;
    if(!isoTime(source.created_at))return false;
    sourceById.set(source.id,source);
  }
  const captures=db.prepare('SELECT c.*,c.rowid AS seq FROM evidence_captures c').all();
  if(captures.length>EVIDENCE_LIMITS.max_captures)return false;
  const sequence=new Map(),captureById=new Map(),perSource=new Map();
  let retainedBytes=0;
  for(const capture of captures){
    const source=sourceById.get(capture.source_id);
    if(!source||capture.source_key!==source.source_key)return false;
    // What a capture is stored under must be the identity it names: the same address rules the source
    // is held to, and the same key a citation is resolved by. A capture re-pointed at another host,
    // path or port — while keeping the source it claims — fails here.
    let captureUrl;try{captureUrl=new URL(capture.url);}catch{return false;}
    if(!['http:','https:'].includes(captureUrl.protocol)||captureUrl.username||captureUrl.password||captureUrl.port||evidenceSourceKey(capture.url)!==capture.source_key)return false;
    if(!/^[a-f0-9]{64}$/.test(capture.sha256)||!Number.isInteger(capture.bytes)||capture.bytes<0)return false;
    if(![0,1].includes(capture.retained))return false;
    if(capture.retained===1){if(capture.bytes<=0||!/^catalog\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(capture.retained_path))return false;retainedBytes+=capture.bytes;}
    else if(capture.retained_path!=='')return false;
    if(!['catalog','submission','curator'].includes(capture.origin)||!EVIDENCE_KINDS.includes(capture.evidence_kind))return false;
    if(!evidenceStamp(capture.retrieved_at)||!evidenceDate(capture.declared_date)||!isoTime(capture.created_at))return false;
    if(typeof capture.excerpt!=='string'||capture.excerpt.length>EVIDENCE_LIMITS.max_excerpt_characters)return false;
    if(capture.supersedes!==null){const prior=sequence.get(capture.supersedes);if(prior===undefined||sequence.get(capture.supersedes)>=capture.seq||captureById.get(capture.supersedes)?.source_id!==capture.source_id)return false;}
    sequence.set(capture.id,capture.seq);captureById.set(capture.id,capture);
    perSource.set(capture.source_id,(perSource.get(capture.source_id)||0)+1);
  }
  if([...perSource.values()].some((count)=>count>EVIDENCE_LIMITS.max_captures_per_source))return false;
  // Retained bytes are the quota a capture write is held to, so the stored total is re-checked too:
  // a backup carrying more retained bytes than the library allows is refused, not opened.
  if(retainedBytes>EVIDENCE_LIMITS.max_retained_bytes)return false;
  const withdrawals=new Map();
  for(const event of db.prepare('SELECT * FROM evidence_events').all()){
    if(!sourceById.has(event.source_id)||!['withdrawn','restored'].includes(event.kind)||typeof event.detail!=='string'||event.detail.length<1||event.detail.length>300||!isoTime(event.created_at))return false;
    const tally=withdrawals.get(event.source_id)||{withdrawn:0,restored:0};
    tally[event.kind]=tally[event.kind]+1;withdrawals.set(event.source_id,tally);
  }
  // The event history and the status it explains must still agree. A withdrawal is its own
  // append-only event carrying the reason, and a fresh capture is the restore that answers it, so a
  // source marked withdrawn without that event — or restored more often than it was withdrawn — is
  // refused. Every source's count is therefore one while it is withdrawn and zero while it is active.
  for(const source of sources){
    const tally=withdrawals.get(source.id)||{withdrawn:0,restored:0};
    if(tally.restored>tally.withdrawn||tally.withdrawn-tally.restored!==(source.status==='withdrawn'?1:0))return false;
  }
  for(const cite of db.prepare('SELECT * FROM submission_evidence').all()){
    if(!Number.isInteger(cite.source_number)||cite.source_number<1||cite.source_number>EVIDENCE_LIMITS.per_artifact_evidence)return false;
    if(!['captured','missing'].includes(cite.state)||!isoTime(cite.created_at))return false;
    let url;try{url=new URL(cite.url);}catch{return false;}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return false;
    if(cite.capture_id===null){if(cite.state!=='missing')return false;}
    else{const capture=captureById.get(cite.capture_id);if(!capture||capture.source_key!==evidenceSourceKey(cite.url)||cite.state!=='captured')return false;}
  }
  return true;
}
const requiredTables = ['accounts', 'invites', 'agents', 'tokens', 'missions', 'tasks', 'claims', 'submissions', 'reviews', 'adoptions', 'messages', 'reports', 'appeals', 'jobs', 'settings', 'audit'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
/** The one stored timestamp format: a 24-character UTC ISO string, exactly as `Date` writes it. */
const isoTime = (value) => typeof value === 'string' && value.length === 24 && value === new Date(value).toISOString();

// One bounded managed resident run. `phase` names exactly what was in flight when the process last
// wrote, so a restart can tell a model call apart from a sent action. `interrupted` is the honest
// classification written once by recovery; it is never guessed from the world.
export const RESIDENT_RUN_PHASES = Object.freeze(['starting','observing','model_call','dispatch','confirmed','finished']);
export const RESIDENT_RUN_STATUSES = Object.freeze(['running','completed','stopped','failed','interrupted']);
export const RESIDENT_RUN_INTERRUPTIONS = Object.freeze(['no_action_yet','model_call_in_flight','action_dispatched_unconfirmed','action_confirmed','unknown']);
export const INTERRUPTION_SUMMARY = Object.freeze({
  no_action_yet: 'The process died before any action was confirmed',
  model_call_in_flight: 'The process died while a model call was in flight; no action was sent for that decision',
  action_dispatched_unconfirmed: 'An action was being dispatched and its confirmation was never recorded; verify it in the world before retrying',
  action_confirmed: 'The last confirmed action is recorded and nothing was pending',
  unknown: 'No durable run state matched this job',
});

// Classify one interrupted run from its last durable write. Only what the record can prove is
// distinguished; anything unrecognized stays 'unknown' rather than being assumed safe.
export function classifyResidentRun(run) {
  if (!run) return 'unknown';
  const action = (() => { try { return JSON.parse(run.last_action || '{}'); } catch { return {}; } })();
  let pending = {};
  try { pending = JSON.parse(run.pending_action || '{}'); } catch { pending = {}; }
  if (run.phase === 'model_call') return 'model_call_in_flight';
  if (run.phase === 'dispatch') return pending?.action ? 'action_dispatched_unconfirmed' : 'unknown';
  if (run.phase === 'confirmed') return 'action_confirmed';
  if (run.phase === 'starting' || run.phase === 'observing') return action?.action ? 'action_confirmed' : 'no_action_yet';
  return 'unknown';
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
function regularFile(path) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Expected an existing regular database file.');
}
export function validateDatabase(path) {
  regularFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity validation failed.');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (!Number.isInteger(version) || version < 1 || version > WORLD_CONTENT_SCHEMA_VERSION) throw new Error('Unsupported database schema version.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((item) => item.name));
    const expectedTables = version >= 3 ? [...requiredTables, 'worlds', 'world_objects', ...COMMUNITY_TABLES, ...JOURNEY_TABLES] : version === 2 ? [...requiredTables, 'worlds', 'world_objects'] : requiredTables;
    if (expectedTables.some((table) => !tables.has(table))) throw new Error('This is not a complete NemoWorld database.');
    if (version >= 2 && ['agents', 'messages'].some((table) => !db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'world_id'))) throw new Error('Database world schema is incomplete.');
    if (version >= 3 && ['emote', 'emote_until', 'last_emote'].some((column) => !db.prepare('PRAGMA table_info(agents)').all().some((field) => field.name === column))) throw new Error('Database resident schema is incomplete.');
    if (version >= 4 && ['region_id', 'country'].some((column) => !db.prepare('PRAGMA table_info(agents)').all().some((field) => field.name === column))) throw new Error('Database civic schema is incomplete.');
    if (version >= 5 && ['npc_mayors','mayor_conversations','research_leads'].some((table) => !tables.has(table))) throw new Error('Database research schema is incomplete.');
    if(version>=6&&!tables.has('claim_drafts'))throw new Error('Database draft schema is incomplete.');
    if(version>=7&&(!tables.has('task_followups')||['task_id','submission_id','creator_id','idempotency_key','fingerprint','created_at'].some(column=>!db.prepare('PRAGMA table_info(task_followups)').all().some(field=>field.name===column))))throw new Error('Database follow-up schema is incomplete.');
    if(version>=8){if(!tables.has('coin_rewards')||['coins_no_update','coins_no_delete','coins_validate_insert'].some(name=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)))throw new Error('Database coin schema is incomplete.');if(!verifyCoinLedger(db))throw new Error('Database coin ledger validation failed.');}
    if(version>=9&&['mode','country_context','source_numbers'].some(column=>!db.prepare('PRAGMA table_info(mayor_conversations)').all().some(field=>field.name===column)))throw new Error('Database mayor evidence schema is incomplete.');
    if (version >= 10) {
      if (!db.prepare('PRAGMA table_info(agents)').all().some(field => field.name === 'kind') || ['agents_kind_immutable','tokens_agent_runtime','tokens_agent_runtime_update'].some(name => !db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)) || !db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='one_human_avatar'").get()) throw new Error('Database human avatar schema is incomplete.');
      if (db.prepare("SELECT id FROM agents WHERE kind NOT IN ('agent','human')").get() || db.prepare("SELECT t.hash FROM tokens t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.kind='runtime' AND (a.id IS NULL OR a.kind!='agent' OR a.operator_id!=t.account_id)").get()) throw new Error('Database avatar identities are invalid.');
      const registration = db.prepare("SELECT value FROM settings WHERE key='registration'").get()?.value;
      if (!['open','closed'].includes(registration)) throw new Error('Database registration settings are invalid.');
      const frontierColumns = { frontier_sectors:['world_id','sector_x','sector_y','creator_account_id','creator_agent_id','created_at'], frontier_blocks:['id','world_id','x','y','z','type','creator_agent_id','creator_account_id','created_at'], frontier_actions:['id','account_id','agent_id','world_id','action','created_at'] };
      for (const [table, columns] of Object.entries(frontierColumns)) if (!tables.has(table) || columns.some(column => !db.prepare(`PRAGMA table_info(${table})`).all().some(field => field.name === column))) throw new Error('Database frontier schema is incomplete.');
    }
    if (version >= 11) {
      const landColumns = { land_parcels:['id','world_id','sector_x','sector_y','plot_x','plot_y','x','y','width','height','area_m2','buildable_cells','reserved','reserved_reason'], land_stewardships:['plot_id','account_id','purpose','description','assigned_at'], land_events:['id','plot_id','account_id','action','purpose','description','created_at'] };
      for (const [table, columns] of Object.entries(landColumns)) if (!tables.has(table) || columns.some(column => !db.prepare(`PRAGMA table_info(${table})`).all().some(field => field.name === column))) throw new Error('Database land schema is incomplete.');
      if (db.prepare('SELECT COUNT(*) AS n FROM land_parcels').get().n !== 16384) throw new Error('Database finite land registry is incomplete.');
      if (!db.prepare('PRAGMA table_info(frontier_blocks)').all().some(column => column.name === 'plot_id') || ['land_parcels_no_update','land_parcels_no_delete','land_parcels_validate_insert','land_stewardships_validate_insert','land_stewardships_no_update','frontier_sectors_finite_insert','frontier_sectors_identity_immutable','frontier_blocks_plot_insert'].some(name => !db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name))) throw new Error('Database land protections are incomplete.');
      if (db.prepare("SELECT id FROM land_parcels WHERE sector_x NOT BETWEEN -8 AND 7 OR sector_y NOT BETWEEN -8 AND 7 OR plot_x NOT BETWEEN 0 AND 7 OR plot_y NOT BETWEEN 0 AND 7 OR id!=printf('plot:%d:%d:%d:%d',sector_x,sector_y,plot_x,plot_y) OR world_id!='frontier:'||sector_x||':'||sector_y OR x!=plot_x*6 OR y!=plot_y*6 OR width!=6 OR height!=6 OR area_m2!=36 OR buildable_cells NOT BETWEEN 0 AND 36 OR reserved NOT IN (0,1) OR (reserved=0 AND reserved_reason!='') OR (reserved=1 AND reserved_reason='')").get()) throw new Error('Database land registry is invalid.');
      if (db.prepare("SELECT s.plot_id FROM land_stewardships s JOIN land_parcels p ON p.id=s.plot_id WHERE p.reserved!=0 OR length(trim(s.purpose)) NOT BETWEEN 1 AND 120 OR length(s.description)>500").get()) throw new Error('Database land stewardship is invalid.');
      if (db.prepare('SELECT b.id FROM frontier_blocks b JOIN land_parcels p ON p.id=b.plot_id WHERE b.world_id!=p.world_id OR b.x<p.x OR b.x>=p.x+p.width OR b.y<p.y OR b.y>=p.y+p.height').get()) throw new Error('Database parcel construction is invalid.');
      // Canonical legacy sectors outside the new perimeter stay valid backup records.
      if (db.prepare("SELECT world_id FROM frontier_sectors WHERE world_id!=printf('frontier:%d:%d',sector_x,sector_y)").get()) throw new Error('Database frontier area identities are invalid.');
    }
    if (version >= 12) {
      if (['z', 'grounded', 'yaw', 'pitch', 'last_look'].some(column => !db.prepare('PRAGMA table_info(agents)').all().some(field => field.name === column))) throw new Error('Database elevation schema is incomplete.');
      if (db.prepare('SELECT id FROM agents WHERE z NOT BETWEEN 0 AND 8').get()) throw new Error('Database elevation state is invalid.');
    }
    if (version >= 13) {
      if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name='world_objects_build_guard'").get()) throw new Error('Database garden build protections are incomplete.');
      const garden=GARDEN_PALETTE.map(type=>`'${type}'`).join(','),house=HOUSE_PALETTE.map(type=>`'${type}'`).join(',');
      if (db.prepare(`SELECT o.id FROM world_objects o JOIN worlds w ON w.id=o.world_id WHERE (w.kind='home' AND o.type NOT IN (${garden})) OR (w.kind='house' AND o.type NOT IN (${house}))`).get()) throw new Error('Database garden construction is invalid.');
      if (db.prepare("SELECT o.id FROM world_objects o JOIN worlds w ON w.id=o.world_id WHERE w.kind NOT IN ('home','house') OR o.x<0 OR o.x>=w.width OR o.y<0 OR o.y>=w.height").get()) throw new Error('Database garden construction is invalid.');
    }
    if (version >= 14) {
      const columns={resident_callings:['agent_id','calling_id','selected_at','last_changed_day'],calling_receipts:['id','agent_id','account_id','calling_id','objective_id','source_kind','source_id','source_at','selected_at','earned_day','points','created_at','proof_hash']};
      for(const [table,fields] of Object.entries(columns))if(!tables.has(table)||fields.some(column=>!db.prepare(`PRAGMA table_info(${table})`).all().some(field=>field.name===column)))throw new Error('Database calling schema is incomplete.');
      if(['world_objects_update_guard','calling_receipts_no_update','calling_receipts_validate_insert'].some(name=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name))||['calling_source_events','calling_objective_rules'].some(name=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='view' AND name=?").get(name)))throw new Error('Database calling and build protections are incomplete.');
      if(db.prepare("SELECT v.agent_id FROM resident_callings v JOIN agents a ON a.id=v.agent_id WHERE v.calling_id NOT IN (SELECT calling_id FROM calling_objective_rules) OR v.selected_at<0 OR (v.last_changed_day!='' AND (length(v.last_changed_day)!=10 OR date(v.last_changed_day) IS NULL))").get()||db.prepare('SELECT r.id FROM calling_receipts r JOIN agents a ON a.id=r.agent_id WHERE r.account_id!=a.operator_id').get()||!verifyCallingReceipts(db))throw new Error('Database calling progress validation failed.');
    }
    if (version >= 15) {
      const columns={npc_ambassadors:['id','iso2','iso3','m49','name','region','subregion','ldc','lldc','sids','world_id','sprite','x','y','direction','status','created_at'],ambassador_legacy_map:['guide_id','region_id','ambassador_id','created_at'],ambassador_conversations:['id','account_id','ambassador_id','question','answer','created_at','mode','country_context','source_numbers']};
      for(const [table,fields] of Object.entries(columns))if(!tables.has(table)||fields.some(column=>!db.prepare(`PRAGMA table_info(${table})`).all().some(field=>field.name===column)))throw new Error('Database country ambassador schema is incomplete.');
      // One row per catalog entry, addressed by its own iso3, each in its own country venue. The
      // catalog is sealed, so a mismatch means the migration did not complete.
      if(db.prepare("SELECT id FROM npc_ambassadors WHERE id!='amb-'||iso3 OR iso3 NOT GLOB '[A-Z][A-Z][A-Z]' OR iso2 NOT GLOB '[A-Z][A-Z]' OR world_id!='country:'||iso3 OR status NOT IN ('active','paused') OR x<0 OR y<0 OR sprite<0").get()||db.prepare('SELECT iso3 FROM npc_ambassadors GROUP BY iso3 HAVING COUNT(*)>1').get())throw new Error('Database country ambassador identities are invalid.');
      const ambassadors=db.prepare('SELECT * FROM npc_ambassadors').all();
      if(ambassadors.length!==countryCatalog.length)throw new Error('Database country ambassador roster is incomplete.');
      const countries=new Map(countryCatalog.map(country=>[country.iso3,country]));
      for(const resident of ambassadors){
        const country=countries.get(resident.iso3),venue=db.prepare('SELECT * FROM worlds WHERE id=?').get(resident.world_id);
        if(!country||resident.iso2!==country.iso2||resident.m49!==country.m49||resident.name!==country.name||resident.region!==(country.region||'')||resident.subregion!==(country.subregion||'')||['ldc','lldc','sids'].some(key=>resident[key]!==Number(Boolean(country[key]))))throw new Error('Database country ambassador catalog identity is invalid.');
        if(!venue||venue.kind!=='country'||venue.owner_agent_id!==null||venue.visibility!=='public'||venue.width!==40||venue.height!==28||resident.x>=venue.width||resident.y>=venue.height)throw new Error('Database country ambassador venue is invalid.');
      }
      // The compatibility mapping must cover every historic regional guide with an existing replacement.
      if(db.prepare('SELECT m.guide_id FROM ambassador_legacy_map m JOIN npc_mayors n ON n.id=m.guide_id LEFT JOIN npc_ambassadors a ON a.id=m.ambassador_id WHERE a.id IS NULL OR m.region_id!=n.region_id').get())throw new Error('Database country ambassador mapping is invalid.');
      if(REGIONS.some(region=>!db.prepare('SELECT guide_id FROM ambassador_legacy_map WHERE guide_id=?').get(region.mayor.id)))throw new Error('Database country ambassador mapping is incomplete.');
      if(db.prepare("SELECT c.id FROM ambassador_conversations c LEFT JOIN npc_ambassadors a ON a.id=c.ambassador_id WHERE a.id IS NULL").get())throw new Error('Database country ambassador conversations are invalid.');
    }
    if (version >= 16) {
      const columns=['id','account_id','agent_id','permission','status','phase','interrupted','stop_reason','decision','decision_budget','model_calls','action_count','failed_calls','failed_actions','last_action','pending_action','credential_hash','minutes','resumed_from','started_at','updated_at'];
      if(!tables.has('resident_runs')||columns.some(column=>!db.prepare('PRAGMA table_info(resident_runs)').all().some(field=>field.name===column)))throw new Error('Database resident run schema is incomplete.');
      const lists=`status NOT IN (${RESIDENT_RUN_STATUSES.map(value=>`'${value}'`).join(',')}) OR phase NOT IN (${RESIDENT_RUN_PHASES.map(value=>`'${value}'`).join(',')}) OR (interrupted!='' AND interrupted NOT IN (${RESIDENT_RUN_INTERRUPTIONS.map(value=>`'${value}'`).join(',')})) OR permission NOT IN ('observe','explore','creative')`;
      if(db.prepare(`SELECT r.id FROM resident_runs r WHERE ${lists} OR length(r.stop_reason)>64 OR decision_budget NOT BETWEEN 1 AND 20 OR minutes NOT BETWEEN 1 AND 20 OR decision<0 OR decision>decision_budget OR model_calls<0 OR model_calls>decision OR action_count<0 OR action_count>model_calls OR failed_calls<0 OR failed_calls>model_calls OR failed_actions<0 OR failed_actions>model_calls OR NOT json_valid(r.last_action) OR NOT json_valid(r.pending_action) OR json_type(r.last_action)!='object' OR json_type(r.pending_action)!='object' OR (r.credential_hash!='' AND (length(r.credential_hash)!=64 OR r.credential_hash GLOB '*[^0-9a-f]*')) OR (r.status='interrupted' AND r.interrupted='') OR (r.status NOT IN ('running','interrupted') AND r.phase!='finished') OR length(r.started_at)!=24 OR length(r.updated_at)!=24`).get())throw new Error('Database resident run state is invalid.');
      // An interrupted classification is written only by recovery, and a resumed run points at the
      // interrupted run it continues. Nothing here repeats an action; it records what already happened.
      if(db.prepare("SELECT r.id FROM resident_runs r LEFT JOIN resident_runs p ON p.id=r.resumed_from WHERE r.resumed_from IS NOT NULL AND (p.id IS NULL OR p.status!='interrupted' OR p.interrupted='')").get())throw new Error('Database resident run resume history is invalid.');
    }
    if (version >= 17) {
      const columns={quest_chains:['id','slug','title','route','summary','narrative','origin','author_account_id','status','practice','beneficiary','created_at','updated_at'],quest_steps:['id','chain_id','ordinal','slug','title','instructions','output_name','source_kind','requires_review','target','prerequisite_step_id','created_at'],quest_enrollments:['id','agent_id','account_id','chain_id','started_at','idempotency_key','created_at']};
      for(const [table,fields] of Object.entries(columns))if(!tables.has(table)||fields.some(column=>!db.prepare(`PRAGMA table_info(${table})`).all().some(field=>field.name===column)))throw new Error('Database quest chain schema is incomplete.');
      if(['quest_chains_identity_immutable','quest_steps_immutable','quest_chains_keep_steps'].some(name=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)))throw new Error('Database quest chain protections are incomplete.');
      // The replaced view must still carry the built-in objective rules and, while a chain is
      // published, the published step rules the receipt trigger validates against.
      const published=db.prepare("SELECT COUNT(*) AS n FROM quest_chains WHERE status='published'").get().n;
      if(!db.prepare("SELECT calling_id FROM calling_objective_rules WHERE objective_id='builder.frontier_place'").get()||(published&&!db.prepare("SELECT objective_id FROM calling_objective_rules WHERE objective_id LIKE 'quest:%' LIMIT 1").get()))throw new Error('Database calling objective rules are incomplete.');
      if(!verifyQuestStructure(db))throw new Error('Database quest chain validation failed.');
      if(!verifyQuestReceipts(db))throw new Error('Database quest progression validation failed.');
    }
    if (version >= 18) {
      const columns={guild_projects:['id','guild_id','title','summary','plan','visibility','status','creator_agent_id','created_at','management_reason'],guild_participants:['project_id','agent_id','role','state','joined_at','updated_at'],guild_contributions:['id','project_id','workstream_id','agent_id','account_id','commitment','evidence','sources','status','review_note','submitted_at','verified_by_agent_id','verified_by_account_id','verified_at','created_at','updated_at']};
      for(const [table,fields] of Object.entries(columns))if(!tables.has(table)||fields.some(column=>!db.prepare(`PRAGMA table_info(${table})`).all().some(field=>field.name===column)))throw new Error('Database guild project schema is incomplete.');
      if(['guild_projects_identity_immutable','guild_projects_keep_records'].some(name=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)))throw new Error('Database guild project protections are incomplete.');
      // A stored guild row must still satisfy every write-time rule, including that a verification
      // names an independent operator, so a tampered board cannot pass a backup or a restore.
      if(!verifyGuildRecords(db))throw new Error('Database guild project validation failed.');
    }
    if (version >= 19) {
      const columns={plot_grants:['id','plot_id','steward_account_id','guest_account_id','guest_agent_id','purpose','scope','expires_at','created_at','revoked_at','revoked_by','uses','last_used_at','status'],plot_grant_events:['id','grant_id','plot_id','account_id','action','detail','created_at']};
      for(const [table,fields] of Object.entries(columns))if(!tables.has(table)||fields.some(column=>!db.prepare(`PRAGMA table_info(${table})`).all().some(field=>field.name===column)))throw new Error('Database plot collaboration schema is incomplete.');
      if(!db.prepare('PRAGMA table_info(frontier_blocks)').all().some(column=>column.name==='grant_id'))throw new Error('Database plot collaboration schema is incomplete.');
      if(['plot_grants_validate_insert','plot_grants_lifecycle','plot_grants_no_delete','plot_grant_events_append_only','plot_grant_events_no_delete','land_stewardships_revoke_grants'].some(name=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name))||!db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='one_active_plot_grant'").get())throw new Error('Database plot collaboration protections are incomplete.');
      // The shipped plot guard must be the one that knows about grants. A database that kept a
      // stewardship-only guard would refuse every guest build, so it fails validation here rather
      // than in the world.
      const guard=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='frontier_blocks_plot_insert'").get()?.sql||'';
      if(!/plot_grants/.test(guard)||!/json_each/.test(guard))throw new Error('Database plot collaboration guard is incomplete.');
      // Every stored grant must still satisfy the rules that created it: a different guest operator,
      // a narrow scope, an ordered expiry inside fourteen days, and — while it is active — a real
      // steward for its plot. A revoked grant keeps its immutable identity and adds its revocation.
      for(const grant of db.prepare('SELECT * FROM plot_grants').all()){
        if(!isoTime(grant.created_at)||!isoTime(grant.expires_at)||grant.expires_at<=grant.created_at)throw new Error('Database plot collaboration grant is invalid.');
        if(grant.expires_at>new Date(Date.parse(grant.created_at)+GRANT_SCOPE_LIMITS.duration_minutes_max*60000).toISOString())throw new Error('Database plot collaboration grant is invalid.');
        if(grant.guest_account_id===grant.steward_account_id||!grantScopeNarrow(grantScopeValue(grant)))throw new Error('Database plot collaboration scope is invalid.');
        if(!['active','revoked'].includes(grant.status))throw new Error('Database plot collaboration grant state is invalid.');
        if(grant.status==='revoked'&&(!isoTime(grant.revoked_at)||grant.revoked_by===null||grant.revoked_by===undefined))throw new Error('Database plot collaboration grant state is invalid.');
        if(grant.status==='active'&&(grant.revoked_at!==null||grant.revoked_by!==null))throw new Error('Database plot collaboration grant state is invalid.');
        if(!Number.isInteger(grant.uses)||grant.uses<0||(grant.last_used_at!==''&&!isoTime(grant.last_used_at)))throw new Error('Database plot collaboration counter is invalid.');
        if(grant.guest_agent_id!==''&&!db.prepare('SELECT id FROM agents WHERE id=? AND operator_id=?').get(grant.guest_agent_id,grant.guest_account_id))throw new Error('Database plot collaboration guest is invalid.');
        if(grant.status==='active'&&!db.prepare('SELECT s.plot_id FROM land_stewardships s JOIN land_parcels p ON p.id=s.plot_id WHERE s.plot_id=? AND s.account_id=? AND p.reserved=0').get(grant.plot_id,grant.steward_account_id))throw new Error('Database plot collaboration steward is invalid.');
      }
      for(const event of db.prepare('SELECT * FROM plot_grant_events').all())if(!db.prepare('SELECT id FROM plot_grants WHERE id=? AND plot_id=?').get(event.grant_id,event.plot_id)||!isoTime(event.created_at)||typeof event.detail!=='string'||event.detail.length>200)throw new Error('Database plot collaboration history is invalid.');
      // A stored guest block must name a grant that belongs to the same plot, the same operator and
      // (when the grant named one) the same resident, so an authorship cannot be re-pointed.
      if(db.prepare("SELECT b.id FROM frontier_blocks b JOIN plot_grants g ON g.id=b.grant_id WHERE b.plot_id!=g.plot_id OR b.creator_account_id!=g.guest_account_id OR (g.guest_agent_id!='' AND g.guest_agent_id!=b.creator_agent_id)").get())throw new Error('Database plot collaboration construction is invalid.');
    }
    if (version >= 20) {
      const offerColumns = ['id','offerer_agent_id','offerer_account_id','recipient_agent_id','recipient_account_id','items','note','status','propose_key','accept_key','proposed_at','expires_at','settled_at','settled_by_account_id'];
      if (!tables.has('resource_offers') || offerColumns.some((column) => !db.prepare('PRAGMA table_info(resource_offers)').all().some((field) => field.name === column))) throw new Error('Database resource offer schema is incomplete.');
      if (!tables.has('resource_offer_events') || ['id','offer_id','account_id','action','detail','created_at'].some((column) => !db.prepare('PRAGMA table_info(resource_offer_events)').all().some((field) => field.name === column))) throw new Error('Database resource offer history is incomplete.');
      if (['resource_offers_validate_insert','resource_offers_lifecycle','resource_offer_events_no_update','resource_offer_events_no_delete'].some((name) => !db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name))) throw new Error('Database resource offer protections are incomplete.');
      // The no-negative-stock rule at the storage layer: a resident shelf is never negative. The
      // CHECK on journey_inventory already refuses a negative write; this re-checks what is stored.
      if (db.prepare('SELECT agent_id FROM journey_inventory WHERE quantity<0 LIMIT 1').get()) throw new Error('Database resident inventory is invalid.');
      // Every stored offer must still satisfy the rules that created it: two different residents of
      // two different operators, a positive item list, a life that expires after it was proposed, a
      // settlement consistent with its status, and exactly one settlement event. A replayed or a
      // duplicated settlement cannot pass this, so a backup or a restore carries a coherent offer.
      for (const offer of db.prepare('SELECT o.*,oa.operator_id AS offerer_operator,ra.operator_id AS recipient_operator FROM resource_offers o LEFT JOIN agents oa ON oa.id=o.offerer_agent_id LEFT JOIN agents ra ON ra.id=o.recipient_agent_id').all()) {
        if (offer.offerer_operator == null || offer.recipient_operator == null || offer.offerer_agent_id === offer.recipient_agent_id || offer.offerer_account_id === offer.recipient_account_id || offer.offerer_account_id !== offer.offerer_operator || offer.recipient_account_id !== offer.recipient_operator) throw new Error('Database resource offer parties are invalid.');
        if (!['proposed','accepted','declined','cancelled','expired'].includes(offer.status)) throw new Error('Database resource offer state is invalid.');
        if (!Number.isInteger(offer.proposed_at) || offer.proposed_at < 0 || !Number.isInteger(offer.expires_at) || offer.expires_at <= offer.proposed_at) throw new Error('Database resource offer timeline is invalid.');
        if ((offer.status === 'proposed') !== (offer.settled_at === null) || (offer.status === 'accepted') !== (offer.accept_key !== null) || (['accepted','declined','cancelled'].includes(offer.status)) !== (offer.settled_by_account_id !== null)) throw new Error('Database resource offer settlement is invalid.');
        if (typeof offer.note !== 'string' || offer.note.length > 200) throw new Error('Database resource offer note is invalid.');
        let items;
        try { items = JSON.parse(offer.items); } catch { throw new Error('Database resource offer items are invalid.'); }
        if (!items || typeof items !== 'object' || Array.isArray(items) || !Object.keys(items).length || Object.values(items).some((quantity) => !Number.isInteger(quantity) || quantity <= 0)) throw new Error('Database resource offer items are invalid.');
        const events = db.prepare('SELECT action FROM resource_offer_events WHERE offer_id=?').all(offer.id);
        const proposed = events.filter((event) => event.action === 'proposed').length, settled = events.length - proposed;
        if (proposed !== 1 || (offer.status === 'proposed' ? settled !== 0 : settled !== 1)) throw new Error('Database resource offer history is invalid.');
        if (offer.status !== 'proposed' && !events.some((event) => event.action === offer.status)) throw new Error('Database resource offer history is invalid.');
      }
      if (db.prepare("SELECT e.id FROM resource_offer_events e LEFT JOIN resource_offers o ON o.id=e.offer_id WHERE o.id IS NULL OR e.action NOT IN ('proposed','accepted','declined','cancelled','expired') OR e.created_at<0 OR length(e.detail)>200").get()) throw new Error('Database resource offer history is invalid.');
    }
    if (version >= 21) {
      const memoryColumns = ['id','agent_id','account_id','kind','attribute','subject','value','source_kind','source_id','source_at','source_label','origin','state','decided_by','decided_at','supersedes','superseded_by','proof_hash','created_at','updated_at'];
      if (!tables.has('resident_memory') || memoryColumns.some((column) => !db.prepare('PRAGMA table_info(resident_memory)').all().some((field) => field.name === column))) throw new Error('Database resident memory schema is incomplete.');
      if (['resident_memory_identity_immutable','resident_memory_validate_insert'].some((name) => !db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name))) throw new Error('Database resident memory protections are incomplete.');
      // Every stored fact must still name a source that exists, keep its immutable provenance, sit
      // inside every stated bound and carry the proof of its own provenance. A tampered or truncated
      // memory row therefore cannot pass a backup, a restore or a startup.
      if (!verifyMemoryRecords(db)) throw new Error('Database resident memory validation failed.');
    }
    if (version >= 22) {
      const columns={evidence_sources:['id','source_key','url','host','path','status','withdrawn_reason','created_at'],evidence_captures:['id','source_id','source_key','url','sha256','bytes','retained','retained_path','retrieved_at','declared_date','unit','title','locator','evidence_kind','provenance','license_name','license_url','license_attribution','excerpt','origin','supersedes','created_at'],evidence_events:['id','source_id','kind','detail','created_at'],submission_evidence:['submission_id','source_number','capture_id','url','locator','cited_date','state','created_at']};
      for(const [table,fields] of Object.entries(columns))if(!tables.has(table)||fields.some((column)=>!db.prepare(`PRAGMA table_info(${table})`).all().some((field)=>field.name===column)))throw new Error('Database evidence library schema is incomplete.');
      if(['evidence_sources_identity_immutable','evidence_captures_no_update','evidence_captures_validate_insert','evidence_events_no_update','evidence_events_no_delete','submission_evidence_no_update'].some((name)=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)))throw new Error('Database evidence library protections are incomplete.');
      // Every stored capture, source and citation must still satisfy the rules that created it. A
      // rewritten version, a re-pointed identity, a citation that no longer names its own capture or
      // a capture past its quota therefore cannot pass a backup, a restore or a startup.
      if (!verifyEvidenceRecords(db)) throw new Error('Database evidence library validation failed.');
    }
    // The trade board was introduced additively under schema 22. Older schema-22 worlds legitimately
    // have no trade objects, but any board object or trade audit entry requires the complete, exact
    // board schema and a balanced ledger before a backup or restore is accepted.
    if (version >= 23 || tradeSchemaPresent(db) || db.prepare("SELECT 1 FROM audit WHERE event LIKE 'trade.%' LIMIT 1").get()) {
      if (!verifyTradeSchema(db)) throw new Error('Database trade board schema is incomplete.');
      const trade = { all: (sql, ...args) => db.prepare(sql).all(...args) };
      if (!verifyTradeRecords(trade)) throw new Error('Database trade board validation failed.');
    }
    // Legacy backups with a valid narrower content list remain restorable, then migrate on open.
    // Current-version backups must have this release's exact list; a missing or broadened legacy
    // CHECK is refused too, so migration cannot launder unsealed content into a valid backup.
    if (version >= 24 && !(version >= WORLD_CONTENT_SCHEMA_VERSION ? worldContentChecksCurrent(db) : worldContentChecksUpgradeable(db))) throw new Error('Database world content constraints are incomplete.');
    if (version >= 25) {
      if (!vaultSchemaPresent(db)) throw new Error('Database resident vault schema is incomplete.');
      if (['resident_vault_identity_immutable','resident_vault_keys_identity_immutable','resident_vault_validate_insert','resident_vault_keys_validate_insert'].some((name) => !db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name))) throw new Error('Database resident vault guards are incomplete.');
      // Structure only: a backup never needs, and recovery never holds, the key that opens a note.
      if (!verifyVaultRecords(db)) throw new Error('Database resident vault validation failed.');
    }
    if (version >= 26) {
      // Karma Coins are a second currency and the shop is their only sink. Every stored receipt names
      // a saved source row the server itself wrote, one receipt per source, inside its per-service and
      // per-operator daily bounds, and every purchase leaves a non-negative balance. `verifyKarmaLedger`
      // re-checks both chains and every receipt against the row it cites, so a backup carrying a
      // forged credit fails closed here rather than being discovered in a wallet.
      const columns={karma_receipts:['seq','id','agent_id','account_id','service_id','tier','source_kind','source_id','source_at','amount','per_day','requires_other_operator','award_day','policy_version','created_at','previous_hash','hash'],karma_purchases:['seq','id','account_id','agent_id','good_id','amount','balance_after','policy_version','idempotency_key','fingerprint','created_at','previous_hash','hash'],shop_purchases:['id','account_id','agent_id','good_id','category','price','granted','world_id','karma_receipt_id','balance_after','key','day','created_at']};
      for(const [table,fields] of Object.entries(columns))if(!tables.has(table)||fields.some((column)=>!db.prepare(`PRAGMA table_info(${table})`).all().some((field)=>field.name===column)))throw new Error('Database karma ledger schema is incomplete.');
      if(!db.prepare("SELECT name FROM sqlite_schema WHERE type='view' AND name='karma_service_rules'").get()||!db.prepare("SELECT name FROM sqlite_schema WHERE type='view' AND name='karma_source_events'").get())throw new Error('Database karma service rules are missing.');
      if(['karma_receipts_no_update','karma_receipts_no_delete','karma_receipts_validate_insert','karma_purchases_no_update','karma_purchases_no_delete','karma_purchases_validate_insert','shop_purchases_no_update'].some((name)=>!db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)))throw new Error('Database karma ledger protections are incomplete.');
      if(!verifyKarmaLedger(db)) throw new Error('Database karma ledger validation failed.');
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database contains invalid references.');
    let previous = '';
    for (const entry of db.prepare('SELECT * FROM audit ORDER BY seq').all()) {
      if (entry.previous_hash !== previous || entry.hash !== digest(JSON.stringify([entry.actor, entry.event, entry.record_id, entry.created_at, previous]))) throw new Error('Database audit chain validation failed.');
      previous = entry.hash;
    }
    return { schema_version: version, accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n };
  } finally { db.close(); }
}
export function backupDatabase(db, destination) {
  const path = resolve(destination);
  privateDirectory(dirname(path));
  // Reserve a unique owner-only file before SQLite writes to it.
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  try {
    db.prepare('VACUUM INTO ?').run(path);
    chmodSync(path, 0o600);
    validateDatabase(path);
    return { path };
  } catch (error) { unlinkSync(path); throw error; }
}

function processIdentity(pid) {
  try {
    if (process.platform === 'darwin') {
      const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim();
      const boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 1000 }).trim();
      return start && boot ? { boot, start } : null;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), start: fields[19] };
  } catch { return null; }
}

export function acquireProcessLock(lockPath, { identityOf = processIdentity } = {}) {
  const path = resolve(lockPath);
  privateDirectory(dirname(path));
  const marker = { pid: process.pid, nonce: randomUUID(), identity: identityOf(process.pid) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (readFileSync(path, 'utf8') === JSON.stringify(marker)) unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stored;
      try { stored = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Unrecognized process lock; inspect it before recovery.'); }
      if (!Number.isSafeInteger(stored.pid) || stored.pid <= 0 || !stored.nonce) throw new Error('Unrecognized process lock; inspect it before recovery.');
      const currentIdentity = identityOf(stored.pid);
      const reusedPid = stored.identity && currentIdentity && (stored.identity.boot !== currentIdentity.boot || stored.identity.start !== currentIdentity.start);
      if (!reusedPid) {
        try { process.kill(stored.pid, 0); throw new Error('The world server or another recovery operation is running. Stop it before recovery.'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      // The content must still match before reclaiming a stale lock.
      if (readFileSync(path, 'utf8') === JSON.stringify(stored)) unlinkSync(path);
    }
  }
  throw new Error('Unable to acquire the world process lock.');
}
export function restoreDatabase(source, destination, { lockPath = resolve(dirname(destination), 'server.lock') } = {}) {
  const input = resolve(source), target = resolve(destination);
  if (input === target) throw new Error('Restore source and destination must be different files.');
  const validation = validateDatabase(input);
  privateDirectory(dirname(target));
  const release = acquireProcessLock(lockPath);
  const temporary = resolve(dirname(target), `.${basename(target)}.restore-${randomUUID()}`);
  let preserved;
  try {
    if (existsSync(target)) {
      regularFile(target);
      // Keep byte copies first: even a damaged original and its WAL must be recoverable.
      const preservationDir = `${target}.before-restore-${Date.now()}-${randomUUID()}`;
      privateDirectory(preservationDir);
      preserved = resolve(preservationDir, 'original.sqlite');
      for (const suffix of ['', '-wal', '-shm']) {
        if (!existsSync(`${target}${suffix}`)) continue;
        regularFile(`${target}${suffix}`);
        copyFileSync(`${target}${suffix}`, `${preserved}${suffix}`, constants.COPYFILE_EXCL);
        chmodSync(`${preserved}${suffix}`, 0o600);
      }
      // A healthy database can be checkpointed safely; a damaged original remains
      // available as the byte copies above while the verified backup replaces it.
      let original;
      try {
        original = new DatabaseSync(target);
        const checkpoint = original.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy) throw new Error('The database is busy; stop all clients before restoring.');
      } catch (error) {
        if (error.message.includes('busy') || error.code === 'SQLITE_BUSY') throw error;
        // Corruption is the reason for restoring; it must not prevent recovery.
        if (!/database|malformed|file is not|SQLITE/i.test(error.message)) throw error;
      } finally { original?.close(); }
    }
    copyFileSync(input, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    validateDatabase(temporary);
    // Checkpoint above empties old WAL; remove its sidecars before the atomic replacement.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${target}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    return { path: target, preserved_original: preserved || null, ...validation };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    release();
  }
}

// ---- Bounded operational diagnostics -----------------------------------------------------------
// The recovery point and the interruption limits an operator must know. These are the same values
// the runbook (docs/OPERATIONS.md) states and the failure drills (scripts/ops-rehearsal.mjs) prove.
export const RECOVERY_LIMITS = Object.freeze({
  schema_version: WORLD_CONTENT_SCHEMA_VERSION,
  accepted_schema_versions: Object.freeze(Array.from({ length: WORLD_CONTENT_SCHEMA_VERSION }, (_, index) => index + 1)),
  // A private resident memory record lives entirely in the database, so a process restart keeps it.
  // It holds no credential and it is read within the runtime's existing observation byte budget.
  resident_memory: Object.freeze({ bounded_facts_per_resident: 24, bounded_value_characters: 160, prompt_facts: 10, prompt_bytes: 4096, approval: 'operator-approval', source: 'a verified calling receipt, a finished run that recorded a refusal, an independent review decision, or the operator’s own explicit input' }),
  // A backup is one consistent VACUUM INTO copy taken inside a single read transaction.
  backup_point: 'The last committed transaction before the copy began; no half-applied transaction is ever inside a backup.',
  backup_loss: 'Everything committed after the copy began. A restore therefore rolls the world back to the backup moment.',
  // Interruption classes written by recoverWorkerJobs(). Nothing is ever replayed automatically.
  replay_policy: 'A recorded action is never replayed. Continuing interrupted work is an explicit operator resume with a fresh credential and the remaining budgets.',
  interruption_classes: Object.freeze(['no_action_yet', 'model_call_in_flight', 'action_dispatched_unconfirmed', 'action_confirmed', 'unknown']),
  // Work that a process death can lose, and work it cannot.
  at_risk: 'One model decision in flight (never an action it had not dispatched), the in-memory worker maps, and any write committed after the newest backup.',
  not_at_risk: 'Every committed world, land, coin, quest, guild, audit and resident-run record, because those live in the database and not in the process.',
});
const BACKUP_NAME = /^world-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/;

// The storage a world actually occupies: the database plus the write-ahead log and its shared
// memory index. Sizes are read with stat() and never by loading file contents.
export function storageUsage(databasePath) {
  const path = resolve(databasePath);
  const bytes = (suffix) => {
    const candidate = `${path}${suffix}`;
    try { return existsSync(candidate) && lstatSync(candidate).isFile() ? statSync(candidate).size : 0; } catch { return 0; }
  };
  const database_bytes = bytes(''), wal_bytes = bytes('-wal'), shm_bytes = bytes('-shm');
  return { database_bytes, wal_bytes, shm_bytes, total_bytes: database_bytes + wal_bytes + shm_bytes };
}

// A cheap integrity read used by the administrator dashboard. It opens the database read-only and
// runs PRAGMA quick_check, which reports corruption without repairing anything and never writes.
export function integritySnapshot(databasePath) {
  const path = resolve(databasePath);
  regularFile(path);
  const started = Date.now();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const quick_check = db.prepare('PRAGMA quick_check').get().quick_check;
    return {
      quick_check,
      checked_at: new Date().toISOString(),
      check_duration_ms: Date.now() - started,
      schema_version: db.prepare('PRAGMA user_version').get().user_version,
      page_count: db.prepare('PRAGMA page_count').get().page_count,
      journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    };
  } finally { db.close(); }
}

// Which verified backups exist, newest first. Only names this application creates are counted, so a
// stray private file in the directory is never listed or reported to a dashboard.
export function backupInventory(directory, { limit = 5 } = {}) {
  const path = resolve(directory);
  const empty = { directory: path, count: 0, latest: null, recent: [] };
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return empty; }
  const files = entries
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => {
      const stats = statSync(resolve(path, entry.name));
      return { filename: entry.name, bytes: stats.size, created_at: new Date(stats.mtimeMs).toISOString() };
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  return { directory: path, count: files.length, latest: files[0] || null, recent: files.slice(0, limit) };
}

// The diagnostics payload is built from named counters and never from stored rows. This pass is the
// second line of defence: a field name that names a secret is dropped, a field whose final word names
// narrative content while it carries text or a structure is dropped, and a value that looks like a
// token, a stored password digest, an email address or a private artifact reference is replaced.
// It is the reason the drill can plant a secret and grep the produced output for it.
const SECRET_FIELD = /(?:password|pass_hash|secret|token|credential|hash|salt|email|contact|authorization|cookie|private)/i;
// What docs/OPERATIONS.md §10 forbids in a diagnostics response: a private message or journal text,
// a private artifact, or a raw prompt or conversation. These rules read the field's final word, so a
// counter that merely mentions one of them (`records.ambassador_conversations`) still publishes its
// number; only text or a structure under such a name is dropped.
const CONTENT_FIELD = /(?:^|_)(?:messages?|texts?|journals?|artifacts?|prompts?|conversations?|excerpts?|transcripts?|body|bodies|contents?|questions?|answers?|passages?|details?|summary|summaries|receipts?)$/i;
const textOrStructure = (item) => typeof item === 'string' || (item !== null && typeof item === 'object');
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PASSWORD_DIGEST = /\b[0-9a-f]{16,}:[0-9a-f]{64,}\b/gi;
const LONG_HEX = /\b[0-9a-f]{40,}\b/gi;
const redactText = (value) => value.replace(PASSWORD_DIGEST, '[redacted-password-digest]').replace(LONG_HEX, '[redacted-token-or-hash]').replace(EMAIL, '[redacted-email]');
export function redactDiagnostics(value, depth = 0) {
  if (depth > 6) return '[redacted-depth]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactDiagnostics(item, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = SECRET_FIELD.test(key) || (CONTENT_FIELD.test(key) && textOrStructure(item)) ? '[redacted-field]' : redactDiagnostics(item, depth + 1);
    return output;
  }
  return typeof value === 'string' ? redactText(value) : value;
}
