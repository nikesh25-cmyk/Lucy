# Task B — the next-passage cue in the HUD

The server half was already shipped: `src/spaces.js` attaches `next_passage` to the `/world` payload
for the viewer's own resident (`src/spaces.js:406-422`), and `tests/passage-cue.test.js` pins it. This
task is the visible half: H4 now names the passage a resident can actually walk to, with the length of
the server's own planned route.

- Base commit: `3c34092` (`Name the next passage a resident can actually walk to (Wave B)`) on
  `integration/deepseek-master-2026-10-14`
- Files changed: `app.js`, `scripts/browser-suite.mjs`, `tests/browser-suite.test.js` (scenario count
  40 → 41), `docs/specs/world-hud.md`, and this file
- Patch: `git format-patch` to `../task-b-next-passage-hud.patch` (see "How this was verified")

## What is rendered

```html
<p id="game-next-action" class="game-next">Discover a shared place</p>     <!-- H4, unchanged -->
<p id="game-next-passage" class="game-next">Meeting Hall · 1 step</p>     <!-- H4, the cue -->
<p id="game-control-hint" class="game-control-hint">WASD to walk · …</p>
<div class="game-quickbar">…</div>
```

One line, the server's own words: `${label} · ${steps} step(s)`. `label` and `steps` are the payload's
(`next_passage.label`, `next_passage.steps`); nothing is derived from `x`, `y`, `direction` or
`distance`, and no word of the line is written in the client. The two examples the server actually
sends today are `Meeting Hall · 1 step` (a doorway in the Commons) and, in an opened frontier sector,
`<direction> frontier passage · N steps` (a gate whose neighbour is really opened).

Rendering is one created `<p>` with a `textContent` write (`element()`, `app.js:122`). `app.js` still
contains no `innerHTML` (`grep -c innerHTML app.js` → 0).

## Where it sits in the HUD spec's structure

`docs/specs/world-hud.md` defines **five indicators and one next action**; H4 is "the only indicator
that changes wording", and it is the only place a dynamic line may live. The cue is therefore folded
into **H4**, not added as a sixth indicator:

