# Task 29 — game experience specification

Branch `task-29-game-experience-spec`, one commit on top of base commit `d59b691`
(`Make NemoWorld a game-first shared experience`, branch `feat/nemoworld-game-first`). Worktree
`work/t29`. Focused patch: `../task-29-game-experience-spec.patch`
(`git format-patch -1 --stdout`), 9 files, 1500 insertions, 0 deletions. The commit's hash is the one
`git log -1` reports on the branch; this document does not pin it because writing it here would change
it.

**This task changed Markdown only.** No code, no stylesheet, no HTML, no JSON, no dependency and no
database record was touched. `app.js`, `index.html`, `style.css`, `nemo-theme.css`, `game-theme.css`,
`world.js`, `server.js`, `src/**`, `tests/**` and every other document are byte-identical to the base
commit (`git diff --stat d59b691 HEAD -- ':!docs'` is empty) — only task 38 may wire the shell, and only
another task may add the server data §8.1 of the main spec would need.

**No browser check was performed by this task.** No page was opened, no click was made and no
screenshot was taken. Every "today" statement in the specification is a reading of the source at
`d59b691`, not an observation. This document does not claim the specified interface exists.

## Deliverables

| File | Contents |
|---|---|
| `docs/GAME_EXPERIENCE.md` | The specification: the five surfaces, the design rules, the server-state map (§8), the exists-vs-requires table (§10), the acceptance argument and the first-five-minutes walkthrough (§11), the surfaces owned by other tasks (§9), and the limitations (§12) |
| `docs/specs/INDEX.md` | Index and the conventions every spec file follows |
| `docs/specs/entry-screen.md` | Entry layout, the six states, and what Play · Observe · Continue each read and write |
| `docs/specs/overlays.md` | Account and character overlays: layouts, the exact field sets, validation, escape path, failure behaviour |
| `docs/specs/world-hud.md` | HUD layout, the five indicators with their fields, the five actions, the explicit not-on-HUD list, the honest states |
| `docs/specs/panels.md` | Chat, Journal, Inventory and Projects as dismissible drawers, each with its server field or endpoint |
| `docs/specs/management-interface.md` | `/manage`: what it hosts, the role gate, the navigation change, what must not move |
| `docs/specs/flows.md` | Enter, move, interact and build as step tables with the server call and the keyboard path per step |
| this file | Delivery record, flows summary, backing summary, exists-vs-requires, limitations |

## The flows in one page

- **Enter.** The entry overlay already sits over the drawn commons (`game-theme.css:71`). **Observe**
  is the shipped anonymous visit (`app.js:462-465`). **Play** is the shipped `playAsHuman` path
  (`app.js:782-792`). **Continue** is the one new control: it resolves the browser's remembered
  character (`localStorage selected-agent`, `app.js:24`) against `GET /me` (`app.js:413`) and re-enters
  through `selectAgent` (`app.js:139`). Nothing about entering writes progress.
- **Account and character.** Both are native `<dialog>` overlays. The account dialog and its field set
  already ship (`index.html:28`, `app.js:487-502`; contract `docs/API.md:13-28`); the character overlay
  is new and reuses the shipped create fields and server rules (`app.js:1159`, `docs/API.md:34-49`).
  Escape or a labelled Close always returns to the world; secrets are never drafted
  (`NEVER_DRAFT_FIELDS`, `app.js:56-60`).
- **World-first HUD.** Five indicators (world+pause, tile, residents here, one next action, aim line)
  and five actions (Interact, Build, Chat, Places, More). The mode switch moves to the world menu. The
  single biggest change is that the calling HUD, which already exists and already reads
  `state.callings` (`app.js:1926-1931`), is currently hidden in the game shell by `game-theme.css:23`.
- **Panels.** Chat, Journal, Inventory, Projects — one drawer shell, three dismissal paths (own Close,
  Escape, HUD button), read-only except where an existing route already writes.
- **Management.** Every reviewer, moderator, administrator, operations and research-management surface
  moves behind one `/manage` mode, entered from a single role-gated `Management` item; the governance
  group leaves the game navigation (`app.js:506`). No permission changes and nothing is deleted.

## Server-state backing, element by element

The authoritative table is `docs/GAME_EXPERIENCE.md` §8 (42 rows, each with a `file:line` citation from
`app.js`, `server.js`, `game-theme.css` or `docs/API.md`). The short form:

