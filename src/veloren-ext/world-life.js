// The living side of Harr: public works that keep being built, and a library that fills as people
// discover the places around the village. Both are READERS of facts the game server wrote:
//   * works: the schedule in the world manifest + the server's own record of what it has built
//     (`<outbox>.world.json`). Nothing here builds anything; the server does, on a clock.
//   * library: signed `landmark.visited` events (a person stood in a discovery place), stored once by
//     the link. A discovery is recognition of curiosity: it grants no coins and no items.
// Everything shown is scripted and says so. No scarcity, no competition: the first finder is named,
// everyone may still find it, and every find adds a page for the whole village.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, '..', '..', 'content');
export const MANIFEST_PATH = join(CONTENT, 'veloren-world-harr.json');
export const PROJECTS_PATH = join(CONTENT, 'veloren-projects.json');
export const DISCOVERIES_PATH = join(CONTENT, 'veloren-discoveries.json');

const cache = new Map();
function readJson(path) {
  const stat = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtime === stat.mtimeMs) return hit.value;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  cache.set(path, { mtime: stat.mtimeMs, value });
  return value;
}

/** Projects in catalogue order, each with its ordered stages: [{ id, title, release_after_minutes }]. */
export function loadWorks({ manifestPath = MANIFEST_PATH, projectsPath = PROJECTS_PATH } = {}) {
  const manifest = readJson(manifestPath);
  const catalogue = readJson(projectsPath);
  const stagesOf = new Map();
  for (const group of manifest.groups || []) {
    if (!group.project) continue;
    if (!stagesOf.has(group.project)) stagesOf.set(group.project, []);
    stagesOf.get(group.project).push({ id: group.id, title: String(group.title || group.id), release_after_minutes: Number(group.release_after_minutes) || 0, site: String(group.site || '') });
  }
  return (catalogue.projects || []).map((project) => ({
    id: project.id, name: project.name, purpose: project.purpose,
    stages: (stagesOf.get(project.id) || []).sort((a, b) => a.release_after_minutes - b.release_after_minutes),
  }));
}

/** The server's record of what it built, or null when it has not written one. Never throws. */
export function loadRecord(path) {
  try {
    if (!path || !existsSync(path)) return null;
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch { return null; }
}

const minutesText = (minutes) => {
  const m = Math.max(1, Math.ceil(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
};

/** Status of every project, from the schedule and the server's record. Pure. */
export function worksStatus(projects, record, now) {
  const started = Number(record?.works_started_ms) || 0;
  const elapsed = Number(record?.works_elapsed_ms) || 0; // minutes of open-world time, not calendar time
  const built = new Set(Object.keys(record?.groups || {}));
  return projects.map((project) => {
    let done = 0;
    let next = null;
    for (const stage of project.stages) {
      if (built.has(stage.id)) { done += 1; continue; }
      if (!next) next = { ...stage, waiting: String(record?.waiting?.[stage.id] || ''), minutes: started ? Math.max(0, (stage.release_after_minutes * 60_000 - elapsed) / 60_000) : null };
    }
    return { id: project.id, name: project.name, purpose: project.purpose, total: project.stages.length, done, next, complete: done === project.stages.length && project.stages.length > 0 };
  });
}

export function worksLines(projects, record, now) {
  const status = worksStatus(projects, record, now);
  const totalStages = status.reduce((n, p) => n + p.total, 0);
  const doneStages = status.reduce((n, p) => n + p.done, 0);
  const complete = status.filter((p) => p.complete).length;
  const out = [`Harr's public works: ${doneStages} of ${totalStages} stages built, ${complete} of ${status.length} projects complete.`];
  if (!record || !record.works_started_ms) out.push('The works begin as soon as the village wakes. Come back in a few minutes.');
  const building = status.filter((p) => !p.complete && p.done > 0);
  const queued = status.filter((p) => !p.complete && p.done === 0);
  const when = (n) => (n.minutes === null ? 'soon' : n.minutes <= 0 ? 'any moment' : `in about ${minutesText(n.minutes)}`);
  for (const p of building) {
    const crew = p.next.waiting.startsWith('needs a crew') ? p.next.waiting.replace('needs a crew: ', '') : '';
    out.push(crew
      ? `${p.name}: stage ${p.done} of ${p.total} built. Next, ${p.next.title.toLowerCase()}, is ready and waits for a crew (${crew}). Join the builders at the site and lend a hand.`
      : `${p.name}: stage ${p.done} of ${p.total} built. Next, ${p.next.title.toLowerCase()}, ${when(p.next)}.`);
  }
  for (const p of queued.filter((q) => !q.next)) out.push(`${p.name}: planned.`);
  for (const p of queued.filter((q) => q.next)) out.push(`${p.name}: planned. Stage 1 (${p.next.title.toLowerCase()}) ${p.next.minutes === null ? 'soon' : p.next.minutes <= 0 ? 'any moment' : `in about ${minutesText(p.next.minutes)}`}.`);
  for (const p of status.filter((s) => s.complete)) out.push(`${p.name}: finished. ${p.purpose}`);
  out.push('Builders gather at the sites by day. The schedule is scripted; the stages are built by the game server and survive restarts.');
  return out;
}

/** Catalogue of discoveries, or []. */
export function loadDiscoveries(path = DISCOVERIES_PATH) {
  try { return readJson(path).discoveries || []; } catch { return []; }
}

/** Every recorded find, once per person and place, oldest first. Reads signed events only. */
export function findsFrom(sql, catalogue) {
  const byLandmark = new Map(catalogue.map((d) => [d.landmark_id, d]));
  const rows = sql.all("SELECT player_uuid, player_alias, landmark_id, MIN(occurred_at) AS at FROM link_events WHERE kind='landmark.visited' AND landmark_id IS NOT NULL GROUP BY player_uuid, landmark_id ORDER BY at ASC LIMIT 5000");
  return rows.filter((r) => byLandmark.has(r.landmark_id)).map((r) => ({ discovery: byLandmark.get(r.landmark_id), player_uuid: r.player_uuid, alias: r.player_alias || 'a traveller', at: Number(r.at) }));
}

const level = (found, total) => (found >= total && total > 0 ? "Harr's catalogue is complete" : found >= Math.ceil(total * 0.6) ? 'a learned village' : found >= Math.ceil(total * 0.3) ? 'a studious hamlet' : 'a quiet hamlet');

export function libraryLines(catalogue, finds, player_uuid, clean = (s) => s) {
  const total = catalogue.length;
  const known = new Set(finds.map((f) => f.discovery.id));
  const mine = finds.filter((f) => f.player_uuid === player_uuid);
  const myIds = new Set(mine.map((f) => f.discovery.id));
  const out = [`Harr Library: ${known.size} of ${total} places catalogued, so Harr is ${level(known.size, total)}. You have found ${myIds.size}.`];
  for (const f of mine.slice(-4)) out.push(`You found ${f.discovery.name}: ${f.discovery.finding}`);
  const unfound = catalogue.filter((d) => !myIds.has(d.id));
  for (const d of unfound.slice(0, 3)) out.push(`To find: ${d.name}, ${d.hint}.`);
  const recent = finds.filter((f) => f.player_uuid !== player_uuid).slice(-2).reverse();
  for (const f of recent) out.push(`Latest page: ${clean(f.alias)} recorded ${f.discovery.name}.`);
  if (!unfound.length) out.push('You have found every place. The village thanks you; the annex shelves are fuller for it.');
  out.push('Walk to a place and stay a few seconds. Finds are recorded by the game server from where you stand; they bring recognition, never coins.');
  return out;
}
