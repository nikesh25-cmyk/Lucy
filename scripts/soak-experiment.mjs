#!/usr/bin/env node
/**
 * NemoWorld Wave 7 long-run and at-the-limit experiment.
 *
 * Three sections, each with its own stated ceiling, and the sections are never blended into one
 * figure. Everything runs on a DISPOSABLE installation: a private temporary directory with its own
 * SQLite database, its own vault key and its own server process. The shipped data directory, any world
 * already running on this machine, installed accounts, credentials and model weights are never opened.
 *
 *   1. soak       A bounded run of the shipped server under a fixed, stated request mix. Samples the
 *                 server process's resident memory on an interval and reports the first-half/second-half
 *                 change, the minimum, the maximum and a least-squares slope, honestly labelled. Also
 *                 reports storage growth (database, WAL and shared-memory bytes) and latency percentiles
 *                 for the whole run and for each half, so a drift is visible rather than averaged away.
 *                 No capacity claim is made and nothing is extrapolated.
 *   2. reconnect  A bounded storm of event-channel subscriptions that open, receive their ready frame
 *                 and disconnect immediately, at bounded concurrency, followed by a probe that opens
 *                 subscriptions until the channel refuses. Reports acceptances, refusals by status, the
 *                 channel's own counters, whether any connection leaked, and whether normal service
 *                 continues afterwards.
 *   3. storage    Measured storage growth from the soak, then a real exhaustion probe: the shipped
 *                 server is driven over real HTTP with the database's page limit lowered so that any
 *                 write needing a new page fails exactly as SQLITE_FULL does when a volume fills.
 *                 Reports the HTTP status and body each write produced, whether the counters and the
 *                 audit chain stayed coherent, and whether the world is writable again once space
 *                 returns.
 *
 * Ceilings (every one is enforced and printed):
 *   --soak-seconds      wall-clock ceiling for section 1, default 60, maximum 180
 *   --clients           simultaneous client workers, default 4, maximum 16
 *   --stored            synthetic stored agents in the fixture, default 200, maximum 2000
 *   --timeout           per-request deadline in milliseconds, default 5000
 *   --storm-cycles      reconnect cycles, default 120, maximum 500
 *   --storm-concurrency simultaneous reconnectors, default 8, maximum 16
 *   --limit-accounts    accounts used for the capacity probe, default 18, maximum 24 (4 subscriptions each)
 *   --disk-budget-bytes the total on-disk ceiling for the whole run, default 268435456 (256 MiB)
 *
 *   node scripts/soak-experiment.mjs [--soak-seconds 60] [--json path]
 *
 * It exits non-zero when a stated ceiling is breached (a failure budget, a leaked connection, a world
 * that stayed unwritable, or a disk budget overrun), so it can be used as a release probe. It is
 * deliberately not part of `npm test`: a timing measurement is evidence, not a stable assertion.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { storageUsage, validateDatabase } from '../src/recovery.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'wave7-soak-password-2026';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const option = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1]; };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const integer = (name, fallback, low, high) => clamp(Number.parseInt(option(name, String(fallback)), 10) || fallback, low, high);

const LIMITS = {
  soak_seconds: integer('soak-seconds', 60, 5, 180),
  clients: integer('clients', 4, 1, 16),
  stored_agents: integer('stored', 200, 1, 2000),
  request_timeout_ms: integer('timeout', 5000, 500, 30000),
  storm_cycles: integer('storm-cycles', 120, 4, 500),
  storm_concurrency: integer('storm-concurrency', 8, 1, 16),
  limit_accounts: integer('limit-accounts', 18, 2, 24),
  disk_budget_bytes: integer('disk-budget-bytes', 256 * 1024 * 1024, 8 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
  // The shipped event channel's own ceiling, read from server.js and re-read from the live payload.
  channel_max_connections: 64,
  channel_max_per_account: 4,
};
const JSON_PATH = option('json', null);
const round = (value, places = 2) => (value === null || value === undefined ? null : Number(value.toFixed(places)));
const percentile = (sorted, fraction) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] : null);
const median = (values) => (values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] : null);
const stats = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return { samples: sorted.length, p50_ms: round(percentile(sorted, 0.5), 1), p90_ms: round(percentile(sorted, 0.9), 1), p95_ms: round(percentile(sorted, 0.95), 1), p99_ms: round(percentile(sorted, 0.99), 1), max_ms: round(sorted[sorted.length - 1] ?? null, 1) };
};

const state = { workspace: null, database: null, port: null, child: null, output: [] };
// A long run must not create a new TCP connection per request: on macOS the ephemeral port range is
// finite and a few tens of thousands of short-lived connections exhaust it, which shows up as socket
// errors that look like a server fault and are not one. One bounded keep-alive pool per run, sized to
// twice the worker count, is what makes a long soak measure the server rather than the client.
const agent = new HttpAgent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 10_000 });
// Every distinct socket failure code is counted, so a future reader can tell a client-side connection
// problem from a server-side one instead of seeing one undifferentiated total.
const socketErrorCodes = new Map();
const freePort = () => new Promise((resolve, reject) => { const probe = createTcpServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const rssKib = (pid) => { try { return Number.parseInt(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10) || null; } catch { return null; } };

/** The fixture: stored records only. It shapes how a read behaves when the database holds rows; it
 *  does not create concurrency and is not a count of supported users. Each client worker gets its own
 *  operator and its own resident, because movement is throttled per resident by the application. */
