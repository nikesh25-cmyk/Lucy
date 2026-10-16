#!/usr/bin/env node
/**
 * NemoWorld concurrent-client harness.
 *
 * It starts the shipped server (`server.js`) as a real child process against a **temporary** SQLite
 * database, seeds that database with a stored-record fixture, and then drives the server's own HTTP
 * API with a bounded number of simultaneous clients. Nothing is mocked, no request is replayed from
 * a fixture, and the shipped data directory is never touched.
 *
 * What it measures — and keeps separate, because they are different questions:
 *   1. payload bytes       actual bytes of response bodies received on the wire
 *   2. latency             per-request wall-clock, reported as nearest-rank percentiles
 *   3. failures            non-2xx responses, and timeouts, counted apart from each other
 *   4. model queue         read from the server's own /health payload, never conflated with HTTP
 *
 * Explicit resource limits (every one of them is enforced, and printed in the report):
 *   --clients         simultaneous client workers; this is the concurrency ceiling
 *   --requests        request attempts per concurrency level
 *   --timeout         per-request deadline in milliseconds
 *   --duration        wall-clock ceiling for the whole run
 *   --failure-budget  largest tolerated (failures + timeouts) / attempts, default 0
 *
 * What it does NOT measure: model throughput, model queue behaviour, real network latency, multiple
 * server processes, or multiple SQLite writers. No local model is configured here, so the server
 * reports `model_configured: false` and `model_queue: null` and no model call is ever made. A stored
 * record count is NOT a count of supported simultaneous users; this harness measures this workload,
 * at this concurrency, on this machine.
 *
 *   node scripts/load-harness.mjs [--clients 1,8] [--requests 200] [--stored 10000] [--json path]
 *
 * It exits non-zero when the failure budget is exceeded, so it can be used as a release probe. It is
 * deliberately not part of `npm test`: a timing measurement is evidence, not a stable assertion.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Platform } from '../src/platform.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'load-harness-password-2026';
const PROBE_PASSWORD = 'load-probe-password-2026';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const clientsList = String(option('clients', '1,8')).split(',').map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value) && value > 0);
const LIMITS = {
  clients: clientsList.length ? clientsList : [1],
  requests_per_level: Number.parseInt(option('requests', '200'), 10),
  stored_records: Number.parseInt(option('stored', '10000'), 10),
  request_timeout_ms: Number.parseInt(option('timeout', '5000'), 10),
  run_timeout_ms: Number.parseInt(option('duration', '120000'), 10),
  failure_budget: Number(option('failure-budget', '0')),
  server_ready_timeout_ms: 180_000,
};
const JSON_PATH = option('json', null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = { workspace: null, database: null, port: null, child: null, serverOutput: [] };

function httpRequestOnce(path, { token, timeoutMs }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const headers = { Host: `127.0.0.1:${state.port}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = httpRequest({ host: '127.0.0.1', port: state.port, path, method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('end', () => resolve({ outcome: response.statusCode >= 200 && response.statusCode < 300 ? 'ok' : 'http_error', status: response.statusCode, bytes, latency_ms: performance.now() - started, path }));
    });
    request.on('error', (error) => resolve({ outcome: error.name === 'AbortError' || error.code === 'UND_ERR_ABORTED' ? 'timeout' : 'socket_error', status: 0, bytes: 0, latency_ms: performance.now() - started, path, detail: error.code || error.name }));
    request.end();
  });
}

/**
 * Bounded pool: at most `clients` requests are ever in flight, every request carries its own deadline,
 * and the whole level stops at the run deadline. A worker that has already been given a request
 * finishes it, so the in-flight bound is never exceeded.
 */
async function runLevel({ clients, requests, timeoutMs, deadline, scenarios }) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      if (performance.now() >= deadline) return;
      const index = next++;
      if (index >= requests) return;
      const scenario = scenarios[index % scenarios.length];
      results.push(await httpRequestOnce(scenario.path, { token: scenario.token, timeoutMs }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(clients, requests) }, worker));
  return results;
}

/** Nearest-rank percentile on a sorted sample: p95 of n values is the ceil(0.95n)-th smallest. */
function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
const round = (value, places = 2) => (value === null || value === undefined ? null : Number(value.toFixed(places)));
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

