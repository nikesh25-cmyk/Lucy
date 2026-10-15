# NemoWorld CI Gate — Local Reproduction & Setup Guide

**Task ID:** A1 — Continuous integration gate  
**Base Commit:** `27c0d72`  
**Branch:** `agy/a1-ci-gate`  
**Status:** Core Gate **Verified Locally** · Chrome Browser Suite **Configured, Not Verified** on GitHub Actions  

---

## 1. Overview & Architecture

The repository enforces a zero-dependency production architecture (Node.js >= 24.0.0, built-in SQLite via `node:sqlite`, and standard web technologies).

The GitHub Actions CI pipeline is declared in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and is partitioned into two distinct jobs:

1. **`core-verification` (Zero-Dependency Gate)**:
   - Requires only Node.js 24.
   - Runs syntax validation, content integrity sealing, unit/integration suites, and full HTTP end-to-end smoke tests.
   - Requires zero `npm install` / `node_modules` downloads.
2. **`chrome-browser-acceptance` (Browser Suite Gate)**:
   - Installs declared devDependency (`playwright-core`).
   - Drives system Google Chrome / Chromium in headless mode.
   - Uploads no test artifacts. Failure output remains in the GitHub Actions job log, which still requires careful review before sharing.

---

## 2. Local Reproduction Commands

### Job 1: Core Verification Gate
Execute the following commands in sequence from repository root:

```bash
# 1. Verify ES module syntax across all JavaScript files
node scripts/check-syntax.mjs

# 2. Verify sealed content definitions (blocks, cosmetics, appearances, crops, furniture)
node scripts/seal-content.mjs --check

# 3. Execute unit and integration test suite
node --test

# 4. Execute HTTP API end-to-end smoke suite (20 scenarios on disposable server & database)
node scripts/e2e-smoke.mjs
```

**Local Execution Evidence (Darwin arm64, Node v24.19.0):**
- Syntax check: `checked 100 files, 0 failed`.
- Content seal check: `Verified: 98 definitions (20 appearance, 9 block, 32 cosmetic, 6 crop, 31 furniture); 3 support files; 42 referenced notices and assets`.
- E2E smoke suite: `SUMMARY 20 steps passed, 0 failed`.

---

### Job 2: Chrome Browser Acceptance Gate

```bash
# 1. Install declared devDependencies only
npm ci

# 2. Run the browser acceptance suite with system Chrome
npm run browser

# 3. For focused scenario testing:
LUCY_BROWSER_ONLY=hero-introduction-film npm run browser

```

**CI Status & Hardware Constraints:**
- **Status:** **Configured, not verified** on live GitHub Actions infrastructure.
- **Limitation Notice:** The full browser acceptance suite covers 3D rendering, first-person controls, multi-tab presence and keyboard locomotion. Its scenario count can change. The workflow has not been run on GitHub Actions, so Chrome availability and timing there remain unverified. It sets a 25-minute job timeout and uploads no artifacts.

---

## 3. Artifact Safety

The workflow uploads no screenshots, databases or test-result files. This avoids relying on a regex redactor to clear arbitrary logs or image pixels. GitHub Actions job output can still contain diagnostic data and must be reviewed before sharing.