| Element | Backed by |
|---|---|
| Play | `GET /me` → `agents[]`; `POST /agents {kind:"human"}`; stored `x/y/z/world_id/yaw/pitch` |
| Observe | `GET /world` with no `agent_id` (`app.js:169`, `server.js:495`) |
| Continue | `GET /me` + the browser's remembered character id, then `selectAgent` |
| Account overlay | `POST /auth/register` (`server.js:450`), `GET /bootstrap` (`server.js:428-431`) |
| Character overlay | `POST /agents`, `POST /callings/select`, `GET /callings/guilds`, `GET /countries` |
| H1 world + pause | `GET /world` → `world.name`, `paused` |
| H2 tile | `GET /world` participant `x`/`y` |
| H3 residents here | `GET /world` → `counts.world_agents` |
| H4 one next action | `GET /callings` → `current_objective.title`; `GET /quests` → `next_action` |
| H5 aim line | `GET /interact` → `fixture.label`, `hint`, `next_step` |
| Interact | `POST /interact` with `Idempotency-Key` |
| Build | `POST /frontier/build`, `POST /agents/:id/build`, `POST /frontier/expand`, `POST /land/assign`, `POST /frontier/grant` |
| Chat | `GET /world` → `messages[]`; `POST /messages` |
| Journal | `GET /journey` → `journal[]`; `POST /journey/journal` |
| Inventory | `GET /journey` → `inventory`, `crops`, `recipes`; `GET /journey/offers` and the offer routes |
| Projects | `GET /guilds`, `GET /quests`, `GET /community` (the panel writes nothing of its own) |
| Management | `POST /reviews`, `POST /missions`, `GET /safety`, `GET /operations`, `POST /research/*` |

**Data the specification wants that does not exist**, and who would have to add it (main spec §8.1):
a *server-side* "last played character" per operator (today it is browser-only, `app.js:24,139`) would
need a schema change, so it belongs to a database task, and is **not required** for Continue to work;
a play clock, an unread-message badge and "online friends" are deliberately **not** specified because
the server stores no such record; competence-pathway tiers belong to task 22. Nothing in this task adds
any of them.

## What exists today vs what this requires

Copied from main spec §10 as the delivery summary; the table there has the citations.

| Element | Today | Required |
|---|---|---|
| Entry over the world | Yes | unchanged structure |
| Play | Yes, as `Play as human` | rename; offer Continue first when a character exists |
| Observe | Yes | unchanged behaviour, stated limits |
| Continue | **no control**; the data exists | add the control and its fallback rules |
| Film | hero button | move to a text link under the buttons |
| Account overlay | Yes | keep; keep the field set and the secrets rule |
| Character **selection** overlay | **no** (full section + aside select) | add the overlay; keep the section for management |
| Character **creation** overlay | in-section only | add the overlay with the same fields and server rules |
| HUD indicators H1–H3, H5 | Yes | keep |
| HUD H4 one next action | exists as `calling-hud`, hidden by `game-theme.css:23` | re-enable one line, no counts |
| Mode switch on the HUD | Yes (`#game-mode-button`) | move to the world menu |
| Chat drawer | Yes | presentational change only |
| Journal drawer | **no panel** | add over `GET /journey` → `journal` |
| Inventory drawer | partial (workshop section) | add over `GET /journey` `inventory`/`crops`/`recipes` |
| Projects drawer | partial (three sections) | add one read-only drawer that links out |
| Management interface | exists as `?mode=workspace` | name it `/manage`; one role-gated nav entry; governance out of the game menu |
| Keyboard parity | Yes for shipped controls | extend the same guarantee to every new overlay and drawer |

## Acceptance argument (summary)

Full form in main spec §11. "A newcomer can understand how to enter, move, interact and build without
reading a dashboard" is met, in the specification, by making the path touch **one overlay, one HUD and
one drawer at a time**, and by never requiring any of: Missions, Research desk, World Assembly,
Countries & areas, Community, Callings & guilds, Guild projects, Quest chains, Coin wallet, Resident
passport, Garden & workshop, My contributions, Review, Mission studio, Safety, Administration or the
Guide. §11.2 walks the first five minutes step by step with the screen, the action and the keyboard
path; §11.4 lists what is deliberately kept out, including the newcomer step list itself, which stays a
text section rather than becoming a HUD widget.

## Gates (actual output)

Run in `work/t29` with `export PATH="$PWD/../node-bin:$PATH"` (Node v24.19.0). No `node_modules` is
present and none is needed: `npm test`'s browser-suite file is a pure unit file by design
(`tests/browser-suite.test.js:1-6`).

```text
$ npm run check
CHECK_EXIT=0            (every file the gate lists parses)

$ npm test
ℹ tests 565
ℹ suites 0
ℹ pass 565
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 54902.340041
TEST_EXIT=0
```

The same two gates were run three times in this worktree, all green:

