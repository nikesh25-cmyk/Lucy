// The in-game command surface: the one section catalogue, the menu built from it, the placement rule
// that opens a section beside or over the world, and the contracts that keep every section from
// replacing the 3D view while a person plays. There is no browser in this runner, so the stylesheet
// and app.js are read as text; the real-Chrome behaviour is the `in-game-command-surface` scenario in
// scripts/browser-suite.mjs and `scripts/command-surface-audit.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SECTIONS, GROUPS, DOCK_MIN_WIDTH, DOCK_WIDTH_MAX, sectionById, sectionLabel, isSection, menuGroups, filterSections, queryTerms, panelMode, dockWidth,
} from '../src/ui/command-deck.js';

const source = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const app = source('app.js');
const css = source('game-panel.css');
const page = source('index.html');
const server = source('server.js');

test('every catalogue row is complete, unique, and says what both a person and an agent do there', () => {
  const ids = SECTIONS.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(SECTIONS.length, 27, 'the 26 sections plus the world itself');
  for (const section of SECTIONS) {
    for (const field of ['id', 'label', 'group', 'icon', 'purpose', 'agent', 'keywords']) assert.ok(section[field], `${section.id} has a ${field}`);
    assert.ok(section.group in GROUPS, `${section.id} is in a known group`);
    assert.ok(section.purpose.endsWith('.') && section.agent.endsWith('.'), `${section.id} writes whole sentences`);
    assert.ok(section.needs === null || ['account', 'reviewer', 'admin'].includes(section.needs), `${section.id} has a known need`);
  }
  assert.equal(Object.isFrozen(SECTIONS) && SECTIONS.every(Object.isFrozen), true);
  assert.equal(sectionById('missions').label, 'Missions');
  assert.equal(sectionById('nope'), null);
  assert.equal(sectionLabel('nope'), 'NemoWorld');
  assert.equal(isSection('coins') && !isSection('nope'), true);
});

test('the catalogue and the panel table in app.js name exactly the same sections', () => {
  const table = app.match(/function sectionViews\(\)\{return \{([^}]+)\};/);
  assert.ok(table, 'app.js has one section table the panel draws from');
  const viewed = [...table[1].matchAll(/(\w+)\s*:\s*render\w+/g)].map((match) => match[1]).sort();
  const catalogued = SECTIONS.map((section) => section.id).filter((id) => id !== 'world').sort();
  assert.deepEqual(viewed, catalogued, 'a section in the table is in the catalogue and the reverse');
});

test('the game menu lists the same sections in the same order as the workspace menu always did', () => {
  const ids = (options) => menuGroups(options).map((group) => ({ title: group.title, ids: group.items.map((item) => item.id) }));
  assert.deepEqual(ids({ account: false, game: true }), [
    { title: 'THE WORLD', ids: ['start', 'world', 'explore', 'list', 'civic', 'countries', 'community', 'callings', 'guilds', 'restoration', 'quests'] },
    { title: 'RESEARCH & CONTRIBUTIONS', ids: ['research', 'missions', 'gallery', 'assembly'] },
    { title: '', ids: ['help'] },
  ]);
  const signedIn = ids({ account: true, game: true });
  assert.deepEqual(signedIn[2], { title: 'YOUR RESIDENTS', ids: ['shop', 'coins', 'passport', 'home', 'workshop', 'characters', 'history'] });
  // Governance stays behind /manage in the game: even an administrator is offered one Management link, not these.
  const everything = menuGroups({ account: true, reviewer: true, admin: true, game: true }).flatMap((group) => group.items.map((item) => item.id));
  for (const hidden of ['review', 'owner', 'safety', 'operations']) assert.equal(everything.includes(hidden), false, `${hidden} is not in the game menu`);
  const workspace = ids({ account: true, reviewer: true, admin: true, game: false }).find((group) => group.title === 'GOVERNANCE');
  assert.deepEqual(workspace.ids, ['review', 'owner', 'safety', 'operations']);
  assert.deepEqual(ids({ account: true, reviewer: false, admin: false, game: false }).find((group) => group.title === 'GOVERNANCE').ids, ['safety']);
});

