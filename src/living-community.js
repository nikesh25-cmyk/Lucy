import { SAMPLE_GUILD_PLANS } from './guilds.js';

// Seeds the cooperative layer of the world through the systems that already exist — circles,
// gatherings, guild projects — as the eight living residents. A lone human arriving in a fresh world
// otherwise has no circle to join, no gathering to RSVP to and no guild project to pledge to, so the
// objectives that need them are unreachable. Every write goes through the same platform method a human
// operator's resident would call, so every quota, ownership and visibility rule still applies; nothing
// here writes a table directly and nothing mints a coin, a plot or a review.

export const LIVING_CIRCLES = Object.freeze([
  { key: 'dawn-gardeners', creator: 'lw-aria', name: 'Dawn Gardeners', focus: 'Care', members: ['lw-rowan', 'lw-selene'],
    summary: 'A circle for people who tend living things at first light: swap seeds, share what grew, and keep the orchard patient and kind.' },
  { key: 'workshop-hands', creator: 'lw-kael', name: 'Workshop Hands', focus: 'Creativity', members: ['lw-theron', 'lw-aria'],
    summary: 'Makers who craft keepsakes together, trade offcuts and show half-finished work. Beginners are welcome at the bench.' },
  { key: 'evening-storytellers', creator: 'lw-selene', name: 'Evening Storytellers', focus: 'Learning', members: ['lw-lyra', 'lw-vaelen', 'lw-bram'],
    summary: 'Short stories, honest questions and quiet company in the Meeting Hall as the day settles.' },
  { key: 'quiet-mediators', creator: 'lw-vaelen', name: 'Quiet Mediators', focus: 'Peace', members: ['lw-selene', 'lw-rowan'],
    summary: 'Practice listening well: how to disagree gently, how to repair a misunderstanding, how to leave room for others.' },
  { key: 'frontier-cartographers', creator: 'lw-bram', name: 'Frontier Cartographers', focus: 'Learning', members: ['lw-lyra', 'lw-theron'],
    summary: 'Map the paths, bridges and plots of the shared land so that every newcomer can find their way.' },
]);

// One recurring gathering per host. The title and purpose rotate with the day so the board never
// reads as the same event repeated; the place is a public shared space the host's calling suits.
export const LIVING_GATHERINGS = Object.freeze([
  { host: 'lw-selene', circle: 'evening-storytellers', world: 'hall', titles: ['Stories at the Hall', 'An Evening of Small Tales', 'Open Hearth Hour', 'Questions Worth Asking'],
    summary: 'Come as you are. One short story or one good question each; listening counts as taking part.' },
  { host: 'lw-vaelen', circle: 'quiet-mediators', world: 'pavilion', titles: ['Listening Practice', 'Repairing a Misunderstanding', 'Quiet Pavilion Sitting', 'Gentle Disagreement'],
    summary: 'A calm, guided hour in the Peace Pavilion. Nothing to prepare and nobody is put on the spot.' },
  { host: 'lw-aria', circle: 'dawn-gardeners', world: 'orchard', titles: ['Orchard Walk and Seed Swap', 'What Grew This Week', 'Tending Together', 'Blossom and Resin Day'],
    summary: 'Walk the orchard, trade seeds and share what is ready to harvest.' },
  { host: 'lw-kael', circle: 'workshop-hands', world: 'workshop', titles: ['Open Bench', 'Keepsake Make-Along', 'Show Your Unfinished Work', 'Trade Your Offcuts'],
    summary: 'Bring a project at any stage. Crafting tips, honest feedback and a seat at the bench.' },
  { host: 'lw-lyra', circle: null, world: 'library', titles: ['Reading Room Hour', 'Sources and Where to Find Them', 'Evidence Reading Circle', 'Ask the Librarian'],
    summary: 'Quiet shared reading in the Library, and help with finding and citing sources.' },
]);

const GATHERING_LEAD_MS = 20 * 60_000, GATHERING_MS = 45 * 60_000, SEED_INTERVAL_MS = 60_000;
const lastSeed = new WeakMap();
const iso = (ms) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
const quiet = (action) => { try { return action(); } catch (error) { if (error?.status) return null; throw error; } };

/** The signed-in-operator actor a resident's own operator would use, as the living tick already does. */
const actorOf = (accounts, resident) => ({ account: accounts[resident.operatorKey], kind: 'session' });

/**
 * Idempotently create the circles and the guild project, join the members, keep one upcoming
 * gathering per host and RSVP its circle. Safe to call every tick: it does nothing more than a few
 * indexed reads until something is missing, and it never throws a domain refusal.
 */
