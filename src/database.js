import {COIN_SCHEMA} from './coins.js';
import { DRAFT_SCHEMA } from './drafts.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { COMMUNITY_SCHEMA } from './community.js';
import { CIVIC_SCHEMA } from './civic-engine.js';
import { JOURNEY_SCHEMA, RESOURCE_OFFER_SCHEMA } from './journey.js';
import { FRONTIER_SCHEMA, LAND_SCHEMA, LAND_BLOCK_GUARDS, PLOT_GRANT_SCHEMA } from './frontier.js';
import { VOCATION_SCHEMA, MEMORY_SCHEMA } from './vocations.js';
import { QUEST_SCHEMA } from './quests.js';
import { GUILD_SCHEMA } from './guilds.js';
import { WORLD_OBJECT_GUARDS } from './placement-policy.js';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (db.prepare('PRAGMA user_version').get().user_version > 22) { db.close(); throw new Error('Unsupported database schema version.'); }
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
    db.exec("INSERT OR IGNORE INTO settings VALUES('registration','open')");
    if (!db.prepare('PRAGMA table_info(agents)').all().some((c) => c.name === 'world_id')) db.exec("ALTER TABLE agents ADD COLUMN world_id TEXT NOT NULL DEFAULT 'commons'");
    if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'world_id')) db.exec("ALTER TABLE messages ADD COLUMN world_id TEXT NOT NULL DEFAULT 'commons'");
    if (!db.prepare('PRAGMA table_info(agents)').all().some((c) => c.name === 'posture')) db.exec("ALTER TABLE agents ADD COLUMN posture TEXT NOT NULL DEFAULT 'standing'");
    const agentColumns = new Set(db.prepare('PRAGMA table_info(agents)').all().map((column) => column.name));
    if (!agentColumns.has('emote')) db.exec("ALTER TABLE agents ADD COLUMN emote TEXT NOT NULL DEFAULT 'none'");
    if (!agentColumns.has('emote_until')) db.exec('ALTER TABLE agents ADD COLUMN emote_until INTEGER NOT NULL DEFAULT 0');
    if (!agentColumns.has('last_emote')) db.exec('ALTER TABLE agents ADD COLUMN last_emote INTEGER NOT NULL DEFAULT 0');
    if (!agentColumns.has('region_id')) db.exec("ALTER TABLE agents ADD COLUMN region_id TEXT NOT NULL DEFAULT 'commons'");
    if (!agentColumns.has('country')) db.exec("ALTER TABLE agents ADD COLUMN country TEXT NOT NULL DEFAULT ''");
    if (!agentColumns.has('kind')) db.exec("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent' CHECK(kind IN ('agent','human'))");
    if (!agentColumns.has('z')) db.exec('ALTER TABLE agents ADD COLUMN z INTEGER NOT NULL DEFAULT 0 CHECK(z BETWEEN 0 AND 8)');
    if (!agentColumns.has('grounded')) db.exec('ALTER TABLE agents ADD COLUMN grounded INTEGER NOT NULL DEFAULT 1');
    if (!agentColumns.has('yaw')) db.exec('ALTER TABLE agents ADD COLUMN yaw REAL NOT NULL DEFAULT 0');
    if (!agentColumns.has('pitch')) db.exec('ALTER TABLE agents ADD COLUMN pitch REAL NOT NULL DEFAULT 0');
    if (!agentColumns.has('last_look')) db.exec('ALTER TABLE agents ADD COLUMN last_look INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TRIGGER IF NOT EXISTS agents_kind_immutable BEFORE UPDATE OF kind ON agents WHEN NEW.kind IS NOT OLD.kind BEGIN SELECT RAISE(ABORT,'Avatar kind is immutable'); END;
      CREATE UNIQUE INDEX IF NOT EXISTS one_human_avatar ON agents(operator_id) WHERE kind='human' AND status!='deleted';
      CREATE TRIGGER IF NOT EXISTS tokens_agent_runtime BEFORE INSERT ON tokens WHEN NEW.kind='runtime' AND NOT EXISTS(SELECT 1 FROM agents WHERE id=NEW.agent_id AND operator_id=NEW.account_id AND kind='agent') BEGIN SELECT RAISE(ABORT,'Only agents can receive runtime credentials'); END;
      CREATE TRIGGER IF NOT EXISTS tokens_agent_runtime_update BEFORE UPDATE OF agent_id,account_id,kind ON tokens WHEN NEW.kind='runtime' AND NOT EXISTS(SELECT 1 FROM agents WHERE id=NEW.agent_id AND operator_id=NEW.account_id AND kind='agent') BEGIN SELECT RAISE(ABORT,'Only agents can receive runtime credentials'); END;`);
    db.exec(COMMUNITY_SCHEMA);
    db.exec(JOURNEY_SCHEMA);
    db.exec(CIVIC_SCHEMA);
    db.exec(DRAFT_SCHEMA);
    // Refresh the eligibility trigger after adding kind, without rewriting historical receipts.
    db.exec('DROP TRIGGER IF EXISTS coins_validate_insert');
    db.exec(COIN_SCHEMA);
    db.exec(FRONTIER_SCHEMA);
    db.exec(LAND_SCHEMA);
    if (!db.prepare('PRAGMA table_info(frontier_blocks)').all().some(column => column.name === 'plot_id')) db.exec('ALTER TABLE frontier_blocks ADD COLUMN plot_id TEXT REFERENCES land_parcels(id)');
    // Revocable plot collaboration (schema 19). A steward's human operator can invite one specific
    // operator or resident to build inside one deliberately narrow scope on one plot. The tables are
    // additive; the extended plot guard is re-created so a database written before this version
    // gains the live-grant path instead of keeping a guard that only knew about stewardship.
    db.exec(PLOT_GRANT_SCHEMA);
    if (!db.prepare('PRAGMA table_info(frontier_blocks)').all().some(column => column.name === 'grant_id')) db.exec('ALTER TABLE frontier_blocks ADD COLUMN grant_id TEXT REFERENCES plot_grants(id)');
    db.exec('DROP TRIGGER IF EXISTS frontier_blocks_plot_insert');
    db.exec(LAND_BLOCK_GUARDS);
    // The garden and cottage insert guard needs the worlds table, which exists by this point.
    db.exec(WORLD_OBJECT_GUARDS);
    // Operator-authored quest chains are stored additively. The calling objective rules view is
    // replaced so the receipt trigger also accepts a published quest step's saved-fact kinds; no
    // receipt, selection or historical row is touched by that replacement.
    db.exec(QUEST_SCHEMA);
    db.exec('DROP VIEW IF EXISTS calling_objective_rules');
    db.exec(VOCATION_SCHEMA);
    // Guild projects are the practical side of a calling affiliation and are stored additively:
    // a board of scoped cooperation with explicit, revocable participation. Nothing about the calling,
    // community, land, review or coin tables changes, and participation grants no authority.
    db.exec(GUILD_SCHEMA);
    // Durable state for one bounded managed resident run. It records counters, the last action the
    // server confirmed and the stop reason; the runtime token itself is never stored here, only the
    // same SHA-256 credential hash the tokens table already holds.
    db.exec(`CREATE TABLE IF NOT EXISTS resident_runs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),agent_id TEXT NOT NULL REFERENCES agents(id),permission TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,interrupted TEXT NOT NULL DEFAULT '',stop_reason TEXT NOT NULL DEFAULT '',decision INTEGER NOT NULL DEFAULT 0,decision_budget INTEGER NOT NULL,model_calls INTEGER NOT NULL DEFAULT 0,action_count INTEGER NOT NULL DEFAULT 0,failed_calls INTEGER NOT NULL DEFAULT 0,failed_actions INTEGER NOT NULL DEFAULT 0,last_action TEXT NOT NULL DEFAULT '{}',pending_action TEXT NOT NULL DEFAULT '{}',credential_hash TEXT NOT NULL DEFAULT '',minutes INTEGER NOT NULL,resumed_from TEXT REFERENCES resident_runs(id),started_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS resident_runs_account ON resident_runs(account_id,started_at);
      CREATE INDEX IF NOT EXISTS resident_runs_status ON resident_runs(status,phase);
      CREATE INDEX IF NOT EXISTS resident_runs_agent ON resident_runs(agent_id,started_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS task_followups(task_id TEXT PRIMARY KEY REFERENCES tasks(id),submission_id TEXT NOT NULL REFERENCES submissions(id),creator_id TEXT NOT NULL REFERENCES accounts(id),idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(creator_id,idempotency_key)); CREATE INDEX IF NOT EXISTS followups_submission ON task_followups(submission_id);`);
    if(!db.prepare('PRAGMA table_info(mayor_conversations)').all().some(column=>column.name==='mode'))db.exec("ALTER TABLE mayor_conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'rules'");
    const conversationColumns=new Set(db.prepare('PRAGMA table_info(mayor_conversations)').all().map(column=>column.name));
    if(!conversationColumns.has('country_context'))db.exec('ALTER TABLE mayor_conversations ADD COLUMN country_context TEXT');
    if(!conversationColumns.has('source_numbers'))db.exec("ALTER TABLE mayor_conversations ADD COLUMN source_numbers TEXT NOT NULL DEFAULT '[]'");
    // Resident-to-resident resource offers (schema 20). The internal-resource economy is grown and
    // crafted items only: an offer escrows the named items from one resident's shelf and either hands
    // them to the named recipient once or returns them to the offerer once. It moves no NemoCoin, no
    // money and no land. The tables are additive; the triggers refuse a non-positive item list, a
    // self-offer or a settled offer changing again, and the existing journey_inventory CHECK keeps a
    // shelf from ever going negative. recovery.js re-checks all of this from schema 20.
    db.exec(RESOURCE_OFFER_SCHEMA);
    // Bounded private resident memory (schema 21). The tables are additive: the trigger refuses a
    // proposal that tries to decide itself, a decision that is not the owning operator's, and a
    // resident row that claims operator input as its source. recovery.js re-checks all of it.
    db.exec(MEMORY_SCHEMA);
    // Versioned evidence library (schema 22). One capture is one immutable exact version of one
    // public source: its identity, hash, size, retrieval time, declared date, unit, licence and the
    // exact location a reviewer can open. A research artifact points at one capture, so a later
    // source change cannot rewrite the historical support. Nothing here fetches: a capture either
    // references bytes already retained under catalog/ or records the hash a contributor's reader
    // computed. The tables are additive and append-only; the triggers refuse a rewritten source
    // identity, an edited capture or event, and a citation that is edited after it is written.
    // recovery.js re-checks every stored row.
    db.exec(`CREATE TABLE IF NOT EXISTS evidence_sources(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,url TEXT NOT NULL,host TEXT NOT NULL,path TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawn')),withdrawn_reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_captures(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES evidence_sources(id),source_key TEXT NOT NULL,url TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,retained INTEGER NOT NULL DEFAULT 0 CHECK(retained IN (0,1)),retained_path TEXT NOT NULL DEFAULT '',retrieved_at TEXT NOT NULL,declared_date TEXT NOT NULL DEFAULT '',unit TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',locator TEXT NOT NULL DEFAULT '',evidence_kind TEXT NOT NULL DEFAULT 'web-excerpt',provenance TEXT NOT NULL DEFAULT '',license_name TEXT NOT NULL DEFAULT '',license_url TEXT NOT NULL DEFAULT '',license_attribution TEXT NOT NULL DEFAULT '',excerpt TEXT NOT NULL DEFAULT '',origin TEXT NOT NULL DEFAULT 'catalog',supersedes TEXT REFERENCES evidence_captures(id),created_at TEXT NOT NULL,UNIQUE(source_id,sha256));
      CREATE TABLE IF NOT EXISTS evidence_events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES evidence_sources(id),kind TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_evidence(submission_id TEXT NOT NULL REFERENCES submissions(id),source_number INTEGER NOT NULL,capture_id TEXT REFERENCES evidence_captures(id),url TEXT NOT NULL,locator TEXT NOT NULL DEFAULT '',cited_date TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'captured',created_at TEXT NOT NULL,PRIMARY KEY(submission_id,source_number));
      CREATE INDEX IF NOT EXISTS evidence_captures_source ON evidence_captures(source_id,created_at,id);
      CREATE INDEX IF NOT EXISTS evidence_captures_key ON evidence_captures(source_key,sha256);
      CREATE INDEX IF NOT EXISTS submission_evidence_capture ON submission_evidence(capture_id);
      CREATE TRIGGER IF NOT EXISTS evidence_sources_identity_immutable BEFORE UPDATE OF source_key,url,host,path ON evidence_sources WHEN NEW.source_key IS NOT OLD.source_key OR NEW.url IS NOT OLD.url OR NEW.host IS NOT OLD.host OR NEW.path IS NOT OLD.path BEGIN SELECT RAISE(ABORT,'Evidence source identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_captures_no_update BEFORE UPDATE ON evidence_captures BEGIN SELECT RAISE(ABORT,'Evidence captures are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_captures_validate_insert BEFORE INSERT ON evidence_captures WHEN NOT (length(NEW.sha256)=64 AND NEW.sha256 NOT GLOB '*[^0-9a-f]*' AND NEW.bytes>=0 AND NEW.retained IN (0,1) AND ((NEW.retained=1 AND NEW.retained_path LIKE 'catalog/%') OR (NEW.retained=0 AND NEW.retained_path='')) AND NEW.origin IN ('catalog','submission','curator') AND NEW.evidence_kind IN ('web-excerpt','normalized-statistics','trade-preview','global-target-framework','reviewed-pdf','plain-text') AND length(NEW.excerpt)<=400 AND (NEW.declared_date='' OR (length(NEW.declared_date)=10 AND date(NEW.declared_date) IS NOT NULL)) AND (length(NEW.retrieved_at)=10 OR length(NEW.retrieved_at)=24)) BEGIN SELECT RAISE(ABORT,'Evidence capture is invalid'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_events_no_update BEFORE UPDATE ON evidence_events BEGIN SELECT RAISE(ABORT,'Evidence events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_events_no_delete BEFORE DELETE ON evidence_events BEGIN SELECT RAISE(ABORT,'Evidence events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS submission_evidence_no_update BEFORE UPDATE ON submission_evidence BEGIN SELECT RAISE(ABORT,'Evidence citations are immutable'); END;`);
    db.exec(`CREATE INDEX IF NOT EXISTS agents_spatial ON agents(world_id,x,y);
      CREATE INDEX IF NOT EXISTS agents_operator ON agents(operator_id);
      CREATE INDEX IF NOT EXISTS tokens_agent ON tokens(agent_id,kind,revoked,expires_at);
      CREATE INDEX IF NOT EXISTS messages_world ON messages(world_id,created_at);
      CREATE INDEX IF NOT EXISTS worlds_owner ON worlds(owner_agent_id);
      CREATE INDEX IF NOT EXISTS worlds_public ON worlds(kind,visibility,name);
      CREATE INDEX IF NOT EXISTS objects_world ON world_objects(world_id);
      CREATE INDEX IF NOT EXISTS missions_status_created ON missions(status,created_at,id);
      CREATE INDEX IF NOT EXISTS tasks_mission ON tasks(mission_id,id);
      CREATE INDEX IF NOT EXISTS research_mission_country_goal ON research_leads(mission_id,country_code,goal);
      CREATE INDEX IF NOT EXISTS claims_agent ON claims(agent_id);
      CREATE INDEX IF NOT EXISTS submissions_claim ON submissions(claim_id,status);
      PRAGMA user_version=22; COMMIT;`);
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  if (path !== ':memory:') chmodSync(path, 0o600);
  return db;
}
