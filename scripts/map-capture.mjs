#!/usr/bin/env node
// Real-browser demonstration of walking across a former world boundary on the global map.
//
// It drives a *running* dev server on its own port against a throw-away database (the same rules as
// scripts/visual-capture.mjs): it signs a disposable operator in through the real dialog, stands the
// resident on the Commons just south of the Highlands seam, and presses the arrow key until the resident
// is well inside Highlands. Before every key press it reads the stored position straight from the
// database, so the log shows the authoritative (world_id, x, y) crossing from one world to the other
// with no portal, while the screenshots show the renderer, the minimap and the 2D view across the join.
//
//   LUCY_DATABASE=$(mktemp -d)/world.sqlite PORT=3110 node server.js
//   node scripts/map-capture.mjs --url http://127.0.0.1:3110 --database <that file> --out docs/handoff/global-map-phase-1
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argument = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const base = argument('url', 'http://127.0.0.1:3110'), databasePath = argument('database');
const outDir = resolve(argument('out', join(ROOT, 'docs', 'handoff', 'global-map-phase-1')));
if (!databasePath) throw new Error('--database <path to the disposable sqlite file> is required');
if (/outputs\/Lucy|\/data\/world\.sqlite$/.test(resolve(databasePath))) throw new Error('refusing to open an installed or shipped database');
mkdirSync(outDir, { recursive: true });
const EMAIL = 'map@capture.test', PASSWORD = 'map-capture-password-2026', origin = new URL(base).origin;

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'X-API-Client': 'operator', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json, raw: text };
}
const database = () => new DatabaseSync(resolve(databasePath));
// The server holds the file open too, so a read or write retries while it is busy.
const withDb = (action) => {
  for (let attempt = 0; ; attempt++) {
    const db = database();
    try { db.exec('PRAGMA busy_timeout=2000'); return action(db); } catch (error) { if (attempt >= 8 || !/locked|busy/i.test(error.message)) throw error; } finally { db.close(); }
  }
};
let session = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
if (session.status !== 200) session = await api('/auth/register', { method: 'POST', body: { name: 'Map capture', email: EMAIL, password: PASSWORD, consent: true } });
if (![200, 201].includes(session.status)) throw new Error(`could not create the capture operator: ${session.status} ${session.raw}`);
const find = (name) => withDb((db) => db.prepare('SELECT id FROM agents WHERE name=? ORDER BY rowid LIMIT 1').get(name));
if (!find('Map walker')) await api('/agents', { method: 'POST', token: session.body.token, body: { kind: 'human', name: 'Map walker', color: '#3d5875', symbol: '◆', capabilities: 'Capture fixture', limitations: 'None' } });
if (!find('Highlands neighbour')) await api('/agents', { method: 'POST', token: session.body.token, body: { kind: 'agent', name: 'Highlands neighbour', color: '#397f79', symbol: '✦', capabilities: 'Capture fixture', limitations: 'None' } });
const walker = find('Map walker'), neighbour = find('Highlands neighbour');
const stored = () => withDb((db) => ({ ...db.prepare('SELECT world_id,x,y FROM agents WHERE id=?').get(walker.id) }));
const place = (id, world, x, y) => withDb((db) => db.prepare('UPDATE agents SET world_id=?,x=?,y=?,z=0,last_move=0 WHERE id=?').run(world, x, y, id));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: process.env.LUCY_BROWSER_CHANNEL || 'chrome', args: ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-first-run'] });
const log = [];

async function run(name, { graphics, viewport, mobile = false, reducedMotion = false }) {
  const context = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await context.addInitScript((value) => { try { localStorage.setItem('nemoworld-graphics', value); } catch { /* storage may be unavailable */ } }, graphics);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  place(walker.id, 'commons', 25, 4); place(neighbour.id, 'district:highlands', 27, 30);
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#auth-dialog').waitFor({ state: 'visible' });
  const form = page.locator('#auth-area section:not([hidden]) form');
  await form.locator('[aria-label="Email"]').fill(EMAIL); await form.locator('[aria-label="Password"]').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: 25000 });
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  const play = page.locator('#hero-actions').getByRole('button', { name: 'Play', exact: true });
  if (await play.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)) await play.click();
  await page.waitForFunction((id) => window.__nemoworld?.selected?.() === id, walker.id, { timeout: 25000 });
  await page.waitForTimeout(2200);
  if (graphics === 'voxel') {
    const camera = page.getByRole('button', { name: 'First person camera that follows your resident' });
    if (await camera.count() && await camera.isVisible() && await camera.getAttribute('aria-pressed') === 'true') { await camera.click(); await page.waitForTimeout(600); }
  }
  const shoot = async (id) => page.screenshot({ path: join(outDir, `${name}-${id}.png`) });
  const frame = () => page.evaluate(() => ({ world: window.__nemoworld.worldId(), mapWindow: Boolean(window.__nemoworld.world()?.map), graphics: document.querySelector('#world')?.dataset.graphics, place: document.querySelector('.world-toolbar strong')?.textContent || '' }));
  await shoot('1-commons-before-the-seam');
  const sequence = [];
  await page.locator('#world').focus();
  for (let step = 0; step < 14; step++) {
    const before = stored();
    // The on-screen arrow and the keyboard take turns, so both paths cross the seam.
    const arrow = page.locator('.movement button', { hasText: '↑' }).first();
    if (step % 2 === 0 && await arrow.isVisible().catch(() => false)) await arrow.click(); else await page.keyboard.press(graphics === 'voxel' ? 'w' : 'ArrowUp');
    await page.waitForTimeout(420);
    const after = stored(), now = await frame();
    sequence.push({ step: step + 1, before, after, client_world: now.world, place: now.place });
    if (after.world_id === 'district:highlands' && !sequence.some((item) => item.shot === 'seam')) { sequence.at(-1).shot = 'seam'; await shoot('2-just-over-the-seam'); }
    if (before.world_id === 'commons' && after.world_id === 'commons' && after.y === 0) {
      await shoot('1b-standing-on-the-edge');
      // Zoomed out, both worlds are in view at once: the road runs straight across the former boundary.
      if (graphics === 'voxel' && !mobile) {
        const box = await page.locator('#world').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let tick = 0; tick < 8; tick++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
        await page.waitForTimeout(500); await shoot('1c-zoomed-out-over-the-join');
        for (let tick = 0; tick < 8; tick++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
        await page.waitForTimeout(300);
      }
    }
  }
  await page.waitForTimeout(500);
  await shoot('3-inside-highlands');
  const final = await frame();
  const crossings = sequence.filter((item) => item.before.world_id !== item.after.world_id);
  log.push({ run: name, graphics, viewport, reducedMotion, final, sequence, crossings: crossings.length, errors });
  console.log(`${name}: ${sequence.map((item) => `${item.after.world_id}:${item.after.x},${item.after.y}`).join(' -> ')}`);
  console.log(`${name}: crossings=${crossings.length} final client world=${final.world} map window=${final.mapWindow} errors=${errors.length}`);
  await context.close();
}

await run('desktop-3d', { graphics: 'voxel', viewport: { width: 1440, height: 900 } });
await run('desktop-2d', { graphics: 'pixel', viewport: { width: 1440, height: 900 } });
await run('desktop-3d-reduced-motion', { graphics: 'voxel', viewport: { width: 1440, height: 900 }, reducedMotion: true });
await run('phone-3d', { graphics: 'voxel', viewport: { width: 390, height: 844 }, mobile: true });
writeFileSync(join(outDir, 'crossing-log.json'), JSON.stringify(log, null, 2));
await browser.close();
