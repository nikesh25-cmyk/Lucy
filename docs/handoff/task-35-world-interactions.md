# Task 35 — world interactions as a contextual interaction component

Branch `task-35-world-interactions`, base commit `d07814d`
(`Merge branch 'task-32-characters' into verify-game-wave-b`). Database schema **21 — unchanged**; no
new dependency; `package.json`, `package-lock.json`, `app.js`, `index.html`, the stylesheets,
`src/spaces.js`, `src/journey.js`, `src/camera-controls.js` and `server.js` are all untouched.

Baseline at the base commit: **600 tests, 600 pass, 0 fail/skip**; syntax gate exit 0; e2e
**15/15**. Re-confirmed on this worktree before the change.

A resident near a doorway, a crop patch, a bench, a crafting station, a country ambassador desk or
another resident now sees the world's own interaction offered through a **small prompt**, and every
conversation or activity opens in a **compact overlay**. The component is a reader and a router,
never a second authority: it reads `GET /interact`, sends intent to the shipped routes, and renders
the server's own `hint` / `next_step`. **No validation is re-implemented on the client.** This task
builds the component and its tests; **task 38 wires the shell**.

## 1. What changed, and the one file that carries it

| File | Change |
|---|---|
| `src/ui/interaction-prompt.js` | **New.** The whole component: the prompt and overlay models, the keyboard map, the payload builders, the refusal renderer, the non-modal DOM painters, and the `createInteractionPrompt` controller. ~570 lines, zero imports, zero dependencies. |
| `tests/interaction-prompt.test.js` | **New.** 13 pure module tests (keyboard map, key intents, models, payloads, refusal, nearby entries, the accessible painter with an injected fake DOM). |
| `tests/interaction-prompt-http.test.js` | **New.** 11 tests driving the real HTTP routes against a temporary database through an injected transport. |
| `docs/INTERACTION_PROMPT.md` | **New.** The component API, the fixtures and their server source, the keyboard map, the wiring steps, limitations and residual risks. |
| `docs/handoff/task-35-world-interactions.md` | **New.** This file. |

Nothing else was touched. In particular the four files owned by the parallel agents
(`src/camera-controls.js`, `src/game-input.js`, `src/ui/build-interface.js`,
`src/ui/inventory-panel.js`, `src/ui/spectator.js`, `src/ui/touch-controls.js`, `game-mobile.css`)
were not read-modified, imported or depended on: the component **accepts the input interface and the
keyboard through injection** (`keys` option, `handleKey`) rather than importing anyone's module.

## 2. The goal, point by point

1. **Discovery by approach.** `controller.approach()` reads `GET /interact` with no tile named, so the
   server ranks the fixtures within six tiles and focuses the nearest
   (`src/spaces.js:516-546`, `docs/API.md:261`). Nearby residents are combined from the world's
   published participants. No client-side ranking of fixtures and no client-side distance rule.
2. **A small, readable prompt.** `promptModel` carries the server's `hint` verbatim (fixture, action,
   "Manhattan distance 1", measured distance in one line), a focusable `role="status"` live region
   (`aria-live="polite"`, `tabindex="0"`), and a `placement` of `pointer-events: none` near the aim so
   it never covers the world. `paintPrompt` sets `textContent` only — no markup injection.
3. **Compact overlays.** `overlayModel` returns a non-modal `dialog` (a crop patch or crafting
   station → an **activity**; an ambassador desk or a resident → a **conversation**). It is
   dismissible by Escape **and** a labelled Close control, never traps focus (`aria-modal="false"`,
   no `showModal()`), and sets `suspendsShortcuts: true` so the gameplay keys stand down while open.
