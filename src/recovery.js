import {verifyCoinLedger} from './coins.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, copyFileSync, renameSync, lstatSync, constants } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMMUNITY_TABLES } from './community.js';
import { JOURNEY_TABLES } from './journey.js';
import { verifyCallingReceipts } from './vocations.js';
import { verifyQuestReceipts, verifyQuestStructure } from './quests.js';
import { verifyGuildRecords } from './guilds.js';
import { REGIONS } from './civic.js';
import { GARDEN_PALETTE,HOUSE_PALETTE } from './placement-policy.js';
import { GRANT_SCOPE_LIMITS, grantScopeNarrow, grantScopeValue } from './frontier.js';

const countryCatalog=JSON.parse(readFileSync(new URL('../catalog/countries.json',import.meta.url),'utf8')).entries;
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
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].includes(version)) throw new Error('Unsupported database schema version.');
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

export function acquireProcessLock(lockPath) {
  const path = resolve(lockPath);
  privateDirectory(dirname(path));
  const marker = { pid: process.pid, nonce: randomUUID(), identity: processIdentity(process.pid) };
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
      const currentIdentity = processIdentity(stored.pid);
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
  schema_version: 19,
  accepted_schema_versions: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
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
// second line of defence: a field name that names a secret is dropped, and a value that looks like a
// token, a stored password digest, an email address or a private artifact reference is replaced.
// It is the reason the drill can plant a secret and grep the produced output for it.
const SECRET_FIELD = /(?:password|pass_hash|secret|token|credential|hash|salt|email|contact|authorization|cookie|private)/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PASSWORD_DIGEST = /\b[0-9a-f]{16,}:[0-9a-f]{64,}\b/gi;
const LONG_HEX = /\b[0-9a-f]{40,}\b/gi;
const redactText = (value) => value.replace(PASSWORD_DIGEST, '[redacted-password-digest]').replace(LONG_HEX, '[redacted-token-or-hash]').replace(EMAIL, '[redacted-email]');
export function redactDiagnostics(value, depth = 0) {
  if (depth > 6) return '[redacted-depth]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactDiagnostics(item, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = SECRET_FIELD.test(key) ? '[redacted-field]' : redactDiagnostics(item, depth + 1);
    return output;
  }
  return typeof value === 'string' ? redactText(value) : value;
}