- It renders inside `.game-hud-bottom`, the same element H4 already owns, in the same `.game-next`
  pill class the objective line uses, so no stylesheet rule was needed and no new surface was created
  (the stylesheets are outside this task's file ownership in any case).
- The spec's own wireframe draws H4 as a **two-line card** (title + description). The objective line is
  the title; the cue is the second line. H4's "one line, never a list" rule is kept line by line: each
  read is one line, neither is a list, and each disappears on its own when the server stops sending it.
- It carries no bar, no percentage, no animation and no invented slogan; the step count is the length
  of one planned route to one named destination, not a progress or trip total. The spec's excluded
  "distance travelled" is a cumulative figure the server does not store — a different thing, and the
  spec page now says so explicitly.
- `docs/specs/world-hud.md` was updated in place: the H4 row, the H4 rules, the layout wireframe, the
  "what must NOT be on the HUD" table (the distance-travelled clarification), and two new rows in
  "States the HUD must render honestly".

## The states, and what the line does in each

| Server state | Line |
|---|---|
| `next_passage` names a reachable passage (`kind: 'gate'` or `'portal'`) | `${label} · ${steps} step(s)` |
| `next_passage.kind === null` | the server's own `reason`, verbatim (`No reachable passage from here.`) |
| `next_passage` is `null` (viewer with no resident in this world, or observing) | **no element at all** |
| the payload has no `next_passage` key, or one of an unknown kind | **no element at all** |
| the resident stands on the passage (`steps: 0`) | `${label} · 0 steps` — the empty route is shown, not dropped |
| `world.paused` is true | withheld (blanked and hidden), because no step can be taken |

The last two are deliberate decisions rather than accidents:

- **`0 steps` is shown.** `planWalk` returns an empty route when the resident already stands on the
  destination, and the server sends `steps: 0`. The requirement's "show nothing" cases are a `null`
  payload and no resident; a zero-length route is neither, so the client does not overrule the server.
- **A paused world withholds the cue.** Movement is refused while paused, so a walk invitation would be
  a lie. The payload still carries the cue in that state — the browser scenario asserts exactly that —
  so the withholding is the HUD's own honest choice, not an absent field.

## Accessibility decision

- **Plain text, no live region, and that is the decision.** `#game-next-passage` has no `aria-live`,
  no `role`, and is not focusable. The line's step count changes as the resident walks, and the world
  poll re-reads the payload every three seconds (`app.js:2129-2151`), so an `aria-live="polite"` line
  would interrupt a screen reader with a new number every few seconds — the noise the brief asked to
  avoid. The surface already has a movement live region: `#world-reticle` is `role="status"` with
  `aria-live="polite"` and names the tile the server stored. The cue is a static read, available to
  the virtual cursor and to any user agent that reads the HUD.
- **No focus, no covering.** The element is a `<p>` with the rest of `.game-hud`, which is
  `pointer-events:none` (`game-theme.css:34`), so it cannot take a click, take focus, or steal it. It
  is text inside the existing bottom band, not a new overlay; the measured band geometry is below.
- **Keyboard/text parity: the cue is purely informational.** It is not actionable, so it has no control
  to mirror; there is no second state a text fallback would have to repeat. Acting on it uses the
  shipped walk path (W/A/S/D, arrows, or the HUD's own movement controls), and the destination is also
  listed with coordinates in the world drawer's `Places & entrances` list, which is already keyboard
  reachable. The spec page records this.

## What was deliberately not added

- No new indicator, no new dashboard, no sixth HUD slot.
- No direction, distance, bearing arrow or "nearest doorway" derived in the client: the server sends
  `direction` only for gates (and its `label` already contains it), so the client does not compute one.
- No control that walks, travels or enters the passage. The server owns movement (one throttled grid
  step) and the doorway action; a client-side shortcut would be a second authority.
- No live region, no animation, no icon, no progress bar.
- No CSS change: the line reuses `.game-next` (`nemo-theme.css:139-140`), so the stylesheets are
  untouched.
- No change to the movement path, the poll cadence, or any server file.

## Cost on the refresh path

- At render (`gameHud`, `app.js:1007-1008`): one string build and one element, once per full render.
- On every refresh (`syncNextPassageLine`, `app.js:3306-3314`, called from `syncGameHud`, which the
  three-second world poll and the post-step render already call): two `querySelector` lookups plus a
  string comparison, and a DOM write only when the text actually changed. No per-frame work was added,
  and no request was added.

`movement-latency` is the instrument that would show a cost here, and it measures input → confirmed
step, which never touches the cue. The two full runs in this session reported medians of 9.4 ms and
13.7 ms, both inside the 9.0-16.6 ms band that instrument recorded for isolated runs on this same
machine (`task-b-wave-latency-instrument.md`), with no scenario-level change to the input-to-step path
that could be attributed to the cue.

## The browser scenario

`next-passage-cue` (registered in `scripts/browser-suite.mjs`, scenario count 40 → 41 in
`tests/browser-suite.test.js`). Five steps, all against real payloads read through the read-only
`window.__nemoworld` hook:

1. the HUD line equals `${label} · ${steps} step(s)` re-composed from the client's own payload; the
   named tile is a passage the payload also exposes (`portals`/`frontier.gates`); the cue's `world_id`
   is the world the HUD names in `.game-place strong`; the line has no `aria-live`;
2. a confirmed step out and back (the resident is returned to its starting tile, so no later scenario
   shares a moved fixture): the line follows the new payload and is not a fixed string;
3. a step onto the passage tile: the payload's empty route is shown (`0 steps`), and stops being empty
   on the step off;
4. the platform is paused over the API (`POST /operations/pause`, resumed in a `finally`): the line is
   blanked and hidden **while the payload still carries the cue**;
5. an independent anonymous browser chooses **Observe**: the payload's `next_passage` is `null` and no
   passage line is rendered at all.

Which movement control carries which world direction is *measured*, not assumed: the scenario takes one
confirmed step, records the world cardinal it produced, and derives the other three from the cycle. The
control-to-direction map is camera-relative in first person, so assuming a map would have made the
scenario depend on the browser's remembered camera.

## Limitations

- **The bottom band grows by 39 px when the cue is present.** Measured at 1440 × 900 in the game shell:
  `.game-hud-bottom` is 177 px tall (18 px off the bottom) with the cue; the cue pill itself measures
  31 px (125-156 px from the bottom edge) and the band's grid gap is 8 px, so the band was 138 px tall
  before this change. In a frontier sector **with build mode open**, `.game-build-host` is anchored at
  `bottom:104px` with `z-index:11` (against the HUD's `9`) and measured 104-648 px, so the build and
  placement panel draws over the whole bottom band. The objective line (164-195 px) was already covered
  that way before this change; the cue now sits under it too. It is a modal build tool standing in
  front of the HUD, not the cue covering the world: outside build mode nothing overlaps. A one-line fix
  belongs to the stylesheet owner (`nemo-theme.css:163`, raise or collapse `.game-build-host`); no CSS
  was touched here.
- **No UI screenshot is committed.** The only visual check was a screenshot taken into the
  git-ignored `test-results/` during the focused run, which showed the cue pill under the objective
  pill, above the control hint, inside the bottom band. The automated assertions read text and geometry
  rather than pixels.
- **The engine's own pixel/2D path was not re-verified for the cue.** The HUD exists only in the game
  presentation, and the cue is text in it, so the graphics toggle cannot remove it; but no scenario
  toggles the renderer with the cue on screen.
- **`steps` counts the server's planned route, not the distance.** A route that must walk around
  scenery is longer than the Manhattan distance in `next_passage.distance`. That is the server's
  number being shown as it is; the client does not reconcile the two.
- **The `reason` state is not exercised in a browser.** `No reachable passage from here.` needs a
  resident in a world with no reachable passage, which the seeded worlds do not produce; the branch is
  a direct pass-through of the server's string and is only pinned by reading
  (`src/spaces.js:421`, `nextPassageLine`).

## How this was verified

All figures below are from runs on the final tree, on this machine.

- `npm run check` — exits 0.
- `npm test` — 881 tests, 881 pass, 0 fail (the registry assertion in `tests/browser-suite.test.js` now
  expects 41 scenarios; no other test was changed).
- `npm run e2e` — 17 steps passed, 0 failed.
- `npm run browser` — **41 of 41 scenarios passed**; the suite's guarantees held in that run (server
  stopped, process lock released, temporary workspace removed, shipped `data/world.sqlite` untouched),
  and the temporary-database, production-database-refusal, teardown-on-failure and trace behaviour is
  unchanged. `next-passage-cue` passes in isolation as well
  (`LUCY_BROWSER_ONLY=next-passage-cue npm run browser`).
- `movement-latency` in that run (the cue is not on this path, so the figures are reported so the two
  can be compared): The Commons, 12 steps east out of 10,5 and the same back — n=24, min 6.2 ms,
  median **13.7 ms**, p95 15.3 ms, max 15.5 ms; split: input → request left the page 1.1 ms, input →
  `POST /move` answered 3.2 ms, that answer → the aim line 9.9 ms; 24 of 24 carried by the movement
  control, 0 presses refused by the server's own throttle; load average 8.9/16.0/24.1 at the end of the
  run. A full run earlier in the same session, on a more loaded machine (load average 21.0/25.6/33.0),
  reported median 9.4 ms with the same code — the same spread the instrument's own note records
  between runs, which is why the load average is quoted beside every figure.
