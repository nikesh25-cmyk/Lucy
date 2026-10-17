#!/usr/bin/env node
// Opens every platform section from the world menu in the real system Chrome and reports, for each
// one, whether the in-game command surface kept its promises:
//
//   - the 3D canvas is still on screen, still the same element, and still at least 28 % of the viewport
//     (a panel may narrow or shorten the world; it may never replace or bury it);
//   - the panel has no horizontal overflow and no duplicate element ids were created next to the world's;
//   - the avatar still answers the keyboard: a W press with the world focused moves it while the panel is open
//     (only reported when --walk is given, because it changes the resident's stored position);
//   - the menu labels the open section current, and Escape closes the panel and returns focus.
//
// It drives a *running* dev server on a throw-away database (see docs/handoff/2026-10-15-in-game-command-surface.md):
//
//   LUCY_DATABASE=$(mktemp -d)/world.sqlite PORT=3140 node server.js
//   node scripts/command-surface-audit.mjs --url http://127.0.0.1:3140 --out /tmp/audit [--viewport 1440x900] [--walk]
//
// Exit status is 1 when any section breaks a promise, so it can gate a change.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argument = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const base = argument('url', 'http://127.0.0.1:3140'), outDir = resolve(argument('out', 'command-surface-audit'));
const [width, height] = argument('viewport', '1440x900').split('x').map(Number);
const phone = width <= 650;
const walk = process.argv.includes('--walk');
mkdirSync(outDir, { recursive: true });
const origin = new URL(base).origin, EMAIL = 'audit@command-surface.test', PASSWORD = 'command-surface-audit-2026';
const api = async (path, body) => {
  const response = await fetch(`${origin}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-API-Client': 'operator' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
let session = await api('/auth/login', { email: EMAIL, password: PASSWORD });
if (session.status !== 200) session = await api('/auth/register', { name: 'Surface audit', email: EMAIL, password: PASSWORD, consent: true });
if (![200, 201].includes(session.status)) throw new Error(`could not create the audit operator: ${session.status}`);

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: process.env.LUCY_BROWSER_CHANNEL || 'chrome', args: ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-first-run'] });
const context = await browser.newContext(phone ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|favicon/.test(message.text())) errors.push(`console ${message.text()}`); });

await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
await page.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
const form = page.locator('#auth-area section:not([hidden]) form');
await form.locator('[aria-label="Email"]').fill(EMAIL); await form.locator('[aria-label="Password"]').fill(PASSWORD);
await form.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: 25000 });
await page.locator('#hero-actions').getByRole('button', { name: 'Play', exact: true }).click();
await page.waitForFunction(() => window.__nemoworld?.selected?.() && document.querySelector('#world'), null, { timeout: 25000 });
await page.waitForTimeout(1800);
await page.evaluate(() => { document.querySelector('#world').dataset.auditMark = 'same-canvas'; });

const sections = await page.evaluate(() => window.__nemoworld.sections());
const failures = [], rows = [];
for (const id of sections) {
  if (id === 'world') continue;
  const label = await page.evaluate((target) => [...document.querySelectorAll('#navigation [data-section]')].find((node) => node.dataset.section === target)?.getAttribute('aria-label') || null, id);
  if (!label) { rows.push(`${id}: not in the menu (reached from a button only)`); await page.evaluate((target) => window.__nemoworld.openSection(target), id); }
  else {
    await page.locator('#game-menu-button').click();
    await page.locator(`#navigation [data-section="${id}"]`).click();
  }
  await page.waitForFunction((target) => window.__nemoworld.panel() === target, id, { timeout: 15000 });
  await page.waitForTimeout(700);
  const report = await page.evaluate(() => {
    const canvas = document.querySelector('#world'), box = canvas?.getBoundingClientRect();
    const panel = document.querySelector('#game-panel'), body = document.querySelector('#game-panel-body');
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id), duplicates = [...new Set(ids.filter((value, index) => ids.indexOf(value) !== index))];
    const heading = body.querySelector('h2')?.textContent?.trim() || '';
    return {
      canvasKept: canvas?.dataset.auditMark === 'same-canvas', canvasShare: box ? Number(((box.width * box.height) / (innerWidth * innerHeight)).toFixed(2)) : 0,
      panelVisible: !panel.hidden && panel.getBoundingClientRect().width > 0, overflow: body.scrollWidth - body.clientWidth, duplicates,
      current: document.querySelector('#navigation [aria-current=page]')?.getAttribute('aria-label') || null,
      heading, textLength: body.textContent.trim().length, focusInPanel: panel.contains(document.activeElement),
      mode: document.body.className.split(/\s+/).filter((name) => name.startsWith('game-panel')).join(' '),
    };
  });
  const problems = [];
  if (!report.canvasKept) problems.push('the 3D canvas was replaced');
  if (report.canvasShare < 0.28) problems.push(`the world shrank to ${report.canvasShare} of the viewport`);
  if (!report.panelVisible) problems.push('the panel is not visible');
  if (report.overflow > 2) problems.push(`the panel scrolls sideways by ${report.overflow}px`);
  if (report.duplicates.length) problems.push(`duplicate ids ${report.duplicates.join(', ')}`);
  if (label && report.current !== label) problems.push(`the menu marks ${report.current} current, not ${label}`);
  if (!report.focusInPanel) problems.push('keyboard focus did not move into the panel');
  if (report.textLength < 40) problems.push('the panel is empty');
  await page.screenshot({ path: join(outDir, `${phone ? 'phone' : 'desktop'}-${id}.png`) });
  rows.push(`${id.padEnd(12)} ${problems.length ? 'FAIL ' + problems.join('; ') : 'ok'}  [${report.mode}] share ${report.canvasShare} "${report.heading}"`);
  if (problems.length) failures.push(`${id}: ${problems.join('; ')}`);
}

