// Durable, explicitly scripted city simulation. Native signed arrival acknowledgements are
// authoritative; this extension cannot award coins, create accounts, or claim private land.
import { readFileSync, statSync } from 'node:fs';

export const CITY_SCHEMA = {
  version: 1,
  sql: `
    CREATE TABLE city_clock(id INTEGER PRIMARY KEY CHECK(id=1), sim_ms INTEGER NOT NULL);
    CREATE TABLE city_citizens(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('adult','child','student','apprentice')),
      role TEXT NOT NULL, household_id TEXT NOT NULL, admitted_sim_ms INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, next_sim_ms INTEGER NOT NULL DEFAULT 0,
      participation INTEGER NOT NULL CHECK(participation IN (0,1))
    );
    CREATE TABLE city_households(id TEXT PRIMARY KEY, adult_a TEXT NOT NULL UNIQUE, adult_b TEXT NOT NULL UNIQUE,
      home_group TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, child_allowance INTEGER NOT NULL CHECK(child_allowance BETWEEN 0 AND 1));
    CREATE TABLE city_jobs(
      id TEXT PRIMARY KEY, citizen_id TEXT NOT NULL REFERENCES city_citizens(id), household_id TEXT NOT NULL,
      revision INTEGER NOT NULL, activity TEXT NOT NULL, target TEXT NOT NULL, expected_group TEXT,
      state TEXT NOT NULL CHECK(state IN ('intent','issued','arrived','completed','rejected','expired_unconfirmed','unknown')),
      cmd_id TEXT UNIQUE, created_sim_ms INTEGER NOT NULL, arrived_sim_ms INTEGER, completed_sim_ms INTEGER,
      error TEXT, UNIQUE(citizen_id,revision)
    );
    CREATE UNIQUE INDEX city_one_pending_job ON city_jobs(citizen_id) WHERE state IN ('intent','issued','arrived','unknown');
    CREATE TABLE city_reports(job_id TEXT PRIMARY KEY REFERENCES city_jobs(id), citizen_id TEXT NOT NULL,
      label TEXT NOT NULL, text TEXT NOT NULL, sources TEXT NOT NULL, sim_ms INTEGER NOT NULL);
    CREATE TABLE city_harvests(job_id TEXT PRIMARY KEY REFERENCES city_jobs(id), citizen_id TEXT NOT NULL,
      kind TEXT NOT NULL, crop TEXT NOT NULL, qty INTEGER NOT NULL, sim_ms INTEGER NOT NULL);
    CREATE TABLE city_attendance(job_id TEXT PRIMARY KEY REFERENCES city_jobs(id), citizen_id TEXT NOT NULL,
      venue TEXT NOT NULL, sim_ms INTEGER NOT NULL);
    CREATE TABLE city_assessments(job_id TEXT PRIMARY KEY REFERENCES city_attendance(job_id), citizen_id TEXT NOT NULL,
      level TEXT NOT NULL, exercise TEXT NOT NULL, answer TEXT NOT NULL, expected TEXT NOT NULL,
      sources TEXT NOT NULL, passed INTEGER NOT NULL, sim_ms INTEGER NOT NULL);
    CREATE TABLE city_social_visits(job_id TEXT PRIMARY KEY REFERENCES city_jobs(id), citizen_id TEXT NOT NULL,
      household_id TEXT NOT NULL, sim_ms INTEGER NOT NULL);
    CREATE TABLE city_marriages(household_id TEXT PRIMARY KEY REFERENCES city_households(id), adult_a TEXT NOT NULL,
      adult_b TEXT NOT NULL, visit_a TEXT NOT NULL UNIQUE, visit_b TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, sim_ms INTEGER NOT NULL);
    CREATE TABLE city_births(citizen_id TEXT PRIMARY KEY REFERENCES city_citizens(id), household_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, home_group TEXT NOT NULL, source TEXT NOT NULL, sim_ms INTEGER NOT NULL);
  `,
};

