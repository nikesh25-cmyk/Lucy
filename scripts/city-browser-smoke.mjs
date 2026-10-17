#!/usr/bin/env node
// Real Chrome, disposable accounts/databases only. Native acknowledgements in this
// probe are signed fixtures, explicitly not a claim of an in-game building test.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { fixture } from '../tests/helpers.js';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { VelorenLink, signEvent } from '../src/veloren-link.js';

const cleanups = [];
const f = await fixture({ after: fn => cleanups.push(fn) });
const output = resolve(process.env.NEMO_CITY_EVIDENCE || 'test-results/city');
mkdirSync(output, { recursive: true });
const key = Buffer.from('disposable-city-browser-key-000000000001');
const player = '11111111-1111-4111-8111-111111111111';
const dbPath = join(f.directory, 'link.sqlite');
const options = { dbPath, eventKey: key, commandsPath: join(f.directory, 'commands.jsonl'), landmarks: [{ id: 'lyra-post', name: 'Post', role: 'post' }, { id: 'lyra-survey', name: 'Field', role: 'survey' }], clock: f.clock };
let platform = f.platform;
let link;
let app;
let browser;
let origin;
const passes = [];
const check = (name, fn) => Promise.resolve().then(fn).then(() => { passes.push(name); console.log(`PASS ${name}`); });
async function start() {
  link = new VelorenLink(options);
  link.platform = platform;
  app = createApp({ platform, velorenLink: link });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${app.server.address().port}`;
}
async function stop() {
  if (app) { await new Promise(resolve => app.server.close(resolve)); await app.stopWorkers(); app = null; }
}
try {
  f.tx('createAgent', f.actor('alice'), { name: 'Alice Guest', kind: 'human', capabilities: 'Visit', limitations: 'Human guest', color: '#397f79', symbol: '✦' });
  await start();
  link.sql.run('INSERT INTO ident_links VALUES(?,?,?,?,?)', player, f.actor('alice').account.id, 'Alice', 'Alice Guest', f.clock());
  browser = await chromium.launch({ channel: process.env.LUCY_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await check('anonymous directory is readable; private home stays signed out', async () => {
    await page.goto(origin + '/city');
    await page.getByText('Sign in to your NemoWorld account to see your private home request.', { exact: false }).waitFor();
    await page.locator('#offices .card').last().waitFor();
    assert.equal(await page.locator('#offices .card').count(), 6);
    assert.equal(await page.locator('#home-form').isVisible(), false);
    assert.equal(await page.locator('#people .person').count(), 60);
    assert.equal(await page.locator('#people .person:visible').count(), 8);
    await page.screenshot({ path: join(output, 'desktop-entry.png') });
    await page.screenshot({ path: join(output, 'desktop-directory.png'), fullPage: true });
  });
  await context.addCookies([{ name: 'world_session', value: f.credentials.alice.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  let plot;
  await check('guest requests a free plot and Rowan build through the real interface', async () => {
    await page.reload();
    await page.locator('#home-form').waitFor();
    plot = await page.locator('#plot').inputValue();
    await page.locator('#style').selectOption('3');
    await page.locator('#plot').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#style').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#request-home').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByText('building', { exact: true }).waitFor();
    assert.equal(platform.get('SELECT plot_id FROM land_stewardships WHERE account_id=?', f.actor('alice').account.id).plot_id, plot);
    assert.equal(link.sql.get('SELECT COUNT(*) AS n FROM home_commands').n, 1);
    assert.equal(await page.locator('#home-form').isVisible(), false);
    await page.screenshot({ path: join(output, 'desktop-request-saved.png'), fullPage: true });
  });
  await check('signed fixture acknowledgement, not HTTP success, changes the view to built', async () => {
    const command = link.sql.get('SELECT cmd_id FROM home_commands');
    const relay = link.issueCredential({ resident_id: 'lw-rowan', scopes: ['events'], days: 1 });
    const event = { v: 1, server_id: 'disposable-fixture', seq: 1, kind: 'command.applied', resident_id: 'lw-rowan', player_uuid: player, player_alias: 'Guest', landmark_id: command.cmd_id, occurred_at: f.clock() };
    event.sig = signEvent(key, event);
    link.ingest(link.authenticate(relay.token, 'events'), [event]);
    await page.locator('#refresh-home').click();
    await page.getByText('built', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('#home-feedback').textContent(), /waiting for the game server/i, 'confirmation clears the stale pending message');
    assert.equal(await page.locator('#enter-home').isVisible(), true);
    assert.equal(platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  });
  await check('390px touch layout and reduced motion retain the confirmed outcome', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#home').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'phone page must fit');
    for (const id of ['enter-home', 'leave-home', 'refresh-home']) {
      const box = await page.locator(`#${id}`).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${id} has a touch target`);
    }
    await page.screenshot({ path: join(output, 'phone-confirmed-home.png'), fullPage: true });
    await page.locator('#home').screenshot({ path: join(output, 'phone-home-detail.png') });
  });
  await check('home and server-confirmed state survive closing and reopening both databases', async () => {
    await stop(); platform.close();
    platform = new Platform(f.database, f.clock);
    await start();
    await page.goto(origin + '/city#home');
    await page.getByText('built', { exact: true }).waitFor();
    assert.equal(platform.get('SELECT plot_id FROM land_stewardships WHERE account_id=?', platform.authenticate(f.credentials.alice.token).account.id).plot_id, plot);
    assert.equal(link.sql.get('SELECT COUNT(*) AS n FROM home_commands').n, 1);
  });
  await check('a second guest sees their own home state without the first guest’s plot', async () => {
    const second = await browser.newContext();
    try {
      await second.addCookies([{ name: 'world_session', value: f.credentials.bob.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
      const other = await second.newPage();
      await other.goto(origin + '/city#home');
      await other.getByText('Link your current Veloren human character to this account, then return.', { exact: true }).waitFor();
      assert.equal(await other.locator('#home-details').isVisible(), false);
      const mine = await other.evaluate(async () => (await fetch('/api/v1/veloren/city/home')).json());
      assert.equal(mine.home.plot, null);
    } finally { await second.close(); }
  });
  await check('confirmed home buttons issue only the current guest’s existing native enter/leave commands', async () => {
    f.advance(6000);
    await page.locator('#enter-home').click();
    await page.getByText('Asking the world to let you in.', { exact: false }).waitFor();
    assert.equal(link.sql.get("SELECT player_uuid FROM home_commands WHERE kind='home_enter'").player_uuid, player);
    f.advance(6000);
    await page.locator('#leave-home').click();
    await page.getByText('Asking the world to set you down at your doorstep.', { exact: true }).waitFor();
    assert.equal(link.sql.get("SELECT player_uuid FROM home_commands WHERE kind='home_leave'").player_uuid, player);
  });
  await check('public city refreshes saved citizens without a page reload', async () => {
    link.nativeCity.enabled = true;
    link.nativeCity.tick();
    await page.waitForFunction(() => [...document.querySelectorAll('#people .card h3')].some(el => el.textContent === 'Ada'), null, { timeout: 20_000 });
    assert.equal(await page.locator('#families .card').count(), 4);
  });
  await check('browser code has no unhandled errors', () => assert.deepEqual(errors, []));
  writeFileSync(join(output, 'results.json'), JSON.stringify({ passed: passes.length, failed: 0, scenarios: passes, native_acknowledgements: 'signed disposable fixtures; no actual game client driven', world_database: 'temporary, removed after run' }, null, 2));
  console.log(`${passes.length}/${passes.length} city browser scenarios passed`);
} finally {
  await browser?.close();
  await stop();
  if (platform !== f.platform) platform.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
