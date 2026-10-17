import { randomUUID } from 'node:crypto';
import { redactDiagnostics } from './recovery.js';

// A structured, counted record for a request that failed unexpectedly.
//
// Before this module the only trace of an unhandled server error was one unstructured stderr line
// carrying `error.code`/`error.name`. That kept secrets out of the log, but it left an operator with
// no way to tell whether the process was failing requests at all: nothing was counted, nothing was
// timestamped, nothing named the route, and the administrator dashboard showed no incident surface.
// A public pilot cannot be operated like that — "is the world returning 500s?" has to be answerable
// from the dashboard, not from scrolling a terminal.
//
// What a record deliberately does NOT carry is any text that came from the request or from the
// failure itself: no request body, no header, no credential, no query string, no message text and no
// stack. docs/OPERATIONS.md §10 states that guarantee for the HTTP error log, and `tests/http.test.js`
// already pins the response half of it; the half this module adds is the *record*, and
// `tests/reliability-drills.test.js` proves the guarantee holds even when the throwing error's own
// message is seeded with a token, a password digest, a contact address and a private artifact marker.
// The safe facts that remain — when, which method, which route, which failure class — are what makes
// the counter actionable. Everything is passed through `redactDiagnostics` anyway, so a route or an
// error name that ever began to carry a secret shape would be scrubbed rather than published.
export const INCIDENT_LIMITS = Object.freeze({
  recent_records: 20,
  note: 'The request failed unexpectedly. No request body, header, credential, query value or message text is recorded.',
});

export function createIncidentLog({ clock = Date.now, limit = INCIDENT_LIMITS.recent_records, sink = null } = {}) {
  const counters = { recorded_since_start: 0 };
  const recent = [];
  let lastAt = null, lastRoute = null;
  const text = (value) => (typeof value === 'string' && value.length <= 200 ? value : '');

  function record(input = {}) {
    try {
      const error = input.error;
      const record = Object.freeze(redactDiagnostics({
        id: randomUUID(),
        at: new Date(clock()).toISOString(),
        kind: text(input.kind) || 'server.error',
        method: text(input.method),
        route: text(input.route),
        status: Number.isInteger(input.status) ? input.status : 500,
        error_name: text(error?.name) || 'UnknownError',
        error_code: text(error?.code),
        note: INCIDENT_LIMITS.note,
      }));
      counters.recorded_since_start += 1;
      lastAt = record.at; lastRoute = record.route;
      recent.push(record);
      while (recent.length > limit) recent.shift();
      // A sink is given a finished record and its own failure is never allowed to change a response.
      try { (sink || defaultSink)(record); } catch { /* an incident that cannot be announced is still counted */ }
      return record;
    } catch { return null; }
  }

  // The same shape the diagnostics payload uses everywhere else: named counters, a last-seen stamp
  // and a bounded tail. Nothing here is estimated and nothing is read back from storage.
  const summary = () => ({
    recorded_since_start: counters.recorded_since_start,
    last_at: lastAt,
    last_route: lastRoute,
    recent: recent.slice(),
    redaction: 'No request body, header, credential, query value or message text is ever recorded.',
  });

  return { record, summary, recent: () => recent.slice() };
}

function defaultSink(record) {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...record })}\n`);
}
