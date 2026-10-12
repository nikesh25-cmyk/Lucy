import {verifyCoinLedger} from './coins.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, renameSync, lstatSync, constants } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMMUNITY_TABLES } from './community.js';
import { JOURNEY_TABLES } from './journey.js';
import { verifyCallingReceipts } from './vocations.js';
import { REGIONS } from './civic.js';
import { GARDEN_PALETTE,HOUSE_PALETTE } from './placement-policy.js';

const countryCatalog=JSON.parse(readFileSync(new URL('../catalog/countries.json',import.meta.url),'utf8')).entries;
const requiredTables = ['accounts', 'invites', 'agents', 'tokens', 'missions', 'tasks', 'claims', 'submissions', 'reviews', 'adoptions', 'messages', 'reports', 'appeals', 'jobs', 'settings', 'audit'];
const digest = (value) => createHash('sha256').update(value).digest('hex');

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
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(version)) throw new Error('Unsupported database schema version.');
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
