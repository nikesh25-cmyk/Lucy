#!/usr/bin/env node
// Browser rendering performance recorder for NemoWorld.
// Measures client frame times, long tasks, memory, confirmed movement latency,
// and second-client observation latency in a real signed-in game scene.
//
// Matrix:
// - Viewports: Desktop (1280x800), Phone (390x844)
// - Motion: Normal, Reduced (prefers-reduced-motion)
// - Server: Isolated process on disposable temporary SQLite database
// - Client: Real Chrome build driven via playwright-core

import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, release, cpus, totalmem } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PERF_DIR = join(ROOT, 'docs', 'perf');
const SCREENSHOTS_DIR = join(PERF_DIR, 'screenshots');
const PASSWORD = 'perf-test-password-2026';

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

function calculatePercentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function calculateStats(numbers) {
  if (!numbers.length) return { median: 0, p95: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...numbers].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const mean = Number((sum / sorted.length).toFixed(2));
  const min = Number(sorted[0].toFixed(2));
  const max = Number(sorted[sorted.length - 1].toFixed(2));
  const median = calculatePercentile(sorted, 50);
  const p95 = calculatePercentile(sorted, 95);
  return { median, p95, min, max, mean, count: sorted.length };
}

async function startIsolatedServer(cwd) {
  const port = await freePort();
  const tempWorkspace = await mkdtemp(join(tmpdir(), 'nemoworld-perf-'));
  const databasePath = join(tempWorkspace, 'world.sqlite');

  const env = {
    ...process.env,
    PORT: String(port),
    LUCY_DATABASE: databasePath,
    LUCY_BIND_HOST: '127.0.0.1',
    LUCY_OPEN_BROWSER: '0',
  };
  delete env.LUCY_PUBLIC_ORIGIN;
  delete env.RENDER_EXTERNAL_URL;

  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited unexpectedly with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    child.kill('SIGTERM');
    await rm(tempWorkspace, { recursive: true, force: true });
    throw new Error('Server failed to reach health 200 within 30s');
  }

  return {
    port,
    child,
    databasePath,
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
      await rm(tempWorkspace, { recursive: true, force: true });
    },
  };
}

async function setupFixtures(baseUrl) {
  // 1. Register admin account
  const adminRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Client': 'operator' },
    body: JSON.stringify({ name: 'Admin Operator', email: 'admin@perf.test', password: PASSWORD, consent: true }),
  });
  const admin = await adminRes.json();

  // 2. Create human player character under admin
  const charRes = await fetch(`${baseUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admin.token}` },
    body: JSON.stringify({ kind: 'human', name: 'Perf Player', color: '#3d5875', symbol: '◆', capabilities: 'Walks', limitations: 'None' }),
  });
  const player = await charRes.json();

  // 3. Create observer account with invite from admin
  const inviteRes = await fetch(`${baseUrl}/api/v1/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${admin.token}` },
    body: JSON.stringify({ role: 'member' }),
  });
  const invite = await inviteRes.json();

  const obsRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Client': 'operator' },
    body: JSON.stringify({ name: 'Observer Operator', email: 'observer@perf.test', password: PASSWORD, consent: true, invite: invite.code }),
  });
  const observer = await obsRes.json();

  const obsCharRes = await fetch(`${baseUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${observer.token}` },
    body: JSON.stringify({ kind: 'human', name: 'Observer Player', color: '#8c6ab1', symbol: '▲', capabilities: 'Watches', limitations: 'None' }),
  });
  const observerPlayer = await obsCharRes.json();

  return { admin, player, observer, observerPlayer };
}