const PRINCIPAL = '00000000-0000-4000-8000-000000000001';
const POLICY = 'operator-preapproved-fictional-city-households-v1';
const BUILD_GROUPS = ['city-home-1-complete', 'city-home-2-complete', 'city-home-3-complete', 'city-home-4-complete',
  'city-office-complete', 'city-school-complete', 'city-university-complete', 'city-farm-complete'];
const FOUNDERS = [
  ['city-ada', 'Ada', 'build', 1], ['city-ivo', 'Ivo', 'build', 2],
  ['city-nila', 'Nila', 'farm', 1], ['city-theo', 'Theo', 'office', 2],
  ['city-mira', 'Mira', 'office', 3], ['city-eli', 'Eli', 'farm', 3],
  ['city-lena', 'Lena', 'social', 4], ['city-oren', 'Oren', 'social', 4],
];
const INTERVAL = 30_000;

function worldRecord(path, maxBytes = 4_000_000) {
  try {
    if (!path || statSync(path).size > maxBytes) return null;
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch { return null; }
}
function nativeRecord(path) {
  const record = worldRecord(path);
  if (record?.format !== 'veloren-world-applied-v1' || typeof record.site !== 'string' || !record.site
    || !Array.isArray(record.origin) || record.origin.length !== 2 || !record.origin.every(Number.isSafeInteger)
    || !record.groups || typeof record.groups !== 'object' || Array.isArray(record.groups)
    || (record.refused !== undefined && (!Array.isArray(record.refused) || record.refused.length))) return null;
  return record;
}
function builtGroups(record) {
  return Object.entries(record?.groups || {}).filter(([id, value]) => /^city-[a-z0-9-]+$/.test(id)
    && value && typeof value === 'object' && /^[a-f0-9]{16}$/.test(value.digest || '')
    && Array.isArray(value.anchor) && value.anchor.length === 2 && value.anchor.every(Number.isSafeInteger)
    && Number.isSafeInteger(value.ground)
    && ['cells','blocks','sprites','foundation_columns','written','applied_at'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)
    && value.applied_at > 0 && value.cells > 0).map(([id]) => id).sort();
}

export class NativeCityService {
  constructor(link, platform, { enabled = false, recordPath, clock = link.clock,
    manifestPath = new URL('../../content/veloren-ai-city.json', import.meta.url),
    projectsPath = new URL('../../content/veloren-ai-city-projects.json', import.meta.url) } = {}) {
    this.link = link; this.platform = platform; this.enabled = enabled === true;
    this.recordPath = recordPath; this.manifestPath = manifestPath; this.projectsPath = projectsPath;
    this.clock = clock; this.lastNativeElapsed = null;
  }

  get enabled() { return this._enabled; }
  set enabled(value) {
    if (this._enabled !== (value === true)) { this.lastNativeElapsed = null; this.lastNativeIdentity = null; }
    this._enabled = value === true;
  }

  #sim() { return this.link.sql.get('SELECT sim_ms FROM city_clock WHERE id=1')?.sim_ms ?? 0; }
  #seed() {
    const sql = this.link.sql;
    sql.tx(() => {
      sql.run('INSERT OR IGNORE INTO city_clock(id,sim_ms) VALUES(1,0)');
      for (let number = 1; number <= 4; number++) {
        const adults = FOUNDERS.filter(f => f[3] === number);
        sql.run('INSERT OR IGNORE INTO city_households VALUES(?,?,?,?,?,?)', `city-household-${number}`, adults[0][0], adults[1][0], `city-home-${number}-complete`, POLICY, 1);
      }
      for (const [id, name, role, household] of FOUNDERS) sql.run(
        "INSERT OR IGNORE INTO city_citizens(id,name,stage,role,household_id,admitted_sim_ms,participation) VALUES(?,?,'adult',?,?,?,1)",
        id, name, role, `city-household-${household}`, this.#sim());
    });
  }

  #advance(record) {
    const elapsed = record?.works_elapsed_ms;
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) { this.lastNativeElapsed = null; return; }
    const identity = JSON.stringify([record.site, record.origin, record.works_started_ms]);
    // Native checkpoints normally arrive every 30 seconds. A startup baseline, replacement
    // world, stale-record jump or long poll gap never replays an arbitrarily old city lifetime.
    const delta = this.lastNativeElapsed === null || this.lastNativeIdentity !== identity ? 0
      : Math.min(60_000, Math.max(0, elapsed - this.lastNativeElapsed));
    this.lastNativeElapsed = elapsed; this.lastNativeIdentity = identity;
    if (delta) this.link.sql.run('UPDATE city_clock SET sim_ms=sim_ms+? WHERE id=1', delta);
  }

  #sources(record) {
    const sources = builtGroups(record).map(ref => ({ type: 'native-world-group', ref, path: 'groups', applied_at: record.groups[ref].applied_at }));
    // Only saved public research marks, with no implicit observe()/new attendance side effects.
    if (this.link.sql.get("SELECT name FROM sqlite_master WHERE type='table' AND name='village_marks'")) {
      for (const mark of this.link.sql.all("SELECT key,text,at FROM village_marks WHERE kind IN ('tech-issued','stage','done') ORDER BY key LIMIT 100")) {
        sources.push({ type: 'saved-public-village-mark', ref: mark.key, text: mark.text, at: mark.at });
      }
    }
    return sources;
  }

  #finish(job, citizen, record, sim) {
    const sql = this.link.sql;
    sql.tx(() => {
      // Completion and its outputs are one transaction, unique by durable job intent.
      if (sql.get('SELECT state FROM city_jobs WHERE id=?', job.id)?.state === 'completed') return;
      const sources = this.#sources(record);
      if (job.activity === 'office') sql.run('INSERT OR IGNORE INTO city_reports VALUES(?,?,?,?,?,?)', job.id, citizen.id,
        'Scripted city report — observed public facts', `${record ? `${builtGroups(record).length} saved city construction stages` : 'Native world record unavailable; no construction total verified'}; ${sources.filter(s => s.type === 'saved-public-village-mark').length} saved public work/research marks observed. This simulation report is not a mission submission or independent review.`, JSON.stringify(sources), sim);
      if (job.activity === 'farm') sql.run('INSERT OR IGNORE INTO city_harvests VALUES(?,?,?,?,?,?)', job.id, citizen.id,
        'virtual-city-harvest', 'simulation greens', 1, sim);
      if (job.activity === 'school') {
        sql.run('INSERT OR IGNORE INTO city_attendance VALUES(?,?,?,?)', job.id, citizen.id, job.target, sim);
        const answer = String(sources.filter(s => s.type === 'native-world-group').length);
        const schoolBuilt = builtGroups(record).includes(`${job.target}-complete`);
        sql.run('INSERT OR IGNORE INTO city_assessments VALUES(?,?,?,?,?,?,?,?,?)', job.id, citizen.id,
          citizen.stage === 'apprentice' ? 'apprentice' : 'school', 'Count the observed saved city construction stages in the cited source snapshot.',
          answer, String(builtGroups(record).length), JSON.stringify(sources), Number(schoolBuilt && answer === String(builtGroups(record).length)), sim);
      }
      if (['social', 'home'].includes(job.activity) && citizen.stage === 'adult') sql.run(
        'INSERT OR IGNORE INTO city_social_visits VALUES(?,?,?,?)', job.id, citizen.id, citizen.household_id, sim);
      sql.run("UPDATE city_jobs SET state='completed', completed_sim_ms=? WHERE id=?", sim, job.id);
      sql.run('UPDATE city_citizens SET next_sim_ms=? WHERE id=?', sim + INTERVAL, citizen.id);
    });
  }

  #reconcile(record, sim) {
    const sql = this.link.sql, built = new Set(builtGroups(record));
    for (const job of sql.all("SELECT * FROM city_jobs WHERE state IN ('intent','issued','arrived','unknown') ORDER BY id")) {
      const citizen = sql.get('SELECT * FROM city_citizens WHERE id=?', job.citizen_id);
      if (job.state === 'intent') { this.#issue(job, citizen); continue; }
      if (job.state === 'unknown') continue; // Never manufacture progress or duplicate an untraceable command.
      if (job.state === 'issued') {
        const outcome = this.link.commandStatus(job.cmd_id).status;
        if (outcome === 'pending') continue;
        if (outcome !== 'applied') {
          sql.tx(() => {
            sql.run('UPDATE city_jobs SET state=?,error=? WHERE id=?', ['rejected','expired_unconfirmed'].includes(outcome) ? outcome : 'unknown', outcome, job.id);
            sql.run('UPDATE city_citizens SET next_sim_ms=? WHERE id=?', sim + INTERVAL, citizen.id);
          });
          continue;
        }
        sql.run("UPDATE city_jobs SET state='arrived',arrived_sim_ms=? WHERE id=?", sim, job.id);
      }
      if (job.activity === 'build' && !built.has(job.expected_group)) continue;
      if (['farm','office','school'].includes(job.activity) && !built.has(`${job.target}-complete`)) continue;
      this.#finish(job, citizen, record, sim);
    }
  }

  #families(record, sim) {
    const sql = this.link.sql, built = new Set(builtGroups(record));
    sql.tx(() => {
      for (const home of sql.all('SELECT * FROM city_households ORDER BY id')) {
        const a = sql.get('SELECT * FROM city_citizens WHERE id=?', home.adult_a);
        const b = sql.get('SELECT * FROM city_citizens WHERE id=?', home.adult_b);
        if (!a || !b || a.id === b.id || a.stage !== 'adult' || b.stage !== 'adult'
          || !a.participation || !b.participation || home.policy !== POLICY) continue;
        const visit = person => sql.get('SELECT job_id FROM city_social_visits WHERE citizen_id=? AND household_id=? ORDER BY sim_ms,job_id LIMIT 1', person.id, home.id);
        const va = visit(a), vb = visit(b);
        if (!va || !vb) continue;
        sql.run('INSERT OR IGNORE INTO city_marriages VALUES(?,?,?,?,?,?,?)', home.id, a.id, b.id, va.job_id, vb.job_id, home.policy, sim);
        if (!home.child_allowance || !this.#homeTarget(a) || !built.has(home.home_group) || sql.get('SELECT citizen_id FROM city_births WHERE household_id=?', home.id)
          || sql.get('SELECT COUNT(*) n FROM city_citizens').n >= 16) continue;
        const id = `city-child-${home.id.slice(-1)}`;
        sql.run("INSERT INTO city_citizens(id,name,stage,role,household_id,admitted_sim_ms,participation) VALUES(?,?,'child','school',?,?,0)", id, `Young ${home.id.endsWith('1') ? 'Ari' : home.id.endsWith('2') ? 'Bo' : home.id.endsWith('3') ? 'Cleo' : 'Dara'}`, home.id, sim);
        sql.run('INSERT INTO city_births VALUES(?,?,?,?,?,?)', id, home.id, 'fictional-birth', home.home_group,
          JSON.stringify({ policy: home.policy, marriage: home.id, group: home.home_group, applied_at: record.groups[home.home_group].applied_at }), sim);
      }
    });
  }

  #education(sim) {
    const sql = this.link.sql;
    for (const citizen of sql.all("SELECT * FROM city_citizens WHERE stage!='adult'")) {
      if (citizen.stage === 'child' && sim - citizen.admitted_sim_ms >= 600_000) sql.run("UPDATE city_citizens SET stage='student' WHERE id=?", citizen.id);
      if (citizen.stage === 'student' && sql.get("SELECT COUNT(*) n FROM city_assessments WHERE citizen_id=? AND level='school' AND passed=1", citizen.id).n >= 3)
        sql.run("UPDATE city_citizens SET stage='apprentice' WHERE id=?", citizen.id);
      if (citizen.stage === 'apprentice' && sql.get("SELECT COUNT(*) n FROM city_assessments WHERE citizen_id=? AND level='apprentice' AND passed=1", citizen.id).n >= 3
        && sql.get('SELECT job_id FROM city_reports WHERE citizen_id=? LIMIT 1', citizen.id))
        sql.run("UPDATE city_citizens SET stage='adult',role='office' WHERE id=?", citizen.id);
    }
  }

  #homeTarget(citizen) {
    const household = this.link.sql.get('SELECT id,home_group FROM city_households WHERE id=?', citizen.household_id);
    return /^city-household-[1-4]$/.test(household?.id || '') && /^city-home-[1-4]-complete$/.test(household.home_group || '')
      ? household.home_group.slice(0, -'-complete'.length) : null;
  }

  #plan(citizen, record) {
    if (citizen.stage === 'child') {
      const target = this.#homeTarget(citizen);
      return target ? { activity: 'home', target } : null;
    }
    if (citizen.stage === 'student') return { activity: 'school', target: 'city-school' };
    if (citizen.stage === 'apprentice') {
      const assessed = this.link.sql.get("SELECT COUNT(*) n FROM city_assessments WHERE citizen_id=? AND level='apprentice' AND passed=1", citizen.id).n;
      return assessed >= 3 ? { activity: 'office', target: 'city-office' } : { activity: 'school', target: 'city-university' };
    }
    if (citizen.role === 'build') {
      const built = new Set(builtGroups(record));
      const configured = worldRecord(this.manifestPath, 2_000_000)?.groups;
      const stages = (Array.isArray(configured) ? configured : []).filter(g => /^city-[a-z0-9-]+$/.test(g.id)
        && g.crew > 0 && /^site-city-(home-[1-4]|office|school|university|farm|build)$/.test(g.site || ''))
        .sort((a, b) => (a.release_after_minutes || 0) - (b.release_after_minutes || 0));
      const stage = stages.find(g => !built.has(g.id));
      if (stage) return { activity: 'build', target: stage.site.slice(5), expected_group: stage.id };
      const group = !stages.length && BUILD_GROUPS.find(g => !built.has(g));
      if (group) return { activity: 'build', target: 'city-build', expected_group: group };
    }
    const activity = citizen.revision % 3 === 1 ? 'social' : citizen.revision % 3 === 2 ? 'home' : citizen.role === 'build' ? 'office' : citizen.role;
    const target = activity === 'home' ? this.#homeTarget(citizen) : ({ social: 'city-park', farm: 'city-farm', office: 'city-office' })[activity];
    return target ? { activity, target } : null;
  }

  #issue(job, citizen) {
    const sql = this.link.sql;
    // A persisted core command recovers the crash window between issueCommand and recording cmd_id.
    const issuedBy = `city:${job.id}`;
    let command = sql.get('SELECT cmd_id FROM link_commands WHERE issued_by=? ORDER BY issued_at LIMIT 1', issuedBy);
    try {
      command ||= this.link.issueCommand({ kind: 'city_actor', player_uuid: PRINCIPAL,
        args: { id: citizen.id, name: citizen.name, stage: citizen.stage, target: job.target, activity: job.activity, revision: job.revision },
        ttl_ms: 300_000, issuedBy });
      sql.run("UPDATE city_jobs SET state='issued',cmd_id=?,error=NULL WHERE id=?", command.cmd_id, job.id);
    } catch (error) {
      // Retain the intent and its same revision for a recoverable unavailable outbox.
      sql.run('UPDATE city_jobs SET error=? WHERE id=?', String(error.message).slice(0, 160), job.id);
    }
  }

  tick() {
    if (!this.enabled) return this.overview();
    if (this.platform?.get("SELECT value FROM settings WHERE key='paused'")?.value === 'true') {
      this.lastNativeElapsed = null; return this.overview();
    }
    this.#seed();
    const record = nativeRecord(this.recordPath);
    this.#advance(record); const sim = this.#sim();
    this.#reconcile(record, sim); this.#families(record, sim); this.#education(sim);
    for (const citizen of this.link.sql.all('SELECT * FROM city_citizens ORDER BY id LIMIT 16')) {
      if (citizen.next_sim_ms > sim || citizen.revision >= 0xffffffff
        || this.link.sql.get("SELECT id FROM city_jobs WHERE citizen_id=? AND state IN ('intent','issued','arrived','unknown')", citizen.id)) continue;
      if (citizen.stage === 'child' && this.link.sql.get("SELECT id FROM city_jobs WHERE citizen_id=? AND activity='home' AND target=? AND state='completed' LIMIT 1", citizen.id, this.#homeTarget(citizen))) continue;
      const plan = this.#plan(citizen, record);
      if (!plan) continue;
      const revision = citizen.revision + 1, id = `${citizen.id}:${revision}`;
      this.link.sql.tx(() => {
        this.link.sql.run("INSERT INTO city_jobs(id,citizen_id,household_id,revision,activity,target,expected_group,state,created_sim_ms) VALUES(?,?,?,?,?,?,?,'intent',?)",
          id, citizen.id, citizen.household_id, revision, plan.activity, plan.target, plan.expected_group || null, sim);
        this.link.sql.run('UPDATE city_citizens SET revision=? WHERE id=?', revision, citizen.id);
      });
      this.#issue(this.link.sql.get('SELECT * FROM city_jobs WHERE id=?', id), citizen);
    }
    return this.overview();
  }

  actorPlans() {
    return this.link.sql.all("SELECT c.id,c.name,c.stage,j.target,j.activity,j.revision,j.state,j.cmd_id FROM city_citizens c JOIN city_jobs j ON j.citizen_id=c.id AND j.revision=c.revision ORDER BY c.id LIMIT 16");
  }

  #construction() {
    const record = nativeRecord(this.recordPath), built = new Set(builtGroups(record));
    const configured = worldRecord(this.manifestPath, 2_000_000)?.groups;
    const catalogue = worldRecord(this.projectsPath, 2_000_000)?.projects;
    const names = new Map((Array.isArray(catalogue) ? catalogue : []).slice(0, 32).map(p => [p.id, p]));
    const projects = new Map(), seen = new Set();
    const publicText = value => String(value || '').replace(/[\r\n\t]+/g, ' ')
      .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s,;]*/g, '[local path]').slice(0, 180);
    for (const group of (Array.isArray(configured) ? configured : []).slice(0, 512)) {
      if (!/^city-[a-z0-9-]+$/.test(group?.id || '') || !/^city-[a-z0-9-]+$/.test(group.project || '') || seen.has(group.id)) continue;
      seen.add(group.id);
      if (!projects.has(group.project)) {
        if (projects.size >= 32) continue;
        const info = names.get(group.project);
        projects.set(group.project, { id: group.project, name: publicText(info?.name || group.project),
          purpose: publicText(info?.purpose || 'Planned native city construction.'), stages: [] });
      }
      projects.get(group.project).stages.push(group);
    }
    return [...projects.values()].map(({ stages, ...project }) => {
      stages.sort((a, b) => (a.release_after_minutes || 0) - (b.release_after_minutes || 0));
      const done = stages.filter(g => built.has(g.id)).length, next = stages.find(g => !built.has(g.id));
      return { ...project, done, total: stages.length, complete: done === stages.length,
        next: next ? { id: next.id, title: publicText(next.title || next.id),
          waiting: !record ? 'native record unavailable' : publicText(record.waiting?.[next.id] || 'awaiting native construction') } : null };
    });
  }

  overview() {
    const sql = this.link.sql;
    const recent = table => sql.all(`SELECT * FROM ${table} ORDER BY sim_ms DESC LIMIT 100`);
    return { enabled: this.enabled, execution: 'scripted native city simulation', simulation_ms: this.#sim(), population_cap: 16,
      citizens: sql.all('SELECT * FROM city_citizens ORDER BY id LIMIT 16'), households: sql.all('SELECT * FROM city_households ORDER BY id'),
      marriages: recent('city_marriages'), births: recent('city_births'), reports: recent('city_reports'), harvests: recent('city_harvests'),
      attendance: recent('city_attendance'), assessments: recent('city_assessments'), plans: this.actorPlans(), construction: this.#construction(),
      rewards: 'Virtual city activity grants no currency, accounts, credentials, land rights or accepted mission contributions.' };
  }
}
