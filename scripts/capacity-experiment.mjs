#!/usr/bin/env node
/**
 * NemoWorld capacity experiment (Task 28).
 *
 * It answers these separate questions and never conflates them:
 *
 *   1. HTTP capacity      — what this single Node process with one SQLite writer actually completes,
 *                           at bounded client concurrency, under the shipped read workload. Measured
 *                           by *invoking* `scripts/load-harness.mjs` (unmodified) and reading its own
 *                           JSON report: attempts, outcomes, throughput, nearest-rank latency
 *                           percentiles and payload bytes.
 *   2. Model-queue capacity — what the bounded local-model queue does when more work arrives than one
 *                           inference at a time can serve. Measured in-process against the shipped
 *                           `boundedModel` with a stub inference of a stated latency, plus a
 *                           corroborating run of the shipped server's own model-queue drill.
 *   3. Write capacity and event subscribers — the shipped server on its own temporary database,
 *                           driven over real HTTP with the two writes a resident client actually
 *                           sends (a confirmed step, `POST /move`, and a saved garden object,
 *                           `POST /agents/:id/build`), at bounded client concurrency. While those
 *                           writes flow, authenticated clients hold `GET /events` Server-Sent Events
 *                           subscriptions to the Commons and every received frame is timed against the
 *                           server's own send clock. Writes are writes and reads are reads: the write
 *                           percentiles here are separate from the read percentiles above.
 *
 * Browser clients are measured by *invoking* `scripts/browser-suite.mjs` (unmodified): real Chrome,
 * real interface, real records, on each suite's own isolated temporary database. Bounded concurrency
 * means at most N suites run at once, and each suite drives at most two concurrent browser pages. The
 * default scenario subset is chosen to be order-independent (it excludes the two walk-dependent
 * scenarios that are known to fail in a long sequential run on this base — see
 * docs/PRODUCTION_READINESS.md §7); `--browser-scenarios` and `--full-browser` change it, and any
 * suite failure is reported, never hidden.
 *
 * What this experiment does NOT do, and the numbers must not be read as covering:
 *   * it is not a production capacity guarantee, a service-level objective, or a supported-user
 *     count. It measures this hardware, this fixture, this concurrency and this workload;
 *   * it configures no real model and makes no model inference call. The model figures are the
 *     queue's own bound with a stub of a stated latency, never a model's throughput;
 *   * the write section drives a bounded, human-paced write workload with a handful of residents on
 *     a disposable fixture; it runs no soak test, measures no memory growth, no TLS, no proxy, no
 *     real network latency and no multiple writers. The load harness it invokes still measures reads
 *     only (every request there is a GET), so the HTTP figures are read capacity and the write
 *     figures are write capacity — they are never added together;
 *   * it never opens an installed world: `data/`, `outputs/`, backups and model weights are read at
 *     most to confirm they did not change. Every measurement runs in a temporary workspace.
 *
 *   node scripts/capacity-experiment.mjs [--http-clients 1,8,32] [--http-requests 200]
 *        [--browser-suites 1,2] [--browser-scenarios id,id] [--full-browser]
 *        [--model-attempts 12] [--model-max-waiting 8] [--model-latency 50]
 *        [--write-clients 1,8] [--write-iterations 40] [--write-builds 3000] [--subscribers 8]
 *        [--skip-http] [--skip-browser] [--skip-model] [--skip-model-drill] [--skip-writes]
 *        [--json path]
 *
 * It exits non-zero when a bounded budget is breached (a harness failure budget, a suite that fails,
 * or a queue bound that does not hold), so it can be used as a release probe on a machine of
 * interest. It is deliberately not part of `npm test`: a timing measurement is evidence, not a
 * stable assertion.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, totalmem, tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { boundedModel } from '../runtime/model.js';
import { Platform } from '../src/platform.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((item) => setTimeout(item, ms));

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);
const numbers = (value) => String(value).split(',').map((entry) => Number.parseInt(entry, 10)).filter((entry) => Number.isInteger(entry) && entry > 0);

const LIMITS = {
  http_clients: numbers(option('http-clients', '1,8,32')),
  http_requests_per_level: Number.parseInt(option('http-requests', '200'), 10),
  http_request_timeout_ms: Number.parseInt(option('http-timeout', '5000'), 10),
  http_run_timeout_ms: Number.parseInt(option('http-duration', '240000'), 10),
  http_failure_budget: Number(option('http-failure-budget', '0')),
  browser_suites: numbers(option('browser-suites', '1,2')),
  browser_scenarios: String(option('browser-scenarios', 'accounts-and-switching,country-ambassadors,first-person-controls,shared-presence-two-clients')).split(',').map((entry) => entry.trim()).filter(Boolean),
  browser_timeout_ms: Number.parseInt(option('browser-timeout', '1500000'), 10),
  model_attempts: Number.parseInt(option('model-attempts', '12'), 10),
  model_max_waiting: Number.parseInt(option('model-max-waiting', '8'), 10),
  model_latency_ms: Number.parseInt(option('model-latency', '50'), 10),
  write_clients: numbers(option('write-clients', '1,8')),
  write_iterations: Number.parseInt(option('write-iterations', '40'), 10),
  write_build_attempts: Number.parseInt(option('write-builds', '3000'), 10),
  write_request_timeout_ms: Number.parseInt(option('write-timeout', '5000'), 10),
  subscribers: Number.parseInt(option('subscribers', '8'), 10),
};
const JSON_PATH = option('json', null);
const SKIP = { http: flag('skip-http'), browser: flag('skip-browser'), model: flag('skip-model'), drill: flag('skip-model-drill'), writes: flag('skip-writes') };
const FULL_BROWSER = flag('full-browser');

const round = (value, places = 2) => (value === null || value === undefined ? null : Number(value.toFixed(places)));
/** Nearest-rank percentile on a sorted sample: p95 of n values is the ceil(0.95n)-th smallest. */
function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
function latencyStats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50_ms: round(percentile(sorted, 0.5), 1),
    p90_ms: round(percentile(sorted, 0.9), 1),
    p95_ms: round(percentile(sorted, 0.95), 1),
    p99_ms: round(percentile(sorted, 0.99), 1),
    max_ms: round(sorted[sorted.length - 1] ?? null, 1),
  };
}

