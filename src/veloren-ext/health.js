// A small, additive health probe for Harr operations (launchers, watchdogs, ops/verify.sh).
//
//   GET /veloren/harr/health     no credential (loopback NemoWorld); aggregate numbers only
//
// Answers four questions: is the database readable, is the link itself working, how long ago did the game last
// send an event, and how old is the works record. It returns counts and ages only: no names, aliases, player ids,
// paths or credentials. It writes nothing and uses no rate-limit table, so a monitor can poll it every few seconds.
// The HTTP status is 200 when the database and the link both work, 503 otherwise (a stale record is a warning, not a failure).
import { loadRecord } from './world-life.js';

export const HEALTH_POLICY = Object.freeze({
  event_warn_s: 15 * 60,     // no game event for 15 minutes while the world should be running: warn
  record_warn_s: 10 * 60,    // the game server rewrites the works record about once a minute
});

const ageSeconds = (now, then) => (Number.isFinite(then) && then > 0 ? Math.max(0, Math.round((now - then) / 1000)) : null);

export function buildHealth(link, now = link.clock(), recordPath = process.env.NEMO_WORLD_RECORD) {
  const out = { ok: true, generated_at: now, db: { ok: false }, link: { ok: false }, events: { last_event_age_s: null, warn: false }, works_record: { present: false, age_s: null, warn: false, stages_built: 0, waiting: 0 }, warnings: [] };
  try { out.db.ok = link.sql.get('SELECT 1 AS one')?.one === 1; } catch { out.db.ok = false; }
  try {
    const status = link.status();
    out.link = { ok: typeof status?.events === 'number', events_total: status?.events ?? 0, players: status?.players ?? 0, credentials_active: status?.credentials_active ?? 0 };
  } catch { out.link = { ok: false }; }
  if (out.db.ok) {
    try {
      const last = link.sql.get('SELECT MAX(received_at) AS at FROM link_events')?.at ?? null;
      out.events.last_event_age_s = ageSeconds(now, last);
    } catch { /* leave null */ }
  }
  out.events.warn = out.events.last_event_age_s !== null && out.events.last_event_age_s > HEALTH_POLICY.event_warn_s;
  const record = loadRecord(recordPath);
  if (record) {
    const groups = record.groups && typeof record.groups === 'object' ? Object.keys(record.groups) : [];
    out.works_record = {
      present: true,
      age_s: ageSeconds(now, Number(record.updated_at)),
      stages_built: groups.filter((k) => /\d$/.test(k)).length,
      waiting: record.waiting && typeof record.waiting === 'object' ? Object.keys(record.waiting).length : 0,
      warn: false,
    };
    out.works_record.warn = out.works_record.age_s === null || out.works_record.age_s > HEALTH_POLICY.record_warn_s;
  }
  if (!out.db.ok) out.warnings.push('database unreadable');
  if (!out.link.ok) out.warnings.push('link not working');
  if (out.events.warn) out.warnings.push('no game events for a long time');
  if (out.events.last_event_age_s === null && out.db.ok) out.warnings.push('no game events recorded yet');
  if (!out.works_record.present) out.warnings.push('works record missing');
  else if (out.works_record.warn) out.warnings.push('works record is stale');
  out.ok = out.db.ok && out.link.ok;
  return out;
}

export const healthExtension = {
  name: 'health',
  async handle(link, ctx) {
    if (ctx.route === '/veloren/harr/health' && ctx.request.method === 'GET') {
      const report = buildHealth(link);
      ctx.json(ctx.response, report.ok ? 200 : 503, report);
      return true;
    }
    return false;
  },
};
