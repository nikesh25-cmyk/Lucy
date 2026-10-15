# NemoWorld browser interaction measurement

**Recorded:** 15 October 2026, on source commit `2428bc5` plus the recorder corrections in this integration branch. Apple M5, 16 GB RAM, macOS Darwin 25.6.0; headless Chrome and one isolated Node server with a disposable SQLite database. The raw file is [render-performance-results.json](perf/render-performance-results.json), with four scene screenshots in [screenshots](perf/screenshots/).

This is a single exploratory run, not a renderer benchmark or a launch capacity claim. The browser entered through the signed-in Play action. For each viewport/motion setting, the recorder collected 120 consecutive **browser `requestAnimationFrame` intervals**, five persisted keyboard moves, and one second-client position observation.

| Setting | Entry from navigation | Median / p95 rAF interval | Key dispatch to DB median / max | Key dispatch to reticle median / max | Second-client position observed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Desktop, normal | 3370 ms | 16.7 / 16.8 ms | 22 / 199 ms | 83 / 341 ms | 40 ms |
| Desktop, reduced motion | 2008 ms | 16.7 / 16.8 ms | 16 / 16 ms | 40 / 44 ms | 223 ms |
| 390 px phone, normal | 2119 ms | 16.7 / 16.7 ms | 19 / 61 ms | 61 / 165 ms | 118 ms |
| 390 px phone, reduced motion | 7713 ms | 16.7 / 16.8 ms | 14 / 17 ms | 30 / 41 ms | 42 ms |

All 20 movement samples reached a changed SQLite coordinate and matching reticle text. Each second-client sample reached the saved coordinate; it was timed by polling the second client's exposed world/presence state. This does **not** isolate SSE delivery from browser processing or measure the rendered canvas pixels. `requestAnimationFrame` cadence is **not renderer FPS**; the renderer can skip a frame while rAF continues. A 390 px viewport with keyboard automation does not measure touch responsiveness.

The five-sample maximum is shown instead of a stable p95 estimate. The settings ran sequentially in one browser/server process, with no repeated trials or randomized order. The long entry time for phone reduced motion and the desktop-normal outlier show run variability. These numbers cannot establish a reduced-motion speed improvement or a production performance budget. The recorder is reusable for a larger repeated experiment, including actual canvas instrumentation, if those claims become necessary.