/** The environment every child gets: no inherited database path, origin, setup code or model. */
function childEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const name of ['LUCY_DATABASE', 'LUCY_PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'LUCY_SETUP_CODE', 'LUCY_MODEL_NAME', 'LUCY_MODEL_URL', 'LUCY_MODEL_BACKEND', 'LUCY_MODEL_KEY', 'LUCY_LOCAL_PORT_FALLBACK', 'PORT', 'LUCY_LOAD_KEEP', 'LUCY_E2E_KEEP', 'LUCY_BROWSER_KEEP', 'LUCY_BROWSER_ONLY', 'LUCY_BROWSER_CHANNEL', 'LUCY_CHROME_PATH', 'WORLD_AGENT_TOKEN', 'WORLD_URL']) delete environment[name];
  return { ...environment, ...extra };
}

/** Run one child process to completion, capturing its output, with a hard wall-clock ceiling. */
function runChild(args, { env, timeoutMs } = {}) {
  return new Promise((resolveChild) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env: env || childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timer); resolveChild({ code: null, signal: null, timedOut, stdout, stderr: `${stderr}${error.message}`, duration_ms: performance.now() - started, error: error.message }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveChild({ code, signal, timedOut, stdout, stderr, duration_ms: performance.now() - started }); });
  });
}

// ---------------------------------------------------------------------------------------------
// The installed world must stay untouched. Record what could be damaged, and prove it did not
// change. Nothing here opens a database or a model weight.
// ---------------------------------------------------------------------------------------------
function installedState() {
  const files = ['data/world.sqlite', 'data/world.sqlite-wal', 'data/world.sqlite-shm'];
  const state = {};
  for (const file of files) {
    const path = join(ROOT, file);
    try { const stat = statSync(path); state[file] = `${stat.size}/${stat.mtimeMs}`; }
    catch { state[file] = 'absent'; }
  }
  state.outputs_lucy = existsSync(join(ROOT, 'outputs', 'Lucy')) ? 'present' : 'absent';
  return state;
}
const sameState = (before, after) => JSON.stringify(before) === JSON.stringify(after);

