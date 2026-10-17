// Player simulation & Sims-style gameplay engine for NemoWorld Veloren.
//
// Unifies:
//   - 5 Peaceful Sims Wellbeing Needs: Nourishment, Fellowship, Scholarship, Craft, Comfort (0..100)
//   - 12 Core Missions + 12 Story Missions with step targets & destination world coordinates
//   - Careers & Public Offices (Architecture, Farming, Research, Design, Logistics, Hospitality)
//   - Schooling & University (Curriculum, assessments, classroom waypoints)
//   - Home & Cottage plots
//   - Resident relationships & current live positions across the 60 residents
//   - Interactive Action Queue (Guide waypoints, auto-walk targets, and /tell chat commands)
//
// Read-only queries of stored facts; zero combat, zero weapons, zero debt.

import { missionsFor as coreMissionsFor, loadMissions as loadCoreMissions } from './missions.js';
import { missionsFor as storyMissionsFor, loadMissions as loadStoryMissions } from './story-missions.js';
import { surveyFor } from './expeditions.js';
import { apprenticeTaskLine } from './apprenticeship.js';
import { VILLAGERS } from './villagers.js';
import { activeSlot, loadEvents } from './village.js';
import { loadWorks, worksStatus, loadRecord } from './world-life.js';

export const WORLD_LANDMARKS = Object.freeze({
  'lyra-house': { name: "Library & Records", x: 15225, y: 16007, category: 'scholarship', blurb: 'Quiet study tables, historical chronicles and village archives.' },
  'lyra-field': { name: "Peace Pavilion", x: 15231, y: 16025, category: 'fellowship', blurb: 'Open-air gathering pavilion for community reflection.' },
  'lyra-plaza': { name: "Meeting Hall & Square", x: 15213, y: 15977, category: 'fellowship', blurb: 'The heart of Harr where residents gather and exchange ideas.' },
  'harr-workshop': { name: "Craft Workshop", x: 15207, y: 15995, category: 'craft', blurb: 'Woodworking benches, masonry tools and architectural blueprints.' },
  'harr-orchard': { name: "Community Orchard", x: 15225, y: 15983, category: 'nourishment', blurb: 'Fresh fruit trees and shaded walking avenues.' },
  'site-well': { name: "Central Fountain & Well", x: 15203, y: 15971, category: 'comfort', blurb: 'Clear spring water and carved stone seating.' },
  'site-market-hall': { name: "Village Pantry & Market", x: 15228, y: 15967, category: 'nourishment', blurb: 'Shelves of fresh bread, root vegetables and dried berries.' },
  'site-cottage-row': { name: "Cottage Living Row", x: 15191, y: 15987, category: 'comfort', blurb: 'Peaceful residential homes with garden plots.' },
  'site-observatory': { name: "Astronomy Observatory", x: 15213, y: 15963, category: 'scholarship', blurb: 'Brass stargazing telescopes and celestial charts.' },
  'site-pavilion': { name: "Botanical Pavilion", x: 15249, y: 16028, category: 'fellowship', blurb: 'Flowering greenhouse dedicated to cooperative botany.' },
  'city-office': { name: "Civic Career & Research Office", x: 15159, y: 16173, category: 'career', blurb: 'Offices for architecture, ecology, research and logistics.' },
  'city-school': { name: "City Academy & School", x: 15234, y: 16175, category: 'scholarship', blurb: 'Classrooms for youth and lifelong scholars.' },
  'city-farm': { name: "Hydroponics & Civic Farm", x: 15153, y: 15927, category: 'nourishment', blurb: 'Automated irrigation channels and bountiful crop beds.' },
  'city-university': { name: "Polytechnic University", x: 15180, y: 16190, category: 'scholarship', blurb: 'Advanced research laboratories and debate auditoriums.' },
});

