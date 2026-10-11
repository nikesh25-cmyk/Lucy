// Fictional civic geography. These mayor NPCs are visible guides, not account holders
// or autonomous moderators. Human moderators retain all enforcement authority.
const districts = [
  ['highlands','Highlands','Alpine ridges','Asha','Mountain access and watershed care'],
  ['snowline','Snowline','Glacial valleys','Tenzin','Climate adaptation and safe passage'],
  ['foothills','Foothills','Terraced slopes','Mira','Food systems and hillside livelihoods'],
  ['riverlands','Riverlands','River basin','Sora','Water quality and flood resilience'],
  ['wetlands','Wetlands','Marsh and delta','Nadi','Wetland restoration and habitat'],
  ['woodlands','Woodlands','Temperate forest','Ilan','Forest stewardship and biodiversity'],
  ['rainforest','Rainforest','Tropical canopy','Amara','Forest communities and conservation'],
  ['grasslands','Grasslands','Open plains','Kito','Pasture, soil and biodiversity'],
  ['farmlands','Farmlands','Cultivated plain','Leila','Agriculture and market access'],
  ['drylands','Drylands','Arid basin','Samir','Drought resilience and water access'],
  ['desert','Desert','Sand and stone','Zahra','Heat resilience and mobility'],
  ['savanna','Savanna','Seasonal grassland','Ayo','Land use and wildlife corridors'],
  ['coast','Coast','Shoreline','Marin','Coastal livelihoods and erosion'],
  ['islands','Islands','Island chain','Kai','Island resilience and ocean care'],
  ['harbor','Harbor','Port and estuary','Nila','Fair trade and port access'],
  ['cities','Cities','Urban neighborhoods','Rumi','Housing, accessibility and public space'],
  ['workshops','Workshops','Maker settlements','Tala','Skills and decent work'],
  ['gardens','Gardens','Community gardens','Pema','Food growing and community care'],
  ['lakes','Lakes','Freshwater shores','Elio','Freshwater ecosystems and health'],
  ['commons','Commons','Shared civic center','Noor','Dialogue and coordination'],
];

export const REGIONS = Object.freeze(districts.map(([id,name,landscape,mayor,focus], index) => Object.freeze({
  id, name, landscape, mayor: Object.freeze({ id: `mayor-${id}`, name: mayor, title: `Mayor of ${name}`, focus, status: 'dormant', kind: 'npc' }),
  order: index + 1,
})));

export const SDG_GOALS = Object.freeze([
  'No Poverty','Zero Hunger','Good Health and Well-being','Quality Education','Gender Equality',
  'Clean Water and Sanitation','Affordable and Clean Energy','Decent Work and Economic Growth',
  'Industry, Innovation and Infrastructure','Reduced Inequalities','Sustainable Cities and Communities',
  'Responsible Consumption and Production','Climate Action','Life Below Water','Life on Land',
  'Peace, Justice and Strong Institutions','Partnerships for the Goals',
]);

export const CIVIC_CHARTER = Object.freeze({
  name: 'World Assembly', status: 'proposed', affiliation: 'Independent fictional institution; not part of the United Nations.',
  mandate: 'Coordinate source-based research and reviewed proposals across regions and countries.',
  safeguard: 'Mayors can organize research and flag concerns once activated. Human moderators decide reports, sanctions and appeals.',
  source: 'https://sdgs.un.org/goals',
});

export function civicAtlas() { return { regions: REGIONS, goals: SDG_GOALS, assembly: CIVIC_CHARTER }; }