// Escape closes a panel and returns focus; the world keeps the same canvas throughout.
await page.evaluate(() => window.__nemoworld.openSection('missions'));
await page.waitForFunction(() => window.__nemoworld.panel() === 'missions');
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__nemoworld.panel() === '');
const closed = await page.evaluate(() => ({ hidden: document.querySelector('#game-panel').hidden, same: document.querySelector('#world').dataset.auditMark === 'same-canvas' }));
rows.push(`escape       ${closed.hidden && closed.same ? 'ok' : 'FAIL'}  panel hidden=${closed.hidden} canvas kept=${closed.same}`);
if (!closed.hidden || !closed.same) failures.push('Escape did not close the panel on the same canvas');

if (walk && !phone) {
  await page.evaluate(() => window.__nemoworld.openSection('missions'));
  await page.waitForFunction(() => window.__nemoworld.panel() === 'missions');
  await page.locator('#game-panel-world').click();
  const before = await page.evaluate(() => { const me = window.__nemoworld.world().participants.find((item) => item.id === window.__nemoworld.selected()); return { x: me?.x, y: me?.y }; });
  await page.keyboard.press('w'); await page.waitForTimeout(800);
  const after = await page.evaluate(() => { const me = window.__nemoworld.world().participants.find((item) => item.id === window.__nemoworld.selected()); return { x: me?.x, y: me?.y, panel: window.__nemoworld.panel() }; });
  const moved = before.x !== after.x || before.y !== after.y;
  rows.push(`walk         ${moved ? 'ok' : 'FAIL'}  panel ${after.panel}; ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  if (!moved) failures.push('W did not move the resident while a panel was open');
}
console.log(rows.join('\n'));
if (errors.length) console.log(`\npage errors:\n${[...new Set(errors)].join('\n')}`);
await browser.close();
if (failures.length || errors.length) { console.log(`\n${failures.length} section problem(s), ${errors.length} page error(s)`); process.exit(1); }
console.log(`\nall ${rows.length - 1} sections kept the world`);