function git(command) {
  try { return execFileSync('git', command, { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// 1. HTTP capacity — the existing load harness, unmodified, on its own temporary database.
// ---------------------------------------------------------------------------------------------
async function measureHttp(workspace) {
  const reportPath = join(workspace, 'http.json');
  const args = ['scripts/load-harness.mjs',
    '--clients', LIMITS.http_clients.join(','),
    '--requests', String(LIMITS.http_requests_per_level),
    '--timeout', String(LIMITS.http_request_timeout_ms),
    '--duration', String(LIMITS.http_run_timeout_ms),
    '--failure-budget', String(LIMITS.http_failure_budget),
    '--json', reportPath];
  console.log('');
  console.log(`HTTP CAPACITY  invoking scripts/load-harness.mjs (unmodified) · clients ${LIMITS.http_clients.join(', ')} · ${LIMITS.http_requests_per_level} requests per level`);
  const run = await runChild(args, { timeoutMs: LIMITS.http_run_timeout_ms + 180_000 });
  let report = null;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch { /* The harness failed before writing its report; its output is the evidence. */ }
  const levels = (report?.levels || []).map((level) => ({
    clients: level.clients,
    elapsed_ms: level.elapsed_ms,
    attempts: level.overall.attempts,
    ok: level.overall.ok,
    http_errors: level.overall.http_errors,
    timeouts: level.overall.timeouts,
    socket_errors: level.overall.socket_errors,
    throughput_per_second: level.throughput_per_second,
    latency: { p50_ms: level.overall.latency_p50_ms, p90_ms: level.overall.latency_p90_ms, p95_ms: level.overall.latency_p95_ms, p99_ms: level.overall.latency_p99_ms, max_ms: level.overall.latency_max_ms, samples: level.overall.latency_samples },
    bytes_median: level.overall.bytes_median,
    bytes_max: level.overall.bytes_max,
    within_budget: level.within_budget,
    per_path: (level.per_path || []).map((path) => ({ path: path.key, attempts: path.attempts, ok: path.ok, p50_ms: path.latency_p50_ms, p95_ms: path.latency_p95_ms, bytes_median: path.bytes_median })),
  }));
  for (const level of levels) {
    console.log(`  concurrency ${String(level.clients).padStart(2)}  ${String(level.ok).padStart(3)}/${String(level.attempts).padEnd(3)} ok  ${String(level.throughput_per_second).padStart(6)} req/s  p50 ${String(level.latency.p50_ms).padStart(8)} ms  p95 ${String(level.latency.p95_ms).padStart(9)} ms  p99 ${String(level.latency.p99_ms).padStart(9)} ms  errors ${level.http_errors}  timeouts ${level.timeouts}  ${level.within_budget ? 'within budget' : 'ABOVE BUDGET'}`);
  }
  if (!levels.length) console.log(`  no level produced a report (exit code ${run.code}${run.timedOut ? ', timed out' : ''}) — see the harness output`);
  return {
    instrument: 'scripts/load-harness.mjs (unmodified, invoked as a child process)',
    exit_code: run.code,
    timed_out: run.timedOut,
    duration_ms: round(run.duration_ms),
    workload: report?.workload || null,
    limits: report?.limits || LIMITS,
    fixture: report?.fixture || null,
    model_read_from_health: report?.model || null,
    ceiling: report?.ceiling || null,
    levels,
    ok: Boolean(report) && levels.length > 0 && levels.every((level) => level.within_budget),
    note: report ? 'Read from the harness\'s own JSON report; the harness enforces and prints every limit.' : `The harness did not produce a report. Its output was:\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-2000)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Browser clients — the existing browser suite, unmodified, invoked at bounded concurrency.
//    Each suite is one isolated installation (own temp workspace, own database, own server) driven
//    by real Chrome; at most two browser pages are open in a suite at once.
// ---------------------------------------------------------------------------------------------
function parseSuiteOutput(stdout) {
  const summary = /SUMMARY\s+(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/.exec(stdout);
  const scenarios = [...stdout.matchAll(/^PASS\s+(\S+)\s+—\s+(.+?)\s+\((\d+) ms\)$/gm)].map((match) => ({ id: match[1], title: match[2], ms: Number(match[3]) }));
  const failed = [...stdout.matchAll(/^FAIL\s+(\S+)\s+—\s+(.+)$/gm)].map((match) => ({ id: match[1], title: match[2] }));
  return {
    passed: summary ? Number(summary[1]) : null,
    failed_count: summary ? Number(summary[2]) : null,
    skipped: summary && summary[3] ? Number(summary[3]) : 0,
    scenarios,
    failed,
    result: /result\s+PASS/.test(stdout) ? 'PASS' : /result\s+FAIL/.test(stdout) ? 'FAIL' : 'unknown',
    browser: (/browser\s+(\S.*)$/m.exec(stdout) || [])[1]?.trim() || null,
    authentication_waits: /the authentication limiter refused this attempt/.test(stdout) ? 1 : 0,
  };
}

async function measureBrowser(levels) {
  const results = [];
  for (const level of levels) {
    console.log('');
    console.log(`BROWSER CLIENTS  ${level.concurrency} concurrent suite(s) × up to 2 browser pages${level.full ? ' · complete 16-scenario suite' : ` · scenarios ${level.scenarios.join(', ')}`}`);
    const started = performance.now();
    const children = await Promise.all(Array.from({ length: level.concurrency }, async () => {
      const env = childEnvironment(level.full ? {} : { LUCY_BROWSER_ONLY: level.scenarios.join(',') });
      return runChild(['scripts/browser-suite.mjs'], { env, timeoutMs: LIMITS.browser_timeout_ms });
    }));
    const wall = performance.now() - started;
    const suites = children.map((child, index) => ({
      index,
      exit_code: child.code,
      timed_out: child.timedOut,
      duration_ms: round(child.duration_ms),
      ...parseSuiteOutput(child.stdout),
      stderr_tail: child.stderr ? child.stderr.slice(-1500) : '',
    }));
    const scenarioLatencies = suites.flatMap((suite) => suite.scenarios.map((scenario) => scenario.ms));
    const ok = suites.every((suite) => suite.exit_code === 0 && suite.result === 'PASS');
    for (const [index, suite] of suites.entries()) {
      console.log(`  suite ${index + 1}      ${suite.result} · ${suite.passed ?? '?'} passed, ${suite.failed_count ?? '?'} failed${suite.timed_out ? ' (timed out)' : ''} · ${(suite.duration_ms / 1000).toFixed(1)} s${suite.browser ? ` · ${suite.browser}` : ''}`);
      for (const scenario of suite.scenarios) console.log(`    ${scenario.id.padEnd(36)} ${String(scenario.ms).padStart(7)} ms`);
    }
    console.log(`  level wall clock ${(wall / 1000).toFixed(1)} s · browser scenarios ${scenarioLatencies.length} · ${ok ? 'all suites passed' : 'A SUITE FAILED'}`);
    results.push({
      concurrency: level.concurrency,
      browser_pages_bound: level.concurrency * 2,
      scenarios_requested: level.full ? 'complete suite (16 scenarios)' : level.scenarios,
      wall_clock_ms: round(wall),
      suites,
      browser_scenario_latency: latencyStats(scenarioLatencies),
      total_scenario_steps: scenarioLatencies.length,
      ok,
    });
  }
  return {
    instrument: 'scripts/browser-suite.mjs (unmodified, invoked as a child process; real Chrome, real interface, real records)',
    fixture: 'each suite creates its own temporary workspace and SQLite database, seeds the fictional accounts through the interface/API and removes them afterwards',
    concurrency_meaning: 'concurrent isolated installations, each driving at most two browser pages. The suite has no knob to raise the number of browser clients against one server, so this experiment reports browser-client cost per client and suite wall-clock. It does NOT establish a maximum number of browser clients.',
    isolated_runs: results.length ? results[0].suites.every((suite) => /PASS/.test(suite.result)) : null,
    levels: results,
    ok: results.every((level) => level.ok),
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Model-queue capacity — the shipped bounded queue, and the shipped server's own drill.
// ---------------------------------------------------------------------------------------------
async function measureModelQueue(workspace) {
  const { model_attempts: attempts, model_max_waiting: maxWaiting, model_latency_ms: latency } = LIMITS;
  console.log('');
  console.log(`MODEL QUEUE  shipped boundedModel · ${attempts} simultaneous requests · max waiting ${maxWaiting} · stub inference ${latency} ms (NO real model is configured or called)`);
  const stub = async ({ id }) => { await sleep(latency); return { id }; };
  const model = boundedModel(stub, { maxWaiting });
  const peak = { waiting: 0, active: 0 };
  const sampler = setInterval(() => { const status = model.status(); peak.waiting = Math.max(peak.waiting, status.waiting); peak.active = Math.max(peak.active, status.active); }, 2);
  sampler.unref();
  const started = performance.now();
  const outcomes = await Promise.all(Array.from({ length: attempts }, (_, id) => {
    const began = performance.now();
    return model({ id }).then(
      () => ({ outcome: 'completed', response_ms: round(performance.now() - began, 1) }),
      (error) => ({ outcome: /busy/i.test(error?.message || '') ? 'refused_saturated' : 'failed', message: error?.message || String(error), response_ms: round(performance.now() - began, 1) }),
    );
  }));
  const wall = performance.now() - started;
  clearInterval(sampler);
  const completed = outcomes.filter((entry) => entry.outcome === 'completed');
  const refused = outcomes.filter((entry) => entry.outcome === 'refused_saturated');
  const failed = outcomes.filter((entry) => entry.outcome === 'failed');
  const queueWaits = completed.map((entry) => Math.max(0, entry.response_ms - latency)).sort((a, b) => a - b);
  const expectedAdmitted = Math.min(attempts, maxWaiting + 1);
  const boundHeld = completed.length === expectedAdmitted && refused.length === attempts - expectedAdmitted && peak.waiting === maxWaiting && failed.length === 0;
  console.log(`  admitted ${completed.length} of ${attempts} · refused as saturated ${refused.length} · failed ${failed.length} · peak waiting ${peak.waiting} of ${maxWaiting} · one-at-a-time peak active ${peak.active}`);
  console.log(`  queue wait before inference p50 ${latencyStats(queueWaits).p50_ms} ms · p95 ${latencyStats(queueWaits).p95_ms} ms · max ${latencyStats(queueWaits).max_ms} ms (queue wait excludes the ${latency} ms stub inference)`);
  console.log(`  serialized throughput ${round(completed.length / (wall / 1000), 1)} inferences/s at a ${latency} ms stub latency · bound ${boundHeld ? 'held' : 'DID NOT HOLD'}`);

  let drill = null;
  if (!SKIP.drill) {
    console.log(`  shipped-server drill  invoking scripts/ops-rehearsal.mjs --drill model-queue-saturation (unmodified)`);
    const run = await runChild(['scripts/ops-rehearsal.mjs', '--drill', 'model-queue-saturation'], { timeoutMs: 300_000 });
    const line = run.stdout.split('\n').find((entry) => entry.includes('model-queue-saturation')) || '';
    drill = { exit_code: run.code, timed_out: run.timedOut, duration_ms: round(run.duration_ms), line: line.trim(), ran: /(PASS|FAIL)\s+model-queue-saturation/.test(run.stdout) };
    console.log(`    ${drill.ran ? line.trim() : `the drill did not run (exit code ${run.code}) — reported as not measured`}`);
  }

  return {
    instrument: 'the shipped `boundedModel` (runtime/model.js) with a stub inference of a stated latency, plus the shipped server\'s own model-queue drill',
    real_model_configured: false,
    real_model_called: false,
    stub_inference_latency_ms: latency,
    attempts,
    max_waiting: maxWaiting,
    admitted: completed.length,
    expected_admitted: expectedAdmitted,
    refused_saturated: refused.length,
    failed: failed.length,
    peak_waiting: peak.waiting,
    peak_active: peak.active,
    queue_wait_ms: latencyStats(queueWaits),
    serialized_inferences_per_second: round(completed.length / (wall / 1000), 1),
    bound_held: boundHeld,
    shipped_server_drill: drill,
    shipped_server_bounds_read_not_exercised: {
      note: 'Read from the shipped server (server.js / src/hosting.js and the harness\'s /health payload), not exercised by a real model here.',
      resident_runs_admitted_at_once: 1,
      research_workers_admitted_at_once: 4,
      model_queue_max_waiting_default: 8,
      event_subscriptions_per_process: 64,
      event_subscriptions_per_account: 4,
    },
    note: 'These are the queue policy\'s own numbers with a stub inference. They are not model throughput, and no production model capacity is established.',
    ok: boundHeld && (!drill || drill.ran),
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Write capacity and the event feed — the shipped server, the shipped write routes, real HTTP.
//
// The load harness measures reads only: every request it sends is a GET, so movement and building are
// not covered there. This section starts the shipped `server.js` on its own temporary database and
// drives the two writes a resident client actually sends —
//   POST /api/v1/move               a confirmed step (movement, the hottest write)
//   POST /api/v1/agents/:id/build   a saved garden object (building)
// — at bounded client concurrency, with each client on its own resident so the server's own 120 ms
// per-agent movement throttle is respected rather than mistaken for a capacity failure. While the
// writes flow, authenticated clients hold `GET /api/v1/events` subscriptions to the Commons and each
// received frame is timed against the server's own send clock (`frame.t`). It measures this machine,
// this fixture and this concurrency; nothing here is a supported-user count.
// ---------------------------------------------------------------------------------------------
const WRITE_PASSWORD = 'capacity-write-password-2026';
const MOVEMENT_THROTTLE_MS = 120;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
  });
}

/** One bounded HTTP POST with its own deadline. It never throws: the outcome says what happened. */
function postJson(port, path, input, token, timeoutMs) {
  return new Promise((resolvePost) => {
    const started = performance.now();
    const payload = Buffer.from(JSON.stringify(input));
    const headers = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': payload.length };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('end', () => resolvePost({ outcome: response.statusCode >= 200 && response.statusCode < 300 ? 'ok' : 'http_error', status: response.statusCode, bytes, latency_ms: performance.now() - started, path }));
    });
    request.on('error', (error) => resolvePost({ outcome: error.name === 'AbortError' || error.code === 'UND_ERR_ABORTED' ? 'timeout' : 'socket_error', status: 0, bytes: 0, latency_ms: performance.now() - started, path, detail: error.code || error.name }));
    request.end(payload);
  });
}

function getJson(port, path, token, timeoutMs) {
  return new Promise((resolveGet) => {
    const headers = { Host: `127.0.0.1:${port}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => { try { resolveGet({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { resolveGet({ status: response.statusCode, body: null }); } });
    });
    request.on('error', () => resolveGet({ status: 0, body: null }));
    request.end();
  });
}

/** One authenticated Server-Sent Events subscription. Frames are timed against the server's clock. */
function openSubscription(port, token, worldId) {
  const state = { buffer: '', frames: 0, received: [], status: null, ready: false, error: null };
  const request = httpRequest({ host: '127.0.0.1', port, path: `/api/v1/events?world_id=${encodeURIComponent(worldId)}`, method: 'GET', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } }, (response) => {
    state.status = response.statusCode;
    if (response.statusCode !== 200) { response.resume(); return; }
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      state.buffer += chunk;
      let index;
      while ((index = state.buffer.indexOf('\n\n')) !== -1) {
        const frame = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 2);
        if (frame.startsWith('event: ready')) { state.ready = true; continue; }
        if (!frame.startsWith('event: update')) continue;
        const at = Date.now();
        try {
          const body = JSON.parse(frame.split('\ndata: ')[1]);
          state.frames += 1;
          if (Number.isFinite(body.t)) state.received.push(at - body.t);
        } catch { /* a frame that will not parse is not counted */ }
      }
    });
  });
  request.on('error', (error) => { state.error = error.code || error.name; });
  request.end();
  state.close = () => request.destroy();
  return state;
}

