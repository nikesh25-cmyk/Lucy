// A newcomer's tasks: a short, peaceful checklist with one clear next step, derived only from facts the game
// server and NemoWorld recorded for this player. Nothing here gives coins or items; it only points the way.
import { identityFor } from './identity.js';
import { loadDiscoveries } from './world-life.js';
import { gameplayTaskLines } from './gameplay.js';

export function tasksFor(link, player_uuid) {
  const sql = link.sql;
  const n = (query, ...args) => Number(sql.get(query, ...args)?.n ?? 0);
  const met = n("SELECT COUNT(DISTINCT resident_id) AS n FROM link_events WHERE kind='resident.met' AND player_uuid=?", player_uuid);
  const finds = n("SELECT COUNT(*) AS n FROM (SELECT 1 FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%' AND player_uuid=? GROUP BY landmark_id)", player_uuid);
  const meals = n("SELECT COUNT(*) AS n FROM pantry_takes WHERE state='delivered' AND player_uuid=?", player_uuid);
  let survey = false;
  try { survey = Boolean(link.progress(player_uuid).complete); } catch { /* not started */ }
  let linked = false;
  try { linked = Boolean(identityFor(link, player_uuid)); } catch { /* not linked */ }
  const first = loadDiscoveries()[0];
  return [
    { id: 'meet', title: 'Meet five villagers', short: 'Stand beside five villagers around the plaza, the workshop and the fields.', progress: Math.min(5, met), target: 5, how: 'Walk up to the people around the plaza, the workshop and the fields and stand beside them for a moment.' },
    { id: 'meal', title: 'Share a meal', short: 'Whisper me: take apple. The pantry is free for everyone.', progress: Math.min(1, meals), target: 1, how: 'Whisper Selene: take apple. The pantry is free for everyone.' },
    { id: 'find', title: 'Find a place for the library', short: `Whisper me: library, then walk to ${first ? first.name.toLowerCase() : 'a place on the list'} and stay a few seconds.`, progress: Math.min(1, finds), target: 1, how: `Whisper Selene: library, then walk to ${first ? first.name.toLowerCase() : 'a place on the list'} and stay a few seconds.` },
    { id: 'survey', title: 'Take the Quiet Survey with Lyra', short: 'Stand beside Lyra at the house and she will walk the survey with you.', progress: survey ? 1 : 0, target: 1, how: 'Stand beside Lyra at the house; she will walk the field survey with you. It is a practice and awards nothing.' },
    { id: 'discover3', title: 'Add three pages to the library', short: 'Visit places from the library list; three pages in all.', progress: Math.min(3, finds), target: 3, how: 'Every find adds insight for the whole village and brings the next technology closer.' },
    { id: 'link', title: 'Keep your progress in NemoWorld', short: 'Whisper Lyra: link my account. She sends a private code.', progress: linked ? 1 : 0, target: 1, how: 'Whisper Lyra: link my account. She sends a private code to enter on the NemoWorld link page.' },
  ].map((t) => ({ ...t, done: t.progress >= t.target }));
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