test('the menu search finds a section by its label, its purpose, an agent verb, or a keyword', () => {
  const items = menuGroups({ account: true, game: true }).flatMap((group) => group.items);
  assert.deepEqual(filterSections(items, ''), items.map((item) => item.id), 'an empty query keeps every section');
  assert.deepEqual(filterSections(items, '   '), items.map((item) => item.id));
  assert.ok(filterSections(items, 'wallet').includes('coins'));
  assert.ok(filterSections(items, 'travel').includes('explore'));
  assert.ok(filterSections(items, 'claim a task').includes('missions'));
  assert.ok(filterSections(items, 'journal').includes('passport'));
  assert.ok(filterSections(items, 'ambassador').includes('civic'));
  assert.deepEqual(filterSections(items, 'zzzz'), []);
  assert.deepEqual(filterSections(items, 'QUEST chains'), ['quests'], 'case does not matter and every word must match');
  assert.deepEqual(queryTerms('Claim, a task!'), ['claim', 'a', 'task']);
});

test('a wide viewport docks the panel beside the world and a narrow one lifts a sheet', () => {
  assert.equal(DOCK_MIN_WIDTH, 1280, 'the dock begins where the HUD stops using its narrow arrangement');
  assert.equal(panelMode(1440), 'dock');
  assert.equal(panelMode(1280), 'dock');
  assert.equal(panelMode(1279), 'sheet');
  assert.equal(panelMode(390), 'sheet');
  assert.equal(panelMode(undefined), 'sheet');
  assert.equal(dockWidth(1280), 461);
  assert.equal(dockWidth(1440), 518);
  assert.equal(dockWidth(2560), DOCK_WIDTH_MAX, 'never wider than a reading column');
  assert.ok(dockWidth(1440, true) > dockWidth(1440) && dockWidth(1440, true) <= 900);
  // The world keeps enough room for the HUD at the smallest dock: 1280 - 461 = 819 px.
  assert.ok(1280 - dockWidth(1280) >= 800);
});

test('app.js: a section opened in the game shell never replaces the world view', () => {
  // The only assignment to state.tab outside the initial object is the one in setTab.
  const assignments = [...app.matchAll(/state\.tab\s*=\s*(?!=)/g)];
  assert.equal(assignments.length, 2, 'state.tab is assigned in setTab only (once for the workspace, once to pin the world)');
  assert.match(app, /function setTab\(tab\)\{\s*if\(!state\.gamePresentation\)\{state\.tab=tab;return;\}\s*state\.tab='world';state\.gamePanel=/);
  // openSection hands the game shell to the panel before it can reach the swapping renderView() path.
  const open = app.slice(app.indexOf('async function openSection'), app.indexOf('async function navigateSection'));
  assert.ok(open.indexOf('openedGamePanel(tab,changed)') > 0 && open.indexOf('openedGamePanel') < open.indexOf('renderView()'), 'the game path returns before renderView');
  assert.match(open, /if\(tab!=='world'&&!state\.gamePresentation\)walkVersion\+\+/, 'opening a panel does not cancel a walk in progress');
  // renderView leaves the 3D scene alone when a panel is the only thing that changed.
  assert.match(app, /if\(gamePanelOpen\(\)&&state\.tab==='world'&&\$\('#view \.world-layout'\)&&worldRenderKey\(\)===renderedWorldKey\)\{applyGameShell\(\);renderGamePanel\(\);return;\}/);
  // The shortcut layer is never suspended by a panel, so the avatar stays controllable.
  const suspended = app.match(/const shellSuspended = \(\) => ([^\n]+)/)[1];
  assert.equal(/gamePanel/.test(suspended), false, 'an open panel does not suspend movement keys');
  // Escape closes the panel, after the menu and the drawers, which are above it.
  assert.match(app, /else if\(state\.gamePanel\)\{event\.preventDefault\(\);closeGamePanel\(\);\}/);
  assert.match(app, /state\.gameDrawer&&state\.gamePanel\)\{state\.gamePanel='';renderGamePanel\(\);\}/, 'a conversation or the tools drawer takes the one right-hand slot');
});