/** A disposable fixture: one mover per client, one builder in its own garden, viewers to subscribe. */
async function seedWriteWorld(directory, { movers, subscribers }) {
  const database = join(directory, 'writes.sqlite');
  const platform = new Platform(database);
  const admin = await platform.register({ name: 'Capacity administrator', email: 'capacity-admin@harness.test', password: WRITE_PASSWORD, consent: true });
  const invite = () => platform.transaction(() => platform.invite(platform.authenticate(admin.token), { role: 'member' }));
  const register = async (name) => { const code = invite(); return platform.register({ name, email: `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@harness.test`, password: WRITE_PASSWORD, consent: true, invite: code.code }); };
  // One operator may hold five agents, so the fixture spreads its residents over enough operators and
  // hands back the owning token with each one; a mover is always driven by its own operator.
  const perOperator = 4;
  const operators = [];
  let current = null, holdings = perOperator;
  const nextAgent = async (name) => {
    if (!current || holdings >= perOperator) { current = await register(`capacity operator ${operators.length + 1}`); operators.push(current); holdings = 0; }
    holdings += 1;
    const actor = platform.authenticate(current.token);
    const agent = platform.transaction(() => platform.createAgent(actor, { name, color: '#397f79', symbol: '✦' }));
    return { id: agent.id, token: current.token };
  };
  const moverList = [];
  for (let index = 0; index < movers; index++) moverList.push(await nextAgent(`Capacity mover ${index + 1}`));
  const builder = await nextAgent('Capacity builder');
  platform.transaction(() => platform.travel(platform.authenticate(builder.token), builder.id, { world_id: `home:${builder.id}` }));
  // The buildable tiles are discovered once, in the fixture, so the HTTP workload can never mistake a
  // refused tile for a capacity failure. Rebuilding a discovered tile is idempotent (`ON CONFLICT …
  // DO UPDATE`), and `flowers` is not blocking scenery.
  const tiles = [];
  for (let y = 2; y <= 21 && tiles.length < 80; y++) {
    for (let x = 2; x <= 29 && tiles.length < 80; x++) {
      try { platform.transaction(() => platform.build(platform.authenticate(builder.token), builder.id, { type: 'flowers', x, y })); tiles.push({ x, y }); }
      catch { /* not a buildable tile in this garden */ }
    }
  }
  // One account may hold four concurrent subscriptions, so each group of four viewers gets its own
  // account; the same account twice would be refused by the channel's own per-account bound.
  const subscriberTokens = [];
  for (let index = 0; index < Math.max(1, Math.ceil(subscribers / 4)); index++) {
    const viewer = await register(`capacity viewer ${index + 1}`);
    const viewerActor = platform.authenticate(viewer.token);
    platform.transaction(() => platform.createAgent(viewerActor, { name: `Capacity viewer ${index + 1} resident`, color: '#397f79', symbol: '✦' }));
    subscriberTokens.push(viewer.token);
  }
  platform.close();
  return { database, moverList, builder, tiles, subscriberTokens, operators: operators.length };
}

