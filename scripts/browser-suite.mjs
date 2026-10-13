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
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESULTS = join(ROOT, 'test-results');
const PUBLIC_HOST = '127.0.0.1';
const PASSWORD = 'browser-acceptance-password-2026';
const REQUEST_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 120_000;
const SCENARIO_TIMEOUT_MS = 300_000;
const PAGE_TIMEOUT_MS = 25_000;

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
  { id: 'accounts-and-switching', title: 'Signup, login, logout and account switching', regression: null },
  { id: 'credential-exclusion', title: 'Credential exclusion from browser storage', regression: 'queue review correction 2' },
  { id: 'private-draft-isolation', title: 'Private draft isolation between operators', regression: 'queue review correction 2' },
  { id: 'refresh-and-focus-restoration', title: 'Refresh returns to the right form and restores focus', regression: 'queue review correction 3' },
  { id: 'first-person-controls', title: 'First-person movement, drag-look and the aim line', regression: null },
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
  { id: 'interaction-saved-world-changes', title: 'A planted crop patch and a bench posture survive a reload', regression: null },
  { id: 'interaction-door-and-crafting', title: 'A doorway travels to another world and a crafting station crafts once per click', regression: null },
  { id: 'interaction-ambassador-desk', title: 'A country ambassador desk answers through the existing conversation action', regression: null },
  { id: 'interaction-state-refusals', title: 'Paused, revoked, wrong-owner and observer refusals keep the server authoritative', regression: null },
  { id: 'consolidated-proposal-history', title: 'Retired research templates remain readable but cannot become missions', regression: 'batch 02 integration correction' },
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
  if (state.contexts.has(key)) return state.contexts.get(key);
  const browserContext = await state.browser.newContext({ viewport: { width: 1440, height: 900 } });
  browserContext.setDefaultTimeout(PAGE_TIMEOUT_MS);
  await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await browserContext.newPage();
  attachPageLogs(page, key);
  const record = { key, context: browserContext, page };
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
};

/**
 * Opens the application. When operator credentials are supplied the session is restored if the
 * cookie is still valid, and a sign-in runs through the interface only when it is not, so a focused
 * run of one scenario still starts from a real signed-in session.
 */
