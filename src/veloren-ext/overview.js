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
      techs: research.techs.map((t) => ({ id: t.id, name: t.name, text: t.text, cost: t.cost, state: unlockedIds.has(t.id) ? 'learned' : status.current?.id === t.id ? 'learning' : 'queued' })),
      sources: { finds: facts.finds, stages: facts.stages, projects: facts.projectsDone.size, helped: facts.helps, events: facts.events },
    },
    works: works.map((w) => ({
      id: w.id, name: w.name, purpose: w.purpose, done: w.done, total: w.total, complete: w.complete,
      next: w.next ? { title: w.next.title, minutes: w.next.minutes === null ? null : Math.ceil(w.next.minutes), waiting: w.next.waiting.startsWith('needs a crew') ? w.next.waiting : '' } : null,
    })),
    pantry: { shelves: shelfSummary(link) },
    rhythm: events.map((e) => {
      const slot = activeSlot(e, now);
      return { id: e.id, title: e.title, place: e.place, blurb: e.blurb, on_now: slot !== null, minutes: slot !== null ? Math.max(1, Math.ceil((slot + e.when.length * 60_000 - now) / 60_000)) : minutesToNext(e, now) };
    }),
    chronicle: chronicleLines(link, events, now, () => 'a visitor').slice(1, -1),
    roles: Object.entries(roles).map(([id, r]) => ({ id, title: r.title, purpose: r.purpose, daily: r.daily, gives: r.gives, count: counts.get(id) || 0 })),
    library: loadDiscoveries().map((d) => ({ name: d.name, hint: d.hint, found: found.has(d.landmark_id), finding: found.has(d.landmark_id) ? d.finding : '' })),
  };
}

export const overviewExtension = {
  name: 'overview',
  async handle(link, ctx) {
    if (ctx.route === '/veloren/harr/overview' && ctx.request.method === 'GET') {
      spendRate(link, '*overview', { gapMs: 0, perHour: 7200 });
      ctx.json(ctx.response, 200, buildOverview(link));
      return true;
    }
    return false;
  },
};