function summarise(results) {
  const byPath = new Map();
  for (const result of results) {
    if (!byPath.has(result.path)) byPath.set(result.path, []);
    byPath.get(result.path).push(result);
  }
  const withStats = (rows, key) => {
    const succeeded = rows.filter((row) => row.outcome === 'ok');
    const latencies = succeeded.map((row) => row.latency_ms).sort((a, b) => a - b);
    const bytes = rows.map((row) => row.bytes);
    return {
      key,
      attempts: rows.length,
      ok: succeeded.length,
      http_errors: rows.filter((row) => row.outcome === 'http_error').length,
      timeouts: rows.filter((row) => row.outcome === 'timeout').length,
      socket_errors: rows.filter((row) => row.outcome === 'socket_error').length,
      statuses: [...new Set(rows.map((row) => row.status))].sort(),
      bytes_total: bytes.reduce((sum, value) => sum + value, 0),
      bytes_median: bytes.length ? bytes.slice().sort((a, b) => a - b)[Math.floor(bytes.length / 2)] : 0,
      bytes_max: bytes.length ? Math.max(...bytes) : 0,
      latency_p50_ms: round(percentile(latencies, 0.5)),
      latency_p90_ms: round(percentile(latencies, 0.9)),
      latency_p95_ms: round(percentile(latencies, 0.95)),
      latency_p99_ms: round(percentile(latencies, 0.99)),
      latency_max_ms: round(latencies[latencies.length - 1] ?? null),
      latency_samples: latencies.length,
    };
  };
  const perPath = [...byPath.entries()].map(([path, rows]) => withStats(rows, path)).sort((a, b) => b.attempts - a.attempts);
  return { overall: withStats(results, 'all requests'), per_path: perPath };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/**
 * The stored-record fixture used by every level. It mirrors the world/platform fixture: synthetic
 * agents stacked in the Commons (the worst case for the viewport bound), one home each, plus one
 * resident with a long visit history and one operator with a long claim history. This builds stored
 * data; it does not create concurrency.
 */
async function seedFixture(database) {
  const platform = new Platform(database, () => Date.parse('2026-10-13T09:00:00.000Z'));
  const credentials = {};
  try {
    const admin = await platform.register({ name: 'Harness admin', email: 'admin@harness.test', password: PASSWORD, consent: true });
    const actor = (name) => platform.authenticate(credentials[name].token);
    const invite = platform.transaction(() => platform.invite(platform.authenticate(admin.token), { role: 'member' }));
    credentials.alice = await platform.register({ name: 'Harness member', email: 'alice@harness.test', password: PASSWORD, consent: true, invite: invite.code });
    const alice = platform.transaction(() => platform.createAgent(actor('alice'), { name: 'Harness resident', color: '#397f79', symbol: '✦' }));
    const operatorId = actor('alice').account.id;
    const position = platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
    const stamp = new Date(platform.clock()).toISOString();
    platform.transaction(() => {
      const insertAgent = platform.db.prepare("INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,world_id,last_seen,created_at) VALUES(?,?,?,'#397f79','✦','','',?,?,'commons',?,?)");
      const insertHome = platform.db.prepare("INSERT INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,'home',?,'public',32,24,?)");
      const insertProfile = platform.db.prepare('INSERT OR IGNORE INTO journey_profiles(agent_id) VALUES(?)');
      const insertVisit = platform.db.prepare('INSERT OR IGNORE INTO journey_visits(agent_id,world_id,visited_at) VALUES(?,?,?)');
      const ids = [];
      for (let index = 0; index < LIMITS.stored_records; index++) {
        const id = randomUUID();
        insertAgent.run(id, operatorId, `Load fixture ${index}`, position.x, position.y, platform.clock(), stamp);
        insertHome.run(`home:${id}`, `Load garden ${index}`, id, stamp);
        insertProfile.run(id);
        ids.push(id);
      }
      for (let index = 0; index < 2000; index++) {
        const worldId = `home:visited-${index}`;
        insertHome.run(worldId, `Visited garden ${index}`, ids[index % ids.length], stamp);
        insertVisit.run(alice.id, worldId, platform.clock() + index);
      }
      const task = platform.get("SELECT id FROM tasks WHERE mission_id='climate'");
      const insertClaim = platform.db.prepare("INSERT INTO claims VALUES(?,?,1,?,NULL,'released',?,?,?)");
      for (let index = 0; index < 2000; index++) insertClaim.run(randomUUID(), task.id, operatorId, platform.clock(), `harness-claim-${index}`, new Date(platform.clock() - index * 1000).toISOString());
    });
    return { token: credentials.alice.token, agent_id: alice.id, position };
  } finally {
    platform.close();
  }
}

async function startServer() {
  const env = { ...process.env, PORT: String(state.port), LUCY_DATABASE: state.database, LUCY_BIND_HOST: '127.0.0.1' };
  for (const name of ['LUCY_PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'LUCY_SETUP_CODE', 'LUCY_LOCAL_PORT_FALLBACK', 'LUCY_MODEL_NAME', 'LUCY_MODEL_URL']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  const collect = (chunk) => { state.serverOutput.push(chunk.toString('utf8').trimEnd()); if (state.serverOutput.length > 40) state.serverOutput = state.serverOutput.slice(-40); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const deadline = performance.now() + LIMITS.server_ready_timeout_ms;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server exited before becoming ready (code ${child.exitCode}).\n${state.serverOutput.join('\n')}`);
    const probe = await httpRequestOnce('/api/v1/health', { timeoutMs: 2000 });
    if (probe.outcome === 'ok') return;
    await sleep(250);
  }
  throw new Error(`The server did not become ready within ${LIMITS.server_ready_timeout_ms} ms.\n${state.serverOutput.join('\n')}`);
}

async function stopServer() {
  const child = state.child;
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
    child.kill('SIGTERM');
    if (!(await Promise.race([exited, sleep(10_000).then(() => false)]))) { child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]); }
  }
  state.child = null;
  const kept = process.env.LUCY_LOAD_KEEP === '1';
  if (!kept) await rm(state.workspace, { recursive: true, force: true });
  return { workspace_removed: !existsSync(state.workspace) };
}

