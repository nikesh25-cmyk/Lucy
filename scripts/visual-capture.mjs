#!/usr/bin/env node
// Visual capture for the 3D renderer and the HUD, taken in the real system Chrome.
//
// It drives a *running* dev server (never the installed copy): register a disposable operator over the
// documented API, sign in through the real dialog, press Play, and photograph the world at the desktop
// and 390 px mobile viewports in each day phase and in an interior. The server must be started on its
// own port against a throw-away database, for example:
//
//   LUCY_DATABASE=$(mktemp -d)/world.sqlite PORT=3100 node server.js
//   node scripts/visual-capture.mjs --label after --url http://127.0.0.1:3100 --database <that file>
//
// Output: <out>/<label>-<viewport>-<shot>.jpg (default docs/handoff/visual-slice-2/; JPEG at quality 80). It refuses any
// database path that is not an explicit argument, and never opens one the caller did not name.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argument = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const label = argument('label', 'shot'), base = argument('url', 'http://127.0.0.1:3100'), databasePath = argument('database');
const outDir = resolve(argument('out', join(ROOT, 'docs', 'handoff', 'visual-slice-2')));
const only = argument('only', '') ? argument('only').split(',') : null;
if (!databasePath) throw new Error('--database <path to the disposable sqlite file> is required');
if (/outputs\/Lucy|\/data\/world\.sqlite$/.test(resolve(databasePath))) throw new Error('refusing to open an installed or shipped database');
mkdirSync(outDir, { recursive: true });

const EMAIL = 'visual@capture.test', PASSWORD = 'visual-capture-password-2026';
const origin = new URL(base).origin;
async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'X-API-Client': 'operator', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json, raw: text };
}
async function fixtures() {
  let session = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  if (session.status !== 200) session = await api('/auth/register', { method: 'POST', body: { name: 'Visual capture', email: EMAIL, password: PASSWORD, consent: true } });
  if (![200, 201].includes(session.status)) throw new Error(`could not create the capture operator: ${session.status} ${session.raw}`);
  const token = session.body.token;
  // The fixtures are looked up by name in the throw-away database, so a second run reuses them.
  const find = (name) => { const db = new DatabaseSync(resolve(databasePath)); try { return db.prepare('SELECT id FROM agents WHERE name=? ORDER BY rowid LIMIT 1').get(name) || null; } finally { db.close(); } };
  const make = async (body) => find(body.name) || (await api('/agents', { method: 'POST', token, body: { color: '#397f79', symbol: '✦', capabilities: 'Visual capture fixture', limitations: 'No external tools', ...body } }), find(body.name));
  const player = await make({ kind: 'human', name: 'Browser player', color: '#3d5875', symbol: '◆' });
  const pathfinder = await make({ kind: 'agent', name: 'Pathfinder' });
  return { token, player, pathfinder };
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: process.env.LUCY_BROWSER_CHANNEL || 'chrome', args: ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-first-run'] });
const fixture = await fixtures();
const place = (world, x, y, extra = {}) => { const db = new DatabaseSync(resolve(databasePath)); try { db.prepare('UPDATE agents SET world_id=?, x=?, y=?, z=0, yaw=?, pitch=?, last_look=? WHERE id=?').run(world, x, y, extra.look?.[0] ?? Math.PI / 4, extra.look?.[1] ?? .62, extra.look ? 1 : 0, extra.id || fixture.player.id); } finally { db.close(); } };

place('commons', 10, 6); // a previous run may have left the player somewhere unusable


// The HUD report: every outermost positioned, visible panel over the scene, which pairs of them
// overlap, and how much of the scene area (the viewport below the masthead) they cover together.
const hudReport = () => {
  const skip = (node) => node.closest('.masthead, .sidebar, .world-aside, .voxel-nameplates, .welcome, dialog, #auth-dialog') || node.tagName === 'CANVAS';
  const nodes = [...document.querySelectorAll('body.game-world *')].filter((node) => {
    if (skip(node) || node.matches('.skip, .skip-link, .world-panel, #view, #content, .workspace-layout, .app-shell, .world-layout')) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const box = node.getBoundingClientRect();
    if (box.width < 12 || box.height < 12 || box.width * box.height > innerWidth * innerHeight * .6 || box.bottom < 0 || box.right < 0 || box.left > innerWidth || box.top > innerHeight) return false;
    const filled = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none', edged = parseFloat(style.borderTopWidth) > 0 && !/rgba\(\d+, \d+, \d+, 0\)/.test(style.borderTopColor);
    return filled || edged;
  });
  const outer = nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
  // A box inside a scrolling or clipping ancestor only occupies the part of itself that ancestor shows.
  const visible = (node) => {
    let box = node.getBoundingClientRect(), left = box.left, top = box.top, right = box.right, bottom = box.bottom;
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = parent.getBoundingClientRect(); left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
    }
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const rects = outer.map((node) => { const box = visible(node); return { name: node.id ? `#${node.id}` : `${node.tagName.toLowerCase()}.${[...node.classList].slice(0, 2).join('.')}`, x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) }; }).filter((r) => r.w > 3 && r.h > 3);
  const overlaps = [];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j], w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w > 3 && h > 3) overlaps.push(`${a.name} x ${b.name} (${w}x${h})`);
  }
  const top = document.querySelector('.masthead')?.getBoundingClientRect().bottom || 0, W = innerWidth, H = innerHeight, step = 6, seen = new Set();
  for (const r of rects) for (let x = Math.floor(r.x / step); x * step < r.x + r.w; x++) for (let y = Math.floor(Math.max(r.y, top) / step); y * step < r.y + r.h; y++) if (x >= 0 && y >= 0 && x * step < W && y * step < H) seen.add(x * 10000 + y);
  const coverage = seen.size * step * step / (W * Math.max(1, H - top));
  return { panels: rects.length, overlaps, coverage: Number(coverage.toFixed(3)), rects };
};

