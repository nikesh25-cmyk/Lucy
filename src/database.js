import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (db.prepare('PRAGMA user_version').get().user_version > 2) { db.close(); throw new Error('Unsupported database schema version.'); }
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', consent_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(code_hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT);
    CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, color TEXT NOT NULL, symbol TEXT NOT NULL, capabilities TEXT NOT NULL, limitations TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified INTEGER NOT NULL DEFAULT 0, x INTEGER NOT NULL, y INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, last_move INTEGER NOT NULL DEFAULT 0, last_message INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), agent_id TEXT REFERENCES agents(id), kind TEXT NOT NULL, expires_at INTEGER NOT NULL, max_calls INTEGER NOT NULL, used_calls INTEGER NOT NULL DEFAULT 0, scopes TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS missions(id TEXT PRIMARY KEY, title TEXT NOT NULL, area TEXT NOT NULL, summary TEXT NOT NULL, owner_id TEXT REFERENCES accounts(id), beneficiary TEXT NOT NULL, reviewer_id TEXT REFERENCES accounts(id), rubric TEXT NOT NULL, status TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), title TEXT NOT NULL, instructions TEXT NOT NULL, rights TEXT NOT NULL, allowed_domains TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), task_version INTEGER NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), agent_id TEXT REFERENCES agents(id), status TEXT NOT NULL, expires_at INTEGER NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(account_id,idempotency_key));
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_claim ON claims(task_id) WHERE status IN ('leased','submitted','changes_requested');
    CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES claims(id), version INTEGER NOT NULL, artifact TEXT NOT NULL, sources TEXT NOT NULL, method TEXT NOT NULL, limitations TEXT NOT NULL, rights TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(claim_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), reviewer_id TEXT NOT NULL REFERENCES accounts(id), decision TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS adoptions(id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), owner_id TEXT NOT NULL REFERENCES accounts(id), note TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), account_id TEXT NOT NULL REFERENCES accounts(id), channel TEXT NOT NULL, mission_id TEXT REFERENCES missions(id), recipients TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES accounts(id), target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, moderator_id TEXT REFERENCES accounts(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS appeals(id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id), account_id TEXT NOT NULL REFERENCES accounts(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decision TEXT, reviewer_id TEXT REFERENCES accounts(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), status TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,event TEXT NOT NULL,record_id TEXT NOT NULL,created_at TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES('paused','false');
    `);
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS worlds(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, owner_agent_id TEXT REFERENCES agents(id), visibility TEXT NOT NULL DEFAULT 'public', width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS world_objects(id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), type TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(world_id,x,y));`);
  try {
    if (!db.prepare('PRAGMA table_info(agents)').all().some((c) => c.name === 'world_id')) db.exec("ALTER TABLE agents ADD COLUMN world_id TEXT NOT NULL DEFAULT 'commons'");
    if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'world_id')) db.exec("ALTER TABLE messages ADD COLUMN world_id TEXT NOT NULL DEFAULT 'commons'");
    if (!db.prepare('PRAGMA table_info(agents)').all().some((c) => c.name === 'posture')) db.exec("ALTER TABLE agents ADD COLUMN posture TEXT NOT NULL DEFAULT 'standing'");
    db.exec(`CREATE INDEX IF NOT EXISTS agents_spatial ON agents(world_id,x,y);
      CREATE INDEX IF NOT EXISTS agents_operator ON agents(operator_id);
      CREATE INDEX IF NOT EXISTS tokens_agent ON tokens(agent_id,kind,revoked,expires_at);
      CREATE INDEX IF NOT EXISTS messages_world ON messages(world_id,created_at);
      CREATE INDEX IF NOT EXISTS worlds_owner ON worlds(owner_agent_id);
      CREATE INDEX IF NOT EXISTS worlds_public ON worlds(kind,visibility,name);
      CREATE INDEX IF NOT EXISTS objects_world ON world_objects(world_id);
      CREATE INDEX IF NOT EXISTS claims_agent ON claims(agent_id);
      CREATE INDEX IF NOT EXISTS submissions_claim ON submissions(claim_id,status);
      PRAGMA user_version=2; COMMIT;`);
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  if (path !== ':memory:') chmodSync(path, 0o600);
  return db;
}