export const CAREER_OFFICES = Object.freeze([
  {
    id: 'architecture',
    title: 'Civic Architecture & Urban Planning',
    office: 'city-office',
    duty: 'Inspect foundation integrity, plan public plaza extensions, and draft voxel schematics.',
    coords: { x: 15159, y: 16173 },
    shiftHourStart: 8,
    shiftHourEnd: 16,
  },
  {
    id: 'agriculture',
    title: 'Sustainable Agriculture & Ecology',
    office: 'city-farm',
    duty: 'Tend irrigation pumps, test soil moisture in the hydroponic plots, and distribute seeds.',
    coords: { x: 15153, y: 15927 },
    shiftHourStart: 6,
    shiftHourEnd: 14,
  },
  {
    id: 'research',
    title: 'Innovation & Scientific Inquiry',
    office: 'city-university',
    duty: 'Synthesize field discoveries into public technologies at the university observatory.',
    coords: { x: 15180, y: 16190 },
    shiftHourStart: 10,
    shiftHourEnd: 18,
  },
  {
    id: 'design',
    title: 'Artisan Craft & Material Design',
    office: 'harr-workshop',
    duty: 'Fabricate timber frames, refine stone blocks, and prepare public stage materials.',
    coords: { x: 15207, y: 15995 },
    shiftHourStart: 9,
    shiftHourEnd: 17,
  },
  {
    id: 'logistics',
    title: 'Pantry Logistics & Supply Flow',
    office: 'site-market-hall',
    duty: 'Stock community pantry shelves and ensure equitable distribution for all villagers.',
    coords: { x: 15228, y: 15967 },
    shiftHourStart: 7,
    shiftHourEnd: 15,
  },
  {
    id: 'hospitality',
    title: 'Village Culture & Social Fellowship',
    office: 'lyra-plaza',
    duty: 'Welcome travelers, coordinate festival gatherings, and chronicle oral traditions.',
    coords: { x: 15213, y: 15977 },
    shiftHourStart: 12,
    shiftHourEnd: 20,
  },
]);

export const SCHOOL_CLASSES = Object.freeze([
  {
    subject: 'Harmony in Voxel Architecture',
    place: 'city-school',
    coords: { x: 15234, y: 16175 },
    question: 'How do civic paths facilitate spontaneous cooperation without congestion?',
    hint: 'Generous 6-block wide walkways with continuous visual continuity.',
  },
  {
    subject: 'Ecology & Renewable Cultivation',
    place: 'city-farm',
    coords: { x: 15153, y: 15927 },
    question: 'What is the ecological benefit of companion planting in shared orchards?',
    hint: 'Natural pest deterrence and soil nitrogen replenishment.',
  },
  {
    subject: 'Epistemology & Scientific Method',
    place: 'city-university',
    coords: { x: 15180, y: 16190 },
    question: 'Why must research insights in NemoWorld be published openly to the village?',
    hint: 'So every citizen and builder can build upon shared discoveries without gatekeeping.',
  },
]);

/**
 * Resolves a landmark or resident ID to world (x, y) coordinates.
 */
export function resolveCoords(targetId) {
  if (!targetId) return null;
  if (WORLD_LANDMARKS[targetId]) {
    return { x: WORLD_LANDMARKS[targetId].x, y: WORLD_LANDMARKS[targetId].y };
  }
  // If target is a villager, resolve their primary post or default to plaza
  const villager = VILLAGERS.find((v) => v.id === targetId || v.name.toLowerCase() === targetId.toLowerCase());
  if (villager && villager.place && WORLD_LANDMARKS[villager.place]) {
    return { x: WORLD_LANDMARKS[villager.place].x, y: WORLD_LANDMARKS[villager.place].y };
  }
  return { x: 15213, y: 15977 }; // Central Plaza fallback
}

/**
 * Computes the 5 Sims Wellbeing Needs (0..100) based on player's recorded facts and activity.
 */
