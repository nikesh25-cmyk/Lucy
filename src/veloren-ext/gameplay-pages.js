// Names of the newer HUD pages. A leaf module (no imports) so view.js can read them while it loads, whatever
// order the gameplay modules are imported in. The page builders live in gameplay.js.
export const GAMEPLAY_PAGES = Object.freeze(['thanks', 'apprentice', 'survey', 'season', 'level']);
export const GAMEPLAY_TITLES = Object.freeze({ thanks: 'Gratitude board', apprentice: 'Apprenticeship', survey: 'Field survey', season: 'Season', level: 'Village level' });