4. **Refusals explain the next usable step.** `refusalModel` renders the server's `hint` + `next_step`
   for every class: out of range → approach; paused/revoked → the resident's state; wrong owner → who
   owns the garden (surfaced in the prompt before the action, from the server's own note); missing
   prerequisite → what to get. All asserted in `tests/interaction-prompt-http.test.js`.
5. **A keyboard equivalent for every interaction.** `keyboardMap()` is one data table; the tests pin
   it. Enter / Space / `i` use the focused fixture for all six entries; arrows cycle; Escape dismisses.
   Non-interaction keys return `null`, so walking, turning and the block palette are untouched.
6. **Server authority.** The component sends intent only and renders only confirmed bodies. A refusal
   sets `refusal` and leaves `confirmed` null — `refused.accomplished === false` is asserted, and each
   refusal test also re-reads the database to prove nothing was written.

## 3. Fixtures covered, and their server source

| Fixture | Server kind | Server source | Runtime scope | Overlay |
|---|---|---|---|---|
| Door | `door` | authored portal → `POST /agents/:id/travel` (`src/spaces.js:92,606`) | `move` | none |
| Crop patch | `crop_patch` | `farm` object / farm tile → `POST /journey/garden` (`src/spaces.js:80,607`) | `build` | activity |
| Bench | `bench` | `bench` object / bench tile → `POST /agents/:id/posture` (`src/spaces.js:81,608`) | `move` | none |
| Crafting station | `crafting_station` | `workbench` → `POST /journey/craft` (`src/spaces.js:82,609`) | `build` | activity |
| Country ambassador desk | `ambassador_desk` | `npc_ambassadors` / `npc_mayors` stand → `POST /ambassadors/talk` (`src/spaces.js:95-96,616-618`) | `chat` | conversation |
| Nearby resident | `resident` | the world payload's participants → `POST /messages` (`src/platform.js:276`) | `chat` | conversation |

The first five are exactly what `GET /interact` returns (`docs/API.md:253-259`). The resident is the
component's own addition and is honest about it: it comes from the published participant list, and its
action is the world's existing nearby channel (which reaches every active resident within three tiles,
stated in the overlay's own note).

## 4. Keyboard map

| Fixture | Action | Keys | Overlay path |
|---|---|---|---|
| Door | `travel` | Enter, Space, `i` | performs directly |
| Crop patch | `garden` | Enter, Space, `i` | overlay; arrows choose plant/tend/harvest, Enter submits |
| Bench | `posture` | Enter, Space, `i` | performs directly |
| Crafting station | `craft` | Enter, Space, `i` | overlay; arrows choose the recipe, Enter submits |
| Ambassador desk | `talk` | Enter, Space, `i` | overlay; type the question, Enter submits |
| Nearby resident | `message` | Enter, Space, `i` | overlay; type the message, Enter submits |

`INTERACTION_KEYS = ['Enter', ' ', 'i']` and the same keys are printed by the shipped aim line
(`src/camera-controls.js:30-32,110-112`). The keys are an injectable default, so a parallel UI owner
can change them without editing this file.

## 5. Wiring steps for the integration owner (task 38)

Full instructions are in `docs/INTERACTION_PROMPT.md` §9. In short: serve the module from `server.js`
(one `files.set(...)` line beside `src/footprints.js`); import it in `app.js`; build the three-method
transport from the shipped `api()` helper; create the controller and keep `setPosition` / `setResidents`
current; call `approach()` after a move and `refresh({ x, y })` on an aim or click; paint into a prompt
host and an overlay host; route keys through `handleKey` (calling `preventDefault()` and standing the
world keyboard down while `suspendsShortcuts` is true); and style the prompt host with
`pointer-events: none` anchored near the aim line.

## 6. Verification (actual output)

Delivered tree, frozen before the runs below. `export PATH="$PWD/../node-bin:$PATH"` (Node v24.19.0).
No `npm install` was needed and none was run.

```
$ node --check src/ui/interaction-prompt.js
PARSE_OK

$ npm run check
CHECK_EXIT=0            (every file the gate lists parses; the new module is checked directly)

$ npm test
ℹ tests 624
ℹ pass 624
ℹ fail 0
ℹ skipped 0
TEST_EXIT=0             (baseline was 600; +24 = 13 tests/interaction-prompt.test.js + 11 tests/interaction-prompt-http.test.js)

$ npm run e2e
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
E2E_EXIT=0
```

**No browser check was performed.** `npm run browser` was **not** run: no scenario can be added to
`scripts/browser-suite.mjs` without `app.js`, which this task does not own, and the component is not
yet reachable from the shipped UI. The suite remains at its shipped 21 scenarios; the component is
verified with module tests and with HTTP tests that drive the real routes against a temporary
database.

## 7. Migration and rollback

**No schema change, and nothing stored.** The component reads `GET /interact` and writes only through
the actions the world already owned (travel, `journey_crops`, `journey_inventory`, `journey_profiles`,
`agents.posture`, `ambassador_conversations`, `messages`, `audit`). No table, column, index, trigger,
view or `PRAGMA user_version` value was touched; `tests/` hard-coded schema assertions are untouched
because the schema did not move from **21**. An installation on schema 21 needs no migration.

**Rollback** is a checkout of the base commit `d07814d`, or deleting the new module, its two test
files and the two documents. Because no shipped file imports the module yet, deleting it changes
nothing that shipped before; the four UI owners' files are unaffected either way.

## 8. Limitations and residual risks

- **No browser check** (stated above, deliberately). A click-through of the prompt, the overlays, the
  Escape dismissal and the focus return is verification that task 38 must add or perform.
- **The component is not yet reachable.** Until task 38 wires the shell, this is a tested library, not
  a visible surface.
- **The syntax gate does not list the new file.** `npm run check` checks a fixed list in
  `package.json`, which this task may not edit. The module parses (`node --check`) and is exercised by
  `npm test`; whoever owns `package.json` should add `src/ui/interaction-prompt.js` to the gate.
- **A resident message is the nearby channel, not a private line.** `POST /messages` with
  `channel: 'nearby'` reaches every active resident within three tiles (`src/platform.js:294`). The
  overlay says so; it does not imply a direct message.
- **A resident conversation keeps no idempotency key.** `/messages` is not in the shipped idempotency
  list, so a rapid repeat is bounded by the world's own 1.5-second per-account throttle, which the
  test asserts, rather than by the interaction ledger.
- **Discovery re-reads on demand, not continuously.** The component does not poll; the integration
  owner must call `approach()` / `refresh()` after a move, or the prompt can be one step stale. This
  is the same refresh the shipped three-second world poll already drives.
- **Overlay styling is the integration owner's.** The module paints an accessible structure and names
  the placement and dismissal in the model; the CSS itself belongs to task 38.
- **`GET /interact` remains readable by a visitor**, so a spectator can inspect a fixture without
  acting for anyone; the component passes `agent_id` only when a resident is acting, and a visitor's
  submit is disabled — mirroring the shipped panel.

## 9. Reproducing

```
cd work/t35 && export PATH="$PWD/../node-bin:$PATH"
node --check src/ui/interaction-prompt.js
npm run check && npm test && npm run e2e
node --test tests/interaction-prompt.test.js tests/interaction-prompt-http.test.js
```

The patch is `../task-35-world-interactions.patch` (`git format-patch` of the branch commits), and it
applies cleanly to the base commit `d07814d`.