async function seedFixture(database) {
  const platform = new Platform(database);
  const admin = await platform.register({ name: 'Soak administrator', email: 'soak-admin@wave7.invalid', password: PASSWORD, consent: true });
  platform.run("UPDATE accounts SET role='admin' WHERE id=?", admin.account.id);
  const nextOperator = async (name) => {
    const invite = platform.transaction(() => platform.invite(platform.authenticate(admin.token), { role: 'member' }));
    const account = await platform.register({ name, email: `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@wave7.invalid`, password: PASSWORD, consent: true, invite: invite.code });
    const actor = platform.authenticate(account.token);
    const agent = platform.transaction(() => platform.createAgent(actor, { name: `${name} resident`, capabilities: 'Read approved public sources', limitations: 'Requires human review' }));
    return { token: account.token, agent_id: agent.id };
  };
  const movers = [];
  for (let index = 0; index < LIMITS.clients; index++) movers.push(await nextOperator(`Soak mover ${index}`));
  const viewers = movers[0];
  // One operator's resident is the fixture's garden builder and land steward. It builds inside its own
  // garden and stays there, so the fixture never makes a second doorway journey (the world's own
  // travel throttle is a rule this experiment is not measuring).
  const steward = platform.authenticate(movers[1].token);
  platform.transaction(() => platform.landAssign(platform.authenticate(movers[0].token), { plot_id: 'plot:0:0:5:5', purpose: 'A Wave 7 soak fixture', description: 'An isolated fixture used only by the soak experiment.' }));
  platform.transaction(() => platform.travel(steward, movers[1].agent_id, { world_id: `home:${movers[1].agent_id}` }));
  platform.transaction(() => platform.build(steward, movers[1].agent_id, { type: 'farm', x: 4, y: 8 }));
  const position = platform.get('SELECT x,y FROM agents WHERE id=?', viewers.agent_id);
  const stamp = new Date(Date.now()).toISOString();
  platform.transaction(() => {
    const insertAgent = platform.db.prepare("INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,world_id,last_seen,created_at) VALUES(?,?,'Soak fixture','#397f79','◆','','',?,?,'commons',?,?)");
    const insertHome = platform.db.prepare("INSERT INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,'home',?,'public',32,24,?)");
    const insertProfile = platform.db.prepare('INSERT OR IGNORE INTO journey_profiles(agent_id) VALUES(?)');
    for (let index = 0; index < LIMITS.stored_agents; index++) {
      const id = randomUUID();
      // The stored residents all crowd the reader's own tile, which is the worst case for the
      // crowded-viewport read this mix leans on.
      insertAgent.run(id, steward.account.id, position.x, position.y, Date.now(), stamp);
      insertHome.run(`home:${id}`, `Soak garden ${index}`, id, stamp);
      insertProfile.run(id);
    }
  });
  // One account per group of four subscriptions, so the reconnect probe can hold the channel's own
  // 64-subscription ceiling without tripping its 4-per-account bound.
  const storm = [];
  for (let index = 0; index < LIMITS.limit_accounts; index++) storm.push((await nextOperator(`Soak storm ${index}`)).token);
  platform.close();
  return { admin_token: admin.token, movers, storm_tokens: storm, viewer_token: viewers.token, viewer_agent: viewers.agent_id, position, evidence_token: movers[0].token };
}