| Run | When | `npm run check` | `npm test` |
|---|---|---|---|
| Baseline | before any file was written | exit 0 | 565 tests, 565 pass, 0 fail, 0 cancelled, 0 skip, 0 todo — `duration_ms 58698.2385` |
| Delivered tree | after the documents were written | exit 0 | 565 tests, 565 pass, 0 fail, 0 cancelled, 0 skip, 0 todo — `duration_ms 54902.340041` |
| Committed tree (`41989b0`) | after the commit | exit 0 | 565 tests, 565 pass, 0 fail, 0 cancelled, 0 skip, 0 todo — `duration_ms 56152.171084` |

The counts are identical in all three runs, so the Markdown-only change alters neither result.
`npm run e2e` and `npm run browser` were **not** run: this task is docs-only and performs no browser
check, as stated above.

## Verification that was actually performed

1. `npm run check` — exit 0, three runs (baseline, delivered tree, committed tree).
2. `npm test` — 565 pass / 0 fail in each of the three runs (table above).
3. `git status` / `git diff --name-only` against `d59b691` — exactly the nine Markdown files listed
   under Deliverables, and `git diff --stat d59b691 HEAD -- ':!docs'` is empty, so no tracked file
   outside `docs/` is modified.
4. Every `file:line` citation in the specification was read from the source in this worktree during
   this task; none was written from memory or from another branch.

## Defects and inconsistencies found while reading the source

These are findings, not changes. This task edits no code, so each is recorded for whoever builds the
specification.

1. **The HUD advertises a key that does not interact.** `app.js:756` (control hint) and
   `app.js:769,2216` (`#game-target`) say "E to interact", and `docs/GAME_INTERFACE.md:10` says
   "E / Enter: use the selected nearby door…", but `E` is bound to *turn* and the interaction keys are
   `Enter`, `Space` and `I` (`src/camera-controls.js:23,31`). The aim line itself prints the correct
   set (`src/camera-controls.js:111`). H5 and the hint must be corrected;
   `docs/GAME_INTERFACE.md:10` is outside this task's file ownership.
2. **The calling HUD is built and then hidden in the game shell.** `callingHUD()` is appended to the
   world panel (`app.js:720`) and filled from `state.callings` (`app.js:1926-1931`), while
   `game-theme.css:23` hides `.calling-hud` whenever `body.game-world` is set. The one next-action
   indicator (H4) is therefore already computed and simply not visible.
3. **There is no keyboard placement for a new frontier block at the point of aim.** Digits 1–7 select
   the type (`app.js:860-867`) and a click places it (`pickWorld` → `buildAt`, `app.js:824-826`). The
   only pointer-free placement today is the frontier card's `Apply block at coordinates` form
   (`app.js:904-909`), which this specification adopts as the documented text path rather than claiming
   a key that does not exist.
4. **Character selection is a full section, not an overlay** (`app.js:1139-1164`), plus a `<select>` in
   the world aside (`app.js:730`); and the mode switch (`Play as human` / `Observe`) sits on the HUD
   even though it is an entry decision (`app.js:759`). Both are recorded in §10 of the main spec as
   work, not as bugs.

## Limitations and residual risks

- **Target, not implementation.** Every "required" row above is unbuilt. This task specifies; it does
  not deliver the interface, and nothing here should be reported as shipped.
- **No browser evidence.** No layout was rendered, so the wireframes are text. Spacing, wrapping and
  the small-screen behaviour of the new overlays are unverified and must be checked in a browser by the
  task that builds them.
- **No new measurement of contrast or targets.** The spec reuses the shipped palette and the 44-pixel
  convention and cites the measured values from task 13; any new surface must be measured against the
  same threshold before release.
- **Four surfaces are owned elsewhere** and are referenced only: competence pathways (task 22),
  restoration events (task 23), the versioned evidence library (task 25) and the reviewer workbench
  (task 26). None of them is in this branch's base, and this document makes no claim about their
  design. The asset library documents are another task's work and are not touched.
- **The Continue default is a browser preference.** Until a server-side "last played character" exists —
  a schema change this spec deliberately does not ask for — Continue is per browser, and a person on a
  new machine simply presses Play or picks a character. The interface must not imply otherwise.
- **`/manage` changes no permission.** It relocates entry points that already have server-side role
  checks; the client gate decides only what is rendered.
- **One design decision worth flagging to the reviewer**: moving the `Play as human / Observe` mode
  switch off the HUD. The capability stays in the world menu (`app.js:461,1493`), but a reviewer who
  prefers it on the HUD can keep it and drop `Places` instead without changing any other part of the
  specification.

## Files changed

```
docs/GAME_EXPERIENCE.md                        (new)
docs/specs/INDEX.md                            (new)
docs/specs/entry-screen.md                     (new)
docs/specs/overlays.md                         (new)
docs/specs/world-hud.md                        (new)
docs/specs/panels.md                           (new)
docs/specs/management-interface.md             (new)
docs/specs/flows.md                            (new)
docs/handoff/task-29-game-experience-spec.md   (new)
```