async function openApp(page, credentials = null) {
  await page.goto(`${baseUrl()}/`, { waitUntil: 'domcontentloaded' });
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
      if (/Too many authentication attempts/i.test(observed.notice)) { outcome = 'rate-limited'; break; }
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
  try {
    await withTimeout(runImplementation(definition), SCENARIO_TIMEOUT_MS, `scenario "${definition.id}"`);
    await discardTraces();
    state.results.push({ id: definition.id, ok: true, ms: Date.now() - started });
    console.log(`PASS  ${definition.id} — ${definition.title} (${Date.now() - started} ms)`);
    return true;
  } catch (error) {
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
      if (id !== 'accounts-and-switching' && !state.fixtures.ready) {
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
async function makeMission(title, tag) {
  const admin = fixtures().admin, reviewer = fixtures().reviewer;
  const mission = await apiExpect(admin, 'POST', '/missions', {
    title, area: 'Climate', summary: 'A bounded fixture mission for the browser acceptance run.',
    beneficiary: 'Acceptance community', owner_id: admin.id, reviewer_id: reviewer.id,
    rubric: 'Check the exact source, its date, its rights and the remaining uncertainty.',
  });
  const task = await apiExpect(admin, 'POST', '/tasks', {
    mission_id: mission.id, title: `Record one source (${tag})`, instructions: 'Provide the source, its exact location, rights and uncertainty.',
    rights: 'Public material with attribution.', allowed_domains: ['example.org'],
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
    expect(count('SELECT COUNT(*) AS n FROM accounts') === 1, 'the first signup must create exactly one account', { actual: `accounts=${count('SELECT COUNT(*) AS n FROM accounts')}` });
    expect(await signedInName(page) === ACTORS.admin.name, 'the session bar must name the signed-in administrator', { actual: await signedInName(page) });
    state.fixtures.adminAccountId = account.id;
    return `201 in the browser · account ${account.id} role=admin · one account in the temporary database`;
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
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
    if (attempt > 0) {
      retries += 1;
      console.log(`        walk retry       the server’s own movement throttle refused a step; resuming the walk into ${plotId}`);
      await page.waitForTimeout(800);
    }
    await page.locator('#plot-detail').getByRole('button', { name: 'Walk to plot', exact: true }).click();
    const reached = await waitForCondition(() => (inside(row('SELECT x,y,world_id FROM agents WHERE id=?', agentId)) ? true : null), 'the resident to step into the plot', { timeout: Math.min(60_000, Math.max(2000, deadline - Date.now())) }).catch(() => null);
    if (reached) {
      const position = await waitForResidentToSettle(agentId);
      if (inside(position)) {
        if (retries) state.notes.push(`the walk into ${plotId} was resumed ${retries} time(s) after the server’s own movement throttle refused a step`);
        return position;
      }
    }
    const notice = ((await page.locator('#notice').textContent().catch(() => '')) || '').trim();
    if (!throttleRefusal(notice)) {
      throw new BrowserSuiteFailure(`the walk into ${plotId} stopped short of the plot`, { expected: `a tile inside ${plotId}`, actual: `${describe(row('SELECT x,y,world_id FROM agents WHERE id=?', agentId))}; the interface said “${notice}”` });
    }
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
    await openTab(stranger.page, 'Guild projects');
    const board = await stranger.page.locator('#view').textContent();
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
    const stored = await waitForCondition(async () => {
      const participants = rows('SELECT p.agent_id,p.role,p.state,a.operator_id FROM guild_participants p JOIN agents a ON a.id=p.agent_id WHERE p.project_id=?', state.fixtures.guildProjects.public.id);
      return participants.length ? participants : null;
    }, 'the participation to be stored');
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
  if (await select.count()) { await select.selectOption(agentId); await settle(page); await page.waitForTimeout(500); }
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
    await apiPatch(fixtures().owner, `/agents/${walker.id}/home`, { visibility: 'private' });
    const closed = await waitForClient(stranger.page, () => { const c = window.__nemoworld?.lastClosed?.(); return c && c.reason === 'access_revoked' ? c : null; }, null, 'the outsider’s subscription to be revoked', 5000);
    expect(closed.reason === 'access_revoked', 'the revocation must name the lost access', { expected: 'access_revoked', actual: describe(closed) });
    // The client is told, and a direct subscription attempt while private is refused as well.
    const notice = await stranger.page.locator('#notice').textContent().catch(() => '');
    expect(/no longer open to you|garden is now private/i.test(notice || ''), 'the client must explain why the live feed stopped', { actual: describe((notice || '').trim().slice(0, 160)) });
    const refused = await inPage(stranger.page, `/events?world_id=${encodeURIComponent(garden)}`, { method: 'GET' });
    expect(refused.status === 403, 'an authenticated but unentitled client must be refused the private channel', { expected: 'HTTP 403', actual: `HTTP ${refused.status}` });
    return `access_revoked closed the stream and a fresh subscription answered ${refused.status}`;
  });

  await step('a session revoked mid-subscription loses its live feed', async () => {
    // Reopen the public garden (the step above made it private), then establish a *fresh* subscription
    // and revoke the stored session credential directly. This is the server-side revocation the
    // channel must notice by itself: the client keeps its stream open and is not the one that closes
    // it. A client that was told its access was revoked stops retrying that world, so the subscription
    // is rebuilt from a reloaded page instead of assuming the visitor's page resubscribes on its own
    // (or depending on whichever world an earlier scenario left that page showing).
    await apiPatch(fixtures().owner, `/agents/${walker.id}/home`, { visibility: 'public' });
    expect(count('SELECT COUNT(*) AS n FROM worlds WHERE id=? AND visibility=?', garden, 'public') === 1, 'the garden must be public again before the visitor resubscribes', { actual: describe(row('SELECT id,visibility FROM worlds WHERE id=?', garden)) });
    await stranger.page.reload({ waitUntil: 'domcontentloaded' });
    await settle(stranger.page);
    const stream = await outsiderLooksAtPublicGarden(stranger.page, walker.name, garden);
    expect(stream.ready && stream.world === garden, 'the visitor must hold a fresh subscription to the reopened garden', { expected: `a ready stream on ${garden}`, actual: describe(stream) });
    write("UPDATE tokens SET revoked=1 WHERE kind='session' AND account_id=?", state.fixtures.stranger.id);
    const closed = await waitForClient(stranger.page, () => { const c = window.__nemoworld?.lastClosed?.(); return c && c.reason === 'session_revoked' ? c : null; }, null, 'the revoked session to lose its subscription', 8000);
    expect(closed.reason === 'session_revoked', 'a revoked credential must end the subscription', { expected: 'session_revoked', actual: describe(closed) });
    const live = count("SELECT COUNT(*) AS n FROM tokens t JOIN accounts a ON a.id=t.account_id WHERE a.email=? AND t.kind='session' AND t.revoked=0", ACTORS.stranger.email);
    expect(live === 0, 'the session credential must be revoked in the database', { actual: `live=${live}` });
    return `session_revoked closed the feed while the stored session token is revoked`;
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
    const stored = await waitForCondition(async () => row('SELECT account_id,ambassador_id,question FROM ambassador_conversations WHERE account_id=? ORDER BY created_at DESC LIMIT 1', state.fixtures.owner.id), 'the conversation turn to be stored');
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

// The suite runs only when it is the entry point, so a unit test can import the pure helpers above
// (and `npm test` keeps passing with no node_modules directory).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