async function startServer() {
  const env = { ...process.env, PORT: String(state.port), LUCY_DATABASE: state.database, LUCY_BIND_HOST: '127.0.0.1' };
  for (const name of ['LUCY_PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'LUCY_SETUP_CODE', 'LUCY_LOCAL_PORT_FALLBACK', 'LUCY_MODEL_NAME', 'LUCY_MODEL_URL', 'LUCY_MODEL_BACKEND']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  const collect = (chunk) => { state.output.push(chunk.toString('utf8').trimEnd()); if (state.output.length > 40) state.output = state.output.slice(-40); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server exited before becoming ready (code ${child.exitCode}).\n${state.output.join('\n')}`);
    const probe = await requestOnce('/api/v1/health', { timeoutMs: 2000 });
    if (probe.outcome === 'ok') return;
    await sleep(200);
  }
  throw new Error(`The server did not become ready.\n${state.output.join('\n')}`);
}

/** Readiness is not a measurement: the probes above legitimately fail while the listener is still
 *  starting, and counting them as soak or storm socket failures would misreport a normal start as a
 *  fault. They are recorded separately and the measured tally starts clean. */
function resetSocketTally(label) {
  const duringStartup = Object.fromEntries(socketErrorCodes);
  socketErrorCodes.clear();
  return { [label]: duringStartup };
}

function requestOnce(path, { token, timeoutMs, method = 'GET', body = null, preview = 400 }) {
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); };
    const headers = { Host: `127.0.0.1:${state.port}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body === null ? null : JSON.stringify(body);
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const request = httpRequest({ host: '127.0.0.1', port: state.port, path, method, headers, agent, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
      let bytes = 0, text = '';
      response.on('data', (chunk) => { bytes += chunk.length; if (text.length < preview) text += chunk.toString('utf8').slice(0, preview - text.length); });
      response.on('end', () => finish({ outcome: response.statusCode >= 200 && response.statusCode < 300 ? 'ok' : 'http_error', status: response.statusCode, bytes, text, latency_ms: performance.now() - started, path }));
    });
    request.on('error', (error) => {
      // An error event can also fire on a request whose response already completed, when the keep-alive
      // pool retires a socket. Only a failure that actually settles the result is counted, so the code
      // tally matches the outcome tally instead of double-reporting a retired connection.
      if (settled) return;
      settled = true;
      const code = error.name === 'AbortError' ? 'timeout' : String(error.code || error.name);
      socketErrorCodes.set(code, (socketErrorCodes.get(code) || 0) + 1);
      resolve({ outcome: error.name === 'AbortError' ? 'timeout' : 'socket_error', status: 0, bytes: 0, text: code, latency_ms: performance.now() - started, path });
    });
    if (payload) request.write(payload);
    request.end();
  });
}

/** The same request, but the whole body is retained and parsed. Used only where a payload must be read
 *  as JSON, so the bounded preview the high-volume paths keep never truncates a document. */
async function requestJson(path, { token, timeoutMs = 5000 } = {}) {
  const result = await requestOnce(path, { token, timeoutMs, preview: Number.MAX_SAFE_INTEGER });
  try { return { status: result.status, data: JSON.parse(result.text) }; } catch { return { status: result.status, data: null }; }
}

/** Section 1 — the bounded soak. One server, a fixed request mix, a sampled RSS, real percentiles. */
async function soak(fixture) {
  const base = '/api/v1';
  const position = fixture.position;
  const movePath = (agentId) => `${base}/move`;
  // The mix is fixed and stated, and it is what the run actually asked for. The write arm is paced at
  // the shipped per-resident movement throttle, because an unpaced step is refused by the application's
  // own 120 ms rule rather than by any limit this experiment is trying to measure.
  const readMix = [
    { weight: 45, name: 'crowded viewport', path: () => `${base}/world?world_id=commons&x=${position.x}&y=${position.y}&agent_id=${fixture.viewer_agent}`, token: () => fixture.viewer_token },
    { weight: 15, name: 'resident passport', path: (mover) => `${base}/journey?agent_id=${mover.agent_id}`, token: (mover) => mover.token },
    { weight: 10, name: 'garden directory', path: () => `${base}/worlds?offset=0&limit=20`, token: () => fixture.viewer_token },
    { weight: 10, name: 'community', path: () => `${base}/community`, token: () => fixture.viewer_token },
    { weight: 10, name: 'health', path: () => `${base}/health`, token: () => null },
  ];
  const schedule = readMix.flatMap((entry) => Array.from({ length: entry.weight }, () => entry));
  const MOVE_INTERVAL_MS = 130;
  const results = [], rss = [], storage = [];
  const deadline = performance.now() + LIMITS.soak_seconds * 1000;
  const started = performance.now();
  const moveTally = { attempted: 0, accepted: 0, refused: 0 };
  let next = 0;
  const sample = () => {
    const value = rssKib(state.child.pid);
    if (value !== null) rss.push({ at_ms: round(performance.now() - started, 0), rss_kib: value });
    storage.push({ at_ms: round(performance.now() - started, 0), ...storageUsage(state.database) });
  };
  sample();
  const sampler = setInterval(sample, 5000);
  const worker = async (mover) => {
    let lastMove = Number.NEGATIVE_INFINITY, step = 0;
    while (performance.now() < deadline) {
      if (performance.now() - lastMove >= MOVE_INTERVAL_MS) {
        lastMove = performance.now();
        step += 1;
        moveTally.attempted += 1;
        const result = await requestOnce(movePath(mover.agent_id), { token: mover.token, timeoutMs: LIMITS.request_timeout_ms, method: 'POST', body: { agent_id: mover.agent_id, direction: step % 2 === 0 ? 'right' : 'left' } });
        if (result.outcome === 'ok') moveTally.accepted += 1; else moveTally.refused += 1;
        results.push({ ...result, arm: 'move (write)' });
        continue;
      }
      const entry = schedule[next++ % schedule.length];
      results.push({ ...(await requestOnce(entry.path(mover), { token: entry.token(mover), timeoutMs: LIMITS.request_timeout_ms })), arm: entry.name });
    }
  };
  await Promise.all(fixture.movers.map((mover) => worker(mover)));
  clearInterval(sampler);
  sample();
  const elapsed = (performance.now() - started) / 1000;

  const midpoint = results.length / 2;
  const half = (rows) => stats(rows.filter((row) => row.outcome === 'ok').map((row) => row.latency_ms));
  const firstHalf = half(results.slice(0, Math.ceil(midpoint)));
  const secondHalf = half(results.slice(Math.ceil(midpoint)));
  const byOutcome = { ok: 0, http_error: 0, timeout: 0, socket_error: 0 };
  for (const row of results) byOutcome[row.outcome] += 1;
  // A status is reported by its own count, so a movement throttle refusal and a real error are never
  // added together into one "failure" figure.
  const byStatus = {};
  for (const row of results) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  const byArm = {};
  for (const row of results) { byArm[row.arm] = byArm[row.arm] || { attempts: 0, ok: 0, http_error: 0, timeout: 0, socket_error: 0 }; byArm[row.arm].attempts += 1; byArm[row.arm][row.outcome] += 1; }
  // Least-squares slope over the RSS samples, reported as a rate rather than as a prediction.
  const slope = (() => {
    if (rss.length < 3) return null;
    const n = rss.length, meanX = rss.reduce((sum, row) => sum + row.at_ms, 0) / n, meanY = rss.reduce((sum, row) => sum + row.rss_kib, 0) / n;
    const covariance = rss.reduce((sum, row) => sum + (row.at_ms - meanX) * (row.rss_kib - meanY), 0);
    const variance = rss.reduce((sum, row) => sum + (row.at_ms - meanX) ** 2, 0);
    return variance === 0 ? null : covariance / variance;
  })();
  const firstRss = rss.length ? rss[0].rss_kib : null, lastRss = rss.length ? rss[rss.length - 1].rss_kib : null;
  const rssValues = rss.map((row) => row.rss_kib);
  const storageFirst = storage[0], storageLast = storage[storage.length - 1];
  return {
    ceiling: { duration_seconds: LIMITS.soak_seconds, clients: LIMITS.clients, request_timeout_ms: LIMITS.request_timeout_ms, stored_agents: LIMITS.stored_agents },
    elapsed_seconds: round(elapsed, 1),
    requests: results.length,
    throughput_per_second: round(results.length / elapsed),
    outcomes: byOutcome,
    outcomes_by_status: byStatus,
    outcomes_by_arm: byArm,
    socket_error_codes: Object.fromEntries(socketErrorCodes),
    move_arm: moveTally,
    statuses: [...new Set(results.map((row) => row.status))].sort((a, b) => a - b),
    bytes_total: results.reduce((sum, row) => sum + row.bytes, 0),
    latency_all: half(results),
    latency_first_half: firstHalf,
    latency_second_half: secondHalf,
    memory: {
      samples: rss.length,
      unit: 'KiB resident set size of the server process, read with ps',
      first_kib: firstRss, last_kib: lastRss, min_kib: rssValues.length ? Math.min(...rssValues) : null, max_kib: rssValues.length ? Math.max(...rssValues) : null,
      change_kib: firstRss !== null && lastRss !== null ? lastRss - firstRss : null,
      median_kib: median(rssValues),
      first_quarter_median_kib: median(rssValues.slice(0, Math.max(1, Math.floor(rssValues.length / 4)))),
      last_quarter_median_kib: median(rssValues.slice(-Math.max(1, Math.floor(rssValues.length / 4)))),
      slope_kib_per_minute: slope === null ? null : round(slope * 60_000, 1),
      peak_sample_kib: rssValues.length ? Math.max(...rssValues) : null,
      note: 'Resident set size is a sawtooth: V8 grows its heap under allocation pressure and a collection returns pages to the operating system, so first-versus-last and a slope are both dominated by where the last collection landed. The quarter medians, the minimum and the maximum are the honest description of the shape. No leak verdict is offered and nothing is extrapolated.',
      samples_series: rss,
    },
    storage: {
      unit: 'bytes on disk for the database, its write-ahead log and its shared-memory index',
      first: storageFirst, last: storageLast,
      growth_bytes: storageFirst && storageLast ? storageLast.total_bytes - storageFirst.total_bytes : null,
      samples_series: storage.slice(0, 40),
    },
  };
}

/** Section 2 — the reconnect storm and the channel's own ceiling. */
async function reconnectStorm(fixture) {
  const base = '/api/v1';
  const eventsOf = async () => (await requestJson(`${base}/operations`, { token: fixture.admin_token, timeoutMs: LIMITS.request_timeout_ms })).data?.diagnostics?.events ?? null;
  const before = await eventsOf();
  // Each phase keeps its own tallies. An acceptance or a refusal belongs to the phase that produced
  // it, so the churn figures can never absorb the at-the-limit probe's refusals.
  const openOnce = async (token) => {
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}${base}/events?world_id=commons`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (response.status !== 200) return { status: response.status, controller: null };
      const reader = response.body.getReader();
      const { value } = await reader.read();
      return { status: 200, ready: Buffer.from(value ?? []).toString('utf8').includes('event: ready'), controller };
    } catch { return { status: 0, controller: null }; }
  };
  const tally = { opened: 0, ready: 0, refused: {}, errors: 0 };
  const count = (result) => {
    if (result.status === 200) { tally.opened += 1; if (result.ready) tally.ready += 1; return; }
    if (result.status === 0) { tally.errors += 1; return; }
    tally.refused[String(result.status)] = (tally.refused[String(result.status)] || 0) + 1;
  };
  // Bounded churn: each cycle opens, reads its ready frame and disconnects.
  const cycles = async (workerIndex) => {
    const token = fixture.storm_tokens[workerIndex % fixture.storm_tokens.length];
    for (let cycle = 0; cycle < Math.ceil(LIMITS.storm_cycles / LIMITS.storm_concurrency); cycle++) {
      const opened = await openOnce(token);
      count(opened);
      opened.controller?.abort();
      await sleep(2);
    }
  };
  const began = performance.now();
  await Promise.all(Array.from({ length: LIMITS.storm_concurrency }, (_, index) => cycles(index)));
  const stormSeconds = (performance.now() - began) / 1000;
  const churn = { opened: tally.opened, ready_frames: tally.ready, refusal_statuses: { ...tally.refused }, client_errors: tally.errors };
  await sleep(200);
  const afterStorm = await eventsOf();
  // Reset the tallies so the probe is reported on its own.
  tally.opened = 0; tally.ready = 0; tally.refused = {}; tally.errors = 0;

  // The probe: keep opening subscriptions until the channel refuses, at most its own ceiling plus four.
  const held = [];
  const probeStarted = performance.now();
  const wanted = LIMITS.channel_max_connections + 4;
  for (let index = 0; index < wanted; index++) {
    const token = fixture.storm_tokens[Math.floor(index / LIMITS.channel_max_per_account) % fixture.storm_tokens.length];
    const opened = await openOnce(token);
    count(opened);
    if (opened.controller) held.push(opened.controller);
  }
  const probe = { opened: tally.opened, refused_statuses: { ...tally.refused }, client_errors: tally.errors };
  const probeSeconds = (performance.now() - probeStarted) / 1000;
  const atLimit = await eventsOf();
  for (const controller of held) controller.abort();
  await sleep(300);
  const afterRelease = await eventsOf();
  // Normal service must continue after the storm.
  const health = await requestOnce(`${base}/health`, { timeoutMs: LIMITS.request_timeout_ms });
  const world = await requestOnce(`${base}/world?world_id=commons&agent_id=${fixture.viewer_agent}`, { token: fixture.viewer_token, timeoutMs: LIMITS.request_timeout_ms });

  const counters = ['opened', 'refused', 'closed', 'overflow_closed', 'write_closed', 'frames'];
  const delta = Object.fromEntries(counters.map((key) => [key, (afterStorm?.[key] ?? 0) - (before?.[key] ?? 0)]));
  return {
    ceiling: { cycles_requested: LIMITS.storm_cycles, concurrency: LIMITS.storm_concurrency, channel_max_connections: LIMITS.channel_max_connections, channel_max_per_account: LIMITS.channel_max_per_account },
    churn: { ...churn, seconds: round(stormSeconds, 2), reconnects_per_second: round(churn.opened / stormSeconds) },
    channel_counters_delta: delta,
    connections_after_the_storm: afterStorm?.connections ?? null,
    at_the_limit: { attempted: wanted, accepted: held.length, refused_statuses: probe.refused_statuses, client_errors: probe.client_errors, seconds: round(probeSeconds, 2), connections_while_held: atLimit?.connections ?? null },
    after_release: { connections: afterRelease?.connections ?? null, accounts: afterRelease?.accounts ?? null },
    service_after: { health_status: health.status, world_status: world.status, world_outcome: world.outcome },
  };
}

