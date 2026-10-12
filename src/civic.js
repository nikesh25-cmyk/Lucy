// Fictional civic geography. Mayor residents have a separate persistent runtime;
// human moderators retain enforcement authority.
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

// Editorial research lenses; fictional districts do not define country geography or task ownership.
const regionalGoals={highlands:[6,11,13],snowline:[11,13],foothills:[2,8,15],riverlands:[6,11,13],wetlands:[6,14,15],woodlands:[13,15],rainforest:[13,15,16],grasslands:[2,13,15],farmlands:[2,8,12],drylands:[6,13,15],desert:[3,11,13],savanna:[2,15],coast:[8,13,14],islands:[7,13,14],harbor:[8,9,17],cities:[10,11,16],workshops:[4,8,9],gardens:[2,3,11],lakes:[3,6,15],commons:[16,17]};

export const REGIONS = Object.freeze(districts.map(([id,name,landscape,mayor,focus], index) => Object.freeze({
  id, name, landscape, researchGoals:Object.freeze(regionalGoals[id]), researchMapping:'Lucy editorial SDG research lens; not a country boundary, task assignment or UN mandate.', mayor: Object.freeze({ id: `mayor-${id}`, name: mayor, title: `Mayor of ${name}`, focus, status: 'active', kind: 'npc' }),
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
  name: 'World Assembly', status: 'pilot', affiliation: 'Independent fictional institution; not part of the United Nations.',
  mandate: 'Coordinate source-based research and reviewed proposals across regions and countries.',
  safeguard: 'Mayors guide research and provide advisory report triage. Human moderators decide reports, sanctions and appeals.',
  source: 'https://sdgs.un.org/goals',
});

export function civicAtlas() { return { regions: REGIONS, goals: SDG_GOALS, assembly: CIVIC_CHARTER }; }

// Choose relevant public context before model generation. Moderation takes priority.
export function mayorTopic(question){
 if(/report|abuse|harass|moder|unsafe|spam|\bban(?:ned)?\b|suspend|sanction|appeal|quarantine|\bblock\b/i.test(question))return 'moderation';
 if(/tea|export|agric|farm|buyer|trade/i.test(question))return 'agriculture';
 if(/united nations|\bun\b|assembly|committee/i.test(question))return 'assembly';
 if(/task|work|research|help|goal/i.test(question))return 'research';
 return 'region';
}