const VIEWPORTS = { desktop: { viewport: { width: 1440, height: 900 } }, mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
const SHOTS = [
  { id: 'commons-day', world: 'commons', at: [10, 6], phase: 'day' },
  { id: 'commons-night', world: 'commons', at: [10, 6], phase: 'night' },
  { id: 'commons-night-orbit', world: 'commons', at: [10, 6], phase: 'night', orbit: true },
  { id: 'plaza-night', world: 'commons', at: [27, 12], phase: 'night' },
  { id: 'plaza-night-orbit', world: 'commons', at: [27, 12], phase: 'night', orbit: true },
  { id: 'plaza-day-orbit', world: 'commons', at: [27, 12], phase: 'day', orbit: true },
  { id: 'lamp-night-orbit', world: 'commons', at: [40, 24], phase: 'night', orbit: true, zoom: 4 },
  { id: 'lamp-day-orbit', world: 'commons', at: [40, 24], phase: 'day', orbit: true, zoom: 4 },
  { id: 'hall-interior', world: 'hall', at: [10, 11], phase: 'day', orbit: true },
  { id: 'hall-interior-night', world: 'hall', at: [10, 8], phase: 'night' },
  { id: 'library-interior', world: 'library', at: [14, 17], phase: 'day', orbit: true },
  { id: 'workshop-interior', world: 'workshop', at: [14, 17], phase: 'day', orbit: true },
  { id: 'observatory-interior', world: 'observatory', at: [16, 20], phase: 'night', orbit: true },
  { id: 'cottage-interior-night', world: 'house', at: [10, 9], phase: 'night' },
  { id: 'cottage-interior', world: 'house', at: [10, 9], phase: 'day', orbit: true },
  { id: 'water-day-orbit', world: 'commons', at: [6, 8], phase: 'day', orbit: true, look: [Math.PI / 2, .5] },
  { id: 'water-b', world: 'commons', at: [6, 8], phase: 'day', orbit: true, look: [-Math.PI / 2, .5] },
  { id: 'water-c', world: 'commons', at: [6, 8], phase: 'day', orbit: true, look: [Math.PI, .5] },
  { id: 'water-dusk-orbit', world: 'commons', at: [6, 8], phase: 'dusk', orbit: true, look: [Math.PI / 2, .5] },
  { id: 'rain-day-orbit', world: 'commons', at: [27, 12], phase: 'day', orbit: true, weather: 'rain' },
  { id: 'mist-dawn-orbit', world: 'commons', at: [10, 6], phase: 'dawn', orbit: true, weather: 'mist' },
  { id: 'houses-day-orbit', world: 'commons', at: [12, 10], phase: 'day', orbit: true, zoom: 2 },
  { id: 'district-coast-orbit', world: 'district:coast', at: [24, 25], look: [Math.PI * .9, .5], phase: 'day', orbit: true },
  { id: 'district-highlands-orbit', world: 'district:highlands', at: [24, 25], look: [Math.PI * .9, .5], phase: 'day', orbit: true },
  { id: 'district-cities-orbit', world: 'district:cities', at: [24, 25], look: [Math.PI * .9, .5], phase: 'day', orbit: true },
  { id: 'district-drylands-orbit', world: 'district:drylands', at: [24, 25], look: [Math.PI * .9, .5], phase: 'day', orbit: true },
  { id: 'district-wetlands-orbit', world: 'district:wetlands', at: [24, 25], look: [Math.PI * .9, .5], phase: 'dusk', orbit: true },
  { id: 'district-gardens-orbit', world: 'district:gardens', at: [24, 25], look: [Math.PI * .9, .5], phase: 'day', orbit: true },
  { id: 'district-woodlands', world: 'district:woodlands', at: [24, 24], phase: 'day' },
];

for (const [name, options] of Object.entries(VIEWPORTS)) {
  const context = await browser.newContext(options), page = await context.newPage();
  let forcedPhase = 'day', forcedWeather = null;
  // The world payload carries the atmosphere; forcing its phase makes a shot independent of the clock.
  await page.route('**/api/v1/**', async (route) => {
    // A live event stream never ends, so it is passed through untouched.
    if (/event-stream/.test(route.request().headers().accept || '') || /\/(events|stream)/.test(route.request().url())) return route.continue();
    const response = await route.fetch(); let text = await response.text();
    try { const json = JSON.parse(text); if (json && typeof json === 'object' && json.atmosphere?.phase) { json.atmosphere = { ...json.atmosphere, phase: forcedPhase, label: forcedPhase, ...(forcedWeather ? { weather: forcedWeather } : {}) }; text = JSON.stringify(json); } } catch { /* not JSON */ }
    await route.fulfill({ response, body: text });
  });
  page.on('pageerror', (error) => console.log(`[${name}] pageerror ${error.message}`));
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#auth-dialog').waitFor({ state: 'visible' });
  const form = page.locator('#auth-area section:not([hidden]) form');
  await form.locator('[aria-label="Email"]').fill(EMAIL); await form.locator('[aria-label="Password"]').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: 25000 });
  for (const shot of SHOTS) {
    if (only && !only.includes(shot.id)) continue;
    forcedPhase = shot.phase; forcedWeather = shot.weather || null; place(shot.world === 'house' ? `house:${fixture.player.id}` : shot.world, shot.at[0], shot.at[1], { look: shot.look });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const play = page.locator('#hero-actions').getByRole('button', { name: 'Play', exact: true });
    if (await play.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)) await play.click();
    await page.waitForFunction((id) => window.__nemoworld?.selected?.() === id, fixture.player.id, { timeout: 25000 });
    await page.waitForTimeout(1800);
    // Play enters first person; an orbit shot switches the pressed camera toggle off.
    const camera = page.getByRole('button', { name: 'First person camera that follows your resident' });
    const firstPerson = async () => (await camera.count() && await camera.isVisible()) ? await camera.getAttribute('aria-pressed') === 'true' : /First person/.test(await page.locator('#world-reticle').textContent());
    if (await firstPerson() !== !shot.orbit) {
      // The toggle is a desktop control; a phone switches view with the V key the HUD hint names.
      if (await camera.count() && await camera.isVisible()) await camera.click(); else { await page.locator('#world').focus(); await page.keyboard.press('v'); }
      await page.waitForTimeout(700);
    }
    // A zoom shot turns the wheel over the canvas, which is exactly what a visitor does to come closer.
    if (shot.zoom) { const box = await page.locator('#world').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); for (let tick = 0; tick < shot.zoom; tick++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(80); } await page.waitForTimeout(500); }
    const state = await page.evaluate(() => ({ world: window.__nemoworld?.worldId?.(), graphics: document.querySelector('#world')?.dataset.graphics }));
    await page.screenshot({ path: join(outDir, `${label}-${name}-${shot.id}.jpg`), type: 'jpeg', quality: 80 });
    if (process.env.DUMP_SELECTOR) console.log(await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.outerHTML).join('\n'), process.env.DUMP_SELECTOR));
    const hud = await page.evaluate(`(${hudReport})()`);
    console.log(`${name} ${shot.id} -> ${state.world} (${state.graphics}) hud: ${hud.panels} panels, ${hud.overlaps.length} overlaps, ${(hud.coverage * 100).toFixed(0)}% of the scene covered`);
    if (process.env.HUD_DETAIL) { for (const overlap of hud.overlaps) console.log(`    overlap ${overlap}`); for (const r of hud.rects) console.log(`    ${r.name} ${r.x},${r.y} ${r.w}x${r.h}`); }
  }
  await context.close();
}
await browser.close();
