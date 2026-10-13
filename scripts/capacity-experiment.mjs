#!/usr/bin/env node
/**
 * NemoWorld capacity experiment (Task 28).
 *
 * It answers two separate questions and never conflates them:
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
 *   * it starts no write workload (every harness request is a GET), runs no soak test, measures no
 *     memory growth, no TLS, no proxy, no real network latency and no multiple writers;
 *   * it never opens an installed world: `data/`, `outputs/`, backups and model weights are read at
 *     most to confirm they did not change. Every measurement runs in a temporary workspace.
 *
 *   node scripts/capacity-experiment.mjs [--http-clients 1,8,32] [--http-requests 200]
 *        [--browser-suites 1,2] [--browser-scenarios id,id] [--full-browser]
 *        [--model-attempts 12] [--model-max-waiting 8] [--model-latency 50]
 *        [--skip-http] [--skip-browser] [--skip-model] [--skip-model-drill]
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
import { boundedModel } from '../runtime/model.js';

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
};
const JSON_PATH = option('json', null);
const SKIP = { http: flag('skip-http'), browser: flag('skip-browser'), model: flag('skip-model'), drill: flag('skip-model-drill') };
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
  console.log(`  limits     http clients ${LIMITS.http_clients.join(',')} · ${LIMITS.http_requests_per_level} req/level · browser suites ${LIMITS.browser_suites.join(',')}${FULL_BROWSER ? ' (+ one complete suite)' : ''} · model attempts ${LIMITS.model_attempts} (max waiting ${LIMITS.model_max_waiting}, stub ${LIMITS.model_latency_ms} ms)`);

  const started = performance.now();
  const http = SKIP.http ? { skipped: true, ok: true } : await measureHttp(workspace);
  const browser = SKIP.browser ? { skipped: true, ok: true } : await measureBrowser([
    ...LIMITS.browser_suites.map((concurrency) => ({ concurrency, scenarios: LIMITS.browser_scenarios, full: false })),
    ...(FULL_BROWSER ? [{ concurrency: 1, scenarios: null, full: true }] : []),
  ]);
  const model = SKIP.model ? { skipped: true, ok: true } : await measureModelQueue(workspace);
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
    claim: 'Under this hardware, this fixture, this concurrency and this workload only. No production capacity is established, no supported-user count is implied, and no stored record count is a count of supported users. No real model was configured or called.',
  };

  const passed = [http, browser, model].every((part) => part.ok !== false);
  console.log('');
  console.log('SUMMARY');
  if (http.levels) for (const level of http.levels) console.log(`  http      c=${String(level.clients).padStart(2)}  ${String(level.throughput_per_second).padStart(6)} req/s  p95 ${String(level.latency.p95_ms).padStart(9)} ms  failures ${level.http_errors + level.timeouts + level.socket_errors}  ${level.within_budget ? 'ok' : 'ABOVE BUDGET'}`);
  if (browser.levels) for (const level of browser.levels) console.log(`  browser   suites=${level.concurrency} (≤${level.browser_pages_bound} pages)  wall ${(level.wall_clock_ms / 1000).toFixed(1)} s  scenarios ${level.total_scenario_steps}  ${level.ok ? 'ok' : 'FAILED'}`);
  if (model.admitted !== undefined) console.log(`  model     admitted ${model.admitted}/${model.attempts}  refused ${model.refused_saturated}  peak waiting ${model.peak_waiting}/${model.max_waiting}  ${model.bound_held ? 'bound held' : 'BOUND NOT HELD'}`);
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
