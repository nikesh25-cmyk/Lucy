# Task B wave — the local input-to-confirmed-step latency instrument

The first step the brief asks for before any movement redesign is a way to *see* the latency it is
about. The browser acceptance suite already measured cross-client propagation (a click reaching the
**other** browser's view, in `shared-presence-two-clients`). It did not measure the interval movement
work is judged against: **one local input to the authoritative server confirming that step**. This is
that instrument. It reports; it does not gate.

- Scenario: `movement-latency`, registered in `scripts/browser-suite.mjs` (suite is now 40 scenarios)
- Run it alone: `LUCY_BROWSER_ONLY=movement-latency npm run browser`
- Files changed: `scripts/browser-suite.mjs`, `tests/browser-suite.test.js` (registry count 39 → 40)
- No product code was touched: `app.js`, `server.js`, `src/**`, `native/**` and every other test are
  unchanged, as are `package.json`, `HANDOFF.md`, `docs/VERIFICATION.md` and `outputs/Lucy`.

## What exactly is measured

**The confirmation event is the accessible aim line.** `#world-reticle` is a `role="status"` paragraph
whose text names the tile the client holds, in the form `… · at 12, 5, layer 0 · …`. The client only
ever holds the server's tile: `performMove` awaits `POST /api/v1/move`, applies the stored position,
re-reads the world with `GET /api/v1/world` and only then repaints the aim line (`app.js`). The live
world feed can deliver the same stored tile through the event channel, which is still the server's
committed record. So:

```
sample = t1 − t0
t0 = performance.now() immediately before the movement input
t1 = the moment the aim line names the tile the plan expects, taken in the MutationObserver
     microtask that follows the paint which applied it
```

This is **input → confirmed step**, not input → optimistic paint. There is **no optimistic paint on
this path at all**: the first tile the interface can name is the server's, which is why the note says
so rather than reporting a second "optimistic" figure that does not exist. The interval contains two
loopback requests (`POST /api/v1/move`, then the world read the client paints from), and the note
splits the figure into those parts so a reader can see how much of it is the server answering and how
much is the interface catching up.

## How it is timed

**Entirely inside one `page.evaluate`.** No Node ↔ browser round trip sits inside any measured
interval: the loop, the presses, the confirmation watcher and the per-step readings all run in the
page. Nothing is asserted or reported from a CDP call in the timed path.

- **The input** is a click on the shipped movement control `#view button[aria-label="Move up|left|down|right"]`
  — the same control `first-person-controls` already drives — issued with `element.click()` inside the
  page. When the workspace has rendered that control **disabled**, a disabled control silently refuses
  `click()`, so the walk key (`w`/`a`/`s`/`d`) is dispatched on the page instead: one keydown handler in
  `app.js` turns either into the same view-relative grid step, and each sample records which of the two
  carried it. Neither medium involves CDP input synthesis.
- **First person, relative steps.** The walk is planned as a route of world-cardinal steps with the
  app's own `planWalk`, then translated through the resident's stored yaw with the same
  `cameraWalkDirection` the client uses for a first-person control. The aim line's own `facing …` label
  is checked against that yaw first, so a translation could not silently walk the wrong way.
- **The route is an out-and-back loop**: 12 single-tile steps out and the same 12 back, 24 consecutive
  confirmed single-tile steps in total, ending on the tile it started from. Walking a resident 24 tiles
  away and leaving it there changed what a later scenario shared (the server's observation window is
  only 20 × 14 tiles, so a resident parked outside it is invisible to the second browser in
  `shared-presence-two-clients`). An instrument must not edit the fixture it measures in.
- **Pacing.** Inputs are spaced 400 ms apart **measured from the previous movement request's own send
  time** (from resource timing), not from the previous press. The shipped client holds motion requests
  160 ms apart *after* the press it belongs to and the server refuses a second step inside 120 ms, so
  pacing from the press alone let the client's own hold push a request late and leave the next one
  inside the server's refusal window. The margin covers the server's own processing jitter. The
  per-step "request left the page" figure in the note is the evidence that the pacing held (≈1–3 ms).
- **An independent server read per step.** After the interval is timed, the page fetches
  `GET /api/v1/world` for the resident and records where the server itself says it stands. No camera
  hint is passed: a hint would move the 20 × 14 observation window off the very resident being read.

## What it asserts (and what it deliberately does not)

Deterministic, therefore asserted:

- Every one of the 24 steps is confirmed: the aim line names exactly the planned tile, in order, one
  tile at a time, from the tile the aim line last named — no step lost, no step doubled.
- The server's own record names the same tile for that step.
- Exactly one movement request per press (measured presses plus any press the server's own throttle
  refused and the instrument re-issued): nothing dropped, nothing doubled.
- The resident ends on the tile it started from, still `active`, in the same world.

**Not asserted: any latency budget.** The figures are printed in the run's notes and in the step line
so two runs can be compared; a slow run does not fail the suite. The only ceiling is a clearly-marked
sanity bound (`MOVEMENT_LATENCY_CONFIRM_TIMEOUT_MS = 15_000`): a step the interface never confirms
means the instrument lost a step, not that the world was slow. It is ~150× the figures measured here.

## The numbers

Both runs are full `npm run browser` runs on this machine's final code. They differ by an order of
magnitude, and that difference is the most important thing on this page.

| run | route | n | min | median | p95 | max | input → POST /move answered (median) | answer → aim line (median) | refused by the server's throttle | load average at the end |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| final run 1 (40/40 pass) | The Commons, 12 × E out and 12 back from 10,5 | 24 | 17.2 ms | **106.4 ms** | 385.3 ms | 412.9 ms | 51.6 ms | 44.6 ms | 0 | 31.5 / 34.1 / 37.4 |
| final run 2 (browser process died at scenario 13; the instrument passed) | The Commons, 12 × E out and 12 back from 10,5 | 24 | 5.0 ms | **11.8 ms** | 23.4 ms | 27.5 ms | 2.8 ms | 9.4 ms | 0 | 22.3 / 28.3 / 33.2 |
| 6 isolated runs of the instrument, back to back | same | 24 | 4.4–9.1 ms | 15.3, 15.5, 16.0, 15.7, 16.6, 29.0 ms | 22.3–175.7 ms | 23.0–186.2 ms | 2.5–3.9 ms | 7.1–10.3 ms | 0 | not recorded then (the same other work was running) |
| the first isolated run of the instrument, before the pacing fix | same | 24 | 3.5 ms | 9.0 ms | 11.6 ms | 22.1 ms | 2.9 ms | 6.1 ms | 0 | not recorded then |

Same code, same route, same machine: **median 11.8 ms in one run and 106.4 ms in the next**, tracking
the load average (22 vs 32 on 10 cores — this machine is running the user's own work, including a
browser and a code agent, throughout). All 24 steps were confirmed in both runs. The instrument's job
was to make that difference visible, and it does.

**Hardware and environment measured on** (named by the note itself, read at run time, plus `sysctl`
for the model identifier): Apple M5 (`Mac17,3`), 10 cores, 16 GB, macOS 26.6.2 (build 25G83), arm64,
kernel 25.6.0 — **loopback HTTP, headless Chrome 155, one server process, one SQLite writer, no
network, and no other client on the resident being measured**.

## What these numbers do not claim

- They are **not a supported-user or real-device latency claim**. There is no network, no TLS, no
  proxy, no phone, no thermal budget and no other player in the interval.
- They are **not a lower bound for a real deployment**, only a lower bound on the *network portion*:
  the loopback round trip is far cheaper than any real one. The rest of the interval (server handling,
  the world read, the paint) can be larger on a real device, and the machine's own load here already
  made it 9× larger than in the best run.
- They are **not a per-frame or per-pixel number**: `t1` is when the DOM text changed (the mutation
  microtask), not when the new text was composited to the screen. Compositing adds at least one frame.
- They are **not a distribution**: 24 samples can characterise a median and a rough p95, not a tail.
- The p95 of a 24-sample run is the 23rd value; read it as "the slowest few of this run", not as a
  service-level figure.
- A `429` from the server's own movement throttle would mean an input never became a step. Such a
  press is re-issued and **reported** in the note; it is never counted as a sample. In the two runs
  above neither had any.

## What would make me distrust these numbers

- **Machine load.** Demonstrated above: 22 → 32 load average moved the median from 11.8 ms to
  106.4 ms. Any figure from this instrument needs the load average in its note, which it prints.
- **A refused input that the retry hides.** The note counts them; if that count is ever non-zero, the
  sample set is still clean (each refusal is re-issued and re-timed from its own press), but the run
  says so. A count that keeps growing means the pacing assumption is wrong, not that the world is slow.
- **A step confirmed without a movement request.** The scenario asserts one request per press, so a
  confirmation from nowhere would fail rather than be reported as a suspiciously fast sample.
- **The walk key carrying many samples.** It is the same handler and the same step, but it is a
  different input medium; the note reports the split. Every run above was 24/24 by the movement
  control except a few isolated runs where the workspace's own control was found disabled once or
  twice (reported in the note's `inputs:` clause).
- **A moved fixture.** If the loop ever fails to return the resident to its starting tile the
  scenario fails; that is also what keeps this scenario from disturbing its neighbours.
- **Tail latency under contention.** One full run's browser process was killed by the machine mid-run
  (`Target page, context or browser has been closed` in scenario 13 onward, with 13 scenarios already
  passing). On a memory-starved machine, a full-suite run is not a clean measurement environment;
  the instrument's own steps were fine in that run.

## Verification of this change

- `npm run check` — passes (it runs `node --check` on `scripts/browser-suite.mjs` among the rest).
- `npm test` — 875 tests, 875 pass, 0 fail (the registry count assertion in
  `tests/browser-suite.test.js` now expects 40 scenarios).
- `npm run e2e` — 17 steps passed, 0 failed (untouched by this change).
- `npm run browser` — 40 of 40 scenarios passed in the run recorded above; the suite's guarantees
  held in that run (server stopped, process lock released, temporary workspace removed, shipped
  `data/world.sqlite` untouched), and the temporary-database, production-database-refusal and
  teardown-on-failure behaviour is unchanged.

## What building the instrument surfaced

1. **The workspace can render its own movement control disabled.** `#view`'s movement buttons are
   rendered from the client's copy of the resident (`disabled = agent.status !== 'active' || world.paused`),
   and the three-second viewport poll replaces the agent list underneath a render. The instrument
   caught a press where the control was disabled (`clickDispatched: false`) and the walk key had to
   carry the input. This is a client-side rendering artifact, not a server refusal — movement itself
   was never refused — and it is reported, not hidden.
2. **Pacing must be measured at the wire.** Pacing inputs from the press hid the shipped client's own
   160 ms motion hold; the server's 120 ms refusal window then refused occasional steps under load
   (`429 POST /api/v1/move`). Fixing the pacing to run from the previous request's send time and
   reporting any refusal removed that class of noise.
3. **The suite is coupled through the resident's position.** A resident parked 24 tiles from the
   arrival plaza is outside the second browser's 20 × 14 observation window, which broke
   `shared-presence-two-clients`. The measured route is now an out-and-back loop for that reason, and
   the scenario asserts the resident ends where it started.
4. **The aim line is a usable confirmation signal.** It is plain text, it is `role="status"`, and it
   names the tile the server stored. An instrument can be built on it without touching
   `window.__nemoworld` internals beyond the read-only hooks the suite already uses.

## Follow-ups worth doing

- A distribution needs more than 24 samples: a longer run (say 200 steps) or a repeat-run harness that
  aggregates the notes would give a p95 and a maximum worth quoting.
- If the disabled-control artifact matters to players, it belongs in its own scenario: press the
  movement control through a viewport-poll tick and assert the control stays usable, rather than
  routing around it as this instrument does.
- The input → answer → paint split is now visible per step; if the movement work changes the number of
  requests per step, that split is where the change will show first.