async function startWriteServer(database, port) {
  const env = { ...process.env, PORT: String(port), LUCY_DATABASE: database, LUCY_BIND_HOST: '127.0.0.1' };
  for (const name of ['LUCY_PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'LUCY_SETUP_CODE', 'LUCY_LOCAL_PORT_FALLBACK', 'LUCY_MODEL_NAME', 'LUCY_MODEL_URL', 'LUCY_MODEL_KEY']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  const collect = (chunk) => { output.push(chunk.toString('utf8').trimEnd()); if (output.length > 40) output.splice(0, output.length - 40); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The write-workload server exited before becoming ready (code ${child.exitCode}).\n${output.join('\n')}`);
    const probe = await getJson(port, '/api/v1/health', null, 2000);
    if (probe.status === 200) return { child, output };
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`The write-workload server did not become ready within 60 s.\n${output.join('\n')}`);
}

async function stopWriteServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', () => resolveExit(true)));
  child.kill('SIGTERM');
  if (!(await Promise.race([exited, sleep(10_000).then(() => false)]))) { child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]); }
}

const writeBucket = () => ({ attempts: 0, ok: 0, http_errors: 0, timeouts: 0, socket_errors: 0, statuses: new Set() });
const summariseWrite = (bucket, samples) => ({
  attempts: bucket.attempts, ok: bucket.ok, http_errors: bucket.http_errors, timeouts: bucket.timeouts,
  socket_errors: bucket.socket_errors, statuses: [...bucket.statuses].sort(), ...latencyStats(samples),
});

