import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, renameSync, lstatSync, constants } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMMUNITY_TABLES } from './community.js';
import { JOURNEY_TABLES } from './journey.js';

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
    if (![1, 2, 3, 4, 5].includes(version)) throw new Error('Unsupported database schema version.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((item) => item.name));
    const expectedTables = version >= 3 ? [...requiredTables, 'worlds', 'world_objects', ...COMMUNITY_TABLES, ...JOURNEY_TABLES] : version === 2 ? [...requiredTables, 'worlds', 'world_objects'] : requiredTables;
    if (expectedTables.some((table) => !tables.has(table))) throw new Error('This is not a complete Shared World database.');
    if (version >= 2 && ['agents', 'messages'].some((table) => !db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'world_id'))) throw new Error('Database world schema is incomplete.');
    if (version >= 3 && ['emote', 'emote_until', 'last_emote'].some((column) => !db.prepare('PRAGMA table_info(agents)').all().some((field) => field.name === column))) throw new Error('Database resident schema is incomplete.');
    if (version >= 4 && ['region_id', 'country'].some((column) => !db.prepare('PRAGMA table_info(agents)').all().some((field) => field.name === column))) throw new Error('Database civic schema is incomplete.');
    if (version >= 5 && ['npc_mayors','mayor_conversations','research_leads'].some((table) => !tables.has(table))) throw new Error('Database research schema is incomplete.');
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