export async function runPerformanceSuite(options = {}) {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const targetDir = options.targetDir || ROOT;
  console.log(`Starting isolated server in ${targetDir}...`);
  const server = await startIsolatedServer(targetDir);
  const db = new DatabaseSync(server.databasePath, { readOnly: true });

  let browser = null;
  const testResults = [];

  const hardwareInfo = {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model || 'Unknown',
    totalMemoryGB: Number((totalmem() / (1024 ** 3)).toFixed(1)),
  };

  try {
    const { player } = await setupFixtures(server.baseUrl);

    console.log(`Launching Chrome browser...`);
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox'],
    });

    const matrix = [
      { id: 'desktop-normal-motion', name: 'Desktop (1280x800) - Normal Motion', viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' },
      { id: 'desktop-reduced-motion', name: 'Desktop (1280x800) - Reduced Motion', viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' },
      { id: 'phone-normal-motion', name: 'Phone (390x844) - Normal Motion', viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' },
      { id: 'phone-reduced-motion', name: 'Phone (390x844) - Reduced Motion', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' },
    ];

    for (const config of matrix) {
      console.log(`\n--- Measuring: ${config.name} ---`);
      const context = await browser.newContext({
        viewport: config.viewport,
        reducedMotion: config.reducedMotion,
      });

      const page = await context.newPage();

      // Inject performance observer for long tasks
      await page.addInitScript(() => {
        window.__perfMetrics = {
          longTasks: [],
        };
        if ('PerformanceObserver' in window) {
          try {
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__perfMetrics.longTasks.push({
                  duration: entry.duration,
                  startTime: entry.startTime,
                });
              }
            });
            observer.observe({ entryTypes: ['longtask'] });
          } catch {}
        }
      });

      // 1. Navigate to home
      const navStart = Date.now();
      await page.goto(`${server.baseUrl}/`, { waitUntil: 'domcontentloaded' });

      // 2. Sign in as Admin
      await page.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.locator('#auth-dialog').waitFor({ state: 'visible' });
      const form = page.locator('#auth-area section:not([hidden]) form');
      await form.locator('[aria-label="Email"]').fill('admin@perf.test');
      await form.locator('[aria-label="Password"]').fill(PASSWORD);
      await form.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: 15_000 });

      // 3. Enter signed-in world via Play button
      const playButton = page.locator('#hero-actions').getByRole('button', { name: 'Play', exact: true });
      await playButton.waitFor({ state: 'visible' });
      await playButton.click();

      // Wait for world canvas and reticle
      await page.locator('#world').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForFunction(
        (id) => window.__nemoworld?.selected?.() === id && (document.querySelector('#world-reticle')?.textContent || '').includes('at '),
        player.id,
        { timeout: 20_000 }
      );
      const timeToEnterMs = Date.now() - navStart;

      // 4. Warmup period (1000ms) to allow scene textures/shaders to stabilize
      await page.waitForTimeout(1000);

      // 5. Sample 120 consecutive animation frames
      const frameData = await page.evaluate(async () => {
        return new Promise((resolve) => {
          const deltas = [];
          let lastTime = null;
          let sampleStartTime = null;

          function sample(now) {
            if (lastTime === null) {
              lastTime = now;
              sampleStartTime = now;
              requestAnimationFrame(sample);
              return;
            }
            deltas.push(now - lastTime);
            lastTime = now;
            if (deltas.length < 120) {
              requestAnimationFrame(sample);
            } else {
              const mem = window.performance?.memory ? {
                usedJSHeapSizeMB: Number((window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)),
                totalJSHeapSizeMB: Number((window.performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)),
              } : null;

              resolve({
                deltas,
                sampleStartTime,
                memory: mem,
                longTasks: window.__perfMetrics?.longTasks || [],
              });
            }
          }
          requestAnimationFrame(sample);
        });
      });

      const frameStats = calculateStats(frameData.deltas);
      const over50msIntervals = frameData.deltas.filter((d) => d > 50).length;
      const longTasksAfterWarmup = frameData.longTasks.filter((t) => t.startTime >= frameData.sampleStartTime);
      const longTaskStats = calculateStats(longTasksAfterWarmup.map((t) => t.duration));

      // 6. Confirmed Movement Latency (5 iterations)
      // Automation key dispatch -> Server SQLite stored tile -> reticle text update.
      const movementSamples = [];
      await page.locator('#world').focus();

      for (let i = 0; i < 5; i++) {
        const beforeRow = db.prepare('SELECT x, y FROM agents WHERE id=?').get(player.id);
        let t0 = null;
        let tDb = null;
        let tReticle = null;
        let successfulKey = null;

        for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
          t0 = Date.now();
          await page.keyboard.press(key);

          const dbDeadline = Date.now() + 400;
          while (Date.now() < dbDeadline) {
            const cur = db.prepare('SELECT x, y FROM agents WHERE id=?').get(player.id);
            if (cur.x !== beforeRow.x || cur.y !== beforeRow.y) {
              tDb = Date.now();
              successfulKey = key;
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          if (tDb) break;
        }

        if (!tDb) {
          console.warn(`Movement step ${i} did not find an open adjacent tile`);
          continue;
        }

        const afterRow = db.prepare('SELECT x, y FROM agents WHERE id=?').get(player.id);

        await page.waitForFunction(
          ([x, y]) => (document.querySelector('#world-reticle')?.textContent || '').includes(`at ${x}, ${y}`),
          [afterRow.x, afterRow.y],
          { timeout: 2000 }
        );
        tReticle = Date.now();

        movementSamples.push({
          step: i + 1,
          direction: successfulKey,
          inputToServerDbMs: tDb - t0,
          inputToReticleMs: tReticle - t0,
        });

        await page.waitForTimeout(100);
      }

      const inputToDbStats = calculateStats(movementSamples.map((s) => s.inputToServerDbMs));
      if (!movementSamples.length) throw new Error(`No persisted movement in ${config.id}`);
      const inputToReticleStats = calculateStats(movementSamples.map((s) => s.inputToReticleMs));

      // 7. Second Client Observed Update
      // Client 2 signs in as observer and enters the world to open live SSE subscription
      const observerContext = await browser.newContext({ viewport: config.viewport });
      const observerPage = await observerContext.newPage();
      await observerPage.goto(`${server.baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await observerPage.locator('#session-bar').getByRole('button', { name: 'Sign in', exact: true }).click();
      await observerPage.locator('#auth-dialog').waitFor({ state: 'visible' });
      const obsForm = observerPage.locator('#auth-area section:not([hidden]) form');
      await obsForm.locator('[aria-label="Email"]').fill('observer@perf.test');
      await obsForm.locator('[aria-label="Password"]').fill(PASSWORD);
      await obsForm.getByRole('button', { name: 'Sign in', exact: true }).click();
      await observerPage.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: 15_000 });

      const obsPlay = observerPage.locator('#hero-actions').getByRole('button', { name: 'Play', exact: true });
      await obsPlay.waitFor({ state: 'visible' });
      await obsPlay.click();
      await observerPage.locator('#world').waitFor({ state: 'visible', timeout: 20_000 });
      await observerPage.waitForTimeout(500);

      // Now move player in Client 1 and time when Client 2 receives the update
      await page.locator('#world').focus();
      const posBefore = db.prepare('SELECT x, y FROM agents WHERE id=?').get(player.id);
      let tMove1 = Date.now();

      for (const key of ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft']) {
        tMove1 = Date.now();
        await page.keyboard.press(key);
        const moveDeadline = Date.now() + 400;
        while (Date.now() < moveDeadline) {
          const posAfter = db.prepare('SELECT x, y FROM agents WHERE id=?').get(player.id);
          if (posAfter.x !== posBefore.x || posAfter.y !== posBefore.y) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        const posAfter = db.prepare('SELECT x, y FROM agents WHERE id=?').get(player.id);
        if (posAfter.x !== posBefore.x || posAfter.y !== posBefore.y) break;
      }

      const currentPos = db.prepare('SELECT x, y FROM agents WHERE id=?').get(player.id);
      if (currentPos.x === posBefore.x && currentPos.y === posBefore.y) throw new Error(`Observer step did not persist in ${config.id}`);
      let tObsMoved = null;
      const obsDeadline = Date.now() + 5000;
      while (Date.now() < obsDeadline) {
        const obsSeen = await observerPage.evaluate((id) => {
          const presenceList = window.__nemoworld?.presence?.() || [];
          const match = presenceList.find((p) => p.id === id);
          if (match?.confirmed) return { x: match.confirmed.x, y: match.confirmed.y };
          const participants = window.__nemoworld?.world?.()?.participants || [];
          const pMatch = participants.find((p) => p.id === id);
          return pMatch ? { x: pMatch.x, y: pMatch.y } : null;
        }, player.id);

        if (obsSeen && obsSeen.x === currentPos.x && obsSeen.y === currentPos.y) {
          tObsMoved = Date.now();
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (!tObsMoved) throw new Error(`Observer did not show stored movement in ${config.id}`);
      const observerUpdateLatencyMs = tObsMoved - tMove1;
      await observerContext.close();

      // 8. Capture scene screenshot
      const screenshotFile = `perf-${config.id}.png`;
      const screenshotPath = join(SCREENSHOTS_DIR, screenshotFile);
      await page.screenshot({ path: screenshotPath });

      await context.close();

      const resultEntry = {
        configId: config.id,
        configName: config.name,
        viewport: config.viewport,
        reducedMotion: config.reducedMotion,
        timeToEnterWorldMs: timeToEnterMs,
        frames: {
          sampled: frameData.deltas.length,
          medianDeltaMs: frameStats.median,
          p95DeltaMs: frameStats.p95,
          minDeltaMs: frameStats.min,
          maxDeltaMs: frameStats.max,
          meanDeltaMs: frameStats.mean,
          intervalsOver50ms: over50msIntervals,
          observedRafHz: Number((1000 / frameStats.mean).toFixed(1)),
        },
        longTasks: {
          count: longTasksAfterWarmup.length,
          medianDurationMs: longTaskStats.median,
          p95DurationMs: longTaskStats.p95,
          maxDurationMs: longTaskStats.max,
        },
        movementLatency: {
          samples: movementSamples,
          inputToServerDbMedianMs: inputToDbStats.median,
          inputToServerDbP95Ms: inputToDbStats.p95,
          inputToReticleMedianMs: inputToReticleStats.median,
          inputToReticleP95Ms: inputToReticleStats.p95,
        },
        secondClientObservedUpdateMs: observerUpdateLatencyMs,
        memory: frameData.memory,
        screenshot: relative(ROOT, screenshotPath),
      };

      testResults.push(resultEntry);

      console.log(`  Browser rAF: ~${resultEntry.frames.observedRafHz} Hz (Median interval: ${resultEntry.frames.medianDeltaMs}ms, p95: ${resultEntry.frames.p95DeltaMs}ms)`);
      console.log(`  Movement (Input -> Server DB): Median ${resultEntry.movementLatency.inputToServerDbMedianMs}ms, p95 ${resultEntry.movementLatency.inputToServerDbP95Ms}ms`);
      console.log(`  Movement (Input -> Reticle): Median ${resultEntry.movementLatency.inputToReticleMedianMs}ms, p95 ${resultEntry.movementLatency.inputToReticleP95Ms}ms`);
      console.log(`  2nd Client Observed Update: ${resultEntry.secondClientObservedUpdateMs}ms`);
    }

    const payload = {
      timestamp: new Date().toISOString(),
      hardware: hardwareInfo,
      targetCommit: options.commit || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8' }).trim(),
      results: testResults,
    };

    const outputPath = join(PERF_DIR, 'render-performance-results.json');
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\nRaw performance data written to: ${outputPath}`);

    return payload;
  } finally {
    if (browser) await browser.close();
    db.close();
    await server.cleanup();
  }
}

if (process.argv[1] && process.argv[1].endsWith('record-render-perf.mjs')) {
  runPerformanceSuite().catch((err) => {
    console.error('Performance recording failed:', err);
    process.exit(1);
  });
}
