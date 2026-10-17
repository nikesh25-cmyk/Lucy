// A newcomer's tasks: a short, peaceful checklist with one clear next step, derived only from facts the game
// server and NemoWorld recorded for this player. Nothing here gives coins or items; it only points the way.
import { identityFor } from './identity.js';
import { loadDiscoveries } from './world-life.js';

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
    { id: 'meet', title: 'Meet five villagers', progress: Math.min(5, met), target: 5, how: 'Walk up to the people around the plaza, the workshop and the fields and stand beside them for a moment.' },
    { id: 'meal', title: 'Share a meal', progress: Math.min(1, meals), target: 1, how: 'Whisper Selene: take apple. The pantry is free for everyone.' },
    { id: 'find', title: 'Find a place for the library', progress: Math.min(1, finds), target: 1, how: `Whisper Selene: library, then walk to ${first ? first.name.toLowerCase() : 'a place on the list'} and stay a few seconds.` },
    { id: 'survey', title: 'Take the Quiet Survey with Lyra', progress: survey ? 1 : 0, target: 1, how: 'Stand beside Lyra at the house; she will walk the field survey with you. It is a practice and awards nothing.' },
    { id: 'discover3', title: 'Add three pages to the library', progress: Math.min(3, finds), target: 3, how: 'Every find adds insight for the whole village and brings the next technology closer.' },
    { id: 'link', title: 'Keep your progress in NemoWorld', progress: linked ? 1 : 0, target: 1, how: 'Whisper Lyra: link my account. She sends a private code to enter on the NemoWorld link page.' },
  ].map((t) => ({ ...t, done: t.progress >= t.target }));
}

export function tasksLines(link, player_uuid) {
  const tasks = tasksFor(link, player_uuid);
  const done = tasks.filter((t) => t.done).length;
  const out = [`Your tasks: ${done} of ${tasks.length} done. They are small and peaceful; take them in any order.`];
  const next = tasks.find((t) => !t.done);
  if (next) out.push(`Next: ${next.title} (${next.progress} of ${next.target}). ${next.how}`);
  for (const t of tasks) out.push(`${t.done ? 'Done' : 'To do'}: ${t.title}${t.done ? '' : `, ${t.progress} of ${t.target}`}.`);
  if (!next) out.push('You have done them all. Lend a hand to the builders, join the market hour, and see what the village is learning with research.');
  return out;
}
