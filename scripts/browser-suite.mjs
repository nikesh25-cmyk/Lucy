#!/usr/bin/env node
// NemoWorld executable browser acceptance suite.
//
// It boots the shipped server as a real child process in a private temporary workspace, points it at
// a temporary SQLite database, drives the real interface in the system Chrome build through
// playwright-core, and after every browser action reads the server's own records (over HTTP and in
// the temporary SQLite file) to confirm the database changed as the interface claimed. The shipped
// data directory, any installed world and outputs/Lucy are never opened for writing, and the
// workspace, process lock and temporary database are removed even when a scenario fails.
//
// Run it with:  npm run browser
// Debug:        LUCY_BROWSER_KEEP=1 npm run browser        keep the workspace, traces and screenshots
//               LUCY_BROWSER_ONLY=a,b npm run browser      run named scenarios only
//               LUCY_CHROME_PATH=/path/to/chrome          use another Chrome build
//               LUCY_BROWSER_CHANNEL=chrome|msedge        use another installed channel
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { cameraWalkDirection, facingLabel } from '../src/camera-controls.js';
import { RESTORATION_PLAN } from '../src/community.js';
import { onMap } from '../src/global-map.js';
import { LIVING_ROSTER } from '../src/living-world.js';
import { validateDatabase } from '../src/recovery.js';
import { planWalk } from '../src/world-walk.js';
import { frontierGates, getWorldDefinition, walkable } from '../world.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESULTS = join(ROOT, 'test-results');
const PUBLIC_HOST = '127.0.0.1';
const PASSWORD = 'browser-acceptance-password-2026';
const REQUEST_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 120_000;
const SCENARIO_TIMEOUT_MS = 300_000;
const PAGE_TIMEOUT_MS = 25_000;
// These operators deliberately keep browser-local state between scenarios. Every other key owns
// a single scenario; unload its finished scene instead of retaining dozens of WebGL worlds.
const REUSABLE_ACTORS=new Set(['admin','owner','stranger','reviewer','contributor']);

class BrowserSuiteFailure extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.expected = evidence.expected;
    this.actual = evidence.actual;
    this.detail = evidence.detail;
  }
}

class StepTimeout extends Error {}

const state = {
  workspace: null, database: null, port: null, child: null, browser: null,
  results: [], notes: [], serverOutput: [], contexts: new Map(), scenarioContexts: new Set(),
  scenario: null, fixtures: {}, skipped: [],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function expect(condition, label, evidence = {}) {
  if (!condition) throw new BrowserSuiteFailure(label, evidence);
  return condition;
}

function baseUrl() { return `http://${PUBLIC_HOST}:${state.port}`; }

// ---------------------------------------------------------------------------------------------
// Pure helpers. These are exported so a unit test can check the refusal rule and the scenario
// registry without starting a browser or a server, which keeps `npm test` working with no
// node_modules directory present.
// ---------------------------------------------------------------------------------------------

/**
 * Why the runtime database path is refused, or null when it is a genuine temporary database.
 * A browser acceptance run must never open an installed world: the database has to live inside the
 * temporary workspace this process created, and it may not be the shipped data directory, an
 * installed copy under outputs/, or the personal Lucy installation.
 */
export function productionDatabaseRefusal(databasePath, projectRoot, workspace) {
  if (typeof databasePath !== 'string' || databasePath === '') return 'no runtime database path was configured';
  if (typeof workspace !== 'string' || workspace === '') return 'no temporary workspace was created';
  const target = resolve(databasePath);
  const home = resolve(workspace);
  const project = resolve(projectRoot);
  const inside = relative(home, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return `the runtime database ${target} is outside the temporary workspace ${home}`;
  }
  const guarded = [
    join(project, 'data'), join(project, 'outputs'), join(project, 'outputs', 'Lucy'),
    join(project, 'Lucy-repo'), join(project, 'backups'), join(project, 'assets'),
  ];
  for (const directory of guarded) {
    const offset = relative(resolve(directory), target);
    if (offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))) {
      return `the runtime database ${target} is inside the protected directory ${resolve(directory)}`;
    }
  }
  if (/(^|[\\/])(data|outputs)([\\/]|$)/.test(target)) return `the runtime database ${target} names an installed data or outputs path`;
  return null;
}

/** The scenarios the suite runs, in order, with the regression each one encodes. */
export const SCENARIOS = Object.freeze([
  { id: 'hero-introduction-film', title: 'The supplied introduction plays on the landing page and fits mobile', regression: null },
  { id: 'game-entry-and-observation', title: 'The game opens to Play and Observe with a full world stage and usable mobile controls', regression: null },
  { id: 'accounts-and-switching', title: 'Signup, login, logout and account switching', regression: null },
  { id: 'world-sound-controls', title: 'World sound is opt in, configurable, persistent and stopped when leaving the game', regression: null },
  { id: 'signed-in-game-play', title: 'A human enters the game, walks with the keyboard, opens its drawers and returns to the saved position', regression: null },
  { id: 'credential-exclusion', title: 'Credential exclusion from browser storage', regression: 'queue review correction 2' },
  { id: 'private-draft-isolation', title: 'Private draft isolation between operators', regression: 'queue review correction 2' },
  { id: 'refresh-and-focus-restoration', title: 'Refresh returns to the right form and restores focus', regression: 'queue review correction 3' },
  { id: 'first-person-controls', title: 'First-person movement, drag-look and the aim line', regression: null },
  { id: 'movement-latency', title: 'Local input to confirmed step: timed in the page, reported and not gated', regression: null },
  { id: 'country-ambassadors', title: 'Country ambassadors: directory, profile, conversation, mismatch', regression: null },
  { id: 'plot-and-blueprints', title: 'Plot assignment and blueprint preview, apply and remove', regression: null },
  { id: 'character-switch-clears-preview', title: 'Selecting another character clears the old blueprint preview', regression: 'queue review correction 1' },
  { id: 'quest-progression', title: 'Quest progression from a saved fact and a refused client completion', regression: null },
  { id: 'guild-cooperation', title: 'Guild cooperation: public, private, join', regression: null },
  { id: 'reward-refusals', title: 'Reward refusals: self-review and an NPC credential', regression: null },
  { id: 'forged-coin-receipt-refused', title: 'A forged coin receipt is refused by the database itself', regression: 'queue review correction 5' },
  { id: 'resident-run-resume-refusal', title: 'An interrupted resident run and the bounded resume refusal', regression: 'queue review correction 4' },
  { id: 'shared-presence-two-clients', title: 'Two browser clients see each other move and build over the event channel', regression: null },
  { id: 'subscription-entitlement-and-revocation', title: 'A private world and a revoked session both lose their live feed', regression: null },
  { id: 'interaction-hint-and-distance', title: 'The interaction hint, its one-tile requirement and an out-of-range refusal', regression: null },
  { id: 'game-hud-interaction-prompt-and-aim', title: 'The game HUD exposes a usable interaction prompt and matching aim guidance', regression: null },
  { id: 'next-passage-cue', title: 'The HUD names the next passage the server sends, and nothing when there is none', regression: null },
  { id: 'hud-visible-while-building', title: 'The HUD next-action band stays readable while the frontier build tools are open', regression: null },
  { id: 'interaction-saved-world-changes', title: 'A planted crop patch and a bench posture survive a reload', regression: null },
  { id: 'interaction-door-and-crafting', title: 'A doorway travels to another world and a crafting station crafts once per click', regression: null },
  { id: 'interaction-ambassador-desk', title: 'A country ambassador desk answers through the existing conversation action', regression: null },
  { id: 'interaction-state-refusals', title: 'Paused, revoked, wrong-owner and observer refusals keep the server authoritative', regression: null },
  { id: 'consolidated-proposal-history', title: 'Retired research templates remain readable but cannot become missions', regression: 'batch 02 integration correction' },
  { id: 'shared-build-and-restart', title: 'Two humans and an AI runtime build together, exchange items and keep progress after restart', regression: 'shared integration' },
  { id: 'wave-b-two-gates', title: 'Two humans and an active AI cross two connected frontier gates, choose their callings, raise one shared saved path in the sector they reached, and return to it after a restart', regression: 'wave B acceptance' },
  { id: 'karma-closed-loop', title: 'A brand-new account builds in its own free personal space, earns Karma Coins from that saved service, buys a shop good and keeps all of it through a restart', regression: 'the closed in-world economy loop' },
  { id: 'home-vault-interface', title: 'An operator opens Home & vault: vault counts and the server’s privacy statement, independent garden and cottage switches, a confirmed erase, a passport summary and a 44 px phone layout', regression: null },
  { id: 'cooperative-restoration-two-operators', title: 'Two operators restore a shared garden and the finished garden survives a restart', regression: null },
  { id: 'reviewer-workbench', title: 'A reviewer assesses each criterion, compares source versions, requests changes and the mission owner records an adoption', regression: null },
  { id: 'review-states-and-refusals', title: 'Accepted, held and refused states stay distinct while a simultaneous acceptance issues one receipt', regression: null },
  { id: 'mission-quality-advisory-signals', title: 'A reviewer reads the advisory mission-quality signals beside the review surface, checks one off for this session only, and the flags block nothing', regression: null },
  { id: 'live-observation-readonly', title: 'An anonymous observer sees public activity and can neither build nor control a resident', regression: null },
  { id: 'game-shell-entry-and-continue', title: 'Play, Observe and Continue enter the world, and the shell keeps one overlay, one HUD and one drawer', regression: null },
  { id: 'selection-does-not-clobber-navigation', title: 'A section opened while a character selection is still loading is not replaced by the world view', regression: 'character selection race (83b9505)' },
  { id: 'management-interface-and-roles', title: '/manage hosts the governance surfaces, and only a privileged role sees the entry', regression: null },
  { id: 'private-memory-and-journal-boundaries', title: 'A private memory and a private journal are refused to another operator and to a sibling character', regression: null },
  { id: 'first-ten-minutes', title: 'One derived next action, a chosen calling, a saved action, a dismissed and resumed guide, and a resumed place', regression: null },
  { id: 'first-play-solo-ambassador', title: 'A new solo operator follows the guide through the Commons, asks a nearby scripted ambassador, and retains that saved meeting', regression: null },
  { id: 'restoration-two-clients', title: 'Two browsers restore one shared garden and the attributed result survives a reload in both', regression: null },
  { id: 'phone-conversation', title: 'The game conversation panel is compact, preserves drafts, and respects reduced motion on phones', regression: null },
  { id: 'in-game-command-surface', title: 'Every platform section opens as a panel over the running 3D world, with keyboard, phone and reduced-motion access, and the avatar stays controllable', regression: null },
  { id: 'shared-world-seam-crossing', title: 'Two humans and one AI resident cross a global-map seam with no portal, speak across it, build in a garden and return after a restart', regression: 'wave 2 shared-world coherence' },
  // Last: signing out ends the administrator session this scenario shares with the ones above.
  { id: 'signout-privacy', title: 'Sign-out clears cached private quests, guilds, blueprints and land state', regression: 'queue review correction 1' },
]);

export function selectedScenarios(only) {
  if (!only) return SCENARIOS.map((entry) => entry.id);
  const wanted = new Set(String(only).split(',').map((item) => item.trim()).filter(Boolean));
  return SCENARIOS.filter((entry) => wanted.has(entry.id)).map((entry) => entry.id);
}

// ---------------------------------------------------------------------------------------------
// Server process, temporary workspace and the production-database refusal
// ---------------------------------------------------------------------------------------------

function apiRequest(path, options = {}) {
  const { method = 'GET', token, cookie, body: payload, headers = {}, apiClient } = options;
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  const sent = { Host: `${PUBLIC_HOST}:${state.port}`, ...headers };
  if (data) { sent['Content-Type'] = 'application/json'; sent['Content-Length'] = String(data.length); sent.Origin = baseUrl(); }
  if (token) sent.Authorization = `Bearer ${token}`;
  if (cookie) sent.Cookie = cookie;
  if (apiClient) sent['X-API-Client'] = apiClient;
  const path_ = `/api/v1${path}`;
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: PUBLIC_HOST, port: state.port, path: path_, method, headers: sent, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        resolve({ status: response.statusCode, headers: response.headers, raw, body, method, path: path_ });
      });
    });
    request.on('error', (error) => reject(new BrowserSuiteFailure(`request ${method} ${path_} failed: ${error.message}`)));
    if (data) request.write(data);
    request.end();
  });
}

const apiGet = (path, options) => apiRequest(path, options);
const apiPost = (path, payload, options = {}) => apiRequest(path, { ...options, method: 'POST', body: payload });

/** One operator HTTP session for fixture setup; the browser still drives every assertion. */
async function apiOperatorSession(email, password) {
  const response = await apiPost('/auth/login', { email, password }, { apiClient: 'operator' });
  if (response.status !== 200) throw new BrowserSuiteFailure(`fixture login for ${email} failed`, { expected: 'HTTP 200', actual: `HTTP ${response.status} ${response.raw}` });
  return response.body;
}

async function api(ticket, method, path, payload, options = {}) {
  const request = { method, token: ticket.token, ...options };
  return payload === undefined ? apiGet(path, request) : apiPost(path, payload, request);
}

async function apiExpect(ticket, method, path, payload, statuses = [200, 201], options = {}) {
  const response = await api(ticket, method, path, payload, options);
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(response.status)) {
    throw new BrowserSuiteFailure(`fixture request ${method} ${path} was refused`, { expected: `HTTP ${allowed.join(' or ')}`, actual: `HTTP ${response.status} ${response.raw}` });
  }
  return response.body;
}

/** The one PATCH route a fixture needs: the owner changes a garden's visiting visibility. */
async function apiPatch(ticket, path, payload, statuses = [200]) {
  const response = await apiRequest(path, { method: 'PATCH', token: ticket.token, body: payload });
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(response.status)) {
    throw new BrowserSuiteFailure(`fixture request PATCH ${path} was refused`, { expected: `HTTP ${allowed.join(' or ')}`, actual: `HTTP ${response.status} ${response.raw}` });
  }
  return response.body;
}

/**
 * The server's own interval between two saved conversation lines from one account. `POST /messages`
 * compares the newest stored line of `actor.account.id` and answers `429 Please wait before sending
 * another message.` inside 1500 ms (`src/platform.js message()`). A runtime credential posts as the
 * account that issued it, so a human's line and its own resident's answer share one interval: a
 * conversation that alternates between them is paced by this rule, not by luck.
 */
const MESSAGE_INTERVAL_MS = 1500;

/**
 * One saved conversation line, paced past that interval. The account whose interval the line is
 * charged to is named by the caller, because a runtime credential has no account id of its own. Only
 * the documented interval refusal is ever resumed — and every resume is printed — so a refusal for
 * any other reason is the failure it looks like. The wait reads the stored row rather than sleeping a
 * fixed time, so a line costs nothing when its account has been quiet for longer than the interval
 * already.
 */
async function sendLine(ticket, accountId, body, { attempts = 3 } = {}) {
  const quiet = () => {
    const last = row('SELECT created_at FROM messages WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 1', accountId);
    return !last || Date.parse(last.created_at) + MESSAGE_INTERVAL_MS <= Date.now() ? true : null;
  };
  let refusal = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await waitForCondition(quiet, `the server’s own ${MESSAGE_INTERVAL_MS} ms interval between two lines from account ${accountId}`, { timeout: 10_000, interval: 100 });
    const response = await api(ticket, 'POST', '/messages', body);
    if (response.status === 200 || response.status === 201) return response.body;
    refusal = `HTTP ${response.status} ${response.raw}`;
    if (response.status !== 429 || !/another message/i.test(response.raw || '')) break;
    console.log(`        message pacing   the server’s own per-account message interval refused a line for account ${accountId}; waiting it out and sending again`);
  }
  throw new BrowserSuiteFailure('POST /messages was refused', { expected: 'HTTP 200 or 201 from POST /messages', actual: refusal });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, PUBLIC_HOST, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function shippedDatabase() { return join(ROOT, 'data', 'world.sqlite'); }

function shippedDatabaseState() {
  const path = shippedDatabase();
  if (!existsSync(path)) return 'absent';
  const stats = statSync(path);
  return `present:${stats.size}:${stats.mtimeMs}`;
}

async function startServer() {
  const env = { ...process.env, PORT: String(state.port), LUCY_DATABASE: state.database, LUCY_BIND_HOST: PUBLIC_HOST };
  for (const name of ['LUCY_PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'LUCY_LOCAL_PORT_FALLBACK', 'LUCY_MODEL_NAME', 'LUCY_MODEL_URL', 'LUCY_SETUP_CODE']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  const collect = (chunk) => { state.serverOutput.push(chunk.toString('utf8').trimEnd()); if (state.serverOutput.length > 60) state.serverOutput = state.serverOutput.slice(-60); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('exit', (code, signal) => { state.serverOutput.push(`[server exited] code=${code} signal=${signal}`); });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new BrowserSuiteFailure(`the server exited before becoming ready (code ${child.exitCode})`, { detail: state.serverOutput.join('\n') });
    try {
      const response = await apiGet('/health');
      if (response.status === 200) return response.body;
      last = `HTTP ${response.status} ${response.raw}`;
    } catch (error) { last = error.message; }
    await sleep(250);
  }
  throw new BrowserSuiteFailure(`the server did not become ready within ${READY_TIMEOUT_MS} ms`, { actual: last });
}

async function stopServer() {
  const child = state.child;
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
    child.kill('SIGTERM');
    if (!await Promise.race([exited, sleep(10_000).then(() => false)])) { child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]); }
  }
  state.child = null;
}

// ---------------------------------------------------------------------------------------------
// Temporary database reads. The suite never writes through these connections except in the one
// scenario that proves the database itself refuses a forged coin receipt.
// ---------------------------------------------------------------------------------------------

function connect() {
  const db = new DatabaseSync(state.database);
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

function rows(sql, ...params) {
  const db = connect();
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

function row(sql, ...params) { return rows(sql, ...params)[0] ?? null; }

function scalar(sql, ...params) {
  const record = row(sql, ...params);
  if (!record) return null;
  return record[Object.keys(record)[0]];
}

function count(sql, ...params) { return Number(scalar(sql, ...params) ?? 0); }

function write(sql, ...params) {
  const db = connect();
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}

// ---------------------------------------------------------------------------------------------
// Browser driver
// ---------------------------------------------------------------------------------------------

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (error) {
    throw new BrowserSuiteFailure('playwright-core is not installed; run npm install for the dev dependency', { detail: error.message });
  }
  const executablePath = process.env.LUCY_CHROME_PATH || undefined;
  const channel = executablePath ? undefined : (process.env.LUCY_BROWSER_CHANNEL || 'chrome');
  const args = ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'];
  if (process.env.CI) args.push('--no-sandbox');
  let browser;
  try {
    browser = await chromium.launch({ channel, executablePath, args });
  } catch (error) {
    throw new BrowserSuiteFailure(`the system Chrome build could not be launched${channel ? ` (channel ${channel})` : ''}`, { expected: 'a working Chrome launch', actual: error.message, detail: 'Install Google Chrome, or set LUCY_CHROME_PATH / LUCY_BROWSER_CHANNEL to a browser Playwright can drive.' });
  }
  return browser;
}

function attachPageLogs(page, key) {
  const write = (line) => {
    const target = state.scenarioLogs || (state.scenarioLogs = []);
    target.push(`[${key}] ${line}`);
  };
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') write(`console.${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => write(`pageerror: ${error.message}`));
  page.on('response', (response) => { if (response.url().includes('/api/v1') && response.status() >= 400) write(`response ${response.status()} ${response.request().method()} ${response.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  page.on('requestfailed', (request) => write(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`.trim()));
}

async function context(key) {
  if (state.contexts.has(key)) {
    const record=state.contexts.get(key);
    if(record.frozen){await record.lifecycle.send('Page.setWebLifecycleState',{state:'active'});record.frozen=false;}
    if(!state.scenarioContexts.has(key)){
      await record.context.tracing.start({screenshots:true,snapshots:true,sources:false});
      state.scenarioContexts.add(key);
    }
    if(record.parkedUrl){const url=record.parkedUrl;record.parkedUrl=null;await record.page.goto(url,{waitUntil:'domcontentloaded'});await settle(record.page);}
    return record;
  }
  const browserContext = await state.browser.newContext({ viewport: { width: 1440, height: 900 } });
  browserContext.setDefaultTimeout(PAGE_TIMEOUT_MS);
  await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await browserContext.newPage();
  attachPageLogs(page, key);
  const lifecycle=await browserContext.newCDPSession(page);
  const record = { key, context: browserContext, page, lifecycle, frozen:false };
  state.contexts.set(key, record);
  state.scenarioContexts.add(key);
  return record;
}

/** A named operator: one isolated browser context with its own storage and session cookie. */
async function actor(key) {
  const definition = ACTORS[key];
  if (!definition) throw new BrowserSuiteFailure(`unknown actor ${key}`);
  const record = await context(key);
  return { ...record, ...definition };
}

const ACTORS = {
  admin: { email: 'administrator@browser.test', password: PASSWORD, name: 'Browser administrator' },
  owner: { email: 'owner@browser.test', password: PASSWORD, name: 'Browser owner' },
  reviewer: { email: 'reviewer@browser.test', password: PASSWORD, name: 'Browser reviewer' },
  stranger: { email: 'stranger@browser.test', password: PASSWORD, name: 'Browser stranger' },
  // The reviewer-workbench scenarios keep all four roles on different accounts: the administrator
  // proposes and later adopts, this operator contributes, and the reviewer is the fourth person.
  contributor: { email: 'contributor@browser.test', password: PASSWORD, name: 'Browser contributor' },
  // The Wave B crossing scenario creates its own two operators and their three residents, so the two
  // humans that cross the frontier gates share no account, character or fixture with any other
  // scenario, and no shared resident is left standing in another sector when it ends. It also
  // stewards a plot of its own in that sector, exactly as `shared-build-and-restart` does with the
  // central sector, because an operator may steward one plot and both scenarios need their own.
  'wave-b-host': { email: 'wave-b-host@browser.test', password: PASSWORD, name: 'Wave B host' },
  'wave-b-guest': { email: 'wave-b-guest@browser.test', password: PASSWORD, name: 'Wave B guest' },
  // The shared-world scenario creates its own two operators and three residents, so nothing it leaves
  // on the far side of a seam is a shared resident another scenario depends on.
  'shared-world-host': { email: 'shared-world-host@browser.test', password: PASSWORD, name: 'Shared world host' },
  'shared-world-guest': { email: 'shared-world-guest@browser.test', password: PASSWORD, name: 'Shared world guest' },
};

/**
 * The one seam the shared-world scenario crosses: the Commons' north edge into Highlands. Every tile
 * here is a plain tile of the two worlds; the avenue through the join is the one `src/global-map.js`
 * opens, so a step off the north edge stores the resident in the neighbour without a portal.
 */
const SHARED_SEAM = Object.freeze({
  anchor: 'commons', neighbour: 'district:highlands',
  stand: { x: 25, y: 0 }, landing: { x: 25, y: 35 }, out_of_range: { x: 25, y: 31 },
  line: 'One tile away, across the border.',
  answer: 'Both sides of the border, one world.',
});

/**
 * Opens the application. When operator credentials are supplied the session is restored if the
 * cookie is still valid, and a sign-in runs through the interface only when it is not, so a focused
 * run of one scenario still starts from a real signed-in session.
 */
async function openApp(page, credentials = null) {
  // The detailed workspace remains a user-reachable view. Existing acceptance scenarios exercise
  // its forms directly; the separate game-entry scenario opens the default world-first screen.
  await page.goto(`${baseUrl()}/?mode=workspace`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (credentials && !await page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(page, credentials);
}

async function settle(page) {
  await page.waitForFunction(() => {
    const view = document.querySelector('#view');
    return view && view.getAttribute('aria-busy') === 'false' && !/Opening the world/.test(view.textContent || '');
  }, null, { timeout: PAGE_TIMEOUT_MS });
}

const nav = (page, label) => page.locator(`#navigation button[aria-label="${label}"]`);

async function openTab(page, label) {
  // In the game the section list lives in the World menu, which closes once a section is chosen; open it again
  // when the entry is not on screen, exactly as a visitor would.
  const menu = page.locator('#game-menu-button');
  for (let attempt = 0; attempt < 2 && !await nav(page, label).isVisible().catch(() => false); attempt++) {
    if (!await menu.isVisible().catch(() => false)) break;
    await menu.click();
    await nav(page, label).waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
  }
  await nav(page, label).click();
  await settle(page);
  await page.waitForTimeout(150);
}

/**
 * Signs in through the real dialog. The server rate-limits authentication attempts per peer, so a
 * refusal from the limiter is waited out once instead of failing the scenario.
 */
async function signIn(page, { email, password }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!await page.locator('#auth-dialog').evaluate((node) => node.open).catch(() => false)) {
      await page.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    }
    const form = page.locator('#auth-area section:not([hidden]) form');
    await form.locator('[aria-label="Email"]').fill(email);
    await form.locator('[aria-label="Password"]').fill(password);
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    let outcome = 'timeout';
    while (Date.now() < deadline) {
      const observed = await page.evaluate(() => {
        const notice = document.querySelector('#auth-notice');
        return { signedIn: document.body.classList.contains('signed-in'), notice: notice?.textContent || '', failed: Boolean(notice && !notice.hidden && notice.classList.contains('error')) };
      });
      if (observed.signedIn) { outcome = 'signed-in'; break; }
      if (observed.failed && /Too many authentication attempts/i.test(observed.notice)) { outcome = 'rate-limited'; break; }
      if (observed.failed) { outcome = `refused: ${observed.notice}`; break; }
      await sleep(200);
    }
    if (outcome === 'signed-in') { await settle(page); await page.waitForTimeout(200); return; }
    if (outcome === 'rate-limited' && attempt === 0) {
      console.log('        auth             the authentication limiter refused this attempt; waiting a minute before retrying once');
      await page.locator('#close-auth').click().catch(() => {});
      await sleep(62_000);
      continue;
    }
    throw new BrowserSuiteFailure('the interface could not sign in', { expected: `a signed-in session for ${email}`, actual: outcome });
  }
}

async function signOut(page) {
  await page.locator('#session-bar').getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForFunction(() => !document.body.classList.contains('signed-in'), null, { timeout: PAGE_TIMEOUT_MS });
  await settle(page);
}

async function signedInName(page) {
  return (await page.locator('#session-bar .session-profile strong').textContent())?.trim() || null;
}

function storage(page) {
  return page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
}

async function inPage(page, path, { method = 'POST', body, headers = {} } = {}) {
  return page.evaluate(async ([target, verb, payload, extra]) => {
    const response = await fetch(`/api/v1${target}`, {
      method: verb,
      credentials: 'same-origin',
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [path, method, body, headers]);
}

/** Opens a disclosure if it is closed, so a restored draft that already opened it is not toggled shut. */
async function openDisclosure(page, text) {
  const summary = page.locator('#view summary', { hasText: text }).first();
  await summary.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  if (!await summary.evaluate((node) => node.closest('details')?.open === true)) await summary.click();
  return summary;
}

async function waitForText(page, text, { scope = '#view', timeout = 20_000 } = {}) {
  await page.locator(scope).getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

async function waitForCondition(condition, label, { timeout = 25_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await sleep(interval);
  }
  throw new BrowserSuiteFailure(`timed out waiting for ${label}`, { expected: label, actual: `still false after ${timeout} ms` });
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new StepTimeout(`${label} exceeded ${milliseconds} ms`)), milliseconds); }),
  ]);
}

async function step(name, action) {
  const started = Date.now();
  const detail = await withTimeout(Promise.resolve().then(action), STEP_TIMEOUT_MS, `step "${name}"`);
  console.log(`      · ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - started} ms)`);
  return detail;
}

// ---------------------------------------------------------------------------------------------
// Failure capture
// ---------------------------------------------------------------------------------------------

async function captureFailure(scenarioId, errors) {
  await mkdir(RESULTS, { recursive: true });
  const saved = [];
  for (const key of state.scenarioContexts) {
    const record = state.contexts.get(key);
    if (!record) continue;
    try {
      const file = join(RESULTS, `${scenarioId}-${key}.png`);
      await record.page.screenshot({ path: file, fullPage: false });
      saved.push(relative(ROOT, file));
    } catch (error) { saved.push(`screenshot failed: ${error.message}`); }
    try {
      const file = join(RESULTS, `${scenarioId}-${key}-trace.zip`);
      await record.context.tracing.stop({ path: file });
      saved.push(relative(ROOT, file));
    } catch (error) { saved.push(`trace failed: ${error.message}`); }
  }
  const log = join(RESULTS, `${scenarioId}.log`);
  const lines = [...(errors || []).map((error) => String(error?.stack || error)), '', 'page log:', ...(state.scenarioLogs || [])];
  await writeFile(log, lines.join('\n'));
  saved.push(relative(ROOT, log));
  return saved;
}

async function discardTraces() {
  for (const key of state.scenarioContexts) {
    const record = state.contexts.get(key);
    if (!record) continue;
    try { await record.context.tracing.stop(); } catch { /* A discarded trace is best effort. */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------------------------

async function runScenario(definition) {
  state.scenario = { ...definition, actor: null };
  state.scenarioContexts = new Set();
  state.scenarioLogs = [];
  console.log('');
  console.log(`SCENARIO ${definition.id} — ${definition.title}${definition.regression ? `  [regression: ${definition.regression}]` : ''}`);
  const started = Date.now();
  const errors = [];
  let failed=false;
  try {
    await withTimeout(runImplementation(definition), SCENARIO_TIMEOUT_MS, `scenario "${definition.id}"`);
    await discardTraces();
    state.results.push({ id: definition.id, ok: true, ms: Date.now() - started });
    console.log(`PASS  ${definition.id} — ${definition.title} (${Date.now() - started} ms)`);
    return true;
  } catch (error) {
    failed=true;
    errors.push(error);
    const saved = await captureFailure(definition.id, errors);
    state.results.push({ id: definition.id, ok: false, ms: Date.now() - started, error });
    console.log(`FAIL  ${definition.id} — ${definition.title}`);
    console.log(`        reason    ${error.message}`);
    if (error.expected !== undefined) console.log(`        expected  ${describe(error.expected)}`);
    if (error.actual !== undefined) console.log(`        actual    ${describe(error.actual)}`);
    if (error.detail) console.log(`        detail    ${String(error.detail).split('\n').slice(0, 12).join('\n                  ')}`);
    if (saved.length) console.log(`        evidence  ${saved.join(', ')}`);
    const pageLog = state.scenarioLogs || [];
    for (const line of pageLog.slice(0, 6)) console.log(`        page      ${line}`);
    return false;
  } finally {
    // Keep reusable operators' exact DOM and browser-local choices; unload one-off scenes, keeping
    // their browsing context/storage available if reused. Freezing alone retains their WebGL memory.
    // The clients participating in one scenario stay active together for its entire duration.
    for(const key of state.scenarioContexts){
      const record=state.contexts.get(key);
      if(record&&!record.page.isClosed()){
        if(failed){await record.context.close();state.contexts.delete(key);}
        else if(REUSABLE_ACTORS.has(key)){await record.lifecycle.send('Page.setWebLifecycleState',{state:'frozen'});record.frozen=true;}
        else{record.parkedUrl=record.page.url();await record.page.goto('about:blank',{waitUntil:'load'});}
      }
    }
    state.scenario = null;
    state.scenarioContexts = new Set();
  }
}

const implementations = new Map();
function define(id, run) { implementations.set(id, run); }
async function runImplementation(definition) {
  const run = implementations.get(definition.id);
  if (!run) throw new BrowserSuiteFailure(`scenario ${definition.id} has no implementation`);
  return run();
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main() {
  const only = process.env.LUCY_BROWSER_ONLY || '';
  const wanted = selectedScenarios(only);
  console.log('NemoWorld browser acceptance suite');
  console.log(`  project root      ${ROOT}`);
  console.log(`  scenarios         ${wanted.join(', ') || '(none selected)'}`);

  const refusal = productionDatabaseRefusal(join(tmpdir(), 'x', 'probe.sqlite'), ROOT, join(tmpdir(), 'x'));
  if (refusal) throw new BrowserSuiteFailure(`the production-database refusal rule is broken: ${refusal}`);

  state.workspace = await mkdtemp(join(tmpdir(), 'nemoworld-browser-'));
  state.database = join(state.workspace, 'world.sqlite');
  state.port = await freePort();
  const databaseRefusal = productionDatabaseRefusal(state.database, ROOT, state.workspace);
  console.log(`  base URL          ${baseUrl()}`);
  console.log(`  workspace         ${state.workspace}`);
  console.log(`  database          ${state.database}`);
  if (databaseRefusal) {
    console.log('');
    console.log('REFUSED');
    console.log(`  ${databaseRefusal}`);
    await rm(state.workspace, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }
  const before = shippedDatabaseState();

  let failure = null;
  try {
    const health = await startServer();
    console.log(`  server ready      GET /api/v1/health -> 200 ${JSON.stringify(health)}`);
    expect(existsSync(join(state.workspace, 'server.lock')), 'the server must take its process lock inside the temporary workspace', { expected: `a lock at ${join(state.workspace, 'server.lock')}`, actual: 'no lock file' });
    expect(productionDatabaseRefusal(state.database, ROOT, state.workspace) === null, 'the runtime database must be the temporary one', { actual: state.database });
    state.browser = await launchBrowser();
    console.log(`  browser           ${state.browser.version()}`);
    if (!wanted.includes('accounts-and-switching') && wanted.length) {
      // A focused run still needs the first administrator, so it registers one over the documented
      // API. The full run creates that account through the interface instead.
      const created = await apiPost('/auth/register', { name: ACTORS.admin.name, email: ACTORS.admin.email, password: PASSWORD, consent: true }, { apiClient: 'operator' });
      if (created.status !== 201) throw new BrowserSuiteFailure('a focused run could not register the first administrator', { expected: 'HTTP 201', actual: `HTTP ${created.status} ${created.raw}` });
      try { await prepareFixtures(); } catch (error) { throw error; }
      console.log('  fixtures          first administrator and four fictional operators created for the focused run');
    }
    console.log('');

    for (const id of wanted) {
      const definition = SCENARIOS.find((entry) => entry.id === id);
      if (id !== 'accounts-and-switching' && id !== 'hero-introduction-film' && id !== 'game-entry-and-observation' && !state.fixtures.ready) {
        console.log('');
        console.log(`SKIP  ${id} — the fictional account fixtures need the first administrator, so run accounts-and-switching first`);
        state.skipped.push(id);
        continue;
      }
      const ok = await runScenario(definition);
      if (!ok && id === 'accounts-and-switching') break;
    }
    await discardTraces();
  } catch (error) {
    failure = error;
  } finally {
    try { await state.browser?.close(); } catch { /* Best effort. */ }
    await stopServer();
  }

  const keep = process.env.LUCY_BROWSER_KEEP === '1';
  const lockReleased = !existsSync(join(state.workspace, 'server.lock'));
  if (!keep) await rm(state.workspace, { recursive: true, force: true });
  const workspaceRemoved = !existsSync(state.workspace);
  const after = shippedDatabaseState();

  console.log('');
  if (failure) {
    console.log(`FAIL  ${failure.message}`);
    if (failure.detail) console.log(`      ${failure.detail}`);
    if (failure instanceof StepTimeout === false) { /* The message is the report. */ }
    console.log(`      server output:`);
    for (const line of state.serverOutput.slice(-12)) console.log(`        ${line}`);
    process.exitCode = 1;
    return;
  }

  const passed = state.results.filter((result) => result.ok).length;
  const failed = state.results.filter((result) => !result.ok);
  console.log('TEARDOWN');
  expect(lockReleased, 'the process lock must be released after shutdown', { expected: `no ${join(state.workspace, 'server.lock')}`, actual: 'the lock file remained' });
  console.log(`  server stopped, process lock released: ${lockReleased}`);
  console.log(`  temporary workspace removed: ${workspaceRemoved}${keep ? ' (kept: LUCY_BROWSER_KEEP=1)' : ''}`);
  console.log(`  shipped database ${before === after ? 'untouched' : `CHANGED (${before} -> ${after})`}`);
  expect(before === after, 'the shipped data/world.sqlite must not change during a browser run', { expected: before, actual: after });
  if (state.skipped.length) console.log(`  skipped scenarios: ${state.skipped.join(', ')}`);
  if (state.notes.length) { console.log('  notes'); for (const note of state.notes) console.log(`    - ${note}`); }

  console.log('');
  console.log(`SUMMARY  ${passed} passed, ${failed.length} failed${state.skipped.length ? `, ${state.skipped.length} skipped` : ''}`);
  for (const result of state.results) console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.id} (${result.ms} ms)${result.error ? ` — ${result.error.message}` : ''}`);
  console.log(`  result  ${failed.length || state.skipped.length ? 'FAIL — see the failing scenario above' : 'PASS — the interface was driven in a real browser and the database agreed'}`);
  if (failed.length || state.skipped.length) process.exitCode = 1;
}


// ---------------------------------------------------------------------------------------------
// Fictional account fixtures
//
// Accounts exist so that privacy and independence can be observed between operators, and every
// browser scenario still signs in through the real interface. Only the first administrator and the
// ordinary member are created through the interface; the remaining fictional accounts and their
// characters are prepared over the documented API so each scenario can stay small and readable.
// ---------------------------------------------------------------------------------------------

/** An existing fictional account for its operator, or a new one created over the documented API. */
async function ensureAccount(admin, { email, password, name, role = 'member' }) {
  const existing = await apiPost('/auth/login', { email, password }, { apiClient: 'operator' });
  if (existing.status === 200) return existing.body;
  const registration = { name, email, password, consent: true };
  if (role !== 'member') {
    const invite = await apiExpect(admin, 'POST', '/invites', { role });
    registration.invite = invite.code;
  }
  const created = await apiPost('/auth/register', registration, { apiClient: 'operator' });
  if (created.status !== 201) throw new BrowserSuiteFailure(`the fictional account ${email} could not be created`, { expected: 'HTTP 201', actual: `HTTP ${created.status} ${created.raw}` });
  return created.body;
}

async function prepareFixtures() {
  const admin = await apiOperatorSession(ACTORS.admin.email, ACTORS.admin.password);
  const owner = await ensureAccount(admin, ACTORS.owner);
  const reviewer = await ensureAccount(admin, { ...ACTORS.reviewer, role: 'reviewer' });
  const stranger = await ensureAccount(admin, ACTORS.stranger);

  const character = (ticket, body) => apiExpect(ticket, 'POST', '/agents', { color: '#397f79', symbol: '✦', capabilities: 'Walks the shared world in the browser acceptance run', limitations: 'No external tools and no real-world claims', ...body });
  const pathfinder = await character(admin, { kind: 'agent', name: 'Pathfinder' });
  const wanderer = await character(admin, { kind: 'agent', name: 'Wanderer' });
  const player = await character(admin, { kind: 'human', name: 'Browser player', color: '#3d5875', symbol: '◆' });
  const steward = await character(owner, { kind: 'agent', name: 'Steward' });
  const walker = await character(owner, { kind: 'agent', name: 'Walker', color: '#8c6ab1', symbol: '◆' });
  const neighbour = await character(stranger, { kind: 'agent', name: 'Neighbour', color: '#cb725f', symbol: '▲' });

  // The steward follows the Researcher calling: its objectives touch neither the recorded shared
  // visit nor a saved home object, so the authored browser chain credits its own steps.
  await apiExpect(owner, 'POST', '/callings/select', { agent_id: steward.id, calling_id: 'researcher' });

  state.fixtures = {
    ready: true, admin: { ...admin, id: admin.account.id }, owner: { ...owner, id: owner.account.id },
    reviewer: { token: reviewer.token, account: reviewer.account, id: reviewer.account.id },
    stranger: { token: stranger.token, account: stranger.account, id: stranger.account.id },
    characters: { pathfinder, wanderer, player, steward, walker, neighbour },
  };
  state.notes.push(`fictional accounts: administrator ${ACTORS.admin.email}, member ${ACTORS.owner.email}, reviewer ${ACTORS.reviewer.email}, member ${ACTORS.stranger.email}`);
  console.log('  fixtures          four fictional operators, six characters, one reviewer invitation');
}

function fixtures() {
  if (!state.fixtures.ready) throw new BrowserSuiteFailure('the fictional account fixtures were never prepared');
  return state.fixtures;
}

async function expectStatus(response, statuses, label) {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(response.status)) {
    throw new BrowserSuiteFailure(label, { expected: `HTTP ${allowed.join(' or ')}`, actual: `HTTP ${response.status} ${response.raw}` });
  }
  return response.body;
}

/** One mission with one open task, owned by the administrator and reviewed by the reviewer. */
async function makeMission(title, tag, allowedDomains = ['example.org']) {
  const admin = fixtures().admin, reviewer = fixtures().reviewer;
  const mission = await apiExpect(admin, 'POST', '/missions', {
    title, area: 'Climate', summary: 'A bounded fixture mission for the browser acceptance run.',
    beneficiary: 'Acceptance community', owner_id: admin.id, reviewer_id: reviewer.id,
    rubric: 'Check the exact source, its date, its rights and the remaining uncertainty.',
  });
  const task = await apiExpect(admin, 'POST', '/tasks', {
    mission_id: mission.id, title: `Record one source (${tag})`, instructions: 'Provide the source, its exact location, rights and uncertainty.',
    rights: 'Public material with attribution.', allowed_domains: allowedDomains,
  });
  await apiExpect(admin, 'POST', '/missions/status', { mission_id: mission.id, status: 'open' });
  return { mission, task };
}

const EVIDENCE = {
  artifact: 'A plain text acceptance record with one attributed source.',
  mime: 'text/plain',
  sources: [{ url: 'https://example.org/report', location: 'Section 2, paragraph 3', date: '2026-10-11' }],
  method: 'Read the published report and recorded the exact supporting section.',
  limitations: 'Acceptance fixture; the facts and rights need human verification.',
  rights: 'Public material recorded with attribution.',
};

/** Operator claims a fixture task with one of its residents and submits evidence. */
async function claimAndSubmit(ticket, task, key, agentId) {
  const claim = await apiExpect(ticket, 'POST', '/claims', { task_id: task.id, agent_id: agentId }, [201], { headers: { 'Idempotency-Key': `browser-claim-${key}` } });
  const submission = await apiExpect(ticket, 'POST', '/submissions', { ...EVIDENCE, claim_id: claim.id }, [201], { headers: { 'Idempotency-Key': `browser-submit-${key}` } });
  return { claim, submission };
}

// ---------------------------------------------------------------------------------------------
// Scenario 1 — signup, login, logout and account switching
// ---------------------------------------------------------------------------------------------

define('accounts-and-switching', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  await openApp(page);

  await step('the first administrator signs up through the interface', async () => {
    await page.locator('#session-bar').getByRole('button', { name: /Create first account/, exact: false }).click();
    await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    const form = page.locator('#auth-area section:not([hidden]) form');
    await form.locator('[aria-label="Operator display name"]').fill(ACTORS.admin.name);
    await form.locator('[aria-label="Private contact email"]').fill(ACTORS.admin.email);
    await form.locator('[aria-label="Password"]').fill(PASSWORD);
    await form.locator('select[name="entry"]').selectOption('agent');
    await form.locator('input[name="consent"]').check();
    await form.getByRole('button', { name: 'Create the first account', exact: true }).click();
    await page.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: PAGE_TIMEOUT_MS });
    await settle(page);
    const account = row('SELECT id,name,email,role,status FROM accounts WHERE email=?', ACTORS.admin.email);
    expect(account && account.role === 'admin', 'the first account created in the browser must be the administrator', { expected: 'a stored admin account', actual: describe(account) });
    const humanAccounts = count("SELECT COUNT(*) AS n FROM accounts WHERE email NOT LIKE 'living-%@nemoworld.internal'");
    expect(humanAccounts === 1, 'the first signup must create exactly one human account', { actual: `human_accounts=${humanAccounts}` });
    expect(await signedInName(page) === ACTORS.admin.name, 'the session bar must name the signed-in administrator', { actual: await signedInName(page) });
    state.fixtures.adminAccountId = account.id;
    return `201 in the browser · account ${account.id} role=admin · one human account in the temporary database`;
  });

  await step('signing out revokes the server session and clears local operator state', async () => {
    await signOut(page);
    expect(!(await page.evaluate(() => localStorage.getItem('selected-agent'))), 'sign-out must clear the remembered character', { actual: 'selected-agent remained' });
    const live = count("SELECT COUNT(*) AS n FROM tokens t JOIN accounts a ON a.id=t.account_id WHERE a.email=? AND t.kind='session' AND t.revoked=0", ACTORS.admin.email);
    const revoked = count("SELECT COUNT(*) AS n FROM tokens t JOIN accounts a ON a.id=t.account_id WHERE a.email=? AND t.kind='session' AND t.revoked=1", ACTORS.admin.email);
    expect(live === 0 && revoked >= 1, 'sign-out must revoke the stored session token', { expected: 'no live session token and at least one revoked token', actual: `live=${live} revoked=${revoked}` });
    return `session token revoked in the temporary database (live=${live}, revoked=${revoked})`;
  });

  await step('an incorrect password is refused without a session', async () => {
    await page.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    const form = page.locator('#auth-area section:not([hidden]) form');
    await form.locator('[aria-label="Email"]').fill(ACTORS.admin.email);
    await form.locator('[aria-label="Password"]').fill('not-the-right-password-2026');
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#auth-notice.error').waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const message = (await page.locator('#auth-notice').textContent())?.trim();
    expect(!(await page.evaluate(() => document.body.classList.contains('signed-in'))), 'a refused sign-in must not open a session', { actual: 'the page reported a signed-in body' });
    await page.locator('#close-auth').click();
    return `refused: ${message}`;
  });

  await step('the administrator signs back in through the interface', async () => {
    await signIn(page, ACTORS.admin);
    expect(await signedInName(page) === ACTORS.admin.name, 'the session bar must name the administrator again', { actual: await signedInName(page) });
    return 'signed in as the administrator';
  });

  const owner = await actor('owner');
  await step('a second operator registers through the interface and sees only their own characters', async () => {
    // The second operator is deliberately signed out here: this step creates the account itself.
    await openApp(owner.page);
    await owner.page.locator('#session-bar').getByRole('button', { name: 'Create account', exact: true }).click();
    await owner.page.locator('#auth-dialog').waitFor({ state: 'visible' });
    const form = owner.page.locator('#auth-area section:not([hidden]) form');
    await form.locator('[aria-label="Operator display name"]').fill(ACTORS.owner.name);
    await form.locator('[aria-label="Private contact email"]').fill(ACTORS.owner.email);
    await form.locator('[aria-label="Password"]').fill(PASSWORD);
    await form.locator('select[name="entry"]').selectOption('agent');
    const inviteField = form.locator('[aria-label="Invitation code (optional)"]');
    expect(await inviteField.count() === 1, 'ordinary signup must offer the optional invitation field', { actual: 'no invitation field was rendered' });
    await form.locator('input[name="consent"]').check();
    await form.getByRole('button', { name: 'Create account', exact: true }).click();
    await owner.page.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: PAGE_TIMEOUT_MS });
    await settle(owner.page);
    const account = row('SELECT id,role FROM accounts WHERE email=?', ACTORS.owner.email);
    expect(account?.role === 'member', 'open signup must create an ordinary member', { expected: 'a stored member account', actual: describe(account) });
    expect(await signedInName(owner.page) === ACTORS.owner.name, 'the second browser context must be signed in as its own operator', { actual: await signedInName(owner.page) });
    await openTab(owner.page, 'My characters');
    const characters = await owner.page.locator('#view').textContent();
    expect(/Create your first character/.test(characters), 'a new operator must not see another operator’s characters', { actual: characters?.slice(0, 160) });
    expect(!/Pathfinder|Wanderer/.test(characters), 'the administrator’s characters must never appear for another operator', { actual: 'an administrator character was listed' });
    const other = await actor('admin');
    await openTab(other.page, 'My characters');
    return `201 in the browser · role=member · the second operator sees no characters of the administrator`;
  });

  await prepareFixtures();
  return 'four fictional operators and six characters are ready';
});

// ---------------------------------------------------------------------------------------------
// Scenario 2 — credential exclusion from browser storage
// ---------------------------------------------------------------------------------------------

define('credential-exclusion', async () => {
  const owner = await actor('owner');
  const page = owner.page;
  await openApp(page);
  // This check starts from a signed-out page: the registration form is only reachable when no
  // operator session is open, and browser storage is only meaningful once it has been cleared.
  if (await page.evaluate(() => document.body.classList.contains('signed-in'))) await signOut(page);

  const invitationCode = 'browser-invitation-code-must-not-be-stored';
  await step('an authentication form keeps no credentials in browser storage', async () => {
    await page.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#auth-tabs').getByRole('button', { name: 'Create account', exact: true }).click();
    const form = page.locator('#auth-area section:not([hidden]) form');
    await form.locator('[aria-label="Operator display name"]').fill('Never saved');
    await form.locator('[aria-label="Private contact email"]').fill('never-saved@browser.test');
    await form.locator('[aria-label="Password"]').fill('a-registration-password-2026');
    await form.locator('[aria-label="Invitation code (optional)"]').fill(invitationCode);
    await form.locator('input[name="consent"]').check();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    const store = await storage(page);
    const flat = [...Object.entries(store.local), ...Object.entries(store.session)];
    for (const secret of ['a-registration-password-2026', invitationCode, 'never-saved@browser.test']) {
      const found = flat.filter(([key, value]) => String(value).includes(secret) || key.includes(secret));
      expect(found.length === 0, 'an authentication field value must never be stored by the browser', { expected: `no stored entry containing ${secret}`, actual: describe(found) });
    }
    const authKeys = Object.keys(store.local).filter((key) => key.startsWith('nemoworld-draft:') && /auth/.test(key));
    expect(authKeys.length === 0, 'authentication forms must never create a draft record', { actual: describe(authKeys) });
    return `${flat.length} storage entries after the authentication form; no credential, invitation or consent value was written`;
  });

  await step('a signed-in session keeps no password, token or setup code in storage', async () => {
    await signIn(page, ACTORS.owner);
    const store = await storage(page);
    const flat = [...Object.entries(store.local), ...Object.entries(store.session)];
    for (const secret of [PASSWORD, ACTORS.owner.email]) {
      const found = flat.filter(([key, value]) => String(value).includes(secret) || key.includes(secret));
      expect(found.length === 0, 'the browser must not persist the account password or contact email', { expected: `no stored entry containing ${secret}`, actual: describe(found) });
    }
    const suspicious = flat.filter(([key, value]) => /password|passphrase|secret|token|credential|setup_code|invite|consent/i.test(key) || /password|passphrase|secret|setup_code/i.test(String(value)));
    expect(suspicious.length === 0, 'no storage entry may be named for a credential field', { actual: describe(suspicious) });
    const credentials = flat.filter(([, value]) => /^[0-9a-f]{64}$/.test(String(value)));
    expect(credentials.length === 0, 'no session or runtime credential may be written to browser storage', { actual: describe(credentials) });
    const sessionCookie = await page.evaluate(() => document.cookie);
    expect(!/world_session/.test(sessionCookie), 'the session cookie must stay HttpOnly and unreadable from script', { actual: describe(sessionCookie) });
    return `storage holds only ${flat.map(([key]) => key).join(', ') || 'nothing'}; the session cookie is HttpOnly`;
  });
  return 'no password, token, setup code, invitation or consent value reached browser storage';
});

// ---------------------------------------------------------------------------------------------
// Scenario 3 — private draft isolation between operators
// ---------------------------------------------------------------------------------------------

define('private-draft-isolation', async () => {
  const owner = await actor('owner');
  const stranger = await actor('stranger');
  const typed = 'A private garden plan for one operator';

  await step('the owner’s unfinished ordinary form is stored under the owner’s own key', async () => {
    await openApp(owner.page, ACTORS.owner);
    await openTab(owner.page, 'My characters');
    const form = owner.page.locator('form[data-draft-section="character-create"]');
    await form.locator('[aria-label="Character name"]').fill(typed);
    const store = await storage(owner.page);
    const keys = Object.keys(store.local).filter((key) => key.startsWith('nemoworld-draft:'));
    expect(keys.length === 1, 'typing in an ordinary form must create exactly one operator-keyed draft', { actual: describe(keys) });
    expect(keys[0] === `nemoworld-draft:operator:${state.fixtures.owner.id}:character-create`, 'the draft must be keyed by the operator account id', { expected: `nemoworld-draft:operator:${state.fixtures.owner.id}:character-create`, actual: describe(keys) });
    await owner.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(owner.page);
    await openTab(owner.page, 'My characters');
    const restored = await owner.page.locator('form[data-draft-section="character-create"] [aria-label="Character name"]').inputValue();
    expect(restored === typed, 'the owner must find their own draft restored after a refresh', { expected: typed, actual: describe(restored) });
    return `one draft key owned by ${state.fixtures.owner.id}; the value survived a reload`;
  });

  await step('a second operator sees no draft of the first', async () => {
    await openApp(stranger.page, ACTORS.stranger);
    await openTab(stranger.page, 'My characters');
    const store = await storage(stranger.page);
    const keys = Object.keys(store.local).filter((key) => key.startsWith('nemoworld-draft:'));
    expect(keys.length === 0, 'another operator must have no draft records of their own yet', { actual: describe(keys) });
    const value = await stranger.page.locator('form[data-draft-section="character-create"] [aria-label="Character name"]').inputValue();
    expect(value === '', 'another operator must never see the first operator’s unfinished text', { expected: 'an empty field', actual: describe(value) });
    const ownerStore = await storage(owner.page);
    expect(JSON.stringify(ownerStore.local).includes(typed), 'the owner’s draft must remain in the owner’s own browser only', { actual: 'the owner lost their own draft' });
    return 'the second operator’s context held no draft key and an empty field';
  });

  await step('a private research draft is stored on the server against its own operator only', async () => {
    const { mission, task } = await makeMission('Browser draft privacy fixture', 'draft');
    const storedMission = row('SELECT demo,status FROM missions WHERE id=?', mission.id);
    expect(storedMission?.demo === 0 && storedMission?.status === 'open', 'the draft fixture must be a real open mission', { expected: 'demo=0 and status=open', actual: describe(storedMission) });
    const claim = await apiExpect(fixtures().stranger, 'POST', '/claims', { task_id: task.id, agent_id: fixtures().characters.neighbour.id }, [201], { headers: { 'Idempotency-Key': 'browser-draft-claim' } });
    const saved = await apiExpect(fixtures().stranger, 'POST', '/drafts', { claim_id: claim.id, expected_revision: 0, format: 'evidence-form-v1', values: { artifact: 'Private draft artifact for the isolation check.' } });
    expect(saved.revision === 1, 'the private draft must be stored', { expected: 'revision 1', actual: describe(saved) });
    const stored = row('SELECT d.claim_id,c.account_id FROM claim_drafts d JOIN claims c ON c.id=d.claim_id WHERE d.claim_id=?', claim.id);
    expect(stored?.account_id === fixtures().stranger.id, 'the stored private draft must belong to the operator that wrote it', { expected: fixtures().stranger.id, actual: describe(stored) });
    const ownerView = await inPage(owner.page, '/drafts', { method: 'GET' });
    expect(ownerView.status === 200 && ownerView.body.drafts.length === 0, 'another operator must see no private drafts', { expected: 'an empty draft list', actual: describe(ownerView.body?.drafts?.length) });
    const strangerView = await inPage(stranger.page, '/drafts', { method: 'GET' });
    expect(strangerView.body.drafts.length === 1 && strangerView.body.drafts[0].claim_id === claim.id, 'the author must still see their own private draft', { expected: `one draft ${claim.id}`, actual: describe(strangerView.body?.drafts?.map((draft) => draft.claim_id)) });
    return `one stored private draft owned by ${stored.account_id}; the other operator’s list is empty`;
  });
  return 'browser drafts are keyed by operator and server drafts are private to their own operator';
});

// ---------------------------------------------------------------------------------------------
// Scenario 4 — refresh returns to the right form and restores focus
// ---------------------------------------------------------------------------------------------

define('refresh-and-focus-restoration', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const title = 'A remembered chain title';
  const steps = '[{"slug":"walk","title":"Walk somewhere","instructions":"Travel into a shared place.","output_name":"A recorded visit","source_kind":"shared_visit","target":1},{"slug":"sow","title":"Sow a row","instructions":"Plant a crop in your own garden.","output_name":"One planted crop","source_kind":"crop_plant","target":1,"prerequisite":"walk"}]';

  await step('an unfinished authored chain is remembered with its cursor', async () => {
  await openApp(page, ACTORS.admin);
    await openTab(page, 'Quest chains');
    await openDisclosure(page, 'Author a quest chain');
    const form = page.locator('form[data-draft-section="quest-author"]');
    await form.locator('[name="title"]').fill(title);
    await form.locator('[name="steps"]').fill(steps);
    await form.locator('[name="steps"]').focus();
    const focus = await page.evaluate(() => ({ name: document.activeElement?.name, section: document.activeElement?.closest('form')?.dataset.draftSection }));
    expect(focus.name === 'steps', 'the typed field must be the remembered control', { expected: 'steps', actual: describe(focus) });
    return `draft section ${focus.section}, remembered field ${focus.name}`;
  });

  await step('a refresh returns to the same form, opens its disclosure and focuses the field', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.waitForFunction(() => document.activeElement?.name === 'steps', null, { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    const state_ = await page.evaluate(() => {
      const control = document.activeElement;
      const form = control?.closest('form[data-draft-section]');
      const disclosures = [];
      for (let node = control?.closest('details'); node; node = node.parentElement?.closest('details')) disclosures.push({ title: node.querySelector('summary')?.textContent || '', open: node.open });
      return { tag: control?.tagName || null, name: control?.name || null, section: form?.dataset.draftSection || null, value: control?.value || '', disclosures, current: document.querySelector('#navigation button[aria-current="page"]')?.textContent || '' };
    });
    expect(state_.section === 'quest-author', 'the refresh must return to the authored chain form', { expected: 'quest-author', actual: describe(state_) });
    expect(state_.name === 'steps', 'the remembered field must be focused again after the controls exist', { expected: 'the steps field', actual: describe(state_) });
    expect(state_.value === steps, 'the remembered field must hold the saved text', { expected: steps, actual: describe(state_.value) });
    expect(state_.disclosures.length >= 1 && state_.disclosures.every((entry) => entry.open), 'every ancestor disclosure must be opened before the field is focused', { expected: 'each ancestor disclosure open', actual: describe(state_.disclosures) });
    expect(/Quest chains/.test(state_.current), 'the interface must return to the same section', { expected: 'Quest chains', actual: describe(state_.current) });
    return `${state_.current} · disclosure "${state_.disclosures[0]?.title}" open · focus on ${state_.name}`;
  });
  return 'the ordinary form, its disclosure and its cursor all survived the refresh';
});

// ---------------------------------------------------------------------------------------------
// Scenario 5 — first-person movement, drag-look and the aim line
// ---------------------------------------------------------------------------------------------

define('first-person-controls', async () => {
  const owner = await actor('owner');
  const page = owner.page;
  const walker = fixtures().characters.walker;

  await step('the resident enters the world in first person', async () => {
  await openApp(page, ACTORS.owner);
    await openTab(page, 'Open world');
    await page.locator('#view select[name="agent"]').selectOption(walker.id);
    await settle(page);
    await page.waitForTimeout(400);
    await page.locator('#view button[aria-label="First person camera that follows your resident"]').click();
    await page.waitForFunction(() => (document.querySelector('#world-reticle')?.textContent || '').startsWith('First person'), null, { timeout: PAGE_TIMEOUT_MS });
    const moved = row('SELECT x,y,z FROM agents WHERE id=?', walker.id);
    expect(moved, 'the resident must exist', { actual: describe(moved) });
    return `aim line starts with “First person” from tile ${moved.x},${moved.y}`;
  });

  const aim = () => page.locator('#world-reticle').textContent();

  await step('a drag rotates the view without moving the resident', async () => {
    const before = row('SELECT x,y,z,yaw,pitch FROM agents WHERE id=?', walker.id);
    const aimBefore = await aim();
    // The canvas is further down the page than the toggles, so it is brought into the viewport
    // first: a pointer drag has to land on the real canvas for the renderer to own the gesture.
    await page.locator('#world').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await page.locator('#world').boundingBox();
    const startX = Math.round(box.x + box.width / 2), startY = Math.round(box.y + box.height / 2);
    expect(startY > 8 && startY < 892 && startX > 8 && startX < 1432, 'the first-person canvas must be inside the viewport before the drag', { actual: `drag origin ${startX},${startY}` });
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (const [dx, dy] of [[-16, 0], [-32, -6], [-52, -12], [-74, -18]]) { await page.mouse.move(startX + dx, startY + dy); await page.waitForTimeout(60); }
    await page.mouse.up();
    const after = await waitForCondition(async () => {
      const current = row('SELECT x,y,z,yaw,pitch FROM agents WHERE id=?', walker.id);
      return current.yaw !== before.yaw || current.pitch !== before.pitch ? current : null;
    }, 'the dragged facing to be stored by the server');
    expect(after.x === before.x && after.y === before.y && after.z === before.z, 'a rotation must never move the resident', { expected: `${before.x},${before.y},z=${before.z}`, actual: `${after.x},${after.y},z=${after.z}` });
    const aimAfter = await waitForCondition(async () => { const text = await aim(); return text !== aimBefore ? text : null; }, 'the aim line to reflect the new facing');
    expect(/facing (north|south|east|west)/.test(aimAfter), 'the aim line must name the facing in plain text', { actual: describe(aimAfter) });
    expect(aimAfter.includes(`at ${after.x}, ${after.y}`), 'the aim line must keep naming the resident’s tile', { expected: `at ${after.x}, ${after.y}`, actual: describe(aimAfter) });
    state.notes.push(`first-person drag stored yaw ${before.yaw.toFixed(3)} -> ${after.yaw.toFixed(3)} without a position change`);
    return `yaw ${before.yaw.toFixed(3)} → ${after.yaw.toFixed(3)}, position ${after.x},${after.y} unchanged · aim line “${aimAfter.slice(0, 60)}…”`;
  });

  await step('a movement control walks exactly one tile and the aim line follows', async () => {
    const before = row('SELECT x,y FROM agents WHERE id=?', walker.id);
    let after = null;
    for (const direction of ['Move up', 'Move left', 'Move down', 'Move right']) {
      await page.locator(`#view button[aria-label="${direction}"]`).click();
      await page.waitForTimeout(500);
      const current = row('SELECT x,y FROM agents WHERE id=?', walker.id);
      const distance = Math.abs(current.x - before.x) + Math.abs(current.y - before.y);
      if (distance === 1) { after = current; expect(true, 'one step', {}); break; }
      expect(distance === 0, `a movement control must move exactly one tile (${direction})`, { expected: `one tile from ${before.x},${before.y}`, actual: `${current.x},${current.y}` });
    }
    expect(after, 'at least one first-person movement direction must be walkable from the starting tile', { expected: 'one tile of movement', actual: `${before.x},${before.y} blocked in all four directions` });
    const aimAfter = await waitForCondition(async () => { const text = await aim(); return text.includes(`at ${after.x}, ${after.y}`) ? text : null; }, 'the aim line to name the new tile');
    expect(aimAfter.startsWith('First person'), 'the aim line must still report the first-person view', { actual: describe(aimAfter.slice(0, 40)) });
    return `moved ${before.x},${before.y} → ${after.x},${after.y}; the accessible aim line names the new tile`;
  });
  return 'first person drove real movement and a real drag-look, with the aim line kept in step';
});

// ---------------------------------------------------------------------------------------------
// Scenario — the local input-to-confirmed-step latency instrument
//
// The suite already measures cross-client propagation (see `shared-presence-two-clients`): a click
// reaching the *other* browser's view. This scenario measures the interval the movement work is
// judged against instead: one local movement input to the interface naming the tile the server
// stored, for a run of consecutive single-tile steps. It is an instrument, not a performance gate.
// It asserts only what is deterministic — that every step was confirmed by the interface and by the
// server — and reports the figures in a note, so two runs can be compared without a slow run
// failing the suite.
//
// Environment, stated plainly: loopback HTTP, headless Chrome, one server process, one SQLite
// writer, no network, and no other client on the resident being measured. The figure is a lower
// bound for a supported user on a real device over a real network, and claims nothing about that.
// ---------------------------------------------------------------------------------------------

/** Consecutive single-tile steps measured inside one page-side loop. */
const MOVEMENT_LATENCY_SAMPLES = 24;
/**
 * A generous sanity bound, not a performance target. A step the interface never confirms means the
 * instrument lost a step, so it fails here rather than reporting a stall as latency. It is far above
 * every figure this suite has measured (a p95 of tens of milliseconds on an idle machine), because a
 * bound that a loaded machine can trip would make the suite flaky rather than informative.
 */
const MOVEMENT_LATENCY_CONFIRM_TIMEOUT_MS = 15_000;
/**
 * The shipped client holds motion requests 160 ms apart after the press it belongs to, and the
 * server refuses a second step inside 120 ms. Inputs are therefore spaced from the previous
 * request's own send time, not from the previous press: on the press's clock alone the client's hold
 * can push a request late and leave the next one inside the server's refusal window. The margin on
 * top is for the server's own processing jitter, which a loaded machine turns into a variable delay
 * between two requests that left the page well apart. Without this spacing the reported figure would
 * measure the client's own pacing, and the per-step dispatch time is reported so a reader can see
 * the pacing held.
 */
const MOVEMENT_LATENCY_PACE_MS = 400;
/**
 * How many inputs one step may take. Only a press the server's own throttle refused is re-issued,
 * and each such refusal is reported; a step that is never confirmed still fails the scenario.
 */
const MOVEMENT_LATENCY_INPUT_ATTEMPTS = 3;
/**
 * The measured route is a loop: this many single-tile steps out, the same number back, so the run
 * ends on the tile it started from and the instrument leaves the shared world as it found it.
 */
const MOVEMENT_LATENCY_ROUTE_STEPS = MOVEMENT_LATENCY_SAMPLES / 2;
/** The cardinal step that undoes another one, for the return leg of the loop. */
const OPPOSITE_DIRECTION = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });

/** The machine this run measured on, read at run time so the note names hardware instead of assuming it. */
function measurementHardware() {
  const model = cpus()[0]?.model || 'an unknown processor';
  return `${model}, ${cpus().length} cores, ${Math.round(totalmem() / 1024 ** 3)} GB, ${platform()} ${arch()} kernel ${release()}`;
}

/** The value `fraction` of the way through an ascending copy of `values`. */
function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/** Landmarks, portals and four long offsets: targets worth planning a Commons route to. */
function latencyRouteTargets(definition, start) {
  const targets = [];
  const add = (x, y) => {
    if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < definition.columns && y < definition.rows) targets.push({ x, y });
  };
  for (const landmark of definition.landmarks || []) add(landmark.x, landmark.y);
  for (const portal of definition.portals || []) add(portal.x, portal.y);
  for (const [dx, dy] of [[32, 0], [-32, 0], [0, 32], [0, -32], [24, 24], [-24, 24], [24, -24], [-24, -24]]) add(start.x + dx, start.y + dy);
  return targets;
}

/** One short readable form of a planned route, e.g. `8×E 4×S`, for the note. */
function compactRoute(route) {
  const letters = { up: 'N', right: 'E', down: 'S', left: 'W' };
  const runs = [];
  for (const direction of route) {
    const letter = letters[direction];
    const last = runs[runs.length - 1];
    if (last && last.letter === letter) last.count += 1;
    else runs.push({ letter, count: 1 });
  }
  return runs.map((run) => `${run.count}×${run.letter}`).join(' ');
}

define('movement-latency', async () => {
  const owner = await actor('owner');
  const page = owner.page;
  const walker = fixtures().characters.walker;
  const CARDINAL_STEPS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  const CONTROL_DIRECTIONS = ['up', 'left', 'down', 'right'];
  const tileName = (tile) => (tile ? `${tile.x},${tile.y}` : 'no tile named');
  // The Commons is where this instrument measures: an authored world a resident walks without a
  // plot of its own, and the one with long walkable routes out of the arrival plaza.
  await sendToCommons(fixtures().owner, walker.id);

  let plan = null;
  await step('the resident enters the Commons in first person with a planned walkable route', async () => {
    await openApp(page, ACTORS.owner);
    await openTab(page, 'Open world');
    await page.locator('#view select[name="agent"]').selectOption(walker.id);
    await settle(page);
    await page.waitForTimeout(400);
    // This operator's browser keeps its last camera choice, so first person is pressed only when it
    // is not already on: the instrument needs the first-person aim line, not a camera toggle.
    const firstPerson = page.locator('#view button[aria-label="First person camera that follows your resident"]');
    if (await firstPerson.getAttribute('aria-pressed') !== 'true') await firstPerson.click();
    await page.waitForFunction(() => (document.querySelector('#world-reticle')?.textContent || '').startsWith('First person'), null, { timeout: PAGE_TIMEOUT_MS });
    const resident = row('SELECT id,world_id,x,y,yaw,status FROM agents WHERE id=?', walker.id);
    expect(resident?.status === 'active', 'the measured resident must be an active stored resident', { expected: 'an active resident row', actual: describe(resident) });
    expect(resident.world_id === 'commons', 'the instrument must measure in the Commons, where the long routes are', { expected: 'commons', actual: describe(resident.world_id) });
    const aim = (await page.locator('#world-reticle').textContent())?.trim() || '';
    expect(aim.includes(`at ${resident.x}, ${resident.y}`), 'the aim line must name the resident’s stored tile before the first input', { expected: `at ${resident.x}, ${resident.y}`, actual: describe(aim.slice(0, 140)) });
    // A first-person control walks the way the client's own facing points, so a planned cardinal
    // route is translated through the same stored yaw the client read at selection. The client's
    // own facing label is checked against that yaw first, because the label is what the interface
    // says and the translation is only sound while the two agree.
    const yaw = Number.isFinite(resident.yaw) ? resident.yaw : Math.PI / 4;
    expect(aim.includes(`facing ${facingLabel(yaw)}`), 'the aim line and the stored yaw must name the same facing', { expected: `facing ${facingLabel(yaw)}`, actual: describe(aim.slice(0, 140)) });
    const controlForCardinal = new Map();
    for (const control of CONTROL_DIRECTIONS) {
      const cardinal = cameraWalkDirection(control, yaw);
      if (!controlForCardinal.has(cardinal)) controlForCardinal.set(cardinal, control);
    }
    const definition = getWorldDefinition(resident.world_id);
    const objects = rows('SELECT type,x,y FROM world_objects WHERE world_id=?', resident.world_id);
    let outbound = null;
    for (const target of latencyRouteTargets(definition, resident)) {
      const candidate = planWalk(definition, { x: resident.x, y: resident.y }, target, { objects });
      if (!candidate || candidate.length < MOVEMENT_LATENCY_ROUTE_STEPS) continue;
      // A facing exactly on a diagonal resolves two controls to one cardinal step, leaving one
      // cardinal unreachable; a route that never needs it is still a valid route.
      if (!candidate.every((direction) => controlForCardinal.has(direction))) continue;
      if (!outbound || candidate.length > outbound.length) outbound = candidate;
    }
    expect(outbound, `a planned route of at least ${MOVEMENT_LATENCY_ROUTE_STEPS} walkable single-tile steps must exist where the resident stands`, { expected: `${MOVEMENT_LATENCY_ROUTE_STEPS} planned steps from ${resident.x},${resident.y}`, actual: describe({ world: resident.world_id, planned: latencyRouteTargets(definition, resident).length, facing: facingLabel(yaw) }) });
    // Out and back: the measured run ends on the tile it started from. Walking a resident 24 tiles
    // away and leaving it there would change what every later scenario shares — the server's
    // observation window is only 20 × 14 tiles, so a resident parked outside it is invisible to the
    // other browser — and an instrument must not edit the fixture it measures in.
    const leg = outbound.slice(0, MOVEMENT_LATENCY_ROUTE_STEPS);
    const measured = [...leg, ...[...leg].reverse().map((direction) => OPPOSITE_DIRECTION[direction])];
    let cursor = { x: resident.x, y: resident.y };
    const stepTiles = measured.map((cardinal) => {
      const [dx, dy] = CARDINAL_STEPS[cardinal];
      cursor = { x: cursor.x + dx, y: cursor.y + dy };
      return { control: controlForCardinal.get(cardinal), cardinal, tile: { ...cursor } };
    });
    plan = { worldId: resident.world_id, worldName: definition.name, startTile: { x: resident.x, y: resident.y }, cardinals: measured, stepTiles };
    return `${definition.name} from ${tileName(plan.startTile)}: ${leg.length} steps out and ${leg.length} back (${compactRoute(measured)}), returning to the starting tile`;
  });

  let measured = null;
  // Every movement request the page actually issued, seen from this side of the connection. It is
  // evidence, not timing: one press must become exactly one `POST …/move`, and a step that was never
  // confirmed has to say whether the input reached the wire at all.
  const issuedMoves = [];
  const recordIssuedMove = (request) => { if (/\/move(\?|$)/.test(request.url())) issuedMoves.push(request.url().replace(/^https?:\/\/[^/]+/, '')); };
  page.on('request', recordIssuedMove);
  await step(`the in-page loop times ${MOVEMENT_LATENCY_SAMPLES} consecutive confirmed steps`, async () => {
    // The whole loop runs inside one page.evaluate, so no Node ↔ browser round trip sits inside a
    // measured interval. The input is the shipped movement control this suite already drives — or,
    // when the workspace has rendered that control disabled, the walk key, which reaches the same
    // intent through the one keydown handler — and the confirmation is the accessible aim line
    // naming the tile the server stored, not an optimistic paint, which this path does not have.
    measured = await page.evaluate(async (input) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const now = () => performance.now();
      const POSITION = /· at (\d+), (\d+)(?:, layer (\d+))?/;
      const readLine = () => document.querySelector('#world-reticle')?.textContent || '';
      const readTile = () => {
        const match = POSITION.exec(readLine());
        return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
      };
      // The newest completed `POST …/move` resource entry says how much of each interval was the
      // request leaving the page, how much was the server answering, and how much was the interface
      // after that. Nothing is patched to get it; it is already timed by the browser.
      try { performance.clearResourceTimings(); performance.setResourceTimingBufferSize(1000); } catch { /* a diagnostic, not the measurement */ }
      const moveEntry = (since) => {
        let newest = null;
        for (const entry of performance.getEntriesByType('resource')) {
          if (!entry.name.includes('/move') || entry.startTime < since) continue;
          if (!newest || entry.startTime > newest.startTime) newest = entry;
        }
        return newest;
      };
      // Every request the page made since a press, so a step that was never confirmed says whether
      // the input left the page at all and, if it did, which endpoint carried it.
      const requestsSince = (since) => performance.getEntriesByType('resource')
        .filter((entry) => entry.startTime >= since)
        .map((entry) => ({ path: entry.name.replace(/^https?:\/\/[^/]+/, ''), ms: Number((entry.startTime - since).toFixed(1)) }));
      // The aim line is rewritten by the same paint that applies the server's tile, so the microtask
      // that follows the mutation is the earliest moment the interface names that tile.
      const waitForTile = (wanted, timeoutMs, since) => new Promise((resolve) => {
        let settled = false, timer = null, observer = null;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          observer?.disconnect();
          if (timer !== null) clearInterval(timer);
          resolve(result);
        };
        const check = () => {
          const tile = readTile();
          if (tile && tile.x === wanted.x && tile.y === wanted.y) { settle({ tile, at: now() }); return; }
          // The server's own movement throttle answers in milliseconds, so a refused input is settled
          // at once instead of being waited out as though it were a slow step.
          if (moveEntry(since)?.responseStatus === 429) { settle({ tile, at: now(), refused: true }); return; }
          if (now() - since >= timeoutMs) settle({ tile, at: now(), timedOut: true });
        };
        observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        timer = setInterval(check, 5);
        check();
      });
      // An independent read of the server's own record for this step, taken after the interface was
      // timed, so the report never has to take the interface's word for the tile.
      const auditTile = async (tile) => {
        // No camera hint: the server centres an authenticated read on the resident being read, and a
        // hint would move the 20 × 14 observation window off the very resident this is asking about.
        const query = new URLSearchParams({ view: 'voxel', world_id: input.worldId, agent_id: input.agentId });
        const body = await fetch(`/api/v1/world?${query}`, { credentials: 'same-origin' }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
        const found = [...(body?.participants || []), ...(body?.agents || [])].find((item) => item?.id === input.agentId) || null;
        return found ? { x: found.x, y: found.y } : null;
      };

      const samples = [];
      // Presses the server's own movement throttle refused before a step was measured. They are
      // reported rather than hidden: a refusal means that input never became a step.
      const refusedPresses = [];
      // Paced from the previous request's own send time, not from the previous press. The shipped
      // client holds motion requests 160 ms apart after the press, so pacing from the press can let
      // the client's own hold compress two sends closer than the server's 120 ms refusal window.
      let lastSentAt = -Infinity;
      for (let index = 0; index < input.steps.length; index++) {
        const planned = input.steps[index];
        let sample = null;
        for (let attempt = 0; attempt < input.maxAttempts && !sample; attempt += 1) {
          const idle = input.paceMs - (now() - lastSentAt);
          if (idle > 0) await sleep(idle);
          const button = document.querySelector(`#view button[aria-label="Move ${planned.control}"]`);
          if (!button) return { error: `no movement control labelled “Move ${planned.control}” was reachable`, samples, refusedPresses };
          const before = readTile();
          // The control's own state as the press finds it: a disabled control silently refuses
          // `click()`, and more than one match would mean the press reached a control the interface
          // had replaced rather than the live one.
          const controlAtPress = {
            disabled: Boolean(button.disabled), connected: Boolean(button.isConnected),
            matches: document.querySelectorAll(`#view button[aria-label="Move ${planned.control}"]`).length,
          };
          // The identity a queued move carries: a press the page accepted and then dropped would show
          // here as a changed selection or world between the press and the wait.
          const contextAtPress = { selected: window.__nemoworld?.selected?.() ?? null, worldId: window.__nemoworld?.worldId?.() ?? null };
          // One input, reported by name. The movement control is the shipped control this suite
          // already drives, but the workspace briefly renders its own controls disabled while its
          // three-second viewport poll swaps the agent list, and a disabled control refuses `click()`
          // without a word. The walk key reaches the same movement intent through the one keydown
          // handler, so it carries the input instead and the sample says so.
          const press = () => {
            let dispatched = false;
            const recordClick = () => { dispatched = true; };
            button.addEventListener('click', recordClick, { capture: true });
            button.click();
            button.removeEventListener('click', recordClick, { capture: true });
            if (dispatched) return 'control';
            const key = { up: 'w', left: 'a', down: 's', right: 'd' }[planned.control];
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            return `key ${key}`;
          };
          const t0 = now();
          const inputMedium = press();
          const confirmation = await waitForTile(planned.tile, input.confirmTimeoutMs, t0);
          const entry = moveEntry(t0);
          lastSentAt = entry ? entry.requestStart : t0;
          if ((confirmation.refused || confirmation.timedOut) && entry?.responseStatus === 429 && attempt < input.maxAttempts - 1) {
            // The server's own throttle refused the step, exactly as the suite treats it elsewhere.
            // This input never became a step, so it is not a sample: the next attempt is timed afresh.
            refusedPresses.push({ index, attempt, control: planned.control });
            continue;
          }
          // What the client itself holds and what the server says, both read after the interval was
          // timed: when a step is not confirmed these are what say whether the step was refused,
          // landed elsewhere, or simply never left the page.
          const clientTile = (() => {
            const held = window.__nemoworld?.world?.()?.participants?.find((item) => item?.id === input.agentId);
            return held ? { x: held.x, y: held.y, yaw: held.yaw } : null;
          })();
          sample = {
            index, control: planned.control, cardinal: planned.cardinal, wanted: planned.tile, before, attempt,
            confirmed: confirmation.tile || null, timedOut: Boolean(confirmation.timedOut), ms: confirmation.at - t0,
            dispatchMs: entry ? entry.requestStart - t0 : null,
            responseMs: entry ? entry.responseEnd - t0 : null,
            status: entry?.responseStatus ?? null,
            inputMedium,
            controlAtPress,
            context: { atPress: contextAtPress, atResult: { selected: window.__nemoworld?.selected?.() ?? null, worldId: window.__nemoworld?.worldId?.() ?? null } },
            client: clientTile, audit: await auditTile(planned.tile), aim: readLine().slice(0, 240),
            // Only kept for a step that was not confirmed: it is the difference between an input the
            // page never sent and one it sent to an endpoint other than the movement route.
            requests: confirmation.timedOut ? requestsSince(t0) : null,
            controlDisabled: confirmation.timedOut ? Boolean(document.querySelector(`#view button[aria-label="Move ${planned.control}"]`)?.disabled) : null,
          };
        }
        samples.push(sample);
        // A lost step, or a server that disagrees about the tile, ends the run where it happened:
        // carrying on would only report a latency for a walk that had stopped being real.
        const named = sample.confirmed && sample.confirmed.x === planned.tile.x && sample.confirmed.y === planned.tile.y;
        const audited = !sample.audit || (sample.audit.x === planned.tile.x && sample.audit.y === planned.tile.y);
        if (sample.timedOut || !named || !audited) break;
      }
      return { samples, refusedPresses };
    }, {
      steps: plan.stepTiles, paceMs: MOVEMENT_LATENCY_PACE_MS, confirmTimeoutMs: MOVEMENT_LATENCY_CONFIRM_TIMEOUT_MS,
      maxAttempts: MOVEMENT_LATENCY_INPUT_ATTEMPTS,
      worldId: plan.worldId, agentId: walker.id,
    });

    expect(!measured.error, 'the measurement loop must reach every planned movement control', { actual: describe(measured.error) });
    for (const [index, sample] of measured.samples.entries()) {
      expect(!sample.timedOut, `step ${index} must be confirmed inside the ${MOVEMENT_LATENCY_CONFIRM_TIMEOUT_MS} ms sanity bound`, { expected: tileName(sample.wanted), actual: tileName(sample.confirmed), detail: describe({ input: sample.inputMedium, control: sample.control, cardinal: sample.cardinal, from: tileName(sample.before), clientHeld: describe(sample.client), serverHeld: describe(sample.audit), aimLine: sample.aim, controlAtPress: describe(sample.controlAtPress), controlAtTimeout: sample.controlDisabled, context: describe(sample.context), requestsSincePress: describe(sample.requests), moveTiming: describe({ dispatchMs: sample.dispatchMs, responseMs: sample.responseMs }), movementRequestsIssued: `${issuedMoves.length} for ${index + 1} presses` }) });
      expect(sample.confirmed && sample.confirmed.x === sample.wanted.x && sample.confirmed.y === sample.wanted.y, `step ${index} must make the interface name the planned tile`, { expected: tileName(sample.wanted), actual: tileName(sample.confirmed) });
      expect(sample.audit && sample.audit.x === sample.wanted.x && sample.audit.y === sample.wanted.y, `step ${index} must be confirmed by the server itself, not only by the interface`, { expected: tileName(sample.wanted), actual: describe(sample.audit) });
      const named = index === 0 ? plan.startTile : measured.samples[index - 1].confirmed;
      expect(sample.before && sample.before.x === named.x && sample.before.y === named.y, `step ${index} must start from the tile the interface last named`, { expected: tileName(named), actual: tileName(sample.before) });
      const advanced = Math.abs(sample.wanted.x - sample.before.x) + Math.abs(sample.wanted.y - sample.before.y);
      expect(advanced === 1, `step ${index} must advance exactly one tile: no step lost, no refusal`, { expected: `one tile from ${tileName(sample.before)}`, actual: tileName(sample.wanted) });
    }
    expect(measured.samples.length === MOVEMENT_LATENCY_SAMPLES, `all ${MOVEMENT_LATENCY_SAMPLES} planned steps must be measured`, { expected: MOVEMENT_LATENCY_SAMPLES, actual: measured.samples.length });

    const durations = measured.samples.map((sample) => sample.ms);
    const statistics = { count: durations.length, min: Math.min(...durations), median: median(durations), p95: percentile(durations, 0.95), max: Math.max(...durations) };
    const finite = (key) => measured.samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
    const dispatch = finite('dispatchMs');
    const response = finite('responseMs');
    // How much of each interval came after the server's own answer: the read of the stored world
    // that the interface paints from. The live feed can deliver that tile too, so this split is
    // reported as a median and is allowed to be small or negative for a single step.
    const afterwards = measured.samples.filter((sample) => Number.isFinite(sample.responseMs)).map((sample) => sample.ms - sample.responseMs);
    const round = (value) => Number(value.toFixed(2));
    const hardware = measurementHardware();
    // Which input carried the samples, and how often the workspace had disabled its own movement
    // control at the moment of the press. Both are reported because the interval is the same either
    // way and a reader deserves to know the input was not always the same control.
    const byControl = measured.samples.filter((sample) => sample.inputMedium === 'control').length;
    const disabledControls = measured.samples.filter((sample) => sample.controlAtPress?.disabled).length;
    state.notes.push([
      `input → confirmed step, timed in the page: ${plan.worldName}, ${MOVEMENT_LATENCY_ROUTE_STEPS} steps out from ${tileName(plan.startTile)} and the same back (${compactRoute(plan.cardinals)})`,
      `min ${round(statistics.min)} ms · median ${round(statistics.median)} ms · p95 ${round(statistics.p95)} ms · max ${round(statistics.max)} ms · n=${statistics.count}`,
      `split: input → request left the page median ${dispatch.length ? round(median(dispatch)) : 'n/a'} ms · input → POST /move answered median ${response.length ? round(median(response)) : 'n/a'} ms · that answer → the aim line median ${afterwards.length ? round(median(afterwards)) : 'n/a'} ms · no earlier optimistic paint exists on this path: the first tile the interface can name is the server’s`,
      `inputs: ${byControl} of ${statistics.count} carried by the movement control and ${statistics.count - byControl} by the walk key, which is the same handler and the same view-relative step; the workspace’s own control was disabled at the press in ${disabledControls} of them · the server’s own movement throttle refused ${measured.refusedPresses.length} press${measured.refusedPresses.length === 1 ? '' : 'es'}, each re-issued and never counted as a step`,
      `measured on ${hardware}, load average ${loadavg().map((value) => value.toFixed(1)).join('/')} at the end of the run; loopback HTTP, headless Chrome, one server process, one SQLite writer, no network, no other client on this resident — a lower bound on the network it crosses, and not a supported-user or real-device latency claim`,
    ].join(' · '));
    return `n=${statistics.count} · min ${round(statistics.min)} ms · median ${round(statistics.median)} ms · p95 ${round(statistics.p95)} ms · max ${round(statistics.max)} ms · ${plan.worldName} ${compactRoute(plan.cardinals)} from ${tileName(plan.startTile)}`;
  });
  page.off('request', recordIssuedMove);

  await step('the resident stands on the tile it started from and the server agrees', async () => {
    const stored = row('SELECT world_id,x,y,status FROM agents WHERE id=?', walker.id);
    const last = measured.samples[measured.samples.length - 1].confirmed;
    expect(stored.world_id === plan.worldId && stored.x === last.x && stored.y === last.y, 'the stored resident must stand on the last tile the interface named', { expected: describe({ world_id: plan.worldId, x: last.x, y: last.y }), actual: describe(stored) });
    expect(stored.x === plan.startTile.x && stored.y === plan.startTile.y, 'the measured loop must leave the resident on its starting tile, so no later scenario shares a moved fixture', { expected: tileName(plan.startTile), actual: `${stored.x},${stored.y}` });
    expect(stored.status === 'active', 'the measured walk must not have changed the resident’s own state', { expected: 'active', actual: describe(stored.status) });
    // Exactly one movement request per press: the measured presses plus the ones the server's own
    // movement throttle refused and the instrument re-issued. Nothing dropped, nothing doubled.
    const expectedMoves = measured.samples.length + measured.refusedPresses.length;
    const issued = await waitForCondition(() => issuedMoves.length >= expectedMoves ? issuedMoves.length : null, 'the movement requests for the measured steps to appear on the connection', { timeout: 2000, interval: 20 });
    expect(issued === expectedMoves, 'every press must have carried exactly one movement request, so no input was dropped and none was doubled', { expected: expectedMoves, actual: describe({ issued, samples: measured.samples.length, reIssuedAfterThrottle: measured.refusedPresses.length, paths: [...new Set(issuedMoves)] }) });
    return `agents row back at ${stored.x},${stored.y} in ${stored.world_id} after ${measured.samples.length} confirmed steps, each carried by one movement request`;
  });

  return `the ${MOVEMENT_LATENCY_SAMPLES}-step input → confirmed-step instrument reported min/median/p95/max in the notes; every step was confirmed by the interface and by the server`;
});

// ---------------------------------------------------------------------------------------------
// Scenario 6 — country ambassadors
// ---------------------------------------------------------------------------------------------

define('country-ambassadors', async () => {
  const owner = await actor('owner');
  const page = owner.page;

  await step('the directory is searchable and the profile carries the country context', async () => {
  await openApp(page, ACTORS.owner);
    await openTab(page, 'Regions & ambassadors');
    await waitForText(page, 'matching of 248 catalog entries');
    const form = page.locator('#ambassador-directory form');
    await form.locator('[aria-label="Search"]').fill('Nepal');
    await form.getByRole('button', { name: 'Find a country ambassador' }).click();
    await settle(page);
    const card = page.locator('#ambassador-directory .card', { hasText: 'NPL' }).first();
    await card.getByRole('button', { name: 'Open profile', exact: true }).click();
    const profile = page.locator('#country-ambassador-profile');
    await profile.waitFor({ state: 'visible' });
    const text = await profile.textContent();
    expect(/country:NPL/.test(text), 'the profile must name the ambassador’s own generated venue', { actual: text?.slice(0, 200) });
    expect(/Nepal · country ambassador/.test(text), 'the profile must be the country profile', { actual: text?.slice(0, 120) });
    return 'GET /ambassador?id=amb-NPL rendered the country profile and its country venue';
  });

  await step('a country-context conversation is stored privately against the operator', async () => {
    const before = count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.owner.id);
    await page.locator('#country-ambassador-profile').getByRole('button', { name: 'Talk to this ambassador', exact: true }).click();
    const dialog = page.locator('dialog.mayor-dialog');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[aria-label="Your question"]').fill('Help me research agriculture.');
    await dialog.getByRole('button', { name: /^Ask / }).click();
    await dialog.locator('.mayor-answer').first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const answer = await dialog.locator('.mayor-answer').first().textContent();
    expect(/fictional research guide/i.test(answer), 'the answer must state that the ambassador is a fictional guide', { actual: describe(answer?.slice(0, 160)) });
    const stored = row('SELECT account_id,ambassador_id,question,answer FROM ambassador_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 1', state.fixtures.owner.id);
    const after = count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.owner.id);
    expect(after === before + 1, 'the conversation must be stored in the temporary database', { expected: `${before + 1} stored turns`, actual: after });
    expect(stored?.ambassador_id === 'amb-NPL', 'the stored turn must name the ambassador', { actual: describe(stored?.ambassador_id) });
    const otherOperator = count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.stranger.id);
    expect(otherOperator === 0, 'another operator must hold no conversation with this ambassador', { actual: `stranger turns=${otherOperator}` });
    return `one private turn stored for ${stored.account_id} with amb-NPL · the other operator holds ${otherOperator}`;
  });

  await step('a country mismatch is refused and writes nothing', async () => {
    const before = count('SELECT COUNT(*) AS n FROM ambassador_conversations');
    const refused = await inPage(page, '/ambassadors/talk', { body: { ambassador_id: 'amb-NPL', question: 'Agriculture exports?', country_code: 'BD' } });
    expect(refused.status === 400, 'a country context that is not the ambassador’s country must be refused', { expected: 'HTTP 400', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(/mismatch/i.test(refused.body?.error || ''), 'the refusal must name the country mismatch', { actual: describe(refused.body?.error) });
    expect(count('SELECT COUNT(*) AS n FROM ambassador_conversations') === before, 'a refused conversation must write nothing', { expected: `${before} turns`, actual: count('SELECT COUNT(*) AS n FROM ambassador_conversations') });
    return `400 ${refused.body.error}`;
  });
  return 'the directory, profile, country-context answer and the mismatch refusal all passed through the interface';
});

// ---------------------------------------------------------------------------------------------
// Scenario 7 — plot assignment and blueprint preview, apply and remove
// ---------------------------------------------------------------------------------------------

async function enterFrontierAs(page, agentId) {
  await openTab(page, 'Open world');
  const select = page.locator('#view select[name="agent"]');
  if (await select.count()) { await select.selectOption(agentId); await settle(page); await page.waitForTimeout(400); }
  const inFrontier = async () => /Build the frontier/.test((await page.locator('#view').textContent().catch(() => '')) || '');
  // Entering the frontier walks the resident to a passage and travels through it; either step can be
  // refused by the server's own movement throttle under load, so the entry is resumed a bounded
  // number of times rather than left half-finished.
  const deadline = Date.now() + 100_000;
  let retries = 0;
  while (!await inFrontier() && Date.now() < deadline) {
    const entering = page.locator('#view').getByRole('button', { name: 'Enter the frontier', exact: true });
    if (!await entering.count()) break;
    await entering.first().click();
    await page.waitForFunction(() => /Build the frontier/.test(document.querySelector('#view')?.textContent || ''), null, { timeout: Math.min(45_000, Math.max(2000, deadline - Date.now())) }).catch(() => {});
    if (await inFrontier()) break;
    const notice = ((await page.locator('#notice').textContent().catch(() => '')) || '').trim();
    if (!throttleRefusal(notice)) break;
    retries += 1;
    console.log('        walk retry       the server’s own movement throttle refused a step; resuming the walk into the frontier');
    await page.waitForTimeout(800);
  }
  const view = await page.locator('#view').textContent();
  expect(/Build the frontier/.test(view), 'the frontier panel must be on screen', { expected: 'the frontier panel', actual: view?.slice(0, 200) });
  if (retries) state.notes.push(`entering the frontier was resumed ${retries} time(s) after the server’s own movement throttle refused a step`);
  return agentId;
}

/**
 * Building actions are throttled to one per 200 ms by the server, so a blueprint click waits its
 * turn and retries once when the server answers with its own rate-limit refusal.
 */
async function frontierClick(page, locator) {
  let notice = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForTimeout(attempt === 0 ? 700 : 600);
    await locator.click();
    await page.waitForTimeout(500);
    notice = (await page.locator('#notice').textContent().catch(() => ''))?.trim() || '';
    if (!/between building actions/i.test(notice)) return notice;
  }
  return notice;
}

/**
 * The server's own movement throttle, in the words the interface repeats. Movement and travel are
 * limited to one action per 120 ms (`src/spaces.js`); a walk driven through the interface paces
 * itself at 160 ms, but when the server processes two steps back to back — which happens under load
 * — it refuses the later one with a 429 and the client's walk stops where it stands. Only these
 * documented refusals are ever resumed, a bounded number of times, and every retry is counted.
 */
const MOVEMENT_THROTTLE = /Move more slowly|Travel more slowly/i;
export const throttleRefusal = (notice) => MOVEMENT_THROTTLE.test(String(notice || ''));

/**
 * Clicks "Walk to plot" and waits until the resident actually stands inside the plot. A walk stopped
 * by the documented movement throttle is resumed from where the resident stands, instead of letting
 * the whole scenario collapse because one step was refused.
 */
async function walkIntoPlot(page, agentId, plotId, parcel, { timeout = 100_000 } = {}) {
  const deadline = Date.now() + timeout;
  const inside = (position) => Boolean(position) && position.x >= parcel.x && position.x < parcel.x + parcel.width && position.y >= parcel.y && position.y < parcel.y + parcel.height;
  let retries = 0;
  let movementThrottle = false;
  const onResponse = (response) => {
    if (response.status() !== 429) return;
    try {
      if (new URL(response.url()).pathname.endsWith('/api/v1/move')) movementThrottle = true;
    } catch { /* A malformed diagnostic URL cannot affect the walk result. */ }
  };
  page.on('response', onResponse);
  try {
    for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
      if (attempt > 0) {
        retries += 1;
        console.log(`        walk retry       the server’s own movement throttle refused a step; resuming the walk into ${plotId}`);
        await page.waitForTimeout(800);
      }
      movementThrottle = false;
      await page.locator('#plot-detail').getByRole('button', { name: 'Walk to plot', exact: true }).click();
      const reached = await waitForCondition(() => {
        if (movementThrottle) return 'movement-throttle';
        return inside(row('SELECT x,y,world_id FROM agents WHERE id=?', agentId)) ? 'inside' : null;
      }, 'the resident to step into the plot', { timeout: Math.min(30_000, Math.max(2000, deadline - Date.now())) }).catch(() => null);
      if (reached === 'inside') {
        const position = await waitForResidentToSettle(agentId);
        if (inside(position)) {
          if (retries) state.notes.push(`the walk into ${plotId} was resumed ${retries} time(s) after the server’s own movement throttle refused a step`);
          return position;
        }
      }
      const notice = ((await page.locator('#notice').textContent().catch(() => '')) || '').trim();
      if (reached !== 'movement-throttle' && !throttleRefusal(notice)) {
        throw new BrowserSuiteFailure(`the walk into ${plotId} stopped short of the plot`, { expected: `a tile inside ${plotId}`, actual: `${describe(row('SELECT x,y,world_id FROM agents WHERE id=?', agentId))}; the interface said “${notice}”` });
      }
    }
  } finally {
    page.off('response', onResponse);
  }
  throw new BrowserSuiteFailure(`the resident never reached ${plotId}`, { expected: `a tile inside ${plotId}`, actual: describe(row('SELECT x,y,world_id FROM agents WHERE id=?', agentId)) });
}

/** Waits until the resident stops moving, so a click that depends on its tile runs after the walk. */
async function waitForResidentToSettle(agentId, { timeout = 90_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null, stableSince = Date.now();
  while (Date.now() < deadline) {
    const position = row('SELECT x,y,world_id FROM agents WHERE id=?', agentId);
    const key = position ? `${position.world_id}:${position.x},${position.y}` : null;
    if (key !== last) { last = key; stableSince = Date.now(); } else if (Date.now() - stableSince > 2000) return position;
    await sleep(400);
  }
  throw new BrowserSuiteFailure('the resident never stopped moving', { actual: describe(last) });
}

define('plot-and-blueprints', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const pathfinder = fixtures().characters.pathfinder;
  const worldId = 'frontier:0:0';
  let plotId = null;

  await step('the steward enters the frontier and the land panel offers a plot', async () => {
  await openApp(page, ACTORS.admin);
    await enterFrontierAs(page, pathfinder.id);
    const detail = page.locator('#plot-detail');
    await detail.waitFor({ state: 'visible' });
    await page.waitForFunction(() => (document.querySelector('#plot-detail .plot-address')?.textContent || '').startsWith('plot:'), null, { timeout: PAGE_TIMEOUT_MS });
    plotId = (await detail.locator('.plot-address').first().textContent())?.trim();
    expect(/^plot:/.test(plotId || ''), 'the land panel must name the plot it selected', { actual: describe(plotId) });
    expect(count('SELECT COUNT(*) AS n FROM land_stewardships WHERE plot_id=?', plotId) === 0, 'the offered plot must start unstewarded', { actual: 'the plot already had a steward' });
    return `the panel offered ${plotId} in ${worldId}`;
  });

  await step('stewardship is recorded by the server for this operator', async () => {
    const purpose = 'A browser acceptance learning garden';
    await page.locator('#plot-detail [aria-label="What will this place do?"]').fill(purpose);
    await page.locator('#plot-detail').getByRole('button', { name: 'Steward this plot', exact: true }).click();
    // An incremental world repaint can replace the form before its write has finished. Wait for
    // the authoritative record; disappearance of a button is not evidence of saved stewardship.
    const stored = await waitForCondition(async () => row('SELECT s.plot_id,s.account_id,s.purpose FROM land_stewardships s WHERE s.plot_id=?', plotId), 'the server to save the clicked stewardship');
    expect(stored, 'the stewardship must be stored', { expected: `a land_stewardships row for ${plotId}`, actual: describe(stored) });
    expect(stored.account_id === state.fixtures.admin.id, 'the stewardship must belong to the signed-in operator', { expected: state.fixtures.admin.id, actual: describe(stored.account_id) });
    expect(stored.purpose === purpose, 'the stored purpose must be the one typed in the browser', { expected: purpose, actual: describe(stored.purpose) });
    return `land_stewardships row for ${plotId} owned by ${stored.account_id}, purpose “${stored.purpose}”`;
  });

  await step('the steward walks into the plot and previews a blueprint without writing', async () => {
    const blocksBefore = count('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', worldId);
    const parcel = row('SELECT x,y,width,height FROM land_parcels WHERE id=?', plotId);
    expect(parcel, 'the stewarded plot must exist in the land registry', { actual: describe(parcel) });
    const position = await walkIntoPlot(page, pathfinder.id, plotId, parcel);
    const readReport = async () => (await page.locator('#blueprint-report').textContent().catch(() => '')) || '';
    await frontierClick(page, page.locator('#view button[data-blueprint-preview]'));
    const first = await waitForCondition(async () => {
      const text = await readReport();
      return /new blocks/.test(text) ? text : null;
    }, 'the blueprint preview report to appear');
    // The panel chooses the plot’s whole first cell as its anchor, which may sit further than the
    // build range allows from where the resident actually stopped. The suite moves the anchor beside
    // the resident and previews again: a preview writes nothing either way.
    const footprint = /(\d+) × (\d+) m footprint/.exec(first.replace(/\s+/g, ' '));
    const width = Number(footprint?.[1] ?? 3), depth = Number(footprint?.[2] ?? 2);
    const inside = (candidate) => candidate.x >= parcel.x && candidate.y >= parcel.y &&
      candidate.x + width <= parcel.x + parcel.width && candidate.y + depth <= parcel.y + parcel.height;
    const covers = (candidate) => position.x >= candidate.x && position.x < candidate.x + width && position.y >= candidate.y && position.y < candidate.y + depth;
    const anchor = [[1, 0], [0, 1], [1, 1], [-width, 0], [0, -depth], [-width, -depth], [-width, 1], [1, -depth]]
      .map(([dx, dy]) => ({ x: position.x + dx, y: position.y + dy }))
      .find((candidate) => inside(candidate) && !covers(candidate));
    expect(anchor, 'the plot must offer room beside the resident for the previewed footprint', { expected: `a ${width} × ${depth} footprint inside ${plotId} that does not cover ${position.x},${position.y}`, actual: describe(parcel) });
    await page.locator('#view input[name="blueprint_x"]').fill(String(anchor.x));
    await page.locator('#view input[name="blueprint_y"]').fill(String(anchor.y));
    await frontierClick(page, page.locator('#view button[data-blueprint-preview]'));
    const report = await waitForCondition(async () => {
      const text = await readReport();
      return /new blocks/.test(text) && !/Walk closer/.test(text) ? text : null;
    }, 'the repositioned blueprint preview to validate');
    const flat = report.replace(/\s+/g, ' ');
    console.log(`        preview          ${flat.slice(0, 200)}`);
    expect(/Every server rule passes for this position\./.test(report), 'the preview must confirm that every server rule passes at this position', { actual: flat.slice(0, 400) });
    expect(/Inside your plot/.test(report), 'the preview must confirm the position is inside the steward’s plot', { actual: flat.slice(0, 300) });
    expect(/new blocks/.test(report), 'the preview report must state the planned block count', { actual: flat.slice(0, 200) });
    const blocksAfter = count('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', worldId);
    expect(blocksAfter === blocksBefore, 'a preview must write nothing to the database', { expected: `${blocksBefore} blocks`, actual: `${blocksAfter} blocks` });
    state.notes.push(`blueprint preview reported: ${flat.slice(0, 180)}`);
    state.fixtures.blueprintAnchor = anchor;
    return `preview reported a valid plan at ${anchor.x},${anchor.y} and the database still holds ${blocksAfter} blocks`;
  });

  await step('applying the blueprint persists the plan inside the stewarded plot', async () => {
    await frontierClick(page, page.locator('#view button[data-blueprint-apply]'));
    const stored = await waitForCondition(async () => {
      const rows_ = rows('SELECT id,x,y,z,type,plot_id,creator_agent_id FROM frontier_blocks WHERE world_id=? AND plot_id=?', worldId, plotId);
      return rows_.length ? rows_ : null;
    }, 'the applied blueprint blocks to be stored');
    expect(stored.every((block) => block.plot_id === plotId), 'every applied block must belong to the stewarded plot', { actual: describe(stored.map((block) => block.plot_id)) });
    expect(stored.every((block) => block.creator_agent_id === pathfinder.id), 'every applied block must be attributed to the resident', { actual: describe([...new Set(stored.map((block) => block.creator_agent_id))]) });
    const unique = new Set(stored.map((block) => `${block.x},${block.y},${block.z}`));
    expect(unique.size === stored.length, 'the plan must not place two blocks on one cell', { actual: `${stored.length} rows, ${unique.size} cells` });
    state.fixtures.blueprintBlocks = stored.length;
    return `${stored.length} frontier_blocks rows in ${plotId}, each attributed to the resident`;
  });

  await step('removing the structure clears every stored block again', async () => {
    await frontierClick(page, page.locator('#view button[data-blueprint-remove]'));
    const outcome = await waitForCondition(async () => {
      const left = count('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=? AND plot_id=?', worldId, plotId);
      if (left === 0) return { left, notice: '' };
      const notice = (await page.locator('#notice').textContent().catch(() => ''))?.trim() || '';
      return /Removed|Nothing of/.test(notice) ? { left, notice } : null;
    }, 'the removal to be reported', { timeout: 30_000 });
    expect(outcome.left === 0, 'removing the structure must clear the stored blocks', { expected: 'zero blocks', actual: `${outcome.left} blocks remained; the interface said “${outcome.notice}”` });
    expect(count('SELECT COUNT(*) AS n FROM land_stewardships WHERE plot_id=?', plotId) === 1, 'removing construction must not release the stewardship', { actual: 'the stewardship disappeared' });
    return `frontier_blocks for ${plotId} back to zero; the stewardship remains`;
  });

  return `plot ${plotId} stewarded and a blueprint previewed, applied and removed through the interface`;
});

// ---------------------------------------------------------------------------------------------
// Scenario 8 — quest progression from a saved fact, and a refused client completion
// ---------------------------------------------------------------------------------------------

const QUEST_SLUG = 'browser-shared-walk';

define('quest-progression', async () => {
  const admin = await actor('admin');
  const owner = await actor('owner');
  const steward = fixtures().characters.steward;
  const steps = JSON.stringify([
    { slug: 'reaching-out', title: 'Travel into a shared place', instructions: 'Enter a shared public place with your resident. Looking at a map does not count.', output_name: 'A recorded visit to a shared world', source_kind: 'shared_visit', target: 1 },
    { slug: 'garden-seat', title: 'Furnish your own garden', instructions: 'Place one allowed object in your own garden or cottage.', output_name: 'One saved home object', source_kind: 'home_furnish', target: 1, prerequisite: 'reaching-out' },
  ]);

  await step('the administrator authors and publishes a practice chain in the interface', async () => {
    await openApp(admin.page, ACTORS.admin);
    await openTab(admin.page, 'Quest chains');
    await openDisclosure(admin.page, 'Author a quest chain');
    const form = admin.page.locator('form[data-draft-section="quest-author"]');
    await form.locator('[name="slug"]').fill(QUEST_SLUG);
    await form.locator('[name="title"]').fill('The browser shared walk');
    await form.locator('[name="route"]').selectOption('world_building');
    await form.locator('[name="scope"]').selectOption('practice');
    await form.locator('[name="summary"]').fill('Two ordered steps that a browser can complete from saved world facts.');
    await form.locator('[name="narrative"]').fill('Written for the browser acceptance run. The first step records a real visit to a shared place and the second saves a planted crop. Both are facts this world already stores.');
    await form.locator('[name="steps"]').fill(steps);
    await admin.page.evaluate(() => { const node = document.querySelector('#notice'); if (node) { node.textContent = ''; node.hidden = true; } });
    await form.getByRole('button', { name: 'Save draft chain', exact: true }).click();
    const authored = await waitForCondition(async () => {
      const text = (await admin.page.locator('#notice').textContent().catch(() => ''))?.trim();
      return text ? text : null;
    }, 'the authoring form to report its result');
    console.log(`        authoring        ${authored}`);
    expect(/saved/i.test(authored), 'the authored chain must be saved', { actual: authored });
    const chain = row('SELECT id,slug,status,route,origin FROM quest_chains WHERE slug=?', QUEST_SLUG);
    expect(chain?.status === 'draft', 'a new chain must start as a draft', { expected: 'status=draft', actual: describe(chain) });
    const stepRows = count('SELECT COUNT(*) AS n FROM quest_steps s JOIN quest_chains c ON c.id=s.chain_id WHERE c.slug=?', QUEST_SLUG);
    expect(stepRows === 2, 'both authored steps must be stored', { expected: 'two quest_steps rows', actual: stepRows });
    await admin.page.locator('#view').getByRole('button', { name: 'Publish chain', exact: true }).first().click();
    await admin.page.waitForFunction((slug) => document.querySelector('#view')?.textContent.includes(slug) || true, QUEST_SLUG).catch(() => {});
    const published = await waitForCondition(async () => {
      const current = row('SELECT status FROM quest_chains WHERE slug=?', QUEST_SLUG);
      return current.status === 'published' ? 'published' : null;
    }, 'the chain to be published');
    return `quest_chains ${chain.id} published with ${stepRows} ordered steps`;
  });

  await step('the resident begins the chain and the board shows the next actual action', async () => {
    await openApp(owner.page, ACTORS.owner);
    await openTab(owner.page, 'Open world');
    await owner.page.locator('#view select[name="agent"]').selectOption(steward.id);
    await settle(owner.page);
    await openTab(owner.page, 'Quest chains');
    const card = owner.page.locator('#view .card', { hasText: 'The browser shared walk' }).first();
    await card.getByRole('button', { name: 'Begin this chain', exact: true }).click();
    await owner.page.waitForFunction((slug) => /Next actual action/i.test(document.querySelector('#view')?.textContent || ''), QUEST_SLUG, { timeout: PAGE_TIMEOUT_MS });
    const enrolled = row('SELECT agent_id,account_id FROM quest_enrollments e JOIN quest_chains c ON c.id=e.chain_id WHERE c.slug=?', QUEST_SLUG);
    expect(enrolled?.agent_id === steward.id && enrolled?.account_id === state.fixtures.owner.id, 'the enrolment must be stored for this resident and operator', { expected: `${steward.id} for ${state.fixtures.owner.id}`, actual: describe(enrolled) });
    const next = owner.page.locator('#view .quest-next').first();
    const text = await next.textContent();
    expect(/step 1/.test(text) && /Travel into a shared place/.test(text), 'the board must show the first authored step', { actual: text?.slice(0, 200) });
    expect(/Named output: A recorded visit to a shared world/.test(text), 'the board must name the output the server will credit', { actual: text?.slice(0, 260) });
    expect(/Credited from a saved server fact/.test(text), 'the board must say the step is credited from a saved server fact', { actual: text?.slice(0, 260) });
    return `quest_enrollments row for ${enrolled.agent_id}; the board shows step 1 and its named output`;
  });

  await step('a client-asserted completion is refused and writes no receipt', async () => {
    const before = count('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?', steward.id);
    const refused = await inPage(owner.page, '/quests/complete', { body: { agent_id: steward.id, chain_id: QUEST_SLUG } });
    expect(refused.status === 400, 'a client completion claim must be refused', { expected: 'HTTP 400', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(/saved server fact/.test(refused.body?.error || ''), 'the refusal must name the saved server fact rule', { actual: describe(refused.body?.error) });
    const after = count('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?', steward.id);
    expect(after === before, 'a refused completion must write no receipt', { expected: `${before} receipts`, actual: after });
    return `400 ${refused.body.error} · receipts unchanged at ${after}`;
  });

  await step('a real recorded visit advances the step exactly once', async () => {
    await openTab(owner.page, 'Regions & ambassadors');
    await waitForText(owner.page, 'COUNTRY PROFILES', { scope: '#view' }).catch(() => {});
    const entering = owner.page.locator('#view').getByRole('button', { name: 'Enter with my resident', exact: true }).first();
    await entering.click();
    const visit = await waitForCondition(async () => {
      const stored = row('SELECT world_id,visited_at FROM journey_visits WHERE agent_id=? AND world_id<>?', steward.id, 'commons');
      return stored ? stored : null;
    }, 'the resident to record a visit to a shared place');
    // "Enter with my resident" travels the resident and the interface re-renders the world when it
    // arrives. Waiting for the browser to actually show the country venue keeps the tab switch below
    // from racing that render, which would otherwise put the world back on screen over the board.
    await waitForClient(owner.page, () => { const id = window.__nemoworld?.worldId?.() || ''; return /^country:/.test(id) && document.querySelector('#view #world') ? id : null; }, null, 'the browser to show the country venue', 20_000);
    await openTab(owner.page, 'Quest chains');
    const receipt = await waitForCondition(async () => {
      const stored = row('SELECT objective_id,source_kind,source_id,points,account_id FROM calling_receipts WHERE agent_id=? AND objective_id LIKE ?', steward.id, `quest:${QUEST_SLUG}.%`);
      return stored ? stored : null;
    }, 'the saved visit to be credited once');
    expect(receipt.objective_id === `quest:${QUEST_SLUG}.reaching-out`, 'the receipt must be named for the authored step', { expected: `quest:${QUEST_SLUG}.reaching-out`, actual: describe(receipt.objective_id) });
    expect(receipt.source_kind === 'shared_visit', 'the receipt must record the saved visit as its source', { expected: 'shared_visit', actual: describe(receipt.source_kind) });
    expect(receipt.points === 5, 'a step must credit the fixed cosmetic experience', { expected: '5 points', actual: describe(receipt.points) });
    expect(receipt.account_id === state.fixtures.owner.id, 'the receipt must belong to the operator', { actual: describe(receipt.account_id) });
    const receipts = count('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=? AND objective_id LIKE ?', steward.id, `quest:${QUEST_SLUG}.%`);
    expect(receipts === 1, 'reading the board again must not credit the same visit twice', { expected: 'one receipt', actual: receipts });
    const board = await owner.page.locator('#view').textContent();
    expect(/step 2/.test(board) && /Furnish your own garden/.test(board), 'the board must advance to the next authored step', { actual: board?.slice(0, 220) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', steward.id) === 0, 'a practice chain must mint no NemoCoin', { actual: 'a coin receipt was issued' });
    return `journey_visits recorded ${visit.world_id}; one receipt ${receipt.objective_id} from ${receipt.source_kind}; 0 coins; the board moved to step 2`;
  });
  return 'progression came from a saved server fact, once, with a client completion refused';
});

// ---------------------------------------------------------------------------------------------
// Scenario 9 — guild cooperation: public, private and a real join
// ---------------------------------------------------------------------------------------------

define('guild-cooperation', async () => {
  const admin = await actor('admin');
  const stranger = await actor('stranger');
  const pathfinder = fixtures().characters.pathfinder;
  const neighbour = fixtures().characters.neighbour;
  const plan = '[{"id":"route","title":"Trace one accessible route","output_name":"A traced route","scope":"Walk and record one accessible route"}]';
  const publicTitle = 'Browser shared growing plan';
  const privateTitle = 'Browser private growing plan';

  const createProject = async (page, title, visibility) => {
    await openTab(page, 'Guild projects');
    await openDisclosure(page, 'Start a guild project');
    const form = page.locator('form[data-draft-section="guild-project-create"]');
    await form.locator('[name="title"]').fill(title);
    await form.locator('[name="guild_id"]').selectOption({ index: 1 });
    await form.locator('[name="visibility"]').selectOption(visibility);
    await form.locator('[name="summary"]').fill('One bounded piece of cooperative work for the browser acceptance run.');
    await form.locator('[name="plan"]').fill(plan);
    await form.getByRole('button', { name: 'Create guild project', exact: true }).click();
    await openTab(page, 'Guild projects');
    return page.locator('#view .cooperative-project', { hasText: title }).first();
  };

  await step('the organiser creates a public and a private guild project in the interface', async () => {
    await openApp(admin.page, ACTORS.admin);
    await openTab(admin.page, 'Open world');
    await admin.page.locator('#view select[name="agent"]').selectOption(pathfinder.id);
    await settle(admin.page);
    await createProject(admin.page, publicTitle, 'public');
    await createProject(admin.page, privateTitle, 'private');
    const stored = rows('SELECT id,title,visibility,creator_agent_id FROM guild_projects WHERE title IN (?,?) ORDER BY visibility', publicTitle, privateTitle);
    expect(stored.length === 2, 'both projects must be stored', { expected: 'two guild_projects rows', actual: describe(stored) });
    expect(stored.every((project) => project.creator_agent_id === pathfinder.id), 'the organiser must be the creating resident', { actual: describe(stored.map((project) => project.creator_agent_id)) });
    expect(stored.some((project) => project.visibility === 'public') && stored.some((project) => project.visibility === 'private'), 'the requested visibility must be stored', { actual: describe(stored.map((project) => project.visibility)) });
    state.fixtures.guildProjects = Object.fromEntries(stored.map((project) => [project.visibility, project]));
    return `guild_projects rows: ${stored.map((project) => `${project.title} (${project.visibility})`).join(', ')}`;
  });

  await step('another operator sees the public project and not the private one', async () => {
    await openApp(stranger.page, ACTORS.stranger);
    await openTab(stranger.page, 'Open world');
    await stranger.page.locator('#view select[name="agent"]').selectOption(neighbour.id);
    await settle(stranger.page);
    // Selecting a resident starts the client's own asynchronous enter-and-refresh, whose trailing render
    // can put the world back over a board a tab switch just opened, and a click the rebuilt navigation
    // swallowed leaves the previous section on screen. Wait for the board itself, re-opening the section
    // within bounds, instead of reading #view on a fixed delay.
    let board = '';
    for (let attempt = 0; attempt < 4 && !/Browser shared growing plan/.test(board); attempt += 1) {
      if (attempt) await stranger.page.waitForTimeout(500);
      await openTab(stranger.page, 'Guild projects');
      board = await waitForCondition(async () => {
        const text = (await stranger.page.locator('#view').textContent().catch(() => '')) || '';
        return /Browser shared growing plan/.test(text) ? text : null;
      }, 'the guild board to render the public project', { timeout: 5000 }).catch(() => '');
    }
    expect(/Browser shared growing plan/.test(board), 'a public guild project must be listed for everyone', { actual: board?.slice(0, 200) });
    expect(!/Browser private growing plan/.test(board), 'a private guild project must never be listed for another operator', { actual: 'the private project appeared on the board' });
    const listing = await inPage(stranger.page, '/guilds?limit=24', { method: 'GET' });
    expect(!listing.body.projects.some((project) => project.id === state.fixtures.guildProjects.private.id), 'the board response must omit the private project', { actual: describe(listing.body.projects.map((project) => project.title)) });
    const privateRead = await inPage(stranger.page, `/guilds/project?id=${state.fixtures.guildProjects.private.id}`, { method: 'GET' });
    expect(privateRead.status === 404, 'another operator must receive 404 for the private project', { expected: 'HTTP 404', actual: `HTTP ${privateRead.status}` });
    return `the public project is listed, the private project is absent and answers ${privateRead.status}`;
  });

  await step('the second operator joins the public project and the server records it', async () => {
    const card = stranger.page.locator('#view .cooperative-project', { hasText: publicTitle }).first();
    await card.getByRole('button', { name: 'Join this guild project', exact: true }).click();
    // The organiser is already a participant, so waiting for "any participant exists" would be satisfied
    // before the click's write lands. Wait for the joining resident's own row instead.
    const stored = await waitForCondition(async () => {
      const participants = rows('SELECT p.agent_id,p.role,p.state,a.operator_id FROM guild_participants p JOIN agents a ON a.id=p.agent_id WHERE p.project_id=?', state.fixtures.guildProjects.public.id);
      return participants.some((participant) => participant.agent_id === neighbour.id) ? participants : null;
    }, `the participation of the neighbouring resident to be stored`);
    const joined = stored.find((participant) => participant.agent_id === neighbour.id);
    expect(joined, 'the joining resident must be recorded', { actual: describe(stored.map((participant) => participant.agent_id)) });
    expect(joined.operator_id === state.fixtures.stranger.id, 'the participant must be owned by the joining operator', { expected: state.fixtures.stranger.id, actual: describe(joined.operator_id) });
    expect(count('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id=?', state.fixtures.stranger.id) === 0, 'joining a guild project must grant no plot', { actual: 'a stewardship appeared' });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE account_id=?', state.fixtures.stranger.id) === 0, 'joining a guild project must issue no coin', { actual: 'a coin receipt appeared' });
    return `guild_participants row for ${joined.agent_id} (${joined.role}/${joined.state}) · no plot, no coin`;
  });
  return 'the public/private boundary held and a real join reached the database';
});

// ---------------------------------------------------------------------------------------------
// Scenario 10 — reward refusals: self-review and an NPC credential
// ---------------------------------------------------------------------------------------------

define('reward-refusals', async () => {
  const admin = await actor('admin');
  const reviewer = await actor('reviewer');
  const pathfinder = fixtures().characters.pathfinder;
  const player = fixtures().characters.player;
  let submissionId = null;

  await step('the administrator’s resident submits work for independent review', async () => {
    const { task } = await makeMission('Browser independent review fixture', 'review');
    const { claim, submission } = await claimAndSubmit(fixtures().admin, task, 'review', pathfinder.id);
    expect(submission.status === 'pending_review' && claim.agent_id === pathfinder.id, 'the submission must be pending review under the resident', { expected: `status=pending_review for ${pathfinder.id}`, actual: describe({ status: submission.status, version: submission.version, agent_id: claim.agent_id }) });
    submissionId = submission.id;
    return `submission ${submission.id} is pending review in the temporary database`;
  });

  await step('the contributor can neither be offered nor perform their own review', async () => {
    const reviewsBefore = count('SELECT COUNT(*) AS n FROM reviews');
    await openApp(admin.page, ACTORS.admin);
    await openTab(admin.page, 'Review');
    const card = admin.page.locator('#view .card', { hasText: 'Browser independent review fixture' }).first();
    await card.waitFor({ state: 'visible' });
    const text = await card.textContent();
    expect(/requires a different human reviewer/.test(text), 'the review view must tell the contributor that their own work needs another reviewer', { expected: 'an independence notice', actual: text?.replace(/\s+/g, ' ').slice(0, 260) });
    const forms = await card.locator('form').count();
    expect(forms === 0, 'the contributor must not be offered a review control for their own submission', { expected: 'no review form', actual: `${forms} forms in the card` });
    const refused = await inPage(admin.page, '/reviews', { body: { submission_id: submissionId, decision: 'accepted', reason: 'Accepting my own contribution.' } });
    expect(refused.status === 403, 'the server must refuse a review posted by the contributor themselves', { expected: 'HTTP 403', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(/own|agents/i.test(refused.body?.error || ''), 'the refusal must state the independence rule', { expected: 'a message about own or agents’ contributions', actual: describe(refused.body?.error) });
    expect(count('SELECT COUNT(*) AS n FROM reviews') === reviewsBefore, 'a refused self-review must write no review row', { expected: `${reviewsBefore} reviews`, actual: count('SELECT COUNT(*) AS n FROM reviews') });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', pathfinder.id) === 0, 'a refused self-review must award no coin', { actual: 'a coin receipt appeared' });
    return `the interface offered no control and the server answered ${refused.status}: ${refused.body?.error}`;
  });

  await step('a different operator accepts the work and the coin receipt is issued', async () => {
    await openApp(reviewer.page, ACTORS.reviewer);
    await openTab(reviewer.page, 'Review');
    const card = reviewer.page.locator('#view .card', { hasText: 'Browser independent review fixture' }).first();
    await card.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const form = card.locator('form').first();
    await form.locator('select[name="decision"]').selectOption('accepted');
    await form.locator('[name="reason"]').fill('Independent acceptance after checking the fixture rubric and its exact source.');
    await form.getByRole('button', { name: 'Record review', exact: true }).click();
    const review = await waitForCondition(async () => {
      const stored = row('SELECT id,reviewer_id,decision FROM reviews WHERE submission_id=?', submissionId);
      return stored ? stored : null;
    }, 'the independent review to be stored');
    expect(review.reviewer_id === state.fixtures.reviewer.id && review.decision === 'accepted', 'the stored review must name the independent reviewer', { expected: `${state.fixtures.reviewer.id} accepted`, actual: describe(review) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', pathfinder.id) === 1, 'the independently accepted contribution must issue exactly one receipt', { expected: 'one coin_rewards row', actual: count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', pathfinder.id) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=? AND amount=10', pathfinder.id) === 1, 'the receipt must be the fixed ten-coin award', { actual: 'no ten-coin receipt' });
    return `reviews row by ${review.reviewer_id}; one 10-coin receipt for ${pathfinder.id}`;
  });

  await step('a country ambassador can never receive a runtime credential', async () => {
    const tokensBefore = count("SELECT COUNT(*) AS n FROM tokens WHERE agent_id='amb-NPL'");
    const refused = await inPage(admin.page, '/runtime/start', { body: { agent_id: 'amb-NPL', minutes: 10, max_calls: 10, scopes: ['read'] } });
    expect(refused.status === 404 || refused.status === 403, 'an ambassador must not receive a credential', { expected: 'HTTP 403 or 404', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(!refused.body?.token, 'no credential may be returned', { actual: 'a token was returned' });
    expect(count("SELECT COUNT(*) AS n FROM tokens WHERE agent_id='amb-NPL'") === tokensBefore, 'no token row may be created for an NPC', { expected: `${tokensBefore} rows`, actual: count("SELECT COUNT(*) AS n FROM tokens WHERE agent_id='amb-NPL'") });
    return `POST /runtime/start for amb-NPL -> ${refused.status} ${refused.body?.error || ''}`;
  });

  await step('the human avatar offers no credential control and is refused one', async () => {
    await openTab(admin.page, 'My characters');
    const record = admin.page.locator('#view .record', { hasText: 'Browser player' }).first();
    await record.waitFor({ state: 'visible' });
    const text = await record.textContent();
    expect(!/Connect an independent AI agent/.test(text), 'a human avatar must not offer an agent credential form', { actual: 'the credential disclosure was rendered for a human avatar' });
    const refused = await inPage(admin.page, '/runtime/start', { body: { agent_id: player.id, minutes: 10, max_calls: 10, scopes: ['read'] } });
    expect(refused.status === 403, 'a human avatar must be refused a runtime credential', { expected: 'HTTP 403', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(count('SELECT COUNT(*) AS n FROM tokens WHERE agent_id=?', player.id) === 0, 'no credential row may exist for the human avatar', { actual: 'a token row appeared' });
    return `the interface offers no credential control for the human player and the server answers ${refused.status}`;
  });
  return 'self-review and NPC credentials were both refused while the independent acceptance still issued its coin';
});

// ---------------------------------------------------------------------------------------------
// Scenario 11 — selecting another character clears the old blueprint preview
// ---------------------------------------------------------------------------------------------

define('character-switch-clears-preview', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const pathfinder = fixtures().characters.pathfinder;
  const wanderer = fixtures().characters.wanderer;

  await step('the steward previews a blueprint in its own plot', async () => {
  await openApp(page, ACTORS.admin);
    await enterFrontierAs(page, pathfinder.id);
    await frontierClick(page, page.locator('#view button[data-blueprint-preview]'));
    const report = await waitForCondition(async () => {
      const text = (await page.locator('#blueprint-report').textContent().catch(() => '')) || '';
      return /new blocks/.test(text) ? text : null;
    }, 'the blueprint preview report to appear before the character changes');
    state.fixtures.previewText = report.replace(/\s+/g, ' ').slice(0, 80);
    return `preview on screen: ${state.fixtures.previewText}`;
  });

  await step('choosing another character clears the preview', async () => {
    await openTab(page, 'Open world');
    await page.locator('#view select[name="agent"]').selectOption(wanderer.id);
    await settle(page);
    await page.waitForTimeout(600);
    const selected = await page.evaluate(() => localStorage.getItem('selected-agent'));
    expect(selected === wanderer.id, 'the interface must remember the newly selected character', { expected: wanderer.id, actual: describe(selected) });
    const reports = await page.locator('#blueprint-report').count();
    const report = reports ? await page.locator('#blueprint-report').textContent() : '';
    expect(!/new blocks/.test(report), 'the previous character’s blueprint preview must be gone', { expected: 'no preview report', actual: describe(report?.slice(0, 160)) });
    return `selected-agent=${wanderer.name}; the old preview is no longer on screen`;
  });

  await step('returning to the steward shows a fresh, empty blueprint panel', async () => {
    await page.locator('#view select[name="agent"]').selectOption(pathfinder.id);
    await settle(page);
    await page.waitForTimeout(800);
    await page.waitForFunction(() => Boolean(document.querySelector('#blueprint-report')), null, { timeout: PAGE_TIMEOUT_MS });
    const report = await page.locator('#blueprint-report').textContent();
    expect(/Preview a blueprint to read its exact cells/.test(report), 'the blueprint panel must be back to its placeholder', { expected: 'the placeholder report', actual: describe(report?.slice(0, 200)) });
    expect(!/new blocks/.test(report), 'the earlier preview must not be restored', { actual: describe(report?.slice(0, 200)) });
    return 'the steward’s panel is clean and asks for a new preview';
  });
  return 'switching characters discarded the cached blueprint report';
});

// ---------------------------------------------------------------------------------------------
// Scenario 12 — sign-out clears cached private quests, guilds, blueprints and land state
// ---------------------------------------------------------------------------------------------

define('consolidated-proposal-history', async () => {
  const admin = await actor('admin');
  const legacyId = 'NP-2-evidence';
  write('INSERT INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    legacyId, 'NP', 2, 'evidence', 'Retired browser fixture', 'A retained interchangeable template.', 'Historical rubric.', '["https://sdgs.un.org/goals/goal2"]', '2026-01-01T00:00:00.000Z');
  const before = row('SELECT * FROM research_leads WHERE id=?', legacyId);
  write('INSERT INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'NP-3-evidence', 'NP', 3, 'evidence', 'Unscoped browser fixture', 'No answerable subject selected.', 'Historical rubric.', '[]', '2026-01-01T00:00:00.000Z');
  const unscopedBefore = row('SELECT * FROM research_leads WHERE id=?', 'NP-3-evidence');
  const generated = await apiPost('/research/generate', { country_code: 'NP' }, { token: fixtures().admin.token });
  expect(generated.status === 200, 'the normal generator must classify the old fixture', { actual: describe(generated) });
  await step('the research desk displays consolidation and names its replacement', async () => {
    await openApp(admin.page, ACTORS.admin);
    await openTab(admin.page, 'Research desk');
    const form = admin.page.locator('#view form').filter({ has: admin.page.getByRole('button', { name: 'Search research', exact: true }) });
    await form.locator('[name="q"]').fill('Retired browser fixture');
    await form.locator('[name="country"]').selectOption('NP');
    await form.locator('[name="status"]').selectOption('consolidated');
    await form.getByRole('button', { name: 'Search research', exact: true }).click();
    await waitForCondition(async () => {
      const text = await admin.page.locator('#view').textContent();
      return text.includes('Replacement: NP-2-interventions') ? text : null;
    }, 'the retired proposal and its replacement to be visible');
    expect(await admin.page.getByText('Activate a reviewed mission', { exact: true }).count() === 0,
      'the retired proposal must not offer an activation form');
    return 'consolidated historical proposal; replacement NP-2-interventions; no activation control';
  });
  await step('the server refuses activation and preserves the original proposal', async () => {
    const missions = count('SELECT COUNT(*) AS n FROM missions');
    const refused = await inPage(admin.page, '/research/activate', { body: { lead_id: legacyId, beneficiary: 'Fictional browser fixture' } });
    expect(refused.status === 409, 'retired proposal activation must fail', { actual: describe(refused) });
    expect(count('SELECT COUNT(*) AS n FROM missions') === missions, 'no mission may be created');
    expect(JSON.stringify(row('SELECT * FROM research_leads WHERE id=?', legacyId)) === JSON.stringify(before), 'the historical row must remain unchanged');
    return '409 refusal; no new mission; original proposal retained unchanged';
  });
  await step('a template without a scoped successor is retired without inventing a replacement', async () => {
    const form = admin.page.locator('#view form').filter({ has: admin.page.getByRole('button', { name: 'Search research', exact: true }) });
    await form.locator('[name="q"]').fill('Unscoped browser fixture');
    await form.locator('[name="status"]').selectOption('retired');
    await form.getByRole('button', { name: 'Search research', exact: true }).click();
    await waitForCondition(async () => {
      const text = await admin.page.locator('#view').textContent();
      return text.includes('No scoped replacement has been authored') ? text : null;
    }, 'the unscoped template to be shown as retired');
    expect(await admin.page.getByText('Activate a reviewed mission', { exact: true }).count() === 0, 'an unscoped retired template must not offer activation');
    const missions = count('SELECT COUNT(*) AS n FROM missions');
    const refused = await inPage(admin.page, '/research/activate', { body: { lead_id: 'NP-3-evidence', beneficiary: 'Fictional browser fixture' } });
    expect(refused.status === 409 && /without a scoped replacement/.test(refused.body.error), 'retirement must be enforced by the server', { actual: describe(refused) });
    expect(count('SELECT COUNT(*) AS n FROM missions') === missions, 'no unscoped mission may be created');
    expect(JSON.stringify(row('SELECT * FROM research_leads WHERE id=?', 'NP-3-evidence')) === JSON.stringify(unscopedBefore), 'the unscoped historical row must remain unchanged');
    return 'retired without a replacement; 409 activation refusal; original row retained';
  });
  return 'the UI and server agree that consolidation is history, not an active proposal';
});

define('phone-conversation', async () => {
  const owner = await actor('owner');
  const page = owner.page;
  const walker = fixtures().characters.walker;
  const neighbour = fixtures().characters.neighbour;
  await sendToCommons(fixtures().owner, walker.id);
  // The Neighbour is owned by the stranger operator and earlier scenarios may have moved it; put it
  // back in the Commons so it is a visible recipient in this scenario's own world.
  await sendToCommons(fixtures().stranger, neighbour.id);

  await step('enter the game shell as the saved resident', async () => {
    await openApp(page, ACTORS.owner);
    await openWorldAs(page, walker.id);
    await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    return 'game shell loaded';
  });

  await step('desktop: the conversation panel opens as a compact overlay', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('#game-hud').getByRole('button', { name: 'Chat', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.gameDrawer === 'chat', null, { timeout: PAGE_TIMEOUT_MS });
    const host = page.locator('#game-conversation-host');
    await host.waitFor({ state: 'visible' });
    const box = await host.evaluate((node) => ({ width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right, top: node.getBoundingClientRect().top }));
    expect(box.width <= 400, 'the desktop conversation panel must be compact', { actual: box.width });
    expect(box.right <= 1280, 'the desktop panel must stay inside the viewport', { actual: box.right });
    expect(box.top >= 60, 'the desktop panel must sit below the masthead', { actual: box.top });
    return `desktop panel ${Math.round(box.width)}px wide at top ${Math.round(box.top)}`;
  });

  await step('draft, channel and recipient survive a full rerender and keep focus', async () => {
    const form = page.locator('#world-chat-card form');
    await form.locator('[name="channel"]').selectOption('private');
    await form.locator('[name="recipient_id"]').selectOption(neighbour.id);
    const text = 'Draft that must survive a render';
    await form.locator('[name="text"]').fill(text);
    await page.evaluate(() => window.__nemoworld.render());
    await settle(page);
    const after = await form.evaluate((node) => ({ channel: node.elements.namedItem('channel')?.value, recipient: node.elements.namedItem('recipient_id')?.value, text: node.elements.namedItem('text')?.value, active: document.activeElement?.name || null }));
    expect(after.channel === 'private' && after.recipient === neighbour.id && after.text === text, 'draft, channel and recipient must survive rerender', { expected: { channel: 'private', recipient: neighbour.id, text }, actual: after });
    expect(after.active === 'text', 'focus must return to the textarea after rerender', { expected: 'text', actual: after.active });
    return 'draft, recipient and focus survived rerender';
  });

  await step('phone 390x844: panel stays small and leaves the world visible', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const host = page.locator('#game-conversation-host');
    await host.waitFor({ state: 'visible' });
    const box = await host.evaluate((node) => ({ width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right, bottom: node.getBoundingClientRect().bottom }));
    expect(box.width <= 340, 'phone panel width must stay compact', { expected: '<=340', actual: box.width });
    expect(box.right <= 390, 'phone panel must not overflow the right edge', { actual: box.right });
    expect(box.bottom <= 844, 'phone panel must not overflow the bottom edge', { actual: box.bottom });
    const world = await page.locator('#world').boundingBox();
    expect(world && world.width > 100, 'world canvas must remain partly visible beside the panel', { actual: world });
    return `phone panel ${Math.round(box.width)}px wide, world still ${Math.round(world?.width || 0)}px wide`;
  });

  await step('reduced motion: panel has no transition', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const transition = await page.evaluate(() => { const host = document.querySelector('#game-conversation-host'); return host ? getComputedStyle(host).transition : ''; });
    expect(transition === 'none' || !transition || transition.includes('0s'), 'panel must not animate under reduced motion', { actual: transition });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    return 'no transition under reduced motion';
  });

  await step('closing the panel returns focus to the HUD and clears the drawer', async () => {
    await page.locator('#game-conversation-host').getByRole('button', { name: 'Close conversation', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.gameDrawer === '', null, { timeout: PAGE_TIMEOUT_MS });
    expect(await page.locator('#game-conversation-host').isVisible() === false, 'panel must hide after close');
    return 'panel closed';
  });
});

// The in-game command surface. A section is a panel over (desktop: beside) the running world, never a
// replacement for it: the same WebGL canvas element survives every section, the avatar still answers
// the keyboard while a panel is open, Escape closes the panel, and a phone gets a sheet that leaves
// the scene on screen. The catalogue is read from the page so a section added later is covered too.
define('in-game-command-surface', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const player = fixtures().characters.player;
  await mkdir(join(RESULTS, 'in-game-command-surface'), { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (!await page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(page, ACTORS.admin);
  // An earlier scenario may have left this operator inside the game; Play appears only on the entry screen.
  const entry = page.locator('#hero-actions').getByRole('button', { name: 'Play', exact: true });
  if (await entry.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) await entry.click();
  await page.waitForFunction((id) => window.__nemoworld?.selected?.() === id && document.querySelector('#world'), player.id, { timeout: PAGE_TIMEOUT_MS });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelector('#world').dataset.surfaceMark = 'kept'; });
  const facts = () => page.evaluate(() => {
    const canvas = document.querySelector('#world'), box = canvas?.getBoundingClientRect(), panel = document.querySelector('#game-panel'), body = document.querySelector('#game-panel-body');
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    return {
      panel: window.__nemoworld.panel(), kept: canvas?.dataset.surfaceMark === 'kept', share: box ? (box.width * box.height) / (innerWidth * innerHeight) : 0, bottom: box?.bottom ?? 0,
      panelHidden: panel.hidden, panelTop: panel.getBoundingClientRect().top, panelLeft: panel.getBoundingClientRect().left, overflow: body.scrollWidth - body.clientWidth, textLength: body.textContent.trim().length,
      duplicates: [...new Set(ids.filter((value, index) => ids.indexOf(value) !== index))], focusInPanel: panel.contains(document.activeElement), focusId: document.activeElement?.id || document.activeElement?.tagName,
      current: document.querySelector('#navigation [aria-current="page"]')?.getAttribute('aria-label') || null, menuOpen: document.body.classList.contains('game-menu-open'),
      pad: Boolean(document.querySelector('.nm-touch') && getComputedStyle(document.querySelector('.nm-touch')).display !== 'none'),
    };
  });

  await step('the menu finds a section by a few words and Enter opens it beside the running world', async () => {
    await page.locator('#game-menu-button').click();
    const search = page.getByRole('searchbox', { name: 'Find a section' });
    await search.waitFor({ state: 'visible' });
    await search.fill('wallet');
    const shown = await page.locator('#navigation [data-section]:not([hidden])').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    expect(shown.length === 1 && shown[0] === 'Coin wallet', 'a search for wallet must leave exactly the Coin wallet', { expected: 'Coin wallet', actual: describe(shown) });
    expect(/1 section matches/.test(await page.locator('#game-menu-status').textContent()), 'the match count must be announced in a status region');
    await search.press('Enter');
    await page.waitForFunction(() => window.__nemoworld.panel() === 'coins', null, { timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(500);
    const seen = await facts();
    expect(seen.kept && !seen.panelHidden, 'the panel must be open on the same 3D canvas', { actual: describe(seen) });
    expect(!seen.menuOpen && seen.current === 'Coin wallet', 'choosing a section closes the menu and marks it current', { actual: describe(seen) });
    expect(seen.share >= 0.5 && seen.panelLeft >= 900, 'on a desktop the world keeps at least half the screen and the panel sits beside it', { actual: describe(seen) });
    expect(seen.focusInPanel, 'keyboard focus must move into the panel', { actual: describe(seen.focusId) });
    await page.screenshot({ path: join(RESULTS, 'in-game-command-surface', 'desktop-wallet.png') });
    return `Coin wallet opened beside the world; the world keeps ${(seen.share * 100).toFixed(0)}% of the screen`;
  });

  await step('the resident still walks while the panel is open, from the keyboard and from the Focus world control', async () => {
    await page.locator('#game-panel-world').click();
    const before = row('SELECT x,y FROM agents WHERE id=?', player.id);
    let moved = null;
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      await page.keyboard.press(key);
      moved = await waitForCondition(() => { const now = row('SELECT x,y FROM agents WHERE id=?', player.id); return Math.abs(now.x - before.x) + Math.abs(now.y - before.y) === 1 ? now : null; }, `a ${key} step to be saved`, { timeout: 1800, interval: 100 }).catch(() => null);
      if (moved) break;
    }
    expect(moved, 'a walking key must move the resident one stored tile with the panel open', { expected: `one step from ${before.x},${before.y}`, actual: describe(row('SELECT x,y FROM agents WHERE id=?', player.id)) });
    expect((await facts()).panel === 'coins', 'walking must not close the panel');
    return `${before.x},${before.y} → ${moved.x},${moved.y} with the Coin wallet open`;
  });

  await step('Escape closes the panel, focus returns to the control that opened it, and the canvas never changed', async () => {
    await page.locator('#game-panel-body').locator('button, a[href], input, select').first().focus().catch(() => {});
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__nemoworld.panel() === '', null, { timeout: PAGE_TIMEOUT_MS });
    const seen = await facts();
    expect(seen.panelHidden && seen.kept, 'the panel must be hidden and the canvas the same one', { actual: describe(seen) });
    expect(await page.evaluate(() => !document.querySelector('#game-panel').contains(document.activeElement)), 'focus must leave the hidden panel');
    return 'Escape closed the panel; focus is on ' + seen.focusId;
  });

  await step('every section in the catalogue opens as a panel and none replaces the world', async () => {
    const ids = await page.evaluate(() => window.__nemoworld.sections().filter((id) => id !== 'world'));
    expect(ids.length >= 24, 'the catalogue must list every section', { actual: String(ids.length) });
    const broken = [];
    for (const id of ids) {
      const inMenu = await page.evaluate((target) => Boolean([...document.querySelectorAll('#navigation [data-section]')].find((node) => node.dataset.section === target)), id);
      if (inMenu) { await page.locator('#game-menu-button').click(); await page.locator(`#navigation [data-section="${id}"]`).click(); }
      else await page.evaluate((target) => window.__nemoworld.openSection(target), id);
      await page.waitForFunction((target) => window.__nemoworld.panel() === target, id, { timeout: PAGE_TIMEOUT_MS });
      await page.waitForTimeout(450);
      const seen = await facts();
      const problems = [];
      if (!seen.kept) problems.push('canvas replaced');
      if (seen.share < 0.5) problems.push(`world share ${seen.share.toFixed(2)}`);
      if (seen.panelHidden) problems.push('panel hidden');
      if (seen.overflow > 2) problems.push(`sideways overflow ${seen.overflow}`);
      if (seen.duplicates.length) problems.push(`duplicate ids ${seen.duplicates.join(',')}`);
      if (seen.textLength < 40) problems.push('empty');
      if (inMenu && seen.current !== await page.evaluate((target) => [...document.querySelectorAll('#navigation [data-section]')].find((node) => node.dataset.section === target)?.getAttribute('aria-label'), id)) problems.push(`menu marks ${seen.current}`);
      if (problems.length) broken.push(`${id}: ${problems.join('; ')}`);
    }
    expect(!broken.length, 'every section must open as a clean panel over the same world', { actual: describe(broken) });
    await page.keyboard.press('Escape');
    return `${ids.length} sections opened beside the same canvas`;
  });

  await step('the shell keeps one right-hand slot: Chat and Places swap with the panel instead of stacking', async () => {
    const hud = page.locator('#game-hud');
    await hud.getByRole('button', { name: 'Places', exact: true }).click();
    await page.waitForFunction(() => window.__nemoworld.panel() === 'explore', null, { timeout: PAGE_TIMEOUT_MS });
    await hud.getByRole('button', { name: 'Chat', exact: true }).waitFor({ state: 'visible' });
    await page.evaluate(() => document.querySelector('#game-hud .game-quickbar button:nth-child(3)').click());
    await page.waitForFunction(() => document.body.dataset.gameDrawer === 'chat' && window.__nemoworld.panel() === '', null, { timeout: PAGE_TIMEOUT_MS });
    expect(await page.locator('#game-panel').isHidden(), 'opening the conversation must close the panel');
    await page.evaluate(() => document.querySelector('#game-hud .game-quickbar button:nth-child(4)').click());
    await page.waitForFunction(() => window.__nemoworld.panel() === 'explore' && !window.__nemoworld.drawer(), null, { timeout: PAGE_TIMEOUT_MS });
    await page.evaluate(() => document.querySelector('#game-hud .game-quickbar button:nth-child(4)').click());
    await page.waitForFunction(() => window.__nemoworld.panel() === '', null, { timeout: PAGE_TIMEOUT_MS });
    return 'Chat closed the panel, Places reopened it and a second press closed it';
  });

  await step('the world menu key M opens the launcher from the scene', async () => {
    await page.locator('#world').focus();
    await page.keyboard.press('m');
    await page.waitForFunction(() => document.body.classList.contains('game-menu-open'), null, { timeout: PAGE_TIMEOUT_MS });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('game-menu-open'), null, { timeout: PAGE_TIMEOUT_MS });
    return 'M opened the menu and Escape closed it';
  });

  await step('a phone gets a sheet: the scene stays above it, the touch pad stands down, and Close brings it back', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.locator('#game-menu-button').click();
    await page.locator('#navigation [data-section="missions"]').click();
    await page.waitForFunction(() => window.__nemoworld.panel() === 'missions', null, { timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(700);
    const seen = await facts();
    expect(seen.kept && !seen.panelHidden, 'the sheet must open over the same canvas', { actual: describe(seen) });
    expect(seen.bottom <= seen.panelTop + 2 && seen.share >= 0.28, 'the world must stay above the sheet and keep at least 28% of the screen', { actual: describe({ share: seen.share, canvasBottom: seen.bottom, sheetTop: seen.panelTop }) });
    expect(seen.overflow <= 2 && !seen.pad, 'the sheet must not scroll sideways and the touch pad must stand down while it covers the pad', { actual: describe({ overflow: seen.overflow, pad: seen.pad }) });
    await page.screenshot({ path: join(RESULTS, 'in-game-command-surface', 'phone-missions.png') });
    await page.locator('#game-panel-close').click();
    await page.waitForFunction(() => window.__nemoworld.panel() === '', null, { timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(500);
    const after = await facts();
    expect(after.pad, 'closing the sheet must bring the touch pad back', { actual: describe(after) });
    return `sheet top ${Math.round(seen.panelTop)}px, world ${(seen.share * 100).toFixed(0)}% of the screen, pad back after Close`;
  });

  await step('reduced motion: the panel and menu define no transition', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#game-menu-button').click();
    await page.locator('#navigation [data-section="community"]').click();
    await page.waitForFunction(() => window.__nemoworld.panel() === 'community', null, { timeout: PAGE_TIMEOUT_MS });
    const motion = await page.evaluate(() => ({ panel: getComputedStyle(document.querySelector('#game-panel')).transitionDuration, content: getComputedStyle(document.querySelector('#content')).transitionDuration, sidebar: getComputedStyle(document.querySelector('.sidebar')).transitionDuration }));
    expect(Object.values(motion).every((value) => value.split(',').every((part) => parseFloat(part) === 0)), 'no transition may run under prefers-reduced-motion', { actual: describe(motion) });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.keyboard.press('Escape');
    return 'transition durations are all 0s under reduced motion';
  });

  return 'every section opens as a panel over the running world, with keyboard, phone and reduced-motion access, and the resident keeps walking';
});

define('signout-privacy', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const pathfinder = fixtures().characters.pathfinder;
  const privateGuild = 'Browser sign-out private plan';
  const privateChain = 'Browser sign-out private chain';
  const plan = '[{"id":"route","title":"Trace one accessible route","output_name":"A traced route","scope":"Walk and record one accessible route"}]';

  await step('the signed-in operator holds private quests, guilds, a blueprint report and land state', async () => {
  await openApp(page, ACTORS.admin);
    await enterFrontierAs(page, pathfinder.id);
    await frontierClick(page, page.locator('#view button[data-blueprint-preview]'));
    await waitForCondition(async () => {
      const text = (await page.locator('#blueprint-report').textContent().catch(() => '')) || '';
      return /new blocks/.test(text) ? text : null;
    }, 'the blueprint preview report to appear before signing out');
    await openTab(page, 'Guild projects');
    await openDisclosure(page, 'Start a guild project');
    const guildForm = page.locator('form[data-draft-section="guild-project-create"]');
    await guildForm.locator('[name="title"]').fill(privateGuild);
    await guildForm.locator('[name="guild_id"]').selectOption({ index: 1 });
    await guildForm.locator('[name="visibility"]').selectOption('private');
    await guildForm.locator('[name="summary"]').fill('A private plan that must not survive a sign-out on screen.');
    await guildForm.locator('[name="plan"]').fill(plan);
    await guildForm.getByRole('button', { name: 'Create guild project', exact: true }).click();
    await openTab(page, 'Guild projects');
    await openTab(page, 'Quest chains');
    await openDisclosure(page, 'Author a quest chain');
    const chainForm = page.locator('form[data-draft-section="quest-author"]');
    await chainForm.locator('[name="slug"]').fill('browser-signout-private');
    await chainForm.locator('[name="title"]').fill(privateChain);
    await chainForm.locator('[name="route"]').selectOption('world_building');
    await chainForm.locator('[name="scope"]').selectOption('practice');
    await chainForm.locator('[name="summary"]').fill('A draft chain that must not survive a sign-out on screen.');
    await chainForm.locator('[name="narrative"]').fill('Drafted only to prove that signing out clears cached private work from the interface.');
    await chainForm.locator('[name="steps"]').fill('[{"slug":"one","title":"One","instructions":"One","output_name":"One","source_kind":"shared_visit","target":1},{"slug":"two","title":"Two","instructions":"Two","output_name":"Two","source_kind":"home_furnish","target":1,"prerequisite":"one"}]');
    await chainForm.getByRole('button', { name: 'Save draft chain', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#notice')?.textContent || '').includes('saved'), null, { timeout: PAGE_TIMEOUT_MS });
    const board = await page.locator('#view').textContent();
    expect(board.includes(privateChain), 'the draft chain must be visible while signed in', { actual: 'the draft chain was not listed' });
    expect(count('SELECT COUNT(*) AS n FROM quest_chains WHERE slug=?', 'browser-signout-private') === 1, 'the draft chain must be stored', { actual: 'no quest_chains row' });
    expect(count('SELECT COUNT(*) AS n FROM guild_projects WHERE title=? AND visibility=?', privateGuild, 'private') === 1, 'the private guild project must be stored', { actual: 'no private guild_projects row' });
    return 'a preview report, a private guild project and a draft chain are all on screen';
  });

  await step('signing out removes them from the interface without deleting server records', async () => {
    await signOut(page);
    state.fixtures.privateCounts = {
      guilds: count('SELECT COUNT(*) AS n FROM guild_projects WHERE title=?', privateGuild),
      chains: count('SELECT COUNT(*) AS n FROM quest_chains WHERE slug=?', 'browser-signout-private'),
      stewardships: count('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id=?', state.fixtures.admin.id),
    };
    expect(state.fixtures.privateCounts.guilds === 1 && state.fixtures.privateCounts.chains === 1, 'signing out must not delete the operator’s server records', { actual: describe(state.fixtures.privateCounts) });
    const store = await storage(page);
    expect(!store.local['selected-agent'], 'sign-out must clear the remembered character', { actual: describe(store.local['selected-agent']) });
    expect(!Object.values(store.local).some((value) => String(value).includes(privateChain)), 'sign-out must not leave private chain text in browser storage', { actual: 'the private chain title remained in storage' });
    return `server records retained (${JSON.stringify(state.fixtures.privateCounts)}); the remembered character is cleared`;
  });

  await step('the public pages show no cached private work after sign-out', async () => {
    await openTab(page, 'Quest chains');
    const quests = await page.locator('#view').textContent();
    expect(!quests.includes(privateChain), 'the private draft chain must not be rendered after sign-out', { actual: 'the private chain was still on screen' });
    expect(!/Your drafts and archived chains/.test(quests), 'the private drafts section must not be rendered after sign-out', { actual: 'the private drafts section survived sign-out' });
    await openTab(page, 'Guild projects');
    const guilds = await page.locator('#view').textContent();
    expect(!guilds.includes(privateGuild), 'the private guild project must not be rendered after sign-out', { actual: 'the private project was still on screen' });
    await openTab(page, 'Open world');
    const world = await page.locator('#view').textContent();
    expect(!/Build the frontier/.test(world), 'the cached frontier and land state must be gone after sign-out', { actual: 'the frontier panel survived sign-out' });
    expect(!/new blocks/.test(world), 'the cached blueprint report must be gone after sign-out', { actual: 'the blueprint report survived sign-out' });
    expect(await page.locator('#plot-detail').count() === 0, 'the cached plot panel must be gone after sign-out', { actual: 'the plot panel survived sign-out' });
    return 'quests, guild projects, the frontier, the blueprint report and the plot panel were all cleared';
  });
  return 'sign-out cleared cached private quests, guilds, blueprints and land/world state';
});

// ---------------------------------------------------------------------------------------------
// Scenario 13 — a forged coin receipt is refused by the database itself
// ---------------------------------------------------------------------------------------------

define('forged-coin-receipt-refused', async () => {
  const owner = await actor('owner');
  const steward = fixtures().characters.steward;
  let claim = null, submission = null;

  await step('the owner’s resident submits work on a second fixture mission', async () => {
    const { task } = await makeMission('Browser forged receipt fixture', 'forged');
    const result = await claimAndSubmit(fixtures().owner, task, 'forged', steward.id);
    claim = result.claim; submission = result.submission;
    expect(submission.status === 'pending_review', 'the fixture submission must be pending review', { actual: describe(submission.status) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', steward.id) === 0, 'the fixture must start without a receipt', { actual: 'a receipt already existed' });
    return `submission ${submission.id} pending, with no receipt for ${steward.id}`;
  });

  await step('a receipt forged from the contributor’s own review is refused with a chain check', async () => {
    const createdAt = new Date().toISOString();
    write('INSERT INTO reviews(id,submission_id,reviewer_id,decision,reason,created_at) VALUES(?,?,?,?,?,?)', 'forged-self-review', submission.id, state.fixtures.owner.id, 'accepted', 'A forged self-review written straight into the database.', createdAt);
    const previous = scalar('SELECT hash FROM coin_rewards ORDER BY seq DESC LIMIT 1') || '';
    let refusal = null;
    try {
      write('INSERT INTO coin_rewards(id,agent_id,account_id,task_id,submission_id,review_id,fingerprint,amount,policy_version,award_day,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', 'forged-receipt', steward.id, state.fixtures.owner.id, claim.task_id, submission.id, 'forged-self-review', 'forged-fingerprint', 10, 1, createdAt.slice(0, 10), createdAt, previous, 'a'.repeat(64));
    } catch (error) { refusal = error; }
    expect(refusal, 'the database must refuse a receipt forged from a self-review', { expected: 'a structural coin-receipt refusal', actual: 'the forged receipt was accepted' });
    expect(/Ineligible coin receipt/i.test(refusal.message), 'the refusal must name the ineligibility, not only the hash chain', { expected: 'Ineligible coin receipt', actual: describe(refusal.message) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', steward.id) === 0, 'the forged receipt must not be stored', { actual: 'a coin_rewards row appeared' });
    return `SQLite refused the insert: ${refusal.message}`;
  });

  await step('a receipt with a broken hash chain is refused as well', async () => {
    const receiptsBefore = count('SELECT COUNT(*) AS n FROM coin_rewards');
    let refusal = null;
    try {
      write('INSERT INTO coin_rewards(id,agent_id,account_id,task_id,submission_id,review_id,fingerprint,amount,policy_version,award_day,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', 'forged-chain-receipt', steward.id, state.fixtures.owner.id, claim.task_id, submission.id, 'forged-self-review', 'forged-fingerprint-2', 10, 1, new Date().toISOString().slice(0, 10), new Date().toISOString(), 'deadbeef', 'b'.repeat(64));
    } catch (error) { refusal = error; }
    expect(refusal, 'the database must refuse a receipt that breaks the append-only chain', { expected: 'a chain refusal', actual: 'the forged receipt was accepted' });
    expect(/Coin chain mismatch|Ineligible coin receipt/i.test(refusal.message), 'the refusal must be one of the coin structural rules', { actual: describe(refusal.message) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards') === receiptsBefore, 'the forged receipts must never enter the ledger', { expected: `${receiptsBefore} receipts`, actual: count('SELECT COUNT(*) AS n FROM coin_rewards') });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', steward.id) === 0, 'the forged resident must hold no receipt', { actual: count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', steward.id) });
    return `SQLite refused the chained forgery: ${refusal.message} · the ledger still holds ${receiptsBefore} legitimate receipt(s)`;
  });

  await step('the interface agrees: the resident’s wallet holds no coin from the forgery', async () => {
    await openApp(owner.page, ACTORS.owner);
    await openTab(owner.page, 'Coin wallet');
    const picker = owner.page.locator('#view select[name="wallet_agent"]');
    if (await picker.count()) { await picker.selectOption(steward.id); await settle(owner.page); }
    const wallet = owner.page.locator('#view');
    const available = await wallet.locator('.progress-card', { hasText: 'Available coins' }).first().locator('strong').textContent();
    expect(available?.trim() === '0', 'the wallet must show no available coin for this resident', { expected: '0', actual: describe(available) });
    const text = await wallet.textContent();
    expect(/No coins awarded yet/.test(text), 'the wallet must list no receipt', { actual: text?.slice(0, 200) });
    return `Coin wallet for ${steward.id}: available coins ${available}, no receipt listed`;
  });
  return 'the database itself refuses a forged receipt; the wallet stays empty';
});

// ---------------------------------------------------------------------------------------------
// Scenario 14 — an interrupted resident run and the bounded resume refusal
// ---------------------------------------------------------------------------------------------

define('resident-run-resume-refusal', async () => {
  const admin = await actor('admin');
  const pathfinder = fixtures().characters.pathfinder;
  const runId = 'browser-interrupted-run';
  const startedAt = new Date().toISOString();

  await step('a resident run left running by a dead process is classified on the next start', async () => {
    write("INSERT INTO resident_runs(id,account_id,agent_id,permission,status,phase,interrupted,stop_reason,decision,decision_budget,model_calls,action_count,failed_calls,failed_actions,last_action,pending_action,credential_hash,minutes,resumed_from,started_at,updated_at) VALUES(?,?,?,?,'running','model_call','','',0,8,0,0,0,0,'{}','{}','',2,NULL,?,?)",
      runId, state.fixtures.admin.id, pathfinder.id, 'explore', startedAt, startedAt);
    // Recovery classifies worker jobs left running, so the fixture records both halves of the pair
    // the shipped server writes when it starts a managed resident.
    write('INSERT INTO jobs(id,agent_id,status,detail,created_at) VALUES(?,?,?,?,?)', runId, pathfinder.id, 'running', 'Local resident: up to 8 model decisions, 2 minutes; explore permissions.', startedAt);
    expect(row('SELECT status,phase FROM resident_runs WHERE id=?', runId).status === 'running', 'the fixture run must start as running', { actual: 'the run was not stored' });
    await stopServer();
    await startServer();
    const classified = await waitForCondition(async () => {
      const stored = row('SELECT status,interrupted,stop_reason,decision_budget,decision FROM resident_runs WHERE id=?', runId);
      return stored?.status === 'interrupted' ? stored : null;
    }, 'the restart to classify the interrupted run');
    expect(classified.stop_reason === 'process_restart', 'the classification must name the process restart', { expected: 'process_restart', actual: describe(classified.stop_reason) });
    expect(Boolean(classified.interrupted), 'the classification must record what was in flight', { actual: describe(classified.interrupted) });
    return `after the restart: status=interrupted, interrupted=${classified.interrupted}, stop_reason=${classified.stop_reason}`;
  });

  await step('the history shows the interrupted run and offers the bounded resume', async () => {
    await openApp(admin.page, ACTORS.admin);
    await openTab(admin.page, 'My contributions');
    const record = admin.page.locator('#view .record', { hasText: 'decisions left' }).first();
    await record.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const text = await record.textContent();
    expect(/Pathfinder · explore run/.test(text), 'the run record must name the resident and its permission mode', { actual: text?.replace(/\s+/g, ' ').slice(0, 200) });
    expect(/interrupted/i.test(text), 'the run record must report the interruption', { actual: text?.slice(0, 200) });
    expect(/8 decisions left/.test(text), 'the run record must report the remaining decision budget', { actual: text?.slice(0, 220) });
    const resume = admin.page.locator('#view').getByRole('button', { name: 'Resume this interrupted run', exact: true });
    expect(await resume.count() === 1, 'the interface must offer exactly one bounded resume', { actual: `resume buttons=${await resume.count()}` });
    return `${text.replace(/\s+/g, ' ').slice(0, 140)} · one resume control offered`;
  });

  await step('the resume is refused without a configured local model and starts nothing', async () => {
    const runsBefore = count('SELECT COUNT(*) AS n FROM resident_runs WHERE account_id=?', state.fixtures.admin.id);
    const tokensBefore = count('SELECT COUNT(*) AS n FROM tokens WHERE account_id=? AND kind=?', state.fixtures.admin.id, 'runtime');
    await admin.page.locator('#view').getByRole('button', { name: 'Resume this interrupted run', exact: true }).click();
    await admin.page.locator('#notice.error').waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const message = (await admin.page.locator('#notice').textContent())?.trim();
    expect(/local model/i.test(message), 'the refusal must explain that no local model is configured', { expected: 'a message about the local model', actual: describe(message) });
    expect(count('SELECT COUNT(*) AS n FROM resident_runs WHERE account_id=?', state.fixtures.admin.id) === runsBefore, 'a refused resume must start no new run', { expected: `${runsBefore} runs`, actual: count('SELECT COUNT(*) AS n FROM resident_runs WHERE account_id=?', state.fixtures.admin.id) });
    expect(count('SELECT COUNT(*) AS n FROM tokens WHERE account_id=? AND kind=?', state.fixtures.admin.id, 'runtime') === tokensBefore, 'a refused resume must mint no credential', { expected: `${tokensBefore} runtime tokens`, actual: count('SELECT COUNT(*) AS n FROM tokens WHERE account_id=? AND kind=?', state.fixtures.admin.id, 'runtime') });
    const stillInterrupted = row('SELECT status FROM resident_runs WHERE id=?', runId);
    expect(stillInterrupted.status === 'interrupted', 'the interrupted run must remain untouched', { expected: 'interrupted', actual: describe(stillInterrupted.status) });
    return `refused: ${message} · no run, no credential`;
  });
  return 'recovery classified the interrupted run and the interface refused an unbounded resume';
});

// ---------------------------------------------------------------------------------------------
// Scenarios 15–16 — the shared-world event channel, driven in two real browsers
//
// The page exposes a read-only introspection hook (`window.__nemoworld`) so a scenario can read what
// the *other* client's view actually holds. It reports only data the page already renders.
// ---------------------------------------------------------------------------------------------

const clientStream = (page) => page.evaluate(() => window.__nemoworld?.stream?.() || null);
const clientWorld = (page) => page.evaluate(() => window.__nemoworld?.world?.() || {});
const clientPresence = (page) => page.evaluate(() => window.__nemoworld?.presence?.() || []);
const clientClosed = (page) => page.evaluate(() => window.__nemoworld?.lastClosed?.() || null);
const waitForClient = (page, evaluator, argument, label, timeout = 6000) =>
  waitForCondition(() => page.evaluate(evaluator, argument), label, { timeout, interval: 50 });

/** Real animation-frame timestamps the browser delivers, sampled while a presence tween is running. */
function clientFrameCadence(page, durationMs = 400) {
  return page.evaluate((duration) => new Promise((resolve) => {
    const stamps = [];
    const start = performance.now();
    const tick = (now) => { stamps.push(now); if (now - start < duration) requestAnimationFrame(tick); else resolve(stamps); };
    requestAnimationFrame(tick);
  }), durationMs);
}

const frameIntervals = (stamps) => stamps.slice(1).map((value, index) => value - stamps[index]);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Point one browser at a world by making its selected resident travel there through the interface. */
async function openWorldAs(page, agentId) {
  await openTab(page, 'Open world');
  const select = page.locator('#view select[name="agent"]');
  // Re-selecting also returns an operator from Look around to its resident. Preserve the trailing
  // world refresh before the next helper reads local permissions or the nearby guest directory.
  if(await select.count()){await select.selectOption(agentId);await settle(page);await page.waitForTimeout(500);}
}

/**
 * Points a visitor's browser at a public garden through the world directory and waits until its
 * event channel is actually open on that world. The stream is verified to be ready *and* bound to
 * the garden, so a leftover ready stream on another world can never stand in for this subscription.
 */
async function outsiderLooksAtPublicGarden(page, ownerName, garden, timeout = 15_000) {
  await openTab(page, 'Explore worlds');
  const search = page.locator('#view form').filter({ has: page.locator('[aria-label="World or garden name"]') });
  await search.locator('[aria-label="World or garden name"]').fill(ownerName);
  await search.getByRole('button', { name: 'Search gardens', exact: true }).click();
  await settle(page);
  const card = page.locator('#view .world-directory-card', { hasText: ownerName }).first();
  await card.waitFor({ state: 'visible' });
  await card.getByRole('button', { name: 'Look around', exact: true }).click();
  await settle(page);
  return waitForClient(page, (world) => { const s = window.__nemoworld?.stream?.(); return s && s.ready && s.world === world ? s : null; }, garden, 'the outsider to subscribe to the public garden', timeout);
}

define('shared-presence-two-clients', async () => {
  const owner = await actor('owner');
  const stranger = await actor('stranger');
  const walker = fixtures().characters.walker;
  const neighbour = fixtures().characters.neighbour;
  const steward = fixtures().characters.steward;
  const garden = `home:${walker.id}`;

  await step('both residents stand in the Commons and both browsers hold a live subscription', async () => {
    for (const [ticket, agentId] of [[fixtures().owner, walker.id], [fixtures().stranger, neighbour.id]]) {
      const current = row('SELECT world_id FROM agents WHERE id=?', agentId).world_id;
      if (current !== 'commons') await apiExpect(ticket, 'POST', `/agents/${agentId}/travel`, { world_id: 'commons' });
    }
    await openApp(owner.page, ACTORS.owner);
    await openWorldAs(owner.page, walker.id);
    await openApp(stranger.page, ACTORS.stranger);
    await openWorldAs(stranger.page, neighbour.id);
    const ownerStream = await waitForClient(owner.page, () => { const s = window.__nemoworld?.stream?.(); return s && s.ready && s.world === 'commons' ? s : null; }, null, 'the owner browser to subscribe to the Commons');
    const otherStream = await waitForClient(stranger.page, () => { const s = window.__nemoworld?.stream?.(); return s && s.ready && s.world === 'commons' ? s : null; }, null, 'the second browser to subscribe to the Commons');
    expect(ownerStream.world === 'commons' && otherStream.world === 'commons', 'both browsers must hold a subscription to the world they are showing', { actual: describe({ owner: ownerStream, other: otherStream }) });
    return `two Server-Sent Events subscriptions on commons (event channel ready on both pages)`;
  });

  await step('client A walks and client B’s view follows over the channel', async () => {
    const before = row('SELECT x,y FROM agents WHERE id=?', walker.id);
    const started = Date.now();
    // Sample the observing browser's real animation-frame cadence while the interpolation runs.
    const cadence = clientFrameCadence(stranger.page, 450);
    let moved = null;
    for (const direction of ['Move up', 'Move left', 'Move down', 'Move right']) {
      await owner.page.locator(`#view button[aria-label="${direction}"]`).click();
      await owner.page.waitForTimeout(450);
      const current = row('SELECT x,y FROM agents WHERE id=?', walker.id);
      if (Math.abs(current.x - before.x) + Math.abs(current.y - before.y) === 1) { moved = current; break; }
    }
    expect(moved, 'the walked resident must step exactly one tile', { expected: `one tile from ${before.x},${before.y}`, actual: describe(row('SELECT x,y FROM agents WHERE id=?', walker.id)) });
    const seen = await waitForClient(stranger.page, ([id, x, y]) => {
      const agent = window.__nemoworld?.world?.()?.participants?.find((item) => item.id === id);
      return agent && agent.x === x && agent.y === y ? { x: agent.x, y: agent.y } : null;
    }, [walker.id, moved.x, moved.y], 'the second browser to show the walked tile', 2000);
    expect(seen.x === moved.x && seen.y === moved.y, 'the other client must show the server-confirmed tile', { expected: `${moved.x},${moved.y}`, actual: describe(seen) });
    // The published tile must equal what the database stores, so the view never invents a position.
    const stored = row('SELECT x,y FROM agents WHERE id=?', walker.id);
    expect(stored.x === moved.x && stored.y === moved.y, 'the database must agree with the pushed tile', { expected: `${moved.x},${moved.y}`, actual: describe(stored) });
    const stream = await clientStream(stranger.page);
    const presence = await clientPresence(stranger.page);
    const record = presence.find((item) => item.id === walker.id);
    expect(record && record.confirmed.x === moved.x && record.confirmed.y === moved.y, 'the second client’s presence record must hold the confirmed tile', { actual: describe(record) });
    const intervals = frameIntervals(await cadence);
    const elapsed = Date.now() - started;
    const cadenceSummary = intervals.length ? `animation frames: median ${median(intervals).toFixed(1)} ms, max ${Math.max(...intervals).toFixed(1)} ms over ${intervals.length + 1} frames` : 'no animation frames were observed';
    state.notes.push(`move: click → the other client’s view in ${elapsed} ms; channel frame delivery ${stream.lastLatencyMs} ms; ${cadenceSummary}`);
    return `walker ${before.x},${before.y} → ${moved.x},${moved.y}; the other browser showed it in ${elapsed} ms (frame latency ${stream.lastLatencyMs} ms); ${cadenceSummary}`;
  });

  await step('a private message never reaches the other client, and a public one does', async () => {
    const secret = 'A browser private note that must never reach another client';
    const publicText = 'A browser public greeting that both clients may read';
    await apiExpect(fixtures().owner, 'POST', '/messages', { agent_id: walker.id, channel: 'private', recipient_id: steward.id, text: secret }, [200]);
    await stranger.page.waitForTimeout(1600);
    const afterPrivate = await clientWorld(stranger.page);
    expect(!afterPrivate.messages.some((message) => message.text === secret), 'a private message must never enter another client’s state', { actual: describe(afterPrivate.messages.map((message) => message.text).slice(-5)) });
    const dom = await stranger.page.locator('#view').textContent();
    expect(!dom.includes(secret), 'a private message must never be rendered for another client', { actual: 'the private text appeared on the page' });
    await owner.page.waitForTimeout(1600);
    await apiExpect(fixtures().owner, 'POST', '/messages', { agent_id: walker.id, channel: 'public', text: publicText }, [200]);
    await waitForClient(stranger.page, (text) => (window.__nemoworld?.world?.()?.messages || []).some((message) => message.text === text) ? text : null, publicText, 'the public message to reach the second client');
    return `the private note stayed private while the public greeting reached the other client`;
  });

  await step('client A returns home and client B follows it into the garden', async () => {
    await owner.page.locator('#view').getByRole('button', { name: 'Go home', exact: true }).click();
    await settle(owner.page);
    await owner.page.waitForTimeout(700);
    const home = row('SELECT world_id FROM agents WHERE id=?', walker.id).world_id;
    expect(home === garden, 'the resident must arrive in its own garden', { expected: garden, actual: describe(home) });

    await apiExpect(fixtures().stranger, 'POST', `/agents/${neighbour.id}/travel`, { world_id: garden });
    await stranger.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(stranger.page);
    await openWorldAs(stranger.page, neighbour.id);
    const ownerStream = await waitForClient(owner.page, (world) => { const s = window.__nemoworld?.stream?.(); return s && s.ready && s.world === world ? s : null; }, garden, 'the owner browser to subscribe to the garden');
    const otherStream = await waitForClient(stranger.page, (world) => { const s = window.__nemoworld?.stream?.(); return s && s.ready && s.world === world ? s : null; }, garden, 'the second browser to subscribe to the garden');
    const otherWorld = await clientWorld(stranger.page);
    const walkerVisible = otherWorld.participants?.some((agent) => agent.id === walker.id);
    expect(walkerVisible, 'the second client must see the resident that already stands in the garden', { actual: describe(otherWorld.participants?.map((agent) => agent.id)) });
    return `${garden} streams to both browsers (${ownerStream.world} / ${otherStream.world}); both residents are present`;
  });

  await step('client A builds an object and client B’s view updates without a world rebuild', async () => {
    const objectsBefore = count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden);
    await owner.page.locator('#view').getByRole('button', { name: 'Start building', exact: true }).click();
    await settle(owner.page);
    const buildForm = owner.page.locator('#view form').filter({ has: owner.page.getByRole('button', { name: 'Apply at tile', exact: true }) });
    await owner.page.locator('#view select[name="kind"]').selectOption('bench');
    await buildForm.locator('input[name="x"]').fill('17');
    await buildForm.locator('input[name="y"]').fill('4');
    await buildForm.getByRole('button', { name: 'Apply at tile', exact: true }).click();
    const saved = await waitForCondition(async () => row('SELECT type,x,y FROM world_objects WHERE world_id=? AND x=17 AND y=4', garden), 'the placed object to be stored');
    expect(saved.type === 'bench', 'the saved object must be the chosen one', { expected: 'bench', actual: describe(saved) });
    expect(count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden) === objectsBefore + 1, 'exactly one object must be added', { actual: `${count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden)} objects` });
    const seen = await waitForClient(stranger.page, ([x, y]) => {
      const object = (window.__nemoworld?.world?.()?.objects || []).find((item) => item.x === x && item.y === y);
      return object ? object : null;
    }, [17, 4], 'the second browser to show the placed object', 2500);
    expect(seen.type === 'bench', 'the other client must show the stored object type', { expected: 'bench', actual: describe(seen) });
    const stream = await clientStream(stranger.page);
    state.notes.push(`build: object delta delivered to the other client (channel frame delivery ${stream.lastLatencyMs} ms)`);
    return `world_objects row bench at 17,4 attributed to ${walker.id}; the other browser showed it (frame latency ${stream.lastLatencyMs} ms)`;
  });

  await step('a character profile opens a saved direct text conversation', async () => {
    await openTab(owner.page, 'World list');
    const profile = owner.page.locator('#view .agent-row', { hasText: neighbour.name }).first();
    await profile.getByRole('button', { name: 'Send direct message', exact: true }).click();
    const form = owner.page.locator('#world-chat-card form');
    expect(await form.locator('[name="channel"]').inputValue() === 'private', 'the profile action must select the private channel');
    expect(await form.locator('[name="recipient_id"]').inputValue() === neighbour.id, 'the profile action must address the chosen character');
    const text = 'A saved hello from the character profile';
    await form.locator('[name="text"]').fill(text);
    await form.getByRole('button', { name: 'Send message', exact: true }).click();
    const saved = await waitForCondition(async () => row('SELECT agent_id,channel,recipients,text FROM messages WHERE text=?', text), 'the direct message to be saved');
    expect(saved.agent_id === walker.id && saved.channel === 'private' && JSON.parse(saved.recipients).includes(neighbour.id), 'the saved conversation must retain sender, private channel and recipient', { actual: describe(saved) });
    await stranger.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(stranger.page);
    const received = await clientWorld(stranger.page);
    expect(received.messages.some(message => message.text === text && message.channel === 'private'), 'the recipient operator must be able to read the stored message');
    return 'the profile selected a private recipient; the database saved the text and the recipient operator read it';
  });

  return 'two real browsers saw each other move and build, with the database agreeing and no private data crossing';
});

define('subscription-entitlement-and-revocation', async () => {
  const owner = await actor('owner');
  const stranger = await actor('stranger');
  const walker = fixtures().characters.walker;
  const garden = `home:${walker.id}`;

  await step('a public garden streams to an outsider', async () => {
    await apiPatch(fixtures().owner, `/agents/${walker.id}/home`, { visibility: 'public' });
    await openApp(stranger.page, ACTORS.stranger);
    // Point the visitor at the public garden through the world directory; the world view subscribes to it.
    const stream = await outsiderLooksAtPublicGarden(stranger.page, walker.name, garden);
    expect(stream.world === garden, 'a public garden must stream to a signed-in outsider', { actual: describe(stream) });
    expect(count('SELECT COUNT(*) AS n FROM worlds WHERE id=? AND visibility=?', garden, 'public') === 1, 'the garden must be public in the database', { actual: 'the garden was not public' });
    return `a live subscription on the public garden ${garden}`;
  });

  await step('making the garden private closes the outsider’s subscription', async () => {
    // The notice area holds one message at a time and the client writes more than one as the feed is
    // closed: the revocation sentence, and the refusal a later world read raises for itself. Record
    // every notice from here on, so a sentence the client really wrote cannot be lost to a later
    // overwrite and read as “the client never explained it”.
    await stranger.page.evaluate(() => {
      const node = document.querySelector('#notice');
      window.__noticeHistory = [];
      if (!node) return;
      const record = () => {
        const text = (node.textContent || '').trim();
        if (text && window.__noticeHistory[window.__noticeHistory.length - 1] !== text) window.__noticeHistory.push(text);
      };
      record();
      new MutationObserver(record).observe(node, { childList: true, characterData: true, subtree: true });
    });
    await apiPatch(fixtures().owner, `/agents/${walker.id}/home`, { visibility: 'private' });
    const closed = await waitForClient(stranger.page, () => { const c = window.__nemoworld?.lastClosed?.(); return c && c.reason === 'access_revoked' ? c : null; }, null, 'the outsider’s subscription to be revoked', 5000);
    expect(closed.reason === 'access_revoked', 'the revocation must name the lost access', { expected: 'access_revoked', actual: describe(closed) });
    // The close event and the visible notice are separate client updates, so wait for the recorded
    // history to carry the reason rather than sampling the element, which a later notice overwrites.
    let notice = '', history = [];
    try {
      notice = await waitForClient(stranger.page, () => {
        const seen = window.__noticeHistory || [];
        return seen.find((text) => /no longer open to you|garden is now private/i.test(text)) || null;
      }, null, 'the client’s notice to explain why the live feed stopped', 5000);
    } catch { /* The history below carries what the page did show. */ }
    history = await stranger.page.evaluate(() => window.__noticeHistory || []).catch(() => []);
    if (!notice) notice = history.find((text) => /no longer open to you|garden is now private/i.test(text)) || history[history.length - 1] || '';
    expect(/no longer open to you|garden is now private/i.test(notice || ''), 'the client must explain why the live feed stopped', { expected: 'a notice naming the lost access or the private garden', actual: describe({ observed: (notice || '').trim().slice(0, 160), history: history.map((text) => text.slice(0, 160)) }) });
    const refused = await inPage(stranger.page, `/events?world_id=${encodeURIComponent(garden)}`, { method: 'GET' });
    expect(refused.status === 403, 'an authenticated but unentitled client must be refused the private channel', { expected: 'HTTP 403', actual: `HTTP ${refused.status}` });
    return `access_revoked closed the stream and a fresh subscription answered ${refused.status}`;
  });

  await step('a session revoked mid-subscription loses its live feed', async () => {
    // Reopen the public garden, then use a fresh signed-in browser context. The earlier browser's
    // spectator was intentionally stopped by access_revoked and has a remembered private-world view;
    // it must not stand in for a new subscription. Revoke only this context's cookie hash so later
    // scenarios keep their own fixture account session.
    await apiPatch(fixtures().owner, `/agents/${walker.id}/home`, { visibility: 'public' });
    expect(count('SELECT COUNT(*) AS n FROM worlds WHERE id=? AND visibility=?', garden, 'public') === 1, 'the garden must be public again before the visitor resubscribes', { actual: describe(row('SELECT id,visibility FROM worlds WHERE id=?', garden)) });
    const revocationClient = await context('revocation-client');
    await openApp(revocationClient.page, ACTORS.stranger);
    const stream = await outsiderLooksAtPublicGarden(revocationClient.page, walker.name, garden);
    expect(stream.ready && stream.world === garden, 'the visitor must hold a fresh subscription to the reopened garden', { expected: `a ready stream on ${garden}`, actual: describe(stream) });
    const cookie=(await revocationClient.context.cookies(baseUrl())).find((item)=>item.name==='world_session');
    expect(cookie?.value, 'the browser must hold a distinct HttpOnly session cookie before revocation');
    const hash=createHash('sha256').update(cookie.value).digest('hex');
    write("UPDATE tokens SET revoked=1 WHERE kind='session' AND hash=?", hash);
    const closed = await waitForClient(revocationClient.page, () => { const c = window.__nemoworld?.lastClosed?.(); return c && c.reason === 'session_revoked' ? c : null; }, null, 'the revoked session to lose its subscription', 8000);
    expect(closed.reason === 'session_revoked', 'a revoked credential must end the subscription', { expected: 'session_revoked', actual: describe(closed) });
    const revoked=row("SELECT revoked FROM tokens WHERE hash=? AND kind='session'",hash);
    expect(revoked?.revoked===1, 'the exact browser credential must be revoked in the database', { actual: describe(revoked) });
    return 'session_revoked closed the feed while that browser’s exact session token was revoked';
  });

  return 'a private world and a revoked session both ended the live feed for a client that lost its right to it';
});

// ---------------------------------------------------------------------------------------------
// Scenarios 17–21 — direct, purposeful world interaction
//
// Every scenario here drives the real interaction panel in a real browser: it types or picks a tile,
// reads what the server says the tile offers, uses the action control, and then reads the server's own
// records to confirm the change. The panel is only a reader and a sender; the fixture, the distance
// requirement, the refusal and the saved effect all come from the server.
// ---------------------------------------------------------------------------------------------

/** One interaction panel form: the action control, not the tile reader. */
const interactionActionForm = (page) => page.locator('#interaction-panel form.interaction-form');
const interactionReadForm = (page) => page.locator('#interaction-panel form').filter({ has: page.getByRole('button', { name: 'Read this tile', exact: true }) });

/** Reads one tile through the panel's typed coordinates — the keyboard and text equivalent. */
async function readInteractionTile(page, x, y) {
  const form = interactionReadForm(page);
  await form.locator('[aria-label="Tile X"]').fill(String(x));
  await form.locator('[aria-label="Tile Y"]').fill(String(y));
  await form.getByRole('button', { name: 'Read this tile', exact: true }).click();
  return waitForCondition(async () => {
    const text = (await page.locator('#interaction-hint').textContent().catch(() => ''))?.trim() || '';
    return text.includes(`${x}, ${y}`) ? text : null;
  }, `the interaction panel to read tile ${x}, ${y}`);
}

/**
 * Walks the resident to a tile with the documented typed walk form, and waits for the stored step.
 * One grid step at a time, and each step re-reads the voxel snapshot, so a long walk is slow — which
 * is also when the server's own 120 ms movement throttle can refuse a step under load and stop the
 * client's walk. The suite then resumes the same walk from where the resident stands, a bounded
 * number of times, counting each retry instead of treating a documented refusal as a failure.
 */
async function walkResidentTo(page, agentId, x, y, { timeout = 100_000 } = {}) {
  const deadline = Date.now() + timeout;
  const form = page.locator('#view .walk-to-tile form');
  await form.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  const atTile = () => { const position = row('SELECT x,y,world_id FROM agents WHERE id=?', agentId); return position && position.x === x && position.y === y ? position : null; };
  let retries = 0;
  while (Date.now() < deadline) {
    await form.locator('[aria-label="Tile X"]').fill(String(x));
    await form.locator('[aria-label="Tile Y"]').fill(String(y));
    await form.getByRole('button', { name: 'Walk to tile', exact: true }).click();
    const arrived = await waitForCondition(atTile, `the resident to walk to ${x}, ${y}`, { timeout: Math.min(60_000, Math.max(2000, deadline - Date.now())) }).catch(() => null);
    if (arrived) {
      if (retries) state.notes.push(`the walk to ${x}, ${y} was resumed ${retries} time(s) after the server’s own movement throttle refused a step`);
      return arrived;
    }
    const notice = ((await page.locator('#notice').textContent().catch(() => '')) || '').trim();
    if (!throttleRefusal(notice)) {
      throw new BrowserSuiteFailure(`the walk to ${x}, ${y} stopped short`, { expected: `the resident at ${x}, ${y}`, actual: `${describe(row('SELECT x,y,world_id FROM agents WHERE id=?', agentId))}; the interface said “${notice}”` });
    }
    retries += 1;
    console.log(`        walk retry       the server’s own movement throttle refused a step; resuming the walk to ${x}, ${y}`);
    await page.waitForTimeout(800);
  }
  throw new BrowserSuiteFailure(`the resident never reached ${x}, ${y}`, { expected: `the resident at ${x}, ${y}`, actual: describe(row('SELECT x,y,world_id FROM agents WHERE id=?', agentId)) });
}

/** One documented travel route, waiting out the server's own 120 ms movement throttle. */
async function travelTo(ticket, agentId, worldId) {
  let last = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await api(ticket, 'POST', `/agents/${agentId}/travel`, { world_id: worldId });
    if (response.status === 200) return response.body;
    last = `HTTP ${response.status} ${response.raw}`;
    if (response.status !== 429) break;
    await sleep(250);
  }
  throw new BrowserSuiteFailure(`fixture travel to ${worldId} was refused`, { expected: 'HTTP 200', actual: last });
}

/**
 * Places a resident on one tile with a fixture write. This is scenario setup only — the walk, the
 * travel and every action afterwards are real server actions — so a forty-step walk across the
 * Commons does not stand between the scenario and the interaction it is testing.
 */
function placeResident(agentId, worldId, x, y) {
  write('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', worldId, x, y, agentId);
}

/** Returns a resident to the Commons arrival through the documented travel route (home, then commons). */
async function sendToCommons(ticket, agentId) {
  const world = () => row('SELECT world_id FROM agents WHERE id=?', agentId).world_id;
  if (world() !== `home:${agentId}` && world() !== 'commons') await travelTo(ticket, agentId, `home:${agentId}`);
  if (world() !== 'commons') await travelTo(ticket, agentId, 'commons');
}

define('interaction-hint-and-distance', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const wanderer = fixtures().characters.wanderer;

  await step('the panel names the fixture beside the resident, the interaction and the requirement', async () => {
    await sendToCommons(fixtures().admin, wanderer.id);
    await openApp(page, ACTORS.admin);
    await openWorldAs(page, wanderer.id);
    const hint = await readInteractionTile(page, 11, 6);
    expect(/Door at 11, 6/.test(hint), 'the hint must name the fixture and its tile', { actual: hint });
    expect(/Enter Meeting Hall/.test(hint), 'the hint must name the available interaction', { actual: hint });
    expect(/Manhattan distance 1/.test(hint), 'the hint must state the distance requirement', { actual: hint });
    expect(/1 tile away, so you can use it now/.test(hint), 'the hint must state the measured distance', { actual: hint });
    const panel = await page.locator('#interaction-panel').textContent();
    expect(/Available now/.test(panel), 'the panel must name the next usable step', { actual: panel?.replace(/\s+/g, ' ').slice(0, 300) });
    expect(/Door · Meeting Hall/.test(panel), 'the panel must head the fixture it read', { actual: panel?.slice(0, 120) });
    state.notes.push(`interaction hint: ${hint.slice(0, 170)}`);
    return hint.slice(0, 150);
  });

  await step('a fixture out of reach is refused with its own status and the way to approach', async () => {
    const hint = await readInteractionTile(page, 35, 24);
    expect(/Door at 35, 24/.test(hint), 'the hint must still name the fixture it read', { actual: hint });
    const panel = await page.locator('#interaction-panel').textContent();
    expect(/out of reach/.test(panel), 'the panel must report the distance as out of reach', { actual: panel?.replace(/\s+/g, ' ').slice(0, 300) });
    expect(/Step onto or beside 35, 24/.test(panel), 'the next step must explain how to approach', { actual: panel?.replace(/\s+/g, ' ').slice(0, 300) });
    const before = row('SELECT world_id,x,y FROM agents WHERE id=?', wanderer.id);
    // The interface sends the intent and the server refuses it: the status is the server's own.
    const refused = await inPage(page, '/interact', { body: { agent_id: wanderer.id, x: 35, y: 24, action: 'travel' }, headers: { 'Idempotency-Key': 'browser-interaction-far-door' } });
    expect(refused.status === 409, 'an out-of-range interaction must fail with its own status', { expected: 'HTTP 409', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(/43 tiles away/.test(refused.body?.error || ''), 'the refusal must state the measured distance', { actual: describe(refused.body?.error) });
    expect(/Step onto or beside 35, 24/.test(refused.body?.next_step || ''), 'the refusal must state the next usable step', { actual: describe(refused.body?.next_step) });
    const after = row('SELECT world_id,x,y FROM agents WHERE id=?', wanderer.id);
    expect(after.world_id === before.world_id && after.x === before.x && after.y === before.y, 'a refused interaction must not move the resident', { expected: describe(before), actual: describe(after) });
    // The same refusal reaches the interface itself: the action control is a real request, not a
    // disabled button, so the user reads the server's own answer and how to satisfy it.
    await interactionActionForm(page).getByRole('button', { name: /^Enter The Makers/ }).click();
    const surfaced = await waitForCondition(async () => {
      const text = (await page.locator('#interaction-hint').textContent().catch(() => ''))?.trim() || '';
      return /Step onto or beside 35, 24/.test(text) ? text : null;
    }, 'the interface to show the server’s refusal and the way to approach');
    expect(/43 tiles away/.test(surfaced), 'the interface must repeat the server’s own refusal', { actual: surfaced });
    expect(row('SELECT world_id FROM agents WHERE id=?', wanderer.id).world_id === 'commons', 'the refused click must leave the resident where it stood', { actual: describe(row('SELECT world_id FROM agents WHERE id=?', wanderer.id)) });
    return `409 ${refused.body.error} · the panel then showed “${surfaced.slice(0, 120)}…”`;
  });
  return 'the hint named the fixture, the interaction and the one-tile requirement, and an out-of-range click failed with the server’s own status and next step';
});

define('game-hud-interaction-prompt-and-aim', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const wanderer = fixtures().characters.wanderer;

  await step('the game presentation opens the selected resident with its HUD', async () => {
    await sendToCommons(fixtures().admin, wanderer.id);
    // Select the fixture resident in the workspace first, then return to the shipped game shell.
    // The selected-agent key is the same persisted user choice the game entry restores.
    await openApp(page, ACTORS.admin);
    await openWorldAs(page, wanderer.id);
    await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.locator('#interaction-panel').waitFor({ state: 'visible' });
    expect(Boolean((await page.locator('#game-target').textContent())?.trim()), 'the HUD must name the current aim or an interaction target', { actual: describe(await page.locator('#game-target').textContent()) });
    return 'the selected Commons resident opened the game HUD and its interaction tools';
  });

  await step('reading the nearby doorway updates both the HUD prompt and the readable aim line', async () => {
    const hint = await readInteractionTile(page, 11, 6);
    expect(/Door at 11, 6/.test(hint) && /Enter Meeting Hall/.test(hint), 'the real interaction read must identify the doorway and action', { actual: hint });
    const target = ((await page.locator('#game-target').textContent()) || '').trim();
    expect(target === 'Enter Meeting Hall · 11, 6 · Enter, Space or I to interact', 'the game HUD must expose the server-provided action and its bound keys', { expected: 'Enter Meeting Hall · 11, 6 · Enter, Space or I to interact', actual: target });
    const interact = page.locator('#game-interact-button');
    expect(await interact.isEnabled(), 'an in-range fixture must enable the HUD interaction control', { actual: 'the Interact button stayed disabled' });
    const aim = ((await page.locator('#world-reticle').textContent()) || '').trim();
    expect(/Door at 11, 6|meeting hall/i.test(aim), 'the aim line must carry the selected fixture context', { actual: aim });
    expect(/Enter, Space or I/.test(aim), 'the aim line must expose the keyboard interaction keys', { actual: aim });
    return `HUD prompt “${target}” · aim line carries the doorway and Enter/Space/I guidance`;
  });

  return 'the real game HUD, interaction control and aim line stayed synchronized after reading a usable doorway';
});

/**
 * The HUD's next-passage line, the visible half of the server's `next_passage` field. The scenario
 * re-composes the line from the payload the client is holding, so a client-invented label, direction,
 * distance or count fails here, and it checks the five states the line must tell apart: a resident
 * with a passage, that same resident after a confirmed step, a resident standing on the passage the
 * server planned an empty route to, a paused world (the payload still carries a cue, so withholding it
 * is the HUD's own honest choice), and a viewer with no resident at all (the server sends `null` and
 * the HUD must show nothing rather than an empty or invented hint).
 */
define('next-passage-cue', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const wanderer = fixtures().characters.wanderer;
  // A browser with no resident in this world. The server answers such a viewer with `next_passage:
  // null` (pinned by tests/passage-cue.test.js), and the HUD must not turn that into a hint.
  const observer = await context('next-passage-cue-observer');

  /** The cue exactly as this client holds the server's payload. */
  const payloadCue = (target) => target.evaluate(() => window.__nemoworld?.world?.()?.next_passage ?? null);
  /** The rendered line: its text, and whether it is actually shown. */
  const hudLine = (target) => target.evaluate(() => {
    const node = document.querySelector('#game-next-passage');
    if (!node) return { exists: false, text: '', hidden: false, visible: false, live: null };
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    return {
      exists: true, text: (node.textContent || '').trim(), hidden: Boolean(node.hidden),
      visible: style.display !== 'none' && style.visibility !== 'hidden' && !node.hidden && box.height > 0 && box.width > 0,
      // The cue must not be a live region: the step count changes as the resident walks and the world
      // poll re-reads it every three seconds, so announcing it would interrupt a screen reader.
      live: node.getAttribute('aria-live'),
    };
  });
  /** The line the HUD claims to compose, re-made from the server's own two fields. */
  const composed = (cue) => `${cue.label} · ${cue.steps} step${cue.steps === 1 ? '' : 's'}`;
  /** The revealed cue: the payload's own field paired with the visible line, or null while they disagree. */
  const revealed = async (target) => {
    const cue = await payloadCue(target), line = await hudLine(target);
    return cue && cue.kind && line.visible ? { cue, line } : null;
  };
  const position = () => row('SELECT x,y FROM agents WHERE id=?', wanderer.id);
  /** The world cardinal one grid step produces on this world's axes. */
  const cardinalOf = (dx, dy) => (dy === -1 ? 'up' : dy === 1 ? 'down' : dx === 1 ? 'right' : 'left');
  /** The four cardinals clockwise, used to read the whole control map from one measured step. */
  const CARDINAL_CYCLE = { up: 'right', right: 'down', down: 'left', left: 'up' };
  /**
   * Which movement control carries which world direction. It is read from the first confirmed step
   * this scenario measures rather than assumed: a control's direction is relative to the camera in
   * first person, and the mapping preserves this cycle, so one measured step names all four.
   */
  const controlFor = {};

  await step('the HUD names the passage the server sends for this resident', async () => {
    await sendToCommons(fixtures().admin, wanderer.id);
    await openApp(page, ACTORS.admin);
    await openWorldAs(page, wanderer.id);
    await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    const first = await waitForCondition(() => revealed(page), 'the HUD to show the passage the server sends for its own resident');
    const expected = composed(first.cue);
    expect(first.line.text === expected, 'the HUD must compose the cue from the server’s own label and planned route length', { expected, actual: first.line.text });
    expect(first.line.live === null, 'the cue must not be a live region the world poll re-announces', { expected: 'no aria-live attribute', actual: describe(first.line.live) });
    // The named tile must be a passage this payload really exposes, not a decorative point.
    const exposed = await page.evaluate(({ x, y }) => {
      const view = window.__nemoworld.world();
      return {
        portal: (view.portals || []).some((item) => item.x === x && item.y === y),
        gate: ((view.frontier && view.frontier.gates) || []).some((item) => item.x === x && item.y === y),
        world: view.world && view.world.name,
      };
    }, { x: first.cue.x, y: first.cue.y });
    expect(exposed.portal || exposed.gate || first.cue.kind === 'portal', 'the named passage must be one the payload itself exposes', { actual: describe({ kind: first.cue.kind, x: first.cue.x, y: first.cue.y, exposed }) });
    // It describes the resident's own world, and the HUD is showing that same world.
    const shown = await page.evaluate(() => ({ id: window.__nemoworld?.worldId?.() || '', name: document.querySelector('.game-place strong')?.textContent?.trim() || '' }));
    expect(first.cue.world_id === shown.id, 'the cue must describe the world the resident stands in', { expected: shown.id, actual: first.cue.world_id });
    expect(shown.name && shown.name === exposed.world, 'the HUD must be showing that same world', { expected: exposed.world, actual: shown.name });
    state.notes.push(`next-passage cue: “${first.line.text}” composed from the payload’s own ${first.cue.kind} ${first.cue.label} at ${first.cue.x},${first.cue.y} in ${first.cue.world_id} (${first.cue.distance} tiles, ${first.cue.steps} planned steps)`);
    return `HUD “${first.line.text}” from the payload’s own ${first.cue.label} at ${first.cue.x},${first.cue.y} in ${first.cue.world_id}`;
  });

  await step('a confirmed step re-reads the cue instead of freezing the first wording', async () => {
    const before = await revealed(page);
    const start = position();
    let direction = null, arrived = null;
    for (const candidate of ['Move up', 'Move left', 'Move down', 'Move right']) {
      await page.locator(`#view .world-bottom button[aria-label="${candidate}"]`).click();
      // Bounded: a blocked direction leaves the resident where it stood, and the next control is tried.
      const step_ = await waitForCondition(() => { const now = position(); return now.x !== start.x || now.y !== start.y ? now : null; },
        `the “${candidate}” control to carry one confirmed step`, { timeout: 3000, interval: 100 }).catch(() => null);
      if (step_) { direction = candidate.replace('Move ', ''); arrived = step_; break; }
    }
    expect(direction, 'one of the four movement controls must carry a confirmed step out of the arrival tile', { expected: 'one tile of movement', actual: `${start.x},${start.y} blocked in all four directions` });
    let control = direction, cardinal = cardinalOf(arrived.x - start.x, arrived.y - start.y);
    for (let index = 0; index < 4; index += 1) { controlFor[cardinal] = control; control = CARDINAL_CYCLE[control]; cardinal = CARDINAL_CYCLE[cardinal]; }
    const moved = await waitForCondition(async () => {
      const cue = await payloadCue(page);
      if (!cue || !cue.kind) return null;
      if (cue.label === before.cue.label && cue.steps === before.cue.steps) return null;
      const line = await hudLine(page);
      return line.visible ? { cue, line } : null;
    }, 'the client to read a new cue after the step');
    expect(moved.line.text === composed(moved.cue), 'after the step the HUD must follow the new payload line for line', { expected: composed(moved.cue), actual: moved.line.text });
    expect(moved.line.text !== before.line.text, 'the cue must be recomputed from where the resident stands, not a fixed string', { expected: `a line other than “${before.line.text}”`, actual: moved.line.text });
    expect(arrived.x === moved.cue.from.x && arrived.y === moved.cue.from.y, 'the payload’s own `from` tile must be where the resident now stands', { expected: `${start.x},${start.y} + one ${direction} step`, actual: `${moved.cue.from.x},${moved.cue.from.y}` });
    // Out and back: the walk returns the resident to the tile it started from, so no later scenario
    // shares a moved fixture, and the first wording comes back with the first tile.
    await page.locator(`#view .world-bottom button[aria-label="Move ${OPPOSITE_DIRECTION[direction]}"]`).click();
    const restored = await waitForCondition(async () => {
      const now = position();
      if (now.x !== start.x || now.y !== start.y) return null;
      const line = await hudLine(page);
      return line.visible && line.text === before.line.text ? line : null;
    }, 'the resident to walk back to its starting tile and the cue to return to its first wording');
    state.notes.push(`next-passage cue after one ${direction} step: “${before.line.text}” → “${moved.line.text}” → “${restored.text}” back on ${start.x},${start.y}`);
    return `${start.x},${start.y} → ${arrived.x},${arrived.y} and back: “${before.line.text}” → “${moved.line.text}” → “${restored.text}”`;
  });

  await step('a resident standing on the passage is told the empty route, not nothing', async () => {
    // The arrival tile is one step from the doorway the server names, so standing on that tile makes
    // the server's own planned route empty. The HUD shows the server's answer for that state instead
    // of dropping a cue it was sent, and it stops being empty the moment the resident steps off.
    const before = await revealed(page);
    const start = position();
    // Walking on, then back off: the door tile is one cardinal step from the resident's own tile, and
    // the control for a world direction is read from the step this scenario already measured.
    const control = controlFor[cardinalOf(before.cue.x - start.x, before.cue.y - start.y)];
    expect(control, 'the step that finds the doorway must be one the movement controls can carry', { expected: `a control for the step from ${start.x},${start.y} to ${before.cue.x},${before.cue.y}`, actual: describe(controlFor) });
    await page.locator(`#view .world-bottom button[aria-label="Move ${control}"]`).click();
    const on = await waitForCondition(() => { const now = position(); return now.x === before.cue.x && now.y === before.cue.y ? now : null; },
      'the resident to stand on the passage tile', { timeout: 5000, interval: 100 });
    const standing = await waitForCondition(async () => {
      const cue = await payloadCue(page);
      if (!cue || cue.steps !== 0) return null;
      const line = await hudLine(page);
      return line.visible ? { cue, line } : null;
    }, 'the payload’s own empty route to reach the HUD', { timeout: 10_000 });
    expect(standing.cue.world_id === before.cue.world_id && standing.cue.label === before.cue.label, 'standing on the passage must still name the same passage', { expected: describe({ label: before.cue.label, world_id: before.cue.world_id }), actual: describe({ label: standing.cue.label, world_id: standing.cue.world_id }) });
    expect(standing.line.text === composed(standing.cue), 'the empty route must be shown from the server’s own fields', { expected: composed(standing.cue), actual: standing.line.text });
    await page.locator(`#view .world-bottom button[aria-label="Move ${OPPOSITE_DIRECTION[control]}"]`).click();
    const off = await waitForCondition(async () => {
      const now = position();
      if (now.x !== start.x || now.y !== start.y) return null;
      const line = await hudLine(page);
      return line.visible && line.text === before.line.text ? line : null;
    }, 'the resident to step off the passage and the cue to count steps again', { timeout: 5000 });
    state.notes.push(`next-passage cue standing on the passage: “${standing.line.text}” on ${on.x},${on.y}, back to “${off.text}” on ${start.x},${start.y}`);
    return `on the ${before.cue.label} tile ${on.x},${on.y}: “${standing.line.text}”, back to “${off.text}”`;
  });

  await step('a paused world shows no passage, and resuming brings the same cue back', async () => {
    const before = await revealed(page);
    await apiExpect(fixtures().admin, 'POST', '/operations/pause', { paused: true });
    let withheld = null;
    try {
      withheld = await waitForCondition(async () => {
        const line = await hudLine(page);
        return !line.visible && line.text === '' ? line : null;
      }, 'the HUD to withhold the passage while the world is paused');
      // The payload that hid the line still carries a cue, so the HUD made an honest choice on a
      // paused world rather than the server sending nothing.
      const held = await page.evaluate(() => ({ paused: Boolean(window.__nemoworld.world().paused), cue: window.__nemoworld.world().next_passage }));
      expect(held.paused === true && held.cue && held.cue.kind, 'the hidden line must be the HUD’s own decision on a paused world the server still describes', { expected: 'a paused payload that still carries a cue', actual: describe({ paused: held.paused, kind: held.cue && held.cue.kind }) });
    } finally {
      // The platform pause is a shared setting: it is resumed even when an assertion above failed.
      await apiExpect(fixtures().admin, 'POST', '/operations/pause', { paused: false });
    }
    const resumed = await waitForCondition(async () => { const line = await hudLine(page); return line.visible && line.text === before.line.text ? line : null; }, 'the cue to return when the world resumes');
    expect(!(await page.evaluate(() => Boolean(window.__nemoworld.world().paused))), 'the platform must be running again', { actual: 'the world is still paused' });
    state.notes.push(`next-passage cue while paused: “${before.line.text}” withheld (line ${withheld.exists ? 'present but hidden and empty' : 'absent'}) with the payload still carrying the ${before.cue.kind} ${before.cue.label}, and restored on resume`);
    return `paused: “${before.line.text}” withheld, then “${resumed.text}” restored after the resume`;
  });

  await step('a viewer with no resident is shown no passage at all', async () => {
    const observerPage = observer.page;
    await observerPage.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(observerPage);
    await observerPage.locator('#hero-actions').getByRole('button', { name: /Observe/i }).first().click();
    await settle(observerPage);
    await observerPage.locator('#game-hud').waitFor({ state: 'visible' });
    // `next_passage` is a field of the payload, so a missing payload and a null field are told apart.
    const observed = await observerPage.evaluate(() => {
      const view = window.__nemoworld?.world?.();
      return { payload: Boolean(view), cue: view && 'next_passage' in view ? view.next_passage : 'absent', world: window.__nemoworld?.worldId?.() || '' };
    });
    expect(observed.payload, 'the observing browser must hold a world payload', { actual: 'no payload' });
    expect(observed.cue === null, 'a viewer without a resident must be sent no cue at all', { expected: 'null', actual: describe(observed.cue) });
    const line = await hudLine(observerPage);
    expect(!line.visible && line.text === '', 'the HUD must show nothing rather than an empty or invented hint', { expected: 'no visible passage line', actual: describe(line) });
    state.notes.push(`next-passage cue for a viewer with no resident: payload ${describe(observed.cue)}, the line ${line.exists ? 'present but hidden and empty' : 'absent'}`);
    return `observing ${observed.world} with next_passage=${describe(observed.cue)} and no passage line rendered`;
  });

  return 'the HUD named the passage the payload sent for the resident, followed a confirmed step, withheld the cue on a paused world, and showed nothing for a viewer with no resident';
});

/**
 * The HUD's bottom band and the frontier build tools both own the bottom of the stage. The tools
 * were anchored *onto* the band: at 1440x900 the host measured 252-796px against a band at
 * 705-882px, so `document.elementFromPoint` at the centre of each next-action line returned the
 * placement panel rather than the line. The band is 177px tall with the passage line and 138px
 * without it, so the objective was already covered before the passage line was added, and the 39px
 * that line added took the cue with it. The tools are now anchored 15px above the band's top edge.
 *
 * The check is a hit test, not a z-index comparison: each line must have a non-zero box inside the
 * viewport, and the topmost element at the centre of that box must be the line itself (or a
 * descendant). `.game-hud` is deliberately `pointer-events:none` so the world keeps its drag and its
 * clicks — only the quickbar inside it takes the pointer — so hit testing skips the band entirely.
 * Each line is therefore given back its own pointer events for the measurement and the inline style
 * is removed again immediately: that is the same mechanism `.game-quickbar` already relies on, it
 * changes no layout and no paint order, and if anything really does cover the line the hit test
 * still returns the covering element. The tools may cover the world; they may not cover the HUD.
 */
define('hud-visible-while-building', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const wanderer = fixtures().characters.wanderer;
  const world = 'frontier:0:0';

  /** The two boxes whose relationship is the defect: the tool host and the HUD's bottom band. */
  const boxes = (target) => target.evaluate(() => {
    const rect = (node) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height) };
    };
    return {
      host: rect(document.querySelector('#game-build-host')),
      band: rect(document.querySelector('.game-hud-bottom')),
      stage: rect(document.querySelector('.world-panel')),
    };
  });

  /**
   * How one line reads where it is actually drawn: its box, its text, and whether the topmost
   * element at the centre of that box is the line itself.
   */
  const readable = (target, selector) => target.evaluate((query) => {
    const describeNode = (element) => (element ? `${element.tagName}${element.id ? `#${element.id}` : ''}${element.className ? `.${String(element.className).trim().split(/\s+/).join('.')}` : ''}` : 'nothing');
    const node = document.querySelector(query);
    if (!node || node.hidden) return { rendered: false, reason: 'the line is absent or hidden' };
    const box = node.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return { rendered: true, reason: 'the line has no box', box: { width: box.width, height: box.height } };
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { rendered: true, reason: `the centre of the line is outside the ${innerWidth}x${innerHeight} viewport` };
    // `.game-hud` is pointer-transparent, so hit testing cannot see the band. Giving the line its own
    // pointer events for this one measurement makes the test ask the occlusion question directly.
    const inline = node.style.pointerEvents;
    let hit = null;
    node.style.pointerEvents = 'auto';
    try { hit = document.elementFromPoint(x, y); } finally { node.style.pointerEvents = inline; }
    return {
      rendered: true, text: (node.textContent || '').trim(),
      box: { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height) },
      hit: describeNode(hit), unobscured: Boolean(hit && (hit === node || node.contains(hit))),
    };
  }, selector);

  /** Whether two boxes share any area at all. */
  const intersect = (a, b) => Boolean(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);

  await step('a frontier resident opens build mode with its next action and its passage on screen', async () => {
    write('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', world, 24, 24, wanderer.id);
    await openGame(page, ACTORS.admin);
    await enterWorldAs(page, wanderer.id, wanderer.name);
    await page.waitForFunction(() => {
      const objective = document.querySelector('#game-next-action');
      const passage = document.querySelector('#game-next-passage');
      return Boolean(objective && !objective.hidden && (objective.textContent || '').trim() && passage && !passage.hidden && (passage.textContent || '').trim());
    }, null, { timeout: PAGE_TIMEOUT_MS });
    await page.locator('#game-build-button').click();
    await page.waitForFunction(() => document.body.classList.contains('game-building'), null, { timeout: PAGE_TIMEOUT_MS });
    await page.locator('#game-build-host').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    const measured = await boxes(page);
    expect(measured.host && measured.host.height > 0, 'the frontier build tools must be open on screen', { actual: describe(measured.host) });
    expect(measured.band && measured.band.height > 0, 'the HUD bottom band must be on screen with the tools open', { actual: describe(measured.band) });
    return `host ${measured.host.top}-${measured.host.bottom} px, band ${measured.band.top}-${measured.band.bottom} px (${measured.band.height} px tall)`;
  });

  await step('both next-action lines stay readable with the build tools open', async () => {
    const objective = await readable(page, '#game-next-action');
    const passage = await readable(page, '#game-next-passage');
    expect(objective.rendered && !objective.reason, 'the objective line must be drawn where it can be read', { actual: describe(objective) });
    expect(passage.rendered && !passage.reason, 'the passage line must be drawn where it can be read', { actual: describe(passage) });
    for (const [name, line] of [['objective', objective], ['passage', passage]]) {
      expect(line.unobscured, `the ${name} line must not be covered by the build tools`, { expected: `the topmost element at the centre of “${line.text}” is that line`, actual: `${line.hit} is on top at ${describe(line.box)}` });
    }
    const measured = await boxes(page);
    expect(!intersect(measured.host, measured.band), 'the build tools must not overlap the HUD bottom band at all', { expected: `a host box clear of the band at ${describe(measured.band)}`, actual: describe(measured.host) });
    state.notes.push(`build tools and HUD band at 1440x900: host ${measured.host.top}-${measured.host.bottom}, band ${measured.band.top}-${measured.band.bottom}; objective “${objective.text}” ${describe(objective.box)}, passage “${passage.text}” ${describe(passage.box)}`);
    return `host ends at ${measured.host.bottom}px, band starts at ${measured.band.top}px; “${objective.text}” and “${passage.text}” both unobscured`;
  });

  await step('the tools still work and nothing in the band became unreachable', async () => {
    // Every control inside the host that moved: on screen, and still the element that receives the
    // pointer at its own centre. The palette itself is disabled until a tile is pointed at (its
    // availability is the world payload's, not this scenario's), so reach is what is asserted here.
    const controls = await page.evaluate(() => [...document.querySelectorAll('#game-build-host button, #game-build-host input')].map((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        label: node.getAttribute('aria-label') || (node.textContent || '').trim(),
        inside: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
        own: Boolean(hit && (hit === node || node.contains(hit))),
      };
    }));
    expect(controls.length >= 8, 'the build tools must still render their palette, their target fields and their confirm control', { actual: describe(controls.map((control) => control.label)) });
    expect(controls.every((control) => control.inside), 'no build control may be pushed outside the viewport', { actual: describe(controls.filter((control) => !control.inside)) });
    expect(controls.every((control) => control.own), 'no build control may be covered by the HUD band it was moved away from', { actual: describe(controls.filter((control) => !control.own)) });
    // And the tool is live, not merely painted: its own target fields still take a real pointer
    // interaction, which the browser only allows while the field is the topmost element at its centre.
    const targetX = page.locator('#game-build-host input[aria-label="Target tile X"]');
    const targetY = page.locator('#game-build-host input[aria-label="Target tile Y"]');
    await targetX.fill('24');
    await targetY.fill('24');
    expect(await targetX.inputValue() === '24' && await targetY.inputValue() === '24', 'the build tools must still accept a real pointer interaction where they now sit', { expected: '24, 24 typed into the tool’s own target fields', actual: describe([await targetX.inputValue(), await targetY.inputValue()]) });
    // The band's own interactive controls keep their clicks: the pointer over the quickbar still lands
    // in the band, never in the build tools.
    const quickbar = await page.evaluate(() => {
      const row = document.querySelector('#game-hud .game-quickbar');
      return [...row.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { label: (button.textContent || '').trim(), reachable: Boolean(hit && row.contains(hit)), hit: hit ? `${hit.tagName}.${String(hit.className).trim()}` : 'nothing' };
      });
    });
    expect(quickbar.length === 5, 'the game HUD keeps its five world actions', { actual: describe(quickbar) });
    expect(quickbar.every((control) => control.reachable), 'no quickbar control may be hidden behind the build tools', { expected: 'the pointer over every quickbar control lands in the band', actual: describe(quickbar) });
    // The tools must stay inside the stage they are anchored to, so nothing is pushed out of reach.
    const measured = await boxes(page);
    expect(measured.host.top >= measured.stage.top && measured.host.bottom <= measured.stage.bottom, 'the build tools must stay inside the world stage', { expected: `inside ${describe(measured.stage)}`, actual: describe(measured.host) });
    const objective = await readable(page, '#game-next-action');
    const passage = await readable(page, '#game-next-passage');
    expect(objective.unobscured && passage.unobscured, 'the next action must stay readable after the tool redraws its panel', { expected: 'both lines unobscured', actual: describe({ objective, passage }) });
    return `${controls.length} build controls each inside the viewport and taking their own click; the tool answered a click; ${quickbar.length} quickbar controls still reachable; host inside ${measured.stage.top}-${measured.stage.bottom}`;
  });

  await step('the same holds at the 390px phone width the suite already covers', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.waitForTimeout(500);
      const measured = await boxes(page);
      expect(measured.host && measured.host.height > 0, 'the build tools must still be open at phone width', { actual: describe(measured.host) });
      const objective = await readable(page, '#game-next-action');
      const passage = await readable(page, '#game-next-passage');
      for (const [name, line] of [['objective', objective], ['passage', passage]]) {
        expect(line.rendered && !line.reason, `the ${name} line must be drawn at phone width`, { actual: describe(line) });
        expect(line.unobscured, `the ${name} line must not be covered by the build tools at phone width`, { expected: `the topmost element at the centre of “${line.text}” is that line`, actual: `${line.hit} is on top at ${describe(line.box)}` });
      }
      expect(!intersect(measured.host, measured.band), 'the build tools must not overlap the HUD band at phone width either', { expected: `a host box clear of the band at ${describe(measured.band)}`, actual: describe(measured.host) });
      state.notes.push(`build tools and HUD band at 390x844: host ${measured.host.top}-${measured.host.bottom}, band ${measured.band.top}-${measured.band.bottom}`);
      return `390x844: host ${measured.host.top}-${measured.host.bottom} px, band ${measured.band.top}-${measured.band.bottom} px, both lines readable`;
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(300);
    }
  });

  await sendToCommons(fixtures().admin, wanderer.id);
  return 'the frontier build tools stayed off the HUD band at desktop and phone width; the objective and passage lines were hit-testable, the palette still answered a click, and every quickbar control kept its own click';
});

define('interaction-saved-world-changes', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const pathfinder = fixtures().characters.pathfinder;
  const garden = `home:${pathfinder.id}`;

  await step('the resident goes home, places a crop patch and plants on it from the panel', async () => {
    await openApp(page, ACTORS.admin);
    await openWorldAs(page, pathfinder.id);
    await page.locator('#view').getByRole('button', { name: 'Go home', exact: true }).first().click();
    await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', pathfinder.id).world_id === garden ? garden : null, 'the resident to arrive in its own garden');
    await page.locator('#view').getByRole('button', { name: 'Start building', exact: true }).click();
    // The palette is its own control beside the coordinate form, so both halves are addressed here.
    const build = page.locator('#view form').filter({ has: page.getByRole('button', { name: 'Apply at tile', exact: true }) });
    await page.locator('#view select[name="kind"]').selectOption('farm');
    await build.locator('[aria-label="Tile X"]').fill('8');
    await build.locator('[aria-label="Tile Y"]').fill('7');
    await build.getByRole('button', { name: 'Apply at tile', exact: true }).click();
    const placed = await waitForCondition(async () => row('SELECT type FROM world_objects WHERE world_id=? AND x=8 AND y=7', garden), 'the crop patch to be saved in the garden');
    expect(placed.type === 'farm', 'the saved object must be the chosen crop patch', { expected: 'farm', actual: describe(placed.type) });
    // The resident stands two tiles from the patch, so the panel says so and offers the approach.
    const outOfReach = await readInteractionTile(page, 8, 7);
    expect(/Crop patch at 8, 7/.test(outOfReach), 'the hint must name the crop patch', { actual: outOfReach });
    expect(/you are 2 tiles away/.test(outOfReach), 'the hint must state the measured distance', { actual: outOfReach });
    await page.locator('#interaction-panel').getByRole('button', { name: 'Approach the crop patch', exact: true }).click();
    await waitForCondition(async () => { const position = row('SELECT x,y FROM agents WHERE id=?', pathfinder.id); return position.x === 7 && position.y === 7 ? position : null; }, 'the resident to walk beside the crop patch');
    const hint = await readInteractionTile(page, 8, 7);
    expect(/you are 1 tile away, so you can use it now/.test(hint), 'the approach must satisfy the requirement', { actual: hint });
    expect(/Plant a crop/.test(hint), 'the hint must name the available interaction for an empty patch', { actual: hint });
    await interactionActionForm(page).locator('select[name="garden_action"]').selectOption('plant:herbs');
    await interactionActionForm(page).getByRole('button', { name: /^Plant a crop\b/ }).click();
    const crop = await waitForCondition(async () => row('SELECT kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=8 AND y=7', pathfinder.id), 'the planting to be stored');
    expect(crop.kind === 'herbs' && crop.harvested_at === null, 'the stored crop must be the planted herbs, still growing', { actual: describe(crop) });
    state.fixtures.planted = crop;
    return `journey_crops row for ${pathfinder.id} at 8,7 (${crop.kind}), planted through the panel`;
  });

  await step('the planting survives a reload and the panel then describes the growing crop', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await openWorldAs(page, pathfinder.id);
    const crop = row('SELECT kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=8 AND y=7', pathfinder.id);
    expect(crop && crop.kind === 'herbs' && crop.planted_at === state.fixtures.planted.planted_at, 'the same planting must be stored after the reload', { expected: describe(state.fixtures.planted), actual: describe(crop) });
    const hint = await readInteractionTile(page, 8, 7);
    expect(/Tend the crop/.test(hint), 'the hint must describe the growing crop now', { actual: hint });
    await interactionActionForm(page).getByRole('button', { name: /^Tend the crop\b/ }).dblclick();
    const tended = await waitForCondition(async () => { const current = row('SELECT tended_at FROM journey_crops WHERE agent_id=? AND x=8 AND y=7', pathfinder.id); return current.tended_at !== null ? current : null; }, 'the tend to be stored');
    expect(tended.tended_at >= crop.planted_at, 'a tend must be recorded on the stored crop', { actual: describe(tended) });
    expect(count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', pathfinder.id) === 1, 'a rapid double click must leave exactly one crop row', { actual: count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', pathfinder.id) });
    expect(row('SELECT harvested_at FROM journey_crops WHERE agent_id=? AND x=8 AND y=7', pathfinder.id).harvested_at === null, 'a double click must not also harvest the crop', { actual: 'the crop was harvested' });
    return 'the crop survived the reload, the panel offered tend, and a double click added no second record';
  });

  await step('a bench in the same garden sits the resident, and the posture survives a reload', async () => {
    await page.locator('#view').getByRole('button', { name: 'Start building', exact: true }).click();
    const build = page.locator('#view form').filter({ has: page.getByRole('button', { name: 'Apply at tile', exact: true }) });
    await page.locator('#view select[name="kind"]').selectOption('bench');
    await build.locator('[aria-label="Tile X"]').fill('10');
    await build.locator('[aria-label="Tile Y"]').fill('8');
    await build.getByRole('button', { name: 'Apply at tile', exact: true }).click();
    const placed = await waitForCondition(async () => row('SELECT type FROM world_objects WHERE world_id=? AND x=10 AND y=8', garden), 'the bench to be saved in the garden');
    expect(placed.type === 'bench', 'the saved object must be the bench', { expected: 'bench', actual: describe(placed.type) });
    await walkResidentTo(page, pathfinder.id, 9, 8);
    const hint = await readInteractionTile(page, 10, 8);
    expect(/Bench at 10, 8/.test(hint) && /Sit on the bench/.test(hint), 'the hint must name the bench and the interaction', { actual: hint });
    expect(/Manhattan distance 1/.test(hint), 'the hint must state the distance requirement for a bench', { actual: hint });
    await interactionActionForm(page).getByRole('button', { name: /^Sit on the bench\b/ }).click();
    const sat = await waitForCondition(async () => row('SELECT posture FROM agents WHERE id=?', pathfinder.id).posture === 'sitting' ? 'sitting' : null, 'the posture to be stored', { timeout: 30_000 });
    expect(sat === 'sitting', 'the server must store the sitting posture', { actual: describe(sat) });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await openWorldAs(page, pathfinder.id);
    expect(row('SELECT posture FROM agents WHERE id=?', pathfinder.id).posture === 'sitting', 'the posture must survive the reload', { actual: describe(row('SELECT posture FROM agents WHERE id=?', pathfinder.id)) });
    return 'a bench interaction stored agents.posture=sitting, and the reload did not undo it';
  });
  return 'a planted crop and a bench posture were both saved by server actions and both survived a reload';
});

define('interaction-door-and-crafting', async () => {
  const owner = await actor('owner');
  const page = owner.page;
  const steward = fixtures().characters.steward;

  await step('a doorway travels the resident into the Meeting Hall and the new world survives a reload', async () => {
    await sendToCommons(fixtures().owner, steward.id);
    await openApp(page, ACTORS.owner);
    await openWorldAs(page, steward.id);
    const hint = await readInteractionTile(page, 11, 6);
    expect(/you are 1 tile away, so you can use it now/.test(hint), 'the doorway beside the arrival must be in reach', { actual: hint });
    await interactionActionForm(page).getByRole('button', { name: /^Enter Meeting Hall\b/ }).click();
    const arrived = await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', steward.id).world_id === 'hall' ? 'hall' : null, 'the doorway to travel');
    expect(arrived === 'hall', 'the stored world must be the one behind the doorway', { actual: describe(arrived) });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await openWorldAs(page, steward.id);
    expect(row('SELECT world_id FROM agents WHERE id=?', steward.id).world_id === 'hall', 'the new world must survive a reload', { actual: describe(row('SELECT world_id FROM agents WHERE id=?', steward.id)) });
    await waitForText(page, 'Meeting Hall');
    return 'the resident travelled through a doorway and the reload showed the same world';
  });

  await step('the resident returns through the hall doorway and enters the Makers’ Workshop through its door', async () => {
    const back = await readInteractionTile(page, 10, 11);
    expect(/Return to the Commons/.test(back), 'the hall exit must read as its own interaction', { actual: back });
    await interactionActionForm(page).getByRole('button', { name: /^Return to the Commons\b/ }).click();
    await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', steward.id).world_id === 'commons' ? 'commons' : null, 'the resident to return to the Commons');
    const commons = row('SELECT x,y FROM agents WHERE id=?', steward.id);
    expect(commons.x === 11 && commons.y === 6, 'the return must arrive at the Commons doorway it came through', { expected: '11,6', actual: describe(commons) });
    // The resident is placed beside the workshop doorway with a fixture write: the doorway is forty
    // tiles from the arrival, and the walk is not what this step tests. The door itself, the travel
    // and everything after it are the interface and the server.
    placeResident(steward.id, 'commons', 34, 24);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await openWorldAs(page, steward.id);
    const hint = await readInteractionTile(page, 35, 24);
    expect(/Door at 35, 24/.test(hint) && /The Makers’ Workshop/.test(hint), 'the workshop doorway must be the fixture on that tile', { actual: hint });
    expect(/1 tile away, so you can use it now/.test(hint), 'standing beside the doorway must satisfy the requirement', { actual: hint });
    await interactionActionForm(page).getByRole('button', { name: /^Enter The Makers’ Workshop\b/ }).click();
    const arrived = await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', steward.id).world_id === 'workshop' ? 'workshop' : null, 'the workshop doorway to travel');
    expect(arrived === 'workshop', 'the resident must arrive in the Makers’ Workshop', { actual: describe(arrived) });
    return 'the panel read the workshop doorway, the door travelled, and the resident stands in the crafting world';
  });

  await step('a crafting station crafts exactly once for one double click', async () => {
    placeResident(steward.id, 'workshop', 13, 10);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await openWorldAs(page, steward.id);
    expect(row('SELECT x,y FROM agents WHERE id=?', steward.id).x === 13, 'the resident must stand beside the crafting station', { actual: describe(row('SELECT x,y FROM agents WHERE id=?', steward.id)) });
    // The grown resources a real garden would have produced, granted as scenario setup. The craft
    // itself is the shipped action and every assertion below reads its real effect.
    for (const [kind, quantity] of [['herbs', 4], ['fiber', 2]]) {
      write('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=excluded.quantity', steward.id, kind, quantity);
    }
    const hint = await readInteractionTile(page, 13, 11);
    expect(/Crafting station at 13, 11/.test(hint), 'the hint must name the crafting station', { actual: hint });
    expect(/Craft a keepsake/.test(hint), 'the hint must name the available interaction', { actual: hint });
    await interactionActionForm(page).locator('select[name="recipe_id"]').selectOption('flower_crown');
    await interactionActionForm(page).getByRole('button', { name: /^Craft a keepsake\b/ }).dblclick();
    const recorded = await waitForCondition(async () => { const profile = row('SELECT crafts FROM journey_profiles WHERE agent_id=?', steward.id); return profile?.crafts >= 1 ? profile : null; }, 'the craft to be recorded');
    expect(recorded.crafts === 1, 'one double click must craft exactly once', { expected: 'crafts=1', actual: `crafts=${recorded.crafts}` });
    const shelf = Object.fromEntries(rows('SELECT kind,quantity FROM journey_inventory WHERE agent_id=?', steward.id).map((item) => [item.kind, item.quantity]));
    expect(shelf.flower_crown === 1, 'exactly one keepsake must be on the shelf', { expected: 'flower_crown=1', actual: describe(shelf) });
    expect(shelf.herbs === 2 && shelf.fiber === 1, 'one craft must debit one recipe, not two', { expected: 'herbs=2 fiber=1', actual: describe(shelf) });
    return `one craft recorded (crafts=${recorded.crafts}) and the shelf holds ${describe(shelf)}`;
  });
  return 'a doorway changed the stored world and a double click at a crafting station produced exactly one keepsake';
});

define('interaction-ambassador-desk', async () => {
  const owner = await actor('owner');
  const page = owner.page;
  const walker = fixtures().characters.walker;

  await step('the resident enters a country venue and walks to the ambassador’s stand', async () => {
    await sendToCommons(fixtures().owner, walker.id);
    await openApp(page, ACTORS.owner);
    await openTab(page, 'Open world');
    await page.locator('#view select[name="agent"]').selectOption(walker.id);
    await settle(page);
    await openTab(page, 'Regions & ambassadors');
    await waitForText(page, 'COUNTRY PROFILES', { scope: '#view' }).catch(() => {});
    await page.locator('#view').getByRole('button', { name: 'Enter with my resident', exact: true }).first().click();
    const arrived = await waitForCondition(async () => {
      const world = row('SELECT world_id FROM agents WHERE id=?', walker.id).world_id;
      return /^country:/.test(world) ? world : null;
    }, 'the resident to enter a country venue');
    expect(/^country:/.test(arrived), 'the resident must be inside a generated country venue', { actual: describe(arrived) });
    const stand = row('SELECT x,y FROM npc_ambassadors WHERE world_id=?', arrived);
    await walkResidentTo(page, walker.id, stand.x, stand.y - 1);
    state.fixtures.stand = { world: arrived, ...stand };
    return `the resident stands beside the ambassador at ${stand.x}, ${stand.y - 1} in ${arrived}`;
  });

  await step('the panel names the desk, and Enter focuses the question rather than guessing one', async () => {
    const { world, x, y } = state.fixtures.stand;
    const hint = await readInteractionTile(page, x, y);
    expect(/Country ambassador desk at/.test(hint), 'the hint must name the desk as the fixture', { actual: hint });
    expect(/Talk to /.test(hint), 'the hint must name the available interaction', { actual: hint });
    expect(/ambassador’s stand/.test(hint) && /Manhattan distance 1/.test(hint), 'the hint must state the requirement', { actual: hint });
    await page.locator('#interaction-panel').scrollIntoViewIfNeeded();
    await page.keyboard.press('Enter');
    const focused = await waitForCondition(async () => {
      const name = await page.evaluate(() => document.activeElement?.name || null);
      return name === 'question' ? name : null;
    }, 'the interaction key to move focus to the question field');
    expect(focused === 'question', 'the keyboard equivalent must reach the typed question', { actual: describe(focused) });
    expect(row('SELECT world_id FROM agents WHERE id=?', walker.id).world_id === world, 'reading a desk must never move the resident', { actual: describe(row('SELECT world_id FROM agents WHERE id=?', walker.id)) });
    return 'the desk hint named the fixture, the interaction and the requirement';
  });

  await step('the question is stored as a private conversation turn through the desk', async () => {
    const before = count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.owner.id);
    const form = interactionActionForm(page);
    await form.locator('[name="question"]').fill('Which registered sources should we read first?');
    await form.getByRole('button', { name: /^Talk to / }).click();
    // This operator already holds one turn with this ambassador from an earlier scenario, so waiting for
    // "a newest row exists" would be satisfied before the click's write lands. Wait for a genuine count
    // increase instead, exactly as the phone step of the first-play scenario does.
    const stored = await waitForCondition(async () => {
      const turns = rows('SELECT account_id,ambassador_id,question FROM ambassador_conversations WHERE account_id=? ORDER BY created_at DESC,rowid DESC', state.fixtures.owner.id);
      return turns.length > before ? turns[0] : null;
    }, 'the conversation turn to be stored');
    expect(count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.owner.id) === before + 1, 'the desk must store exactly one turn', { expected: `${before + 1} turns`, actual: count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.owner.id) });
    expect(/^amb-/.test(stored.ambassador_id), 'the stored turn must name the ambassador', { actual: describe(stored.ambassador_id) });
    expect(stored.account_id === state.fixtures.owner.id, 'the turn must belong to the signed-in operator', { actual: describe(stored.account_id) });
    expect(count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.stranger.id) === 0, 'another operator must hold no turn with this ambassador', { actual: 'a stranger turn appeared' });
    // The desk keeps its own rule for a rapid second question: sent straight from the page, without
    // the interface's own click coalescing, the world refuses it and stores nothing.
    const rapid = await inPage(page, '/interact', { body: { agent_id: walker.id, x: stored.ambassador_id ? state.fixtures.stand.x : 0, y: state.fixtures.stand.y, action: 'talk', question: 'And a second question straight away?' }, headers: { 'Idempotency-Key': 'browser-interaction-rapid-turn' } });
    expect(rapid.status === 429, 'a rapid second question must be refused by the desk’s own rule', { expected: 'HTTP 429', actual: `HTTP ${rapid.status} ${describe(rapid.body)}` });
    expect(/Wait a moment/.test(rapid.body?.next_step || ''), 'the refusal must say what to do next', { actual: describe(rapid.body?.next_step) });
    expect(count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.owner.id) === before + 1, 'the refused second question must store nothing', { expected: `${before + 1} turns`, actual: count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', state.fixtures.owner.id) });
    return `one stored turn for ${stored.ambassador_id}; a rapid second question answered ${rapid.status}`;
  });
  return 'a country ambassador desk answered through the existing conversation action and stored exactly one private turn';
});

define('interaction-state-refusals', async () => {
  const admin = await actor('admin');
  const owner = await actor('owner');
  const stranger = await actor('stranger');
  const wanderer = fixtures().characters.wanderer;
  const walker = fixtures().characters.walker;
  const neighbour = fixtures().characters.neighbour;
  const walkerGarden = `home:${walker.id}`;

  await step('a paused resident is refused with its state named, and resumed afterwards', async () => {
    await sendToCommons(fixtures().admin, wanderer.id);
    await openApp(admin.page, ACTORS.admin);
    await openWorldAs(admin.page, wanderer.id);
    await readInteractionTile(admin.page, 11, 6);
    await apiExpect(fixtures().admin, 'POST', '/agents/control', { agent_id: wanderer.id, status: 'paused' });
    const refused = await inPage(admin.page, '/interact', { body: { agent_id: wanderer.id, x: 11, y: 6, action: 'travel' }, headers: { 'Idempotency-Key': 'browser-interaction-paused' } });
    expect(refused.status === 403, 'a paused resident must be refused', { expected: 'HTTP 403', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(/is paused/.test(refused.body?.error || ''), 'the refusal must name the state', { actual: describe(refused.body?.error) });
    expect(/Resume .* in My characters/.test(refused.body?.next_step || ''), 'the refusal must say what to do next', { actual: describe(refused.body?.next_step) });
    expect(row('SELECT world_id FROM agents WHERE id=?', wanderer.id).world_id === 'commons', 'a paused resident must not travel', { actual: describe(row('SELECT world_id FROM agents WHERE id=?', wanderer.id)) });
    await apiExpect(fixtures().admin, 'POST', '/agents/control', { agent_id: wanderer.id, status: 'active' });
    expect(row('SELECT status FROM agents WHERE id=?', wanderer.id).status === 'active', 'the resident must be runnable again', { actual: 'still paused' });
    return `403 ${refused.body.error}`;
  });

  await step('a revoked resident is refused with its state named', async () => {
    await apiExpect(fixtures().admin, 'POST', '/agents/control', { agent_id: wanderer.id, status: 'revoked' });
    const refused = await inPage(admin.page, '/interact', { body: { agent_id: wanderer.id, x: 11, y: 6, action: 'travel' }, headers: { 'Idempotency-Key': 'browser-interaction-revoked' } });
    expect(refused.status === 403, 'a revoked resident must be refused', { expected: 'HTTP 403', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(/revoked/.test(refused.body?.error || ''), 'the refusal must name the state', { actual: describe(refused.body?.error) });
    expect(/must resume this resident/.test(refused.body?.next_step || ''), 'the refusal must say what the operator can do', { actual: describe(refused.body?.next_step) });
    expect(row('SELECT world_id FROM agents WHERE id=?', wanderer.id).world_id === 'commons', 'a revoked resident must not travel', { actual: describe(row('SELECT world_id FROM agents WHERE id=?', wanderer.id)) });
    await apiExpect(fixtures().admin, 'POST', '/agents/control', { agent_id: wanderer.id, status: 'active' });
    return `403 ${refused.body.error}`;
  });

  await step('a crop patch in another operator’s garden names its owner and writes nothing', async () => {
    await sendToCommons(fixtures().owner, walker.id);
    // The garden is public for this step, whichever scenario ran before it.
    await apiPatch(fixtures().owner, `/agents/${walker.id}/home`, { visibility: 'public' });
    await openApp(owner.page, ACTORS.owner);
    await openWorldAs(owner.page, walker.id);
    await owner.page.locator('#view').getByRole('button', { name: 'Go home', exact: true }).first().click();
    await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', walker.id).world_id === walkerGarden ? walkerGarden : null, 'the owner’s resident to arrive in its garden');
    await owner.page.locator('#view').getByRole('button', { name: 'Start building', exact: true }).click();
    const build = owner.page.locator('#view form').filter({ has: owner.page.getByRole('button', { name: 'Apply at tile', exact: true }) });
    await owner.page.locator('#view select[name="kind"]').selectOption('farm');
    await build.locator('[aria-label="Tile X"]').fill('8');
    await build.locator('[aria-label="Tile Y"]').fill('7');
    await build.getByRole('button', { name: 'Apply at tile', exact: true }).click();
    await waitForCondition(async () => row('SELECT type FROM world_objects WHERE world_id=? AND x=8 AND y=7', walkerGarden), 'the owner’s crop patch to be saved');

    // The other operator visits the public garden and stands on the patch. A fresh operator session is
    // used here: an earlier scenario deliberately revokes the stranger’s stored session credential.
    const strangerTicket = await apiOperatorSession(ACTORS.stranger.email, ACTORS.stranger.password);
    await travelTo(strangerTicket, neighbour.id, walkerGarden);
    await openApp(stranger.page, ACTORS.stranger);
    await openWorldAs(stranger.page, neighbour.id);
    await walkResidentTo(stranger.page, neighbour.id, 8, 8);
    const hint = await readInteractionTile(stranger.page, 8, 7);
    expect(/Crop patch at 8, 7/.test(hint), 'the visitor must be able to read the fixture', { actual: hint });
    expect(/Walker’s garden/.test(hint), 'the panel must name the garden’s owner before the click', { actual: hint });
    const before = count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', neighbour.id);
    await interactionActionForm(stranger.page).locator('select[name="garden_action"]').selectOption('plant:herbs');
    await interactionActionForm(stranger.page).getByRole('button', { name: /^Plant a crop\b/ }).click();
    const surfaced = await waitForCondition(async () => {
      const text = (await stranger.page.locator('#interaction-hint').textContent().catch(() => ''))?.trim() || '';
      return /own garden/.test(text) ? text : null;
    }, 'the wrong-owner refusal to reach the interface');
    expect(/Walker’s garden/.test(surfaced), 'the refusal must name who owns the patch', { actual: surfaced });
    expect(count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', neighbour.id) === before, 'a refused planting must write nothing', { expected: `${before} crops`, actual: count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', neighbour.id) });
    const refused = await inPage(stranger.page, '/interact', { body: { agent_id: neighbour.id, x: 8, y: 7, action: 'garden', garden_action: 'plant', kind: 'herbs' }, headers: { 'Idempotency-Key': 'browser-interaction-foreign-crop' } });
    expect(refused.status === 403, 'the wrong owner must be refused with its own status', { expected: 'HTTP 403', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    return `403 ${refused.body.error} · ${refused.body.next_step?.slice(0, 90)}…`;
  });

  await step('an observer of another world can inspect a fixture and never act as its resident', async () => {
    const entered = count("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered'");
    await openApp(stranger.page, ACTORS.stranger);
    await openTab(stranger.page, 'Explore worlds');
    const card = stranger.page.locator('#view .world-directory-card', { hasText: 'Meeting Hall' }).first();
    await card.waitFor({ state: 'visible' });
    await card.getByRole('button', { name: 'Look around', exact: true }).click();
    await settle(stranger.page);
    await waitForCondition(async () => (await stranger.page.evaluate(() => window.__nemoworld?.worldId?.() || null)) === 'hall' ? 'hall' : null, 'the visitor to look at the Meeting Hall');
    const hint = await readInteractionTile(stranger.page, 10, 11);
    expect(/Door at 10, 11|Return to the Commons/.test(hint), 'a visitor must be able to read the fixture', { actual: hint });
    expect(/inspection only/i.test(hint), 'a visitor must be told it is inspection only', { actual: hint });
    const panel = await stranger.page.locator('#interaction-panel').textContent();
    expect(/Inspection only/.test(panel), 'the panel must refuse to act for the visitor', { actual: panel?.replace(/\s+/g, ' ').slice(0, 240) });
    expect(/a visitor may examine this fixture, never act for another resident/.test(panel), 'the panel must say what a visitor may do', { actual: panel?.replace(/\s+/g, ' ').slice(0, 300) });
    const action = interactionActionForm(stranger.page).getByRole('button', { name: /^Return to the Commons\b/ });
    expect(await action.isDisabled(), 'a visitor must not be offered an action control for another resident', { actual: 'the control was enabled for a visitor' });
    expect(row('SELECT world_id FROM agents WHERE id=?', neighbour.id).world_id === walkerGarden, 'looking around must not move the visitor’s own resident', { actual: describe(row('SELECT world_id FROM agents WHERE id=?', neighbour.id)) });
    // Acting as another operator’s resident is not a refusal of scope but of ownership.
    const impersonated = await inPage(stranger.page, '/interact', { body: { agent_id: walker.id, x: 10, y: 11, action: 'travel' }, headers: { 'Idempotency-Key': 'browser-interaction-impersonate' } });
    expect(impersonated.status === 404, 'another operator’s resident must not be usable', { expected: 'HTTP 404', actual: `HTTP ${impersonated.status} ${describe(impersonated.body)}` });
    expect(row('SELECT world_id FROM agents WHERE id=?', walker.id).world_id === walkerGarden, 'the impersonation attempt must change nothing', { actual: describe(row('SELECT world_id FROM agents WHERE id=?', walker.id)) });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered'") === entered, 'inspection must write nothing at all', { expected: `${entered} entries`, actual: count("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered'") });
    return `inspection only for the visitor, and acting as ${walker.name} answered ${impersonated.status}`;
  });
  return 'paused, revoked, wrong-owner and observer refusals all kept the server authoritative and left the world unchanged';
});

// ---------------------------------------------------------------------------------------------
// Scenario — one cooperative world restoration walked through by two operators
//
// Two browser contexts, two operators, one public garden. Every contribution is an action the
// server records on its own: a resident walks into the garden (the recorded visit that participation
// requires), the grower sows real crops in its own garden, the maker crafts real keepsakes at a
// crafting station, the keeper joins a circle another operator keeps, and the groundskeepers place
// the plan's own objects on the plan's own tiles. Then the finished garden is read back from the
// database, from the world's own interaction panel, and after the server process has been restarted.
// ---------------------------------------------------------------------------------------------
const RESTORATION_TITLE = 'The Gathering Garden';

/**
 * Waits until the *browser* has finished a navigation, not merely the server: the same race the
 * country-venue fix closed. A travel writes its database row before the page has re-rendered, so a
 * tab switch issued at that moment is overwritten by the travel's own trailing render. This waits for
 * the loaded world payload and a settled view, and the panel opener below retries within bounds.
 */
async function browserShows(page, worldId, tab = null, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => ({
      loaded: window.__nemoworld?.world?.()?.world?.id || '',
      shown: window.__nemoworld?.worldId?.() || '',
      tab: document.querySelector('#navigation button[aria-current="page"]')?.getAttribute('aria-label') || '',
      busy: document.querySelector('#view')?.getAttribute('aria-busy') === 'true',
    })).catch((error) => ({ error: error.message }));
    if (last?.loaded === worldId && !last.busy && (!tab || last.tab === tab)) return last;
    await sleep(300);
  }
  throw new BrowserSuiteFailure(`the browser never finished showing ${worldId}`, { expected: `the loaded world ${worldId}${tab ? ` on “${tab}”` : ''}`, actual: describe(last) });
}

/**
 * Opens a navigation section and waits until the page itself reports that section as current. The
 * section name lives in the menu toggle, which is independent of focus styling and of a stale view,
 * so a navigation issued while an earlier handler is still rendering is retried within bounds
 * instead of being swallowed by a rebuilt navigation node.
 */
async function openSectionNamed(page, label, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await nav(page, label).click();
    await page.waitForTimeout(250);
    const shown = await page.evaluate(() => ({
      section: (document.querySelector('#toggle-navigation')?.textContent || '').replace(/^Menu · /, ''),
      notice: (document.querySelector('#notice')?.textContent || '').trim(),
    }));
    if (shown.section === label) { await settle(page); return shown; }
    await page.waitForTimeout(500);
  }
  throw new BrowserSuiteFailure(`the “${label}” section never became current`, { expected: label, actual: describe(await page.evaluate(() => ({ section: document.querySelector('#toggle-navigation')?.textContent || '', notice: document.querySelector('#notice')?.textContent || '' }))) });
}

/** Selects one resident through My characters and waits until the browser reports the switch. */
async function selectResident(page, agentId, name) {
  const already = await page.evaluate(() => window.__nemoworld?.selected?.() || '');
  if (already === agentId) return { selected: agentId };
  await openSectionNamed(page, 'My characters');
  const row = page.locator('#view .record', { hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  const enter = row.getByRole('button', { name: 'Enter as this character', exact: true });
  if (await enter.count()) await enter.click();
  const shown = await waitForCondition(async () => {
    const observed = await page.evaluate(() => ({
      selected: window.__nemoworld?.selected?.() || '',
      notice: document.querySelector('#notice')?.textContent || '',
    }));
    return observed.selected === agentId ? observed : null;
  }, `the browser to select resident ${agentId}`).catch(async (error) => {
    const notice = ((await page.locator('#notice').textContent().catch(() => '')) || '').trim();
    throw new BrowserSuiteFailure('the interface did not select that resident', { expected: agentId, actual: `${error.message}; the interface said “${notice}”` });
  });
  await settle(page);
  return shown;
}

/**
 * Selects one resident and then waits for that control's own trailing render. "Enter as this
 * character" ends by opening the world view (`app.js`: `selectAgent(id).then(() => {state.tab='world';
 * render();})`), and that render lands after the selection is already visible — so a section opened in
 * between is silently overwritten by it. Callers that need another section afterwards use this.
 */
async function selectResidentAndSettle(page, agentId, name) {
  const before = await page.evaluate(() => window.__nemoworld?.selected?.() || '');
  await selectResident(page, agentId, name);
  if (before === agentId) return { selected: agentId };
  await waitForCondition(async () => (await page.evaluate(() => document.querySelector('#toggle-navigation')?.textContent || '')) === 'Menu · Open world' ? true : null, 'the character switch to land on the world view');
  await settle(page);
  return { selected: agentId };
}

/**
 * Waits until the interface itself has reported the outcome of a control it was given, so a later
 * navigation is never clobbered by the trailing render of an action that is still finishing.
 */
async function waitForNotice(page, pattern, label) {
  return waitForCondition(async () => {
    const text = ((await page.locator('#notice').textContent().catch(() => '')) || '').trim();
    return pattern.test(text) ? text : null;
  }, label);
}

/** Opens the restoration panel and waits until it is the current section with its plan on screen. */
async function openRestoration(page) {
  const shown = await openSectionNamed(page, 'World restoration');
  await waitForText(page, RESTORATION_TITLE);
  return shown;
}
const RESTORATION_GROUND = RESTORATION_PLAN.steps.find((step) => step.id === 'ground');
const RESTORATION_TILES = RESTORATION_PLAN.steps.flatMap((step) => [...step.slots, ...step.assembles]);
const panelText = async (page) => ((await page.locator('#view').textContent().catch(() => '')) || '').replace(/\s+/g, ' ');

define('cooperative-restoration-two-operators', async () => {
  const owner = await actor('owner');
  const stranger = await actor('stranger');
  const walker = fixtures().characters.walker;
  const steward = fixtures().characters.steward;
  const garden = `home:${walker.id}`;
  const eventId = `restoration:${garden}`;
  const gardenObjects = () => count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden);
  // This garden is shared with the rest of the suite, so every "nothing was written" assertion is a
  // comparison against the count this scenario itself started from, and the artifact is counted on
  // the plan's own tiles only.
  const plannedStanding = () => RESTORATION_TILES.filter((tile) => row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, tile.x, tile.y)?.type === tile.type).length;
  // The suite shares one database, so "mints nothing" is a delta on the very accounts that took part
  // rather than a global zero: an earlier scenario may legitimately have earned a coin or a plot.
  const operators = [state.fixtures.owner.id, state.fixtures.stranger.id];
  const mintedSince = () => ({
    coins: count('SELECT COUNT(*) AS n FROM coin_rewards'),
    their_coins: count('SELECT COUNT(*) AS n FROM coin_rewards WHERE account_id IN (?,?)', operators[0], operators[1]),
    their_land: count('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id IN (?,?)', operators[0], operators[1]),
    their_blocks: count('SELECT COUNT(*) AS n FROM frontier_blocks WHERE creator_account_id IN (?,?)', operators[0], operators[1]),
  });
  const progressOf = async (stepId) => {
    const read = await inPage(owner.page, `/restoration?event_id=${encodeURIComponent(eventId)}`, { method: 'GET' });
    return read.body.event.progress.steps.find((step) => step.id === stepId);
  };

  // A fresh operator session and a fresh resident for the second operator. An earlier scenario
  // revokes every session token of this account and leaves the resident it used standing in this very
  // garden, so the walkthrough starts from a resident that has genuinely never been there — which is
  // exactly the prerequisite this scenario has to refuse.
  const strangerTicket = await apiOperatorSession(ACTORS.stranger.email, PASSWORD);
  const grower = await apiExpect(strangerTicket, 'POST', '/agents', { name: 'Beacon', kind: 'agent', color: '#aa7845', symbol: '✿', capabilities: 'Sows crops and crafts keepsakes', limitations: 'No external tools and no real-world claims' });
  // The callings the plan draws on are chosen once, before the event, exactly as a resident chooses
  // its calling in the interface: the garden's builder, its researcher keeper and a grower-maker.
  await apiExpect(fixtures().owner, 'POST', '/callings/select', { agent_id: walker.id, calling_id: 'builder' });
  await apiExpect(strangerTicket, 'POST', '/callings/select', { agent_id: grower.id, calling_id: 'cultivator' });

  await step('the garden is opened to visitors and one bounded restoration window is stored', async () => {
    const objectsBefore = gardenObjects(), mintedBefore = mintedSince();
    state.fixtures.restoration = { objectsBefore };
    await apiPatch(fixtures().owner, `/agents/${walker.id}/home`, { visibility: 'public' });
    await openApp(owner.page, ACTORS.owner);
    await openWorldAs(owner.page, walker.id);
    await owner.page.locator('#view').getByRole('button', { name: 'Go home', exact: true }).first().click();
    await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', walker.id).world_id === garden
      && count('SELECT COUNT(*) AS n FROM journey_visits WHERE agent_id=? AND world_id=?', walker.id, garden) === 1 ? true : null,
      'the garden’s own resident to walk home, recording the visit');
    await browserShows(owner.page, garden);
    await openRestoration(owner.page);
    await waitForText(owner.page, RESTORATION_TITLE);
    await openDisclosure(owner.page, 'Open a restoration');
    const form = owner.page.locator('form[data-draft-section="restoration-open"]');
    await form.locator('[name="hours"]').fill('3');
    await form.getByRole('button', { name: 'Open the restoration', exact: true }).click();
    await waitForNotice(owner.page, /The restoration is open for a bounded window/, 'the interface to report the open restoration');
    const stored = await waitForCondition(async () => row('SELECT * FROM community_events WHERE id=?', eventId) || null, 'the restoration occurrence to be stored by the server');
    expect(stored.status === 'scheduled', 'the occurrence must be scheduled', { actual: describe(stored.status) });
    expect(stored.world_id === garden && stored.creator_agent_id === walker.id, 'the occurrence must name the garden and its convenor', { actual: describe(stored) });
    expect(Date.parse(stored.ends_at) - Date.parse(stored.starts_at) === 3 * 3600000, 'the window must be the bounded one that was asked for', { actual: `${stored.starts_at} → ${stored.ends_at}` });
    expect(gardenObjects() === objectsBefore, 'opening a restoration writes no world object', { actual: `${objectsBefore} → ${gardenObjects()} objects` });
    state.fixtures.restoration = { id: eventId, garden, objectsBefore, mintedBefore };
    return `community_events row ${eventId}, window ${stored.starts_at} → ${stored.ends_at}, zero objects written`;
  });

  await step('a resident that has not walked into the garden cannot pledge', async () => {
    await openApp(stranger.page, ACTORS.stranger);
    await selectResident(stranger.page, grower.id, 'Beacon');
    await openRestoration(stranger.page);
    await stranger.page.locator('#view').getByRole('button', { name: 'Pledge to help with this restoration', exact: true }).click();
    const refusal = await waitForCondition(async () => {
      const text = ((await stranger.page.locator('#notice').textContent().catch(() => '')) || '').trim();
      return /Walk into/.test(text) ? text : null;
    }, 'the pledge to be refused until the resident has stood in the garden');
    expect(count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=? AND agent_id=?', eventId, grower.id) === 0, 'a refused pledge must write no participation row', { actual: 'a row appeared' });
    expect(/Step 1 · Lay the gathering ground/.test(await panelText(stranger.page)), 'the plan must be readable before anyone takes part', { actual: (await panelText(stranger.page)).slice(0, 200) });
    return `refused: ${refusal.slice(0, 140)}`;
  });

  await step('both operators pledge after actually walking into the garden, and no pledge advances a step', async () => {
    // The visitor takes its own resident through the garden’s door: a real travel that records the visit.
    await stranger.page.locator('#view').getByRole('button', { name: /^Take Beacon into/ }).first().click();
    await browserShows(stranger.page, garden);
    await openRestoration(stranger.page);
    await stranger.page.locator('#view').getByRole('button', { name: 'Pledge to help with this restoration', exact: true }).click();
    await waitForNotice(stranger.page, /Pledged\. This promise advances no step/, 'the visitor’s pledge to be reported');
    await waitForCondition(async () => count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=? AND agent_id=?', eventId, grower.id) === 1 ? true : null, 'the visitor’s pledge to be stored');
    // The garden’s own builder pledges, and so does its keeper.
    await openRestoration(owner.page);
    await owner.page.locator('#view').getByRole('button', { name: 'Pledge to help with this restoration', exact: true }).click();
    await waitForNotice(owner.page, /Pledged\. This promise advances no step/, 'the garden builder’s pledge to be reported');
    await waitForCondition(async () => count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=? AND agent_id=?', eventId, walker.id) === 1 ? true : null, 'the garden builder’s pledge to be stored');
    await selectResident(owner.page, steward.id, 'Steward');
    await openRestoration(owner.page);
    // The keeper travels with the panel's own control when it is not already standing in the garden.
    if (count('SELECT COUNT(*) AS n FROM agents WHERE id=? AND world_id=?', steward.id, garden) === 0) {
      await owner.page.locator('#view').getByRole('button', { name: /^Take Steward into/ }).first().click();
      await browserShows(owner.page, garden);
      await openRestoration(owner.page);
    }
    await owner.page.locator('#view').getByRole('button', { name: 'Pledge to help with this restoration', exact: true }).click();
    await waitForNotice(owner.page, /Pledged\. This promise advances no step/, 'the keeper’s pledge to be reported');
    await waitForCondition(async () => count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', eventId) === 3 ? true : null, 'all three pledges to be stored');
    const promises = rows('SELECT a.name FROM community_rsvps r JOIN agents a ON a.id=r.agent_id WHERE r.event_id=? ORDER BY a.name', eventId);
    expect(promises.length === 3, 'three residents must be pledged across two operators', { actual: describe(promises) });
    expect(rows('SELECT DISTINCT a.operator_id FROM community_rsvps r JOIN agents a ON a.id=r.agent_id WHERE r.event_id=?', eventId).length === 2, 'the pledges must come from two operators', { actual: 'one operator pledged' });
    const view = await inPage(owner.page, `/restoration?event_id=${encodeURIComponent(eventId)}`, { method: 'GET' });
    expect(view.body.event.progress.steps.every((step) => step.progress === 0), 'a pledge is not work: no step may move', { actual: describe(view.body.event.progress.steps.map((step) => [step.id, step.progress])) });
    expect(view.body.event.progress.steps_completed === 0 && view.body.event.artifact.standing === 0, 'a pledge must write no object and complete nothing', { actual: describe(view.body.event.artifact) });
    expect(gardenObjects() === state.fixtures.restoration.objectsBefore, 'three pledges must write no object at all', { actual: `${state.fixtures.restoration.objectsBefore} → ${gardenObjects()} objects` });
    expect(/is a promise, not work/i.test(view.body.policy.promise) && /never advances a single step/i.test(view.body.policy.promise), 'the payload must label a pledge as a promise that advances nothing', { actual: describe(view.body.policy.promise) });
    state.notes.push(`restoration pledges: ${promises.map((row_) => row_.name).join(', ')} — progress ${view.body.event.progress.steps_completed}/${view.body.event.progress.steps_total}`);
    return `three pledges from two operators, ${view.body.event.progress.steps_completed} of ${view.body.event.progress.steps_total} steps measured, zero objects written`;
  });

  await step('a wrong calling and a missing saved fact are both refused by the server', async () => {
    const wrongCalling = await inPage(stranger.page, '/restoration/contribute', { body: { agent_id: grower.id, event_id: eventId, step_id: 'keep' } });
    expect(wrongCalling.status === 403, 'a step answers its own callings only', { expected: 'HTTP 403', actual: `HTTP ${wrongCalling.status} ${describe(wrongCalling.body)}` });
    expect(/Keepers step/.test(wrongCalling.body?.error || ''), 'the refusal must name the role', { actual: describe(wrongCalling.body?.error) });
    const missing = await inPage(stranger.page, '/restoration/contribute', { body: { agent_id: grower.id, event_id: eventId, step_id: 'beds' } });
    expect(missing.status === 409, 'a step with no saved fact must be refused, never credited', { expected: 'HTTP 409', actual: `HTTP ${missing.status} ${describe(missing.body)}` });
    expect(/not recorded for/.test(missing.body?.error || ''), 'the refusal must say which saved fact is missing', { actual: describe(missing.body?.error) });
    const unplanned = await inPage(owner.page, '/restoration/place', { body: { agent_id: walker.id, event_id: eventId, x: 12, y: 15 } });
    expect(unplanned.status === 409, 'a tile outside the plan must be refused', { expected: 'HTTP 409', actual: `HTTP ${unplanned.status}` });
    expect(gardenObjects() === state.fixtures.restoration.objectsBefore, 'three refusals must write nothing at all', { actual: `${state.fixtures.restoration.objectsBefore} → ${gardenObjects()} objects` });
    return `403 ${wrongCalling.body.error} · 409 ${describe(missing.body.error)} · 409 ${describe(unplanned.body.error)}`;
  });

  await step('the grower sows two real crops and the shared beds are measured from them', async () => {
    await selectResident(stranger.page, grower.id, 'Beacon');
    await openSectionNamed(stranger.page, 'Open world');
    await stranger.page.locator('#view').getByRole('button', { name: 'Go home', exact: true }).first().click();
    await browserShows(stranger.page, `home:${grower.id}`);
    await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', grower.id).world_id === `home:${grower.id}` ? true : null, 'the grower to go home');
    await stranger.page.locator('#view').getByRole('button', { name: 'Start building', exact: true }).click();
    const build = stranger.page.locator('#view form').filter({ has: stranger.page.getByRole('button', { name: 'Apply at tile', exact: true }) });
    // Two crop patches on one row, two tiles apart so both stay clear of the arrival and both are
    // within one tile of the tile the resident stands on.
    for (const column of [8, 10]) {
      await stranger.page.locator('#view select[name="kind"]').selectOption('farm');
      await build.locator('[aria-label="Tile X"]').fill(String(column));
      await build.locator('[aria-label="Tile Y"]').fill('7');
      await build.getByRole('button', { name: 'Apply at tile', exact: true }).click();
      await waitForCondition(async () => row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=7', `home:${grower.id}`, column) ? true : null, `the crop patch at ${column}, 7 to be saved`);
    }
    await walkResidentTo(stranger.page, grower.id, 9, 7);
    for (const [column, kind] of [[8, 'herbs'], [10, 'fiber']]) {
      await readInteractionTile(stranger.page, column, 7);
      await interactionActionForm(stranger.page).locator('select[name="garden_action"]').selectOption(`plant:${kind}`);
      await interactionActionForm(stranger.page).getByRole('button', { name: /^Plant a crop\b/ }).click();
      await waitForCondition(async () => row('SELECT kind FROM journey_crops WHERE agent_id=? AND x=? AND y=7', grower.id, column) ? true : null, `the ${kind} sowing at ${column}, 7 to be stored`);
      // The panel finished reporting the planting before the next tile is read: the same client-side
      // signal the shipped interaction scenario uses, so a rebuild cannot swallow the next fill.
      await waitForCondition(async () => {
        const hint = ((await stranger.page.locator('#interaction-hint').textContent().catch(() => '')) || '').trim();
        return /Tend the crop/.test(hint) ? hint : null;
      }, `the panel to report the ${kind} sowing at ${column}, 7`);
    }
    const sown = count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=? AND harvested_at IS NULL', grower.id);
    expect(sown === 2, 'two real sowings must be stored', { actual: `${sown} planted crops` });
    await openRestoration(stranger.page);
    await stranger.page.locator('#view').getByRole('button', { name: 'Record my saved sowing for this step', exact: true }).click();
    await waitForNotice(stranger.page, /Recorded from the saved work/, 'the sowing to be reported');
    const beds = await waitForCondition(async () => { const step_ = await progressOf('beds'); return step_.progress === 2 ? step_ : null; }, 'the shared beds to be measured from the two sowings');
    expect(beds.complete === true, 'two sowings must answer the beds step', { actual: describe(beds) });
    expect(/2 of 2/.test(await panelText(stranger.page)), 'the panel must show the measured progress', { actual: (await panelText(stranger.page)).slice(0, 200) });
    return `beds ${beds.progress} of ${beds.target} measured from journey_crops rows at 8,7 and 10,7`;
  });

  await step('the maker crafts two keepsakes and the garden’s light is measured from them', async () => {
    // The grown resources a real garden would have produced, granted as scenario setup: the harvest
    // itself takes twenty minutes of server time and is not what this step tests. The craft is real.
    for (const [kind, quantity] of [['herbs', 6], ['fiber', 4], ['wood', 4]]) {
      write('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=excluded.quantity', grower.id, kind, quantity);
    }
    placeResident(grower.id, 'workshop', 13, 10);
    await stranger.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(stranger.page);
    await selectResident(stranger.page, grower.id, 'Beacon');
    const hint = await readInteractionTile(stranger.page, 13, 11);
    expect(/Crafting station at 13, 11/.test(hint), 'the maker must stand beside a crafting station', { actual: hint });
    for (const recipe of ['flower_crown', 'garden_lantern']) {
      const before = count('SELECT crafts FROM journey_profiles WHERE agent_id=?', grower.id);
      await restorationCraft(stranger.page, grower.id, recipe, before);
      await stranger.page.waitForTimeout(800);
    }
    const crafts = count('SELECT crafts FROM journey_profiles WHERE agent_id=?', grower.id);
    expect(crafts === 2, 'two separate crafts must be recorded', { actual: `crafts=${crafts}` });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='journey.crafted' AND record_id=?", grower.id) === 2, 'the world must hold two craft records', { actual: 'the craft count differs' });
    await openRestoration(stranger.page);
    await stranger.page.locator('#view').getByRole('button', { name: 'Record my saved craft for this step', exact: true }).click();
    await waitForNotice(stranger.page, /Recorded from the saved work/, 'the craft to be reported');
    const light = await waitForCondition(async () => { const step_ = await progressOf('light'); return step_.progress === 2 ? step_ : null; }, 'the garden’s light to be measured from the two crafts');
    expect(light.complete === true, 'two crafts must answer the makers’ step', { actual: describe(light) });
    return `light ${light.progress} of ${light.target} measured from two journey.crafted records`;
  });

  await step('the keeper joins a circle another operator keeps, and the garden is left in that keeping', async () => {
    await selectResident(stranger.page, grower.id, 'Beacon');
    await openSectionNamed(stranger.page, 'Community');
    await openDisclosure(stranger.page, 'Start a circle');
    const create = stranger.page.locator('#view form').filter({ has: stranger.page.getByRole('button', { name: 'Create circle', exact: true }) });
    await create.locator('[name="name"]').fill('Garden keepers');
    await create.locator('[name="focus"]').selectOption('Care');
    await create.locator('[name="summary"]').fill('Keep the restored garden open after the event.');
    await create.getByRole('button', { name: 'Create circle', exact: true }).click();
    const circle = await waitForCondition(async () => row("SELECT id,name,creator_agent_id FROM community_circles WHERE name='Garden keepers'") || null, 'the neighbouring circle to be stored');
    expect(circle.creator_agent_id === grower.id, 'the circle must belong to the other operator', { actual: describe(circle.creator_agent_id) });
    await selectResident(owner.page, steward.id, 'Steward');
    await openSectionNamed(owner.page, 'Community');
    const card = owner.page.locator('#view .card', { hasText: 'Garden keepers' }).first();
    await card.getByRole('button', { name: 'Join circle', exact: true }).click();
    await waitForCondition(async () => count('SELECT COUNT(*) AS n FROM community_members WHERE circle_id=? AND agent_id=?', circle.id, steward.id) === 1 ? true : null, 'the keeper to join the neighbouring circle');
    await openRestoration(owner.page);
    await owner.page.locator('#view').getByRole('button', { name: 'Record my saved circle membership for this step', exact: true }).click();
    await waitForNotice(owner.page, /Recorded from the saved work/, 'the keeping to be reported');
    const keep = await waitForCondition(async () => { const step_ = await progressOf('keep'); return step_.progress === 1 ? step_ : null; }, 'the keeping to be measured from the membership');
    expect(keep.complete === true, 'a circle another operator keeps must answer the keepers’ step', { actual: describe(keep) });
    return `keep ${keep.progress} of ${keep.target} measured from a community_members row for ${circle.name}`;
  });

  await step('the groundskeepers lay the measured tiles, and one planned tile is filled exactly once', async () => {
    await selectResident(owner.page, walker.id, 'Walker');
    await browserShows(owner.page, garden);
    await openRestoration(owner.page);
    const first = RESTORATION_GROUND.slots[0];
    await owner.page.locator('#view').getByRole('button', { name: `Place the ${first.type} at ${first.x}, ${first.y}`, exact: true }).click();
    const away = await waitForCondition(async () => {
      const text = ((await owner.page.locator('#notice').textContent().catch(() => '')) || '').trim();
      return /tiles? from/.test(text) ? text : null;
    }, 'the placement to be refused while the resident is away from the tile');
    expect(gardenObjects() === state.fixtures.restoration.objectsBefore, 'a refused placement must write nothing', { actual: `${state.fixtures.restoration.objectsBefore} → ${gardenObjects()} objects` });
    state.notes.push(`restoration placement refusal: ${away.slice(0, 120)}`);
    for (const slot of RESTORATION_GROUND.slots) {
      await walkResidentTo(owner.page, walker.id, slot.x, slot.y - 1);
      await owner.page.locator('#view').getByRole('button', { name: `Place the ${slot.type} at ${slot.x}, ${slot.y}`, exact: true }).click();
      await waitForNotice(owner.page, new RegExp(`standing at ${slot.x}, ${slot.y}`), `the ${slot.type} placement to be reported`);
      const saved = await waitForCondition(async () => row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, slot.x, slot.y) || null, `the ${slot.type} at ${slot.x}, ${slot.y} to be saved`);
      expect(saved.type === slot.type, 'the saved object must be the object the plan named', { expected: slot.type, actual: describe(saved.type) });
    }
    const repeat = await inPage(owner.page, '/restoration/place', { body: { agent_id: walker.id, event_id: eventId, x: first.x, y: first.y } });
    expect(repeat.status === 409, 'a filled planned tile must be refused instead of filled twice', { expected: 'HTTP 409', actual: `HTTP ${repeat.status} ${describe(repeat.body)}` });
    for (const slot of RESTORATION_GROUND.slots) {
      expect(row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, slot.x, slot.y)?.type === slot.type, `${slot.type} at ${slot.x}, ${slot.y} must stand once`, { actual: describe(row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, slot.x, slot.y)) });
    }
    expect(count('SELECT COUNT(*) AS n FROM audit WHERE event=? AND substr(record_id,1,?)>0', 'restoration.placed', 0) === 3, 'exactly three placements must be recorded', { actual: 'the placement count differs' });
    return `three placements filled once each after one distance refusal; ${plannedStanding()} of the plan’s ${RESTORATION_TILES.length} objects stand`;
  });

  await step('finishing the plan writes the garden once, and the world agrees from three directions', async () => {
    const view = await waitForCondition(async () => {
      const read = await inPage(owner.page, `/restoration?event_id=${encodeURIComponent(eventId)}`, { method: 'GET' });
      return read.body.event.phase === 'completed' ? read.body.event : null;
    }, 'the restoration to be recorded completed');
    expect(view.progress.steps_completed === view.progress.steps_total, 'every step must be measured', { actual: describe(view.progress.steps.map((step) => [step.id, step.progress, step.target])) });
    expect(view.artifact.standing === RESTORATION_TILES.length && view.artifact.missing === 0, 'every planned object must stand', { actual: describe(view.artifact) });
    for (const tile of RESTORATION_TILES) {
      const saved = row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, tile.x, tile.y);
      expect(saved?.type === tile.type, `${tile.type} at ${tile.x}, ${tile.y} must be saved in the garden`, { actual: describe(saved) });
    }
    expect(plannedStanding() === RESTORATION_TILES.length, 'every planned tile holds the object the plan named', { actual: `${plannedStanding()} of ${RESTORATION_TILES.length} planned objects` });
    // The world's own interaction panel reads the placed bench back as a real fixture of this garden.
    await openSectionNamed(owner.page, 'Open world');
    const hint = await readInteractionTile(owner.page, RESTORATION_GROUND.slots[0].x, RESTORATION_GROUND.slots[0].y);
    expect(/Bench at 9, 15/.test(hint), 'the world’s own panel must read the placed bench back', { actual: hint });
    // Nothing a whole restoration grants: no coin, no land, no role, and no power over anyone.
    const accounts = rows('SELECT id,role FROM accounts WHERE id IN (?,?)', operators[0], operators[1]);
    expect(accounts.every((account_) => account_.role === 'member'), 'a restoration must grant no account role', { actual: describe(accounts.map((account_) => account_.role)) });
    const mintedAfter = mintedSince();
    expect(mintedAfter.coins === state.fixtures.restoration.mintedBefore.coins, 'a restoration must mint no coin at all', { actual: describe({ before: state.fixtures.restoration.mintedBefore, after: mintedAfter }) });
    expect(mintedAfter.their_coins === state.fixtures.restoration.mintedBefore.their_coins, 'neither participating operator may gain a coin receipt', { actual: describe(mintedAfter) });
    expect(mintedAfter.their_land === state.fixtures.restoration.mintedBefore.their_land, 'a restoration must grant no stewardship', { actual: describe(mintedAfter) });
    expect(mintedAfter.their_blocks === state.fixtures.restoration.mintedBefore.their_blocks, 'a restoration must write no frontier block for its participants', { actual: describe(mintedAfter) });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.completed'") === 1, 'the finished garden is written exactly once', { actual: 'the completion count differs' });
    return `${view.progress.steps_completed} of ${view.progress.steps_total} steps measured, ${view.artifact.standing} objects standing, no coin, no land, no role, no frontier block`;
  });

  await step('the restored garden survives a restart of the world server', async () => {
    await stopServer();
    await startServer();
    await owner.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(owner.page);
    // The schema number is never hard-coded here: it is compared against the version the running
    // server reports for the very database file this scenario validates, so a schema bump cannot
    // leave a stale literal behind. Validation itself (integrity, tables, ledger, evidence) still
    // has to succeed for the read to return at all.
    const validation = validateDatabase(state.database);
    const reported = await apiGet('/operations', { token: fixtures().admin.token });
    // The administrator dashboard reports the running server's own `PRAGMA user_version` under
    // `diagnostics.schema`, read from the same file this scenario just validated.
    const serverSchema = reported.status === 200 ? reported.body?.diagnostics?.schema?.version ?? null : null;
    expect(serverSchema === validation.schema_version, 'the database that validates after the restart must be the schema the running server reports', { expected: `GET /operations schema version ${serverSchema ?? `(HTTP ${reported.status})`}`, actual: describe(validation) });
    const read = await inPage(owner.page, `/restoration?event_id=${encodeURIComponent(eventId)}`, { method: 'GET' });
    expect(read.body.event.phase === 'completed', 'the recorded outcome must survive the restart', { actual: describe(read.body.event.phase) });
    expect(read.body.event.artifact.standing === RESTORATION_TILES.length, 'every restored object must survive the restart', { actual: describe(read.body.event.artifact) });
    for (const tile of RESTORATION_TILES) {
      const saved = row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, tile.x, tile.y);
      expect(saved?.type === tile.type, `${tile.type} at ${tile.x}, ${tile.y} must still stand after the restart`, { actual: describe(saved) });
    }
    await openRestoration(owner.page);
    await waitForText(owner.page, 'The restored garden');
    return `schema ${validation.schema_version}, ${read.body.event.artifact.standing} objects standing, the event still reads ${read.body.event.phase}`;
  });

  return `two operators restored ${garden} together: ${plannedStanding()} saved objects on the plan’s own tiles, ${count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', eventId)} pledges, no coin, no land and no role`;
});

/** One craft at the crafting station the resident already stands beside, waiting for its record. */
async function restorationCraft(page, agentId, recipe, before) {
  await interactionActionForm(page).locator('select[name="recipe_id"]').selectOption(recipe);
  await interactionActionForm(page).getByRole('button', { name: /^Craft a keepsake\b/ }).click();
  await waitForCondition(async () => count('SELECT crafts FROM journey_profiles WHERE agent_id=?', agentId) > before ? true : null, `the ${recipe} to be recorded`);
}

// ---------------------------------------------------------------------------------------------
// Scenario 23 — the reviewer workbench
//
// Four people on four accounts: the administrator proposes the mission and later adopts, this
// operator contributes, the reviewer is a third person, and the adopter role is the mission owner.
// The reviewer drives the workbench through the interface: criterion by criterion, a comparison of
// the cited source version against the version the library holds now, a changes-requested round
// trip the contributor reads back, and finally an acceptance and a recorded adoption.
// ---------------------------------------------------------------------------------------------

const WORKBENCH_SOURCE = 'https://example.org/workbench-report';
const randomHash = () => createHash('sha256').update(String(Math.random() * 1e9)).digest('hex');
const WORKBENCH_RETAINED = JSON.parse(readFileSync(join(ROOT, 'catalog/agriculture-statistics.json'), 'utf8'))
  .countries.flatMap((country) => country.series || []).filter((entry) => entry.raw_file && entry.sha256);
const WORKBENCH_RETAINED_SOURCE = WORKBENCH_RETAINED[0].url;
const WORKBENCH_NEXT_VERSION = WORKBENCH_RETAINED.find((entry) => entry.sha256 !== WORKBENCH_RETAINED[0].sha256);

/** A bounded structured decision brief for the reviewer-workbench fixtures. */
function workbenchBrief(tag) {
  return {
    title: `Browser reviewer fixture ${tag}`,
    recipient: 'Proposed fixture focal point; unconfirmed',
    requested_decision: 'Review the cited fixture evidence before any selection.',
    beneficiaries: 'Fictional browser acceptance community; no operating project.',
    problem: 'A bounded browser fixture for the reviewer workbench; it describes no real programme.',
    findings: [{ text: 'This is a browser acceptance fixture, not a real trade or programme finding.', source_numbers: [1], qualification: 'No buyer, shipment or institutional conclusion is claimed.' }],
    options: [
      { title: 'Gather evidence first', action: 'Prepare a dated evidence register.', owner: 'Proposed technical focal point; unconfirmed', cost_basis: 'Research budget unknown.', dependencies: 'Producer and reviewer selection.', risks: 'Incomplete local applicability.' },
      { title: 'Defer the selection', action: 'Record the gaps and defer.', owner: 'Proposed municipality role; unconfirmed', cost_basis: 'No project commitment assumed.', dependencies: 'A documented decision by the responsible institution.', risks: 'Evidence gaps remain open.' },
    ],
    recommended_option: 1,
    recommendation_reason: 'Fixture rationale: the evidence is insufficient for a selection.',
    milestones: [{ deliverable: 'Dated gap register', owner: 'Proposed research contributor', timing: 'Proposed first month after approval', measure: 'An independent reviewer checks the source locations.' }],
    evidence_gaps: 'Buyer demand, shipment eligibility and costs remain unknown in this fixture.',
    cost_scenario: { currency: 'NPR', precision: 2, quantity_kg: 1, rows: [{ item: 'Illustrative preparation', basis: 'estimate', amount: '0.10', assumption: 'Artificial fixture amount; not a real quote.' }, { item: 'Freight', basis: 'unknown', amount: null, assumption: 'No carrier quote or route selected.' }] },
  };
}

const workbenchSource = (sha, url = WORKBENCH_SOURCE) => ({ url, location: `Section 2, paragraph 3; SHA256 ${sha}`, date: '2026-10-11' });

/** The contributor account and one fictional resident, created over the documented API. */
async function contributorFixtures(name) {
  const ticket = await ensureAccount(fixtures().admin, ACTORS.contributor);
  const resident = await apiExpect(ticket, 'POST', '/agents', { kind: 'agent', name, color: '#5d7bb1', symbol: '✎', capabilities: 'Reads approved sources and prepares cited briefs', limitations: 'No external tools and no real-world claims' });
  return { ticket, resident };
}

/** Submits one structured decision brief with its source pinned to an exact version. */
async function submitBrief(ticket, claim, tag, sha, key, sourceUrl = WORKBENCH_SOURCE) {
  const submission = await apiExpect(ticket, 'POST', '/submissions', {
    claim_id: claim.id, brief: workbenchBrief(tag), sources: [workbenchSource(sha, sourceUrl)],
    method: 'Read the cited section and recorded its exact location.',
    limitations: 'A browser fixture; facts and rights still require human verification.',
    rights: 'Public material recorded with attribution.',
    mime: 'application/json',
  }, [201], { headers: { 'Idempotency-Key': key } });
  return submission;
}

/** Opens the reviewer workbench panel for one mission card and loads it through the interface. */
async function openWorkbench(page, missionTitle, submissionId = null) {
  const card = page.locator('#view .card', { hasText: missionTitle }).first();
  await card.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  await openDisclosure(page, 'Reviewer workbench');
  const open = card.getByRole('button', { name: 'Open the reviewer workbench', exact: true });
  const offered = await open.count() > 0;
  if (offered) await open.click();
  try {
    await waitForCondition(async () => await card.locator('.workbench').count() > 0 ? true : null, 'the reviewer workbench to render');
  } catch (error) {
    // A refused or failing load leaves a notice in the interface; report it with the failure.
    const notice = await page.locator('#notice').textContent().catch(() => '');
    const probe = await page.evaluate((title) => { const card = [...document.querySelectorAll('#view .card')].find((node) => (node.textContent || '').includes(title)); if (!card) return 'no matching card'; return [...card.querySelectorAll('*')].filter((node) => node.classList.contains('workbench')).length; }, missionTitle).catch((err) => `probe failed: ${err.message}`);
    let fetchTiming = 'not measured';
    if (submissionId) { const started = Date.now(); await inPage(page, `/review/workbench?submission=${encodeURIComponent(submissionId)}`, { method: 'GET' }).catch(() => null); fetchTiming = `${Date.now() - started}ms`; }
    throw new BrowserSuiteFailure('the reviewer workbench did not render', { expected: 'the workbench panel in the review card', actual: `load button offered: ${offered}; notice: “${(notice || '').trim()}”; workbench panels in the card: ${JSON.stringify(probe)}; an in-page fetch of the same view took ${fetchTiming}`, detail: error.message });
  }
  return card;
}

/** Records one criterion-by-criterion review through the shipped form. */
async function recordWorkbenchReview(card, { decision, reason, result, notes, change }) {
  const form = card.locator('form').filter({ hasText: 'Record review' }).first();
  await form.locator('select[name="decision"]').selectOption(decision);
  await form.locator('[name="reason"]').fill(reason);
  if (change) await form.locator('[name="change_0"]').fill(change);
  await form.locator('[name="assessment_0_result"]').selectOption(result);
  await form.locator('[name="assessment_0_sources"]').fill('1');
  await form.locator('[name="assessment_0_notes"]').fill(notes);
  await form.locator('[name="assessment_scope"]').fill('Fictional browser fixture only; the proposed recipient remains unconfirmed.');
  await form.locator('[name="assessment_rights"]').fill('Attribution recorded; no reuse permission has been established.');
  await form.locator('[name="assessment_costs"]').fill('Freight remains unknown and no budget is approved by this review.');
  await form.getByRole('button', { name: 'Record review', exact: true }).click();
}

const reviewRow = (submissionId) => row('SELECT * FROM reviews WHERE submission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', submissionId);

define('reviewer-workbench', async () => {
  const reviewer = await actor('reviewer');
  const admin = await actor('admin');
  const contributor = await actor('contributor');
  const { ticket, resident } = await contributorFixtures('Notetaker');
  const WORKBENCH_TITLE = 'Browser reviewer workbench fixture';
  const { mission, task } = await makeMission(WORKBENCH_TITLE, 'workbench', ['api.worldbank.org']);
  const firstSha = WORKBENCH_RETAINED[0].sha256;
  let first = null, second = null, citedCapture = null, newerCapture = null, claim = null;
  const requested = 'Name the exact paragraph instead of the whole section.';

  await step('a contributor submits a cited decision brief that pins one retained-byte source version', async () => {
    claim = await apiExpect(ticket, 'POST', '/claims', { task_id: task.id, agent_id: resident.id }, [201], { headers: { 'Idempotency-Key': 'browser-workbench-claim' } });
    first = await submitBrief(ticket, claim, 'one', firstSha, 'browser-workbench-submit-1', WORKBENCH_RETAINED_SOURCE);
    expect(first.status === 'pending_review', 'the fixture brief must be pending review', { actual: describe(first.status) });
    const cited = row('SELECT * FROM submission_evidence WHERE submission_id=? AND source_number=1', first.id);
    expect(cited && cited.capture_id, 'the citation must pin an exact stored version', { actual: describe(cited) });
    citedCapture = row('SELECT * FROM evidence_captures WHERE id=?', cited.capture_id);
    expect(citedCapture.sha256 === firstSha && citedCapture.origin === 'catalog' && citedCapture.retained === 1, 'the pinned version must be hash-checked retained bytes, not a contributor declaration', { expected: firstSha, actual: describe(citedCapture) });
    return `submission ${first.id} pins ${firstSha.slice(0, 12)}… as one exact version`;
  });

  await step('a newer version of that source is captured, and the reviewer compares it in the workbench', async () => {
    // An alternate retained fixture file exercises version comparison; it is not a real update to
    // the provider series, and this scenario creates no production evidence or recommendation.
    newerCapture = await apiExpect(fixtures().admin, 'POST', '/evidence/capture', { url: WORKBENCH_RETAINED_SOURCE, sha256: WORKBENCH_NEXT_VERSION.sha256, retained: true, retained_path: WORKBENCH_NEXT_VERSION.raw_file, retrieved_at: '2026-10-12', locator: 'Alternate retained browser fixture', evidence_kind: 'normalized-statistics', supersedes: citedCapture.id }, [201]);
    expect(newerCapture.retained === 1, 'the newer version must also have retained bytes', { actual: describe(newerCapture) });
    await openApp(reviewer.page, ACTORS.reviewer);
    const view = await inPage(reviewer.page, `/review/workbench?submission=${encodeURIComponent(first.id)}`, { method: 'GET' });
    expect(view.status === 200 && view.body.submission.state.value === 'pending', 'the workbench must open for the pending version', { expected: 'HTTP 200 with a pending state', actual: `HTTP ${view.status} ${describe(view.body?.submission?.state)}` });
    expect(view.body.citations[0].state === 'replaced', 'the citation must read as replaced while the cited version stays pinned', { expected: 'replaced', actual: describe(view.body.citations[0].state) });
    expect(view.body.citations[0].cited_version.sha256 === firstSha && view.body.citations[0].current_version.sha256 === newerCapture.sha256, 'the comparison must name both versions', { actual: describe(view.body.citations[0].comparison) });
    expect(view.body.roles.proposer.name === ACTORS.admin.name && view.body.roles.contributor.name === ACTORS.contributor.name && view.body.roles.reviewer.name === ACTORS.reviewer.name, 'the four roles must be named and kept apart', { actual: describe(view.body.roles) });
    expect(view.body.roles.may_adopt === false && /Only the mission owner/.test(view.body.roles.adoption_refusal), 'the reviewer must be told they cannot adopt', { actual: describe(view.body.roles.adoption_refusal) });
    // The reviewer drives the same comparison through the interface.
    await openTab(reviewer.page, 'Review');
    const card = await openWorkbench(reviewer.page, WORKBENCH_TITLE, first.id);
    const text = await card.textContent();
    expect(/replaced version/.test(text), 'the interface must label the replaced citation', { actual: text?.replace(/\s+/g, ' ').slice(0, 300) });
    expect(text.includes(firstSha) && text.includes(newerCapture.sha256), 'the interface must show both versions side by side', { actual: 'a version hash was missing from the workbench' });
    expect(/Version cited by this contribution/.test(text) && /Version the library holds now/.test(text), 'the comparison table must name both columns', { actual: text?.replace(/\s+/g, ' ').slice(0, 300) });
    expect(/Yes\. Record a criterion-by-criterion decision below\./.test(text), 'the workbench must say the reviewer may decide', { actual: text?.replace(/\s+/g, ' ').slice(0, 300) });
    expect(row('SELECT sha256 FROM evidence_captures WHERE id=?', citedCapture.id).sha256 === firstSha, 'a later capture must never rewrite the cited version', { actual: describe(row('SELECT * FROM evidence_captures WHERE id=?', citedCapture.id)) });
    return `cited ${firstSha.slice(0, 12)}… vs current ${newerCapture.sha256.slice(0, 12)}…, labelled replaced in the interface`;
  });

  await step('the reviewer requests specific changes criterion by criterion', async () => {
    const card = await openWorkbench(reviewer.page, WORKBENCH_TITLE, first.id);
    await recordWorkbenchReview(card, { decision: 'changes_requested', reason: 'The section is cited but the paragraph is not identified.', result: 'uncertain', notes: 'The cited passage is real but its exact paragraph is not stated.', change: requested });
    const stored = await waitForCondition(async () => reviewRow(first.id) || null, 'the changes-requested review to be stored');
    expect(stored.decision === 'changes_requested' && stored.reviewer_id === state.fixtures.reviewer.id, 'the review must name the independent reviewer and the decision', { actual: describe(stored) });
    expect(/HUMAN EVIDENCE ASSESSMENT — THIS SUBMISSION VERSION/.test(stored.reason) && /Finding 1: Support or applicability uncertain/.test(stored.reason), 'the assessment must be criterion by criterion', { actual: stored.reason.slice(0, 300) });
    expect(/REQUESTED CHANGES — THIS SUBMISSION VERSION/.test(stored.reason) && stored.reason.includes(requested), 'the requested changes must be stored with this version', { actual: stored.reason.slice(0, 400) });
    expect(row('SELECT status FROM submissions WHERE id=?', first.id).status === 'changes_requested', 'the version must go back as changes requested', { actual: describe(row('SELECT status FROM submissions WHERE id=?', first.id)) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', resident.id) === 0, 'a requested correction must issue no coin', { actual: 'a receipt appeared' });
    return `review by ${stored.reviewer_id} · submission ${first.id} is changes_requested with one named instruction`;
  });

  await step('the contributor reads exactly what was requested', async () => {
    await openApp(contributor.page, ACTORS.contributor);
    await openTab(contributor.page, 'My contributions');
    const record = contributor.page.locator('#view .record', { hasText: 'Browser reviewer fixture one' }).first();
    await record.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const text = await record.textContent();
    expect(text.includes(requested), 'the contributor must read the exact requested change', { actual: text?.replace(/\s+/g, ' ').slice(0, 400) });
    expect(/Changes requested for this version/.test(text), 'the requested changes must be labelled as such', { actual: text?.replace(/\s+/g, ' ').slice(0, 300) });
    expect(/Changes requested:/.test(text), 'the changes-requested state must be written out, not coded', { actual: text?.replace(/\s+/g, ' ').slice(0, 300) });
    const history = await inPage(contributor.page, '/history', { method: 'GET' });
    const stored = history.body.submissions.find((entry) => entry.id === first.id);
    expect(Array.isArray(stored.requested_changes) && stored.requested_changes[0] === requested, 'the API must return the same list', { actual: describe(stored.requested_changes) });
    expect(stored.state.value === 'changes_requested', 'the contributor’s own view must carry the one state value', { actual: describe(stored.state) });
    return `the contributor reads “${stored.requested_changes[0]}” for version ${stored.version}`;
  });

  await step('the corrected version is accepted criterion by criterion and issues exactly one receipt', async () => {
    second = await submitBrief(ticket, claim, 'two', newerCapture.sha256, 'browser-workbench-submit-2', WORKBENCH_RETAINED_SOURCE);
    expect(second.version === 2 && second.status === 'pending_review', 'the corrected version must be a new pending version', { actual: describe({ version: second.version, status: second.status }) });
    await reviewer.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(reviewer.page);
    await openTab(reviewer.page, 'Review');
    const card = await openWorkbench(reviewer.page, WORKBENCH_TITLE, first.id);
    await recordWorkbenchReview(card, { decision: 'accepted', reason: 'The paragraph citation is now exact and the unknown freight stays explicit.', result: 'supported', notes: 'Opened the cited paragraph and read the qualification with it.' });
    const stored = await waitForCondition(async () => { const entry = reviewRow(second.id); return entry && entry.decision === 'accepted' ? entry : null; }, 'the acceptance to be stored');
    expect(row('SELECT status FROM submissions WHERE id=?', second.id).status === 'accepted', 'the corrected version must be accepted', { actual: describe(row('SELECT status FROM submissions WHERE id=?', second.id)) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', resident.id) === 1, 'exactly one receipt must be issued', { expected: 'one coin_rewards row', actual: `${count('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', resident.id)} rows` });
    expect(scalar('SELECT amount FROM coin_rewards WHERE agent_id=?', resident.id) === 10, 'the receipt must be the fixed ten-coin award', { actual: describe(scalar('SELECT amount FROM coin_rewards WHERE agent_id=?', resident.id)) });
    expect(stored.reviewer_id === state.fixtures.reviewer.id, 'the acceptance must be independent', { actual: describe(stored.reviewer_id) });
    const wallet = await inPage(reviewer.page, `/coins?agent_id=${encodeURIComponent(resident.id)}`, { method: 'GET' });
    expect(wallet.status === 403 || wallet.status === 404, 'a reviewer must not read another operator’s wallet', { expected: 'HTTP 403 or 404', actual: `HTTP ${wallet.status}` });
    return `${stored.decision} by ${stored.reviewer_id}; one 10-coin receipt for ${resident.id}`;
  });

  await step('the mission owner records a documented adoption with its supporting evidence', async () => {
    const refused = await inPage(reviewer.page, '/adoptions', { body: { submission_id: second.id, note: 'Adopting the version I reviewed.' } });
    expect(refused.status === 403 && /Only the mission owner/.test(refused.body?.error || ''), 'the reviewer must not adopt the version they accepted', { expected: 'HTTP 403 from the mission-owner rule', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    await openApp(admin.page, ACTORS.admin);
    await openTab(admin.page, 'Gallery');
    const card = admin.page.locator('#view .card', { hasText: WORKBENCH_TITLE }).first();
    await card.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await openDisclosure(admin.page, 'Record a documented adoption');
    const form = card.locator('form').filter({ hasText: 'Record adoption' }).first();
    await form.locator('[name="note"]').fill('Cited in the fictional browser community register.');
    await form.locator('[name="evidence"]').fill('Register entry REG-BROWSER-2026-10-13.');
    await form.getByRole('button', { name: 'Record adoption', exact: true }).click();
    const adoption = await waitForCondition(async () => row('SELECT * FROM adoptions WHERE submission_id=?', second.id) || null, 'the adoption declaration to be stored');
    expect(/DOCUMENTED ADOPTION — MISSION OWNER DECLARATION/.test(adoption.note), 'the declaration must say what it is', { actual: adoption.note.slice(0, 200) });
    expect(adoption.note.includes('Register entry REG-BROWSER-2026-10-13.'), 'the supporting evidence must be recorded with it', { actual: adoption.note.slice(0, 400) });
    expect(/not proof that the work was implemented/.test(adoption.note), 'the declaration must state what it is not', { actual: adoption.note.slice(-300) });
    expect(adoption.owner_id === state.fixtures.admin.id, 'the adopter must be the mission owner', { expected: state.fixtures.admin.id, actual: describe(adoption.owner_id) });
    await waitForText(admin.page, 'Register entry REG-BROWSER-2026-10-13.');
    const view = await inPage(admin.page, `/review/workbench?submission=${encodeURIComponent(second.id)}`, { method: 'GET' });
    expect(view.body.submission.state.value === 'adopted' && view.body.adoptions.length === 1, 'the workbench must read the adopted state and the declaration', { actual: describe({ state: view.body.submission.state.value, adoptions: view.body.adoptions.length }) });
    expect(view.body.roles.may_adopt === true && view.body.roles.distinct.adopter_from_reviewer === true, 'the adopter stays a distinct person from the reviewer', { actual: describe(view.body.roles.distinct) });
    const packet = await inPage(admin.page, `/briefing?submission=${encodeURIComponent(second.id)}&format=json`, { method: 'GET' });
    expect(packet.status === 200 && packet.body.documented_uses === 1 && packet.body.adoptions[0].declared_by === ACTORS.admin.name, 'the packet must carry the declaration', { actual: `HTTP ${packet.status} ${describe(packet.body?.documented_uses)}` });
    expect(/recorded declaration by the mission owner/.test(packet.body.boundary) && /not proof that the work was implemented/.test(packet.body.boundary), 'the packet must state the adoption boundary', { actual: packet.body.boundary });
    return `adoption ${adoption.id} by ${adoption.owner_id} with its supporting evidence; the packet carries the declaration and its boundary`;
  });

  return `one reviewer assessed both versions criterion by criterion, compared ${first.id} against a newer capture, requested “${requested}” and accepted the correction; the mission owner recorded one adoption with its evidence`;
});

// ---------------------------------------------------------------------------------------------
// Scenario — the advisory mission-quality signals beside the reviewer's own surface
// ---------------------------------------------------------------------------------------------

define('mission-quality-advisory-signals', async () => {
  const admin = await actor('admin');
  const reviewer = await actor('reviewer');
  // This scenario's own operator and resident. The shared fictional contributor reaches the shipped
  // 100-coin daily operator limit by the time this scenario runs in the full suite, and the receipt
  // assertion below needs an operator whose own UTC day is still fresh.
  const ticket = await ensureAccount(fixtures().admin, { email: 'quality-contributor@browser.test', password: PASSWORD, name: 'Browser quality contributor' });
  const resident = await apiExpect(ticket, 'POST', '/agents', { kind: 'agent', name: 'Quality resident', color: '#5d7bb1', symbol: '✎', capabilities: 'Reads approved sources and prepares cited briefs', limitations: 'No external tools and no real-world claims' });
  // The stored research proposal supplies the text, so the near-duplicate measure has a real
  // neighbour to score against. The mission keeps its own known defects — no recorded source
  // register and no stated limits — and it is created and opened with them present.
  const lead = row("SELECT * FROM research_leads WHERE id='NP-2-baseline'");
  expect(lead && lead.title && lead.instructions, 'the stored research proposal must be readable', { actual: describe(lead) });
  const TITLE = lead.title;
  const DISMISSAL_NOTE = 'Checked against the stored research proposal: this fixture deliberately reuses that proposal’s text, so the match is expected and names no duplicate work.';
  const mission = await apiExpect(fixtures().admin, 'POST', '/missions', {
    title: TITLE, area: 'Agriculture', summary: lead.instructions.slice(0, 2000),
    beneficiary: 'Acceptance community', owner_id: state.fixtures.owner.id, reviewer_id: state.fixtures.reviewer.id, rubric: lead.rubric,
  });
  const task = await apiExpect(fixtures().admin, 'POST', '/tasks', {
    mission_id: mission.id, title: 'Record one source (quality)', instructions: lead.instructions.slice(0, 2000),
    rights: 'Public material with attribution.', allowed_domains: ['example.org'],
  });
  await apiExpect(fixtures().admin, 'POST', '/missions/status', { mission_id: mission.id, status: 'open' });
  // The store's own fingerprint, so "a dismissal writes nothing" is checked against every table and
  // the audit chain rather than one counter.
  const storeCounts = () => ['missions', 'tasks', 'claims', 'submissions', 'reviews', 'reports', 'adoptions', 'coin_rewards', 'audit'].map((table) => `${table}:${count(`SELECT COUNT(*) AS n FROM ${table}`)}`).join('|');
  const openQuality = async (page) => {
    const card = page.locator('#view .card', { hasText: TITLE }).first();
    await card.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const summary = card.locator('summary', { hasText: 'Mission quality signals' }).first();
    await summary.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    if (!await summary.evaluate((node) => node.closest('details')?.open === true)) await summary.click();
    await card.getByRole('button', { name: 'Load advisory signals', exact: true }).click();
    await waitForCondition(async () => ((await card.locator('.mission-quality-panel').textContent().catch(() => '')) || '').includes('near_duplicate') ? true : null, 'the advisory signals to render');
    return card;
  };
  let assessment = null, submission = null, score = null, threshold = null;

  await step('the flagged proposal is created and opened, and its assessment is read over the API', async () => {
    const refused = await apiGet(`/quality?task=${encodeURIComponent(task.id)}`, { token: state.fixtures.stranger.token });
    expect(refused.status === 403, 'a member who is not a reviewer must be refused', { expected: 'HTTP 403', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    assessment = await apiExpect(state.fixtures.reviewer, 'GET', `/quality?task=${encodeURIComponent(task.id)}`, undefined, [200]);
    expect(assessment.advisory === true && assessment.authority.level === 'advisory' && assessment.authority.changes_status === false, 'the assessment must carry the module’s own advisory authority statement', { actual: describe(assessment.authority) });
    const missing = assessment.missing.map((entry) => entry.field);
    expect(missing.includes('limits') && missing.includes('sources'), 'the proposal’s two known defects must be reported by field name', { actual: describe(missing) });
    const duplicate = assessment.signals.find((signal) => signal.code === 'near_duplicate');
    expect(duplicate && duplicate.advisory === true, 'the stored research proposal must be reported as one advisory signal', { actual: describe(assessment.signals.map((signal) => signal.code)) });
    threshold = assessment.duplicates.threshold;
    score = assessment.duplicates.matches[0].score;
    expect(assessment.duplicates.matches[0].id === lead.id && score >= threshold, 'the closest match must name the stored proposal at or above the threshold', { expected: `≥ ${threshold}`, actual: describe(assessment.duplicates.matches[0]) });
    expect(assessment.thresholds.duplicate_similarity === threshold, 'the threshold that was actually used must be returned', { actual: describe(assessment.thresholds.duplicate_similarity) });
    expect(row('SELECT status FROM missions WHERE id=?', mission.id).status === 'open', 'a flagged mission must still be created, given a task and opened', { actual: describe(row('SELECT status FROM missions WHERE id=?', mission.id)) });
    return `mission ${mission.id} created and opened with ${missing.length} unusable field(s); the closest stored proposal scores ${score} at the ${threshold} threshold`;
  });

  await step('a contributor submits a cited version against that task', async () => {
    const claim = await apiExpect(ticket, 'POST', '/claims', { task_id: task.id, agent_id: resident.id }, [201], { headers: { 'Idempotency-Key': 'browser-quality-claim' } });
    // The submitted text is unique to this scenario: the shipped coin predicate refuses a receipt for
    // identical normalised work, and the shared fixture artifact has already earned one elsewhere.
    submission = await apiExpect(ticket, 'POST', '/submissions', { ...EVIDENCE, artifact: 'A quality-signal fixture contribution whose exact wording belongs to this scenario alone.', claim_id: claim.id }, [201], { headers: { 'Idempotency-Key': 'browser-quality-submit' } });
    expect(submission.status === 'pending_review', 'the version must wait for review', { actual: describe(submission.status) });
    return `submission ${submission.id} is pending review with the advisory signals unchanged`;
  });

  await step('the reviewer reads the advisory signals and their score beside the review surface', async () => {
    await openApp(reviewer.page, ACTORS.reviewer);
    await openTab(reviewer.page, 'Review');
    const card = await openQuality(reviewer.page);
    const panel = card.locator('.mission-quality-panel');
    const text = (await panel.textContent()) || '';
    expect(text.includes('near_duplicate'), 'the signal code must be shown verbatim', { actual: text.replace(/\s+/g, ' ').slice(0, 500) });
    expect(text.includes(String(score)), 'the score that was computed must be shown', { expected: String(score), actual: text.replace(/\s+/g, ' ').slice(0, 700) });
    expect(text.includes(String(threshold)), 'the threshold that was used must be shown', { expected: String(threshold), actual: text.replace(/\s+/g, ' ').slice(0, 700) });
    expect(/Advisory only\./.test(text) && /blocks creating, activating, claiming, submitting, reviewing or adopting this work/.test(text), 'the panel must say in words what it does not do', { actual: text.replace(/\s+/g, ' ').slice(0, 500) });
    expect(text.includes('limits') && text.includes('sources'), 'the unusable required fields must be named', { actual: text.replace(/\s+/g, ' ').slice(0, 700) });
    expect(text.includes(assessment.authority.coin_decision.slice(0, 60)), 'the coin decision must stay where the module says it stays', { actual: 'the coin statement was missing from the panel' });
    // No verdict and no blocking control is presented: the only control is the read, and no severity is
    // styled as a warning. This reviewer is one of the people the signal names, so the module will not
    // let them check it off, and the interface repeats the module’s own reason rather than offering a
    // control that could never work.
    const labels = await panel.locator('button').allTextContents();
    expect(labels.length === 1 && labels[0].trim() === 'Refresh advisory signals', 'the panel must offer no verdict or blocking control', { actual: describe(labels) });
    expect(await panel.locator('.badge.warning').count() === 0, 'no severity may be presented as a warning verdict', { actual: 'a warning badge was rendered' });
    expect(/An independent human must dismiss a signal/.test(text) && /the named reviewer is one of the parties the signal concerns/.test(text), 'the named reviewer must be told, in the module’s own words, why this check is not theirs', { actual: text.replace(/\s+/g, ' ').slice(-500) });
    return `the panel showed the code, the score ${score} and the threshold ${threshold}; the only control is a refresh, and the named reviewer is told why the check is not theirs`;
  });

  await step('an independent administrator checks the signal off for this session only, and it is stored nowhere', async () => {
    await openApp(admin.page, ACTORS.admin);
    await openTab(admin.page, 'Review');
    const card = await openQuality(admin.page);
    const panel = card.locator('.mission-quality-panel');
    const before = storeCounts();
    const schemaBefore = validateDatabase(state.database).schema_version;
    const form = panel.locator('form').filter({ hasText: 'Checked — not a problem' }).first();
    await form.locator('[name="note"]').fill(DISMISSAL_NOTE);
    await form.getByRole('button', { name: 'Checked — not a problem', exact: true }).click();
    await waitForCondition(async () => ((await panel.textContent().catch(() => '')) || '').includes(DISMISSAL_NOTE) ? true : null, 'the dismissal to be shown beside the signal');
    const text = (await panel.textContent()) || '';
    expect(text.includes(ACTORS.admin.name), 'the declaration must name the human who made it', { actual: text.replace(/\s+/g, ' ').slice(-400) });
    expect(/Kept in this browser session only/.test(text) && /Nothing was written/.test(text), 'the panel must state the honest scope of a dismissal', { actual: text.replace(/\s+/g, ' ').slice(-600) });
    // It was not recorded anywhere: no row, no audit entry and no dismissal table to record it in.
    expect(storeCounts() === before, 'a dismissal must write nothing at all', { expected: before, actual: storeCounts() });
    expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND lower(name) LIKE '%dismiss%'") === 0, 'no dismissal table exists, which is why the check cannot be recorded', { actual: 'a dismissal table appeared' });
    expect(validateDatabase(state.database).schema_version === schemaBefore, 'a dismissal must leave the database schema unchanged', { expected: schemaBefore, actual: describe(validateDatabase(state.database).schema_version) });
    // Reloading forgets it, because nothing was stored.
    await admin.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(admin.page);
    await openTab(admin.page, 'Review');
    const reopened = await openQuality(admin.page);
    const after = (await reopened.locator('.mission-quality-panel').textContent()) || '';
    expect(after.includes(DISMISSAL_NOTE) === false, 'the dismissal must not survive a reload, because nothing was stored', { actual: 'the dismissal text was still shown after the reload' });
    expect(await reopened.getByRole('button', { name: 'Checked — not a problem', exact: true }).count() === 1, 'the control must be offered again after the reload', { actual: 'the dismissal control was not offered again' });
    return `the dismissal was displayed, wrote nothing (${before.split('|').length} tables and the audit chain unchanged), and did not survive a reload`;
  });

  await step('the reviewer records an ordinary acceptance, so the flags blocked nothing', async () => {
    await openTab(reviewer.page, 'Review');
    const card = reviewer.page.locator('#view .card', { hasText: TITLE }).first();
    const form = card.locator('form').filter({ hasText: 'Record review' }).first();
    await form.locator('select[name="decision"]').selectOption('accepted');
    await form.locator('[name="reason"]').fill('The cited source and its location are recorded, and the advisory signals were read and changed nothing here.');
    await form.getByRole('button', { name: 'Record review', exact: true }).click();
    const stored = await waitForCondition(async () => row('SELECT * FROM reviews WHERE submission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', submission.id) || null, 'the acceptance to be stored');
    expect(stored.decision === 'accepted' && stored.reviewer_id === state.fixtures.reviewer.id, 'the acceptance must be stored against the flagged version', { actual: describe(stored) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', submission.id) === 1, 'exactly one receipt must be issued', { actual: `${count('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', submission.id)} receipts` });
    expect(scalar('SELECT amount FROM coin_rewards WHERE submission_id=?', submission.id) === 10, 'the receipt must be the shipped fixed ten-coin award', { actual: describe(scalar('SELECT amount FROM coin_rewards WHERE submission_id=?', submission.id)) });
    // The whole create, activate, submit and review sequence left the reading identical: the flags are
    // a reading of the proposal, not a state that anything acts on.
    const after = await apiExpect(state.fixtures.reviewer, 'GET', `/quality?task=${encodeURIComponent(task.id)}`, undefined, [200]);
    expect(JSON.stringify(after) === JSON.stringify(assessment), 'the assessment must be byte-identical after the flow', { actual: 'the assessment changed during the flow' });
    return `accepted by ${stored.reviewer_id} for one 10-coin receipt; the assessment is byte-identical before and after`;
  });

  return `one flagged mission was created, opened, submitted against and accepted; a reviewer read the advisory signals with the score ${score}, and an independent administrator checked one off for the session only without writing anything, which a reload forgot`;
});

// ---------------------------------------------------------------------------------------------
// Scenario 24 — the four states, self-adoption and the quarantine hold
// ---------------------------------------------------------------------------------------------

define('review-states-and-refusals', async () => {
  const admin = await actor('admin');
  const reviewer = await actor('reviewer');
  const contributor = await actor('contributor');
  const { ticket, resident } = await contributorFixtures('States resident');
  // This mission is owned by the contributor's own operator: that is the self-adoption case.
  const SELF_ADOPTION_TITLE = 'Browser self-adoption fixture';
  const mission = await apiExpect(fixtures().admin, 'POST', '/missions', {
    title: SELF_ADOPTION_TITLE, area: 'Climate', summary: 'A bounded fixture whose owner also contributes.',
    beneficiary: 'Acceptance community', owner_id: ticket.account.id, reviewer_id: state.fixtures.reviewer.id,
    rubric: 'Check the exact source, its date, its rights and the remaining uncertainty.',
  });
  const task = await apiExpect(fixtures().admin, 'POST', '/tasks', { mission_id: mission.id, title: 'Record one source (self-adoption)', instructions: 'Provide the source, its exact location, rights and uncertainty.', rights: 'Public material with attribution.', allowed_domains: ['example.org'] });
  await apiExpect(fixtures().admin, 'POST', '/missions/status', { mission_id: mission.id, status: 'open' });
  let submission = null, receipt = null;

  await step('an independently accepted contribution starts accepted with an available receipt', async () => {
    const claim = await apiExpect(ticket, 'POST', '/claims', { task_id: task.id, agent_id: resident.id }, [201], { headers: { 'Idempotency-Key': 'browser-states-claim' } });
    submission = await submitBrief(ticket, claim, 'states', randomHash(), 'browser-states-submit');
    const review = await apiExpect(fixtures().reviewer, 'POST', '/reviews', { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture acceptance after checking the cited section.' });
    expect(review.coin_reward?.status === 'awarded', 'the acceptance must award the fixed receipt', { actual: describe(review.coin_reward) });
    receipt = row('SELECT * FROM coin_rewards WHERE submission_id=?', submission.id);
    expect(row('SELECT status FROM submissions WHERE id=?', submission.id).status === 'accepted', 'the accepted state must be stored', { actual: describe(row('SELECT status FROM submissions WHERE id=?', submission.id)) });
    await openApp(contributor.page, ACTORS.contributor);
    const wallet = await inPage(contributor.page, `/coins?agent_id=${encodeURIComponent(resident.id)}`, { method: 'GET' });
    expect(wallet.body.balance === 10 && wallet.body.held === 0, 'the first acceptance must be available, not held', { actual: describe(wallet.body) });
    return `submission ${submission.id} accepted, receipt ${receipt.id.slice(0, 8)}…, wallet balance ${wallet.body.balance}`;
  });

  await step('the contributor who owns the mission still cannot adopt their own work', async () => {
    await openApp(contributor.page, ACTORS.contributor);
    await openTab(contributor.page, 'Gallery');
    const card = contributor.page.locator('#view .card', { hasText: SELF_ADOPTION_TITLE }).first();
    await card.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const text = await card.textContent();
    expect(/cannot also adopt it/.test(text), 'the interface must explain the separation instead of offering the form', { actual: text?.replace(/\s+/g, ' ').slice(0, 400) });
    expect(await card.locator('form').filter({ hasText: 'Record adoption' }).count() === 0, 'the contributor must not be offered an adoption control', { actual: 'an adoption form was rendered' });
    const refused = await inPage(contributor.page, '/adoptions', { body: { submission_id: submission.id, note: 'Adopting my own contribution.' } });
    expect(refused.status === 403 && /cannot adopt their own contribution/.test(refused.body?.error || ''), 'the server must refuse the self-adoption by name', { expected: 'HTTP 403 naming the contributor rule', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(count('SELECT COUNT(*) AS n FROM adoptions WHERE submission_id=?', submission.id) === 0, 'a refused self-adoption must write no record', { actual: 'an adoption row appeared' });
    return `the interface offered no control and the server answered ${refused.status}: ${refused.body?.error}`;
  });

  await step('quarantine holds the coin and the availability without rewriting the record', async () => {
    const before = { review: row('SELECT * FROM reviews WHERE submission_id=?', submission.id), receipt: row('SELECT * FROM coin_rewards WHERE submission_id=?', submission.id) };
    const report = await apiExpect(fixtures().reviewer, 'POST', '/reports', { target_type: 'submission', target_id: submission.id, reason: 'Browser fixture: hold this evidence for inspection.' });
    await apiExpect(fixtures().admin, 'POST', '/moderation', { report_id: report.id, action: 'quarantine', reason: 'Hold for inspection in the browser fixture.' });
    expect(row('SELECT status FROM submissions WHERE id=?', submission.id).status === 'quarantined', 'the version must be quarantined', { actual: describe(row('SELECT status FROM submissions WHERE id=?', submission.id)) });
    expect(JSON.stringify(row('SELECT * FROM reviews WHERE submission_id=?', submission.id)) === JSON.stringify(before.review), 'the acceptance record must be untouched', { actual: 'the review row changed' });
    expect(JSON.stringify(row('SELECT * FROM coin_rewards WHERE submission_id=?', submission.id)) === JSON.stringify(before.receipt), 'the issued receipt must be untouched', { actual: 'the receipt row changed' });
    const wallet = await inPage(contributor.page, `/coins?agent_id=${encodeURIComponent(resident.id)}`, { method: 'GET' });
    expect(wallet.body.balance === 0 && wallet.body.held === 10 && wallet.body.issued === 10, 'quarantine must hold the receipt rather than void it', { expected: 'available 0, held 10, issued 10', actual: describe(wallet.body) });
    expect(wallet.body.receipts[0].id === before.receipt.id && wallet.body.receipts[0].state === 'held', 'the same receipt must simply read held', { actual: describe(wallet.body.receipts[0]) });
    // The interface names the held state and keeps saying what is retained.
    await contributor.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(contributor.page);
    await openTab(contributor.page, 'My contributions');
    const record = contributor.page.locator('#view .record', { hasText: 'Browser reviewer fixture states' }).first();
    await record.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const text = await record.textContent();
    expect(/Held — quarantined/.test(text), 'the contributor must read the held state in words', { actual: text?.replace(/\s+/g, ' ').slice(0, 300) });
    expect(/retained exactly as they were/.test(text), 'the held state must say the record is retained', { actual: text?.replace(/\s+/g, ' ').slice(0, 400) });
    await openTab(contributor.page, 'Coin wallet');
    const picker = contributor.page.locator('#view select[name="wallet_agent"]');
    if (await picker.count()) await picker.selectOption(resident.id);
    // Selecting a wallet character reloads its journey, so the held figure is waited for rather than
    // read from whichever resident the page happened to hold.
    const held = await waitForCondition(async () => {
      const value = await contributor.page.locator('#view .progress-card', { hasText: 'Held coins' }).first().locator('strong').textContent().catch(() => null);
      return value?.trim() === '10' ? value : null;
    }, 'the wallet to show the held coin for this resident');
    expect(held.trim() === '10', 'the wallet must show the held coin', { expected: '10', actual: describe(held) });
    return `quarantined: the acceptance and receipt rows are byte-identical, the wallet reads available 0 / held 10 and the contribution reads “Held — quarantined”`;
  });

  await step('a replayed and a simultaneous acceptance still issue exactly one receipt', async () => {
    const racedTask = await apiExpect(fixtures().admin, 'POST', '/tasks', { mission_id: mission.id, title: 'Record one source (raced)', instructions: 'Provide the source, its exact location, rights and uncertainty.', rights: 'Public material with attribution.', allowed_domains: ['example.org'] });
    const claim = await apiExpect(ticket, 'POST', '/claims', { task_id: racedTask.id, agent_id: resident.id }, [201], { headers: { 'Idempotency-Key': 'browser-states-race-claim' } });
    const raced = await submitBrief(ticket, claim, 'raced', randomHash(), 'browser-states-race-submit');
    const [first, second] = await Promise.all([
      apiPost('/reviews', { submission_id: raced.id, decision: 'accepted', reason: 'Concurrent acceptance A.' }, { token: state.fixtures.reviewer.token }),
      apiPost('/reviews', { submission_id: raced.id, decision: 'accepted', reason: 'Concurrent acceptance B.' }, { token: state.fixtures.admin.token }),
    ]);
    expect([first.status, second.status].sort().join(',') === '201,409', 'two simultaneous acceptances must resolve to one acceptance and one refusal', { expected: 'HTTP 201 and HTTP 409', actual: `${first.status} and ${second.status}` });
    const replay = await apiPost('/reviews', { submission_id: raced.id, decision: 'accepted', reason: 'A replay of the same acceptance.' }, { token: state.fixtures.reviewer.token });
    expect(replay.status === 409, 'a replayed acceptance must be refused', { expected: 'HTTP 409', actual: `HTTP ${replay.status} ${describe(replay.body)}` });
    const receipts = count('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', raced.id);
    expect(count('SELECT COUNT(*) AS n FROM reviews WHERE submission_id=?', raced.id) === 1 && receipts === 1, 'exactly one review and one receipt must exist for the raced version', { actual: `${count('SELECT COUNT(*) AS n FROM reviews WHERE submission_id=?', raced.id)} reviews, ${receipts} receipts` });
    const validation = validateDatabase(state.database);
    expect(validation.accounts >= 5, 'the database must still validate with its coin ledger after the race', { actual: describe(validation) });
    return `two simultaneous acceptances resolved to ${first.status}/${second.status}, the replay was refused, and exactly one 10-coin receipt exists`;
  });

  return `the accepted, held and refused states stayed distinct for one contributor; self-adoption was refused without a record and two simultaneous acceptances issued one receipt`;
});

// The suite runs only when it is the entry point, so a unit test can import the pure helpers above
// (and `npm test` keeps passing with no node_modules directory).
// Integration acceptance: the host and guest are human avatars in separate browsers. The AI
// resident uses a scoped runtime credential (a deterministic API action, not an LLM decision).
// Starter herbs and initial positions are explicitly prepared fixtures; all subsequent building,
// grants, exchange and progress cross the real server and are checked again after a process restart.
define('shared-build-and-restart', async () => {
  const owner = await actor('owner'), admin = await actor('admin');
  const guest = fixtures().characters.player, ai = fixtures().characters.walker;
  const world = 'frontier:0:0', plot = 'plot:0:0:5:5';
  const host = await apiExpect(fixtures().owner, 'POST', '/agents', { kind: 'human', name: 'Shared host', capabilities: 'Build together in this acceptance fixture', limitations: 'No real-world output', color: '#397f79', symbol: '✦' });
  let grantId, offerId, runtime;
  const coinsBefore = count('SELECT COUNT(*) FROM coin_rewards');
  const snapshot = () => JSON.stringify({
    blocks: rows('SELECT * FROM frontier_blocks WHERE plot_id=? ORDER BY x,y,z', plot),
    grants: rows('SELECT * FROM plot_grants WHERE plot_id=? ORDER BY id', plot),
    grantEvents: rows('SELECT * FROM plot_grant_events WHERE grant_id=? ORDER BY id', grantId),
    offers: rows('SELECT * FROM resource_offers WHERE id=?', offerId),
    offerEvents: rows('SELECT * FROM resource_offer_events WHERE offer_id=? ORDER BY id', offerId),
    inventory: rows('SELECT * FROM journey_inventory WHERE agent_id IN (?,?) ORDER BY agent_id,kind', host.id, guest.id),
    memory: rows('SELECT * FROM resident_memory WHERE agent_id=? ORDER BY id',ai.id),
  });
  await step('two human operators and one AI resident meet on the host’s stewarded plot', async () => {
    await apiExpect(fixtures().owner, 'POST', '/land/assign', { plot_id: plot, purpose: 'A shared learning path', description: 'A disposable test of building and item exchange across two operators.' });
    for (const [resident, x, y] of [[host,31,32],[guest,34,33],[ai,32,33]]) {
      write('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', world,x,y,resident.id);
    }
    write('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?)',host.id,'herbs',3);
    runtime = await apiExpect(fixtures().owner, 'POST', '/runtime/start', { agent_id:ai.id, minutes:10,max_calls:20,scopes:['read','build'] });
    await openApp(owner.page,ACTORS.owner); await openWorldAs(owner.page,host.id);
    await openApp(admin.page,ACTORS.admin); await openWorldAs(admin.page,guest.id);
    for (const page of [owner.page,admin.page]) await waitForClient(page, w => {
      const view=window.__nemoworld?.world?.();return view?.world?.id===w&&view.participants.some(p=>p.kind==='human')&&view.participants.some(p=>p.kind==='agent')?true:null;
    },world,'both browsers to see the shared humans and AI');
    return 'two human browser sessions and one AI resident in frontier:0:0; three fixture herbs';
  });
  await step('the host previews without writing, keeps the form, and confirms narrow guest access',async()=>{
    const card=owner.page.locator('.grant-card'), form=card.locator('form');
    await form.locator('[name="guest_agent_id"]').selectOption(guest.id);
    await form.locator('[name="purpose"]').fill('Help lay our shared path');
    await form.locator('input[name="block_types"][value="path"]').check();
    const before=count('SELECT COUNT(*) FROM plot_grants');
    await card.getByRole('button',{name:'Preview the exact collaboration access without granting it',exact:true}).click();
    await card.locator('#grant-report').getByText('This preview wrote 0 rows.',{exact:true}).waitFor();
    expect(count('SELECT COUNT(*) FROM plot_grants')===before,'a preview must create no grant');
    expect(await form.locator('[name="purpose"]').inputValue()==='Help lay our shared path','preview must preserve the purpose');
    expect(await form.locator('[name="guest_agent_id"]').inputValue()===guest.id,'preview must preserve the intended guest');
    await form.getByRole('button',{name:'Grant building access',exact:true}).click();
    const grant=await waitForCondition(async()=>row('SELECT id FROM plot_grants WHERE plot_id=? AND guest_agent_id=?',plot,guest.id),'the confirmed grant to be saved');grantId=grant.id;
    await admin.page.reload({waitUntil:'domcontentloaded'});await settle(admin.page);await openWorldAs(admin.page,guest.id);
    expect((await admin.page.locator('.grant-card').textContent()).includes('Help lay our shared path'),'the guest must see the held grant, even when it owns another plot');
    return `saved grant ${grantId}; path blocks on layer 0 only`;
  });
  const place=async(page,x,y)=>{
    await page.locator('.frontier-hotbar').getByRole('button',{name:/^\d+ path$/}).click();
    const form=page.locator('#view form').filter({has:page.getByRole('button',{name:'Apply block at coordinates',exact:true})});
    await form.locator('[name="x"]').fill(String(x));await form.locator('[name="y"]').fill(String(y));await form.locator('[name="z"]').fill('0');
    await frontierClick(page,form.getByRole('button',{name:'Apply block at coordinates',exact:true}));
    await waitForCondition(async()=>row('SELECT id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z=0',world,x,y),'the human’s block to be saved');
  };
  await step('both humans build through the UI and the scoped AI runtime adds an attributed block',async()=>{
    await place(owner.page,31,31);await place(admin.page,32,32);
    await apiExpect(runtime,'POST','/frontier/build',{world_id:world,x:33,y:32,z:0,type:'wood'});
    const blocks=rows('SELECT x,y,type,creator_agent_id,grant_id FROM frontier_blocks WHERE plot_id=?',plot);
    expect(blocks.length===3,'three blocks must be stored',{actual:describe(blocks)});
    expect(new Set(blocks.map(b=>b.creator_agent_id)).size===3,'each human and AI build must have its own attribution');
    expect(blocks.find(b=>b.creator_agent_id===guest.id)?.grant_id===grantId,'the guest block must name its live grant');
    await waitForClient(admin.page,p=>{const b=window.__nemoworld?.world?.()?.blocks||[];return b.filter(x=>x.plot_id===p).length===3?true:null;},plot,'the other client to receive all three saved blocks');
    return 'three stored blocks: human host, human guest with grant, AI scoped runtime; same shared view';
  });
  await step('the operator records a private AI purpose while human calling controls remain usable',async()=>{
    await openTab(owner.page,'Callings & guilds');
    expect(await owner.page.locator('.calling-story').count()===1,'a human player must be able to open its calling without an AI-memory 404');
    await openWorldAs(owner.page,ai.id);await openTab(owner.page,'Callings & guilds');
    const form=owner.page.locator('#view form').filter({has:owner.page.getByRole('button',{name:'Record a memory fact from your own input',exact:true})});
    await form.locator('[name="kind"]').selectOption('purpose');await form.locator('[name="attribute"]').selectOption('intent');
    await form.locator('[name="value"]').fill('Build a welcoming shared learning path.');
    await form.getByRole('button',{name:'Record a memory fact from your own input',exact:true}).click();
    await waitForCondition(async()=>row("SELECT id FROM resident_memory WHERE agent_id=? AND state='active'",ai.id),'the approved purpose to be saved');
    const stranger=await apiRequest(`/memory?agent_id=${ai.id}`,{token:fixtures().admin.token});
    expect(stranger.status===404,'the other operator must not read the AI resident’s private memory');
    const own=await apiRequest('/memory',{token:runtime.token});
    expect(own.status===200&&own.body.facts.some(f=>f.value==='Build a welcoming shared learning path.'),'the resident credential observes its own approved purpose');
    await openWorldAs(owner.page,host.id);
    return 'human calling screen usable; one operator-approved AI purpose; other operator refused 404';
  });
  await step('the host offers one herb and the named recipient accepts once through the UI',async()=>{
    await openTab(owner.page,'Garden & workshop');
    const card=owner.page.locator('#view .card',{has:owner.page.getByRole('heading',{name:'Give what you grew',exact:true})});
    const form=card.locator('form');await form.locator('[name="recipient_agent_id"]').selectOption(guest.id);await form.locator('[name="kind"]').selectOption('herbs');
    await form.locator('[name="quantity"]').fill('1');await form.locator('[name="note"]').fill('Thank you for building together');
    await form.getByRole('button',{name:'Offer items',exact:true}).click();
    const offer=await waitForCondition(async()=>row('SELECT id,status FROM resource_offers WHERE offerer_agent_id=? AND recipient_agent_id=?',host.id,guest.id),'the escrowed offer');offerId=offer.id;
    expect(scalar('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?',host.id,'herbs')===2,'the offer must escrow exactly one herb');
    await openTab(admin.page,'Garden & workshop');
    await admin.page.locator('#view').getByRole('button',{name:'Accept',exact:true}).click();
    await waitForCondition(async()=>row('SELECT status FROM resource_offers WHERE id=?',offerId)?.status==='accepted','the browser acceptance to settle');
    expect(scalar('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?',guest.id,'herbs')===1,'the named recipient receives exactly one item');
    expect(count("SELECT COUNT(*) FROM resource_offer_events WHERE offer_id=? AND action='accepted'",offerId)===1,'one acceptance event only');
    expect(count('SELECT COUNT(*) FROM coin_rewards')===coinsBefore,'shared building and item exchange issue no coin');
    return 'offer accepted through the UI; two herbs on host shelf and one on recipient shelf';
  });
  await step('a full process restart preserves blocks, grants, item exchange and inventories',async()=>{
    const before=snapshot();await stopServer();await startServer();
    expect(snapshot()===before,'the exact shared progress must survive a server restart');
    for(const [page,resident,account] of [[owner.page,host,ACTORS.owner],[admin.page,guest,ACTORS.admin]]) {
      await openApp(page,account);await openWorldAs(page,resident.id);
      await waitForClient(page,p=>{const v=window.__nemoworld?.world?.();return v?.world?.id==='frontier:0:0'&&v.blocks.filter(b=>b.plot_id===p).length===3?true:null;},plot,'the restarted clients to reload saved construction');
    }
    return 'both clients reconnected; all three blocks and settled inventory exchange survived byte-for-byte';
  });
  await step('revoking access refuses the guest’s existing session and preserves completed construction',async()=>{
    await owner.page.locator('.grant-card').getByRole('button',{name:`Revoke the collaboration granted to ${guest.name}`,exact:true}).click();
    await waitForCondition(async()=>row('SELECT status FROM plot_grants WHERE id=?',grantId)?.status==='revoked','revocation to persist');
    const refused=await apiRequest('/frontier/build',{method:'POST',token:fixtures().admin.token,body:{agent_id:guest.id,world_id:world,x:32,y:31,z:0,type:'path'}});
    expect(refused.status===403,'cached guest credentials must lose building access immediately',{actual:describe(refused.body)});
    expect(count('SELECT COUNT(*) FROM frontier_blocks WHERE plot_id=?',plot)===3,'revocation must preserve the work already built');
    return '403 for cached guest session after revocation; three attributed blocks remain';
  });
  return 'two humans and a scoped AI runtime built together, exchanged one item, and reloaded their saved progress after a real server restart';
});

// ---------------------------------------------------------------------------------------------
// Wave B — two connected frontier gates, crossed by two independent humans and one active AI
//
// Wave B's acceptance sentence is only partly unproved on this tip. `shared-build-and-restart` already
// drives two humans and one scoped AI runtime building, exchanging an item and surviving a restart;
// `restoration-two-clients` and `cooperative-restoration-two-operators` drive a shared world change;
// `first-ten-minutes` covers choosing a calling. None of them crosses a frontier gate, and none of
// them carries one party through its whole acceptance sentence. This scenario covers the combination
// and re-proves none of the others: three residents in one seeded sector, the two connected gates
// that leave it, the server's own stored answer for every crossing, one calling chosen per resident,
// one cooperative saved world change in the sector the party crossed into, and a real restart.
//
// Each claim is read back from the temporary SQLite database or from the server's own payload: the
// stored `world_id`, the stored arrival tile, the `messages` rows with their sender, operator,
// channel, world, recipients and text, the `resident_callings` and `calling_receipts` rows, the
// `frontier_blocks` rows with their creator, operator, plot and grant, and the `resident_memory`
// purpose row across a real process restart. The two humans belong to operators this scenario creates
// for itself, so no shared fixture is moved, and each human walks into the frontier through the
// Commons' own passage in its browser. The build site is *found* rather than assumed: the seeded
// frontier reserves the crossroads plots and every water or dense-habitat plot, so the scenario asks
// the shipped land registry for an assignable plot near the tile the last crossing landed on, and the
// whole search writes nothing.
// ---------------------------------------------------------------------------------------------

/** The seeded 3 × 3 frontier a two-gate path crosses, and the Commons passage into the first sector. */
const WAVE_B_FIRST = 'frontier:0:0';
const WAVE_B_SECOND = 'frontier:0:-1';
const WAVE_B_THIRD = 'frontier:1:-1';
const COMMONS_FRONTIER_PASSAGE = { x: 19, y: 6 };
/**
 * The order the client's four movement controls sit in around the compass. A movement control is
 * camera-relative in first person and absolute in the orbiting view, but a camera rotation preserves
 * this cycle, so one measured step names all four.
 */
const CONTROL_CYCLE = Object.freeze({ up: 'right', right: 'down', down: 'left', left: 'up' });
const WAVE_B_HUMAN_LINE = 'The east passage answers back onto the field we came from; the new path holds.';
const WAVE_B_AI_LINE = 'Both passages are open and I am standing on the second gate.';
const WAVE_B_PURPOSE = 'Cross both frontier passages and keep the shared path open.';
/**
 * The calling each of the three crossing residents chooses. The host's human picks the Builder, whose
 * own objective is a saved frontier block; the guest's human picks the Cultivator; and the AI resident
 * is given the Steward, whose `path_place` objective is a saved ground path inside its operator's own
 * plot — so the one world change this party makes is the work its callings actually describe.
 */
const WAVE_B_CALLINGS = Object.freeze({ host: 'builder', guest: 'cultivator', aide: 'steward' });

/**
 * Where the crossing party raises its shared path: one assignable plot in the sector the last crossing
 * reached, the walkable tile in it nearest that arrival (the staging tile), and the three walkable
 * tiles nearest the staging tile (the blocks). This is a **read** of the shipped land registry, the
 * published world definition and the saved blocks: it writes nothing, it moves no resident, and it
 * never invents a parcel. The seeded frontier reserves the crossroads plots and any water or
 * dense-habitat plot, so the plot is discovered from `GET /land` rather than assumed to be free.
 */
async function waveBPathSite(ticket, worldId, arrival) {
  const definition = getWorldDefinition(worldId);
  const plots = [];
  for (let offset = 0; ; offset += 50) {
    const page = await apiRequest(`/land?world_id=${encodeURIComponent(worldId)}&status=available&limit=50&offset=${offset}`, { token: ticket.token });
    if (page.status !== 200 || !Array.isArray(page.body?.plots)) {
      throw new BrowserSuiteFailure(`the land registry must describe ${worldId}`, { expected: 'HTTP 200 with an available-plot page', actual: `HTTP ${page.status} ${page.raw}` });
    }
    plots.push(...page.body.plots);
    if (!page.body.has_more) break;
  }
  expect(plots.length, `${worldId} must offer at least one assignable plot`, { expected: 'an available plot near the crossing', actual: `${plots.length} available plots` });
  const saved = new Set(rows('SELECT x,y FROM frontier_blocks WHERE world_id=? AND z=0', worldId).map((block) => `${block.x},${block.y}`));
  const free = (x, y) => walkable({ x, y }, definition) && !saved.has(`${x},${y}`);
  let site = null;
  for (const plot of plots) {
    for (let y = plot.y; y < plot.y + plot.height; y += 1) for (let x = plot.x; x < plot.x + plot.width; x += 1) {
      if (!free(x, y)) continue;
      const reach = Math.abs(x - arrival.x) + Math.abs(y - arrival.y);
      if (!site || reach < site.reach) site = { reach, plot, stage: { x, y } };
    }
  }
  expect(site, `${worldId} must hold an assignable plot with a walkable tile`, { expected: 'a walkable tile inside an available plot', actual: `${plots.length} available plots, none walkable` });
  const cells = [];
  for (let y = site.plot.y; y < site.plot.y + site.plot.height; y += 1) for (let x = site.plot.x; x < site.plot.x + site.plot.width; x += 1) {
    if (!free(x, y) || (x === site.stage.x && y === site.stage.y)) continue;
    cells.push({ x, y, from: Math.abs(x - site.stage.x) + Math.abs(y - site.stage.y) });
  }
  cells.sort((a, b) => a.from - b.from || a.y - b.y || a.x - b.x);
  const blocks = cells.slice(0, 3);
  expect(blocks.length === 3 && blocks.every((cell) => cell.from <= 6), `the plot ${site.plot.id} must hold three tiles the crossing party can reach on foot`, { expected: 'three walkable tiles within six steps of the staging tile', actual: describe({ plot: site.plot.id, stage: site.stage, cells }) });
  return { plot_id: site.plot.id, stage: site.stage, blocks: blocks.map(({ x, y }) => ({ x, y })), reach: site.reach };
}

/** One gate of a sector, by the direction a resident crosses it in. */
const waveBGate = (worldId, direction) => frontierGates(worldId).find((gate) => gate.direction === direction) || null;
/**
 * Where a crossing lands. `travel()` places the resident on the gate the entered sector answers the
 * sector it left with, so this is the tile a crossing must store — not the sector's own plaza start
 * and not whatever tile the movement happened to reach.
 */
const waveBArrival = (worldId, fromWorldId) => frontierGates(worldId).find((gate) => gate.targetWorldId === fromWorldId) || null;
/** The world cardinal one stored step produced. */
const stepCardinal = (from, to) => (to.y < from.y ? 'up' : to.y > from.y ? 'down' : to.x > from.x ? 'right' : 'left');
/** The stored row a resident's movement is judged by — never the interface's own opinion of it. */
const residentAt = (agentId) => row('SELECT world_id,x,y,status FROM agents WHERE id=?', agentId);

/**
 * One press of a movement control, confirmed by the database rather than by the interface looking
 * busy: `arrived` reads the stored row. Only the server's own movement-throttle refusal is resumed, a
 * bounded number of times, and every resume is reported — a documented refusal is never a failure.
 */
async function pressMoveUntil(page, agentId, control, arrived, label, { attempts = 4, timeout = 8000 } = {}) {
  const button = page.locator(`#view button[aria-label="Move ${control}"]`);
  await button.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  let notice = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await button.click();
    const reached = await waitForCondition(arrived, label, { timeout, interval: 80 }).catch(() => null);
    if (reached) return reached;
    notice = ((await page.locator('#notice').textContent().catch(() => '')) || '').trim();
    if (!throttleRefusal(notice)) break;
    console.log(`        walk retry       the server’s own movement throttle refused a step; pressing “Move ${control}” again for ${label}`);
    await page.waitForTimeout(500);
  }
  throw new BrowserSuiteFailure(`the “Move ${control}” control did not carry the step`, { expected: label, actual: `${describe(residentAt(agentId))}; the interface said “${notice}”` });
}

/**
 * Which movement control carries which world direction, measured instead of assumed, because a
 * movement control is camera-relative whenever this browser is in first person. One confirmed step
 * names its own control, the control cycle names the other three, and a second measured control then
 * checks the derived map. Both measured steps are undone immediately, so the resident starts and
 * ends on the tile this found it standing on.
 */
async function learnMovementControls(page, agentId) {
  const start = residentAt(agentId);
  const stepped = () => { const now = residentAt(agentId); return now.x !== start.x || now.y !== start.y ? now : null; };
  const backOn = () => { const now = residentAt(agentId); return now.x === start.x && now.y === start.y ? true : null; };
  const press = (control, arrived, label) => pressMoveUntil(page, agentId, control, arrived, label);
  let measuredControl = null, measuredDirection = null;
  for (const candidate of ['up', 'right', 'down', 'left']) {
    const after = await press(candidate, stepped, `the “Move ${candidate}” control to carry one confirmed step from ${start.x},${start.y}`).catch(() => null);
    if (!after) continue;
    measuredControl = candidate;
    measuredDirection = stepCardinal(start, after);
    break;
  }
  expect(measuredDirection, 'one movement control must carry a confirmed step out of the tile this resident was found on', { expected: `one tile of movement from ${start.x},${start.y}`, actual: `${describe(residentAt(agentId))} was refused in all four directions` });
  const controlFor = {};
  let control = measuredControl, direction = measuredDirection;
  for (let index = 0; index < 4; index += 1) { controlFor[direction] = control; control = CONTROL_CYCLE[control]; direction = CONTROL_CYCLE[direction]; }
  await press(controlFor[OPPOSITE_DIRECTION[measuredDirection]], backOn, `the resident to step back to ${start.x},${start.y}`);
  // The map is about to decide which way a crossing goes, so it is checked before it is used: a second
  // control is measured and has to agree with the direction the first measurement gave it.
  const probe = Object.keys(controlFor).find((item) => item !== measuredDirection);
  const after = await press(controlFor[probe], stepped, `the “Move ${controlFor[probe]}” control to carry one confirmed step for the map check`);
  expect(stepCardinal(start, after) === probe, 'the derived control map must hold for a second measured control', { expected: `“Move ${controlFor[probe]}” to move the resident ${probe}`, actual: `${stepCardinal(start, after)} to ${after.x},${after.y}` });
  await press(controlFor[OPPOSITE_DIRECTION[probe]], backOn, `the resident to step back to ${start.x},${start.y}`);
  return controlFor;
}

/**
 * One frontier crossing, driven from the exact gate tile with a movement control and confirmed by the
 * database. `src/spaces.js` crosses only when the resident stands on the gate tile itself *and* the
 * neighbour is opened, so that tile is asserted first, and the arrival is asserted against the gate
 * the entered sector answers with.
 */
async function browserCrossGate(page, agentId, controlFor, fromWorldId, gate, who) {
  const arrival = waveBArrival(gate.targetWorldId, fromWorldId);
  expect(arrival, `${gate.targetWorldId} must answer ${fromWorldId} with a gate of its own`, { expected: `a gate in ${gate.targetWorldId} that leads back to ${fromWorldId}`, actual: describe(frontierGates(gate.targetWorldId)) });
  const standing = residentAt(agentId);
  expect(standing.world_id === fromWorldId && standing.x === gate.x && standing.y === gate.y, `${who} must stand on the exact ${gate.direction} gate tile before crossing`, { expected: `${gate.x},${gate.y} in ${fromWorldId}`, actual: describe(standing) });
  const crossed = await pressMoveUntil(page, agentId, controlFor[gate.direction], () => { const now = residentAt(agentId); return now.world_id === gate.targetWorldId ? now : null; }, `${who} to cross the ${gate.direction} gate into ${gate.targetWorldId}`);
  expect(crossed.x === arrival.x && crossed.y === arrival.y, `${who} must arrive on the tile ${gate.targetWorldId} answers the crossing with`, { expected: `${arrival.x},${arrival.y} (its ${arrival.direction} gate)`, actual: describe(crossed) });
  return crossed;
}

/**
 * One path block through the shipped build panel — the same palette and coordinate form a player uses.
 * The stored row, not the interface, decides whether it worked, and the panel's own refusal is carried
 * into the failure message so a refused build is never reported as a missing write.
 */
async function waveBPlacePathThroughUi(page, worldId, cell) {
  await page.locator('.frontier-hotbar').getByRole('button', { name: /^\d+ path$/ }).click();
  const form = page.locator('#view form').filter({ has: page.getByRole('button', { name: 'Apply block at coordinates', exact: true }) });
  await form.locator('[name="x"]').fill(String(cell.x));
  await form.locator('[name="y"]').fill(String(cell.y));
  await form.locator('[name="z"]').fill('0');
  const notice = await frontierClick(page, form.getByRole('button', { name: 'Apply block at coordinates', exact: true }));
  const saved = await waitForCondition(async () => row('SELECT id,type,creator_agent_id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z=0', worldId, cell.x, cell.y) || null, `the block at ${cell.x}, ${cell.y} to be saved by the build panel`).catch(() => null);
  if (!saved) {
    throw new BrowserSuiteFailure(`the build panel never saved the block at ${cell.x}, ${cell.y}`, { expected: `a frontier_blocks row at ${cell.x},${cell.y} in ${worldId}`, actual: `the interface said “${notice}”` });
  }
  return saved;
}

/** One documented movement step with a runtime credential, paced past the server's own 120 ms throttle. */
async function runtimeStep(ticket, agentId, direction, { attempts = 4, paceMs = 140 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(paceMs);
    const response = await api(ticket, 'POST', '/move', { agent_id: agentId, direction });
    if (response.status === 200) return response.body;
    last = `HTTP ${response.status} ${response.raw}`;
    if (response.status !== 429) break;
  }
  throw new BrowserSuiteFailure(`the resident’s ${direction} step was refused`, { expected: 'HTTP 200 from POST /move', actual: last });
}

/** The shipped planner's own route out of the world it stands in, walked one documented step at a time. */
async function runtimeWalk(ticket, agentId, worldId, target, who) {
  const from = residentAt(agentId);
  expect(from.world_id === worldId, `${who} must stand in ${worldId} before this walk`, { expected: worldId, actual: describe(from) });
  const route = planWalk(getWorldDefinition(worldId), { x: from.x, y: from.y }, target, { objects: rows('SELECT type,x,y FROM world_objects WHERE world_id=?', worldId), maxSteps: 256, maxVisited: 16_384 });
  expect(route, `${who} must have a walkable route from ${from.x},${from.y} to ${target.x},${target.y}`, { expected: `a planned route from ${from.x},${from.y} to ${target.x},${target.y}`, actual: `no route through ${worldId}` });
  for (const direction of route) await runtimeStep(ticket, agentId, direction);
  const arrived = residentAt(agentId);
  expect(arrived.world_id === worldId && arrived.x === target.x && arrived.y === target.y, `${who} must finish the walk on the tile the planner aimed at`, { expected: `${target.x},${target.y} in ${worldId}`, actual: describe(arrived) });
  return { steps: route.length, arrived };
}

/** One gate crossing by a runtime credential: the same server rule, driven over the documented route. */
async function runtimeCrossGate(ticket, agentId, direction, fromWorldId, gate, who) {
  const arrival = waveBArrival(gate.targetWorldId, fromWorldId);
  expect(arrival, `${gate.targetWorldId} must answer ${fromWorldId} with a gate of its own`, { expected: `a gate in ${gate.targetWorldId} that leads back to ${fromWorldId}`, actual: describe(frontierGates(gate.targetWorldId)) });
  const standing = residentAt(agentId);
  expect(standing.world_id === fromWorldId && standing.x === gate.x && standing.y === gate.y, `${who} must stand on the exact ${direction} gate tile before crossing`, { expected: `${gate.x},${gate.y} in ${fromWorldId}`, actual: describe(standing) });
  await runtimeStep(ticket, agentId, direction);
  const crossed = residentAt(agentId);
  expect(crossed.world_id === gate.targetWorldId, `${who} must cross the ${direction} gate into ${gate.targetWorldId}`, { expected: gate.targetWorldId, actual: describe(crossed) });
  expect(crossed.x === arrival.x && crossed.y === arrival.y, `${who} must arrive on the tile ${gate.targetWorldId} answers the crossing with`, { expected: `${arrival.x},${arrival.y} (its ${arrival.direction} gate)`, actual: describe(crossed) });
  return crossed;
}

define('wave-b-two-gates', async () => {
  const host = await actor('wave-b-host'), guest = await actor('wave-b-guest');
  // Two operators this scenario owns end to end: one human avatar each, plus the AI resident that
  // carries the saved purpose. No other scenario reads any of the three.
  const hostTicket = await ensureAccount(fixtures().admin, ACTORS['wave-b-host']);
  const guestTicket = await ensureAccount(fixtures().admin, ACTORS['wave-b-guest']);
  const resident = (ticket, body) => apiExpect(ticket, 'POST', '/agents', { color: '#397f79', symbol: '✦', capabilities: 'Walks the shared frontier in the browser acceptance run', limitations: 'No external tools and no real-world claims', ...body });
  const crosserOne = await resident(hostTicket, { kind: 'human', name: 'Crosser one', symbol: '◆' });
  const crosserTwo = await resident(guestTicket, { kind: 'human', name: 'Crosser two', symbol: '▲' });
  const crosserAide = await resident(hostTicket, { kind: 'agent', name: 'Crosser aide' });
  const firstGate = waveBGate(WAVE_B_FIRST, 'up'), secondGate = waveBGate(WAVE_B_SECOND, 'right');
  const firstAnswer = waveBArrival(WAVE_B_SECOND, WAVE_B_FIRST);
  let runtime = null, purpose = null, hostControls = null, guestControls = null, sharedPath = null, hostGrantId = null;
  const coinsBefore = count('SELECT COUNT(*) AS n FROM coin_rewards');

  await step('two new humans and one AI resident walk out of the Commons into the same frontier sector', async () => {
    const created = rows('SELECT id,kind,world_id,x,y FROM agents WHERE id IN (?,?,?)', crosserOne.id, crosserTwo.id, crosserAide.id);
    expect(created.length === 3 && created.every((item) => item.world_id === 'commons'), 'a newly created resident starts in the Commons', { expected: 'three residents in commons', actual: describe(created) });
    // Both humans walk the Commons passage and travel through it, each in its own browser.
    for (const [page, account, human] of [[host.page, ACTORS['wave-b-host'], crosserOne], [guest.page, ACTORS['wave-b-guest'], crosserTwo]]) {
      await openApp(page, account);
      await selectResidentAndSettle(page, human.id, human.name);
      await enterFrontierAs(page, human.id);
    }
    // The AI resident walks the same passage with its own runtime credential, which it keeps for the
    // rest of the scenario: that credential is what makes every later AI claim the AI's own action.
    runtime = await apiExpect(hostTicket, 'POST', '/runtime/start', { agent_id: crosserAide.id, minutes: 20, max_calls: 500, scopes: ['read', 'move', 'chat', 'build'] });
    await runtimeWalk(runtime, crosserAide.id, 'commons', COMMONS_FRONTIER_PASSAGE, 'the AI resident');
    await travelTo(runtime, crosserAide.id, WAVE_B_FIRST);

    for (const [who, human] of [['Crosser one', crosserOne], ['Crosser two', crosserTwo], ['Crosser aide', crosserAide]]) {
      const stored = residentAt(human.id);
      expect(stored.world_id === WAVE_B_FIRST, `${who} must stand in ${WAVE_B_FIRST}`, { expected: WAVE_B_FIRST, actual: describe(stored) });
      expect(stored.x === 24 && stored.y === 24, `${who} must arrive on the sector's own start tile`, { expected: '24,24', actual: describe(stored) });
      expect(stored.status === 'active', `${who} must still be an active resident`, { expected: 'active', actual: describe(stored.status) });
    }
    // The server wrote down who entered which world, so the arrival is the server's own record of a
    // travel and not merely a position that happens to look right.
    const entries = rows("SELECT actor,record_id FROM audit WHERE event='world.entered' ORDER BY seq");
    expect(entries.filter((entry) => entry.actor === hostTicket.account.id && entry.record_id === WAVE_B_FIRST).length >= 2, 'the host operator must have both its human entry and its AI entry in the audit trail', { expected: `two ${WAVE_B_FIRST} entries for ${hostTicket.account.id}`, actual: describe(entries) });
    expect(entries.some((entry) => entry.actor === guestTicket.account.id && entry.record_id === WAVE_B_FIRST), 'the guest operator must have its own entry in the audit trail', { expected: `${WAVE_B_FIRST} for ${guestTicket.account.id}`, actual: describe(entries) });
    // Both browsers hold a freshly read server payload for that one sector, with the party in it.
    for (const [page, human] of [[host.page, crosserOne], [guest.page, crosserTwo]]) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page);
      await openWorldAs(page, human.id);
    }
    for (const page of [host.page, guest.page]) await waitForClient(page, (world) => {
      const view = window.__nemoworld?.world?.();
      if (view?.world?.id !== world) return null;
      const kinds = view.participants.map((item) => item.kind);
      return kinds.filter((kind) => kind === 'human').length === 2 && kinds.includes('agent') ? true : null;
    }, WAVE_B_FIRST, 'both browsers to show two humans and one AI resident in the same frontier sector', 15_000);
    state.notes.push(`wave B entry: ${crosserOne.name} and ${crosserTwo.name} (two operators) and the AI resident ${crosserAide.name} walked the Commons passage at ${COMMONS_FRONTIER_PASSAGE.x},${COMMONS_FRONTIER_PASSAGE.y} into ${WAVE_B_FIRST}, arriving on 24,24 with one audit entry per operator`);
    return `three residents in ${WAVE_B_FIRST} at 24,24 (two human entries and one AI entry in the audit trail), visible from both browsers`;
  });

  await step('the operator records the AI resident’s chosen purpose and the resident reads it back', async () => {
    await selectResidentAndSettle(host.page, crosserAide.id, crosserAide.name);
    await openSectionNamed(host.page, 'Callings & guilds');
    const recorder = host.page.locator('#view form').filter({ has: host.page.getByRole('button', { name: 'Record a memory fact from your own input', exact: true }) });
    await recorder.locator('[name="kind"]').selectOption('purpose');
    await recorder.locator('[name="attribute"]').selectOption('intent');
    await recorder.locator('[name="value"]').fill(WAVE_B_PURPOSE);
    await recorder.getByRole('button', { name: 'Record a memory fact from your own input', exact: true }).click();
    const stored = await waitForCondition(async () => row("SELECT * FROM resident_memory WHERE agent_id=? AND kind='purpose' AND state='active'", crosserAide.id), 'the recorded purpose to be stored');
    expect(stored.value === WAVE_B_PURPOSE && stored.attribute === 'intent' && stored.origin === 'operator' && stored.source_kind === 'human' && stored.decided_by === hostTicket.account.id, 'the stored purpose must be this operator’s own recorded fact about its own resident', { expected: `${WAVE_B_PURPOSE} · purpose/intent · operator · human`, actual: describe({ value: stored.value, attribute: stored.attribute, origin: stored.origin, source: stored.source_kind, decided_by: stored.decided_by }) });
    purpose = stored;
    const own = await apiRequest('/memory', { token: runtime.token });
    expect(own.status === 200 && own.body.facts.some((fact) => fact.value === WAVE_B_PURPOSE), 'the AI resident must read its own approved purpose through its runtime credential', { expected: 'the recorded purpose in the resident’s own memory read', actual: `HTTP ${own.status} ${describe(own.body?.facts?.map((fact) => fact.value))}` });
    // Back to the human that crosses the gates; this control ends on the world view by itself.
    await selectResidentAndSettle(host.page, crosserOne.id, crosserOne.name);
    return `resident_memory ${stored.id} recorded by ${hostTicket.account.id} as purpose/intent, read back by the resident itself`;
  });

  await step('the host walks to the north gate and crosses it into the second sector', async () => {
    hostControls = await learnMovementControls(host.page, crosserOne.id);
    const walked = await walkResidentTo(host.page, crosserOne.id, firstGate.x, firstGate.y);
    expect(walked.world_id === WAVE_B_FIRST, 'the walk to the gate must stay in the sector it started in', { expected: WAVE_B_FIRST, actual: describe(walked) });
    const crossed = await browserCrossGate(host.page, crosserOne.id, hostControls, WAVE_B_FIRST, firstGate, 'Crosser one');
    await browserShows(host.page, WAVE_B_SECOND);
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered' AND record_id=? AND actor=?", WAVE_B_SECOND, hostTicket.account.id) === 1, 'the crossing must be the server’s own recorded entry of the new sector, exactly once', { actual: describe(rows("SELECT record_id FROM audit WHERE actor=? AND event='world.entered'", hostTicket.account.id)) });
    state.notes.push(`wave B gate 1 (browser): Crosser one walked to the up gate ${firstGate.x},${firstGate.y} in ${WAVE_B_FIRST} and crossed into ${WAVE_B_SECOND}, arriving on ${crossed.x},${crossed.y} — the tile that sector answers the crossing with`);
    return `${WAVE_B_FIRST} ${firstGate.x},${firstGate.y} → ${WAVE_B_SECOND} ${crossed.x},${crossed.y}; one world.entered audit row`;
  });

  await step('the guest crosses the same gate from the same tile', async () => {
    guestControls = await learnMovementControls(guest.page, crosserTwo.id);
    const walked = await walkResidentTo(guest.page, crosserTwo.id, firstGate.x, firstGate.y);
    expect(walked.world_id === WAVE_B_FIRST, 'the guest’s walk to the gate must stay in the sector it started in', { expected: WAVE_B_FIRST, actual: describe(walked) });
    const crossed = await browserCrossGate(guest.page, crosserTwo.id, guestControls, WAVE_B_FIRST, firstGate, 'Crosser two');
    await browserShows(guest.page, WAVE_B_SECOND);
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered' AND record_id=? AND actor=?", WAVE_B_SECOND, guestTicket.account.id) === 1, 'the guest’s crossing must be its own recorded entry of the new sector', { actual: describe(rows("SELECT record_id FROM audit WHERE actor=? AND event='world.entered'", guestTicket.account.id)) });
    return `${WAVE_B_FIRST} ${firstGate.x},${firstGate.y} → ${WAVE_B_SECOND} ${crossed.x},${crossed.y}, recorded against the second operator`;
  });

  await step('the AI resident crosses the same pair of gates with its runtime credential, both ways', async () => {
    await runtimeWalk(runtime, crosserAide.id, WAVE_B_FIRST, { x: firstGate.x, y: firstGate.y }, 'the AI resident');
    const forward = await runtimeCrossGate(runtime, crosserAide.id, 'up', WAVE_B_FIRST, firstGate, 'the AI resident');
    const back = await runtimeCrossGate(runtime, crosserAide.id, 'down', WAVE_B_SECOND, firstAnswer, 'the AI resident');
    expect(back.world_id === WAVE_B_FIRST && back.x === firstGate.x && back.y === firstGate.y, 'the two gates must be one connected passage: crossing back lands on the exact tile the resident left', { expected: `${firstGate.x},${firstGate.y} in ${WAVE_B_FIRST}`, actual: describe(back) });
    const again = await runtimeCrossGate(runtime, crosserAide.id, 'up', WAVE_B_FIRST, firstGate, 'the AI resident');
    expect(again.x === forward.x && again.y === forward.y, 'a repeated crossing must store the same arrival tile, so the landing is the server’s rule and not an accident', { expected: `${forward.x},${forward.y}`, actual: `${again.x},${again.y}` });
    const spent = scalar("SELECT MAX(used_calls) FROM tokens WHERE account_id=? AND agent_id=? AND kind='runtime'", hostTicket.account.id, crosserAide.id);
    expect(spent >= 30, 'the AI resident’s steps must be charged to its own runtime credential, not to a human session', { expected: 'at least 30 charged calls', actual: describe(spent) });
    state.notes.push(`wave B gate 1 (runtime): the AI resident crossed ${WAVE_B_FIRST} → ${WAVE_B_SECOND} (arriving ${forward.x},${forward.y}), back to ${WAVE_B_FIRST} ${back.x},${back.y}, and forward again to ${WAVE_B_SECOND} ${again.x},${again.y} — the same landing every time, on ${spent} charged runtime calls`);
    return `the AI resident crossed the connected pair three times through its own credential (${forward.x},${forward.y} · back to ${back.x},${back.y} · again to ${again.x},${again.y})`;
  });

  await step('the host crosses the second gate into the third sector', async () => {
    const walked = await walkResidentTo(host.page, crosserOne.id, secondGate.x, secondGate.y);
    expect(walked.world_id === WAVE_B_SECOND, 'the walk to the second gate must happen in the sector the first crossing reached', { expected: WAVE_B_SECOND, actual: describe(walked) });
    const crossed = await browserCrossGate(host.page, crosserOne.id, hostControls, WAVE_B_SECOND, secondGate, 'Crosser one');
    await browserShows(host.page, WAVE_B_THIRD);
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered' AND record_id=? AND actor=?", WAVE_B_THIRD, hostTicket.account.id) === 1, 'the second crossing must be its own recorded entry of the third sector', { actual: describe(rows("SELECT record_id FROM audit WHERE actor=? AND event='world.entered'", hostTicket.account.id)) });
    state.notes.push(`wave B gate 2 (browser): Crosser one walked to the right gate ${secondGate.x},${secondGate.y} in ${WAVE_B_SECOND} and crossed into ${WAVE_B_THIRD}, arriving on ${crossed.x},${crossed.y}`);
    return `${WAVE_B_SECOND} ${secondGate.x},${secondGate.y} → ${WAVE_B_THIRD} ${crossed.x},${crossed.y} after a ${walked.x},${walked.y} walk across the sector`;
  });

  await step('the guest crosses the second gate as well', async () => {
    const walked = await walkResidentTo(guest.page, crosserTwo.id, secondGate.x, secondGate.y);
    expect(walked.world_id === WAVE_B_SECOND, 'the guest’s walk to the second gate must happen in the second sector', { expected: WAVE_B_SECOND, actual: describe(walked) });
    const crossed = await browserCrossGate(guest.page, crosserTwo.id, guestControls, WAVE_B_SECOND, secondGate, 'Crosser two');
    await browserShows(guest.page, WAVE_B_THIRD);
    return `${WAVE_B_SECOND} ${secondGate.x},${secondGate.y} → ${WAVE_B_THIRD} ${crossed.x},${crossed.y}: both humans reached the third sector on foot`;
  });

  await step('the AI resident crosses the second gate with the same credential', async () => {
    await runtimeWalk(runtime, crosserAide.id, WAVE_B_SECOND, { x: secondGate.x, y: secondGate.y }, 'the AI resident');
    const crossed = await runtimeCrossGate(runtime, crosserAide.id, 'right', WAVE_B_SECOND, secondGate, 'the AI resident');
    return `the AI resident crossed ${WAVE_B_SECOND} → ${WAVE_B_THIRD} and stands on ${crossed.x},${crossed.y}, the tile that sector answers the crossing with`;
  });

  await step('the crossing partners talk in the sector they crossed into, and a third party cannot read it', async () => {
    // The guest's own browser sends the first line through the conversation card of the world its
    // resident now stands in, so the stored world is the sector the crossing reached.
    const form = guest.page.locator('#world-chat-card form');
    await form.locator('[name="channel"]').selectOption('private');
    await form.locator('[name="recipient_id"]').selectOption(crosserOne.id);
    await form.locator('[name="text"]').fill(WAVE_B_HUMAN_LINE);
    await form.getByRole('button', { name: 'Send message', exact: true }).click();
    const humanRow = await waitForCondition(async () => row('SELECT * FROM messages WHERE text=?', WAVE_B_HUMAN_LINE), 'the guest’s saved line');
    expect(humanRow.agent_id === crosserTwo.id && humanRow.account_id === guestTicket.account.id, 'the saved line must be attributed to the resident and the operator that wrote it', { expected: `agent ${crosserTwo.id} of ${guestTicket.account.id}`, actual: describe({ agent: humanRow.agent_id, account: humanRow.account_id }) });
    expect(humanRow.channel === 'private' && humanRow.world_id === WAVE_B_THIRD && humanRow.status === 'visible', 'the saved line must belong to the sector the party crossed into', { expected: `private in ${WAVE_B_THIRD}`, actual: describe({ channel: humanRow.channel, world: humanRow.world_id, status: humanRow.status }) });
    expect(JSON.stringify(JSON.parse(humanRow.recipients).sort()) === JSON.stringify([crosserOne.id, crosserTwo.id].sort()), 'the private line must name exactly its two crossing partners as recipients', { expected: describe([crosserOne.id, crosserTwo.id].sort()), actual: describe(humanRow.recipients) });
    // The AI resident answers through the credential it crossed with, so its line is its own.
    await apiExpect(runtime, 'POST', '/messages', { agent_id: crosserAide.id, channel: 'private', recipient_id: crosserOne.id, text: WAVE_B_AI_LINE }, [200]);
    const aiRow = await waitForCondition(async () => row('SELECT * FROM messages WHERE text=?', WAVE_B_AI_LINE), 'the AI resident’s saved line');
    expect(aiRow.agent_id === crosserAide.id && aiRow.account_id === hostTicket.account.id && aiRow.world_id === WAVE_B_THIRD && aiRow.channel === 'private', 'the AI line must be attributed to the AI resident in the sector it crossed into', { expected: `agent ${crosserAide.id} in ${WAVE_B_THIRD}`, actual: describe({ agent: aiRow.agent_id, account: aiRow.account_id, world: aiRow.world_id, channel: aiRow.channel }) });
    // The recipient reads both lines from its own browser and the server's own payload.
    await host.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(host.page);
    await openWorldAs(host.page, crosserOne.id);
    await waitForClient(host.page, (lines) => {
      const held = (window.__nemoworld?.world?.()?.messages || []).map((message) => message.text);
      return lines.every((line) => held.includes(line)) ? true : null;
    }, [WAVE_B_HUMAN_LINE, WAVE_B_AI_LINE], 'the recipient’s own browser to read both saved lines', 20_000);
    // A third operator that was never addressed reads the same sector and sees neither line.
    const outsider = await apiRequest(`/world?world_id=${encodeURIComponent(WAVE_B_THIRD)}`, { token: fixtures().stranger.token });
    expect(outsider.status === 200, 'a third operator must still be able to read the public sector', { expected: 'HTTP 200', actual: `HTTP ${outsider.status} ${outsider.raw}` });
    const seen = (outsider.body.messages || []).map((message) => message.text);
    expect(!seen.includes(WAVE_B_HUMAN_LINE) && !seen.includes(WAVE_B_AI_LINE), 'a third operator must read neither line of the private thread in that sector', { expected: 'neither saved line', actual: describe(seen) });
    const dbThread = rows('SELECT agent_id,account_id,channel,world_id FROM messages WHERE world_id=? ORDER BY created_at', WAVE_B_THIRD);
    expect(dbThread.length === 2 && dbThread.every((item) => item.channel === 'private' && item.world_id === WAVE_B_THIRD), 'both saved lines must be stored private in that sector', { actual: describe(dbThread) });
    state.notes.push(`wave B conversation: two private messages stored in ${WAVE_B_THIRD} (one from the human guest, one from the AI resident), read by the addressed operator and withheld from ${ACTORS.stranger.email} reading the same sector`);
    return `messages ${humanRow.id} (${crosserTwo.name}) and ${aiRow.id} (${crosserAide.name}) saved private in ${WAVE_B_THIRD}, readable by the recipient and withheld from a third operator`;
  });

  await step('each of the three residents chooses a calling, and the choice is a stored row', async () => {
    // The host's human chooses through the shipped calling card. The guest's human and the AI resident
    // are chosen by their own operators over the documented route: a calling is an operator's decision
    // for its own resident, never something a runtime credential picks for itself.
    await selectResidentAndSettle(host.page, crosserOne.id, crosserOne.name);
    await openSectionNamed(host.page, 'Callings & guilds');
    const card = host.page.locator(`#view .calling-choice[data-calling="${WAVE_B_CALLINGS.host}"]`);
    await card.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await card.getByRole('button', { name: /^Become/ }).click();
    await waitForCondition(async () => row('SELECT calling_id FROM resident_callings WHERE agent_id=?', crosserOne.id)?.calling_id === WAVE_B_CALLINGS.host ? true : null, 'Crosser one’s chosen calling to be stored');
    await apiExpect(guestTicket, 'POST', '/callings/select', { agent_id: crosserTwo.id, calling_id: WAVE_B_CALLINGS.guest });
    await apiExpect(hostTicket, 'POST', '/callings/select', { agent_id: crosserAide.id, calling_id: WAVE_B_CALLINGS.aide });
    const chosen = rows('SELECT agent_id,calling_id FROM resident_callings WHERE agent_id IN (?,?,?)', crosserOne.id, crosserTwo.id, crosserAide.id);
    expect(chosen.length === 3, 'each of the three residents must hold one stored calling', { expected: 'three resident_callings rows', actual: describe(chosen) });
    const byAgent = Object.fromEntries(chosen.map((entry) => [entry.agent_id, entry.calling_id]));
    expect(byAgent[crosserOne.id] === WAVE_B_CALLINGS.host && byAgent[crosserTwo.id] === WAVE_B_CALLINGS.guest && byAgent[crosserAide.id] === WAVE_B_CALLINGS.aide, 'every stored calling must be the one its own operator chose', { expected: describe(WAVE_B_CALLINGS), actual: describe(byAgent) });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='calling.selected' AND record_id IN (?,?,?)", crosserOne.id, crosserTwo.id, crosserAide.id) === 3, 'each choice must be the server’s own recorded event', { expected: 'three calling.selected rows', actual: describe(rows("SELECT record_id FROM audit WHERE event='calling.selected'")) });
    // The AI resident reads its own calling back through the credential it crossed with, not through a
    // human session: the calling is stored server-side and is not a claim the client makes.
    const own = await apiRequest(`/callings?agent_id=${encodeURIComponent(crosserAide.id)}`, { token: runtime.token });
    expect(own.status === 200 && own.body.calling.id === WAVE_B_CALLINGS.aide, 'the AI resident must read its own calling through its runtime credential', { expected: `HTTP 200 with the ${WAVE_B_CALLINGS.aide} calling`, actual: `HTTP ${own.status} ${describe(own.body?.calling?.id || own.body?.error)}` });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards') === coinsBefore, 'choosing a calling must mint no coin', { actual: 'the coin ledger changed' });
    state.notes.push(`wave B callings: ${crosserOne.name} chose ${WAVE_B_CALLINGS.host} through the calling card, ${crosserTwo.name} chose ${WAVE_B_CALLINGS.guest} and the AI resident ${crosserAide.name} chose ${WAVE_B_CALLINGS.aide} through the documented route; the AI resident read its own calling back on its runtime credential`);
    return `three stored callings (${WAVE_B_CALLINGS.host} · ${WAVE_B_CALLINGS.guest} · ${WAVE_B_CALLINGS.aide}), three calling.selected audit rows and no coin`;
  });

  await step('the party stewards one plot in the sector it crossed into and leaves one shared path standing', async () => {
    const arrival = waveBArrival(WAVE_B_THIRD, WAVE_B_SECOND);
    // Where to build is found, not assumed: the seeded frontier reserves the crossroads plots and any
    // water or dense-habitat plot, so the site comes from the shipped land registry and the published
    // world definition, and this search writes nothing at all.
    sharedPath = await waveBPathSite(hostTicket, WAVE_B_THIRD, arrival);
    await apiExpect(hostTicket, 'POST', '/land/assign', { plot_id: sharedPath.plot_id, purpose: 'The crossing party’s shared path', description: 'A disposable acceptance fixture: three residents that crossed two connected frontier gates lay one path in the sector they reached.' });
    const stewardship = await waitForCondition(async () => row('SELECT * FROM land_stewardships WHERE plot_id=?', sharedPath.plot_id) || null, 'the host’s stewardship to be stored');
    expect(stewardship.account_id === hostTicket.account.id, 'the plot must be stewarded by the operator that assigned it', { expected: hostTicket.account.id, actual: describe(stewardship) });
    // One narrow grant: this guest, this plot, path blocks on one layer of placement, for an hour.
    const grant = await apiExpect(hostTicket, 'POST', '/frontier/grant', { plot_id: sharedPath.plot_id, guest_agent_id: crosserTwo.id, purpose: 'Lay one path block with us', duration_minutes: 60, block_types: ['path'], layers: [0], actions: ['place'], max_blocks: 1 });
    hostGrantId = grant.grant.id;
    const stored = row('SELECT * FROM plot_grants WHERE id=?', hostGrantId);
    expect(stored.status === 'active' && stored.guest_account_id === guestTicket.account.id && stored.guest_agent_id === crosserTwo.id, 'the grant must be the narrow live collaboration access that was asked for', { expected: `an active path grant for ${crosserTwo.id}`, actual: describe({ status: stored.status, guest_account: stored.guest_account_id, guest_agent: stored.guest_agent_id, scope: stored.scope }) });
    expect(count('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', WAVE_B_THIRD) === 0, `${WAVE_B_THIRD} must hold no saved block before the party builds`, { actual: `${count('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', WAVE_B_THIRD)} blocks already saved` });
    // The party walks to the same staging tile, each in its own client or credential, one grid route at
    // a time. Building is only allowed within six tiles, so the walk is what makes the build possible.
    await openWorldAs(host.page, crosserOne.id);
    await walkResidentTo(host.page, crosserOne.id, sharedPath.stage.x, sharedPath.stage.y);
    await walkResidentTo(guest.page, crosserTwo.id, sharedPath.stage.x, sharedPath.stage.y);
    await runtimeWalk(runtime, crosserAide.id, WAVE_B_THIRD, sharedPath.stage, 'the AI resident');
    for (const [who, human] of [['Crosser one', crosserOne], ['Crosser two', crosserTwo], ['Crosser aide', crosserAide]]) {
      const standing = residentAt(human.id);
      expect(standing.world_id === WAVE_B_THIRD && standing.x === sharedPath.stage.x && standing.y === sharedPath.stage.y, `${who} must stand on the staging tile before the shared build`, { expected: `${sharedPath.stage.x},${sharedPath.stage.y} in ${WAVE_B_THIRD}`, actual: describe(standing) });
    }
    // The host human builds through the interface. The guest's contribution is the same documented
    // build route carrying the guest's own session, and the AI resident builds on the runtime credential
    // it crossed with. Three writes, three actors, two operators, one saved path.
    await waveBPlacePathThroughUi(host.page, WAVE_B_THIRD, sharedPath.blocks[0]);
    await apiExpect(guestTicket, 'POST', '/frontier/build', { agent_id: crosserTwo.id, world_id: WAVE_B_THIRD, x: sharedPath.blocks[1].x, y: sharedPath.blocks[1].y, z: 0, type: 'path' });
    await sleep(250);
    await apiExpect(runtime, 'POST', '/frontier/build', { world_id: WAVE_B_THIRD, x: sharedPath.blocks[2].x, y: sharedPath.blocks[2].y, z: 0, type: 'path' });
    const built = rows('SELECT x,y,z,type,creator_agent_id,creator_account_id,plot_id,grant_id FROM frontier_blocks WHERE world_id=? ORDER BY y,x', WAVE_B_THIRD);
    expect(built.length === 3, 'the party must leave exactly three saved blocks', { expected: 'three frontier_blocks rows', actual: describe(built) });
    expect(built.every((block) => block.type === 'path' && block.z === 0 && block.plot_id === sharedPath.plot_id), 'every saved block must be the path the party planned, inside the plot it stewarded', { expected: `three path blocks in ${sharedPath.plot_id}`, actual: describe(built) });
    expect(new Set(built.map((block) => block.creator_agent_id)).size === 3, 'each resident must be attributed for its own block', { expected: 'three distinct builder residents', actual: describe(built.map((block) => block.creator_agent_id)) });
    expect(new Set(built.map((block) => block.creator_account_id)).size === 2, 'the two humans must be attributed to two operators, and the AI resident to its own', { expected: 'two operator accounts', actual: describe(built.map((block) => block.creator_account_id)) });
    expect(built.find((block) => block.creator_agent_id === crosserTwo.id).grant_id === hostGrantId, 'the guest block must name the live collaboration grant that allowed it', { actual: describe(built.find((block) => block.creator_agent_id === crosserTwo.id)) });
    for (const [page, who] of [[host.page, 'the host'], [guest.page, 'the guest']]) {
      await waitForClient(page, (plot) => {
        const blocks = window.__nemoworld?.world?.()?.blocks || [];
        return blocks.filter((block) => block.plot_id === plot).length === 3 ? true : null;
      }, sharedPath.plot_id, `${who} browser to receive all three saved path blocks`, 20_000);
    }
    // The two callings whose own objectives describe this work must recognise the saved actions, and
    // neither a calling receipt nor a shared build is a coin: the ledger is compared, not assumed.
    const builder = await apiExpect(hostTicket, 'GET', `/callings?agent_id=${encodeURIComponent(crosserOne.id)}`);
    expect(builder.receipts.some((receipt) => receipt.objective_id === `${WAVE_B_CALLINGS.host}.frontier_place`), 'the builder’s own saved placement must be recognised by its chosen calling', { expected: `a ${WAVE_B_CALLINGS.host}.frontier_place receipt`, actual: describe(builder.receipts.map((receipt) => receipt.objective_id)) });
    const steward = await apiExpect(hostTicket, 'GET', `/callings?agent_id=${encodeURIComponent(crosserAide.id)}`);
    expect(steward.receipts.some((receipt) => receipt.objective_id === `${WAVE_B_CALLINGS.aide}.path_place`), 'the steward resident’s own saved path must be recognised by its chosen calling', { expected: `a ${WAVE_B_CALLINGS.aide}.path_place receipt`, actual: describe(steward.receipts.map((receipt) => receipt.objective_id)) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards') === coinsBefore, 'one shared saved path must mint no coin', { actual: 'the coin ledger changed' });
    state.notes.push(`wave B world change: ${sharedPath.plot_id} stewarded by the host for a stated purpose, three path blocks saved at ${sharedPath.blocks.map((block) => `${block.x},${block.y}`).join(' · ')} by three residents from two operators (the guest block under grant ${hostGrantId}), visible in both browsers, recognised by the ${WAVE_B_CALLINGS.host} and ${WAVE_B_CALLINGS.aide} callings, no coin minted`);
    return `three attributed path blocks saved in ${sharedPath.plot_id} (${sharedPath.blocks.map((block) => `${block.x},${block.y}`).join(' · ')}), staged from ${sharedPath.stage.x},${sharedPath.stage.y} after a ${sharedPath.reach}-step walk, one of them under grant ${hostGrantId}`;
  });

  await step('the party leaves and returns: a real restart keeps the same sector, purpose and shared path', async () => {
    const place = () => Object.fromEntries([crosserOne, crosserTwo, crosserAide].map((human) => [human.id, residentAt(human.id)]));
    const before = place();
    const purposeBefore = row('SELECT * FROM resident_memory WHERE id=?', purpose.id);
    const pathBefore = rows('SELECT x,y,z,type,creator_agent_id,creator_account_id,plot_id,grant_id FROM frontier_blocks WHERE world_id=? ORDER BY y,x', WAVE_B_THIRD);
    const callingsBefore = rows('SELECT agent_id,calling_id,selected_at FROM resident_callings WHERE agent_id IN (?,?,?) ORDER BY agent_id', crosserOne.id, crosserTwo.id, crosserAide.id);
    const landBefore = row('SELECT plot_id,account_id,purpose,assigned_at FROM land_stewardships WHERE plot_id=?', sharedPath.plot_id);
    expect(pathBefore.length === 3 && callingsBefore.length === 3 && landBefore, 'the world change, the callings and the stewardship must all exist before the restart', { expected: 'three blocks, three callings, one stewardship', actual: describe({ blocks: pathBefore.length, callings: callingsBefore.length, land: Boolean(landBefore) }) });
    await stopServer();
    await startServer();
    expect(describe(place()) === describe(before), 'a restart against the same database must not move any of the three residents', { expected: describe(before), actual: describe(place()) });
    for (const [who, human] of [['Crosser one', crosserOne], ['Crosser two', crosserTwo], ['Crosser aide', crosserAide]]) {
      const stored = residentAt(human.id);
      expect(stored.world_id === WAVE_B_THIRD, `${who} must still stand in the sector it crossed into`, { expected: WAVE_B_THIRD, actual: describe(stored) });
      expect(stored.x === sharedPath.stage.x && stored.y === sharedPath.stage.y, `${who} must still stand on the staging tile it walked to`, { expected: `${sharedPath.stage.x},${sharedPath.stage.y}`, actual: `${stored.x},${stored.y}` });
    }
    const purposeAfter = row('SELECT * FROM resident_memory WHERE id=?', purpose.id);
    expect(describe(purposeAfter) === describe(purposeBefore), 'the purpose-bearing record the resident crossed for must be unchanged by the restart', { expected: describe(purposeBefore), actual: describe(purposeAfter) });
    const own = await apiRequest('/memory', { token: runtime.token });
    expect(own.status === 200 && own.body.facts.some((fact) => fact.value === WAVE_B_PURPOSE), 'the AI resident must still read its own purpose through the same credential after the restart', { expected: WAVE_B_PURPOSE, actual: `HTTP ${own.status} ${describe(own.body?.error || own.body?.facts?.map((fact) => fact.value))}` });
    // The shared path, the callings that recognised it and the stewardship that allowed it are read
    // back from storage after the restart: a restart must not rewrite, duplicate or lose any of them.
    const pathAfter = rows('SELECT x,y,z,type,creator_agent_id,creator_account_id,plot_id,grant_id FROM frontier_blocks WHERE world_id=? ORDER BY y,x', WAVE_B_THIRD);
    expect(describe(pathAfter) === describe(pathBefore), 'the three saved path blocks must survive the restart byte-for-byte', { expected: describe(pathBefore), actual: describe(pathAfter) });
    const callingsAfter = rows('SELECT agent_id,calling_id,selected_at FROM resident_callings WHERE agent_id IN (?,?,?) ORDER BY agent_id', crosserOne.id, crosserTwo.id, crosserAide.id);
    expect(describe(callingsAfter) === describe(callingsBefore), 'the three chosen callings must survive the restart unchanged', { expected: describe(callingsBefore), actual: describe(callingsAfter) });
    const landAfter = row('SELECT plot_id,account_id,purpose,assigned_at FROM land_stewardships WHERE plot_id=?', sharedPath.plot_id);
    expect(describe(landAfter) === describe(landBefore), 'the plot’s stewardship must survive the restart unchanged', { expected: describe(landBefore), actual: describe(landAfter) });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards') === coinsBefore, 'the restart must mint nothing', { actual: 'the coin ledger changed' });
    for (const [page, account, human] of [[host.page, ACTORS['wave-b-host'], crosserOne], [guest.page, ACTORS['wave-b-guest'], crosserTwo]]) {
      await openApp(page, account);
      await openWorldAs(page, human.id);
      await browserShows(page, WAVE_B_THIRD);
      await waitForClient(page, (plot) => {
        const blocks = window.__nemoworld?.world?.()?.blocks || [];
        return blocks.filter((block) => block.plot_id === plot).length === 3 ? true : null;
      }, sharedPath.plot_id, 'the restarted browser to reload the shared path it built', 20_000);
    }
    const kept = rows('SELECT agent_id,text FROM messages WHERE world_id=? ORDER BY created_at', WAVE_B_THIRD);
    expect(kept.length === 2, 'the sector’s saved conversation must still be there after the restart', { expected: 'both saved lines', actual: describe(kept) });
    state.notes.push(`wave B restart: ${WAVE_B_THIRD} ${sharedPath.stage.x},${sharedPath.stage.y} held by all three residents, resident_memory ${purpose.id} and ${sharedPath.plot_id} (three path blocks, ${hostGrantId}) byte-for-byte unchanged, both saved lines still addressable, both browsers back in the same sector with the path they built`);
    return `after a real restart: three residents still on ${sharedPath.stage.x},${sharedPath.stage.y} in ${WAVE_B_THIRD}, the purpose fact, the three callings, the stewardship and all three path blocks unchanged, both browsers showing that sector and that path`;
  });

  await step('the party leaves a desktop and a phone picture of the world it built', async () => {
    // The window the world is actually shown in. Both files are checked for real bytes, so a blank or
    // missing capture fails the scenario instead of being saved as decoration.
    const dir = join(RESULTS, 'wave-b-two-gates');
    await mkdir(dir, { recursive: true });
    const desktop = join(dir, 'desktop.png'), phone = join(dir, 'phone.png');
    await host.page.screenshot({ path: desktop });
    await guest.page.setViewportSize({ width: 390, height: 844 });
    await guest.page.waitForTimeout(600);
    await guest.page.screenshot({ path: phone });
    const width = await guest.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(width.document <= width.viewport, 'the world view must fit a 390 px phone without horizontal scrolling', { expected: `a document ${width.viewport} px wide or narrower`, actual: `${width.document} px in a ${width.viewport} px viewport` });
    await guest.page.setViewportSize({ width: 1280, height: 800 });
    for (const [name, file] of [['desktop', desktop], ['phone', phone]]) {
      const bytes = existsSync(file) ? statSync(file).size : 0;
      expect(bytes > 10_000, `the ${name} capture must be a real picture of the rendered world`, { expected: 'a PNG larger than 10,000 bytes', actual: `${bytes} bytes at ${file}` });
    }
    state.notes.push(`wave B pictures: test-results/wave-b-two-gates/desktop.png (${statSync(desktop).size} bytes) and phone.png at 390 px (${statSync(phone).size} bytes, document ${width.document} px wide)`);
    return `desktop.png and phone.png saved from the world the party returned to, 390 px document width ${width.document} px`;
  });

  return `two independent humans and one active AI resident entered ${WAVE_B_FIRST} through the Commons, crossed the connected ${firstGate.direction} and ${secondGate.direction} gates into ${WAVE_B_SECOND} and ${WAVE_B_THIRD} with every crossing read back from the stored world and arrival tile, talked in saved attributed text, chose one calling each, stewarded a plot in the sector they reached and left three attributed path blocks standing there under one narrow collaboration grant, and returned after a restart to the same sector, the same recorded purpose and the same saved path`;
});

/**
 * The free personal space every account's resident already owns, played as a closed loop: sign up,
 * create a character, walk into the space, build an object by pointing at it, settle the service into
 * Karma Coins, buy a good in the shop, and restart. Every claim below is read back from the temporary
 * database or the server's own payload, and the scenario leaves no shared fixture behind.
 */
define('karma-closed-loop', async () => {
  const player = await context('karma-loop');
  const page = player.page;
  const EMAIL = 'tester.karma-loop@browser.test';
  const NAME = 'Karma loop tester';
  const RESIDENT = 'Loop resident';
  let account = null, resident = null, garden = null, cottage = null, placed = null;
  const coinsBefore = count('SELECT COUNT(*) AS n FROM coin_rewards');
  const parcelsBefore = count('SELECT COUNT(*) AS n FROM land_parcels');
  const stewardshipsBefore = count('SELECT COUNT(*) AS n FROM land_stewardships');
  /** The world door, tried a bounded number of times: the ship writes its own game mode asynchronously,
   *  which can race the entry helper's reload, so every attempt is the real documented door. */
  const enterTheWorld = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await enterWorldAs(page, resident.id, RESIDENT); return true; }
      catch { await page.waitForTimeout(600); }
    }
    return false;
  };

  await step('a brand-new operator signs up and creates its first resident through the interface', async () => {
    await page.goto(baseUrl(), { waitUntil: 'domcontentloaded' });
    await settle(page);
    await signUp(page, { name: NAME, email: EMAIL, password: PASSWORD });
    account = row('SELECT id,name,role FROM accounts WHERE email=?', EMAIL);
    expect(account && account.role === 'member', 'the dialog must create a disposable member account', { expected: 'a stored member account', actual: describe(account) });
    expect(count('SELECT COUNT(*) AS n FROM agents WHERE operator_id=?', account.id) === 0, 'the new operator must start with no resident', { actual: `${count('SELECT COUNT(*) AS n FROM agents WHERE operator_id=?', account.id)} residents` });
    resident = await createResidentThroughInterface(page, RESIDENT);
    garden = `home:${resident.id}`;
    cottage = `house:${resident.id}`;
    expect(resident.status === 'active', 'the created character must be an active resident', { actual: describe(resident) });
    // Creating a character leaves the app on the characters section, so the world door is the entry
    // screen's own Continue.
    expect(await enterTheWorld(), 'the new resident must be able to enter the world from the entry screen', { expected: 'the world open as the resident', actual: describe(await entryState(page)) });
    state.notes.push(`karma loop: ${EMAIL} signed up through the dialog and created ${RESIDENT} (${resident.kind} ${resident.id}) through the character overlay`);
    return `account ${account.id} with one ${resident.kind} resident ${resident.id}`;
  });

  await step('the new resident already owns a personal space the server lets it build in', async () => {
    const worlds = rows('SELECT id,kind,visibility,owner_agent_id FROM worlds WHERE id IN (?,?) ORDER BY id', garden, cottage);
    expect(worlds.length === 2, 'every resident must already own a personal garden and a cottage', { expected: `rows for ${garden} and ${cottage}`, actual: describe(worlds) });
    expect(worlds.every((world) => world.owner_agent_id === resident.id), 'both spaces must belong to the new resident', { actual: describe(worlds) });
    expect(worlds.find((world) => world.id === garden).kind === 'home', 'the garden must be the home kind the build rules recognise', { actual: describe(worlds.map((world) => world.kind)) });
    // The space is complimentary: it is not a land parcel, it costs nothing, and it changes no registry.
    expect(count('SELECT COUNT(*) AS n FROM land_parcels') === parcelsBefore, 'a personal space must not add a land parcel', { actual: `${count('SELECT COUNT(*) AS n FROM land_parcels')} parcels` });
    expect(count('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id=?', account.id) === 0, 'a personal space must not need a stewarded plot', { actual: 'a stewardship appeared' });
    // And the server itself says this resident may build here, with the palette it will accept.
    const view = await inPage(page, `/world?world_id=${encodeURIComponent(garden)}&agent_id=${encodeURIComponent(resident.id)}`, { method: 'GET' });
    expect(view.status === 200 && view.body.world?.kind === 'home', 'the personal space must be readable by its owner', { expected: 'HTTP 200 for a home world', actual: `HTTP ${view.status} ${describe(view.body?.world?.kind)}` });
    expect(Array.isArray(view.body.build_palette) && view.body.build_palette.includes('bench'), 'the server must publish a buildable object palette for the garden', { actual: describe(view.body.build_palette) });
    return `garden ${garden} and cottage ${cottage} owned by ${resident.id}; ${view.body.build_palette.length} buildable object kinds, no parcel and no stewardship`;
  });

  await step('the resident walks into its own space and Build opens the palette there', async () => {
    // Through the interface the player uses: the world tools drawer names the space and travels there.
    await openGameTab(page, 'Open world');
    if (!await page.evaluate(() => document.body.classList.contains('game-tools-open'))) {
      await page.locator('#game-hud').getByRole('button', { name: 'More', exact: true }).click();
    }
    const space = page.locator('#world-my-space-card');
    await space.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await space.getByRole('button', { name: 'Go to my space', exact: true }).click();
    await browserShows(page, garden);
    expect(count('SELECT COUNT(*) AS n FROM journey_visits WHERE agent_id=? AND world_id=?', resident.id, garden) >= 1, 'walking in must be recorded as the visit the server wrote', { actual: 'no visit row' });
    // Home returns to the playable scene after confirmed travel. The drawer must
    // close as part of that action, so there is no second dismissal to perform.
    await page.waitForFunction(() => !document.body.classList.contains('game-tools-open'), null, { timeout: PAGE_TIMEOUT_MS });
    await page.getByRole('button', { name: 'Close world tools', exact: true }).waitFor({state:'hidden',timeout:PAGE_TIMEOUT_MS});
    await page.locator('#game-build-button').click();
    await page.waitForFunction(() => document.body.classList.contains('game-building'), null, { timeout: PAGE_TIMEOUT_MS });
    const host = page.locator('#game-build-host');
    await host.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    expect(await host.locator('section.ui-hotbar').count() === 1 && await host.locator('section.ui-placement').count() === 1, 'the garden must mount the same hotbar and placement preview the frontier uses', { actual: `${await host.locator('section').count()} sections` });
    const bench = host.locator('[data-build-type="bench"]');
    await bench.waitFor({ state: 'visible' });
    state.notes.push(`karma loop: the world tools drawer carried the resident into ${garden}, and the HUD's Build action opened a ${await host.locator('[data-build-type]').count()}-item object palette and one placement preview`);
    return `resident in ${garden} with a ${await host.locator('[data-build-type]').count()}-item object palette and one placement preview, opened by the HUD's own Build action`;
  });

  await step('the resident builds an object by choosing it and naming the tile, and the server saves it', async () => {
    const site = await gardenFarmTile(page, resident.id);
    expect(site, 'the garden must offer a free walkable tile to build on', { actual: 'no free tile in the published window' });
    const host = page.locator('#game-build-host');
    await host.locator('[data-build-type="bench"]').click();
    const preview = host.locator('section.ui-placement');
    const fieldsX = preview.locator('input[name="x"]');
    const fieldsY = preview.locator('input[name="y"]');
    await fieldsX.fill(String(site.x));
    await fieldsY.fill(String(site.y));
    await preview.getByRole('button', { name: 'Ask the server to place the selected object at this tile', exact: true }).click();
    placed = await waitForCondition(async () => row('SELECT type,x,y FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, site.x, site.y), 'the pointed placement to be saved', { timeout: 30_000 });
    expect(placed.type === 'bench', 'the saved object must be the one the palette had chosen', { expected: 'bench', actual: describe(placed.type) });
    // The same tile is one object, never two: the storage key is the tile, so a repeat either answers
    // with that same tile or refuses, and the garden still holds exactly one object.
    const repeat = await inPage(page, `/agents/${resident.id}/build`, { body: { type: 'bench', x: site.x, y: site.y } });
    expect([200, 201, 409].includes(repeat.status), 'asking for the same object on the same tile is that one tile again, never a duplicate', { actual: `HTTP ${repeat.status} ${describe(repeat.body)}` });
    expect(count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden) === 1, 'the garden must hold exactly the one object that was placed', { actual: `${count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden)} objects` });
    state.notes.push(`karma loop: a repeat placement on ${site.x},${site.y} answered HTTP ${repeat.status} and the garden still held one world_objects row`);
    // And a real refusal builds nothing: an object cannot stand on the tile the resident itself occupies.
    const standing = row('SELECT x,y FROM agents WHERE id=?', resident.id);
    const refused = await inPage(page, `/agents/${resident.id}/build`, { body: { type: 'bench', x: standing.x, y: standing.y } });
    expect(refused.status === 409, 'placing an object on top of the resident must be refused', { expected: 'HTTP 409', actual: `HTTP ${refused.status} ${describe(refused.body)}` });
    expect(count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden) === 1, 'a refused placement must leave the garden exactly as it was', { actual: `${count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden)} objects` });
    state.notes.push(`karma loop: the garden hotbar chose bench and the placement preview saved it at ${site.x},${site.y} - one world_objects row; a repeat on the same tile stayed one object and a placement on the resident was refused 409`);
    return `world_objects ${placed.type} saved at ${site.x},${site.y} through the garden's own hotbar and preview; the tile stays one object and an occupied tile is refused`;
  });

  await step('the saved service settles into Karma Coins, and the shop spends them once', async () => {
    // Three more saved acts, so the purse reaches the cheapest price. A second object goes in through
    // the same garden preview, and two crop patches are planted through the shipped garden action.
    // Every one of them is a row the server writes for work actually done, and nothing is credited for
    // a claim: the faucet reads those rows and nothing else.
    const host = page.locator('#game-build-host');
    const second = await gardenFarmTile(page, resident.id);
    expect(second, 'the garden must offer a second free tile to build on', { actual: 'no free tile in the published window' });
    await host.locator('[data-build-type="lantern"]').click();
    const preview = page.locator('#game-build-host section.ui-placement');
    await preview.locator('input[name="x"]').fill(String(second.x));
    await preview.locator('input[name="y"]').fill(String(second.y));
    await preview.getByRole('button', { name: 'Ask the server to place the selected object at this tile', exact: true }).click();
    await waitForCondition(async () => count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden) === 2 ? true : null, 'the second garden object to be saved', { timeout: 30_000 });
    for (const kind of ['herbs', 'fiber']) {
      const tile = await gardenFarmTile(page, resident.id);
      expect(tile, `the garden must offer a patch tile for ${kind}`, { actual: 'no free tile in the published window' });
      const patch = await inPage(page, `/agents/${resident.id}/build`, { body: { type: 'farm', x: tile.x, y: tile.y } });
      expect([200, 201].includes(patch.status), `the crop patch for ${kind} must be saved`, { expected: 'HTTP 200 or 201', actual: `HTTP ${patch.status} ${describe(patch.body)}` });
      const planted = await inPage(page, '/journey/garden', { body: { agent_id: resident.id, action: 'plant', kind, x: tile.x, y: tile.y } });
      expect(planted.status === 200, `planting ${kind} must be saved by the garden action`, { expected: 'HTTP 200', actual: `HTTP ${planted.status} ${describe(planted.body)}` });
    }
    await openGameTab(page, 'Karma & shop');
    const panel = page.locator('#shop-panel-host');
    await panel.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    // Opening the section settles: the one earning action, and the server decides the amount.
    const wallet = await waitForCondition(async () => {
      const text = (await panel.textContent()) || '';
      const match = /Karma Coins:\s*(\d+)/.exec(text);
      return match ? Number(match[1]) : null;
    }, 'the shop panel to state the settled purse', { timeout: 30_000 });
    expect(wallet >= 8, 'two saved objects and two planted crops must settle into at least the cheapest price', { expected: 'at least 8 Karma Coins', actual: String(wallet) });
    expect(count('SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=?', resident.id) >= 4, 'settling must record one receipt per saved act the server wrote', { actual: `${count('SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=?', resident.id)} receipts` });
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards') === coinsBefore, 'settling Karma must mint no NemoCoin', { actual: 'the NemoCoin ledger changed' });
    // Buy the cheapest good through the panel: choose, then confirm. The first click buys nothing.
    const good = panel.locator('[data-buy]').first();
    const goodId = await good.getAttribute('data-buy');
    await good.click();
    const confirm = panel.locator(`[data-confirm-buy="${goodId}"]`);
    await confirm.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await confirm.click();
    const purchase = await waitForCondition(async () => row('SELECT * FROM shop_purchases WHERE account_id=?', account.id), 'the recorded purchase', { timeout: 30_000 });
    expect(purchase.good_id === goodId, 'the recorded purchase must name the good the panel confirmed', { expected: goodId, actual: describe(purchase.good_id) });
    const granted = JSON.parse(purchase.granted);
    expect(granted.kind === 'herbs' && granted.quantity === 2, 'the cheapest good must grant the sealed herbs it advertises', { expected: '2 herbs', actual: describe(granted) });
    expect(count('SELECT quantity AS n FROM journey_inventory WHERE agent_id=? AND kind=?', resident.id, 'herbs') === 2, 'the bought resource must land on the resident shelf', { actual: 'the shelf does not hold the bought resource' });
    expect(count('SELECT COUNT(*) AS n FROM karma_purchases WHERE account_id=?', account.id) === 1, 'one purchase must record exactly one debit', { actual: `${count('SELECT COUNT(*) AS n FROM karma_purchases WHERE account_id=?', account.id)} debits` });
    // The good is usable, not just recorded: the resident's own journey read now offers the bought
    // resource on its shelf and counts it toward the recipes that need it.
    const journey = await inPage(page, `/journey?agent_id=${encodeURIComponent(resident.id)}`, { method: 'GET' });
    const shelf = (journey.body.inventory || []).find((item) => item.kind === 'herbs');
    expect(shelf?.quantity === 2, 'the bought resource must be on the shelf the journey read returns', { expected: 'two herbs', actual: describe(journey.body.inventory) });
    const recipe = (journey.body.recipes || []).find((entry) => Object.keys(entry.ingredients || {}).includes('herbs'));
    expect(recipe, 'a recipe the shelf can serve must name the bought resource as an ingredient', { actual: describe((journey.body.recipes || []).map((entry) => entry.id)) });
    expect(Number(recipe.ingredients.herbs) <= 2, 'the bought quantity must be enough for at least one recipe that uses it', { expected: 'an ingredient cost of at most 2 herbs', actual: describe(recipe.ingredients) });
    state.notes.push(`karma loop: settled ${wallet} Karma Coins from one saved garden object, then bought ${goodId} (${purchase.price}) with key ${purchase.key} - one debit, two herbs on the shelf, no NemoCoin`);
    return `purse ${wallet} Karma Coins, one purchase of ${goodId} for ${purchase.price}, ${granted.quantity} ${granted.kind} granted`;
  });

  await step('a real restart keeps the space, the object, the shelf and the purse', async () => {
    const spaceBefore = rows('SELECT type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x', garden);
    const shelfBefore = rows('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? ORDER BY kind', resident.id);
    const karmaBefore = rows('SELECT id,service_id,amount FROM karma_receipts WHERE account_id=? ORDER BY seq', account.id);
    const purchasesBefore = rows('SELECT id,good_id,amount FROM karma_purchases WHERE account_id=? ORDER BY seq', account.id);
    await stopServer();
    await startServer();
    expect(describe(rows('SELECT type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x', garden)) === describe(spaceBefore), 'the built object must survive the restart byte-for-byte', { expected: describe(spaceBefore), actual: describe(rows('SELECT type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x', garden)) });
    expect(describe(rows('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? ORDER BY kind', resident.id)) === describe(shelfBefore), 'the bought resource must survive the restart', { expected: describe(shelfBefore), actual: describe(rows('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? ORDER BY kind', resident.id)) });
    expect(describe(rows('SELECT id,service_id,amount FROM karma_receipts WHERE account_id=? ORDER BY seq', account.id)) === describe(karmaBefore), 'the karma receipts must survive the restart', { expected: describe(karmaBefore), actual: 'the receipts changed' });
    expect(describe(rows('SELECT id,good_id,amount FROM karma_purchases WHERE account_id=? ORDER BY seq', account.id)) === describe(purchasesBefore), 'the purchase must survive the restart', { expected: describe(purchasesBefore), actual: 'the purchase changed' });
    // Both browsers, both currencies and the land registry are exactly as they were.
    expect(count('SELECT COUNT(*) AS n FROM coin_rewards') === coinsBefore, 'the restart must mint no NemoCoin', { actual: 'the NemoCoin ledger changed' });
    expect(count('SELECT COUNT(*) AS n FROM land_parcels') === parcelsBefore && count('SELECT COUNT(*) AS n FROM land_stewardships') === stewardshipsBefore, 'the finite land registry must be untouched by the whole loop', { actual: 'the land registry changed' });
    await page.goto(baseUrl(), { waitUntil: 'domcontentloaded' });
    await settle(page);
    expect(await enterTheWorld(), 'the resident must be able to return to its world after the restart', { expected: 'the world open as the resident', actual: describe(await entryState(page)) });
    await browserShows(page, garden);
    await openGameTab(page, 'Karma & shop');
    const panel = page.locator('#shop-panel-host');
    await panel.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await waitForCondition(async () => /Karma Coins:\s*\d+/.test((await panel.textContent()) || '') ? true : null, 'the restarted panel to state the purse again');
    state.notes.push(`karma loop restart: ${garden} still holds ${spaceBefore.length} object, the shelf still holds ${shelfBefore.length} kind, the ledger still holds ${karmaBefore.length} receipt and ${purchasesBefore.length} purchase, with no NemoCoin and no land touched`);
    return `after a real restart: the garden, the object, the shelf, ${karmaBefore.length} karma receipt and the purchase are unchanged, and the panel states the purse again`;
  });

  await step('Home opens the cottage through its real garden doorway from the Commons',async()=>{
    const returned=await inPage(page,`/agents/${resident.id}/travel`,{body:{world_id:'commons'}});
    expect(returned.status===200,'the cottage check starts in the Commons',{actual:describe(returned)});
    await page.reload({waitUntil:'domcontentloaded'});await settle(page);
    expect(await enterTheWorld(),'the saved resident re-enters the Commons');
    await openGameTab(page,'Open world');
    if(!await page.evaluate(()=>document.body.classList.contains('game-tools-open')))await page.locator('#game-hud').getByRole('button',{name:'More',exact:true}).click();
    await page.locator('#world-my-space-card').getByRole('button',{name:'Open my cottage',exact:true}).click();
    await browserShows(page,cottage);
    expect(row('SELECT world_id FROM agents WHERE id=?',resident.id)?.world_id===cottage,'the cottage arrival must be stored by the server');
    expect(count('SELECT COUNT(*) FROM journey_visits WHERE agent_id=? AND world_id=?',resident.id,cottage)>=1,'the physical cottage entry must leave a saved visit');
    await page.getByRole('button',{name:'Close world tools',exact:true}).waitFor({state:'hidden',timeout:PAGE_TIMEOUT_MS});
    return 'one Home action travelled to the garden, walked to its real door and saved entry into the cottage; the playable scene resumed';
  });

  await step('the same purse and shop work on a phone with reduced motion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    // Repaint the section under the new viewport and preference: a reload gives the phone a clean
    // shell (no desktop drawer left open), and the world door is the same Continue every player uses.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    expect(await enterTheWorld(), 'the resident must be able to enter its world on a phone', { expected: 'the world open as the resident', actual: describe(await entryState(page)) });
    await openGameTab(page, 'Karma & shop');
    await settle(page);
    const panel = page.locator('#shop-panel-host');
    await panel.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const measured = await panel.evaluate((host) => {
      const root = host.firstElementChild || host;
      const buy = root.querySelector('.ui-shop-buy, .ui-shop-confirm-button');
      const styles = getComputedStyle(root);
      return {
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        target: buy ? Math.round(buy.getBoundingClientRect().height) : 0,
        reduced_class: String(root.className).includes('ui-shop-reduced'),
        transition: styles.transitionDuration,
      };
    });
    expect(measured.document <= measured.viewport, 'the shop must fit a 390 px phone without horizontal scrolling', { expected: `a document ${measured.viewport} px wide or narrower`, actual: `${measured.document} px in a ${measured.viewport} px viewport` });
    expect(measured.target >= 44, 'every shop button must meet the 44 px touch floor', { expected: 'at least 44 px', actual: `${measured.target} px` });
    expect(measured.reduced_class && /^0s/.test(measured.transition), 'the panel must drop its transitions when the reader asks for less motion', { expected: 'the reduced class and no transition', actual: describe({ reduced_class: measured.reduced_class, transition: measured.transition }) });
    await page.emulateMedia({ reducedMotion: null });
    await page.setViewportSize({ width: 1280, height: 800 });
    state.notes.push(`karma loop phone: at 390 px the shop document was ${measured.document} px wide in a ${measured.viewport} px viewport, its buy control measured ${measured.target} px tall, and reduced motion removed the transition`);
    return `390 px: no horizontal scroll (${measured.document} ≤ ${measured.viewport}), a ${measured.target} px buy control and no transition under reduced motion`;
  });

  return `a brand-new account signed up, created one resident, received the personal garden and cottage that come with it, built a bench there through the garden's own hotbar and placement preview, settled one saved service into Karma Coins, bought the cheapest shop good and kept the shelf, the purse and the space through a real restart - with no NemoCoin minted and no land parcel or stewardship touched`;
});

/** One crossing of the shared seam through the browser, from the edge tile the fixture left it on. */
async function browserCrossSeam(page, agentId, controlFor, who) {
  const standing = residentAt(agentId);
  expect(standing.world_id === SHARED_SEAM.anchor && standing.x === SHARED_SEAM.stand.x && standing.y === SHARED_SEAM.stand.y, `${who} must stand on the edge tile before crossing`, { expected: `${SHARED_SEAM.stand.x},${SHARED_SEAM.stand.y} in ${SHARED_SEAM.anchor}`, actual: describe(standing) });
  const crossed = await pressMoveUntil(page, agentId, controlFor.up, () => { const now = residentAt(agentId); return now.world_id === SHARED_SEAM.neighbour ? now : null; }, `${who} to walk across the seam into ${SHARED_SEAM.neighbour}`);
  expect(crossed.x === SHARED_SEAM.landing.x && crossed.y === SHARED_SEAM.landing.y, `${who} must be stored in the neighbour's own coordinates for the tile above the seam`, { expected: `${SHARED_SEAM.landing.x},${SHARED_SEAM.landing.y} in ${SHARED_SEAM.neighbour}`, actual: describe(crossed) });
  return crossed;
}

define('shared-world-seam-crossing', async () => {
  const host = await actor('shared-world-host'), guest = await actor('shared-world-guest');
  const hostTicket = await ensureAccount(fixtures().admin, ACTORS['shared-world-host']);
  const guestTicket = await ensureAccount(fixtures().admin, ACTORS['shared-world-guest']);
  const resident = (ticket, body) => apiExpect(ticket, 'POST', '/agents', { color: '#397f79', symbol: '✦', capabilities: 'Walks the shared world in the browser acceptance run', limitations: 'No external tools and no real-world claims', ...body });
  const humanOne = await resident(hostTicket, { kind: 'human', name: 'Seam walker one', symbol: '◆' });
  const humanTwo = await resident(guestTicket, { kind: 'human', name: 'Seam walker two', symbol: '▲' });
  const aide = await resident(hostTicket, { kind: 'agent', name: 'Seam AI resident' });
  let runtime = null, controlOne = null, controlTwo = null, garden = null, built = [];

  await step('two humans and one AI resident walk off the Commons edge into Highlands with no portal', async () => {
    const created = rows('SELECT id,kind,world_id FROM agents WHERE id IN (?,?,?)', humanOne.id, humanTwo.id, aide.id);
    expect(created.length === 3 && created.every((item) => item.world_id === 'commons' && item.kind !== undefined), 'the three residents must start in the Commons', { expected: 'three residents in commons', actual: describe(created) });
    const worldsBefore = new Set(rows('SELECT id FROM worlds').map((world) => world.id));
    const sectorsBefore = count('SELECT COUNT(*) AS n FROM frontier_sectors');
    // The AI resident is issued its own runtime credential by the operator that owns it: that is what
    // makes every later AI step the AI's own action and not a human's.
    runtime = await apiExpect(hostTicket, 'POST', '/runtime/start', { agent_id: aide.id, minutes: 20, max_calls: 500, scopes: ['read', 'move', 'chat', 'build'] });
    for (const [page, account, human] of [[host.page, ACTORS['shared-world-host'], humanOne], [guest.page, ACTORS['shared-world-guest'], humanTwo]]) {
      await openApp(page, account);
      await selectResidentAndSettle(page, human.id, human.name);
      await openWorldAs(page, human.id);
    }
    // The walk to the edge is the interface's own route planner, one tile in from the crossing tile so
    // the movement controls can be measured without crossing a seam while they are being measured.
    await walkResidentTo(host.page, humanOne.id, SHARED_SEAM.stand.x, SHARED_SEAM.stand.y + 1);
    await walkResidentTo(guest.page, humanTwo.id, SHARED_SEAM.stand.x, SHARED_SEAM.stand.y + 1);
    controlOne = await learnMovementControls(host.page, humanOne.id);
    controlTwo = await learnMovementControls(guest.page, humanTwo.id);
    await walkResidentTo(host.page, humanOne.id, SHARED_SEAM.stand.x, SHARED_SEAM.stand.y);
    await walkResidentTo(guest.page, humanTwo.id, SHARED_SEAM.stand.x, SHARED_SEAM.stand.y);
    const first = await browserCrossSeam(host.page, humanOne.id, controlOne, 'Seam walker one');
    const second = await browserCrossSeam(guest.page, humanTwo.id, controlTwo, 'Seam walker two');
    // The AI resident walks the same edge over its own credential, one documented step at a time.
    await runtimeWalk(runtime, aide.id, SHARED_SEAM.anchor, SHARED_SEAM.stand, 'the AI resident');
    await runtimeStep(runtime, aide.id, 'up');
    const third = residentAt(aide.id);
    expect(third.world_id === SHARED_SEAM.neighbour && third.x === SHARED_SEAM.landing.x && third.y === SHARED_SEAM.landing.y, 'the AI resident must cross the seam with the same rule as a human', { expected: `${SHARED_SEAM.landing.x},${SHARED_SEAM.landing.y} in ${SHARED_SEAM.neighbour}`, actual: describe(third) });
    for (const [who, human] of [['Seam walker one', humanOne], ['Seam walker two', humanTwo], ['Seam AI resident', aide]]) {
      const stored = residentAt(human.id);
      expect(stored.world_id === SHARED_SEAM.neighbour, `${who} must be stored in the neighbouring world`, { expected: SHARED_SEAM.neighbour, actual: describe(stored) });
      expect(stored.status === 'active', `${who} must still be an active resident`, { expected: 'active', actual: stored.status });
    }
    // Crossing a seam is a step into land that already exists — not a travel and not a land claim. The
    // *count* of every `worlds` row cannot witness that: the living-world loop seeds its eight scripted
    // residents (and each one's garden and cottage) once the first administrator exists, so it adds
    // sixteen rows of its own at some point while this step is running, whether or not anyone crosses
    // anything. The invariant asserted is therefore the causal one: the world crossed into was already
    // stored before the crossing, no region of the global map appeared, and none of the three residents
    // that crossed owns one more world than it did before.
    const appeared = rows('SELECT id,kind FROM worlds').map((world) => world.id).filter((id) => !worldsBefore.has(id));
    expect(worldsBefore.has(SHARED_SEAM.neighbour), 'the world across the seam must already be stored before the crossing, so that a crossing is a step into existing land and never the creation of a world', { expected: `${SHARED_SEAM.neighbour} among the ${worldsBefore.size} worlds stored before the crossing`, actual: `${SHARED_SEAM.neighbour} was not stored before the crossing; the worlds stored then were ${describe([...worldsBefore].filter((id) => id.includes('district') || id === 'commons'))}` });
    expect(appeared.filter((id) => onMap(id)).length === 0, 'crossing a seam must create no region of the global map', { expected: 'no new world that is a rectangle of the map', actual: `worlds that appeared during the step: ${describe(appeared)}` });
    expect(count('SELECT COUNT(*) AS n FROM worlds WHERE owner_agent_id IN (?,?,?)', humanOne.id, humanTwo.id, aide.id) === 6, 'crossing a seam must create no world of the crossing residents\u2019 own', { expected: 'the six worlds (one garden and one cottage each) the three who crossed already owned', actual: `${count('SELECT COUNT(*) AS n FROM worlds WHERE owner_agent_id IN (?,?,?)', humanOne.id, humanTwo.id, aide.id)} owned by the three who crossed` });
    state.notes.push(`shared world registry: the crossing step saw ${appeared.length} new worlds rows, none of them a map region (${appeared.slice(0, 4).join(', ')}${appeared.length > 4 ? ', …' : ''}), none owned by a resident that crossed; this is the living-world roster being seeded, counted as a note rather than asserted`);
    // The finite land registry is a different table, written by a different path, and nothing else in
    // the process touches it while this step runs: its count can be compared exactly.
    expect(count('SELECT COUNT(*) AS n FROM frontier_sectors') === sectorsBefore, 'crossing a seam must not touch the finite land registry', { expected: `${sectorsBefore} sectors`, actual: `${count('SELECT COUNT(*) AS n FROM frontier_sectors')}` });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered' AND actor IN (?,?)", hostTicket.account.id, guestTicket.account.id) === 3, 'each crossing must be the server\u2019s own recorded entry of the new world, once per resident', { expected: 'three world.entered rows for the two operators', actual: describe(rows("SELECT actor,record_id FROM audit WHERE event='world.entered'")) });
    // Both browsers are drawing the world the residents are stored in.
    await browserShows(host.page, SHARED_SEAM.neighbour);
    await browserShows(guest.page, SHARED_SEAM.neighbour);
    state.notes.push(`shared world: Seam walker one (browser, ${hostTicket.account.id}), Seam walker two (browser, ${guestTicket.account.id}) and the AI resident crossed ${SHARED_SEAM.anchor} ${SHARED_SEAM.stand.x},${SHARED_SEAM.stand.y} into ${SHARED_SEAM.neighbour} ${SHARED_SEAM.landing.x},${SHARED_SEAM.landing.y} with no portal; three world.entered audit rows, the world crossed into already stored, no new map region, no world of the crossing residents' own and no sector touched`);
    return `${SHARED_SEAM.anchor} ${SHARED_SEAM.stand.x},${SHARED_SEAM.stand.y} \u2192 ${SHARED_SEAM.neighbour} ${first.x},${first.y} for two browser-driven humans and one runtime credential, both browsers drawing ${SHARED_SEAM.neighbour}`;
  });

  await step('a bounded viewport read answers for every region the window crosses, and the AI resident reads it on its own credential', async () => {
    const view = await apiRequest('/map?world_id=' + encodeURIComponent(SHARED_SEAM.anchor) + '&agent_id=' + encodeURIComponent(aide.id), { token: runtime.token });
    expect(view.status === 200, 'the AI resident must be able to read a viewport across the seam', { expected: 'HTTP 200', actual: `HTTP ${view.status} ${view.raw}` });
    const regions = (view.body.regions || []).map((item) => item.world_id);
    expect(regions.includes(SHARED_SEAM.anchor) && regions.includes(SHARED_SEAM.neighbour), 'a window straddling the seam must report both regions', { expected: `${SHARED_SEAM.anchor} and ${SHARED_SEAM.neighbour}`, actual: describe(regions) });
    expect(view.body.work.regions <= view.body.bounds.max_regions && view.body.work.statements <= view.body.bounds.max_statements, 'the read must stay inside the bound it states', { expected: `at most ${view.body.bounds.max_regions} regions and ${view.body.bounds.max_statements} statements`, actual: describe(view.body.work) });
    const stored = residentAt(aide.id);
    const seen = (view.body.participants || []).find((item) => item.id === aide.id);
    expect(seen && seen.world_id === stored.world_id && seen.x === stored.x && seen.y === stored.y, 'the viewport read must report the stored world and the stored tile, not the world the client draws', { expected: `${stored.world_id} ${stored.x},${stored.y}`, actual: describe(seen) });
    expect(JSON.stringify(view.body).includes('home:') === false, 'no garden may ever be a region of a viewport', { actual: 'a garden id appeared in the payload' });
    state.notes.push(`shared world viewport: /api/v1/map over ${SHARED_SEAM.anchor} reported regions ${regions.join(', ')} in ${view.body.work.statements} statements of a stated ${view.body.bounds.max_statements}, with the AI resident at ${seen.x},${seen.y} in ${seen.world_id}`);
    return `${regions.length} regions (${regions.join(', ')}), ${view.body.work.statements}/${view.body.bounds.max_statements} statements, the AI resident reported in ${seen.world_id}`;
  });

  await step('a nearby message crosses the seam and reaches the neighbour on the other side only', async () => {
    // Human one stays on the landing tile; the AI resident steps back across the seam, so the two stand
    // one world-space tile apart with the boundary between them; human two walks four tiles away.
    await runtimeStep(runtime, aide.id, 'down');
    const aideTile = residentAt(aide.id);
    expect(aideTile.world_id === SHARED_SEAM.anchor && aideTile.x === SHARED_SEAM.stand.x && aideTile.y === SHARED_SEAM.stand.y, 'the AI resident must be back on the Commons side of the seam', { expected: `${SHARED_SEAM.anchor} ${SHARED_SEAM.stand.x},${SHARED_SEAM.stand.y}`, actual: describe(aideTile) });
    const far = planWalk(getWorldDefinition(SHARED_SEAM.neighbour), { x: SHARED_SEAM.landing.x, y: SHARED_SEAM.landing.y }, SHARED_SEAM.out_of_range, { objects: [], maxSteps: 64, maxVisited: 4096 });
    expect(far, 'the neighbouring world must offer a route four tiles off the landing tile', { expected: 'a route to ' + SHARED_SEAM.out_of_range.x + ',' + SHARED_SEAM.out_of_range.y, actual: 'no route' });
    for (const step_ of far) await runtimeStep(guestTicket, humanTwo.id, step_);
    const farTile = residentAt(humanTwo.id);
    expect(farTile.world_id === SHARED_SEAM.neighbour && farTile.x === SHARED_SEAM.out_of_range.x && farTile.y === SHARED_SEAM.out_of_range.y, 'Seam walker two must stand four tiles off the landing tile, still in the neighbouring world', { expected: `${SHARED_SEAM.out_of_range.x},${SHARED_SEAM.out_of_range.y} in ${SHARED_SEAM.neighbour}`, actual: describe(farTile) });
    const sent = await sendLine(hostTicket, hostTicket.account.id, { agent_id: humanOne.id, channel: 'nearby', text: SHARED_SEAM.line });
    const stored = await waitForCondition(async () => row('SELECT * FROM messages WHERE id=?', sent.id) || null, 'the nearby line to be stored');
    const recipients = JSON.parse(stored.recipients);
    expect(stored.world_id === SHARED_SEAM.neighbour, 'the saved line must belong to the world its sender crossed into', { expected: SHARED_SEAM.neighbour, actual: stored.world_id });
    expect(recipients.includes(aide.id), 'a nearby message must reach a resident one world-space tile away across the seam', { expected: `the AI resident ${aide.id} among the recipients`, actual: describe(recipients) });
    expect(!recipients.includes(humanTwo.id), 'and must not reach a resident four world-space tiles away, whatever the two regions\u2019 local coordinates say', { expected: `${humanTwo.id} absent`, actual: describe(recipients) });
    // The neighbour reads it from its own world, through the credential it crossed with.
    const read = await apiRequest('/world?world_id=' + encodeURIComponent(SHARED_SEAM.anchor) + '&x=' + SHARED_SEAM.stand.x + '&y=' + SHARED_SEAM.stand.y, { token: runtime.token });
    expect(read.status === 200 && (read.body.messages || []).some((message) => message.id === sent.id), 'the neighbour must read the line from its own world', { expected: `HTTP 200 holding ${sent.id}`, actual: `HTTP ${read.status}` });
    // And the answer crosses the other way: the AI resident speaks, and the human on the far side hears
    // it. The runtime credential posts as the account that issued it — the same account as the human's
    // line above — so the answer is paced past the server's own per-account message interval instead of
    // racing it, and the stored row proves both lines share that account.
    const answer = await sendLine(runtime, stored.account_id, { channel: 'nearby', text: SHARED_SEAM.answer });
    const answered = await waitForCondition(async () => row('SELECT * FROM messages WHERE id=?', answer.id) || null, 'the AI resident\u2019s answer to be stored');
    expect(answered.account_id === stored.account_id, 'the AI resident\u2019s line must be stored under the account that issued its credential', { expected: stored.account_id, actual: describe(answered.account_id) });
    expect(JSON.parse(answered.recipients).includes(humanOne.id), 'the AI resident\u2019s answer must reach the human one tile away across the same seam', { expected: `${humanOne.id} among the recipients`, actual: describe(JSON.parse(answered.recipients)) });
    state.notes.push(`shared world conversation: ${sent.id} sent from ${SHARED_SEAM.neighbour} reached the AI resident one world-space tile away on the other side and was withheld from the resident four tiles away; the AI resident answered with ${answer.id}, which reached the human across the seam`);
    return `both directions crossed the seam: ${recipients.length + 1} recipients for ${sent.id} (with the far resident excluded) and the AI answer ${answer.id} reaching the far-side human`;
  });

  await step('the AI resident builds in its own garden and the same placement is refused on the map', async () => {
    const refusedOnTheMap = await api(runtime, 'POST', `/agents/${aide.id}/build`, { type: 'flowers', x: SHARED_SEAM.landing.x, y: SHARED_SEAM.landing.y - 2 });
    expect(refusedOnTheMap.status >= 400, 'a placement outside the resident\u2019s own plot must be refused, on the far side of a seam', { expected: 'a refusal', actual: `HTTP ${refusedOnTheMap.status} ${refusedOnTheMap.raw}` });
    const gardenId = `home:${aide.id}`;
    garden = await travelTo(runtime, aide.id, gardenId);
    const definition = getWorldDefinition(gardenId);
    built = [];
    for (let y = 0; y < definition.rows && built.length < 3; y++) for (let x = 0; x < definition.columns && built.length < 3; x++) {
      if (!walkable({ x, y }, definition)) continue;
      if (Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) <= 1) continue;
      if ((definition.portals || []).some((portal) => Math.abs(portal.x - x) + Math.abs(portal.y - y) <= 1)) continue;
      built.push({ x, y });
    }
    expect(built.length === 3, 'the AI resident\u2019s garden must offer buildable tiles', { expected: 'three buildable tiles', actual: describe(built) });
    for (const [index, tile] of built.entries()) await apiExpect(runtime, 'POST', `/agents/${aide.id}/build`, { type: index === 1 ? 'bench' : 'flowers', x: tile.x, y: tile.y }, [201]);
    const stored = rows('SELECT type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x', gardenId);
    expect(stored.length === 3, 'the garden must hold exactly the three placements the AI resident made', { expected: 'three saved placements', actual: describe(stored) });
    // Out of the garden the same placement is out of reach: rights follow the stored plot.
    await travelTo(runtime, aide.id, SHARED_SEAM.anchor);
    const refusedAtHome = await api(runtime, 'POST', `/agents/${aide.id}/build`, { type: 'flowers', x: built[0].x, y: built[0].y });
    expect(refusedAtHome.status >= 400, 'the same placement must be refused once the resident is back on the map', { expected: 'a refusal', actual: `HTTP ${refusedAtHome.status} ${refusedAtHome.raw}` });
    state.notes.push(`shared world build: three attributed placements saved in ${gardenId} by the AI resident on its own credential (${built.map((tile, index) => (index === 1 ? 'bench' : 'flowers') + ' ' + tile.x + ',' + tile.y).join(' \u00b7 ')}), refused at ${SHARED_SEAM.landing.x},${SHARED_SEAM.landing.y - 2} in ${SHARED_SEAM.neighbour} and refused again from the Commons`);
    return `three placements saved in ${gardenId} and two placements refused outside the resident's own plot`;
  });

  await step('a real restart keeps the crossing, the conversation and the garden byte for byte', async () => {
    // Leave all three on the far side of the seam again, so the restart has a crossing to preserve.
    const home = planWalk(getWorldDefinition(SHARED_SEAM.anchor), { x: residentAt(aide.id).x, y: residentAt(aide.id).y }, SHARED_SEAM.stand, { objects: rows('SELECT type,x,y FROM world_objects WHERE world_id=?', SHARED_SEAM.anchor), maxSteps: 256, maxVisited: 16_384 });
    expect(home, 'the AI resident must have a route back to the edge tile', { expected: `a route to ${SHARED_SEAM.stand.x},${SHARED_SEAM.stand.y}`, actual: describe(residentAt(aide.id)) });
    for (const direction of home) await runtimeStep(runtime, aide.id, direction);
    await runtimeStep(runtime, aide.id, 'up');
    // The humans never left the far side: they crossed in the first step and have stayed there.
    const placement = () => Object.fromEntries([humanOne, humanTwo, aide].map((human) => [human.id, residentAt(human.id)]));
    const before = placement();
    expect(Object.values(before).every((item) => item.world_id === SHARED_SEAM.neighbour), 'all three residents must be on the far side of the seam before the restart', { expected: `three residents in ${SHARED_SEAM.neighbour}`, actual: describe(before) });
    const objectsBefore = rows('SELECT id,world_id,type,x,y,created_at FROM world_objects WHERE world_id=? ORDER BY x,y', `home:${aide.id}`);
    const conversationBefore = rows("SELECT id,agent_id,account_id,channel,world_id,created_at FROM messages WHERE text IN (?,?) ORDER BY id", SHARED_SEAM.line, SHARED_SEAM.answer);
    expect(conversationBefore.length === 2, 'the crossing conversation must be saved before the restart', { expected: 'two saved lines', actual: describe(conversationBefore) });
    await stopServer();
    await startServer();
    expect(describe(placement()) === describe(before), 'a restart against the same database must not move any of the three residents', { expected: describe(before), actual: describe(placement()) });
    expect(Object.values(placement()).every((item) => item.world_id === SHARED_SEAM.neighbour), 'all three must still be stored in the world they crossed into', { expected: SHARED_SEAM.neighbour, actual: describe(placement()) });
    const objectsAfter = rows('SELECT id,world_id,type,x,y,created_at FROM world_objects WHERE world_id=? ORDER BY x,y', `home:${aide.id}`);
    expect(describe(objectsAfter) === describe(objectsBefore), 'the garden must survive the restart byte-for-byte', { expected: describe(objectsBefore), actual: describe(objectsAfter) });
    const conversationAfter = rows("SELECT id,agent_id,account_id,channel,world_id,created_at FROM messages WHERE text IN (?,?) ORDER BY id", SHARED_SEAM.line, SHARED_SEAM.answer);
    expect(describe(conversationAfter) === describe(conversationBefore), 'both saved lines must survive the restart unchanged', { expected: describe(conversationBefore), actual: describe(conversationAfter) });
    // The credential the AI resident crossed with still works, and both browsers reload into the world
    // the party is stored in.
    const read = await apiRequest('/world?world_id=' + encodeURIComponent(SHARED_SEAM.anchor) + '&x=' + SHARED_SEAM.stand.x + '&y=' + SHARED_SEAM.stand.y, { token: runtime.token });
    expect(read.status === 200, 'the AI resident\u2019s credential must still read after the restart', { expected: 'HTTP 200', actual: `HTTP ${read.status} ${read.raw}` });
    for (const [page, account, human] of [[host.page, ACTORS['shared-world-host'], humanOne], [guest.page, ACTORS['shared-world-guest'], humanTwo]]) {
      await openApp(page, account);
      await openWorldAs(page, human.id);
      await browserShows(page, SHARED_SEAM.neighbour);
    }
    await waitForClient(host.page, (party) => {
      const held = (window.__nemoworld?.world?.()?.participants || []).map((item) => item.id);
      return party.every((id) => held.includes(id)) ? true : null;
    }, [humanOne.id, humanTwo.id, aide.id], 'the reloaded browser to show the whole party in the world it crossed into', 20_000);
    state.notes.push(`shared world restart: after a real restart all three residents are still stored in ${SHARED_SEAM.neighbour} at ${SHARED_SEAM.landing.x},${SHARED_SEAM.landing.y}, ${objectsAfter.length} garden placements and both crossing lines are byte-for-byte unchanged, the runtime credential still reads and both browsers show ${SHARED_SEAM.neighbour} with the party in it`);
    return `after a real restart: three residents still in ${SHARED_SEAM.neighbour} ${SHARED_SEAM.landing.x},${SHARED_SEAM.landing.y}, ${objectsAfter.length} placements and 2 saved lines unchanged, both browsers back in ${SHARED_SEAM.neighbour}`;
  });

  return `two independent humans drove two browsers and one AI resident drove its own runtime credential from the Commons edge ${SHARED_SEAM.stand.x},${SHARED_SEAM.stand.y} into ${SHARED_SEAM.neighbour} ${SHARED_SEAM.landing.x},${SHARED_SEAM.landing.y} with no portal and no new world, read a bounded viewport that reported both sides of the seam, spoke across the join with the far resident excluded and the neighbour included, built three placements in the AI resident's own garden with the same call refused on the map, and returned after a real restart to the same stored rows, the same conversation and the same garden`;

});

define('home-vault-interface', async () => {
  const player = await context('home-vault');
  const page = player.page;
  const EMAIL = 'tester.home-vault@browser.test';
  const NAME = 'Home vault tester';
  const RESIDENT = 'Vault resident';
  const SECRET = 'the orchard gate code is moonlight';
  let account = null, resident = null, runtime = null;
  const vaultRequests = [];
  page.on('request', (request) => { if (/\/api\/v1\/vault/.test(request.url())) vaultRequests.push(`${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search ? '?…' : ''}`); });
  const shots = join(RESULTS, 'home-vault-interface');
  await mkdir(shots, { recursive: true });
  const spaces = () => Object.fromEntries(rows('SELECT kind,visibility FROM worlds WHERE owner_agent_id=?', resident.id).map((world) => [world.kind, world.visibility]));
  const enterTheWorld = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await enterWorldAs(page, resident.id, RESIDENT); return true; } catch { await page.waitForTimeout(600); }
    }
    return false;
  };
  const openHome = async () => {
    await openGameTab(page, 'Home & vault');
    const host = page.locator('#home-panel-host');
    await host.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await page.locator('[data-home-resident] [data-vault-status]').first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(() => document.querySelector('[data-home-panel]')?.getAttribute('aria-busy') === 'false', null, { timeout: PAGE_TIMEOUT_MS });
    return host;
  };
  const gardenSwitch = () => page.locator('[data-home-switch$=":garden"]');
  const cottageSwitch = () => page.locator('[data-home-switch$=":cottage"]');
  /** The 4.5:1 floor, measured on what the browser drew: text colour against the composited ancestors. */
  const contrastOf = (selector) => page.evaluate((query) => {
    const parse = (value) => { const m = /rgba?\(([^)]+)\)/.exec(value); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const results = [];
    for (const node of document.querySelectorAll(query)) {
      if (!node.checkVisibility?.() || !node.textContent.trim()) continue;
      const chain = [];
      for (let at = node; at; at = at.parentElement) chain.push(at);
      let background = { r: 5, g: 29, b: 24, a: 1 };
      for (const link of chain.reverse()) { const paint = parse(getComputedStyle(link).backgroundColor); if (paint && paint.a > 0) background = over(paint, background); }
      const ink = parse(getComputedStyle(node).color);
      const text = over(ink, background);
      const [light, dark] = [lum(text), lum(background)].sort((a, b) => b - a);
      results.push({ text: node.textContent.trim().slice(0, 40), ratio: Number(((light + 0.05) / (dark + 0.05)).toFixed(2)) });
    }
    return results;
  }, selector);

  await step('a brand-new operator signs up, creates an AI resident and opens Home & vault from the game menu', async () => {
    await page.goto(baseUrl(), { waitUntil: 'domcontentloaded' });
    await settle(page);
    await signUp(page, { name: NAME, email: EMAIL, password: PASSWORD });
    account = row('SELECT id FROM accounts WHERE email=?', EMAIL);
    resident = await createResidentThroughInterface(page, RESIDENT);
    expect(resident.kind === 'agent', 'the created character must be an AI resident', { actual: describe(resident) });
    expect(await enterTheWorld(), 'the resident must enter the world', { actual: describe(await entryState(page)) });
    await openHome();
    const card = page.locator('#world-home-vault-card');
    expect((await card.locator('h2').first().textContent()).includes('homes'), 'the section must name itself', { actual: await card.textContent() });
    expect(await card.locator(`[data-home-resident="${resident.id}"]`).count() === 1, 'the section must list the operator’s AI resident', { actual: await card.textContent() });
    return `account ${account.id} with AI resident ${resident.id}; Home & vault open over the world`;
  });

  await step('a resident with no vault says so, and the cottage starts closed while the garden is open', async () => {
    const vault = page.locator(`[data-home-vault="${resident.id}"]`);
    expect(await vault.getAttribute('data-vault-enrolled') === 'false', 'a fresh resident has no vault', { actual: await vault.textContent() });
    expect(/no vault yet/i.test(await vault.textContent()), 'the panel must say there is no vault yet', { actual: await vault.textContent() });
    expect(await page.locator(`[data-home-erase="${resident.id}"]`).isDisabled(), 'there is nothing to erase', { actual: 'Erase is enabled' });
    const stored = spaces();
    expect(stored.house === 'private' && stored.home === 'public', 'the server must start the cottage private and the garden public', { actual: describe(stored) });
    expect(await gardenSwitch().getAttribute('aria-checked') === 'true' && await cottageSwitch().getAttribute('aria-checked') === 'false', 'the switches must show the server’s state', { actual: describe(stored) });
    const rule = (await page.locator('[data-home-rule]').first().textContent()) || '';
    expect(/Closing the garden also closes the cottage\./.test(rule) && /Opening the garden does not open the cottage/.test(rule), 'the page must say in words what the garden switch does to the cottage', { actual: rule });
    return `no vault; garden ${stored.home}, cottage ${stored.house}; the rule is written beside the switches`;
  });

  await step('the vault shows counts and the server’s own privacy statement, never a note or a slot map', async () => {
    // The operator's own signed-in page mints the resident's credential, so the browser session is never replaced.
    runtime = await inPage(page, '/runtime/start', { body: { agent_id: resident.id, minutes: 5, max_calls: 30, scopes: ['read', 'vault'] } });
    expect(runtime.status === 200 || runtime.status === 201, 'the operator must be able to mint the resident’s own credential', { actual: describe(runtime) });
    for (const slot of [1, 2, 3]) {
      const written = await apiRequest('/vault/write', { method: 'POST', token: runtime.body.token, body: { slot, text: `${SECRET} ${slot}` } });
      expect(written.status === 200, 'the resident’s own credential must write a note', { actual: `HTTP ${written.status} ${written.raw}` });
    }
    vaultRequests.length = 0;
    await openGameTab(page, 'My characters');
    const host = await openHome();
    const vault = page.locator(`[data-home-vault="${resident.id}"]`);
    const text = (await vault.textContent()) || '';
    expect(/Sealed by the server\. 3 notes, /.test(text), 'the panel must state the key model and the note count', { actual: text });
    const policy = await inPage(page, `/vault?agent_id=${encodeURIComponent(resident.id)}`, { method: 'GET' });
    expect(policy.status === 200 && !JSON.stringify(policy.body).includes('moonlight') && !('slots' in policy.body) && !('key_check' in policy.body), 'the operator route must carry no note, slot map or key check', { actual: describe(policy.body) });
    for (const line of [policy.body.policy.summary, policy.body.policy.sealed, policy.body.policy.effect]) expect(text.includes(line), 'the panel must show the server’s own privacy statement', { expected: line, actual: text });
    const page_text = await page.locator('body').innerText();
    expect(!page_text.includes('moonlight') && !page_text.includes(SECRET), 'a note must never reach the operator’s page', { actual: 'note text found on the page' });
    expect(vaultRequests.every((entry) => !/vault\/notes/.test(entry)) && vaultRequests.some((entry) => entry.startsWith('GET /api/v1/vault')), 'the page must ask only for the counts', { actual: describe(vaultRequests) });
    await page.screenshot({ path: join(shots, 'desktop-vault.png') });
    state.notes.push(`home vault: three notes written by the resident's own credential; the operator's page showed "${text.match(/Sealed by the server\. 3 notes, [^.]*/)?.[0]}" and no note text; requests: ${vaultRequests.join(', ')}`);
    return `3 notes counted, the server's VAULT_POLICY text shown, no note text on the page, requests ${[...new Set(vaultRequests)].join(', ')}`;
  });

  await step('the cottage and garden switches are independent and show only what the server saved', async () => {
    await cottageSwitch().click();
    await page.waitForFunction(() => document.querySelector('[data-home-switch$=":cottage"]')?.getAttribute('aria-checked') === 'true', null, { timeout: PAGE_TIMEOUT_MS });
    let stored = spaces();
    expect(stored.house === 'public' && stored.home === 'public', 'opening the cottage must change only the cottage', { actual: describe(stored) });
    expect(/The server saved it: the garden is open to visitors and the cottage is open to visitors\./.test(await page.locator('[data-home-saved]').textContent()), 'the saved line must be the server’s answer', { actual: await page.locator('[data-home-saved]').textContent() });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-home-switch')?.endsWith(':cottage')), 'focus must stay on the switch that was pressed', { actual: await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)) });
    // Closing the garden also closes the cottage — by the keyboard alone.
    await gardenSwitch().focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('[data-home-switch$=":garden"]')?.getAttribute('aria-checked') === 'false', null, { timeout: PAGE_TIMEOUT_MS });
    stored = spaces();
    expect(stored.home === 'private' && stored.house === 'private', 'closing the garden must also close the cottage', { actual: describe(stored) });
    expect(await cottageSwitch().getAttribute('aria-checked') === 'false', 'the cottage switch must now read Off', { actual: await cottageSwitch().textContent() });
    // Opening the garden does not open the cottage.
    await gardenSwitch().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-home-switch$=":garden"]')?.getAttribute('aria-checked') === 'true', null, { timeout: PAGE_TIMEOUT_MS });
    stored = spaces();
    expect(stored.home === 'public' && stored.house === 'private', 'opening the garden must not open the cottage', { actual: describe(stored) });
    expect(await cottageSwitch().getAttribute('aria-checked') === 'false', 'the cottage switch must still read Off', { actual: await cottageSwitch().textContent() });
    await page.screenshot({ path: join(shots, 'desktop-switches.png') });
    return 'cottage opened alone; garden closed by the keyboard closed the cottage too; garden opened by the keyboard left the cottage closed';
  });

  await step('Erase asks first, cancel keeps the vault, and the confirmed erase deletes every note and the key', async () => {
    const erase = page.locator(`[data-home-erase="${resident.id}"]`);
    await erase.click();
    const confirm = page.locator(`[data-home-confirm="${resident.id}"]`);
    await confirm.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    expect(/Erase Vault resident’s vault and its 3 notes\?/.test(await confirm.textContent()) && /cannot be undone/.test(await confirm.textContent()), 'the confirm must name the resident, the notes and that it cannot be undone', { actual: await confirm.textContent() });
    expect(count('SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=?', resident.id) === 3, 'asking must erase nothing', { actual: 'rows changed' });
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-home-confirm-erase')), 'focus must move to the confirm button', { actual: await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)) });
    await page.screenshot({ path: join(shots, 'desktop-erase-confirm.png') });
    // Escape cancels the armed erase first; the panel itself stays open.
    await page.keyboard.press('Escape');
    await confirm.waitFor({ state: 'detached', timeout: PAGE_TIMEOUT_MS });
    expect(await page.locator('#home-panel-host').isVisible() && count('SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=?', resident.id) === 3, 'Escape must cancel the erase and leave the panel and the vault alone', { actual: 'the panel closed or the vault changed' });
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-home-erase')), 'focus must return to Erase after Escape', { actual: await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)) });
    await erase.click();
    await page.locator(`[data-home-cancel="${resident.id}"]`).click();
    expect(await page.locator(`[data-home-confirm="${resident.id}"]`).count() === 0 && count('SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=?', resident.id) === 3, 'the Cancel button must keep the vault', { actual: 'the vault changed' });
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-home-erase')), 'focus must return to Erase after Cancel', { actual: await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)) });
    await erase.click();
    await page.locator(`[data-home-confirm-erase="${resident.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('[data-vault-enrolled]')?.getAttribute('data-vault-enrolled') === 'false', null, { timeout: PAGE_TIMEOUT_MS });
    expect(count('SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=?', resident.id) === 0 && count('SELECT COUNT(*) AS n FROM resident_vault_keys WHERE agent_id=?', resident.id) === 0, 'the confirmed erase must delete every note and the key', { actual: 'rows remain' });
    expect(/The server erased the vault: 3 notes and the key were deleted\./.test(await page.locator('[data-home-saved]').textContent()), 'the page must report the server’s own count', { actual: await page.locator('[data-home-saved]').textContent() });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='vault.erased'") >= 1, 'the server must have audited the erase', { actual: 'no audit row' });
    return 'Escape and Cancel each kept three notes; the confirmed erase removed them and the key, was audited, and the page reported the count';
  });

  await step('the passport carries a “Your resident’s home” summary that links to the vault and to the switches', async () => {
    await openGameTab(page, 'Resident passport');
    const summary = page.locator('#world-home-summary');
    await summary.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(() => /garden is open/.test(document.querySelector('#world-home-summary')?.textContent || ''), null, { timeout: PAGE_TIMEOUT_MS });
    const text = (await summary.textContent()) || '';
    expect(/Your resident’s home/.test(text) && /The garden is open: anyone can visit it\./.test(text) && /The cottage is closed: only your account and this resident can enter\./.test(text) && /Vault: This resident has no vault yet/.test(text), 'the summary must state the garden, the cottage and the vault', { actual: text });
    await page.screenshot({ path: join(shots, 'desktop-passport-summary.png') });
    await summary.getByRole('button', { name: `Open ${RESIDENT}’s vault` }).click();
    await page.locator(`[data-home-vault="${resident.id}"]`).waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-home-anchor')?.endsWith(':vault'), null, { timeout: PAGE_TIMEOUT_MS });
    await openGameTab(page, 'Resident passport');
    await page.locator('#world-home-summary').getByRole('button', { name: `Choose who can visit ${RESIDENT}’s garden and cottage` }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-home-anchor')?.endsWith(':privacy'), null, { timeout: PAGE_TIMEOUT_MS });
    return 'the summary states garden, cottage and vault; its two links open Home & vault with the focus on the vault heading and on the visiting heading';
  });

  await step('a refusal from the server is shown plainly, in its own words, and no success is claimed', async () => {
    await openHome();
    const direct = await inPage(page, `/agents/${encodeURIComponent(resident.id)}/home`, { method: 'PATCH', body: { house_visibility: 'everyone' } });
    expect(direct.status === 400 && typeof direct.body?.error === 'string', 'the server must refuse an unknown visibility', { actual: describe(direct) });
    // The page asks for a change the server will refuse: the resident now belongs to another operator behind its back.
    const stranger = row("SELECT id FROM accounts WHERE email='stranger@browser.test'");
    write('UPDATE agents SET operator_id=? WHERE id=?', stranger.id, resident.id);
    try {
      await cottageSwitch().click();
      const words = page.locator('[data-home-refusal-words]');
      await words.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
      const shown = ((await words.textContent()) || '').trim();
      const server = await inPage(page, `/agents/${encodeURIComponent(resident.id)}/home`, { method: 'PATCH', body: { house_visibility: 'public' } });
      expect(shown.length > 3 && shown === server.body?.error, 'the page must show the server’s refusal verbatim', { expected: describe(server.body?.error), actual: shown });
      expect(await words.getAttribute('role') === 'alert' && await page.locator('[data-home-saved]').count() === 0, 'a refusal is an alert and never a success', { actual: await page.locator('[data-home-resident]').first().textContent() });
      state.notes.push(`home vault: a refused change showed the server's own words: "${shown}"`);
      return `refusal shown verbatim: "${shown}"`;
    } finally { write('UPDATE agents SET operator_id=? WHERE id=?', account.id, resident.id); }
  });

  await step('at 390 px with reduced motion the section fits, every control is 44 px or more and the text clears 4.5:1', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHome();
    const colours = await contrastOf('[data-home-panel] p, [data-home-panel] h3, [data-home-panel] h4, [data-home-panel] button:not(:disabled)');
    const weak = colours.filter((item) => item.ratio < 4.5);
    expect(colours.length > 8 && weak.length === 0, 'every text on the section must reach 4.5:1 against what is behind it', { expected: 'ratio ≥ 4.5', actual: describe(weak.length ? weak : colours.slice(0, 3)) });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    expect(await enterTheWorld(), 'the resident must enter its world on a phone', { actual: describe(await entryState(page)) });
    await openHome();
    await page.locator(`[data-home-erase="${resident.id}"]`).scrollIntoViewIfNeeded().catch(() => {});
    const measured = await page.evaluate(() => {
      const root = document.querySelector('[data-home-panel]');
      const controls = [...root.querySelectorAll('button')].filter((node) => !node.disabled);
      return {
        viewport: window.innerWidth, document: document.documentElement.scrollWidth,
        smallest: Math.min(...controls.map((node) => Math.round(node.getBoundingClientRect().height))),
        count: controls.length, reduced: root.className.includes('ui-home-reduced'), transition: getComputedStyle(root).transitionDuration,
        overflow: [...root.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1).length,
      };
    });
    expect(measured.document <= measured.viewport && measured.overflow === 0, 'the section must fit a 390 px phone without horizontal scrolling', { actual: describe(measured) });
    expect(measured.count >= 3 && measured.smallest >= 44, 'every control must meet the 44 px touch floor', { actual: describe(measured) });
    expect(measured.reduced && /^0s/.test(measured.transition), 'the panel must drop its transitions under reduced motion', { actual: describe(measured) });
    await page.screenshot({ path: join(shots, 'phone-home-vault.png') });
    await page.emulateMedia({ reducedMotion: null });
    await page.setViewportSize({ width: 1280, height: 800 });
    state.notes.push(`home vault phone: 390 px, document ${measured.document} px, smallest control ${measured.smallest} px, ${colours.length} text samples all ≥ 4.5:1`);
    return `390 px: no horizontal scroll, smallest control ${measured.smallest} px, no transition under reduced motion; ${colours.length} desktop text samples all ≥ 4.5:1`;
  });

  return 'an operator opened Home & vault from the game menu; the vault showed counts and the server’s privacy statement and never a note; the two visiting switches moved independently (by pointer and by keyboard) and matched the saved rows; Erase asked first and then deleted every note and the key; the passport summary linked to both; a server refusal was shown verbatim; the phone layout held at 44 px';
});

define('hero-introduction-film',async()=>{
  const visitor=await context('film-visitor');await visitor.page.goto(baseUrl(),{waitUntil:'domcontentloaded'});await settle(visitor.page);
  await step('the landing film has an accessible poster and waits for playback intent',async()=>{
    const video=visitor.page.locator('#hero-introduction');await video.waitFor({state:'visible'});
    const info=await video.evaluate(v=>({autoplay:v.autoplay,paused:v.paused,controls:v.controls,preload:v.preload,poster:v.poster}));
    expect(!info.autoplay&&info.paused&&info.controls&&info.preload==='none','the hero must not autoplay or download the film at page load',{actual:describe(info)});
    expect(info.poster.endsWith('/assets/media/nemoworld-introduction.jpg'),'the hero must show the supplied film’s poster');
    return 'user-started playback, native sound/seek/fullscreen controls, poster, no preload';
  });
  await step('Chrome decodes the supplied film and closing its introduction pauses playback',async()=>{
    await visitor.page.locator('#hero-actions').getByRole('link',{name:'Watch the film (2 min)',exact:true}).click();
    const video=visitor.page.locator('#introduction-film');
    await video.evaluate(async v=>{v.muted=true;await v.play();});
    const info=await waitForCondition(async()=>video.evaluate(v=>v.currentTime>0.2?{duration:v.duration,width:v.videoWidth,height:v.videoHeight}:null),'Chrome to decode and advance the film');
    expect(info.duration>90&&info.width===1280&&info.height===720,'the complete 720p introduction must be playable',{actual:describe(info)});
    await visitor.page.getByRole('button',{name:'Close introduction',exact:true}).click();
    await waitForCondition(async()=>video.evaluate(v=>v.paused),'closing the film to pause audio and video');
    await mkdir(join(RESULTS,'hero-introduction-film'),{recursive:true});
    await visitor.page.screenshot({path:join(RESULTS,'hero-introduction-film','desktop.png')});
    await visitor.page.setViewportSize({width:390,height:844});
    expect(await visitor.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'the video hero must fit a phone without horizontal overflow');
    await visitor.page.screenshot({path:join(RESULTS,'hero-introduction-film','mobile.png')});
    return `Chrome played ${info.duration.toFixed(2)} seconds at ${info.width}×${info.height}; close pauses it; 390px mobile fits`;
  });
  return 'the supplied introduction plays in Chrome and fits mobile, with no autoplay';
});

define('game-entry-and-observation', async () => {
  const visitor = await context('game-visitor');
  const page = visitor.page;
  await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
  await settle(page);

  await step('the landing screen offers Play and Observe, and Play asks the visitor to sign up', async () => {
    const actions = page.locator('#hero-actions');
    await actions.waitFor({ state: 'visible' });
    const play = actions.getByRole('button', { name: /Play/i }).first();
    const observe = actions.getByRole('button', { name: /Observe/i }).first();
    expect(await play.isVisible() && await observe.isVisible(), 'both game entry choices must be usable', { expected: 'visible Play and Observe buttons' });
    await play.click();
    await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    expect(await page.locator('#auth-dialog').evaluate((dialog) => dialog.open), 'anonymous Play must lead to account creation', { actual: 'the account dialog is not open' });
    await page.locator('#close-auth').click();
    return 'Play opened the account dialog; Observe remained available without an account';
  });

  await step('Observe loads the public world as a screen-filling scene', async () => {
    await page.locator('#hero-actions').getByRole('button', { name: /Observe/i }).first().click();
    await settle(page);
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    const canvas = page.locator('#world');
    await canvas.waitFor({ state: 'visible' });
    const stage = await canvas.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    expect(stage.width >= stage.viewportWidth * 0.75 && stage.height >= stage.viewportHeight * 0.5,
      'the 3D world must occupy most of the desktop viewport', { expected: 'at least 75% of width and 50% of height', actual: describe(stage) });
    const observed = await page.evaluate(() => ({
      world: window.__nemoworld?.worldId?.(),
      participants: window.__nemoworld?.world?.()?.participants,
    }));
    expect(observed.world === 'commons' && Array.isArray(observed.participants),
      'Observe must load server world data for the Commons', { actual: describe(observed) });
    const before = (await page.locator('#world-reticle').textContent())?.trim() || '';
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    const after = await waitForCondition(async () => {
      const line = (await page.locator('#world-reticle').textContent())?.trim() || '';
      return line !== before ? line : null;
    }, 'the observer camera to respond to an arrow key');
    expect(/at \d+, \d+/.test(after), 'keyboard observation must keep the camera location readable', { actual: after });
    await mkdir(join(RESULTS, 'game-entry-and-observation'), { recursive: true });
    await page.screenshot({ path: join(RESULTS, 'game-entry-and-observation', 'desktop.png') });
    return `3D scene ${Math.round(stage.width)}×${Math.round(stage.height)} in ${stage.viewportWidth}×${stage.viewportHeight}; public ${observed.world} loaded; ArrowRight moved the observer camera`;
  });

  await step('the phone layout keeps the world and menu accessible without sideways scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const canvas = page.locator('#world');
    const stage = await canvas.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(stage.scrollWidth <= stage.viewportWidth, 'the game screen must fit a 390px phone without horizontal overflow', { actual: describe(stage) });
    expect(stage.width >= 300 && stage.height >= 350, 'the mobile world must remain a usable scene', { actual: describe(stage) });
    const menu = page.locator('#game-menu-button');
    expect(await menu.isVisible(), 'the mobile world menu must remain visible', { actual: 'no visible #game-menu-button' });
    expect((await menu.getAttribute('aria-label')) || (await menu.textContent())?.trim(), 'the world menu must have an accessible name');
    await menu.click();
    await nav(page, 'Open world').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.sidebar')?.getBoundingClientRect().left >= -1, null, { timeout: 2000 });
    const metrics = await page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { x: Math.round(rect.x), y: Math.round(rect.y), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height), transform: style.transform, overflow: style.overflow, position: style.position };
      };
      return {
        sidebar: box('.sidebar'), navigation: box('#navigation'), firstNavButton: box('#navigation button'),
        openWorldButton: box('#navigation button[aria-label="Open world"]'), masthead: box('.masthead'),
        sessionBar: box('#session-bar'), signIn: box('#session-bar button:nth-of-type(2)'),
        createAccount: box('#session-bar button:nth-of-type(3)'), menuButton: box('#game-menu-button'),
      };
    });
    state.notes.push(`mobile menu geometry: ${describe(metrics)}`);
    expect(metrics.openWorldButton.x >= 0 && metrics.openWorldButton.right <= stage.viewportWidth,
      'the opened mobile menu must display its navigation labels inside the viewport', { actual: describe(metrics.openWorldButton) });
    expect(metrics.sessionBar.y >= metrics.masthead.y && metrics.sessionBar.bottom <= metrics.masthead.bottom,
      'the mobile account actions must fit inside the header', { actual: describe({ masthead: metrics.masthead, sessionBar: metrics.sessionBar }) });
    await page.screenshot({ path: join(RESULTS, 'game-entry-and-observation', 'mobile-menu.png') });
    return `390px phone: scene ${Math.round(stage.width)}×${Math.round(stage.height)}, world menu opened`;
  });

  return 'visitors can choose Play or Observe, explore the public world on desktop, and use its menu on a phone';
});

define('world-sound-controls', async () => {
  const visitor = await context('sound-visitor');
  const page = visitor.page;
  await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
  await settle(page);

  await step('the world starts silent until the visitor explicitly enables sound', async () => {
    await page.locator('#hero-actions').getByRole('button', { name: /Observe/i }).first().click();
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    await page.locator('#game-menu-button').click();
    const controls = page.locator('.game-audio-controls');
    await controls.waitFor({ state: 'visible' });
    const mute = controls.getByRole('button').first();
    const volume = controls.getByRole('slider', { name: 'Ambience volume' });
    const initial = {
      label: (await mute.textContent())?.trim(),
      pressed: await mute.getAttribute('aria-pressed'),
      disabled: await mute.isDisabled(),
      volume: await volume.inputValue(),
    };
    expect(initial.label === 'Enable sound' && initial.pressed === 'false' && !initial.disabled,
      'sound must be available but opt in through an explicit control', { actual: describe(initial) });
    expect(Number(initial.volume) > 0 && Number(initial.volume) <= 1,
      'the ambience volume control must expose a usable default', { actual: describe(initial) });
    await mute.click();
    await waitForCondition(async () => (await mute.textContent())?.trim() === 'Mute sound' ? true : null, 'the explicit sound gesture to start playback');
    return `initially ${initial.label}; explicit click enabled the ambience bed`;
  });

  await step('mute and volume controls are accessible and survive a reload', async () => {
    const controls = page.locator('.game-audio-controls');
    const mute = controls.getByRole('button').first();
    const volume = controls.getByRole('slider', { name: 'Ambience volume' });
    await volume.fill('0.37');
    await waitForCondition(async () => Math.abs(Number(await volume.inputValue()) - 0.37) < 0.001 ? true : null, 'the volume slider to accept the requested level');
    await mute.click();
    await waitForCondition(async () => (await mute.textContent())?.trim() === 'Sound on' ? true : null, 'the mute control to report its state');
    expect(await mute.getAttribute('aria-pressed') === 'true', 'muting must expose its state to assistive technology');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('#game-menu-button').click();
    const restored = page.locator('.game-audio-controls');
    const restoredMute = restored.getByRole('button').first();
    const restoredVolume = restored.getByRole('slider', { name: 'Ambience volume' });
    await restored.waitFor({ state: 'visible' });
    const persisted = {
      label: (await restoredMute.textContent())?.trim(),
      pressed: await restoredMute.getAttribute('aria-pressed'),
      volume: await restoredVolume.inputValue(),
    };
    expect(persisted.label === 'Enable sound' && persisted.pressed === 'true' && Math.abs(Number(persisted.volume) - 0.37) < 0.001,
      'mute and volume preferences must persist without auto-starting playback', { expected: '{ Enable sound, true, 0.37 }', actual: describe(persisted) });
    return `mute persisted as ${persisted.pressed}; volume persisted at ${persisted.volume}`;
  });

  await step('a panel keeps the world and its sound, and leaving the game stops playback and keeps sound opt in', async () => {
    // Guide is a section of the in-game panel now: the world keeps running and its controls stay.
    await openTab(page, 'Guide');
    expect(await page.locator('#world').count() === 1, 'a section must open beside the running world, not replace it');
    await page.locator('#game-menu-button').click();
    await page.locator('.game-audio-controls').waitFor({ state: 'visible' });
    expect((await page.locator('.game-audio-controls').getByRole('button').first().textContent())?.trim() === 'Enable sound',
      'opening a panel must not start sound the visitor had not enabled');
    await page.keyboard.press('Escape');
    // Leaving the game is leaving the page: the management interface has no world and no sound controls.
    await page.goto(`${baseUrl()}/manage`, { waitUntil: 'domcontentloaded' });
    expect(await page.locator('.game-audio-controls').count() === 0, 'leaving the game must remove its live sound controls');
    await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('#game-menu-button').click();
    const controls = page.locator('.game-audio-controls');
    const mute = controls.getByRole('button').first();
    await controls.waitFor({ state: 'visible' });
    expect((await mute.textContent())?.trim() === 'Enable sound',
      'returning to the game must show stopped playback and require opt in again', { actual: (await mute.textContent())?.trim() });
    return 'a panel left the world and its sound alone; leaving for /manage stopped playback and returning required an explicit enable click again';
  });

  return 'world ambience is opt in, keyboard accessible, persistent and stopped when leaving the game';
});

define('signed-in-game-play', async () => {
  const admin = await actor('admin');
  const page = admin.page;
  const player = fixtures().characters.player;
  await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (!await page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(page, ACTORS.admin);

  await step('the entry screen Play control enters as the saved human player in first person', async () => {
    // Task 38 moved the mode switch out of the quickbar and onto the entry screen, so Play is the
    // door. Play, not Continue, is what resolves the human player for this operator.
    const actions = page.locator('#hero-actions');
    await actions.waitFor({ state: 'visible' });
    const play = actions.getByRole('button', { name: 'Play', exact: true });
    await play.waitFor({ state: 'visible' });
    expect(await play.isVisible(), 'the entry screen must offer a Play control', { actual: 'no visible Play control' });
    await play.click();
    await page.waitForFunction((id) =>
      window.__nemoworld?.selected?.() === id &&
      (document.querySelector('#world-reticle')?.textContent || '').startsWith('First person'), player.id,
    { timeout: PAGE_TIMEOUT_MS });
    const stored = row('SELECT world_id,x,y,z,kind FROM agents WHERE id=?', player.id);
    expect(stored?.kind === 'human', 'Play must select the stored human player', { actual: describe(stored) });
    const arrival = await waitForCondition(() => { const saved = row('SELECT yaw,pitch,last_look FROM agents WHERE id=?', player.id); return saved.last_look > 0 ? saved : null; }, 'the first human look to be saved');
    expect(Math.abs(arrival.yaw + 3 * Math.PI / 4) < 0.001 && Math.abs(arrival.pitch + 0.08) < 0.001,
      'a new human must first face southeast along the Commons approach', { actual: describe(arrival) });
    const terrain = await page.evaluate(() => ({ drawn: window.__nemoworld?.terrainExtent?.(), world: window.__nemoworld?.world?.()?.world }));
    expect(terrain.drawn?.rows === terrain.world?.height && terrain.drawn?.columns === terrain.world?.width,
      'the first-person renderer must use the full authored world beyond the server observation viewport',
      { expected: `${terrain.world?.width}×${terrain.world?.height}`, actual: describe(terrain.drawn) });
    const canvas = page.locator('#world');
    expect(await canvas.isVisible(), 'the first-person world canvas must be visible');
    await mkdir(join(RESULTS, 'signed-in-game-play'), { recursive: true });
    await page.screenshot({ path: join(RESULTS, 'signed-in-game-play', 'desktop-play.png') });
    return `${player.name} entered ${stored.world_id} at ${stored.x},${stored.y} in first person`;
  });

  let moved = null;
  await step('a keyboard walking key changes exactly one stored tile', async () => {
    await page.locator('#world').focus();
    const before = row('SELECT world_id,x,y FROM agents WHERE id=?', player.id);
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      await page.keyboard.press(key);
      moved = await waitForCondition(() => {
        const current = row('SELECT world_id,x,y FROM agents WHERE id=?', player.id);
        return current.world_id === before.world_id && Math.abs(current.x - before.x) + Math.abs(current.y - before.y) === 1 ? current : null;
      }, `a keyboard ${key} step to be saved`, { timeout: 1800, interval: 100 }).catch(() => null);
      if (moved) break;
    }
    expect(moved, 'one keyboard walking direction must move the human player one tile', { expected: `one step from ${before.x},${before.y}`, actual: describe(row('SELECT world_id,x,y FROM agents WHERE id=?', player.id)) });
    await page.waitForFunction(([x,y]) => (document.querySelector('#world-reticle')?.textContent || '').includes(`at ${x}, ${y}`), [moved.x, moved.y], { timeout: PAGE_TIMEOUT_MS });
    return `${before.x},${before.y} → ${moved.x},${moved.y} saved in the database`;
  });

  await step('nearby residents have projected public nameplates while first person hides the player', async () => {
    const selfLabel = page.locator(`.voxel-nameplate[data-participant-id="${player.id}"]`);
    expect(await selfLabel.count() === 0, 'first person must omit the local player from its scene labels');
    const mode = page.getByRole('button', { name: 'First person camera that follows your resident' });
    await mode.click();
    const other = page.locator(`.voxel-nameplate[data-participant-id="${fixtures().characters.pathfinder.id}"]`);
    await other.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const label = (await other.textContent())?.trim() || '';
    expect(label.includes('Pathfinder') && label.includes('AI resident'),
      'an observed AI resident must have a public name and role attached to the live 3D scene', { actual: label });
    await mode.click();
    await page.waitForFunction(() => (document.querySelector('#world-reticle')?.textContent || '').startsWith('First person'), null, { timeout: PAGE_TIMEOUT_MS });
    return 'the orbit view showed Pathfinder as an AI resident; first person omitted the local player';
  });

  await step('Chat and More reveal the existing world tools from the game HUD', async () => {
    const hud = page.locator('#game-hud');
    await hud.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.gameDrawer === 'chat', null, { timeout: PAGE_TIMEOUT_MS });
    await page.locator('#world-chat-card').waitFor({ state: 'visible' });
    await hud.getByRole('button', { name: 'More', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.gameDrawer === 'tools', null, { timeout: PAGE_TIMEOUT_MS });
    await page.locator('.world-aside').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Close world tools', exact: true }).click();
    expect(await page.evaluate(() => document.body.dataset.gameDrawer) === '', 'the tools drawer must close through its own visible control');
    return 'Chat and More opened the existing world panels; Close returned to the scene';
  });

  await step('a reload returns to the same human player and server-saved tile', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    const selected = await page.evaluate(() => window.__nemoworld?.selected?.());
    const current = row('SELECT world_id,x,y FROM agents WHERE id=?', player.id);
    const shown = (await page.locator('#game-coordinates').textContent())?.trim();
    expect(selected === player.id, 'reload must restore the selected human player', { expected: player.id, actual: selected });
    expect(current.world_id === moved.world_id && current.x === moved.x && current.y === moved.y,
      'reload must retain the server-saved world and tile', { expected: describe(moved), actual: describe(current) });
    expect(shown === `${current.x}, ${current.y}`, 'the game HUD must show the saved tile after reload', { expected: `${current.x}, ${current.y}`, actual: shown });
    const aim = (await page.locator('#world-reticle').textContent())?.trim() || '';
    expect(aim.startsWith('First person'), 'the same tab must restore first-person play after reload', { actual: aim.slice(0, 180) });
    expect(aim.includes('facing south-east'), 'the server-saved human facing must survive reload', { actual: aim.slice(0, 180) });
    return `${player.name} restored at ${current.world_id}:${current.x},${current.y}`;
  });

  await step('the human quickbar remains tappable on a phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.locator('.nm-touch-floating').waitFor({ state: 'visible' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.locator('#game-hud').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('.sidebar')?.getBoundingClientRect().right <= 2, null, { timeout: 2000 });
      const controls = await page.locator('#game-hud .game-quickbar button').evaluateAll((buttons) => buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { label: button.textContent?.trim(), x: Math.round(box.x), right: Math.round(box.right), y: Math.round(box.y), height: Math.round(box.height) };
      }));
      // The game-experience specification keeps the HUD at five actions: the mode switch moved to
      // the world menu, so the quickbar is Interact, Build, Chat, Places, More.
      expect(controls.length === 5, 'the phone quickbar must carry exactly the five world actions', { actual: describe(controls) });
      expect(controls.every((control) => control.x >= 0 && control.right <= 390 && control.height >= 40),
        'every phone quickbar action must fit the screen with a tappable height', { actual: describe(controls) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'the signed-in game must fit a 390px phone without sideways scrolling');
      const pad = page.locator('.nm-touch-floating');
      await pad.waitFor({ state: 'visible' });
      expect(await page.locator('.world-bottom').isVisible() === false,
        'the compact touch pad must replace, not overlap, the legacy arrow controls');
      const targets = await pad.locator('button').evaluateAll((buttons) => buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const atCenter = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { label: button.getAttribute('aria-label'), disabled: button.disabled, x: Math.round(box.x), right: Math.round(box.right), y: Math.round(box.y), bottom: Math.round(box.bottom), width: Math.round(box.width), height: Math.round(box.height), reachable: button === atCenter || button.contains(atCenter) };
      }));
      expect(targets.length === 11 && targets.every((target) => target.x >= 0 && target.right <= 390 && target.y >= 60 && target.bottom <= 844 && target.width >= 44 && target.height >= 44),
        'every phone movement, camera and action target must be visible and tappable', { actual: describe(targets) });
      expect(targets.every((target) => target.reachable), 'no guide, map control or HUD may cover a phone touch target', { actual: describe(targets.filter((target) => !target.reachable)) });
      const bands = await page.evaluate(() => ({ touch: document.querySelector('.nm-touch-floating').getBoundingClientRect().bottom, hud: document.querySelector('.game-hud-bottom').getBoundingClientRect().top }));
      expect(bands.touch < bands.hud, 'the phone touch controls must end above the five-action HUD', { actual: describe(bands) });
      state.notes.push(`phone play layout: ${describe(await page.evaluate(() => {
        const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), overflow: getComputedStyle(node).overflow }; };
        return { guide: box('.game-guide'), guideNext: box('.game-guide-next'), guideOther: box('.game-guide-card:not(.game-guide-next)'), touch: box('.nm-touch-floating'), hud: box('.game-hud-bottom') };
      }))}`);
      const yawBefore = row('SELECT yaw FROM agents WHERE id=?', player.id).yaw;
      await pad.getByRole('button', { name: 'Turn the camera left' }).click();
      const yawAfter = await waitForCondition(() => {
        const saved = row('SELECT yaw FROM agents WHERE id=?', player.id).yaw;
        return saved !== yawBefore ? saved : null;
      }, 'the visible phone camera control to save a new facing');
      const tileBefore = row('SELECT x,y FROM agents WHERE id=?', player.id);
      let touchStep = null;
      for (const direction of ['up', 'left', 'down', 'right']) {
        await pad.getByRole('button', { name: `Move ${direction}` }).click();
        touchStep = await waitForCondition(() => {
          const saved = row('SELECT x,y FROM agents WHERE id=?', player.id);
          return Math.abs(saved.x - tileBefore.x) + Math.abs(saved.y - tileBefore.y) === 1 ? saved : null;
        }, `a visible phone ${direction} step to be stored`, { timeout: 700, interval: 100 }).catch(() => null);
        if (touchStep) break;
      }
      expect(touchStep, 'one of the four visible phone movement buttons must save exactly one tile', { actual: describe(row('SELECT x,y FROM agents WHERE id=?', player.id)) });
      await page.screenshot({ path: join(RESULTS, 'signed-in-game-play', 'mobile-play.png') });
      return `five quickbar actions and ten touch targets fit a 390px phone; Look saved yaw ${yawBefore.toFixed(2)} → ${yawAfter.toFixed(2)}, and Move saved ${tileBefore.x},${tileBefore.y} → ${touchStep.x},${touchStep.y}`;
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  return 'the human player used the game HUD, walked by keyboard, and returned to the saved world position';
});

// Live observation. A visitor with no account and no resident reads the public world through the
// read-only transport, sees the residents the server published, and cannot build or act for anyone.
define('live-observation-readonly', async () => {
  const visitor = await context('observer-visitor');
  const page = visitor.page;
  const walker = fixtures().characters.walker;
  // Put a resident in the Commons where the observer's opening window looks, so "public activity"
  // is a real stored position and not an assumption.
  write('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', 'commons', 11, 7, walker.id);
  const messageSequence = row('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').n;
  const objectSequence=row('SELECT COALESCE(MAX(rowid),0) AS n FROM world_objects').n;
  const before = { tile: row('SELECT world_id,x,y FROM agents WHERE id=?', walker.id), blocks: count('SELECT COUNT(*) FROM frontier_blocks'), messages: rows('SELECT * FROM messages WHERE rowid<=? ORDER BY rowid',messageSequence), objects: rows('SELECT * FROM world_objects WHERE rowid<=? ORDER BY rowid',objectSequence) };

  await step('the anonymous observer enters the Commons through Observe', async () => {
    await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const actions = page.locator('#hero-actions');
    await actions.waitFor({ state: 'visible' });
    await actions.getByRole('button', { name: 'Observe', exact: true }).click();
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    expect(await page.evaluate(() => document.body.classList.contains('signed-in')) === false, 'observation must need no account');
    const observed = await page.evaluate(() => ({ world: window.__nemoworld?.worldId?.(), mode: window.__nemoworld?.gameMode?.(), selected: window.__nemoworld?.selected?.() }));
    expect(observed.world === 'commons' && observed.mode === 'observe' && !observed.selected, 'Observe must load the public world with no resident selected', { actual: describe(observed) });
    return 'the visitor observed commons with no session and no resident';
  });

  await step('the observer sees the public activity the server published, and its own connection state', async () => {
    const spectator = await waitForCondition(async () => {
      const view = await page.evaluate(() => window.__nemoworld?.spectator?.() || null);
      return view && view.residents.length ? view : null;
    }, 'the spectator view to publish the residents the server returned');
    expect(spectator.status.live === false, 'an anonymous visitor holds no live channel, and the status says so', { actual: describe(spectator.status) });
    expect(typeof spectator.status.detail === 'string' && spectator.status.detail.length > 0, 'the observer is told what its connection is');
    const seen = spectator.residents.find((resident) => resident.id === walker.id);
    expect(seen && seen.x === 11 && seen.y === 7, 'the observer must see the resident at its stored tile', { expected: '11, 7', actual: describe(spectator.residents) });
    const line = (await page.locator('#game-observer-status').textContent())?.trim() || '';
    expect(line.length > 0, 'the HUD must carry the observer status line', { actual: line });
    return `the spectator published ${spectator.residents.length} public residents from the snapshot`;
  });

  await step('the observer can follow a resident and pan, and every attempt to act is refused', async () => {
    const select = page.locator('#observer-follow');
    await select.waitFor({ state: 'visible' });
    await select.selectOption(walker.id);
    const following = await waitForCondition(async () => {
      const view = await page.evaluate(() => window.__nemoworld?.spectator?.() || null);
      return view?.following === walker.id ? view : null;
    }, 'the observer to follow the resident');
    expect(following.target.x === 11 && following.target.y === 7, 'following targets the resident’s stored tile', { actual: describe(following.target) });
    const cameraBefore = following.camera;
    await page.locator('.game-observer-controls').getByRole('button', { name: 'Pan right', exact: true }).click();
    const panned = await waitForCondition(async () => {
      const view = await page.evaluate(() => window.__nemoworld?.spectator?.() || null);
      return view && view.camera.x === cameraBefore.x + 1 ? view : null;
    }, 'the observer camera to pan one tile without a resident');
    expect(panned.following === null, 'a pan ends the follow: the camera has one target owner');
    expect(panned.target.x === panned.camera.x && panned.target.y === panned.camera.y, 'with no follow, the camera target is the observer’s own tile', { actual: describe(panned.target) });

    // Four writes from the observer's own page, including one acting as the resident in the world.
    const refusals = {};
    for (const [path, body] of [['/move', { agent_id: walker.id, direction: 'right' }], ['/messages', { text: 'a visitor cannot speak for anyone', world_id: 'commons' }], ['/frontier/build', { world_id: 'frontier:0:0', x: 1, y: 1, z: 0, type: 'wood' }], ['/interact', { agent_id: walker.id, x: 11, y: 7, action: 'travel' }]]) {
      refusals[path] = (await inPage(page, path, { body })).status;
    }
    expect(Object.values(refusals).every((status) => status >= 400), 'no observation write may be accepted', { actual: describe(refusals) });
    const build = page.locator('#game-build-button');
    await build.click();
    const refusal = (await page.locator('#notice').textContent())?.trim() || '';
    expect(/read-only/i.test(refusal), 'the observer’s Build control must refuse in the server’s own terms', { actual: refusal });
    return `follow then pan; writes refused: ${describe(refusals)}`;
  });

  await step('observation changed nothing in the database', async () => {
    expect(describe(row('SELECT world_id,x,y FROM agents WHERE id=?', walker.id)) === describe(before.tile), 'the watched resident must not move', { expected: describe(before.tile), actual: describe(row('SELECT world_id,x,y FROM agents WHERE id=?', walker.id)) });
    expect(count('SELECT COUNT(*) FROM frontier_blocks') === before.blocks, 'no block may be stored by an observer');
    expect(describe(rows('SELECT * FROM messages WHERE rowid<=? ORDER BY rowid',messageSequence)) === describe(before.messages), 'observation cannot change any existing message');
    const newMessages=rows('SELECT m.agent_id,m.account_id,m.text,a.operator_id FROM messages m LEFT JOIN agents a ON a.id=m.agent_id WHERE m.rowid>?',messageSequence);
    const livingIds=new Set(LIVING_ROSTER.map(resident=>resident.id));
    expect(newMessages.every(message=>livingIds.has(message.agent_id)&&message.account_id===message.operator_id), 'any concurrent message must be attributed to the independent living-world tick, never the anonymous observer');
    expect(count("SELECT COUNT(*) FROM messages WHERE text='a visitor cannot speak for anyone'")===0,'the refused anonymous message must not be saved');
    expect(describe(rows('SELECT * FROM world_objects WHERE rowid<=? ORDER BY rowid',objectSequence))===describe(before.objects), 'observation cannot change any existing object');
    const newObjects=rows('SELECT id,world_id,type,x,y FROM world_objects WHERE rowid>?',objectSequence);
    expect(newObjects.every(object=>object.id==='lw-aria-farm-3-3'&&object.world_id==='home:lw-aria'&&object.type==='farm'&&object.x===3&&object.y===3),'the only concurrent object allowed is the exact starter farm independently seeded by the living-world tick',{actual:describe(newObjects)});
    return `resident tile, blocks, prior objects and prior messages unchanged; ${newMessages.length} messages and ${newObjects.length} exact starter farms came only from the server's living-world tick, and the anonymous message was not saved`;
  });

  await step('a signed-in observer sees only public conversation and public resident fields', async () => {
    const owner = await actor('owner');
    const steward = fixtures().characters.steward;
    const secret = 'Private note hidden from observation mode';
    await apiExpect(fixtures().owner, 'POST', '/messages', { agent_id: walker.id, channel: 'private', recipient_id: steward.id, text: secret }, [200]);
    await openApp(owner.page, ACTORS.owner);
    await owner.page.evaluate(() => sessionStorage.setItem('nemoworld-game-mode', 'entry'));
    await owner.page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(owner.page);
    await owner.page.locator('#hero-actions').getByRole('button', { name: 'Observe', exact: true }).click();
    await owner.page.locator('#game-hud').waitFor({ state: 'visible' });
    const observed = await owner.page.evaluate((residentId) => ({ messages: window.__nemoworld.world().messages, resident: window.__nemoworld.world().participants.find((item) => item.id === residentId) }), walker.id);
    expect(!observed.messages.some((message) => message.text === secret), 'private conversation must not enter the observer view model', { actual: describe(observed.messages.map((message) => message.text)) });
    expect(observed.resident && observed.resident.operator_id === undefined && observed.resident.capabilities === undefined, 'even an owned resident is shown through public fields while observing', { actual: describe(observed.resident) });
    expect(!(await owner.page.locator('#view').textContent()).includes(secret), 'private conversation must not appear in the observer UI');
    expect(await owner.page.locator('#world-chat-card form').count() === 0, 'observation offers no Send message form');
    return 'the signed-in observer saw public residents without private messages or a write form';
  });

  return 'anonymous and signed-in observation stayed public and read-only';
});

// The game shell. The three entry controls, the five-action HUD, the drawers and the character
// overlay, each asserted against the server rather than against a rendered string.
define('game-shell-entry-and-continue', async () => {
  const visitor = await context('shell-first-visitor');
  const operator = await context('shell-admin');
  const page = operator.page;
  const pathfinder = fixtures().characters.pathfinder;

  await step('a first-time visitor sees Play and Observe, and the film as a text link', async () => {
    await visitor.page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(visitor.page);
    const actions = visitor.page.locator('#hero-actions');
    await actions.waitFor({ state: 'visible' });
    const labels = (await actions.getByRole('button').allTextContents()).map((label) => label.trim());
    expect(labels.includes('Play') && labels.includes('Observe'), 'a first-time visitor must see Play and Observe', { actual: describe(labels) });
    expect(!labels.some((label) => label.startsWith('Continue')), 'Continue must be absent when there is nothing to continue', { actual: describe(labels) });
    expect(await actions.locator('a.game-film-link').count() === 1, 'the film must be a text link under the controls');
    expect((await visitor.page.locator('#game-hud').count()) === 0 || !await visitor.page.locator('#game-hud').isVisible(), 'the HUD must be hidden on the entry screen');
    return `the entry screen offered ${describe(labels)}`;
  });

  await step('Continue enters the world as the character this browser remembers', async () => {
    await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await signIn(page, ACTORS.admin);
    await page.evaluate((id) => { localStorage.setItem('selected-agent', id); sessionStorage.setItem('nemoworld-game-mode', 'entry'); }, pathfinder.id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    const actions = page.locator('#hero-actions');
    await actions.getByRole('button', { name: new RegExp('^Continue as ') }).waitFor({ state: 'visible' });
    const label = (await actions.getByRole('button', { name: new RegExp('^Continue as ') }).textContent())?.trim() || '';
    expect(label.includes(pathfinder.name), 'Continue must name the remembered character', { expected: pathfinder.name, actual: label });
    await actions.getByRole('button', { name: new RegExp('^Continue as ') }).click();
    await page.locator('#game-hud').waitFor({ state: 'visible' });
    const entered = await waitForCondition(async () => {
      const state_ = await page.evaluate(() => ({ selected: window.__nemoworld?.selected?.(), mode: window.__nemoworld?.gameMode?.() }));
      return state_.selected === pathfinder.id && state_.mode === 'play' ? state_ : null;
    }, 'Continue to enter the world as the remembered character');
    expect(entered.selected === pathfinder.id, 'Continue must select the remembered character server-side', { actual: describe(entered) });
    return `Continue entered as ${pathfinder.name}`;
  });

  await step('the HUD carries the five actions, and one drawer opens at a time', async () => {
    const hud = page.locator('#game-hud');
    const controls = await hud.locator('.game-quickbar button').allTextContents();
    expect(describe(controls.map((label) => label.trim())) === describe(['Interact', 'Build', 'Chat', 'Places', 'More']),
      'the HUD must carry exactly the five world actions, with the mode switch moved to the world menu', { actual: describe(controls) });
    await hud.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.waitForFunction(() => window.__nemoworld?.drawer?.() === 'chat', null, { timeout: PAGE_TIMEOUT_MS });
    await hud.getByRole('button', { name: 'More', exact: true }).click();
    await page.waitForFunction(() => window.__nemoworld?.drawer?.() === 'tools', null, { timeout: PAGE_TIMEOUT_MS });
    expect(await page.evaluate(() => document.body.dataset.gameDrawer) === 'tools', 'opening a second drawer must close the first');
    // The Journal, Inventory and Projects drawers read the server payloads and name their fields.
    for (const [name, id] of [['Journal', '#world-journal-card'], ['Inventory', '#world-inventory-card'], ['Projects', '#world-projects-card']]) {
      expect(await page.locator(id).count() === 1, `the ${name} drawer must exist in the world tools`);
    }
    expect((await page.locator('#world-inventory-card').textContent()).includes('On the shelf'), 'the Inventory drawer must render the shelf the server returned');
    await page.getByRole('button', { name: 'Close world tools', exact: true }).click();
    expect(await page.evaluate(() => document.body.dataset.gameDrawer) === '', 'the labelled Close must dismiss the drawer');
    return 'five HUD actions; Chat then More left exactly one drawer open, and its own Close dismissed it';
  });

  await step('the character overlay creates a resident, and the database gains exactly that row', async () => {
    const before = count('SELECT COUNT(*) FROM agents');
    // The character overlay opens from the world aside's own control.
    await page.locator('#game-hud').getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Choose a character…', exact: true }).click();
    const dialog = page.locator('#character-dialog');
    await dialog.waitFor({ state: 'visible' });
    expect(await dialog.evaluate((node) => node.open), 'the character overlay must be an open native dialog');
    const listed = await dialog.locator('.record h3').allTextContents();
    expect(listed.includes(pathfinder.name), 'the overlay must list the operator’s own characters from GET /me', { actual: describe(listed) });
    const form = dialog.locator('form[data-draft-section="character-create"]');
    await form.locator('[aria-label="Character name"]').fill('Overlay newcomer');
    await form.getByRole('button', { name: 'Create character', exact: true }).click();
    const created = await waitForCondition(async () => row("SELECT id,kind,status FROM agents WHERE name='Overlay newcomer'"), 'the overlay to create exactly one stored character');
    expect(created.kind === 'agent' && created.status === 'active', 'the created row must be the kind the form chose', { actual: describe(created) });
    expect(count('SELECT COUNT(*) FROM agents') === before + 1, 'the overlay must create exactly one character', { expected: `${before + 1}`, actual: `${count('SELECT COUNT(*) FROM agents')}` });
    // The row is stored before the shell finishes re-reading the world, so wait for the overlay to
    // close rather than reading its state the instant the database row appears.
    const closed = await waitForCondition(async () => await dialog.evaluate((node) => node.open) === false ? true : null,
      'the character overlay to close after a successful creation').then(() => true).catch(() => false);
    expect(closed, 'a successful creation must close the overlay', { actual: `open=${await dialog.evaluate((node) => node.open)} notice=${(await page.locator('#notice').textContent())?.trim()}` });
    const entered = await waitForCondition(async () => {
      const selected = await page.evaluate(() => window.__nemoworld?.selected?.());
      return selected === created.id ? selected : null;
    }, 'the world to enter as the character the overlay created');
    expect(entered === created.id, 'creating a character must enter the world as it', { expected: created.id, actual: entered });
    return `the overlay listed ${listed.length} residents and stored one new character, entering as it`;
  });

  return 'Play, Observe and Continue are the entry door, the HUD carries five actions, and the character overlay creates a stored resident';
});

/**
 * Everything the page says about which section is on screen and what the client state holds, in one
 * read: the menu section, the marked current section, the rendered heading, whether the world view is
 * the mounted one, the calling story the opened section rendered, the resident the world payload was
 * read for, and whether the selection control still reports itself busy. The suite already reads this
 * surface in other scenarios; gathering it once keeps this scenario's failure evidence complete.
 */
const pageSectionFacts = (page) => page.evaluate(() => {
  const world = window.__nemoworld?.world?.() || null;
  return {
    section: (document.querySelector('#toggle-navigation')?.textContent || '').replace(/^Menu · /, ''),
    current: document.querySelector('#navigation button[aria-current="page"]')?.getAttribute('aria-label') || null,
    heading: (document.querySelector('#view h2')?.textContent || '').trim(),
    worldView: Boolean(document.querySelector('#view #world-overview')),
    story: (document.querySelector('#view .calling-story')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    selected: window.__nemoworld?.selected?.() || null,
    viewer: world?.viewer_agent_id ?? null,
    loadedWorldId: world?.world?.id ?? null,
    controlBusy: window.__selectionRaceControl ? window.__selectionRaceControl.hasAttribute('aria-busy') : null,
  };
});

// "Enter as this character" awaits the resident's own world read and then opens the world view. A
// section the operator opens while that read is in flight must win. This scenario widens the await
// deterministically — the world read is held open with a route until the scenario releases it — rather
// than racing it, and pins both halves: the opened section survives, and the plain click still enters.
define('selection-does-not-clobber-navigation', async () => {
  const operator = await context('selection-race-operator');
  const page = operator.page;
  const unchangedAgent = fixtures().characters.wanderer;
  const racingAgent = fixtures().characters.pathfinder;
  let releaseHeldRead = () => {};

  /** The one "Enter as this character" control in that character's own row on My characters. */
  const enterControl = async (agent) => {
    await openSectionNamed(page, 'My characters');
    const record = page.locator('#view .record', { hasText: agent.name }).first();
    await record.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const control = record.getByRole('button', { name: 'Enter as this character', exact: true });
    const count = await control.count();
    expect(count === 1, `“Enter as this character” must be offered for ${agent.name}`, { expected: 'one control', actual: `${count} controls` });
    return control;
  };

  const storedWorld = (agent) => row('SELECT world_id FROM agents WHERE id=?', agent.id).world_id;

  try {
    await step('with nothing else opened, entering as a character still lands in that character’s world', async () => {
      await openApp(page, ACTORS.admin);
      const control = await enterControl(unchangedAgent);
      const expectedWorld = storedWorld(unchangedAgent);
      await control.click();
      // The world tab is set only by this control's own trailing render, so a world section with the
      // resident's payload is the control having run its intended path with no other navigation.
      const shown = await waitForCondition(async () => {
        const facts = await pageSectionFacts(page);
        return facts.section === 'Open world' && facts.worldView && facts.selected === unchangedAgent.id && facts.viewer === unchangedAgent.id ? facts : null;
      }, `entering as ${unchangedAgent.name} to open its world`, { timeout: 30_000 });
      expect(shown.current === 'Open world', 'the navigation must mark the world as the current section', { expected: 'Open world', actual: describe(shown.current) });
      expect(shown.loadedWorldId === expectedWorld, 'the world view must carry that character’s own world', { expected: expectedWorld, actual: describe({ loaded: shown.loadedWorldId, viewer: shown.viewer }) });
      return `${unchangedAgent.name} entered ${expectedWorld} and the world view is the mounted one`;
    });

    await step('a section opened while the character’s world read is still in flight survives the selection', async () => {
      const control = await enterControl(racingAgent);
      const expectedWorld = storedWorld(racingAgent);
      // The section the operator opens carries the selected resident's calling payload, so the same
      // read is taken here over the API: the rendered card has to name this calling, not just a name
      // that happened to be on screen.
      const calling = (await apiExpect(fixtures().admin, 'GET', `/callings?agent_id=${racingAgent.id}`)).calling.name;
      // Hold open the exact read this control awaits, and nothing else: a later read for the same
      // resident passes straight through rather than queueing behind the held one.
      let arrived = false;
      let letGo = () => {};
      const held = new Promise((resolve) => { letGo = resolve; });
      releaseHeldRead = () => { letGo(); };
      await page.route((url) => url.pathname === '/api/v1/world' && url.searchParams.get('agent_id') === racingAgent.id, async (route) => {
        if (arrived) return route.continue();
        arrived = true;
        await held;
        await route.continue();
      });
      await control.click();
      await waitForCondition(() => arrived ? true : null, `the world read ${racingAgent.name}’s selection awaits`, { timeout: 15_000, interval: 25 });
      // The control is busy for the whole handler and clears that mark in a `finally` after the
      // handler's trailing render, so this node is the page's own statement that the selection has
      // not finished yet — and later, that it has, render included.
      await waitForCondition(() => page.evaluate((name) => {
        const record = [...document.querySelectorAll('#view .record')].find((node) => (node.textContent || '').includes(name));
        const button = record?.querySelector('button[aria-busy="true"]');
        if (button) window.__selectionRaceControl = button;
        return Boolean(button);
      }, racingAgent.name), 'the selection control to report itself busy while its read is held', { timeout: 5_000, interval: 25 });
      // The await is provably open here: open a different section inside it.
      await openSectionNamed(page, 'Callings & guilds');
      const opened = await pageSectionFacts(page);
      expect(opened.section === 'Callings & guilds' && opened.current === 'Callings & guilds' && /Every resident has a calling/.test(opened.heading),
        'the operator must be able to open another section while the selection is still running',
        { expected: 'the Callings & guilds section and its heading', actual: describe({ section: opened.section, current: opened.current, heading: opened.heading }) });
      expect(opened.controlBusy === true, 'the selection must still be running when the other section is opened', { expected: 'the control still busy', actual: describe({ controlBusy: opened.controlBusy, selected: opened.selected }) });
      expect(opened.story.includes(racingAgent.name) && opened.story.includes(calling), 'the opened section must already carry the selected resident’s own calling payload', { expected: `${racingAgent.name} and the calling ${calling}`, actual: describe(opened.story) });
      releaseHeldRead();
      const settled = await waitForCondition(async () => {
        const facts = await pageSectionFacts(page);
        return facts.controlBusy === false && facts.viewer === racingAgent.id ? facts : null;
      }, `the selection of ${racingAgent.name} to finish after the delayed world read`, { timeout: 30_000, interval: 100 });
      expect(settled.section === 'Callings & guilds' && settled.current === 'Callings & guilds',
        'the section the operator opened must still be the visible one when the selection finishes',
        { expected: 'Callings & guilds still current', actual: describe({ section: settled.section, current: settled.current, heading: settled.heading }) });
      expect(/Every resident has a calling/.test(settled.heading), 'the opened section’s own heading must still be rendered', { expected: 'Every resident has a calling', actual: describe(settled.heading) });
      expect(!settled.worldView, 'the world view must not have replaced the opened section', { expected: 'no world view mounted', actual: describe({ worldView: settled.worldView, heading: settled.heading }) });
      expect(settled.selected === racingAgent.id, 'the selection itself must still have landed', { expected: racingAgent.id, actual: describe(settled.selected) });
      expect(settled.loadedWorldId === expectedWorld, 'the delayed world read must be the payload the page holds', { expected: `${expectedWorld} read for ${racingAgent.id}`, actual: describe({ loaded: settled.loadedWorldId, viewer: settled.viewer }) });
      return `the ${racingAgent.name} world read was held open, Callings & guilds was opened inside it, and the section was still mounted when the selection finished`;
    });

    return 'a section opened during a character selection stays; with nothing opened the same control still enters the world';
  } finally {
    // The held read is released and the interception removed with the scenario even when a step
    // fails, so no later scenario can inherit either one.
    releaseHeldRead();
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  }
});

// The management interface: one role-gated entry out of the newcomer's path, and the same governance
// sections in full behind it. The client gate only decides what is rendered; the server refuses a
// privileged route to a member regardless.
define('management-interface-and-roles', async () => {
  const member = await actor('owner');
  const operator = await context('manage-operator');

  await step('a member never sees a management entry in the game menu', async () => {
    await member.page.goto(`${baseUrl()}/?mode=workspace`, { waitUntil: 'domcontentloaded' });
    await settle(member.page);
    if (!await member.page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(member.page, ACTORS.owner);
    await member.page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(member.page);
    await member.page.locator('#game-menu-button').click();
    await nav(member.page, 'Guide').waitFor({ state: 'visible' });
    const labels = (await member.page.locator('#navigation button').allTextContents()).map((label) => label.trim());
    expect(!labels.includes('Management'), 'a member must not see the management entry', { actual: describe(labels) });
    for (const hidden of ['Review', 'Mission studio', 'Administration']) expect(!labels.includes(hidden), `${hidden} must leave the newcomer's path`, { actual: describe(labels) });
    expect(await member.page.locator('.tabs button[aria-label="Safety"]').count() === 0, 'governance decisions leave the game menu; reporting does not');
    return 'the member game menu held no governance or management entry';
  });

  await step('/manage serves the workspace presentation with the governance sections', async () => {
    await operator.page.goto(`${baseUrl()}/manage`, { waitUntil: 'domcontentloaded' });
    await settle(operator.page);
    if (!await operator.page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(operator.page, ACTORS.admin);
    await operator.page.goto(`${baseUrl()}/manage`, { waitUntil: 'domcontentloaded' });
    await settle(operator.page);
    expect(await operator.page.evaluate(() => document.body.classList.contains('game-world')) === false, '/manage must open the management presentation, not the game shell');
    const labels = (await operator.page.locator('#navigation button').allTextContents()).map((label) => label.trim());
    for (const shown of ['Review', 'Mission studio', 'Safety', 'Administration']) expect(labels.includes(shown), `${shown} must be offered in /manage`, { actual: describe(labels) });
    await openTab(operator.page, 'Administration');
    expect((await operator.page.locator('#view').textContent()).length > 0, 'the administration section must render for an administrator');
    return `the management presentation offered ${describe(labels.filter((label) => ['Review', 'Mission studio', 'Safety', 'Administration'].includes(label)))}`;
  });

  await step('the management entry is offered to a privileged role in the game menu', async () => {
    await operator.page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await settle(operator.page);
    await operator.page.locator('#game-menu-button').click();
    await nav(operator.page, 'Guide').waitFor({ state: 'visible' });
    const labels = (await operator.page.locator('#navigation button').allTextContents()).map((label) => label.trim());
    expect(labels.includes('Management'), 'an administrator must be offered exactly one management entry', { actual: describe(labels) });
    for (const hidden of ['Review', 'Mission studio', 'Administration']) expect(!labels.includes(hidden), `${hidden} must stay behind /manage even for an administrator`, { actual: describe(labels) });
    return 'the administrator game menu held one Management entry and no governance group';
  });

  return '/manage hosts the governance surfaces; a member never sees the entry and an administrator sees exactly one';
});

// Private memory and the private journal. Another operator of the same world sees nothing, and a
// sibling character of the same operator does not leak it through a runtime credential either.
define('private-memory-and-journal-boundaries', async () => {
  const owner = await actor('owner');
  const page = owner.page;
  // Walker already has an operator-approved fact from shared-build-and-restart. Use the untouched
  // steward as the subject so this scenario owns exactly one active fact and one journal entry.
  const subject = fixtures().characters.steward, siblingResident = fixtures().characters.walker;
  const secret = 'A private purpose the acceptance run wrote.';

  await step('the operator records a private purpose and the resident holds a private journal note', async () => {
    const recorded = await apiExpect(fixtures().owner, 'POST', '/memory/manage', { action: 'record', agent_id: subject.id, kind: 'purpose', attribute: 'intent', value: secret });
    expect(recorded.fact?.id, 'the operator must be able to record a memory fact', { actual: describe(recorded) });
    // A record made by the owning operator is decided at write time; a resident proposal is not.
    expect(count("SELECT COUNT(*) FROM resident_memory WHERE agent_id=? AND state='active'", subject.id) === 1, 'exactly one active fact must be stored', { actual: describe(rows('SELECT state FROM resident_memory WHERE agent_id=?', subject.id)) });
    await apiExpect(fixtures().owner, 'POST', '/journey/journal', { agent_id: subject.id, text: secret });
    expect(count('SELECT COUNT(*) FROM journey_journal WHERE agent_id=?', subject.id) === 1, 'exactly one private journal entry must be stored', { actual: `${count('SELECT COUNT(*) FROM journey_journal WHERE agent_id=?', subject.id)}` });
    return 'one operator-recorded memory fact and one private journal entry stored for the subject resident';
  });

  await step('the owning operator reads it, and the resident’s own credential reads only its own record', async () => {
    const owned = await apiRequest(`/memory?agent_id=${subject.id}`, { token: fixtures().owner.token });
    expect(owned.status === 200 && owned.body.facts.some((fact) => fact.value === secret), 'the owning operator must read the approved purpose', { actual: `HTTP ${owned.status}` });
    expect(JSON.stringify(owned.body).includes(secret), 'the operator’s own read must carry the stored value');
    return 'the own-operator read returned the stored fact';
  });

  await step('another operator and a sibling character are both refused', async () => {
    const stranger = await apiRequest(`/memory?agent_id=${subject.id}`, { token: fixtures().stranger.token });
    expect(stranger.status === 404, 'another operator must see nothing at all', { actual: `HTTP ${stranger.status} ${describe(stranger.body)}` });
    expect(JSON.stringify(stranger.body).includes(secret) === false, 'no other-operator response may carry the value');
    const sibling = await apiExpect(fixtures().owner, 'POST', '/runtime/start', { agent_id: siblingResident.id, minutes: 5, max_calls: 20, scopes: ['read', 'contribute'] });
    const leaked = await apiRequest(`/memory?agent_id=${subject.id}`, { token: sibling.token });
    expect(leaked.status === 404, 'a sibling character must not read another resident’s memory', { actual: `HTTP ${leaked.status} ${describe(leaked.body)}` });
    expect(JSON.stringify(leaked.body).includes(secret) === false, 'a sibling read may not carry the value');
    const self = await apiRequest('/memory', { token: sibling.token });
    expect(self.status === 200 && self.body.agent_id === siblingResident.id, 'a runtime credential reads exactly its own resident', { actual: describe(self.body?.agent_id) });
    expect(JSON.stringify(self.body).includes(secret) === false, 'the sibling’s own record must not contain the subject resident’s fact');
    // The private journal is operator-only: a sibling credential and an anonymous visitor are refused.
    const journal = await apiRequest(`/journey?agent_id=${subject.id}`, { token: sibling.token });
    expect(journal.status >= 400, 'a sibling credential must not read another resident’s journey', { actual: `HTTP ${journal.status}` });
    const anonymous = await apiRequest(`/journey?agent_id=${subject.id}`);
    expect(anonymous.status >= 400, 'the private journal is never public', { actual: `HTTP ${anonymous.status}` });
    return `another operator ${stranger.status}, sibling credential ${leaked.status}, journey ${journal.status}/${anonymous.status}`;
  });

  await step('the resident’s own operator page shows the fact and another operator’s page does not', async () => {
    await page.goto(`${baseUrl()}/?mode=workspace`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    if (!await page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(page, ACTORS.owner);
    await openTab(page, 'Callings & guilds');
    await openWorldAs(page, subject.id);
    await openTab(page, 'Callings & guilds');
    const shown = await page.locator('#view').textContent();
    expect(shown.includes(secret), 'the owning operator must see the approved purpose', { actual: 'the value is absent from the owner’s view' });
    const outsider = await context('stranger');
    await outsider.page.goto(`${baseUrl()}/?mode=workspace`, { waitUntil: 'domcontentloaded' });
    await settle(outsider.page);
    if (!await outsider.page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(outsider.page, ACTORS.stranger);
    await openWorldAs(outsider.page, fixtures().characters.neighbour.id);
    await openTab(outsider.page, 'Callings & guilds');
    expect((await outsider.page.locator('#view').textContent()).includes(secret) === false, 'another operator’s page must never show the value');
    return 'the owning operator saw the fact; the other operator’s page did not';
  });

  return 'private memory and the private journal stayed readable by the owning operator alone';
});

// ---------------------------------------------------------------------------------------------
// Scenario — the first ten minutes, through one browser
//
// One disposable operator is created through the real dialog, creates one AI resident through the
// shipped character form, and enters the world from the entry overlay. Every guide assertion compares
// the rendered guide with the server's own `GET /api/v1/first-play` read and with the saved rows in
// the temporary database, so the guide can only ever reflect a stored fact.
//
// Integration notes this scenario encodes (they are product behaviour, not test scaffolding):
//   · `createCharacter` submits the calling the form holds, which defaults to `explorer`. Selecting
//     the default calling is a no-op on the server (`changed:false`), so a resident created with the
//     default truly has no `calling.selected` audit row and the calling step is genuinely unfinished.
//   · The guide's `next_step` is always the *first* unfinished step, so a saved practice action
//     advances the derived `progress.done` count while the shown step stays the earliest gap.
// ---------------------------------------------------------------------------------------------

/** Opens the shipped game shell — the presentation that mounts the first-play guide. */
async function openGame(page, credentials = null) {
  await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (credentials && !await page.evaluate(() => document.body.classList.contains('signed-in'))) await signIn(page, credentials);
}

/**
 * Opens one navigation section in the game shell. The game shell keeps the sidebar off canvas until
 * the world menu is opened, so the menu is opened first and every later click re-opens it (a section
 * change closes the menu again).
 */
async function openGameTab(page, label) {
  const target = nav(page, label);
  if (!await page.evaluate(() => document.body.classList.contains('game-menu-open'))) {
    await page.locator('#game-menu-button').click();
    await page.waitForFunction(() => document.body.classList.contains('game-menu-open'), null, { timeout: PAGE_TIMEOUT_MS });
  }
  await target.click();
  await settle(page);
  await page.waitForTimeout(150);
}

/** Enters the world through the entry overlay's own Continue control, then waits for the guide. */
/** Everything the entry-screen and in-world waits need to explain a failure. */
const entryState = (page) => page.evaluate(() => ({
  classes: document.body.className,
  tab: document.querySelector('#navigation button[aria-current="page"]')?.getAttribute('aria-label') || null,
  gameMode: typeof window.__nemoworld?.gameMode === 'function' ? window.__nemoworld.gameMode() : null,
  selected: typeof window.__nemoworld?.selected === 'function' ? window.__nemoworld.selected() : null,
  heroButtons: [...document.querySelectorAll('#hero-actions button')].map((node) => (node.textContent || '').trim()),
  stored: { gameMode: sessionStorage.getItem('nemoworld-game-mode'), selected: localStorage.getItem('selected-agent') },
  leftovers: Object.keys(localStorage).filter((key) => key.startsWith('nemoworld-draft:') || key.startsWith('nemoworld-focus')),
}));

async function enterWorldAs(page, agentId, name) {
  await page.evaluate((id) => { localStorage.setItem('selected-agent', id); sessionStorage.setItem('nemoworld-game-mode', 'entry'); }, agentId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(page);
  try {
    await page.waitForFunction(() => document.body.classList.contains('game-entry'), null, { timeout: PAGE_TIMEOUT_MS });
  } catch (error) {
    throw new BrowserSuiteFailure('the entry screen never owned the door after the reload', { expected: 'body.game-world.game-entry', actual: describe(await entryState(page)), detail: error.message });
  }
  const hidden = await guideRoot(page);
  expect(hidden.present === false || hidden.display === 'none', 'the guide must not show while the entry screen owns the door', { expected: 'the guide absent or display:none on the entry screen', actual: describe(hidden) });
  const entry = page.locator('#hero-actions').getByRole('button', { name: `Continue as ${name}`, exact: true });
  await entry.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  await entry.click();
  await page.locator('#game-hud').waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  try {
    await page.waitForFunction(() => window.__nemoworld?.selected?.() && window.__nemoworld?.gameMode?.() === 'play', null, { timeout: PAGE_TIMEOUT_MS });
  } catch (error) {
    throw new BrowserSuiteFailure('Continue never opened the world as the resident', { expected: 'selected=agent, gameMode=play', actual: describe(await entryState(page)), detail: error.message });
  }
  await waitForGuide(page);
  const shown = await guideRoot(page);
  expect(shown.present && shown.display !== 'none' && shown.position === 'fixed', 'the guide must float as a fixed overlay once the world is open', { expected: 'position:fixed, displayed, with the guide root rendered', actual: describe(shown) });
  return shown;
}

/** The first-play guide root as the browser laid it out: presence, display, position and the reduced class. */
const guideRoot = (page) => page.evaluate(() => {
  const root = document.querySelector('#game-guide-host .game-guide');
  if (!root) return { present: false, display: null, position: null, reduced: false };
  const style = getComputedStyle(root);
  return { present: true, display: style.display, position: style.position, reduced: root.classList.contains('game-guide-reduced') };
});

/**
 * One shipped write driven from the page that already loaded the application, waiting out the
 * server's own 429 throttles (movement and building) instead of failing the scenario on them.
 */
async function pageWrite(page, path, body) {
  let response = await inPage(page, path, { body });
  for (let attempt = 0; attempt < 6 && response.status === 429; attempt++) {
    await sleep(300);
    response = await inPage(page, path, { body });
  }
  return response;
}

/** Opens the shipped game shell and waits for the first-play guide to paint. */
async function enterGameShell(page) {
  await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await waitForGuide(page);
}

/**
 * Captures the guide as evidence. The guide is now the theme's fixed `.game-guide` overlay, so the
 * screenshot is taken at the current viewport with no page scrolling.
 */
async function captureGuide(page, file) {
  await waitForGuide(page);
  await page.screenshot({ path: file });
}

/**
 * Opens the restoration panel and selects one exact occurrence. The board lists every occurrence, so
 * a run that already holds other restorations cannot leave this scenario acting on the wrong one.
 */
async function openRestorationEvent(page, eventId) {
  await openRestoration(page);
  const board = page.locator('#view select[aria-label="Restoration"]');
  if (await board.count()) {
    const values = await board.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
    expect(values.includes(eventId), 'the restoration board must offer the occurrence this scenario opened', { expected: eventId, actual: describe(values) });
    if (await board.inputValue() !== eventId) { await board.selectOption(eventId); await settle(page); }
    expect(await board.inputValue() === eventId, 'the panel must show the occurrence this scenario opened', { expected: eventId, actual: await board.inputValue() });
  }
}

const GUIDE_NEXT = '#game-guide-host .game-guide-card.game-guide-next';

async function waitForGuide(page) {
  await page.locator(GUIDE_NEXT).waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
}

/** The first-play guide exactly as the browser rendered it. */
const guideDom = (page) => page.evaluate(() => {
  const host = document.querySelector('#game-guide-host');
  const nextCard = host?.querySelector('.game-guide-card.game-guide-next') || null;
  const meter = host?.querySelector('[data-guide="meter"]');
  const restoration = host?.querySelector('.game-guide-card.game-guide-restoration') || null;
  return {
    hasHost: Boolean(host),
    nextCards: host ? host.querySelectorAll('.game-guide-card.game-guide-next').length : 0,
    nextTitle: nextCard ? (nextCard.querySelector('.game-guide-title')?.textContent || '').trim() : null,
    nextTitles: nextCard ? [...nextCard.querySelectorAll('.game-guide-title')].map((node) => (node.textContent || '').trim()) : [],
    target: nextCard?.querySelector('[data-guide="target"]')?.textContent?.trim() || null,
    progress: host?.querySelector('[data-guide="progress"]')?.textContent?.trim() || null,
    done: meter ? Number(meter.getAttribute('value')) : null,
    total: meter ? Number(meter.getAttribute('max')) : null,
    actions: nextCard ? [...nextCard.querySelectorAll('.game-guide-action')].map((node) => ({ id: node.getAttribute('data-guide-action'), label: (node.textContent || '').trim(), height: node.getBoundingClientRect().height })) : [],
    dismissal: Boolean(host?.querySelector('.game-guide-dismissed')),
    resume: Boolean(host?.querySelector('[data-guide="resume"]')),
    hasRestoration: Boolean(restoration),
    restorationRows: restoration ? [...restoration.querySelectorAll('tr[data-actor]')].map((tr) => ({
      actor: tr.getAttribute('data-actor'), step: tr.getAttribute('data-step'), distinct: tr.getAttribute('data-distinct'),
      cells: [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()),
    })) : [],
    remaining: restoration ? [...restoration.querySelectorAll('.game-guide-remaining li')].map((li) => (li.textContent || '').trim()) : [],
    titles: host ? [...host.querySelectorAll('.game-guide-title')].map((node) => (node.textContent || '').trim()) : [],
  };
});

/** The server's own first-play read, through the page's own signed-in session. */
async function readFirstPlay(page, agentId = null, worldId = null) {
  const params = new URLSearchParams();
  if (agentId) params.set('agent_id', agentId);
  if (worldId) params.set('world_id', worldId);
  const query = params.toString();
  const read = await inPage(page, `/first-play${query ? `?${query}` : ''}`, { method: 'GET' });
  return read.body;
}

// ---------------------------------------------------------------------------------------------
// Keyboard and text equivalents for the guide
//
// The guide's controls are real `<button>` elements, so Tab moves between them and Enter/Space
// activates them natively. The shell binds no guide shortcut: its one keydown handler hands Enter,
// Space and `I` to the interaction prompt (only while a fixture stands within six tiles) and stands
// the world's own keys down whenever a `<button>` holds focus, so a focused guide control keeps its
// native activation. These helpers therefore drive the guide with the keyboard alone.
// ---------------------------------------------------------------------------------------------

/** A stable key for one focusable guide control, from the attributes the guide itself sets. */
const controlKey = (node) => {
  if (!node) return '?';
  if (node.action) return `action:${node.action}`;
  if (node.guide) return `guide:${node.guide}`;
  if (node.encounter) return `encounter:${node.encounter}`;
  if (node.tag === 'SUMMARY') return `summary:${node.text}`;
  return String(node.tag || '?');
};

/** The element the page currently focuses, described without naming a specific control. */
const focusedControl = (page) => page.evaluate(() => {
  const node = document.activeElement;
  if (!node || node === document.body) return null;
  return {
    inGuide: Boolean(node.closest?.('#game-guide-host')),
    action: node.getAttribute?.('data-guide-action'),
    guide: node.getAttribute?.('data-guide'),
    encounter: node.getAttribute?.('data-guide-encounter-action'),
    tag: node.tagName,
    text: (node.textContent || '').trim().slice(0, 80),
    disabled: Boolean(node.disabled),
    tabindex: node.getAttribute?.('tabindex'),
  };
});

/** The guide's focusable controls in document order, with the state each one carries. */
const guideControls = (page) => page.evaluate(() => {
  const root = document.querySelector('#game-guide-host .game-guide');
  if (!root) return [];
  return [...root.querySelectorAll('button, summary, a[href], input, select, textarea, [tabindex]')]
    .filter((node) => {
      if (!node.getClientRects().length) return false;
      for (let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement) {
        if(parent.tagName==='DETAILS'&&!parent.open&&parent.querySelector(':scope > summary')!==node)return false;
      }
      return true;
    })
    .map((node) => ({
      action: node.getAttribute('data-guide-action'),
      guide: node.getAttribute('data-guide'),
      encounter: node.getAttribute('data-guide-encounter-action'),
      tag: node.tagName,
      text: (node.textContent || '').trim().slice(0, 60),
      disabled: Boolean(node.disabled),
      tabindex: node.getAttribute('tabindex'),
    }));
});

/** The action line the guide renders as a live region. */
const guideLiveRegion = (page) => page.evaluate(() => {
  const node = document.querySelector('#game-guide-host .game-guide-action-line');
  if (!node) return null;
  const title = node.querySelector('.game-guide-title');
  return {
    role: node.getAttribute('role'),
    live: node.getAttribute('aria-live'),
    atomic: node.getAttribute('aria-atomic'),
    text: (node.textContent || '').trim(),
    titleText: title ? (title.textContent || '').trim() : null,
    titleTag: title ? title.tagName : null,
  };
});

/** Tabs forward until a guide control satisfies `accept`. It never clicks and never navigates. */
async function tabToGuideControl(page, accept, label, maxTabs = 400) {
  for (let index = 0; index < maxTabs; index++) {
    await page.keyboard.press('Tab');
    const active = await focusedControl(page);
    if (active && active.inGuide && accept(active)) return active;
  }
  throw new BrowserSuiteFailure(`Tab never reached ${label}`, { expected: label, actual: `no matching guide control after ${maxTabs} Tab presses` });
}

/** Tabs through the guide's subtree and returns the controls in the order focus reached them. */
async function tabSweepGuide(page, maxTabs = 400) {
  const seen = [];
  for (let index = 0; index < maxTabs; index++) {
    await page.keyboard.press('Tab');
    const active = await focusedControl(page);
    if (active?.inGuide) { seen.push(controlKey(active)); continue; }
    if (seen.length) break; // focus left the guide after visiting it
  }
  return seen;
}

/** Walks a resident with the world's own keyboard keys, one checked tile at a time. */
async function walkWithKeyboard(page, agentId, moves) {
  for (const key of moves) {
    let arrived = null;
    for (let attempt = 0; attempt < 3 && !arrived; attempt++) {
      const before = row('SELECT x,y FROM agents WHERE id=?', agentId);
      await page.keyboard.press(key);
      arrived = await waitForCondition(async () => {
        const now = row('SELECT x,y FROM agents WHERE id=?', agentId);
        return Math.abs(now.x - before.x) + Math.abs(now.y - before.y) === 1 ? now : null;
      }, `a keyboard ${key} step to be saved`, { timeout: 2500, interval: 100 }).catch(() => null);
    }
    expect(arrived, `the keyboard ${key} step must move the resident exactly one tile`, { actual: describe(row('SELECT x,y FROM agents WHERE id=?', agentId)) });
  }
  return row('SELECT x,y FROM agents WHERE id=?', agentId);
}

// ---------------------------------------------------------------------------------------------
// The shipped per-account message throttle and the typed encounter contract
//
// The guide may open a private composer but cannot supply words for its operator. Opening it must
// write no row. Only a later, typed submission may advance the derived meeting step. The actual send
// still obeys the server's 1500 ms per-account message throttle.
// ---------------------------------------------------------------------------------------------
const MESSAGE_THROTTLE_MS = 1500;

/** Waits out the remainder of the shipped per-account throttle, from that account's own last message. */
async function waitForMessageWindow(accountId) {
  const last = row('SELECT created_at FROM messages WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', accountId);
  if (!last) return 0;
  const remaining = Math.max(0, MESSAGE_THROTTLE_MS - (Date.now() - Date.parse(last.created_at)));
  if (remaining) await sleep(remaining + 50);
  return remaining;
}

/** Runs one typed submission and reports the HTTP statuses the page itself saw for its message write. */
async function withMessageWatch(page, task) {
  const statuses = [];
  const record = (response) => { if (response.request().method() === 'POST' && response.url().includes('/api/v1/messages')) statuses.push(response.status()); };
  page.on('response', record);
  try {
    const value = await task();
    // The row commits before the response is delivered, and Playwright reports a response
    // asynchronously, so wait for the page's own status before detaching — a refusal has to surface
    // here rather than slip past a closed listener.
    await waitForCondition(async () => (statuses.length ? true : null), 'the page’s own message response', { timeout: 5000 }).catch(() => {});
    return { statuses, value };
  } finally { page.off('response', record); }
}

/** Waits for one exactly-new private message row and returns it, never an earlier path's row. */
async function waitForNewMessage(agentId, before) {
  return waitForCondition(async () => {
    const now = count('SELECT COUNT(*) AS n FROM messages WHERE agent_id=? AND channel=?', agentId, 'private');
    return now === before + 1 ? row('SELECT id,agent_id,channel,text,recipients FROM messages WHERE agent_id=? AND channel=? ORDER BY created_at DESC,rowid DESC LIMIT 1', agentId, 'private') : null;
  }, 'the typed encounter to store exactly one new private message');
}

/** A guide encounter prepares the existing text form; it cannot post or mark the meeting itself. */
async function openGuideComposer(page, trigger, agentId, recipientId) {
  const before = count('SELECT COUNT(*) AS n FROM messages WHERE agent_id=?', agentId);
  const writes = [];
  const record = (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/v1/messages')) writes.push(request.url());
  };
  page.on('request', record);
  try {
    await trigger();
    const form = page.locator('#world-chat-card form');
    await form.locator('[name="text"]').waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    // The guide action is asynchronous: the drawer can become visible before its composer receives
    // focus. Wait for that final focus handoff rather than sampling mid-click.
    await waitForCondition(async () => form.evaluate((node) => document.activeElement === node.elements.namedItem('text')).catch(() => false),
      'the private composer to receive focus', { timeout: 3000, interval: 50 }).catch(() => null);
    const prepared = await form.evaluate((node) => ({
      channel: node.elements.namedItem('channel')?.value,
      recipient: node.elements.namedItem('recipient_id')?.value,
      text: node.elements.namedItem('text')?.value,
      focused: document.activeElement === node.elements.namedItem('text'),
      active: { tag: document.activeElement?.tagName, id: document.activeElement?.id, name: document.activeElement?.getAttribute('name') },
    }));
    expect(prepared.channel === 'private' && prepared.recipient === recipientId && prepared.text === '' && prepared.focused,
      'the guide must open a blank, focused private composer for the named resident',
      { expected: { channel: 'private', recipient: recipientId, text: '', focused: true }, actual: prepared });
    expect(writes.length === 0 && count('SELECT COUNT(*) AS n FROM messages WHERE agent_id=?', agentId) === before,
      'opening the encounter must send no canned or blank message and complete no saved step',
      { expected: 'zero POST /messages and zero new rows', actual: describe({ writes, before, after: count('SELECT COUNT(*) AS n FROM messages WHERE agent_id=?', agentId) }) });
    return form;
  } finally { page.off('request', record); }
}

/** The guide's own refusal notice, when a click or key press was refused. */
const guideRefusal = (page) => page.evaluate(() => (document.querySelector('#game-guide-host [data-guide="error"]')?.textContent || '').trim());

/** Creates one disposable operator through the real dialog, waiting out the server's auth limiter. */
async function signUp(page, { name, email, password }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#session-bar').getByRole('button', { name: /Create account/, exact: false }).click();
    await page.locator('#auth-dialog').waitFor({ state: 'visible' });
    const form = page.locator('#auth-area section:not([hidden]) form');
    await form.locator('[aria-label="Operator display name"]').fill(name);
    await form.locator('[aria-label="Private contact email"]').fill(email);
    await form.locator('[aria-label="Password"]').fill(password);
    await form.locator('select[name="entry"]').selectOption('agent');
    await form.locator('input[name="consent"]').check();
    await form.getByRole('button', { name: 'Create account', exact: true }).click();
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    let outcome = 'timeout';
    while (Date.now() < deadline) {
      const observed = await page.evaluate(() => {
        const notice = document.querySelector('#auth-notice');
        return { signedIn: document.body.classList.contains('signed-in'), notice: notice?.textContent || '', failed: Boolean(notice && !notice.hidden && notice.classList.contains('error')) };
      });
      if (observed.signedIn) { outcome = 'signed-in'; break; }
      if (observed.failed && /Too many authentication attempts/i.test(observed.notice)) { outcome = 'rate-limited'; break; }
      if (observed.failed) { outcome = `refused: ${observed.notice}`; break; }
      await sleep(200);
    }
    if (outcome === 'signed-in') { await settle(page); return; }
    if (outcome === 'rate-limited' && attempt === 0) {
      console.log('        signup           the authentication limiter refused this attempt; waiting a minute before retrying once');
      await page.locator('#close-auth').click().catch(() => {});
      await sleep(62_000);
      continue;
    }
    throw new BrowserSuiteFailure('the interface could not create the disposable operator', { expected: `a signed-in session for ${email}`, actual: outcome });
  }
}

/** Creates one AI resident through the shipped character form, leaving the calling at its default. */
async function createResidentThroughInterface(page, name) {
  // The creation form opens in the in-game panel while playing and in the view otherwise.
  const form = page.locator('#view form[data-draft-section="character-create"], #game-panel-body form[data-draft-section="character-create"]').first();
  await form.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  await form.locator('[aria-label="Character name"]').fill(name);
  await form.getByRole('button', { name: 'Create character', exact: true }).click();
  const resident = await waitForCondition(async () => row("SELECT id,kind,status FROM agents WHERE name=?", name), 'the interface to create the resident');
  // The saved row appears while the ship is still finishing: `createCharacter` then re-reads the
  // world and calls `selectAgent`, which writes the tab's own game mode. Settle that first — the
  // shipped behaviour is that creating a character enters the world as it — so a later "enter via the
  // entry overlay" cannot race the ship's own `play` write and boot straight into the world.
  await page.waitForFunction((id) => window.__nemoworld?.selected?.() === id && window.__nemoworld?.gameMode?.() === 'play', resident.id, { timeout: PAGE_TIMEOUT_MS });
  return resident;
}

const GARDEN_UNWALKABLE = new Set(['water', 'tree', 'building', 'fountain', 'wall']);
const gardenWalkable = (type) => typeof type === 'string' && !GARDEN_UNWALKABLE.has(type);

/** A free, walkable garden tile away from the resident, the doorways and every stored object. */
async function gardenFarmTile(page, agentId) {
  const home = `home:${agentId}`;
  const read = await inPage(page, `/world?world_id=${encodeURIComponent(home)}&agent_id=${encodeURIComponent(agentId)}`, { method: 'GET' });
  const descriptor = read.body;
  const resident = (descriptor.participants || []).find((entry) => entry.id === agentId) || descriptor.camera;
  const near = (point, x, y) => Math.abs(point.x - x) + Math.abs(point.y - y) <= 1;
  const tiles = [];
  for (let row = 0; row < descriptor.terrain.length; row++) {
    for (let column = 0; column < descriptor.terrain[row].length; column++) {
      const x = descriptor.camera.x + column, y = descriptor.camera.y + row;
      if (!gardenWalkable(descriptor.terrain[row][column])) continue;
      if (near(resident, x, y)) continue;
      if ((descriptor.portals || []).some((portal) => near(portal, x, y))) continue;
      if ((descriptor.objects || []).some((object) => object.x === x && object.y === y)) continue;
      tiles.push({ x, y, distance: Math.abs(resident.x - x) + Math.abs(resident.y - y) });
    }
  }
  tiles.sort((left, right) => left.distance - right.distance || left.y - right.y || left.x - right.x);
  return tiles[0] || null;
}

define('first-ten-minutes', async () => {
  const player = await context('first-ten');
  const page = player.page;
  const EMAIL = 'tester.first-ten@browser.test';
  const NAME = 'Ten-minute tester';
  const RESIDENT = 'Commons newcomer';
  let resident = null, nextBeforeDismiss = null, sentComposerNode = null, firstPrivateMessage = null;

  await step('a disposable operator signs up through the real dialog with no resident yet', async () => {
    await openGame(page);
    expect(await page.evaluate(() => document.body.classList.contains('game-world')), 'the game shell must open in the world presentation', { actual: 'no game-world class on the body' });
    const before = await readFirstPlay(page);
    expect(before && before.viewer === null && before.progress.done === 0, 'with no resident the derived guide counts no completed step', { expected: 'viewer=null, progress.done=0', actual: describe({ viewer: before?.viewer, done: before?.progress?.done }) });
    await signUp(page, { name: NAME, email: EMAIL, password: PASSWORD });
    const account = row('SELECT id,name,email,role FROM accounts WHERE email=?', EMAIL);
    expect(account && account.role === 'member', 'the dialog must create the disposable member account', { expected: 'a stored member account', actual: describe(account) });
    expect(count('SELECT COUNT(*) AS n FROM agents WHERE operator_id=?', account.id) === 0, 'the new operator must start with no resident', { actual: `${count('SELECT COUNT(*) AS n FROM agents WHERE operator_id=?', account.id)} residents` });
    state.fixtures.firstTen = { accountId: account.id, email: EMAIL };
    return `account ${account.id} created through the dialog with no resident; the guide reported 0 of 5`;
  });

  await step('the interface creates one AI resident and the guide counts exactly that saved row', async () => {
    resident = await createResidentThroughInterface(page, RESIDENT);
    expect(resident.kind === 'agent' && resident.status === 'active', 'the created character must be an active AI resident', { actual: describe(resident) });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='calling.selected' AND record_id=?", resident.id) === 0, 'creating a resident with the default calling must not record a chosen calling', { actual: 'a calling.selected row appeared' });
    const after = await readFirstPlay(page, resident.id, 'commons');
    expect(after?.viewer?.agent_id === resident.id && after.progress.done === 1, 'the saved agents row must be the one completed step', { expected: 'progress.done=1', actual: describe({ viewer: after?.viewer?.agent_id, done: after?.progress?.done }) });
    expect(after.next_step?.id === 'calling' && after.next_step?.ordinal === 2, 'the next step must be the calling the resident has not chosen', { expected: 'calling at ordinal 2', actual: describe(after.next_step) });
    return `agents row ${resident.id}; guide done=1, next=${after.next_step.id}`;
  });

  await step('the entry overlay enters the world and shows exactly one next action', async () => {
    await enterWorldAs(page, resident.id, RESIDENT);
    const guide = await guideDom(page);
    expect(guide.hasHost && guide.nextCards === 1, 'the world view must host exactly one next-action card', { actual: describe({ host: guide.hasHost, next: guide.nextCards }) });
    expect(guide.progress === 'Step 2 of 5', 'the guide must state the step and the authored total', { expected: 'Step 2 of 5', actual: describe(guide.progress) });
    expect(guide.done === 1 && guide.total === 5, 'the meter must carry the derived done count and the five authored steps', { expected: 'done=1, total=5', actual: describe({ done: guide.done, total: guide.total }) });
    expect(guide.nextTitles.length === 1 && guide.nextTitles[0] === 'Choose a calling', 'the next card must carry exactly one task title, never a list', { expected: ['Choose a calling'], actual: describe(guide.nextTitles) });
    return `Step 2 of 5, done 1, one title “${guide.nextTitles[0]}”`;
  });

  await step('a forged completion record in this browser changes nothing', async () => {
    await page.evaluate(() => localStorage.setItem('nemoworld-newcomer', JSON.stringify({ completed: ['enter', 'calling', 'meet', 'practice', 'restore'], acknowledged: true })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const guide = await guideDom(page);
    const server = await readFirstPlay(page, resident.id, 'commons');
    expect(guide.progress === 'Step 2 of 5' && guide.nextTitles[0] === 'Choose a calling', 'the guide must still report the unfinished calling after the forged list', { expected: 'Step 2 of 5 · Choose a calling', actual: describe({ progress: guide.progress, titles: guide.nextTitles }) });
    expect(server.progress.done === 1 && server.next_step.id === 'calling', 'the server read must agree that only the resident row is saved', { expected: 'done=1, next=calling', actual: describe({ done: server.progress?.done, next: server.next_step?.id }) });
    return 'the forged localStorage record was ignored; the guide still reads Step 2 of 5';
  });

  await step('a calling is chosen through the interface and a calling.selected audit row is written', async () => {
    await openGameTab(page, 'Callings & guilds');
    const choice = page.locator(':is(#view, #game-panel-body) .calling-choice[data-calling="cultivator"]');
    await choice.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await choice.getByRole('button', { name: /^Become/ }).click();
    const audit = await waitForCondition(async () => row("SELECT seq,event,record_id FROM audit WHERE event='calling.selected' AND record_id=?", resident.id), 'the saved calling.selected audit row');
    expect(audit.record_id === resident.id, 'the audit row must name the resident', { actual: describe(audit) });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='calling.selected' AND record_id=?", resident.id) === 1, 'choosing once must write exactly one audit row', { actual: 'the audit count differs' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const guide = await guideDom(page);
    const server = await readFirstPlay(page, resident.id, 'commons');
    expect(server.progress.done === 2 && server.steps.find((item) => item.id === 'calling').done === true, 'the guide must advance to two saved steps after the calling', { expected: 'done=2 with calling done', actual: describe({ done: server.progress?.done, steps: server.steps?.map((item) => [item.id, item.done]) }) });
    expect(guide.done === 2 && guide.progress === 'Step 3 of 5', 'the rendered guide must agree with the server read', { expected: 'done=2, Step 3 of 5', actual: describe({ done: guide.done, progress: guide.progress }) });
    return `calling.selected audit for ${resident.id}; guide advanced to ${server.progress.done} of 5 (${guide.progress})`;
  });

  await step('the forged completion record still changes nothing after the real step', async () => {
    await page.evaluate(() => localStorage.setItem('nemoworld-newcomer', JSON.stringify({ completed: ['enter', 'calling', 'meet', 'practice', 'restore'], acknowledged: true })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const guide = await guideDom(page);
    const server = await readFirstPlay(page, resident.id, 'commons');
    expect(server.progress.done === 2, 'the forged record must not add a completed step', { expected: 'done=2', actual: describe(server.progress) });
    expect((guide.progress || '').startsWith('Step 3 of 5'), 'the rendered guide must still name the first unfinished step', { expected: 'Step 3 of 5', actual: describe(guide.progress) });
    return `still ${server.progress.done} of 5 after the forged record`;
  });

  await step('one real saved practice action is stored and leaves a calling receipt', async () => {
    const home = `home:${resident.id}`;
    // The game shell hides the world title that carries the workspace "Go home" control, so the
    // travel is the same shipped route driven from the page.
    const travelled = await pageWrite(page, `/agents/${resident.id}/travel`, { world_id: home });
    expect(travelled.status === 200 && travelled.body?.world_id === home, 'the resident must travel into its own garden by the shipped route', { expected: `HTTP 200 into ${home}`, actual: `HTTP ${travelled.status} ${describe(travelled.body)}` });
    await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', resident.id).world_id === home ? home : null, 'the resident to stand in its own garden');
    const site = await gardenFarmTile(page, resident.id);
    expect(site, 'the garden must offer a free walkable tile for a crop patch', { actual: 'no free tile in the published window' });
    const built = await pageWrite(page, `/agents/${resident.id}/build`, { type: 'farm', x: site.x, y: site.y });
    expect(built.status === 201, 'the crop patch must be saved by the shipped build route', { expected: 'HTTP 201', actual: `HTTP ${built.status} ${describe(built.body)}` });
    const planted = await pageWrite(page, '/journey/garden', { agent_id: resident.id, action: 'plant', kind: 'herbs', x: site.x, y: site.y });
    expect(planted.status === 200 && planted.body?.crop?.kind === 'herbs', 'the sowing must be saved in the resident’s own garden', { expected: 'HTTP 200 with a herbs crop', actual: `HTTP ${planted.status} ${describe(planted.body)}` });
    expect(count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=? AND x=? AND y=?', resident.id, site.x, site.y) === 1, 'exactly one sowing row must exist', { actual: 'the crop row is missing' });
    await openGameTab(page, 'Callings & guilds');
    const receipt = await waitForCondition(async () => row('SELECT id,objective_id,source_kind FROM calling_receipts WHERE agent_id=?', resident.id), 'the calling receipt earned by the saved sowing');
    expect(receipt.source_kind === 'crop_plant', 'the receipt must name the saved sowing as its source', { expected: 'source_kind=crop_plant', actual: describe(receipt) });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const server = await readFirstPlay(page, resident.id, home);
    expect(server.progress.done === 3 && server.steps.find((item) => item.id === 'practice').done === true, 'the guide must advance again after the saved practice action', { expected: 'done=3 with practice done', actual: describe({ done: server.progress?.done, steps: server.steps?.map((item) => [item.id, item.done]) }) });
    return `journey_crops row at ${site.x},${site.y}; calling_receipts ${receipt.objective_id}; guide done=${server.progress.done}`;
  });

  await step('a nearby resident gives the guide its one meeting action to drive', async () => {
    const viewer = row('SELECT world_id,x,y FROM agents WHERE id=?', resident.id);
    const helper = fixtures().characters.neighbour;
    // Another operator's resident four tiles away: inside the guide's six-tile encounter radius.
    // Opening the private composer cannot silently complete the meeting; only typed, saved words do.
    // Move other close residents clear so this is the server's nearest candidate.
    for (const other of rows("SELECT id,x,y FROM agents WHERE world_id=? AND status='active' AND id NOT IN (?,?)", viewer.world_id, resident.id, helper.id)) {
      if (Math.abs(other.x - viewer.x) + Math.abs(other.y - viewer.y) <= 3) write('UPDATE agents SET x=?,y=? WHERE id=?', Math.min(30, viewer.x + 16), Math.min(22, viewer.y + 10), other.id);
    }
    write("UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,status='active' WHERE id=?", viewer.world_id, viewer.x + 4, viewer.y, helper.id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const guide = await guideDom(page);
    const action = guide.actions.find((item) => item.id === 'meet-nearest');
    expect(guide.nextTitle === 'Meet a resident and read its limits' && action, 'the guide must publish its one meeting action for the nearby resident', { expected: 'meet-nearest on the meeting step', actual: describe({ title: guide.nextTitle, actions: guide.actions }) });
    return `the guide offers “${action.label}”`;
  });

  await step('the guide dismisses to a single bar and resumes without writing a step', async () => {
    nextBeforeDismiss = (await guideDom(page)).nextTitle;
    const before = { receipts: count('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?', resident.id), audits: count('SELECT COUNT(*) AS n FROM audit'), agents: count('SELECT COUNT(*) AS n FROM agents'), crops: count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', resident.id) };
    // Dismiss repaints the guide itself: no navigation, reload or section change may stand between
    // the click and the assertion, so the dismissed bar has to replace the action card immediately.
    await page.locator('#game-guide-host [data-guide="dismiss"]').click();
    const dismissed = await guideDom(page);
    expect(dismissed.dismissal && dismissed.nextCards === 0, 'dismissing must immediately replace the action card with the dismissed bar, with no navigation', { expected: 'the dismissed bar and no action card', actual: describe({ dismissal: dismissed.dismissal, next: dismissed.nextCards }) });
    expect(dismissed.titles.length === 0, 'the dismissed bar must carry no task title', { actual: describe(dismissed.titles) });
    expect(dismissed.resume, 'the dismissed bar must offer the resume control', { actual: 'no [data-guide="resume"]' });
    await page.locator('#game-guide-host [data-guide="resume"]').click();
    const resumed = await guideDom(page);
    expect(resumed.nextCards === 1 && resumed.nextTitle === nextBeforeDismiss, 'resuming must immediately bring back the same task title, with no navigation', { expected: nextBeforeDismiss, actual: describe({ next: resumed.nextCards, title: resumed.nextTitle }) });
    const after = { receipts: count('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?', resident.id), audits: count('SELECT COUNT(*) AS n FROM audit'), agents: count('SELECT COUNT(*) AS n FROM agents'), crops: count('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', resident.id) };
    expect(describe(after) === describe(before), 'dismissing and resuming must write nothing at all', { expected: describe(before), actual: describe(after) });
    return `dismissed to the bar and resumed “${resumed.nextTitle}” immediately, with no row changed`;
  });

  await step('the camera choice and the saved place survive a reload with the same next step', async () => {
    await page.locator('#world').focus();
    await page.keyboard.press('v');
    await page.waitForFunction(() => (document.querySelector('#world-reticle')?.textContent || '').startsWith('First person'), null, { timeout: PAGE_TIMEOUT_MS });
    expect(await page.evaluate(() => localStorage.getItem('nemoworld-first-person')) === 'true', 'the camera choice must be written to localStorage', { actual: describe(await page.evaluate(() => localStorage.getItem('nemoworld-first-person'))) });
    const placed = row('SELECT world_id,x,y,z FROM agents WHERE id=?', resident.id);
    const before = await readFirstPlay(page, resident.id, placed.world_id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const after = row('SELECT world_id,x,y,z FROM agents WHERE id=?', resident.id);
    expect(await page.evaluate(() => window.__nemoworld?.selected?.()) === resident.id, 'the reload must restore the same character', { expected: resident.id, actual: describe(await page.evaluate(() => window.__nemoworld?.selected?.())) });
    expect((await page.evaluate(() => document.querySelector('#world-reticle')?.textContent || '')).startsWith('First person'), 'the camera choice must survive the reload', { actual: describe(await page.evaluate(() => document.querySelector('#world-reticle')?.textContent)) });
    expect(after.world_id === placed.world_id && after.x === placed.x && after.y === placed.y && after.z === placed.z, 'the reload must show the same world and tile the database stores', { expected: describe(placed), actual: describe(after) });
    const reader = await readFirstPlay(page, resident.id, after.world_id);
    expect(reader.next_step?.id === before.next_step?.id && reader.progress.done === before.progress.done, 'the guide must resume at the same step and the same count', { expected: describe({ next: before.next_step?.id, done: before.progress?.done }), actual: describe({ next: reader.next_step?.id, done: reader.progress?.done }) });
    return `restored ${after.world_id}:${after.x},${after.y} in first person at the same step (${reader.next_step?.id})`;
  });

  await step('desktop and 390px phone open a blank conversation without claiming a saved meeting', async () => {
    await mkdir(join(RESULTS, 'first-ten-minutes'), { recursive: true });
    const world = row('SELECT world_id FROM agents WHERE id=?', resident.id).world_id;
    const other = fixtures().characters.neighbour.id;
    const desktopButton = page.locator(GUIDE_NEXT).locator('.game-guide-action').first();
    await openGuideComposer(page, () => desktopButton.click(), resident.id, other);
    const desktopRefusal = await guideRefusal(page);
    expect(desktopRefusal === '', 'opening the desktop composer must not show a refusal', { expected: 'no refusal notice', actual: describe(desktopRefusal) });
    await captureGuide(page, join(RESULTS, 'first-ten-minutes', 'desktop.png'));
    const afterDesktop = await readFirstPlay(page, resident.id, world);
    expect(afterDesktop.next_step?.id === 'meet' && afterDesktop.steps.find((item) => item.id === 'meet').done === false,
      'opening the composer must leave the meeting step unfinished', { expected: 'meet unfinished', actual: describe({ next: afterDesktop.next_step?.id, steps: afterDesktop.steps }) });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const phoneButton = page.locator(GUIDE_NEXT).locator('.game-guide-action').first();
    // The shell swaps the guide's nodes on a world repaint, so a single measurement can land on a
    // detached node (an empty box). Re-measure until the button is laid out; the ≥44px assertion stands.
    const box = await waitForCondition(async () => phoneButton.boundingBox().catch(() => null), 'the guide’s phone button to be laid out');
    expect(box && box.height >= 44, 'the guide’s primary button must be at least 44 CSS pixels tall on a phone', { expected: 'height >= 44', actual: describe(box) });
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(width.scroll <= 390 + 1, 'the phone layout must not scroll horizontally', { expected: 'scrollWidth <= 391', actual: describe(width) });
    await openGuideComposer(page, () => phoneButton.click(), resident.id, other);
    await captureGuide(page, join(RESULTS, 'first-ten-minutes', 'phone.png'));
    const afterPhone = await readFirstPlay(page, resident.id, world);
    expect(afterPhone.next_step?.id === 'meet' && afterPhone.progress.done === afterDesktop.progress.done,
      'neither composer opening may advance the derived meeting step', { expected: describe({ next: afterDesktop.next_step?.id, done: afterDesktop.progress?.done }), actual: describe({ next: afterPhone.next_step?.id, done: afterPhone.progress?.done }) });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    return `desktop.png and phone.png at 390×844; a ${Math.round(box.height)}px button, no sideways scroll, blank private composer, zero message writes`;
  });

  await step('a reduced-motion phone opens the same blank composer with no transition or saved step', async () => {
    const reduced = await context('first-ten-reduced');
    await reduced.page.emulateMedia({ reducedMotion: 'reduce' });
    await openGame(reduced.page, { email: EMAIL, password: PASSWORD });
    await reduced.page.setViewportSize({ width: 390, height: 844 });
    await enterWorldAs(reduced.page, resident.id, RESIDENT);
    const button = reduced.page.locator(GUIDE_NEXT).locator('.game-guide-action').first();
    const reducedRoot = await guideRoot(reduced.page);
    expect(reducedRoot.present && reducedRoot.reduced === true, 'the guide root must carry the reduced-motion class for a viewer who asked for it', { expected: 'a .game-guide root with game-guide-reduced', actual: describe(reducedRoot) });
    // One atomic in-page read: the shell swaps the guide's nodes on a world repaint, and a node handed
    // to Playwright can detach between its resolution and the evaluation (a detached node reports '').
    const duration = await reduced.page.evaluate(() => {
      const node = document.querySelector('#game-guide-host .game-guide .game-guide-action');
      return node ? getComputedStyle(node).transitionDuration : null;
    });
    expect(typeof duration === 'string' && duration.split(',').every((part) => part.trim() === '0s'), 'a reduced-motion viewer must receive no transition on the guide control', { expected: '0s', actual: describe(duration) });
    const box = await waitForCondition(async () => button.boundingBox().catch(() => null), 'the reduced-motion guide button to be laid out');
    expect(box && box.height >= 44, 'the reduced-motion phone button must stay tappable', { expected: 'height >= 44', actual: describe(box) });
    await openGuideComposer(reduced.page, () => button.click(), resident.id, fixtures().characters.neighbour.id);
    const reducedRefusal = await guideRefusal(reduced.page);
    expect(reducedRefusal === '', 'the reduced-motion composer must open without a refusal', { expected: 'no refusal notice', actual: describe(reducedRefusal) });
    const server = await readFirstPlay(reduced.page, resident.id, row('SELECT world_id FROM agents WHERE id=?', resident.id).world_id);
    expect(server.next_step?.id === 'meet' && server.steps.find((item) => item.id === 'meet').done === false,
      'the reduced-motion guide must leave the meeting unfinished until text is sent', { expected: 'meet unfinished', actual: describe(server.next_step?.id) });
    return `390px reduced motion: a ${Math.round(box.height)}px button, transitionDuration ${duration}, zero message writes`;
  });

  await step('the one next action is exposed as text in the guide’s live region', async () => {
    const guide = await guideDom(page);
    const live = await guideLiveRegion(page);
    expect(live && live.role === 'status' && live.live === 'polite' && live.atomic === 'true', 'the action line must be an atomic, polite live region', { expected: 'role=status, aria-live=polite, aria-atomic=true', actual: describe(live) });
    expect(live.titleText === guide.nextTitle && (guide.nextTitle || '').length > 0, 'the live region must carry the same next-action title the guide shows', { expected: guide.nextTitle, actual: describe(live.titleText) });
    expect(live.text.includes(guide.nextTitle), 'a text-only reader must read the action title as rendered text, not only inside an aria-label', { expected: `the title inside the live region’s text`, actual: describe(live.text.slice(0, 200)) });
    expect(['H1', 'H2', 'H3'].includes(live.titleTag), 'the title must be a real heading element with text content', { actual: describe(live.titleTag) });
    const labelled = await page.evaluate((title) => {
      const node = document.querySelector('#game-guide-host .game-guide-action-line');
      const titleNode = node?.querySelector('.game-guide-title') || null;
      return { titleText: titleNode?.textContent?.trim() || null, ariaLabel: titleNode?.getAttribute('aria-label') || null };
    }, guide.nextTitle);
    expect(labelled.titleText === guide.nextTitle, 'the title must be element text, not an attribute', { expected: guide.nextTitle, actual: describe(labelled) });
    return `live region role=status · text “${live.titleText}”`;
  });

  await step('every guide control is reachable by Tab in document order', async () => {
    const controls = await guideControls(page);
    const expectedOrder = controls.map(controlKey);
    expect(expectedOrder.length >= 2, 'the guide must expose its next action and its dismiss control', { expected: 'at least two controls', actual: describe(expectedOrder) });
    for (const control of controls) {
      expect(control.tabindex !== '-1', 'no guide control may be removed from the tab order', { expected: 'no tabindex="-1"', actual: describe(control) });
      expect(control.disabled === false, 'no guide control may be disabled while its step is available', { expected: 'enabled', actual: describe(control) });
    }
    let seen = await tabSweepGuide(page);
    // A world repaint re-mounts the guide and can drop focus mid-sweep; retry the sweep rather than
    // accept a short one, and assert the order it finally reports.
    for (let attempt = 0; attempt < 2 && describe(seen) !== describe(expectedOrder); attempt++) seen = await tabSweepGuide(page);
    expect(describe(seen) === describe(expectedOrder), 'Tab must reach every guide control exactly once, in document order', { expected: describe(expectedOrder), actual: describe(seen) });
    const summary=await tabToGuideControl(page,node=>node.tag==='SUMMARY'&&node.text==='People & progress','the optional people/progress summary');
    expect(summary.tag==='SUMMARY','optional records use a native keyboard disclosure');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#game-guide-host details.game-guide-details')?.open===true,null,{timeout:PAGE_TIMEOUT_MS});
    const expanded=(await guideControls(page)).map(controlKey);
    expect(expanded.some(key=>key.startsWith('encounter:')),'the expanded disclosure makes the resident encounter controls keyboard-reachable');
    let expandedSeen=await tabSweepGuide(page);
    for(let attempt=0;attempt<2&&describe(expandedSeen)!==describe(expanded);attempt++)expandedSeen=await tabSweepGuide(page);
    expect(describe(expandedSeen)===describe(expanded),'expanded supporting controls retain native document-order focus',{expected:describe(expanded),actual:describe(expandedSeen)});
    await tabToGuideControl(page,node=>node.tag==='SUMMARY'&&node.text==='People & progress','the open people/progress summary');
    await page.keyboard.press('Space');
    await page.waitForFunction(()=>document.querySelector('#game-guide-host details.game-guide-details')?.open===false,null,{timeout:PAGE_TIMEOUT_MS});
    return `Tab reached ${seen.join(' → ')}; Enter exposed every supporting encounter control and Space closed it again`;
  });

  await step('a saved keyboard walk refreshes the guide’s nearby target without a reload', async () => {
    const garden = `home:${resident.id}`;
    const beforeGuide = await readFirstPlay(page, resident.id, garden);
    const beforeDistance = beforeGuide.next_step?.target?.distance;
    expect(beforeGuide.next_step?.id === 'meet' && Number.isFinite(beforeDistance), 'the meeting target must have a server-derived starting distance', { actual: describe(beforeGuide.next_step) });
    await page.locator('#world').focus();
    await page.keyboard.press('v'); // leave first person: WASD then walks in world directions
    await page.waitForFunction(() => !(document.querySelector('#world-reticle')?.textContent || '').startsWith('First person'), null, { timeout: PAGE_TIMEOUT_MS });
    const before = row('SELECT x,y FROM agents WHERE id=?', resident.id);
    const moves = [...Array(Math.max(0, 13 - before.x)).fill('d'), ...Array(Math.max(0, 9 - before.y)).fill('s')];
    const arrived = await walkWithKeyboard(page, resident.id, moves);
    expect(arrived.x === 13 && arrived.y === 9, 'the keyboard walk must reach the intended garden tile', { expected: '13,9', actual: describe(arrived) });
    const updated = await readFirstPlay(page, resident.id, garden);
    const afterDistance = updated.next_step?.target?.distance;
    expect(updated.next_step?.id === 'meet' && Number.isFinite(afterDistance) && afterDistance !== beforeDistance,
      'the saved walk must change the server-derived distance to the same resident',
      { expected: `meet at a distance different from ${beforeDistance}`, actual: describe({ next: updated.next_step, arrived }) });
    const targetLine = await waitForCondition(async () => {
      const guide = await guideDom(page);
      return guide.target?.includes(`${afterDistance} tile`) ? guide.target : null;
    }, 'the guide’s target distance to update after the saved keyboard walk');
    expect(targetLine.includes(updated.next_step.target.label), 'the repainted target must still name the same resident', { expected: updated.next_step.target.label, actual: targetLine });
    // More than six tiles from every fixture, so the interaction prompt owns nothing and Enter belongs
    // to the focused control (the prompt claims Enter only while a fixture stands within six tiles).
    const clear = await inPage(page, `/interact?world_id=${encodeURIComponent(garden)}&agent_id=${encodeURIComponent(resident.id)}`, { method: 'GET' });
    expect(clear.status === 200 && clear.body?.fixture === null && clear.body?.nearby?.length === 0, 'no fixture may stand within six tiles of the walked-to tile', { expected: 'fixture=null and nearby=[]', actual: `HTTP ${clear.status} ${describe({ fixture: clear.body?.fixture, nearby: clear.body?.nearby })}` });
    // The prompt only re-reads on a world render, and it claims Enter while it holds a fixture, so a
    // render is forced with the keyboard ('v') and the prompt must go hidden before the activation.
    await page.locator('#world').focus();
    await page.keyboard.press('v');
    await page.waitForFunction(() => document.querySelector('#game-prompt-host')?.hidden === true, null, { timeout: PAGE_TIMEOUT_MS });
    const prompt = await page.evaluate(() => ({ hidden: document.querySelector('#game-prompt-host')?.hidden === true, text: (document.querySelector('#game-prompt-host')?.textContent || '').trim() }));
    expect(prompt.hidden && prompt.text === '', 'the interaction prompt must offer no fixture, so Enter belongs to the focused control', { expected: 'an empty, hidden prompt', actual: describe(prompt) });
    expect(updated.next_step?.actions?.some((action) => action.id === 'meet-nearest'), 'the meeting action must still be published for the nearby resident', { expected: 'meet-nearest still offered', actual: describe(updated.next_step?.actions) });
    return `walked to ${arrived.x},${arrived.y} by keyboard; guide target ${beforeDistance} → ${afterDistance} tiles without reload; no fixture claims Enter`;
  });

  await step('keyboard-only activation opens typed chat; only sending the typed text completes meeting', async () => {
    const garden = `home:${resident.id}`;
    const before = await readFirstPlay(page, resident.id, garden);
    expect(before.next_step?.id === 'meet' && before.next_step.actions.some((action) => action.id === 'meet-nearest'), 'the next step must be the meeting action this test drives', { expected: 'meet with a meet-nearest action', actual: describe({ next: before.next_step?.id, actions: before.next_step?.actions }) });
    const recipientId = fixtures().characters.neighbour.id;
    const rowCount = count('SELECT COUNT(*) AS n FROM messages WHERE agent_id=? AND channel=?', resident.id, 'private');
    const focused = await tabToGuideControl(page, (node) => node.action === 'meet-nearest', 'the guide’s next-action control');
    expect(focused.action === 'meet-nearest' && focused.text.includes('Message'), 'document.activeElement must really be the guide’s next-action button', { expected: 'the guide’s “Message …” control', actual: describe(focused) });
    const form = await openGuideComposer(page, () => page.keyboard.press('Enter'), resident.id, recipientId);
    const stillWaiting = await readFirstPlay(page, resident.id, garden);
    expect(stillWaiting.next_step?.id === 'meet' && stillWaiting.progress.done === before.progress.done,
      'the keyboard activation alone must not complete a meeting', { expected: describe({ next: before.next_step?.id, done: before.progress.done }), actual: describe({ next: stillWaiting.next_step?.id, done: stillWaiting.progress.done }) });
    const words = 'Hello. I am tending this garden. What bounded work are you doing here?';
    await page.keyboard.type(words);
    expect(await form.locator('[name="text"]').inputValue() === words, 'the operator must type the message rather than accept a canned one', { actual: describe(await form.locator('[name="text"]').inputValue()) });
    await page.keyboard.press('Tab');
    const submit = await page.evaluate(() => ({ text: (document.activeElement?.textContent || '').trim(), type: document.activeElement?.getAttribute('type') }));
    expect(submit.type === 'submit' && submit.text === 'Send message', 'Tab from the typed field must reach the real submit button', { expected: 'Send message submit button', actual: describe(submit) });
    await waitForMessageWindow(state.fixtures.firstTen.accountId);
    sentComposerNode = await form.elementHandle();
    const attempt = await withMessageWatch(page, async () => { await page.keyboard.press('Enter'); return waitForNewMessage(resident.id, rowCount); });
    const stored = attempt.value;
    expect(attempt.statuses.includes(200) && !attempt.statuses.includes(429), 'the page must see the typed keyboard message accepted (HTTP 200), never refused', { expected: 'HTTP 200', actual: describe(attempt.statuses) });
    const keyboardRefusal = await guideRefusal(page);
    expect(keyboardRefusal === '', 'the typed submission must not show a guide refusal', { expected: 'no refusal notice', actual: describe(keyboardRefusal) });
    expect(stored.agent_id === resident.id && stored.channel === 'private' && stored.text === words && JSON.parse(stored.recipients).includes(recipientId),
      'the saved row must contain only the operator’s exact typed words and the intended AI resident',
      { expected: describe({ agent_id: resident.id, channel: 'private', text: words, recipient: recipientId }), actual: describe(stored) });
    firstPrivateMessage = stored;
    const after = await readFirstPlay(page, resident.id, garden);
    expect(after.steps.find((item) => item.id === 'meet').done === true && after.progress.done === before.progress.done + 1,
      'only the saved private message may complete this character’s meeting step',
      { expected: `meet done; ${before.progress.done + 1} steps counted`, actual: describe({ next: after.next_step?.id, done: after.progress.done, steps: after.steps }) });
    const guide = await waitForCondition(async () => {
      const shown = await guideDom(page);
      return shown.done === after.progress.done ? shown : null;
    }, 'the rendered guide to re-read the saved typed meeting');
    expect(guide.progress === `Step ${after.next_step?.ordinal} of ${after.progress.total}` && guide.nextTitle === after.next_step?.title, 'the rendered guide must agree with the re-read it just made', { expected: `Step ${after.next_step?.ordinal} of ${after.progress.total} · ${after.next_step?.title}`, actual: describe({ progress: guide.progress, title: guide.nextTitle }) });
    return `Tab → Enter opened blank chat; typed ${words.length} characters → Tab → Enter saved private message ${stored.id} (HTTP ${attempt.statuses.join('/')}); guide advanced to ${guide.progress}`;
  });

  await step('a second typed reply keeps the private recipient after the first send rerenders the world', async () => {
    const garden = `home:${resident.id}`;
    const recipientId = fixtures().characters.neighbour.id;
    expect(sentComposerNode && await sentComposerNode.evaluate((node) => !node.isConnected),
      'the first accepted message must have replaced the original conversation form during a world render',
      { expected: 'the original form is disconnected', actual: sentComposerNode ? await sentComposerNode.evaluate((node) => ({ connected: node.isConnected })) : 'no original form' });
    const form = page.locator('#world-chat-card form');
    await form.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    const fresh = await form.evaluate((node) => ({ channel: node.elements.namedItem('channel')?.value, recipient: node.elements.namedItem('recipient_id')?.value, text: node.elements.namedItem('text')?.value }));
    expect(fresh.channel === 'private' && fresh.recipient === recipientId && fresh.text === '',
      'the fresh composer must keep the private channel and recipient while clearing the submitted words',
      { expected: { channel: 'private', recipient: recipientId, text: '' }, actual: fresh });
    const words = 'I can help with the next garden step. Which part needs a human operator?';
    await form.locator('[name="text"]').focus();
    await page.keyboard.type(words);
    expect(await form.locator('[name="text"]').inputValue() === words, 'the second message must also be typed by the operator', { actual: describe(await form.locator('[name="text"]').inputValue()) });
    const before = count('SELECT COUNT(*) AS n FROM messages WHERE agent_id=? AND channel=?', resident.id, 'private');
    await waitForMessageWindow(state.fixtures.firstTen.accountId);
    const attempt = await withMessageWatch(page, async () => { await form.getByRole('button', { name: 'Send message', exact: true }).click(); return waitForNewMessage(resident.id, before); });
    const saved = attempt.value;
    expect(attempt.statuses.includes(200) && !attempt.statuses.includes(429), 'the second typed reply must be accepted through the visible form', { expected: 'HTTP 200', actual: describe(attempt.statuses) });
    const pair = rows('SELECT id,agent_id,channel,text,recipients FROM messages WHERE id IN (?,?)', firstPrivateMessage.id, saved.id);
    expect(pair.length === 2 && pair.every((message) => message.agent_id === resident.id && message.channel === 'private' && JSON.parse(message.recipients).includes(recipientId)) && saved.text === words,
      'both saved messages must stay private to the same intended AI resident after the rerender',
      { expected: 'two private rows with the same sender and recipient, and exact second text', actual: describe(pair) });
    const observer = await api(fixtures().owner, 'GET', `/world?world_id=${encodeURIComponent(garden)}`);
    expect(observer.status === 200 && !observer.body?.messages?.some((message) => pair.some((privateMessage) => privateMessage.id === message.id || privateMessage.text === message.text)),
      'an unrelated operator’s world read must contain neither private turn',
      { expected: 'HTTP 200 with neither turn in messages', actual: describe({ status: observer.status, messages: observer.body?.messages?.map((message) => message.text).slice(-5) }) });
    const recipient = await api(fixtures().stranger, 'GET', `/world?world_id=${encodeURIComponent(garden)}&agent_id=${encodeURIComponent(recipientId)}`);
    expect(recipient.status === 200 && pair.every((message) => recipient.body?.messages?.some((entry) => entry.id === message.id && entry.channel === 'private' && entry.text === message.text)),
      'the addressed resident’s operator must be able to read both turns',
      { expected: 'HTTP 200 with both private turns', actual: describe({ status: recipient.status, messages: recipient.body?.messages?.map((message) => message.text).slice(-5) }) });
    const guide = await readFirstPlay(page, resident.id, garden);
    expect(guide.steps.find((item) => item.id === 'meet').done === true && guide.progress.done === 4,
      'the second message must preserve the one already completed meeting step without adding a fictitious step',
      { expected: 'meet=true, done=4', actual: describe({ done: guide.progress.done, meet: guide.steps.find((item) => item.id === 'meet') }) });
    await page.keyboard.press('Escape');
    return `two separately typed HTTP 200 messages remained private after the form rerender; an unrelated operator saw neither and the recipient operator saw both`;
  });

  await step('the guide dismisses and resumes from the keyboard alone', async () => {
    const beforeTitle = (await guideDom(page)).nextTitle;
    const dismiss = await tabToGuideControl(page, (node) => node.guide === 'dismiss', 'the guide’s dismiss control');
    expect(dismiss.guide === 'dismiss', 'document.activeElement must really be the dismiss control', { expected: 'data-guide="dismiss"', actual: describe(dismiss) });
    await page.keyboard.press('Enter');
    const dismissed = await guideDom(page);
    expect(dismissed.dismissal && dismissed.nextCards === 0, 'Enter on the dismiss control must immediately replace the action card with the dismissed bar', { expected: 'the dismissed bar and no action card', actual: describe({ dismissal: dismissed.dismissal, next: dismissed.nextCards }) });
    expect(dismissed.titles.length === 0, 'the dismissed bar must carry no task title', { actual: describe(dismissed.titles) });
    const resume = await tabToGuideControl(page, (node) => node.guide === 'resume', 'the guide’s resume control');
    expect(resume.guide === 'resume', 'document.activeElement must really be the resume control', { expected: 'data-guide="resume"', actual: describe(resume) });
    await page.keyboard.press('Enter');
    const resumed = await guideDom(page);
    expect(resumed.nextCards === 1 && resumed.nextTitle === beforeTitle, 'Enter on the resume control must immediately bring the action card back', { expected: beforeTitle, actual: describe({ next: resumed.nextCards, title: resumed.nextTitle }) });
    return `Tab → Enter dismissed to the bar, Tab → Enter resumed “${resumed.nextTitle}” — no pointer, no navigation`;
  });

  await step('a paused resident receives an announced refusal and recovers without invented restoration work', async () => {
    const garden = `home:${resident.id}`;
    const control = await pageWrite(page, '/agents/control', { agent_id: resident.id, status: 'paused' });
    expect(control.status === 200 && control.body?.status === 'paused', 'the operator must be able to pause its own resident', { expected: 'HTTP 200 with status=paused', actual: `HTTP ${control.status} ${describe(control.body)}` });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await openGameTab(page, 'Open world');
    await waitForGuide(page);
    const blockedRead = await readFirstPlay(page, resident.id, garden);
    expect(blockedRead.next_step?.id === 'restore' && blockedRead.next_step?.blocked?.code === 'resident_unavailable',
      'the server must report the paused resident on its still unfinished restoration step',
      { expected: 'restore blocked=resident_unavailable', actual: describe(blockedRead.next_step) });
    // The guide draws its own first-play read asynchronously. The server has just told this step that
    // the resident is unavailable, so wait for the card to carry that decision rather than sampling the
    // DOM a fixed second after the reload and hoping the render has landed.
    await waitForClient(page, () => document.querySelector('#game-guide-host .game-guide-card.game-guide-next [data-guide="blocked"]') ? true : null, null, 'the guide to render the paused resident’s refusal', 10_000);
    const card = await page.evaluate(() => {
      const next = document.querySelector('#game-guide-host .game-guide-card.game-guide-next');
      const action = next?.querySelector('.game-guide-action') || null;
      const alert = next?.querySelector('[data-guide="blocked"]') || null;
      const refusal = document.querySelector('#game-guide-host [data-guide="resume-refusal"]');
      return {
        actionRendered: Boolean(action && action.getClientRects().length),
        actionDisabled: Boolean(action?.disabled),
        actionAriaDisabled: action?.getAttribute('aria-disabled') || null,
        actionKey: action ? (action.getAttribute('data-guide-action') || '') : null,
        alertRole: alert?.getAttribute('role') || null,
        alertLive: alert?.getAttribute('aria-live') || null,
        alertText: (alert?.textContent || '').trim(),
        refusalText: (refusal?.textContent || '').trim(),
      };
    });
    expect(!card.actionRendered || card.actionDisabled && card.actionAriaDisabled === 'true',
      'a paused resident may have no available restoration action; any action it does show must be disabled and aria-disabled',
      { expected: 'no action, or an action that is disabled and aria-disabled="true"', actual: describe(card) });
    expect(card.alertRole === 'alert' && card.alertLive === 'assertive' && card.alertText.length > 0, 'the refusal must be announced as an assertive alert with text', { expected: 'role=alert with the refusal text', actual: describe({ role: card.alertRole, live: card.alertLive, text: card.alertText }) });
    expect(card.refusalText.length > 0, 'the resume card must state how to recover the resident', { actual: describe(card.refusalText) });
    const sweep = await tabSweepGuide(page);
    expect(!sweep.includes(`action:${card.actionKey}`), 'a natively disabled action is not in the tab order — it is announced, not focusable', { expected: `no action:${card.actionKey} among the tabbed controls`, actual: describe(sweep) });
    expect(sweep.length >= 1, 'the guide must stay keyboard-operable while blocked', { actual: describe(sweep) });
    const back = await pageWrite(page, '/agents/control', { agent_id: resident.id, status: 'active' });
    expect(back.status === 200 && back.body?.status === 'active', 'the resident must be resumable', { expected: 'HTTP 200 with status=active', actual: `HTTP ${back.status} ${describe(back.body)}` });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const recovered = await page.evaluate(() => {
      const action = document.querySelector('#game-guide-host .game-guide-card.game-guide-next .game-guide-action');
      return { rendered: Boolean(action && action.getClientRects().length), disabled: Boolean(action?.disabled), blocked: Boolean(document.querySelector('#game-guide-host [data-guide="blocked"]')) };
    });
    expect(recovered.blocked === false && (!recovered.rendered || recovered.disabled === false),
      'resuming the resident must remove the refusal without inventing a restoration action',
      { expected: 'no blocked alert; any available action enabled', actual: describe(recovered) });
    return `blocked restoration: refusal text announced, no enabled action, guide operable by Tab (${sweep.join(' → ')}), refusal cleared after resume`;
  });

  return 'one disposable operator chose a calling, saved a practice action, typed a private AI-resident message, walked and returned to a resumed place; every completed step came from saved rows';
});

// A genuinely new account has no second operator's AI resident in the Commons. The authored solo
// fallback must lead it to a scripted country ambassador; opening the question
// field writes nothing, and only a question asked by its own nearby character completes meeting.
define('first-play-solo-ambassador', async () => {
  const page = (await context('first-play-solo')).page;
  const EMAIL = 'tester.solo-ambassador@browser.test';
  const RESIDENT = 'Solo newcomer';
  const QUESTION = 'Which numbered country sources can I inspect before proposing a garden task?';
  let account = null, resident = null, starter = null;
  let displaced = [];

  try {
  await step('a new account chooses a calling with no other operator in the Commons', async () => {
    await openGame(page);
    await signUp(page, { name: 'Solo tester', email: EMAIL, password: PASSWORD });
    account = row('SELECT id,email,role FROM accounts WHERE email=?', EMAIL);
    expect(account?.role === 'member', 'the solo route must use a newly registered member account', { actual: describe(account) });
    resident = await createResidentThroughInterface(page, RESIDENT);
    await enterWorldAs(page, resident.id, RESIDENT);
    await openGameTab(page, 'Callings & guilds');
    const choice = page.locator(':is(#view, #game-panel-body) .calling-choice[data-calling="cultivator"]');
    await choice.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    await choice.getByRole('button', { name: /^Become/ }).click();
    await waitForCondition(async () => row("SELECT seq FROM audit WHERE event='calling.selected' AND record_id=?", resident.id), 'the solo resident’s calling selection to be saved');
    await openTab(page, 'Open world');
    starter = row("SELECT a.id,a.name,a.world_id,a.x,a.y FROM npc_ambassadors a JOIN worlds w ON w.id=a.world_id WHERE a.status='active' AND w.visibility='public' ORDER BY CASE WHEN a.iso3='NPL' THEN 0 ELSE 1 END,a.name LIMIT 1");
    expect(starter && /^country:/.test(starter.world_id), 'an active scripted country ambassador must stand in a public generated venue', { actual: describe(starter) });
    // The suite has independent AI fixtures. Keep them out of this new operator's path so this
    // scenario exercises the actual solo-install fallback, then restore their exact positions.
    displaced = rows("SELECT id,world_id,x,y,z FROM agents WHERE id!=? AND kind='agent' AND status='active' AND world_id IN (?,?)", resident.id, 'commons', starter.world_id);
    for (const other of displaced) write('UPDATE agents SET world_id=?,x=8,y=8,z=0 WHERE id=?', `home:${other.id}`, other.id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    await waitForGuide(page);
    const first = await readFirstPlay(page, resident.id, 'commons');
    expect(first.viewer?.world_id === 'commons' && first.encounter === null && first.next_step?.id === 'meet' && first.next_step?.actions?.[0]?.id === 'visit-ambassador' && first.next_step.target.world_id === starter.world_id,
      'the solo Commons must offer the country venue rather than pretending a live AI resident is present',
      { expected: `meet, no encounter, visit-ambassador into ${starter.world_id}`, actual: describe({ viewer: first.viewer, encounter: first.encounter, step: first.next_step }) });
    expect(first.progress.done === 2 && first.steps.find((item) => item.id === 'meet').done === false,
      'account creation and calling selection must leave the meeting unfinished', { expected: 'done=2, meet=false', actual: describe(first.progress) });
    return `new account ${account.id}, resident ${resident.id}, calling saved in Commons; the guide offers ${starter.world_id}`;
  });

    await step('the guide travels from the Commons directory into a public country venue', async () => {
      const directory = await readFirstPlay(page, resident.id, 'commons');
      expect(directory.encounter === null && directory.next_step?.actions?.[0]?.id === 'visit-ambassador' && directory.next_step.actions[0].route === `/agents/${resident.id}/travel` && directory.next_step.actions[0].body.world_id === starter.world_id,
        'the Commons guide must publish the shipped travel route into the scripted country venue',
        { expected: `visit-ambassador into ${starter.world_id}`, actual: describe({ encounter: directory.encounter, step: directory.next_step }) });
      const rendered = await waitForCondition(async () => {
        const guide = await guideDom(page);
        return guide.actions.some((action) => action.id === 'visit-ambassador') ? guide : null;
      }, 'the Commons guide to show its country venue action');
      expect(rendered.target?.includes(starter.world_id) || rendered.target?.includes('scripted ambassador'),
        'the visible target must explain the country fallback', { actual: describe(rendered.target) });
      await page.locator(GUIDE_NEXT).locator('[data-guide-action="visit-ambassador"]').click();
      await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', resident.id)?.world_id === starter.world_id ? true : null, 'the solo resident to enter the ambassador venue');
      expect(count("SELECT COUNT(*) AS n FROM audit WHERE actor=? AND event='world.entered' AND record_id=?", account.id, starter.world_id) === 1,
        'one real server travel action must record entry to the country venue', { expected: 'one world.entered row', actual: count("SELECT COUNT(*) AS n FROM audit WHERE actor=? AND event='world.entered' AND record_id=?", account.id, starter.world_id) });
      const arrived = await readFirstPlay(page, resident.id, starter.world_id);
      expect(arrived.steps.find((item) => item.id === 'meet').done === false,
        'travelling alone must not complete the conversation', { expected: 'meet=false', actual: describe(arrived.steps.find((item) => item.id === 'meet')) });
      return `guide travel saved Commons → ${starter.world_id}; meeting remains unfinished`;
    });

    await step('walking into range reveals the scripted ambassador and its bounded question action', async () => {
      const before = await readFirstPlay(page, resident.id, starter.world_id);
      const initial = row('SELECT x,y FROM agents WHERE id=?', resident.id);
      const startingDistance = Math.abs(initial.x - starter.x) + Math.abs(initial.y - starter.y);
      if (startingDistance > 6) {
        const refused = await inPage(page, '/ambassadors/talk', { body: { ambassador_id: starter.id, agent_id: resident.id, question: 'A premature test question' } });
        expect(refused.status === 409 && count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', account.id) === 0,
          'a character outside six tiles must be refused without saving an ambassador turn',
          { expected: 'HTTP 409 and zero rows', actual: describe({ status: refused.status, body: refused.body }) });
      }
      if (startingDistance > 1) {
        const objects = rows('SELECT type,x,y FROM world_objects WHERE world_id=?', starter.world_id);
        const route = planWalk(getWorldDefinition(starter.world_id), initial, { x: starter.x, y: starter.y - 1 }, { objects });
        expect(Array.isArray(route) && route.length > 0, 'the authored country venue must have a walkable route to the ambassador’s stand', { actual: describe({ initial, stand: starter, route }) });
        const keys = { up: 'w', right: 'd', down: 's', left: 'a' };
        await page.locator('#world').focus();
        for (const direction of route) {
          await walkWithKeyboard(page, resident.id, [keys[direction]]);
          await sleep(150); // the same 120 ms server movement limit every human keyboard walk obeys
        }
      }
      const position = row('SELECT world_id,x,y FROM agents WHERE id=?', resident.id);
      const distance = Math.abs(position.x - starter.x) + Math.abs(position.y - starter.y);
      expect(position.world_id === starter.world_id && distance <= 6, 'the character must physically stand within the server’s encounter radius', { expected: `in ${starter.world_id}, distance <= 6`, actual: describe({ position, distance }) });
      const near = await readFirstPlay(page, resident.id, starter.world_id);
      expect(near.encounter?.kind === 'npc' && near.encounter.scripted === true && near.encounter.npc_id === starter.id && near.next_step?.actions?.[0]?.id === 'meet-nearest',
        'the nearby guide must describe the scripted ambassador and offer its question action',
        { expected: `scripted ${starter.id} with meet-nearest`, actual: describe({ encounter: near.encounter, step: near.next_step }) });
      expect(near.next_step.actions[0].body.agent_id === resident.id && near.next_step.actions[0].body.ambassador_id === starter.id,
        'the authored question action must bind the selected character and the country ambassador', { actual: describe(near.next_step.actions[0].body) });
      const card = await waitForCondition(async () => {
        const guide = await guideDom(page);
        return guide.actions.some((action) => action.id === 'meet-nearest') ? guide : null;
      }, 'the guide to refresh after the walk');
      const encounter = (await page.locator('#game-guide-host .game-guide-encounter').textContent()) || '';
      expect(/Scripted resident/.test(encounter) && encounter.includes(starter.name) && /cannot/i.test(encounter),
        'the visible encounter must identify the ambassador as scripted and state its limits', { actual: encounter.slice(0, 400) });
      return `walked from ${initial.x},${initial.y} to ${position.x},${position.y}; ${card.actions[0].label} appears with a scripted-resident limitation`;
    });

    await step('only an operator-typed nearby question saves the meeting for this character', async () => {
      const before = count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', account.id);
      const writes = [];
      const recordRequest = (request) => { if (request.method() === 'POST' && request.url().includes('/api/v1/ambassadors/talk')) writes.push(request.postDataJSON()); };
      page.on('request', recordRequest);
      let dialog;
      try {
        await page.locator(GUIDE_NEXT).locator('[data-guide-action="meet-nearest"]').click();
        dialog = page.locator('dialog.mayor-dialog');
        await dialog.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
        const question = dialog.locator('[aria-label="Your question"]');
        expect(await question.inputValue() === '' && writes.length === 0 && count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', account.id) === before,
          'opening the ambassador composer must leave it blank and save no canned question',
          { expected: 'blank question, zero POSTs and rows', actual: describe({ value: await question.inputValue(), writes, before }) });
      } finally { page.off('request', recordRequest); }
      const field = dialog.locator('[aria-label="Your question"]');
      await field.focus();
      await page.keyboard.type(QUESTION);
      expect(await field.inputValue() === QUESTION, 'the solo operator must type its own country question', { expected: QUESTION, actual: await field.inputValue() });
      const responses = [];
      const recordResponse = (response) => {
        if (response.request().method() === 'POST' && response.url().includes('/api/v1/ambassadors/talk')) {
          responses.push({ status: response.status(), body: response.request().postDataJSON() });
        }
      };
      page.on('response', recordResponse);
      let stored;
      try {
        await dialog.getByRole('button', { name: /^Ask / }).click();
        stored = await waitForCondition(async () => row('SELECT id,account_id,ambassador_id,question,answer FROM ambassador_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 1', account.id), 'the nearby question to be saved');
        await waitForCondition(async () => responses.length ? true : null, 'the browser’s ambassador talk response');
      } finally { page.off('response', recordResponse); }
      expect(responses.length === 1 && responses[0].status === 200 && responses[0].body?.agent_id === resident.id && responses[0].body?.ambassador_id === starter.id,
        'the real dialog must send one accepted question bound to this nearby character and ambassador',
        { expected: `one HTTP 200 with agent_id=${resident.id} and ambassador_id=${starter.id}`, actual: describe(responses) });
      expect(count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', account.id) === before + 1 && stored.ambassador_id === starter.id && stored.question === QUESTION,
        'one exact question and its scripted response must be stored against the new account', { actual: describe(stored) });
      expect(count("SELECT COUNT(*) AS n FROM audit WHERE actor=? AND event='firstplay.ambassador_met' AND record_id=?", account.id, `${resident.id}|${stored.id}`) === 1,
        'the server must attribute this saved nearby question to this character exactly once', { actual: 'the meeting audit was missing or duplicated' });
      const after = await readFirstPlay(page, resident.id, starter.world_id);
      expect(after.progress.done === 3 && after.steps.find((item) => item.id === 'meet').done === true && after.next_step?.id === 'practice',
        'only the accepted nearby question may advance this character to the practice step',
        { expected: 'done=3, meet=true, next=practice', actual: describe({ progress: after.progress, steps: after.steps, next: after.next_step }) });
      await dialog.locator('button', { hasText: 'Close' }).first().click();
      return `typed ${QUESTION.length} characters, HTTP 200, one attributed conversation ${stored.id}; guide advanced to practice`;
    });

    await step('the attributed meeting and the country venue survive a reload', async () => {
      const saved = row('SELECT world_id,x,y,z FROM agents WHERE id=?', resident.id);
      const conversations = count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=? AND ambassador_id=?', account.id, starter.id);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page);
      await waitForGuide(page);
      const resumed = row('SELECT world_id,x,y,z FROM agents WHERE id=?', resident.id);
      const guide = await readFirstPlay(page, resident.id, starter.world_id);
      expect(describe(resumed) === describe(saved) && guide.resume?.world_id === starter.world_id && guide.progress.done === 3 && guide.steps.find((item) => item.id === 'meet').done === true,
        'reload must retain the resident’s exact venue position and the server-derived meeting',
        { expected: describe({ saved, done: 3, meet: true }), actual: describe({ resumed, progress: guide.progress, meet: guide.steps.find((item) => item.id === 'meet') }) });
      expect(count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=? AND ambassador_id=?', account.id, starter.id) === conversations,
        'returning must neither lose nor duplicate the saved question', { expected: conversations, actual: count('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=? AND ambassador_id=?', account.id, starter.id) });
      return `reloaded at ${saved.world_id}:${saved.x},${saved.y}; one saved scripted encounter still completes meeting`;
    });
  } finally {
    for (const other of displaced) write('UPDATE agents SET world_id=?,x=?,y=?,z=? WHERE id=?', other.world_id, other.x, other.y, other.z, other.id);
  }

  return `one newly registered solo account reached ${starter.world_id}, typed a distance-checked question to its scripted ambassador and resumed with the saved meeting`;
});

// ---------------------------------------------------------------------------------------------
// Scenario — one shared restoration seen by two browsers
//
// Two operators, two independent browser contexts, one public garden that no earlier scenario used.
// A opens the restoration on its own garden and takes the groundskeeping step; B travels in, pledges
// and places the second planned object. Every claim is checked against `community_events`,
// `community_rsvps`, `world_objects` and `audit`, the page's own world payload, and the guide's
// shared-restoration card, which must attribute each counted step to its own operator.
// ---------------------------------------------------------------------------------------------

define('restoration-two-clients', async () => {
  const owner = await actor('owner');
  const stranger = await actor('stranger');

  // A fresh operator session for the second operator: an earlier scenario revokes every stored session
  // token of this account, so its fixture session cannot be reused.
  const strangerTicket = await apiOperatorSession(ACTORS.stranger.email, PASSWORD);
  const gardener = await apiExpect(fixtures().owner, 'POST', '/agents', { name: 'Aster the builder', kind: 'agent', color: '#397f79', symbol: '✦', capabilities: 'Carries and places the plan’s own objects', limitations: 'No external tools and no real-world claims' });
  const helper = await apiExpect(strangerTicket, 'POST', '/agents', { name: 'Bramble the builder', kind: 'agent', color: '#aa7845', symbol: '✿', capabilities: 'Carries and places the plan’s own objects', limitations: 'No external tools and no real-world claims' });
  await apiExpect(fixtures().owner, 'POST', '/callings/select', { agent_id: gardener.id, calling_id: 'builder' });
  await apiExpect(strangerTicket, 'POST', '/callings/select', { agent_id: helper.id, calling_id: 'builder' });
  const garden = `home:${gardener.id}`;
  const eventId = `restoration:${garden}`;
  const [firstSlot, secondSlot] = RESTORATION_GROUND.slots;

  await step('the garden is opened to visitors and the owner opens one restoration through the interface', async () => {
    await apiPatch(fixtures().owner, `/agents/${gardener.id}/home`, { visibility: 'public' });
    await openApp(owner.page, ACTORS.owner);
    await selectResidentAndSettle(owner.page, gardener.id, gardener.name);
    await openTab(owner.page, 'Open world');
    await owner.page.locator('#view').getByRole('button', { name: 'Go home', exact: true }).first().click();
    await waitForCondition(async () => row('SELECT world_id FROM agents WHERE id=?', gardener.id).world_id === garden ? garden : null, 'the owner’s resident to travel into the garden it will restore');
    await openRestoration(owner.page);
    await openDisclosure(owner.page, 'Open a restoration');
    const form = owner.page.locator('form[data-draft-section="restoration-open"]');
    await form.locator('[name="hours"]').fill('3');
    await form.getByRole('button', { name: 'Open the restoration', exact: true }).click();
    const stored = await waitForCondition(async () => row('SELECT * FROM community_events WHERE id=?', eventId), 'the restoration occurrence to be stored');
    expect(stored.status === 'scheduled', 'the occurrence must be scheduled', { actual: describe(stored.status) });
    expect(stored.world_id === garden && stored.creator_agent_id === gardener.id, 'the occurrence must name the garden and its convenor', { actual: describe({ world: stored.world_id, creator: stored.creator_agent_id }) });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.opened' AND record_id=?", eventId) === 1, 'opening must write exactly one audit row', { actual: 'the audit count differs' });
    state.fixtures.restoration = { id: eventId, garden, gardener: gardener.id, helper: helper.id };
    return `community_events ${eventId} scheduled; audit restoration.opened written once`;
  });

  await step('the owner pledges and places the first planned object as a Groundskeeper', async () => {
    await openRestorationEvent(owner.page, eventId);
    await owner.page.locator('#view').getByRole('button', { name: 'Pledge to help with this restoration', exact: true }).click();
    await waitForCondition(async () => count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=? AND agent_id=?', eventId, gardener.id) === 1 ? true : null, 'the owner’s pledge to be stored');
    expect(count('SELECT COUNT(*) AS n FROM community_events WHERE id=?', eventId) === 1, 'the restoration must still be exactly one row', { actual: 'the event count differs' });
    const pledged = await readFirstPlay(owner.page, gardener.id, garden);
    const pledgedWork = pledged.restoration?.actors.find((actor) => actor.agent_id === gardener.id)?.contributions || [];
    expect(pledged.steps.find((item) => item.id === 'restore').done === false && pledgedWork.length === 0 && pledged.restoration?.steps_completed === 0,
      'a pledge must be visible as a promise but cannot count as restoration work or finish the guide',
      { expected: 'restore=false, no counted contribution, 0 completed steps', actual: describe({ restore: pledged.steps.find((item) => item.id === 'restore'), work: pledgedWork, steps_completed: pledged.restoration?.steps_completed }) });
    placeResident(gardener.id, garden, firstSlot.x, firstSlot.y - 1);
    await owner.page.locator('#view').getByRole('button', { name: `Place the ${firstSlot.type} at ${firstSlot.x}, ${firstSlot.y}`, exact: true }).click();
    const saved = await waitForCondition(async () => row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, firstSlot.x, firstSlot.y), `the ${firstSlot.type} to be saved on its planned tile`);
    expect(saved.type === firstSlot.type, 'the saved object must be the object the plan named', { expected: firstSlot.type, actual: describe(saved.type) });
    const firstAudit = `${eventId}|${gardener.id}|${firstSlot.x},${firstSlot.y}|${firstSlot.type}`;
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.placed' AND record_id=?", firstAudit) === 1,
      'the first placement audit must name this operator’s resident, exact tile and object once', { actual: describe(firstAudit) });
    const first = await readFirstPlay(owner.page, gardener.id, garden);
    const firstCounted = first.restoration?.actors.find((actor) => actor.agent_id === gardener.id)?.contributions.find((item) => item.step_id === 'ground')?.counted;
    expect(firstCounted === 1 && first.steps.find((item) => item.id === 'restore').done === false,
      'one operator’s counted placement must remain unfinished until another operator saves work',
      { expected: 'ground counted=1; restore=false', actual: describe({ counted: firstCounted, restore: first.steps.find((item) => item.id === 'restore') }) });
    return `community_rsvps row for ${gardener.id}; world_objects ${saved.type} at ${firstSlot.x},${firstSlot.y}`;
  });

  await step('the stranger travels in, pledges and places the second planned object', async () => {
    await travelTo(strangerTicket, helper.id, garden);
    expect(count('SELECT COUNT(*) AS n FROM journey_visits WHERE agent_id=? AND world_id=?', helper.id, garden) === 1, 'walking in must record the visit a pledge requires', { actual: 'no journey_visits row' });
    await openApp(stranger.page, ACTORS.stranger);
    await selectResident(stranger.page, helper.id, helper.name);
    placeResident(helper.id, garden, secondSlot.x, secondSlot.y - 1);
    await openRestorationEvent(stranger.page, eventId);
    await stranger.page.locator('#view').getByRole('button', { name: 'Pledge to help with this restoration', exact: true }).click();
    await waitForCondition(async () => count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', eventId) === 2 ? true : null, 'both pledges to be stored');
    expect(rows('SELECT DISTINCT a.operator_id FROM community_rsvps r JOIN agents a ON a.id=r.agent_id WHERE r.event_id=?', eventId).length === 2, 'the pledges must come from two operators', { actual: describe(rows('SELECT a.operator_id FROM community_rsvps r JOIN agents a ON a.id=r.agent_id WHERE r.event_id=?', eventId)) });
    const promiseOnly = await readFirstPlay(stranger.page, helper.id, garden);
    expect(promiseOnly.steps.find((item) => item.id === 'restore').done === false &&
      !(promiseOnly.restoration?.actors.find((actor) => actor.agent_id === helper.id)?.contributions || []).length,
    'two distinct pledges alone must still leave the helper with no counted work and an unfinished guide',
    { expected: 'helper restore=false, no counted contribution', actual: describe({ restore: promiseOnly.steps.find((item) => item.id === 'restore'), actor: promiseOnly.restoration?.actors.find((actor) => actor.agent_id === helper.id) }) });
    await stranger.page.locator('#view').getByRole('button', { name: `Place the ${secondSlot.type} at ${secondSlot.x}, ${secondSlot.y}`, exact: true }).click();
    const saved = await waitForCondition(async () => row('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, secondSlot.x, secondSlot.y), `the ${secondSlot.type} to be saved on its planned tile`);
    expect(saved.type === secondSlot.type, 'the stranger’s saved object must be the object the plan named', { expected: secondSlot.type, actual: describe(saved.type) });
    const secondAudit = `${eventId}|${helper.id}|${secondSlot.x},${secondSlot.y}|${secondSlot.type}`;
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.placed' AND record_id=?", secondAudit) === 1,
      'the second placement audit must name the other operator’s resident, exact tile and object once', { actual: describe(secondAudit) });
    expect(count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.opened'") >= 1 && count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.joined'") >= 2 && count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.placed'") >= 2, 'the audit trail must hold the open, both joins and both placements', { actual: describe({ opened: count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.opened'"), joined: count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.joined'"), placed: count("SELECT COUNT(*) AS n FROM audit WHERE event='restoration.placed'") }) });
    for (const [page, agentId] of [[owner.page, gardener.id], [stranger.page, helper.id]]) {
      const derived = await readFirstPlay(page, agentId, garden);
      expect(derived.steps.find((item) => item.id === 'restore').done === true,
        'the guide may complete shared restoration only after both distinct operators placed counted objects',
        { expected: 'restore=true from two saved objects', actual: describe({ viewer: agentId, restore: derived.steps.find((item) => item.id === 'restore'), actors: derived.restoration?.actors }) });
    }
    return `two pledges and two distinct operators’ counted placements; world_objects ${saved.type} at ${secondSlot.x},${secondSlot.y}; both derived guides record restoration done`;
  });

  await step('neither browser can mark a step, and the guide attributes each counted step', async () => {
    const rsvpsBefore = count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', eventId);
    const objectsBefore = count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden);
    for (const [page, agentId] of [[owner.page, gardener.id], [stranger.page, helper.id]]) {
      const forged = await inPage(page, '/quests/complete', { body: { agent_id: agentId, chain_id: 'gathering-garden' } });
      expect(forged.status === 400, 'a raw client completion must be refused with the derived-fact rule', { expected: 'HTTP 400', actual: `HTTP ${forged.status} ${describe(forged.body)}` });
      const forgedRead = await inPage(page, `/first-play?agent_id=${encodeURIComponent(agentId)}&world_id=${encodeURIComponent(garden)}&completed=restore`, { method: 'GET' });
      expect(forgedRead.status === 400, 'a client-supplied completion flag must not enter the guide read', { expected: 'HTTP 400', actual: `HTTP ${forgedRead.status} ${describe(forgedRead.body)}` });
    }
    expect(count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', eventId) === rsvpsBefore, 'a refused completion must write no participation row', { actual: 'the rsvp count changed' });
    expect(count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden) === objectsBefore, 'a refused completion must write no object', { actual: 'the object count changed' });
    // The guide only exists in the game presentation, so both browsers now enter the game shell at
    // the garden their resident stands in.
    await enterGameShell(owner.page);
    await enterGameShell(stranger.page);
    let remaining = [];
    for (const [page, mine, other] of [[owner.page, gardener.name, helper.name], [stranger.page, helper.name, gardener.name]]) {
      const guide = await guideDom(page);
      expect(guide.hasRestoration, 'the guide must render the shared-restoration card', { actual: 'no .game-guide-restoration card' });
      const otherRow = guide.restorationRows.find((entry) => entry.actor === other);
      const mineRow = guide.restorationRows.find((entry) => entry.actor === mine);
      expect(otherRow && otherRow.distinct === 'true' && otherRow.step === 'ground' && Number(otherRow.cells[2]) >= 1, 'the guide must attribute the other operator’s counted step to its own name', { expected: `${other} · ground · counted with data-distinct=true`, actual: describe(guide.restorationRows) });
      expect(mineRow && mineRow.distinct === 'false' && mineRow.step === 'ground' && Number(mineRow.cells[2]) >= 1, 'the guide must attribute the viewer’s own counted step to its own name', { expected: `${mine} · ground · counted with data-distinct=false`, actual: describe(guide.restorationRows) });
      expect(guide.remaining.length >= 3, 'the card must list what remains with the surviving steps', { actual: describe(guide.remaining) });
      remaining = guide.remaining;
      const live = await page.evaluate((world) => { const view = window.__nemoworld?.world?.(); return { world: view?.world?.id, objects: (view?.objects || []).map((object) => `${object.type}@${object.x},${object.y}`) }; }, garden);
      expect(live.world === garden && live.objects.includes(`${firstSlot.type}@${firstSlot.x},${firstSlot.y}`) && live.objects.includes(`${secondSlot.type}@${secondSlot.x},${secondSlot.y}`), 'the page’s own world payload must show both placed objects', { expected: `${firstSlot.type}@${firstSlot.x},${firstSlot.y} and ${secondSlot.type}@${secondSlot.x},${secondSlot.y}`, actual: describe(live) });
    }
    await mkdir(join(RESULTS, 'restoration-two-clients'), { recursive: true });
    await captureGuide(owner.page, join(RESULTS, 'restoration-two-clients', 'desktop.png'));
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await owner.page.waitForTimeout(250);
    await captureGuide(owner.page, join(RESULTS, 'restoration-two-clients', 'phone.png'));
    await owner.page.setViewportSize({ width: 1440, height: 900 });
    return `both guides named ${gardener.name} (data-distinct=true for ${helper.name}) and ${helper.name} (data-distinct=false for itself), with ${remaining.length} steps remaining`;
  });

  await step('the shared result survives a reload in both browsers', async () => {
    const snapshot = () => ({
      objects: rows('SELECT type,x,y FROM world_objects WHERE world_id=? ORDER BY x,y', garden),
      rsvps: rows('SELECT agent_id FROM community_rsvps WHERE event_id=? ORDER BY agent_id', eventId),
      event: row('SELECT status,starts_at,ends_at FROM community_events WHERE id=?', eventId),
    });
    const before = snapshot();
    await owner.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(owner.page);
    await waitForGuide(owner.page);
    await stranger.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(stranger.page);
    await waitForGuide(stranger.page);
    expect(describe(snapshot()) === describe(before), 'the placement, the two pledges and the occurrence must survive the reload', { expected: describe(before), actual: describe(snapshot()) });
    for (const page of [owner.page, stranger.page]) {
      const guide = await guideDom(page);
      expect(guide.hasRestoration && guide.restorationRows.length >= 2, 'the reloaded guide must keep both attributions', { actual: describe(guide.restorationRows) });
    }
    for (const [page, agentId] of [[owner.page, gardener.id], [stranger.page, helper.id]]) {
      const derived = await readFirstPlay(page, agentId, garden);
      expect(derived.steps.find((item) => item.id === 'restore').done === true,
        'the shared restoration step must remain derived as done after both browser reloads', { actual: describe({ viewer: agentId, restore: derived.steps.find((item) => item.id === 'restore') }) });
    }
    const view = await inPage(stranger.page, `/world?world_id=${encodeURIComponent(garden)}&agent_id=${encodeURIComponent(helper.id)}`, { method: 'GET' });
    const types = (view.body.objects || []).map((object) => `${object.type}@${object.x},${object.y}`);
    expect(types.includes(`${firstSlot.type}@${firstSlot.x},${firstSlot.y}`) && types.includes(`${secondSlot.type}@${secondSlot.x},${secondSlot.y}`), 'the world read must still publish both placed objects', { actual: describe(types) });
    return `after the reload: ${before.objects.length} objects in ${garden}, ${before.rsvps.length} pledges, the guide still attributed both operators`;
  });

  return `two browsers restored ${garden} together: ${count('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden)} objects saved, ${count('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', eventId)} pledges from two operators, every step derived from the rows the world already held`;
});

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}