export function computeSimsNeeds(link, playerUuid, now = link.clock()) {
  const sql = link.sql;
  const n = (query, ...args) => Number(sql?.get(query, ...args)?.n ?? 0);

  // 1. Nourishment: based on pantry takes and recent delivery
  let lastMealMs = 0;
  let mealsCount = 0;
  try {
    const last = sql?.get("SELECT MAX(created_at) AS t, COUNT(*) AS n FROM pantry_takes WHERE player_uuid=?", playerUuid);
    lastMealMs = Number(last?.t ?? 0);
    mealsCount = Number(last?.n ?? 0);
  } catch { /* guest */ }

  const hoursSinceMeal = lastMealMs > 0 ? (now - lastMealMs) / 3_600_000 : 4;
  const nourishment = Math.max(25, Math.min(100, Math.round(100 - hoursSinceMeal * 4 + mealsCount * 10)));

  // 2. Fellowship: based on residents met and events attended
  let residentsMet = 0;
  let togetherVisits = 0;
  try {
    residentsMet = n("SELECT COUNT(DISTINCT resident_id) AS n FROM link_events WHERE kind='resident.met' AND player_uuid=?", playerUuid);
    togetherVisits = n("SELECT COUNT(DISTINCT landmark_id) AS n FROM link_events WHERE kind='landmark.together' AND player_uuid=?", playerUuid);
  } catch { /* guest */ }
  const fellowship = Math.max(30, Math.min(100, 35 + residentsMet * 3 + togetherVisits * 5));

  // 3. Scholarship: based on library finds and research contributions
  let libraryFinds = 0;
  try {
    libraryFinds = n("SELECT COUNT(DISTINCT landmark_id) AS n FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%' AND player_uuid=?", playerUuid);
  } catch { /* guest */ }
  const scholarship = Math.max(20, Math.min(100, 25 + libraryFinds * 8));

  // 4. Craft: based on public works helped
  let helps = 0;
  try {
    helps = n("SELECT COUNT(*) AS n FROM link_events WHERE kind='project.helped' AND player_uuid=?", playerUuid);
  } catch { /* guest */ }
  const craft = Math.max(25, Math.min(100, 30 + helps * 10));

  // 5. Comfort: based on home cottage ownership or visiting plaza
  let hasHome = false;
  try {
    hasHome = Boolean(sql?.get("SELECT 1 FROM home_assignments WHERE player_uuid=? LIMIT 1", playerUuid));
  } catch { /* guest */ }
  const comfort = hasHome ? 95 : 65;

  const statusOf = (val) => {
    if (val >= 80) return 'Satisfied';
    if (val >= 60) return 'Content';
    if (val >= 40) return 'Seeking Attention';
    return 'Urgent Need';
  };

  return {
    nourishment: { value: nourishment, max: 100, status: statusOf(nourishment), label: 'Nourishment', hint: 'Visit the pantry or community farm to take a meal.' },
    fellowship: { value: fellowship, max: 100, status: statusOf(fellowship), label: 'Fellowship', hint: 'Greet villagers or attend the evening festival.' },
    scholarship: { value: scholarship, max: 100, status: statusOf(scholarship), label: 'Scholarship', hint: 'Discover new landmarks or attend a school lecture.' },
    craft: { value: craft, max: 100, status: statusOf(craft), label: 'Craft & Work', hint: 'Help complete a public works stage at the workshop.' },
    comfort: { value: comfort, max: 100, status: statusOf(comfort), label: 'Comfort & Rest', hint: hasHome ? 'Rest inside your cottage.' : 'Choose and claim a cottage plot with Rowan.' },
  };
}

/**
 * Builds the player-aware Sims and Gameplay state.
 */