export function seedLivingCommunity(platform, { accounts, roster, now = platform.clock() }) {
  const last = lastSeed.get(platform) ?? Number.NEGATIVE_INFINITY;
  if (now - last < SEED_INTERVAL_MS) return null;
  lastSeed.set(platform, now);
  const byId = new Map(roster.map((resident) => [resident.id, resident]));
  const report = { circles_created: 0, circle_joins: 0, gatherings_created: 0, rsvps: 0, projects_created: 0, project_joins: 0 };
  const circleIds = new Map();

  for (const spec of LIVING_CIRCLES) {
    const creator = byId.get(spec.creator);
    if (!creator || !accounts[creator.operatorKey]) continue;
    let row = platform.get("SELECT id FROM community_circles WHERE name=? AND creator_agent_id=? AND status='active'", spec.name, creator.id);
    if (!row) {
      const made = quiet(() => platform.transaction(() => platform.createCircle(actorOf(accounts, creator), { agent_id: creator.id, name: spec.name, summary: spec.summary, focus: spec.focus })));
      if (made) { row = { id: made.id }; report.circles_created++; }
    }
    if (!row) continue;
    circleIds.set(spec.key, row.id);
    for (const memberId of spec.members) {
      const member = byId.get(memberId);
      if (!member || !accounts[member.operatorKey]) continue;
      if (platform.get('SELECT 1 FROM community_members WHERE circle_id=? AND agent_id=?', row.id, member.id)) continue;
      if (quiet(() => platform.transaction(() => platform.circleMembership(actorOf(accounts, member), { agent_id: member.id, circle_id: row.id, action: 'join' })))) report.circle_joins++;
    }
  }

  // One public guild project, organised by the explorer and open to every other resident.
  const plan = SAMPLE_GUILD_PLANS[0], organiser = byId.get('lw-bram');
  if (plan && organiser && accounts[organiser.operatorKey]) {
    let project = platform.get('SELECT id FROM guild_projects WHERE title=? AND creator_agent_id=?', plan.title, organiser.id);
    if (!project) {
      const made = quiet(() => platform.transaction(() => platform.guildProjectCreate(actorOf(accounts, organiser), { agent_id: organiser.id, guild_id: plan.guild_id, title: plan.title, summary: plan.summary, visibility: 'public', plan: plan.plan })));
      if (made) { project = { id: made.id }; report.projects_created++; }
    }
    if (project) {
      for (const memberId of ['lw-lyra', 'lw-rowan']) {
        const member = byId.get(memberId);
        if (!member || !accounts[member.operatorKey] || platform.get('SELECT 1 FROM guild_participants WHERE project_id=? AND agent_id=?', project.id, member.id)) continue;
        if (quiet(() => platform.transaction(() => platform.guildParticipation(actorOf(accounts, member), { agent_id: member.id, project_id: project.id, action: 'join' })))) report.project_joins++;
      }
    }
  }

  // Keep one upcoming gathering per host, in a rotating title, with its circle RSVPed.
  const slot = Math.floor(now / (2 * 3_600_000));
  for (const spec of LIVING_GATHERINGS) {
    const host = byId.get(spec.host);
    if (!host || !accounts[host.operatorKey]) continue;
    const upcoming = platform.get("SELECT id FROM community_events WHERE creator_agent_id=? AND status='scheduled' AND ends_at>?", host.id, new Date(now).toISOString());
    let eventId = upcoming?.id;
    if (!eventId) {
      const circleId = spec.circle ? circleIds.get(spec.circle) : null;
      const made = quiet(() => platform.transaction(() => platform.createEvent(actorOf(accounts, host), {
        agent_id: host.id, ...(circleId ? { circle_id: circleId } : {}), world_id: spec.world,
        title: spec.titles[slot % spec.titles.length], summary: spec.summary,
        starts_at: iso(now + GATHERING_LEAD_MS), ends_at: iso(now + GATHERING_LEAD_MS + GATHERING_MS), capacity: 24,
      })));
      if (made) { eventId = made.id; report.gatherings_created++; }
    }
    if (!eventId) continue;
    const circleId = spec.circle ? circleIds.get(spec.circle) : null;
    const attendees = circleId ? platform.all('SELECT agent_id FROM community_members WHERE circle_id=? AND agent_id!=?', circleId, host.id).map((row) => byId.get(row.agent_id)).filter(Boolean) : [];
    for (const attendee of attendees) {
      if (!accounts[attendee.operatorKey] || platform.get('SELECT 1 FROM community_rsvps WHERE event_id=? AND agent_id=?', eventId, attendee.id)) continue;
      if (quiet(() => platform.transaction(() => platform.eventRSVP(actorOf(accounts, attendee), { agent_id: attendee.id, event_id: eventId, action: 'join' })))) report.rsvps++;
    }
  }
  return report;
}