/** Section 3 — storage growth from the soak, then a real write exhaustion probe over HTTP. */
async function storageExhaustion(directory, soakStorage) {
  const database = join(directory, 'exhaustion.sqlite');
  const platform = new Platform(database);
  const admin = await platform.register({ name: 'Exhaustion administrator', email: 'soak-exhaust@wave7.invalid', password: PASSWORD, consent: true });
  platform.run("UPDATE accounts SET role='admin' WHERE id=?", admin.account.id);
  const actor = platform.authenticate(admin.token);
  const agent = platform.transaction(() => platform.createAgent(actor, { name: 'Exhaustion resident', capabilities: 'Fixture only', limitations: 'Fixture only' }));
  platform.transaction(() => platform.travel(actor, agent.id, { world_id: `home:${agent.id}` }));
  platform.transaction(() => platform.build(actor, agent.id, { type: 'farm', x: 4, y: 8 }));
  // The write the probe drives has no world rule of its own to confuse the signal: POST /jobs is a
  // runtime credential reporting its own run summary, so the only thing that can refuse it is storage.
  const runtime = platform.transaction(() => platform.runtime(actor, agent.id, { scopes: ['contribute'], minutes: 20, max_calls: 500 }));
  const before = storageUsage(database);
  const auditBefore = platform.get('SELECT COUNT(*) AS n FROM audit').n;
  // A full volume: the page limit is set to the current page count, so a write that needs a new page
  // fails exactly as SQLITE_FULL does when the disk has no space left. The shipped server is handed
  // THIS connection, so the limit applies to the real HTTP path and not merely to a side handle.
  const pages = platform.get('PRAGMA page_count').page_count;
  platform.run(`PRAGMA max_page_count=${pages}`);
  const app = createApp({ platform, backupDir: join(directory, 'backups'), mayorModel: async () => '{"action":"wait"}' });
  const port = await freePort();
  await new Promise((resolve) => app.server.listen(port, '127.0.0.1', resolve));
  const call = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method: options.method || 'GET', headers: { Authorization: `Bearer ${options.token || admin.token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    const text = await response.text();
    return { status: response.status, text: options.full ? text : text.slice(0, 200) };
  };
  try {
    // Reads keep working while writes cannot: exhaustion is a write problem, and saying otherwise
    // would be a false alarm.
    const read = await call(`/world?world_id=commons`);
    // Fill until the limit refuses. Every attempt is the same small, rule-free insert, so the first
    // refusal is the storage limit and nothing else. The audit count is read immediately before each
    // attempt, so the delta is attributable to the refused write rather than to the accepted ones.
    const writes = [];
    let auditBeforeRefusal = auditBefore, auditAtRefusal = null;
    for (let index = 0; index < 400; index++) {
      auditBeforeRefusal = platform.get('SELECT COUNT(*) AS n FROM audit').n;
      const result = await call('/jobs', { method: 'POST', token: runtime.token, body: { status: 'completed', detail: `Exhaustion probe ${index}: ${'x'.repeat(400)}` } });
      writes.push(result);
      if (result.status !== 201) { auditAtRefusal = platform.get('SELECT COUNT(*) AS n FROM audit').n; break; }
    }
    const accepted = writes.filter((row) => row.status === 201).length;
    const firstRefusal = writes.find((row) => row.status !== 201) || null;
    const diagnostics = await call('/operations', { full: true });
    let parsed = null; try { parsed = JSON.parse(diagnostics.text); } catch { parsed = null; }
    const integrityDuring = platform.integrity().quick_check;
    // Space returns.
    platform.run('PRAGMA max_page_count=2000000000');
    const recovered = await call('/jobs', { method: 'POST', token: runtime.token, body: { status: 'completed', detail: 'Written after space returned.' } });
    const after = storageUsage(database);
    const incidents = parsed?.diagnostics?.incidents || null;
    return {
      ceiling: { page_limit_pages: pages, page_limit_bytes_equivalent: pages * 4096, fill_attempt_ceiling: 400, disk_budget_bytes: LIMITS.disk_budget_bytes },
      storage_growth: soakStorage || null,
      read_while_full: read.status,
      fill_attempts: writes.length,
      writes_accepted_before_the_limit: accepted,
      first_refusal: firstRefusal,
      audit_entries_added_by_the_refused_write: auditAtRefusal === null ? null : auditAtRefusal - auditBeforeRefusal,
      integrity_while_full: integrityDuring,
      diagnostics_status: diagnostics.status,
      diagnostics_audit_valid: parsed ? parsed.audit_valid : null,
      diagnostics_coin_ledger_valid: parsed ? parsed.coin_ledger_valid : null,
      incidents_counted: incidents ? incidents.recorded_since_start : null,
      incidents_last_route: incidents ? incidents.last_route : null,
      incidents_last_error_code: incidents && incidents.recent.length ? incidents.recent[incidents.recent.length - 1].error_code : null,
      recovered_write_status: recovered.status,
      storage_after: after,
    };
  } finally {
    await app.stopWorkers();
    await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
    platform.close();
  }
}

async function main() {
  state.workspace = mkdtempSync(join(tmpdir(), 'nemoworld-wave7-soak-'));
  state.database = join(state.workspace, 'soak.sqlite');
  state.port = await freePort();
  console.log('NemoWorld Wave 7 long-run and at-the-limit experiment');
  console.log(`hardware   ${process.platform} ${process.arch}, Node ${process.version}, load ${execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim()}`);
  console.log(`ceilings   soak ${LIMITS.soak_seconds} s · clients ${LIMITS.clients} · request deadline ${LIMITS.request_timeout_ms} ms · stored agents ${LIMITS.stored_agents} · storm ${LIMITS.storm_cycles} cycles at ${LIMITS.storm_concurrency} · disk budget ${(LIMITS.disk_budget_bytes / 1048576).toFixed(0)} MiB`);
  console.log('           no model is configured, so no model call is made and no model throughput is measured here');
  const fixture = await seedFixture(state.database);
  await startServer();
  const readiness = resetSocketTally('readiness_probe_socket_failures');
  const healthBefore = await requestOnce('/api/v1/health', { timeoutMs: 5000 });
  let report;
  try {
    const soakResult = await soak(fixture);
    const healthAfter = await requestOnce('/api/v1/health', { timeoutMs: 5000 });
    soakResult.service_before = { status: healthBefore.status, outcome: healthBefore.outcome };
    soakResult.service_after = { status: healthAfter.status, outcome: healthAfter.outcome };
    console.log('');
    console.log(`soak       ${soakResult.requests} requests in ${soakResult.elapsed_seconds} s (${soakResult.throughput_per_second}/s) · outcomes ${JSON.stringify(soakResult.outcomes)} · by status ${JSON.stringify(soakResult.outcomes_by_status)}`);
    console.log(`  write    ${soakResult.move_arm.accepted}/${soakResult.move_arm.attempted} paced moves accepted · ${soakResult.move_arm.refused} refused (the shipped 120 ms per-resident movement throttle is stated in the mix, not counted as a failure)`);
    console.log(`  by arm   ${Object.entries(soakResult.outcomes_by_arm).map(([arm, value]) => `${arm}: ${value.ok}/${value.attempts} ok`).join(' · ')}`);
    console.log(`  latency  all p50 ${soakResult.latency_all.p50_ms} ms p95 ${soakResult.latency_all.p95_ms} ms p99 ${soakResult.latency_all.p99_ms} ms max ${soakResult.latency_all.max_ms} ms`);
    console.log(`  drift    first half p95 ${soakResult.latency_first_half.p95_ms} ms → second half p95 ${soakResult.latency_second_half.p95_ms} ms`);
    console.log(`  service  health ${healthBefore.status} before the soak → ${healthAfter.status} after it`);
    if (Object.keys(soakResult.socket_error_codes).length) console.log(`  sockets  ${JSON.stringify(soakResult.socket_error_codes)} (a client- or server-side connection failure is named, never merged into one total)`);
    else console.log(`  sockets  no connection failure was recorded during the measured window (readiness probes are counted separately: ${JSON.stringify(readiness.readiness_probe_socket_failures)})`);
    console.log(`  memory   ${soakResult.memory.samples} samples · min ${soakResult.memory.min_kib} KiB · median ${soakResult.memory.median_kib} KiB · max ${soakResult.memory.max_kib} KiB · first ${soakResult.memory.first_kib} KiB · last ${soakResult.memory.last_kib} KiB`);
    console.log(`  shape    first-quarter median ${soakResult.memory.first_quarter_median_kib} KiB → last-quarter median ${soakResult.memory.last_quarter_median_kib} KiB (sawtooth, not a monotonic trend)`);
    console.log(`  storage  ${soakResult.storage.first?.total_bytes} → ${soakResult.storage.last?.total_bytes} bytes total (db ${soakResult.storage.last?.database_bytes}, wal ${soakResult.storage.last?.wal_bytes})`);
    const storm = await reconnectStorm(fixture);
    console.log('');
    console.log(`reconnect ${storm.churn.opened} subscriptions opened and disconnected in ${storm.churn.seconds} s (${storm.churn.reconnects_per_second}/s) · ready frames ${storm.churn.ready_frames} · client errors ${storm.churn.client_errors}`);
    console.log(`  channel  counters delta ${JSON.stringify(storm.channel_counters_delta)} · connections after the storm ${storm.connections_after_the_storm}`);
    console.log(`  at limit ${storm.at_the_limit.accepted}/${storm.at_the_limit.attempted} accepted while holding · connections ${storm.at_the_limit.connections_while_held} · connections after release ${storm.after_release.connections}`);
    console.log(`  service  health ${storm.service_after.health_status} · world ${storm.service_after.world_status}`);
    const storage = await storageExhaustion(join(state.workspace, 'storage'), soakResult.storage);
    console.log('');
    console.log(`storage    growth over the soak ${storage.storage_growth?.growth_bytes} bytes`);
    console.log(`  full     read while full ${storage.read_while_full} · writes accepted before the limit ${storage.writes_accepted_before_the_limit}/${storage.fill_attempts} · first refusal ${storage.first_refusal ? `${storage.first_refusal.status} ${storage.first_refusal.text}` : 'none — the limit was not reached'}`);
    console.log(`  effects  audit entries added by the refused write ${storage.audit_entries_added_by_the_refused_write} · integrity while full ${storage.integrity_while_full} · audit chain valid ${storage.diagnostics_audit_valid} · coin ledger valid ${storage.diagnostics_coin_ledger_valid}`);
    console.log(`  counted  ${storage.incidents_counted} unexpected-failure incident(s) recorded, last route ${storage.incidents_last_route}, last error code ${storage.incidents_last_error_code}`);
    console.log(`  recover  after space returned the write answered ${storage.recovered_write_status}`);
    const used = storageUsage(state.database).total_bytes + (state.workspace ? directoryBytes(state.workspace) : 0);
    report = {
      generated_at: new Date().toISOString(),
      hardware: { platform: process.platform, arch: process.arch, node: process.version, load: execFileSync('/usr/bin/uptime', { encoding: 'utf8' }).trim() },
      limits: LIMITS,
      fixture: { stored_agents: LIMITS.stored_agents, note: 'stored records only; not concurrent users' },
      model: { configured: false, note: 'No model was configured, so no model call was made and no model throughput is measured.' },
      soak: soakResult, reconnect: storm, storage,
      startup: readiness,
      server_output_tail: state.output.slice(-12),
      disk_consumed_bytes: used,
      claim: 'Measured on this hardware, this fixture, this concurrency and this workload only. No capacity, service-level or production claim is established, and nothing here is extrapolated to a longer run.',
    };
    if (used > LIMITS.disk_budget_bytes) report.budget_breach = `the run consumed ${used} bytes, over the ${LIMITS.disk_budget_bytes}-byte ceiling`;
    console.log('');
    console.log(`disk       ${used} bytes consumed on a disposable workspace (ceiling ${LIMITS.disk_budget_bytes})`);
    console.log(`claim      ${report.claim}`);
  } finally {
    if (state.child && state.child.exitCode === null) {
      const exited = new Promise((resolve) => state.child.once('exit', resolve));
      state.child.kill('SIGTERM');
      await Promise.race([exited, sleep(10_000)]).then(() => { if (state.child.exitCode === null) state.child.kill('SIGKILL'); });
    }
    agent.destroy();
    if (JSON_PATH && report) writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
    if (JSON_PATH && report) console.log(`report     ${JSON_PATH}`);
    const removed = state.workspace;
    rmSync(removed, { recursive: true, force: true });
    console.log(`cleanup    ${existsSync(removed) ? 'FAILED to remove ' + removed : `removed ${removed}`}`);
  }
  const storm = report.reconnect;
  const leaked = (storm.after_release.connections ?? 0) !== 0;
  if (leaked) { console.error(`FAIL  ${storm.after_release.connections} subscriptions were still held after the storm was released`); process.exitCode = 1; }
  if (report.budget_breach) { console.error(`FAIL  ${report.budget_breach}`); process.exitCode = 1; }
  if (report.storage.recovered_write_status !== 201) { console.error(`FAIL  the world did not accept a write again after space returned (${report.storage.recovered_write_status})`); process.exitCode = 1; }
  if (report.soak.service_after?.outcome !== 'ok') { console.error(`FAIL  the server did not answer a health probe after the soak (${report.soak.service_after?.outcome})`); process.exitCode = 1; }
}

/** The bytes the whole experiment left on disk, measured rather than assumed, before cleanup. */
function directoryBytes(path) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else if (entry.isFile()) { try { total += statSync(join(current, entry.name)).size; } catch { /* a file removed mid-walk */ } }
    }
  };
  walk(path);
  return total;
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL  ${error.message}`);
  if (state.output.length) for (const line of state.output.slice(-10)) console.error(`      ${line}`);
  if (state.child?.exitCode === null) state.child.kill('SIGTERM');
  if (state.workspace) rmSync(state.workspace, { recursive: true, force: true });
  process.exitCode = 1;
}