export function buildPlayerSim(link, playerIdentifier = 'anonymous', now = link.clock()) {
  const sql = link.sql;
  let playerUuid = '00000000-0000-0000-0000-000000000000';
  let alias = playerIdentifier;

  // Try finding link
  try {
    const linkRow = sql?.get('SELECT player_uuid, alias FROM ident_links WHERE player_uuid=? OR alias=? LIMIT 1', playerIdentifier, playerIdentifier);
    if (linkRow) {
      playerUuid = linkRow.player_uuid;
      alias = linkRow.alias || playerIdentifier;
    }
  } catch { /* fallback to guest */ }

  const needs = computeSimsNeeds(link, playerUuid, now);

  // Load Missions (Core and Story)
  let core = [];
  try { core = coreMissionsFor(link, playerUuid); } catch { core = []; }

  let stories = [];
  try { stories = storyMissionsFor(link, playerUuid, now); } catch { stories = []; }

  // Assign Career based on deterministic hash of player alias or default to Architecture
  let hashVal = 0;
  for (let i = 0; i < alias.length; i++) hashVal = (hashVal * 31 + alias.charCodeAt(i)) >>> 0;
  const career = CAREER_OFFICES[hashVal % CAREER_OFFICES.length];

  const currentHour = new Date(now).getHours();
  const onShift = currentHour >= career.shiftHourStart && currentHour < career.shiftHourEnd;

  // School Curriculum
  const activeClass = SCHOOL_CLASSES[Math.floor(now / (86_400_000)) % SCHOOL_CLASSES.length];

  // Home Plot
  let homePlot = null;
  try {
    const assigned = sql?.get('SELECT plot_id, style FROM home_assignments WHERE player_uuid=? LIMIT 1', playerUuid);
    if (assigned) {
      homePlot = { assigned: true, plotId: assigned.plot_id, style: assigned.style, coords: { x: 15191, y: 15987 } };
    }
  } catch { /* guest */ }
  if (!homePlot) {
    homePlot = { assigned: false, plotId: 'cottage-1', style: 'classic', coords: { x: 15191, y: 15987 } };
  }

  // Active Works
  let works = [];
  try {
    works = worksStatus(loadWorks(), loadRecord(process.env.NEMO_WORLD_RECORD), now);
  } catch { works = []; }
  const activeWork = works.find((w) => !w.complete && w.next) || works[0] || null;

  // Daily Survey
  let survey = null;
  try { survey = surveyFor(link, playerUuid, now); } catch { survey = null; }

  // Apprenticeship
  let apprenticeLine = '';
  try { apprenticeLine = apprenticeTaskLine(link, playerUuid); } catch { apprenticeLine = ''; }

  // Interactive Action Queue (Top playable actions with world coordinates and chat commands)
  const actions = [];

  // 1. Mission Action
  const nextCore = core.find((m) => !m.done);
  if (nextCore) {
    const targetPlace = nextCore.steps?.find((s) => s.progress < s.count)?.prefix || 'lyra-plaza';
    const coords = resolveCoords(targetPlace) || { x: 15213, y: 15977 };
    actions.push({
      id: 'action-mission',
      title: `Mission: ${nextCore.title}`,
      description: nextCore.purpose,
      coords,
      buttonLabel: 'Guide to Mission',
      autoWalkLabel: 'Auto-Walk to Mission',
      chatCommand: `/tell Selene start`,
      category: 'Mission',
    });
  }

  // 2. Career Action
  actions.push({
    id: 'action-career',
    title: `Career: ${career.title}`,
    description: onShift ? `Shift Active: ${career.duty}` : `Next shift starts at ${career.shiftHourStart}:00. Duty: ${career.duty}`,
    coords: career.coords,
    buttonLabel: onShift ? 'Report to Shift' : 'Visit Workplace',
    autoWalkLabel: 'Auto-Walk to Office',
    chatCommand: `/tell Rowan shift`,
    category: 'Career',
  });

  // 3. School / Scholarship Action
  actions.push({
    id: 'action-school',
    title: `School: ${activeClass.subject}`,
    description: `Lecture & Discussion: ${activeClass.question}`,
    coords: activeClass.coords,
    buttonLabel: 'Attend Class',
    autoWalkLabel: 'Auto-Walk to Class',
    chatCommand: `/tell Selene library`,
    category: 'Scholarship',
  });

  // 4. Nourishment / Pantry Action
  actions.push({
    id: 'action-pantry',
    title: 'Village Pantry: Take Meal',
    description: 'Fresh warm bread, garden soup and berries at the pantry shelf.',
    coords: { x: 15228, y: 15967 },
    buttonLabel: 'Visit Pantry',
    autoWalkLabel: 'Auto-Walk to Pantry',
    chatCommand: `/tell Selene pantry`,
    category: 'Nourishment',
  });

  // 5. Public Work Action
  if (activeWork && activeWork.next) {
    actions.push({
      id: 'action-work',
      title: `Public Work: ${activeWork.name}`,
      description: `Next stage: ${activeWork.next.title}. ${activeWork.next.waiting || 'Lend a hand with building.'}`,
      coords: { x: 15207, y: 15995 },
      buttonLabel: 'Help Build',
      autoWalkLabel: 'Auto-Walk to Stage',
      chatCommand: `/tell Rowan works`,
      category: 'Craft',
    });
  }

  // 6. Home / Rest Action
  actions.push({
    id: 'action-home',
    title: homePlot.assigned ? `My Cottage (${homePlot.plotId})` : 'Choose a Cottage Plot',
    description: homePlot.assigned ? 'Your cozy residence in Harr. Rest and restore comfort.' : 'Choose and build a cottage with Rowan in Cottage Row.',
    coords: homePlot.coords,
    buttonLabel: homePlot.assigned ? 'Walk Home' : 'Claim Plot',
    autoWalkLabel: 'Auto-Walk Home',
    chatCommand: homePlot.assigned ? `/tell Rowan my plot` : `/tell Rowan preview cottage-1`,
    category: 'Comfort',
  });

  return {
    player: {
      alias,
      uuid: playerUuid,
      isLinked: playerUuid !== '00000000-0000-0000-0000-000000000000',
    },
    simsNeeds: needs,
    career: {
      ...career,
      onShift,
      currentHour,
    },
    school: {
      ...activeClass,
    },
    home: homePlot,
    missions: {
      core: core.slice(0, 8),
      stories: stories.slice(0, 6),
      survey: survey ? { title: survey.sheet?.template?.title, done: survey.done, count: survey.count, need: survey.need } : null,
      apprentice: apprenticeLine,
    },
    actions,
    landmarks: WORLD_LANDMARKS,
  };
}
