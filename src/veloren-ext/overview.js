// The Harr dashboard's data: one read-only JSON document with everything about the village in one place.
//
//   GET /veloren/harr/overview     no credential (loopback NemoWorld); aggregate facts only
//
// Purpose, goals, research, public works, the pantry, the village rhythm, the chronicle, what each kind of villager
// does, and the library of discoveries. No account data, no private text; aliases of finders are not included.
import { goalStatus, gatherFacts, loadCharter, loadResearch, loadRoles, researchStatus } from './research.js';
import { loadDiscoveries, loadRecord, loadWorks, worksStatus } from './world-life.js';
import { activeSlot, chronicleLines, loadEvents, minutesToNext } from './village.js';
import { shelfSummary } from './pantry.js';
import { spendRate } from './view.js';
import { VILLAGERS } from './villagers.js';
import { tasksFor, tasksLines } from './tasks.js';
import { gameplayOverview, seasonalBlurb, withLevel } from './gameplay.js';

export function buildOverview(link, now = link.clock()) {
  const charter = loadCharter();
  const research = loadResearch();
  const facts = gatherFacts(link);
  const status = researchStatus(facts, research);
  const events = loadEvents();
  const roles = loadRoles();
  const works = worksStatus(loadWorks(), loadRecord(process.env.NEMO_WORLD_RECORD), now);
  const found = new Set(link.sql.all("SELECT DISTINCT landmark_id AS id FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%'").map((r) => r.id));
  const unlockedIds = new Set(status.unlocked.map((t) => t.id));
  const counts = new Map();
  for (const v of VILLAGERS) counts.set(v.role, (counts.get(v.role) || 0) + 1);
  return {
    generated_at: now,
    purpose: { name: charter.name, text: charter.purpose, principles: charter.principles, goals: goalStatus(facts, status, charter) },
    research: {
      insight: status.insight, learned: status.unlocked.length, total: research.techs.length,
      current: status.current ? { name: status.current.name, text: status.current.text, progress: status.progress, cost: status.current.cost } : null,
      techs: research.techs.map((t) => ({ id: t.id, name: t.name, text: t.text, cost: t.cost, needs: t.needs || [], state: unlockedIds.has(t.id) ? 'learned' : status.current?.id === t.id ? 'learning' : 'queued' })),
      sources: { finds: facts.finds, stages: facts.stages, projects: facts.projectsDone.size, helped: facts.helps, events: facts.events },
    },
    works: works.map((w) => ({
      id: w.id, name: w.name, purpose: w.purpose, done: w.done, total: w.total, complete: w.complete,
      next: w.next ? { title: w.next.title, minutes: w.next.minutes === null ? null : Math.ceil(w.next.minutes), waiting: /^(needs a crew|waiting for research)/.test(w.next.waiting) ? w.next.waiting : '' } : null,
    })),
    pantry: { shelves: shelfSummary(link) },
    rhythm: events.map((e) => {
      const slot = activeSlot(e, now);
      return { id: e.id, title: e.title, place: e.place, blurb: seasonalBlurb(e, now), on_now: slot !== null, minutes: slot !== null ? Math.max(1, Math.ceil((slot + e.when.length * 60_000 - now) / 60_000)) : minutesToNext(e, now) };
    }),
    chronicle: withLevel(chronicleLines(link, events, now, () => 'a visitor'), link).slice(1, -1),
    roles: Object.entries(roles).map(([id, r]) => ({ id, title: r.title, purpose: r.purpose, daily: r.daily, gives: r.gives, count: counts.get(id) || 0 })),
    gameplay: gameplayOverview(link, now),
    library: loadDiscoveries().map((d) => ({ name: d.name, hint: d.hint, found: found.has(d.landmark_id), finding: found.has(d.landmark_id) ? d.finding : '' })),
  };
}

// The document needs no credential, so anybody who can reach the page can ask for it as often as the hourly cap allows;
// it is computed from the database, the content files and the server's record, so it is kept for a few seconds.
const OVERVIEW_TTL_MS = 5_000;
const overviewCache = new WeakMap();
function cachedOverview(link) {
  const now = link.clock();
  const hit = overviewCache.get(link);
  if (hit && now >= hit.at && now - hit.at < OVERVIEW_TTL_MS) return hit.value;
  const value = buildOverview(link, now);
  overviewCache.set(link, { at: now, value });
  return value;
}

export const overviewExtension = {
  name: 'overview',
  async handle(link, ctx) {
    if (ctx.route === '/veloren/harr/overview' && ctx.request.method === 'GET') {
      spendRate(link, '*overview', { gapMs: 0, perHour: 7200 });
      ctx.json(ctx.response, 200, cachedOverview(link));
      return true;
    }
    if (ctx.route === '/veloren/harr/tasks' && ctx.request.method === 'GET') {
      spendRate(link, '*overview', { gapMs: 0, perHour: 7200 });
      ctx.json(ctx.response, 200, {
        tasks: tasksFor(link, 'anonymous'),
        lines: tasksLines(link, 'anonymous'),
      });
      return true;
    }
    return false;
  },
};