async function runWriteLevel({ clients, iterations, buildAttempts, port, moverList, builder, tiles, timeoutMs, deadline }) {
  const workers = Math.min(clients, moverList.length);
  const buildPerWorker = Math.max(1, Math.ceil(buildAttempts / workers));
  let tileIndex = 0;
  const withRate = (bucket, samples, elapsed) => ({ ...summariseWrite(bucket, samples), elapsed_ms: round(elapsed), throughput_per_second: round(elapsed ? bucket.attempts / (elapsed / 1000) : 0) });

  // Movement: every client steps its own resident and waits past the server's own 120 ms per-agent
  // throttle, so a confirmed step is never confused with a throttle refusal. This is the client-paced
  // write a walking human actually produces.
  const move = writeBucket(); const moveSamples = [];
  const moveStarted = performance.now();
  await Promise.all(Array.from({ length: workers }, async (_, index) => {
    const mover = moverList[index % moverList.length];
    let lastMoveAt = -Infinity;
    for (let step = 0; step < iterations; step++) {
      if (performance.now() >= deadline) return;
      const wait = lastMoveAt + MOVEMENT_THROTTLE_MS + 10 - performance.now();
      if (wait > 0) await sleep(wait);
      const result = await postJson(port, '/api/v1/move', { agent_id: mover.id, direction: (index + step) % 2 === 0 ? 'right' : 'left' }, mover.token, timeoutMs);
      // Pacing is measured from the confirmed response, so the server's own processing time cannot
      // shrink the gap and turn a paced step into a throttle refusal.
      lastMoveAt = performance.now();
      move.attempts += 1;
      if (result.outcome === 'ok') { move.ok += 1; moveSamples.push(result.latency_ms); }
      else move[`${result.outcome}s`] += 1;
      move.statuses.add(result.status);
    }
  }));
  const moveElapsed = performance.now() - moveStarted;

  // Building: the same clients save garden objects with no client pacing, so the throughput is what
  // the server actually serves rather than what the harness chose to offer. Rebays are idempotent.
  const build = writeBucket(); const buildSamples = [];
  const buildStarted = performance.now();
  await Promise.all(Array.from({ length: workers }, async () => {
    for (let step = 0; step < buildPerWorker; step++) {
      if (performance.now() >= deadline) return;
      const tile = tiles[tileIndex++ % tiles.length];
      const result = await postJson(port, `/api/v1/agents/${builder.id}/build`, { x: tile.x, y: tile.y, type: 'flowers' }, builder.token, timeoutMs);
      build.attempts += 1;
      if (result.outcome === 'ok') { build.ok += 1; buildSamples.push(result.latency_ms); }
      else build[`${result.outcome}s`] += 1;
      build.statuses.add(result.status);
    }
  }));
  const buildElapsed = performance.now() - buildStarted;

  const total = move.attempts + build.attempts;
  const wall = moveElapsed + buildElapsed;
  return {
    clients,
    requests: total,
    elapsed_ms: round(wall),
    throughput_per_second: round(wall ? total / (wall / 1000) : 0),
    movement: withRate(move, moveSamples, moveElapsed),
    building: withRate(build, buildSamples, buildElapsed),
    failures: move.http_errors + move.timeouts + move.socket_errors + build.http_errors + build.timeouts + build.socket_errors,
  };
}

