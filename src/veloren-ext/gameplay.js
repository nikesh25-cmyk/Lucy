// The five newer gameplay systems behind one small door, so view.js, tasks.js and overview.js each need one import:
//   gratitude (thanks board), apprenticeship (mentor chains), expeditions (daily field surveys),
//   seasons (the slow calendar) and growth (village level). See docs/GAMEPLAY_NEW.md.
// Everything here is a reader of stored facts; none of it grants coins, Karma or items.
import { gratitudeLines, wallEntries, GRATITUDE_POLICY } from './gratitude.js';
import { apprenticeLines, apprenticeTaskLine, apprenticeshipCensus } from './apprenticeship.js';
import { surveyFor, surveyLines, villageSurvey } from './expeditions.js';
import { libraryNote, seasonAt, seasonLines, seasonalBlurb } from './seasons.js';
import { GAMEPLAY_PAGES, GAMEPLAY_TITLES } from './gameplay-pages.js';
import { levelLines, villageLevel, withLevel } from './growth.js';

export { GAMEPLAY_PAGES, GAMEPLAY_TITLES };

export function gameplayPageLines(name, link, player_uuid, clean = (s) => s) {
  const now = link.clock();
  if (name === 'thanks') return gratitudeLines(link, player_uuid, now, clean);
  if (name === 'apprentice') return apprenticeLines(link, player_uuid, now);
  if (name === 'survey') return surveyLines(link, player_uuid, now);
  if (name === 'season') return seasonLines(now);
  if (name === 'level') return levelLines(link);
  throw Object.assign(new Error('Unknown page.'), { status: 404 });
}

/** Extra lines for the tasks page: one for the apprenticeship, one for today's survey. Never throws. */
export function gameplayTaskLines(link, player_uuid) {
  const out = [];
  try { out.push(apprenticeTaskLine(link, player_uuid)); } catch { /* optional */ }
  try {
    const s = surveyFor(link, player_uuid);
    out.push(s.done ? `Field survey: today's survey is done, ${s.count} of ${s.need}. Thank you.`
      : s.closed ? 'Field survey: today\'s sheet has closed at dusk; a new one is posted tomorrow.'
        : `Field survey: ${s.sheet.template.title}, ${s.count} of ${s.need} (whisper survey).`);
  } catch { /* optional */ }
  return out;
}

/** Library page: today's seasonal note, placed before the closing hint. */
export function withSeasonNote(lines, now) {
  const note = libraryNote(now);
  if (!note) return lines;
  const out = [...lines];
  out.splice(Math.max(1, out.length - 1), 0, note);
  return out;
}

/** Additive block for the dashboard overview JSON. Aggregates only: no names, no ids. */
export function gameplayOverview(link, now = link.clock()) {
  const season = seasonAt(now);
  const level = villageLevel(link);
  const survey = villageSurvey(link, now);
  const sheet = surveyFor(link, '00000000-0000-0000-0000-000000000000', now).sheet;
  return {
    season: { id: season.id, name: season.name, line: season.line, day: season.day, length: season.length, next: season.next.name, pantry_rates: season.rates },
    village_level: { level: level.level, of: level.of, name: level.name, text: level.text, facts: level.facts, next: level.next },
    survey: {
      day: sheet.day, title: sheet.template.title, need: sheet.need, closes_at_hour: new Date(sheet.dusk_at).getHours(),
      places: sheet.places.map((p) => ({ name: p.name, hint: p.hint })), village: survey,
    },
    gratitude: { wall: wallEntries(link, now, () => 'a visitor').map((e) => ({ at: e.at, source: e.source, text: e.text })), shown: GRATITUDE_POLICY.wall_size, days: GRATITUDE_POLICY.wall_days },
    apprenticeship: apprenticeshipCensus(link, now),
  };
}

export { seasonalBlurb, withLevel };
