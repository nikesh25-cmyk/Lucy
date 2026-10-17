// A newcomer's tasks: a short, peaceful checklist with one clear next step, derived only from facts the game
// server and NemoWorld recorded for this player. Nothing here gives coins or items; it only points the way.
// The list is the missions catalogue (content/veloren-missions.json) in its short form: this file keeps the
// page's old shape and wording so the guide and its tests do not change. `short` is the one-line hint the
// guide's recommendation uses (help, start, next, menu); a mission without one falls back to its `how`.
import { missionsFor } from './missions.js';
import { gameplayTaskLines } from './gameplay.js';

export function tasksFor(link, player_uuid) {
  return missionsFor(link, player_uuid).map((m) => ({
    id: m.id, title: m.title, short: m.short || m.how, progress: m.progress, target: m.target, how: m.how, done: m.done,
  }));
}

/**
 * The ONE thing a newcomer should do now: the first unfinished task, in the order above, taken only
 * from saved facts. When everything is done it points at the village instead. Pure reads.
 */
export function recommendNext(link, player_uuid) {
  const next = tasksFor(link, player_uuid).find((t) => !t.done);
  if (next) return { id: next.id, title: next.title, progress: next.progress, target: next.target, short: next.short, all_done: false };
  return { id: 'village', title: 'Lend a hand in the village', progress: 0, target: 0, short: 'Say works to see what the builders need, or today for the market hour.', all_done: true };
}

export function tasksLines(link, player_uuid) {
  const tasks = tasksFor(link, player_uuid);
  const done = tasks.filter((t) => t.done).length;
  const out = [`Your tasks: ${done} of ${tasks.length} done. They are small and peaceful; take them in any order.`];
  const next = tasks.find((t) => !t.done);
  if (next) out.push(`Next: ${next.title} (${next.progress} of ${next.target}). ${next.how}`);
  for (const t of tasks) out.push(`${t.done ? 'Done' : 'To do'}: ${t.title}${t.done ? '' : `, ${t.progress} of ${t.target}`}.`);
  if (!next) out.push('You have done them all. Lend a hand to the builders, join the market hour, and see what the village is learning with research.');
  out.push(...gameplayTaskLines(link, player_uuid));
  return out;
}