async function measureWritesAndSubscribers(workspace) {
  const directory = await mkdtemp(join(workspace, 'writes-'));
  const clients = LIMITS.write_clients;
  const seeded = await seedWriteWorld(directory, { movers: Math.max(...clients), subscribers: LIMITS.subscribers });
  const port = await freePort();
  const { child, output } = await startWriteServer(seeded.database, port);
  console.log('');
  console.log(`WRITE AND EVENT CAPACITY  shipped server.js (real HTTP) · movers ${Math.max(...clients)} · builder 1 · buildable tiles ${seeded.tiles.length} · subscribers ${LIMITS.subscribers}`);
  console.log(`  fixture    one synthetic operator, one resident per write client in the Commons and one builder in its own garden; NO real model and no read workload in this section`);
  const health = await getJson(port, '/api/v1/health', null, 5000);
  const feeds = [];
  for (let index = 0; index < LIMITS.subscribers; index++) feeds.push(openSubscription(port, seeded.subscriberTokens[Math.floor(index / 4) % seeded.subscriberTokens.length], 'commons'));
  const ready = await (async () => {
    const until = performance.now() + 10_000;
    while (performance.now() < until && !feeds.every((feed) => feed.ready)) await sleep(20);
    return feeds.every((feed) => feed.ready);
  })();
  const windowStart = performance.now();

  const levels = [];
  const deadline = performance.now() + 300_000;
  for (const concurrency of clients) {
      const level = await runWriteLevel({ clients: concurrency, iterations: LIMITS.write_iterations, buildAttempts: LIMITS.write_build_attempts, port, moverList: seeded.moverList, builder: seeded.builder, tiles: seeded.tiles, timeoutMs: LIMITS.write_request_timeout_ms, deadline });
    levels.push(level);
    console.log(`  clients ${String(level.clients).padStart(2)}  ${String(level.requests).padStart(4)} writes in ${(level.elapsed_ms / 1000).toFixed(2)} s  ${String(level.throughput_per_second).padStart(6)} writes/s combined`);
    console.log(`    movement  ${String(level.movement.attempts).padStart(4)} paced steps  ${String(level.movement.throughput_per_second).padStart(6)} steps/s  p50 ${String(level.movement.p50_ms).padStart(7)} ms  p95 ${String(level.movement.p95_ms).padStart(8)} ms  statuses ${level.movement.statuses.join(',')}  failures ${level.movement.http_errors + level.movement.timeouts + level.movement.socket_errors}`);
    console.log(`    building  ${String(level.building.attempts).padStart(4)} unpaced saves ${String(level.building.throughput_per_second).padStart(6)} saves/s  p50 ${String(level.building.p50_ms).padStart(7)} ms  p95 ${String(level.building.p95_ms).padStart(8)} ms  statuses ${level.building.statuses.join(',')}  failures ${level.building.http_errors + level.building.timeouts + level.building.socket_errors}`);
  }
  const windowSeconds = (performance.now() - windowStart) / 1000;

  // The server's own per-agent throttle, measured rather than assumed: unpaced movement on one
  // resident. This is a write bound the application sets deliberately, not a capacity failure.
  await sleep(MOVEMENT_THROTTLE_MS + 80);
  const probe = [];
  const probeStarted = performance.now();
  for (let index = 0; index < 12; index++) probe.push(await postJson(port, '/api/v1/move', { agent_id: seeded.moverList[0].id, direction: index % 2 === 0 ? 'right' : 'left' }, seeded.moverList[0].token, LIMITS.write_request_timeout_ms));
  const throttleProbe = {
    requests: probe.length,
    accepted: probe.filter((entry) => entry.outcome === 'ok').length,
    refused_429: probe.filter((entry) => entry.status === 429).length,
    elapsed_ms: round(performance.now() - probeStarted),
  };

  for (const feed of feeds) feed.close();
  await stopWriteServer(child);

  const statuses = [...new Set(feeds.map((feed) => feed.status))].sort();
  const perClientFrames = feeds.map((feed) => feed.frames);
  const opened = feeds.filter((feed) => feed.status === 200).length;
  const framesTotal = perClientFrames.reduce((sum, count) => sum + count, 0);
  const rateOf = (count) => round(windowSeconds > 0 ? count / windowSeconds : 0, 2);
  console.log(`  subscribers ${opened}/${LIMITS.subscribers} opened  statuses ${statuses.join(',')}  frames ${framesTotal} total  delivery p50 ${latencyStats(feeds.flatMap((feed) => feed.received)).p50_ms} ms  p95 ${latencyStats(feeds.flatMap((feed) => feed.received)).p95_ms} ms  peak client rate ${Math.max(0, ...perClientFrames.map(rateOf))} frames/s`);
  console.log(`  throttle   ${throttleProbe.accepted} of ${throttleProbe.requests} unpaced steps accepted, ${throttleProbe.refused_429} refused 429 in ${throttleProbe.elapsed_ms} ms`);
  const failures = levels.reduce((sum, level) => sum + level.failures, 0);
  console.log(`  verdict    ${failures} failed/timed-out writes, ${opened === LIMITS.subscribers && ready ? 'every subscriber held its feed' : 'A SUBSCRIBER DID NOT OPEN'}${output.length && failures ? ` — server said: ${output.slice(-2).join(' ')}` : ''}`);

  return {
    instrument: 'the shipped server.js as a child process, driven over real HTTP on a temporary database (POST /api/v1/move, POST /api/v1/agents/:id/build) with GET /api/v1/events Server-Sent Events subscriptions held open',
    workload: 'movement writes (one resident per client, paced above the server\'s own 120 ms per-agent step throttle) and building writes (idempotent garden objects), with authenticated Commons event subscribers held open across every level',
    fixture: { movers: seeded.moverList.length, builders: 1, buildable_tiles: seeded.tiles.length, subscriber_accounts: seeded.subscriberTokens.length, subscribers_requested: LIMITS.subscribers, operator_accounts: seeded.operators + seeded.subscriberTokens.length, movement_throttle_ms: MOVEMENT_THROTTLE_MS, note: 'a disposable synthetic fixture (one operator holds at most four residents); a stored record count is built here, but concurrency is created by the client pool, not by the row count' },
    limits: { write_clients: clients, write_iterations: LIMITS.write_iterations, write_build_attempts: LIMITS.write_build_attempts, request_timeout_ms: LIMITS.write_request_timeout_ms, subscribers: LIMITS.subscribers },
    model_from_health: health.body ? { model_configured: health.body.model_configured, model_queue: health.body.model_queue } : null,
    levels,
    subscribers: {
      requested: LIMITS.subscribers, opened, statuses, all_ready: ready,
      window_seconds: round(windowSeconds),
      frames_total: framesTotal,
      frames_per_client: { min: Math.min(...perClientFrames), max: Math.max(...perClientFrames) },
      frames_per_client_per_second: rateOf(framesTotal / Math.max(1, feeds.length)),
      peak_client_frames_per_second: Math.max(0, ...perClientFrames.map(rateOf)),
      delivery_latency_ms: latencyStats(feeds.flatMap((feed) => feed.received)),
      frame_rate_limit: 20,
    },
    movement_throttle_probe: { ...throttleProbe, note: 'unpaced movement on one resident: the served step rate for one resident is bounded by the application\'s own 120 ms throttle, not by the database' },
    ok: failures === 0 && opened === LIMITS.subscribers && ready && levels.length === clients.length,
    note: 'Write and event-feed capacity under this hardware, this fixture, this concurrency and this workload only. Reads are excluded here; the read figures are in http_capacity and the two are never added together. No real model was configured or called.',
  };
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'nemoworld-capacity-'));
  const installedBefore = installedState();
  const commit = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = (git(['status', '--porcelain']) || '').split('\n').filter(Boolean).length;

  console.log('NemoWorld capacity experiment (Task 28)');
  console.log('  This is a bounded local measurement, not a production capacity guarantee, and it starts no paid work.');
  console.log(`  hardware   ${cpus()[0]?.model || 'unknown CPU'} · ${cpus().length} logical CPUs · ${(totalmem() / 1024 ** 3).toFixed(1)} GiB memory`);
  console.log(`  system     ${process.platform} ${process.arch} · ${release()} · Node ${process.version}`);
  console.log(`  source     ${branch} @ ${commit ? commit.slice(0, 12) : 'unknown'}${dirty ? ` (${dirty} modified path(s) in the working tree)` : ' (clean working tree)'}`);
  console.log(`  isolation  every measurement runs in its own temporary workspace and database: ${workspace}`);
  console.log(`  installed  data/world.sqlite ${installedBefore['data/world.sqlite']} · outputs/Lucy ${installedBefore.outputs_lucy} (recorded, and re-checked at the end)`);
  console.log(`  limits     http clients ${LIMITS.http_clients.join(',')} · ${LIMITS.http_requests_per_level} req/level · browser suites ${LIMITS.browser_suites.join(',')}${FULL_BROWSER ? ' (+ one complete suite)' : ''} · model attempts ${LIMITS.model_attempts} (max waiting ${LIMITS.model_max_waiting}, stub ${LIMITS.model_latency_ms} ms) · write clients ${LIMITS.write_clients.join(',')} · ${LIMITS.write_iterations} paced moves + ${LIMITS.write_build_attempts} saves per level · ${LIMITS.subscribers} event subscribers`);

  const started = performance.now();
  const http = SKIP.http ? { skipped: true, ok: true } : await measureHttp(workspace);
  const browser = SKIP.browser ? { skipped: true, ok: true } : await measureBrowser([
    ...LIMITS.browser_suites.map((concurrency) => ({ concurrency, scenarios: LIMITS.browser_scenarios, full: false })),
    ...(FULL_BROWSER ? [{ concurrency: 1, scenarios: null, full: true }] : []),
  ]);
  const model = SKIP.model ? { skipped: true, ok: true } : await measureModelQueue(workspace);
  const writes = SKIP.writes ? { skipped: true, ok: true } : await measureWritesAndSubscribers(workspace);
  const installedAfter = installedState();
  const untouched = sameState(installedBefore, installedAfter);

  const report = {
    name: 'nemoworld-capacity-experiment',
    task: 'Task 28 — production readiness package',
    generated_at: new Date().toISOString(),
    duration_ms: round(performance.now() - started),
    source: { branch, commit, modified_paths: dirty },
    hardware: { cpu: cpus()[0]?.model || 'unknown', logical_cpus: cpus().length, memory_gib: round(totalmem() / 1024 ** 3, 1), platform: process.platform, arch: process.arch, os_release: release(), node: process.version },
    limits: LIMITS,
    isolation: { workspace, installed_before: installedBefore, installed_after: installedAfter, installed_world_untouched: untouched, note: 'Each instrument creates and removes its own temporary workspace and SQLite database. No installed database, backup, model weight or outputs/ path was opened for writing.' },
    http_capacity: http,
    browser_clients: browser,
    model_queue_capacity: model,
    write_and_event_capacity: writes,
    claim: 'Under this hardware, this fixture, this concurrency and this workload only. No production capacity is established, no supported-user count is implied, and no stored record count is a count of supported users. Read, write and model figures are separate measurements and are never added together. No real model was configured or called.',
  };

  const passed = [http, browser, model, writes].every((part) => part.ok !== false);
  console.log('');
  console.log('SUMMARY');
  if (http.levels) for (const level of http.levels) console.log(`  http      c=${String(level.clients).padStart(2)}  ${String(level.throughput_per_second).padStart(6)} req/s  p95 ${String(level.latency.p95_ms).padStart(9)} ms  failures ${level.http_errors + level.timeouts + level.socket_errors}  ${level.within_budget ? 'ok' : 'ABOVE BUDGET'}`);
  if (browser.levels) for (const level of browser.levels) console.log(`  browser   suites=${level.concurrency} (≤${level.browser_pages_bound} pages)  wall ${(level.wall_clock_ms / 1000).toFixed(1)} s  scenarios ${level.total_scenario_steps}  ${level.ok ? 'ok' : 'FAILED'}`);
  if (model.admitted !== undefined) console.log(`  model     admitted ${model.admitted}/${model.attempts}  refused ${model.refused_saturated}  peak waiting ${model.peak_waiting}/${model.max_waiting}  ${model.bound_held ? 'bound held' : 'BOUND NOT HELD'}`);
  if (writes.levels) for (const level of writes.levels) console.log(`  writes    c=${String(level.clients).padStart(2)}  move ${String(level.movement.throughput_per_second).padStart(6)} steps/s p95 ${String(level.movement.p95_ms).padStart(6)} ms · build ${String(level.building.throughput_per_second).padStart(6)} saves/s p95 ${String(level.building.p95_ms).padStart(6)} ms · failures ${level.failures}  ${level.failures ? 'FAILED' : 'ok'}`);
  if (writes.subscribers) console.log(`  events    ${writes.subscribers.opened}/${writes.subscribers.requested} subscribers  ${writes.subscribers.frames_total} frames  delivery p95 ${writes.subscribers.delivery_latency_ms.p95_ms} ms  peak client ${writes.subscribers.peak_client_frames_per_second}/${writes.subscribers.frame_rate_limit} frames/s  ${writes.ok ? 'ok' : 'FAILED'}`);
  console.log(`  isolation the installed world was ${untouched ? 'untouched' : 'CHANGED — investigate'}`);
  console.log(`  claim     ${report.claim}`);
  if (JSON_PATH) { await writeFile(resolve(JSON_PATH), `${JSON.stringify(report, null, 2)}\n`); console.log(`  wrote     ${resolve(JSON_PATH)}`); }
  await rm(workspace, { recursive: true, force: true });
  if (!passed || !untouched) process.exitCode = 1;
}

process.on('SIGINT', () => { process.exitCode = 130; });

try { await main(); }
catch (error) {
  console.error(`\nFAIL  ${error.message}`);
  console.error(error.stack?.split('\n').slice(1, 4).join('\n') || '');
  process.exitCode = 1;
}