test('index.html hosts one labelled panel and loads its stylesheet between the game and touch layers', () => {
  assert.equal(page.split('id="game-panel"').length - 1, 1);
  assert.match(page, /<aside id="game-panel"[^>]*aria-labelledby="game-panel-title"[^>]*aria-describedby="game-panel-help"[^>]*hidden inert>/);
  for (const id of ['game-panel-title', 'game-panel-help', 'game-panel-body', 'game-panel-world', 'game-panel-menu', 'game-panel-size', 'game-panel-close']) assert.ok(page.includes(`id="${id}"`), `${id} exists`);
  const order = ['/game-theme.css', '/game-panel.css', '/game-mobile.css'].map((href) => page.indexOf(`href="${href}"`));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2], 'the panel refines the game stylesheet and precedes the touch layer');
  assert.equal(page.split('game-panel.css').length - 1, 1);
});

test('the server serves the new module and stylesheet from its fixed file table', () => {
  assert.match(server, /'first-play-guide', 'shop-panel', 'home-panel', 'command-deck']/);
  assert.match(server, /files\.set\('\/game-panel\.css', \['game-panel\.css', 'text\/css; charset=utf-8'\]\)/);
});

test('game-panel.css: scoped to the game shell, breakpoints match the module, motion removed under reduced motion', () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...code.matchAll(/(?:^|[}\n])\s*([^@{}\n][^{}]*)\{/g)].map((match) => match[1].trim()).filter(Boolean);
  for (const selector of selectors.flatMap((list) => list.split(','))) assert.match(selector.trim(), /^body\.game-world/, `${selector.trim()} begins with body.game-world`);
  assert.match(code, new RegExp(`@media\\(min-width:${DOCK_MIN_WIDTH}px\\)`), 'the dock begins where the module says');
  assert.match(code, new RegExp(`@media\\(max-width:${DOCK_MIN_WIDTH - 1}px\\)`), 'the sheet covers everything below it');
  assert.match(code, /game-panel-docked #content\{width:calc\(100% - var\(--game-panel-w\)\)\}/, 'the docked world gives up exactly the panel column');
  assert.match(code, /game-panel-sheet #content\{height:calc\(100% - var\(--game-sheet-h\)\)\}/, 'the sheet world gives up exactly the sheet height');
  assert.equal(/nm-touch/.test(code), false, 'no touch selector is written here');
  // The HUD elements a compact panel stands down are kept as visually hidden live regions, never display:none.
  const compact = code.slice(code.indexOf('.game-panel-compact .world-reticle'), code.indexOf('.game-panel-compact .game-live-count'));
  assert.match(compact, /clip-path:inset\(50%\)/);
  assert.doesNotMatch(compact, /display:none/, 'the aim line, feedback, target and prompt stay readable to assistive technology');
  assert.match(code, /@media\(prefers-reduced-motion:reduce\)\{[^@]*transition:none!important;animation:none!important/);
  assert.equal(/@keyframes|animation:\s*[a-z]/i.test(code.replace(/animation:none!important/g, '')), false, 'no motion is defined at all');
  assert.equal(/!important/.test(code.replace(/\.sidebar \[hidden\]\{display:none!important\}/, '').replace(/margin:0!important/g, '').replace(/none!important/g, '')), false, 'the layer wins by order, not force');
  // 44 px targets for every control the panel adds.
  assert.match(code, /\.game-panel-tool\{min-width:44px;min-height:44px/);
  assert.match(code, /\.game-panel-body button,[^{]*\{min-height:44px\}/);
});
