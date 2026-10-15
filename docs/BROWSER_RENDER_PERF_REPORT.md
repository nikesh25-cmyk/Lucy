# NemoWorld Client Rendering Performance Report

**Task:** AG-02 (Repair of held A3)  
**Date:** 15 October 2026  
**Commit:** `9df194e` on `review/antigravity-2026-10-15` (incorporating visual slice 1 merge)  
**Hardware Profile:**  
- **Host:** Apple M5 (10 cores, ARM64)  
- **OS:** macOS Darwin 25.6.0  
- **Memory:** 16.0 GB  
- **Browser:** Google Chrome (Chromium headless channel via Playwright, hardware acceleration with swiftshader safety fallback)  
- **Server:** Isolated Node child process on ephemeral port with disposable SQLite database  

---

## 1. Executive Summary & Methodology

The prior held A3 submission sampled an anonymous landing page canvas, lacked scene warmup, counted a fixed sleep duration as movement latency, and made unsubstantiated percentage improvement claims without an objective baseline.

This repaired performance evaluation (AG-02):
1. **Signed-in Player Journey:** Authenticates a real account, enters the world in first person through the game's authoritative `Play` action, selects the human avatar, and waits for reticle alignment.
2. **Post-Warmup Frame Sampling:** Enforces a 1,000 ms warmup period after scene entry before sampling 120 consecutive frames via `requestAnimationFrame` to isolate active rendering from initial asset decompression.
3. **Confirmed Movement Latency (5 Steps):** Measures roundtrip latency from physical keyboard dispatch (`ArrowRight`, `ArrowLeft`, `ArrowUp`, `ArrowDown`) to:
   - Server-side SQLite persistence in the `agents` table (`inputToServerDbMs`).
   - Client-side canvas reticle coordinate update (`inputToRenderedMs`).
4. **Second Client Observed Update:** Connects a second signed-in player instance (`observer@perf.test`) subscribed to the live Server-Sent Events (`/api/v1/events?world_id=commons`) feed and measures elapsed time until the first player's new position is reflected in the observer's world state.
5. **Full Matrix:** Evaluates 4 matrix quadrants: Desktop (1280×800) vs Phone (390×844) viewports under Normal vs Reduced (`prefers-reduced-motion`) motion.
6. **No Speculative Renderer Edits:** Zero renderer modifications were made while Claude's visual branch was in flight.

---

## 2. Measurement Summary Matrix

| Configuration | Viewport | Motion | Time to Enter Scene | Median Frame Delta | p95 Frame Delta | Approx FPS | Input → Server DB (Median / p95) | Input → Rendered (Median / p95) | 2nd Client Observation Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Desktop Normal** | 1280×800 | Normal | 1,326 ms | **33.3 ms** | **33.4 ms** | 30.3 FPS | **13.0 ms** / 22.0 ms | **28.0 ms** / 60.0 ms | **85 ms** |
| **Desktop Reduced** | 1280×800 | Reduced | 1,272 ms | **33.3 ms** | **33.4 ms** | 30.4 FPS | **13.0 ms** / 13.0 ms | **29.0 ms** / 64.0 ms | **93 ms** |
| **Phone Normal** | 390×844 | Normal | 1,257 ms | **33.3 ms** | **33.4 ms** | 30.3 FPS | **13.0 ms** / 16.0 ms | **52.0 ms** / 71.0 ms | **87 ms** |
| **Phone Reduced** | 390×844 | Reduced | 1,280 ms | **33.3 ms** | **33.4 ms** | 30.3 FPS | **14.0 ms** / 22.0 ms | **27.0 ms** / 62.0 ms | **86 ms** |

---

## 3. Key Observations & Findings

1. **30 FPS Render Lock:**
   - The game engine consistently locks to a stable ~30 FPS frame cadence (median frame time `33.3 ms`, p95 `33.4 ms`) across both desktop and 390 px mobile viewports. Frame pacing jitter is negligible after the initial 1s warmup.
2. **Server Movement Roundtrip:**
   - Movement from client keyboard input to authoritative SQLite database persistence completes in **13–14 ms median** (p95 `13–22 ms`).
   - The full visual loop—from keyboard keydown through server acknowledgment to client reticle position update—completes in **27–52 ms median** (p95 `60–71 ms`).
3. **Multiplayer Observer Latency:**
   - A second signed-in client observing the same Commons world receives the live SSE delta and reconciles the moving player's coordinates within **85–93 ms**, confirming responsive multiplayer presence without polling lag.
4. **Mobile (390 px) Touch & HUD Performance:**
   - On the 390 px mobile viewport, time-to-enter-world is **1,257 ms**, comparable to desktop (**1,326 ms**).
   - Reduced motion mode lowers input-to-render latency on mobile from 52 ms to 27 ms by bypassing non-essential transitions.

---

## 4. Preserved Artifacts

- **Raw Metrics:** `docs/perf/render-performance-results.json`
- **Scene Captures:**
  - `docs/perf/screenshots/perf-desktop-normal-motion.png`
  - `docs/perf/screenshots/perf-desktop-reduced-motion.png`
  - `docs/perf/screenshots/perf-phone-normal-motion.png`
  - `docs/perf/screenshots/perf-phone-reduced-motion.png`
