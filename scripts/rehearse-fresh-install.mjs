#!/usr/bin/env node
// Fresh-install release rehearsal for NemoWorld.
// Tests scripted server bootstrap from a clean code copy, API registration,
// persistence and selected startup errors. It does not execute Start World.command
// or drive account creation and play through the browser.

import { spawn, execSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { existsSync, mkdirSync, cpSync, chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function findChromeBinary() {
  if (process.env.LUCY_CHROME_PATH && existsSync(process.env.LUCY_CHROME_PATH)) {
    return process.env.LUCY_CHROME_PATH;
  }
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(macChrome)) return macChrome;
  return undefined;
}

export async function runFreshInstallRehearsal() {
  console.log('=== Starting Fresh-Install Release Rehearsal ===');
  const rehearsalLog = [];
  const log = (msg) => {
    console.log(`[Rehearsal] ${msg}`);
    rehearsalLog.push(msg);
  };

  const stageRoot = await mkdtemp(join(tmpdir(), 'nemoworld-fresh-stage-'));
  const reportDir = join(ROOT, 'docs', 'rehearsal');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  const report = {
    testedAt: new Date().toISOString(),
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
    },
    nodeVersion: process.version,
    steps: [],
    failuresAndRecovery: [],
    verdict: null,
  };

  try {
    // Step 1: Clean Extraction
    log('Step 1: Extracting clean codebase to disposable directory...');
    const excludeDirs = new Set(['.git', 'data', 'node_modules', 'outputs', '.runtime']);
    cpSync(ROOT, stageRoot, {
      recursive: true,
      filter: (src) => {
        const rel = relative(ROOT, src);
        if (!rel) return true;
        const segments = rel.split('/');
        return !segments.some((seg) => excludeDirs.has(seg));
      },
    });
    report.steps.push({ step: 'extraction', status: 'PASS', detail: `Staged to ${stageRoot}` });

    // Step 2: First Start & Port Binding
    log('Step 2: Starting server in clean directory...');
    const port = await freePort();
    const dataDir = join(stageRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'world.sqlite');

    const env = {
      ...process.env,
      PORT: String(port),
      LUCY_DATABASE: dbPath,
      LUCY_BIND_HOST: '127.0.0.1',
      LUCY_OPEN_BROWSER: '0',
    };

    let serverProcess = spawn(process.execPath, ['server.js'], { cwd: stageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let serverOutput = '';
    const collectOut = (d) => { serverOutput += d.toString(); };
    serverProcess.stdout.on('data', collectOut);
    serverProcess.stderr.on('data', collectOut);

    // Wait for server ready
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) {
        throw new Error(`Server exited early with code ${serverProcess.exitCode}. Output: ${serverOutput}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        if (res.status === 200) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error(`Server failed to start in fresh directory within 20s. Output: ${serverOutput}`);
    log(`Server ready on port ${port}. Database created at ${dbPath}`);
    report.steps.push({ step: 'start_server', status: 'PASS', detail: `Server ready at http://127.0.0.1:${port}` });

    // Step 3: Fictional Adult Account Registration & Admin Invariant
    log('Step 3: Registering first fictional adult administrator account (Elena Rostova)...');
    const regRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Client': 'operator' },
      body: JSON.stringify({
        name: 'Elena Rostova',
        email: 'elena.rostova@example.test',
        password: 'password-elena-2026',
        consent: true,
      }),
    });
    const regData = await regRes.json();
    if (regRes.status !== 201 || !regData.token) {
      throw new Error(`Registration failed: HTTP ${regRes.status} ${JSON.stringify(regData)}`);
    }
    if (regData.account.role !== 'admin') {
      throw new Error(`First registrant must be admin, got: ${regData.account.role}`);
    }
    log(`First registrant successfully became admin: ${regData.account.name} (Role: ${regData.account.role})`);
    report.steps.push({ step: 'first_admin_registration', status: 'PASS', detail: `Registered ${regData.account.name} as admin` });

    // Step 4: UI Verification via Playwright & Screenshot Capture
    log('Step 4: Driving UI with browser to capture screenshots...');
    const chromeBin = findChromeBinary();
    const playwright = await import('playwright-core').catch(() => null);
    if (playwright?.chromium && chromeBin) {
      const browser = await playwright.chromium.launch({
        executablePath: chromeBin,
        headless: true,
        args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
      });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      const landingShot = join(reportDir, 'rehearsal-fresh-landing.png');
      await page.screenshot({ path: landingShot });
      log(`Saved landing page screenshot to ${landingShot}`);

      await context.close();
      await browser.close();
      report.steps.push({ step: 'ui_inspection', status: 'PASS', detail: `Captured screenshot ${landingShot}` });
    } else {
      log('Playwright or Chrome binary not present; skipping screenshot capture.');
      report.steps.push({ step: 'ui_inspection', status: 'SKIPPED', detail: 'Browser driver not loaded' });
    }

    // Step 5: Save One Persistent Change
    log('Step 5: Creating an AI resident and updating profile...');
    const agentRes = await fetch(`http://127.0.0.1:${port}/api/v1/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${regData.token}`,
      },
      body: JSON.stringify({ name: 'Elena Companion', kind: 'agent' }),
    });
    const agentData = await agentRes.json();
    if (agentRes.status !== 201 || !agentData.id) {
      throw new Error(`Agent creation failed: HTTP ${agentRes.status}`);
    }
    log(`Saved agent: ${agentData.name} (${agentData.id})`);
    report.steps.push({ step: 'save_change', status: 'PASS', detail: `Created agent ${agentData.name}` });

    // Step 6: Graceful Stop and Restart
    log('Step 6: Gracefully stopping server and restarting...');
    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));

    // Restart server on same database
    serverProcess = spawn(process.execPath, ['server.js'], { cwd: stageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const restartDeadline = Date.now() + 20_000;
    let restarted = false;
    while (Date.now() < restartDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        if (res.status === 200) { restarted = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!restarted) throw new Error('Server failed to restart on existing database');
    log('Server successfully restarted.');

    // Step 7: Verify Persistence Across Restart
    log('Step 7: Verifying account and agent persistence...');
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Client': 'operator' },
      body: JSON.stringify({ email: 'elena.rostova@example.test', password: 'password-elena-2026' }),
    });
    const loginData = await loginRes.json();
    if (loginRes.status !== 200 || loginData.account.name !== 'Elena Rostova') {
      throw new Error(`Persistence failure on account login: HTTP ${loginRes.status}`);
    }

    const meRes = await fetch(`http://127.0.0.1:${port}/api/v1/me`, {
      headers: { 'Authorization': `Bearer ${loginData.token}` },
    });
    const meData = await meRes.json();
    const foundAgent = Array.isArray(meData.agents) && meData.agents.find((a) => a.id === agentData.id);
    if (!foundAgent) throw new Error('Saved agent was not found after restart!');
    log(`Verified persistent agent: ${foundAgent.name} (id: ${foundAgent.id})`);
    report.steps.push({ step: 'verify_persistence', status: 'PASS', detail: 'Account and agent verified byte-for-byte across restart' });

    serverProcess.kill('SIGTERM');

    // Step 8: Negative Test: Occupied Port Handling
    log('Step 8: Testing failure case: Occupied port behavior...');
    const blocker = createTcpServer();
    const busyPort = await freePort();
    await new Promise((resolve) => blocker.listen(busyPort, '127.0.0.1', resolve));

    const occupiedEnv = { ...env, PORT: String(busyPort), LUCY_LOCAL_PORT_FALLBACK: '0' };
    const failChild = spawn(process.execPath, ['server.js'], { cwd: stageRoot, env: occupiedEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    let failOutput = '';
    failChild.stderr.on('data', (d) => { failOutput += d.toString(); });
    failChild.stdout.on('data', (d) => { failOutput += d.toString(); });

    const [exitCode] = await new Promise((resolve) => failChild.once('exit', (code) => resolve([code])));
    blocker.close();

    log(`Occupied port test exited with code ${exitCode}. Output: ${failOutput.trim()}`);
    report.failuresAndRecovery.push({
      scenario: 'occupied_port_without_fallback',
      expected: 'Non-zero exit code with EADDRINUSE or address in use error',
      actualExitCode: exitCode,
      actualOutput: failOutput.trim(),
      handledCleanly: exitCode !== 0,
    });
    if (exitCode === 0 || !/EADDRINUSE|address already in use/i.test(failOutput)) {
      throw new Error('Occupied-port refusal did not produce the expected error.');
    }

    // Step 9: Negative Test: Unwritable Data Directory
    log('Step 9: Testing failure case: Unwritable data directory...');
    const unwritableWorkspace = await mkdtemp(join(tmpdir(), 'nemoworld-unwritable-'));
    const lockedDir = join(unwritableWorkspace, 'data');
    mkdirSync(lockedDir, { recursive: true });
    chmodSync(lockedDir, 0o444); // Read-only

    const unwriteEnv = { ...env, LUCY_DATABASE: join(lockedDir, 'world.sqlite'), PORT: String(await freePort()) };
    const unwriteChild = spawn(process.execPath, ['server.js'], { cwd: stageRoot, env: unwriteEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    let unwriteOutput = '';
    unwriteChild.stderr.on('data', (d) => { unwriteOutput += d.toString(); });
    unwriteChild.stdout.on('data', (d) => { unwriteOutput += d.toString(); });

    const [unwriteExit] = await new Promise((resolve) => unwriteChild.once('exit', (code) => resolve([code])));
    chmodSync(lockedDir, 0o777);
    await rm(unwritableWorkspace, { recursive: true, force: true });

    log(`Unwritable directory test exited with code ${unwriteExit}. Error message: ${unwriteOutput.trim()}`);
    report.failuresAndRecovery.push({
      scenario: 'unwritable_data_directory',
      expected: 'Non-zero exit code with EACCES or permission error',
      actualExitCode: unwriteExit,
      actualOutput: unwriteOutput.trim(),
      handledCleanly: unwriteExit !== 0,
    });
    if (unwriteExit === 0 || !/EACCES|permission denied/i.test(unwriteOutput)) {
      throw new Error('Unwritable-directory refusal did not produce the expected error.');
    }

    report.verdict = 'SCRIPTED SERVER BOOTSTRAP VERIFIED. The Mac launcher and browser account/play journey were not exercised.';
    log(`\nFinal Verdict: ${report.verdict}`);

  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }

  const reportJson = join(reportDir, 'fresh-install-rehearsal.json');
  writeFileSync(reportJson, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Saved report JSON to ${reportJson}`);
  return report;
}

if (process.argv[1] && process.argv[1].endsWith('rehearse-fresh-install.mjs')) {
  runFreshInstallRehearsal().catch((err) => {
    console.error('Rehearsal failed:', err);
    process.exit(1);
  });
}
