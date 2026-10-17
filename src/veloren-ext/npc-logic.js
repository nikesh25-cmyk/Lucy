// What the villagers know and say, grounded in the same recorded facts the dashboard shows.
//
// A villager asked about their work (or about why Harr exists) answers from live facts: a builder from the works
// board, a farmer from the pantry shelves, a scholar from the research queue, a courier from the chronicle, a
// keeper or maker from the village rhythm. The words are scripted; the numbers are real. The same facts are
// handed to the language model as context, so its answers cannot contradict the board.
import { loadCharter, loadRoles, researchStatus, gatherFacts } from './research.js';
import { loadRecord, loadWorks, worksStatus } from './world-life.js';
import { shelfSummary } from './pantry.js';
import { chronicleLines, loadEvents, todayLines } from './village.js';
import { VILLAGERS } from './villagers.js';
import { conversationReply } from './conversations.js';
import { mentorReply } from './apprenticeship.js';

const roleOf = (resident) => resident?.role || null;
const cut = (text, n = 240) => (text.length <= n ? text : `${text.slice(0, n - 1).replace(/[\s,;:.-]+\S*$/, '')}…`);

function worksFact(link) {
  const status = worksStatus(loadWorks(), loadRecord(process.env.NEMO_WORLD_RECORD), link.clock());
  const active = status.find((p) => !p.complete && p.done > 0) || status.find((p) => !p.complete);
  if (!active) return 'Every public work is finished for now.';
  const waits = active.next?.waiting || '';
  if (waits.startsWith('needs a crew')) return `We are raising ${active.name}: ${active.done} of ${active.total} stages built. The next stage is ready and needs a crew of two or more at the site, so lend a hand if you can.`;
  return `We are raising ${active.name}: ${active.done} of ${active.total} stages built.`;
}

function researchFact(link) {
  const facts = gatherFacts(link);
  const s = researchStatus(facts);
  return s.current
    ? `The village has ${s.insight} insight and has learned ${s.unlocked.length} things. We are learning ${s.current.name} now, ${s.progress} of ${s.current.cost}. Every place you find adds to it.`
    : 'We have learned everything in our queue and are ready for the next chapter.';
}

const FACTS = {
  builder: worksFact,
  farmer: (link) => `The pantry holds ${shelfSummary(link)}; it is free to everyone and restocked from our fields.`,
  scholar: researchFact,
  courier: (link) => cut(chronicleLines(link, loadEvents(), link.clock()).slice(1, 2).join(' ') || 'A quiet day so far.'),
  keeper: (link) => cut(todayLines(loadEvents(), link.clock()).slice(1, 3).join(' ')),
  maker: (link) => cut(todayLines(loadEvents(), link.clock()).slice(1, 2).join(' ')),
};

/** One line of true context about the village, for this villager. */
export function factsFor(link, resident) {
  const role = roleOf(resident);
  try { return FACTS[role] ? cut(FACTS[role](link), 280) : ''; } catch { return ''; }
}

/** A grounded reply when the question is about the villager's work or the village's purpose; otherwise null. */
export function replyFor(link, resident, lower) {
  const role = roleOf(resident);
  const roles = loadRoles();
  const has = (words) => words.some((w) => lower.includes(w));
  try {
    if (has(['purpose', 'why harr', 'why are we', 'charter', 'what is harr', 'greater'])) return cut(loadCharter().purpose);
    if (has(['apprentice', 'mentor', 'teach me', 'learn from you'])) { const m = mentorReply(link, resident); if (m) return cut(m); }
    if (!role || !roles[role] || !FACTS[role]) return null;
    if (has(['what are you doing', 'your work', 'what do you do', 'your job', ...roles[role].topics])) {
      return cut(`${roles[role].purpose} ${FACTS[role](link)}`);
    }
    const talk = conversationReply(link, resident, lower); // the role's 'ask me about' answers, after its own topics
    if (talk) return cut(talk);
  } catch { /* a villager never fails to answer */ }
  return null;
}

/** Where a builder or maker should be while a public work is going up: the site its next stage stands on.
 *  Scripted and small — the site id comes from the same works board the dashboard shows. */
export function workOrder(link, resident_id) {
  const resident = VILLAGERS.find((r) => r.id === resident_id);
  if (!resident || (resident.role !== 'builder' && resident.role !== 'maker')) return null;
  const status = worksStatus(loadWorks(), loadRecord(process.env.NEMO_WORLD_RECORD), link.clock());
  const active = status.find((p) => !p.complete && p.next?.site) || status.find((p) => !p.complete);
  const site = active?.next?.site;
  return site ? { mode: 'work', target_landmark_id: site } : null;
}

export const npcExtension = {
  name: 'npc',
  reply: (link, resident, lower) => replyFor(link, resident, lower),
  facts: (link, resident) => factsFor(link, resident),
  director: (link, resident_id) => workOrder(link, resident_id),
  async handle() { return false; },
};

export { VILLAGERS };