/** Reads the model-queue limits from the server's own health payload, so they are reported, not guessed. */
async function health() {
  const response = await new Promise((resolve) => {
    const request = httpRequest({ host: '127.0.0.1', port: state.port, path: '/api/v1/health', method: 'GET', headers: { Host: `127.0.0.1:${state.port}` }, signal: AbortSignal.timeout(5000) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    });
    request.on('error', () => resolve(null));
    request.end();
  });
  return response;
}

async function main() {
  state.workspace = await mkdtemp(join(tmpdir(), 'nemoworld-load-'));
  state.database = join(state.workspace, 'load.sqlite');
  state.port = await freePort();
  console.log('NemoWorld concurrent-client harness');
  console.log(`hardware      ${process.platform} ${process.arch}, ${(await import('node:os')).cpus().length} logical CPUs, Node ${process.version}`);
  console.log(`limits        concurrency ${LIMITS.clients.join(', ')} · ${LIMITS.requests_per_level} requests per level · request deadline ${LIMITS.request_timeout_ms} ms · run deadline ${LIMITS.run_timeout_ms} ms · failure budget ${(LIMITS.failure_budget * 100).toFixed(2)}%`);
  console.log(`fixture       ${LIMITS.stored_records} synthetic agents in the Commons with one home each, 2,000 visits, 2,000 claims (stored records, not users)`);
  const seeded = await seedFixture(state.database);
  await startServer();
  const serverHealth = await health();
  console.log(`model queue   model_configured=${serverHealth?.model_configured} model_queue=${JSON.stringify(serverHealth?.model_queue)} research_workers=${JSON.stringify(serverHealth?.research_workers)} resident_workers=${JSON.stringify(serverHealth?.resident_workers)}`);
  console.log('              no local model is configured for this harness, so no model call is made and the model queue is not exercised');

  const scenarios = [
    { name: 'crowded viewport', path: `/api/v1/world?world_id=commons&x=${seeded.position.x}&y=${seeded.position.y}&agent_id=${seeded.agent_id}`, token: seeded.token },
    { name: 'garden directory', path: '/api/v1/worlds?offset=0&limit=20', token: seeded.token },
    { name: 'resident passport', path: `/api/v1/journey?agent_id=${seeded.agent_id}`, token: seeded.token },
    { name: 'contribution history', path: '/api/v1/history', token: seeded.token },
    { name: 'health', path: '/api/v1/health', token: null },
  ];
  const deadline = performance.now() + LIMITS.run_timeout_ms;
  const levels = [];
  for (const clients of LIMITS.clients) {
    if (performance.now() >= deadline) { console.log(`\nSKIP  concurrency ${clients}: the run deadline was reached.`); break; }
    const started = performance.now();
    const results = await runLevel({ clients, requests: LIMITS.requests_per_level, timeoutMs: LIMITS.request_timeout_ms, deadline, scenarios });
    const elapsed = performance.now() - started;
    const stats = summarise(results);
    const failures = stats.overall.http_errors + stats.overall.timeouts + stats.overall.socket_errors;
    const rate = results.length ? failures / results.length : 0;
    const level = {
      clients,
      elapsed_ms: round(elapsed),
      throughput_per_second: round(results.length / (elapsed / 1000)),
      limits: { ...LIMITS, deadline_reached: performance.now() >= deadline },
      ...stats,
      failures,
      failure_rate: round(rate, 6),
      within_budget: rate <= LIMITS.failure_budget,
    };
    levels.push(level);
    console.log('');
    console.log(`concurrency ${clients} · ${results.length} attempts in ${(elapsed / 1000).toFixed(2)} s · ${level.throughput_per_second} requests/s`);
    console.log(`  outcomes     ok ${stats.overall.ok} · http errors ${stats.overall.http_errors} · timeouts ${stats.overall.timeouts} · socket errors ${stats.overall.socket_errors} (statuses ${stats.overall.statuses.join(',')})`);
    console.log(`  latency      p50 ${stats.overall.latency_p50_ms} ms · p90 ${stats.overall.latency_p90_ms} ms · p95 ${stats.overall.latency_p95_ms} ms · p99 ${stats.overall.latency_p99_ms} ms · max ${stats.overall.latency_max_ms} ms (nearest-rank over ${stats.overall.latency_samples} successful responses)`);
    console.log(`  payload      ${kb(stats.overall.bytes_total)} total · median ${stats.overall.bytes_median} B · largest ${kb(stats.overall.bytes_max)} per response`);
    for (const path of stats.per_path) {
      console.log(`    ${String(path.key).replace(`/api/v1/`, '').slice(0, 46).padEnd(48)}n=${String(path.attempts).padStart(4)} p50 ${String(path.latency_p50_ms).padStart(7)} ms p95 ${String(path.latency_p95_ms).padStart(7)} ms median ${String(path.bytes_median).padStart(7)} B`);
    }
    console.log(`  verdict      failure rate ${(rate * 100).toFixed(3)}% is ${rate <= LIMITS.failure_budget ? 'within' : 'ABOVE'} the ${(LIMITS.failure_budget * 100).toFixed(2)}% budget`);
  }

  const exceeded = levels.filter((level) => !level.within_budget);
  const report = {
    generated_at: new Date().toISOString(),
    hardware: { platform: process.platform, arch: process.arch, cpus: (await import('node:os')).cpus().length, node: process.version },
    workload: 'one HTTP process, one SQLite writer, loopback, GET reads only',
    limits: LIMITS,
    fixture: { stored_agents: LIMITS.stored_records + 1, stored_homes: LIMITS.stored_records + 1, stored_visits: 2000, stored_claims: 2000, scenario: 'synthetic agents stacked in the Commons' },
    model: { model_configured: serverHealth?.model_configured ?? null, model_queue: serverHealth?.model_queue ?? null, research_workers: serverHealth?.research_workers ?? null, resident_workers: serverHealth?.resident_workers ?? null, note: 'No model was configured, so no model call was made and no model queue was measured.' },
    levels,
    ceiling: exceeded.length ? `the failure budget was first exceeded at concurrency ${exceeded[0].clients}` : `no failure-budget breach up to concurrency ${Math.max(...LIMITS.clients)}`,
    claim: 'Under this hardware, this concurrency and this workload only. No production capacity is established, and no stored record count is a count of supported simultaneous users.',
  };
  await stopServer();
  console.log('');
  console.log(`SUMMARY  ${maxClients(levels)}`);
  console.log(`  ceiling    ${report.ceiling}`);
  console.log(`  claim      ${report.claim}`);
  if (JSON_PATH) { await writeFile(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`); console.log(`  wrote      ${JSON_PATH}`); }
  if (exceeded.length) process.exitCode = 1;
}

const maxClients = (levels) => levels.length
  ? `${levels.length} concurrency level(s) measured; every level ran its full request count: ${levels.every((level) => level.overall.attempts === LIMITS.requests_per_level)}`
  : 'no level completed';

process.on('SIGINT', () => { state.child?.kill('SIGTERM'); if (state.workspace) rm(state.workspace, { recursive: true, force: true }); process.exitCode = 130; });

try {
  await main();
} catch (error) {
  console.error(`\nFAIL  ${error.message}`);
  if (state.serverOutput.length) for (const line of state.serverOutput.slice(-10)) console.error(`      ${line}`);
  if (state.child?.exitCode === null) state.child.kill('SIGTERM');
  if (state.workspace && process.env.LUCY_LOAD_KEEP !== '1') await rm(state.workspace, { recursive: true, force: true });
  process.exitCode = 1;
}
