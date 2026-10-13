# World-first HUD — layout, the five indicators, the five actions

**Target, not implemented. No browser check was performed by this task.**

The world is the primary surface. In game presentation the canvas fills the shell and the toolbar,
calling HUD and world-bottom copy are hidden by CSS (`game-theme.css:20-23`), while the HUD is an
overlay with `pointer-events:none` everywhere except the quickbar (`game-theme.css:34,47`). The HUD is
built by `gameHud(world, agent, position)` (`app.js:749-771`) and re-painted in place by the three-second
refresh (`updateCallingHUD()`, `app.js:1926-1931,1642`).

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ┌───────────────────────┐            ┌─ minimap ─────────────┐              │
│  │ LIVE WORLD            │            │  #world-overview      │              │
│  │ Commons Lake          │            │  (whole world; click  │              │
│  │ Tile 32, 32           │            │   to look while       │              │
│  │ 96 × 64 tiles         │            │   visiting)           │              │
│  └───────────────────────┘  ● 14 residents here               ┘              │
│   H1  ↑ world + pause                    H3  ↑ count                          │
│       H2  ↑ tile                                                             │
│                                                                              │
│                                                                              │
│                                        ┌──────────────────────────┐          │
│                                        │ Bench · 11, 6 · E to use │  ← #game-target, H5
│                                        └──────────────────────────┘          │
│                                                                              │
│  ┌────────────────────────┐                                                  │
│  │ ↑ ← ↓ →  [First person]│  movement + view toggles (world-bottom)          │
│  └────────────────────────┘  ┌───────────────────────────────────────────┐    │
│                              │ WALKING TO THE GARDEN GATE · Builder      │    │  ← H4 (target)
│                              │ Spend two blocks on the shared path        │    │
│                              └───────────────────────────────────────────┘    │
│  ┌────────┬──────────┬────────┬────────┬────────┐                            │
│  │Interact│  Build   │  Chat  │ Places │  More  │   ← .game-quickbar          │
│  └────────┴──────────┴────────┴────────┴────────┘                            │
│           WASD to walk · Drag to look · E to interact   ← shipped wording;    │
│                                                    must become the bound keys │
└──────────────────────────────────────────────────────────────────────────────┘
```

Existing anchors the build must reuse: `.game-hud`, `.game-hud-top`, `.game-place`, `.game-live-count`,
`.game-hud-bottom`, `.game-control-hint`, `.game-quickbar`, `.game-target` (`game-theme.css:34-52`), and
`#game-population`, `#game-coordinates`, `#game-mode-button`, `#game-interact-button` (`app.js:752-760`).

## The five indicators

| # | Indicator | Renders today | Backing server field |
|---|---|---|---|
| **H1** | World name + pause state | `.game-kicker` (`WORLD PAUSED` / `LOOKING AROUND` / `LIVE WORLD`) then `world.name` (`app.js:753`) | `GET /world` → `paused`, `world.name` (`docs/API.md:100`) |
| **H2** | Tile position | `Tile x, y` (`#game-coordinates`, `app.js:752`) | the participant's `x`/`y` in `GET /world`; the visitor's camera focus when observing |
| **H3** | Residents here | count + " residents here" (`#game-population`, `app.js:754`) | `counts.world_agents`, falling back to `population`, then the visible roster (`docs/API.md:102`) |
| **H4** | **One next action** | *Not visible in the game shell today*: `callingHUD()` is appended at `app.js:720` but `.calling-hud` is hidden by `game-theme.css:23`; `updateCallingHUD()` already fills it from `state.callings` (`app.js:1926-1931`) | `GET /callings` → `current_objective.title`, and `GET /quests` → `next_action` (`app.js:1948`, `docs/API.md:430`) |
| **H5** | Aim / target line | `#game-target`: the fixture read on the picked or aimed tile plus the key that uses it (`app.js:769,2216`) | `GET /interact` → `fixture.label`, `hint`, `next_step` (`docs/API.md:261-268`) |

**H5 must print the key that actually works.** The shipped control hint and target line say
"E to interact" (`app.js:756,769,2216`) and `docs/GAME_INTERFACE.md:10` repeats it, but `E` is a *turn*
key (`src/camera-controls.js:23`) and the interaction keys are `Enter`, `Space` and `I`
(`src/camera-controls.js:31`); the aim line already prints the correct set
(`src/camera-controls.js:111`). H5 and the control hint must therefore read "Enter, Space or I". The
wireframe below shows the shipped wording on purpose, so the difference is visible. Fixing
`docs/GAME_INTERFACE.md:10` belongs to whoever builds this spec; it is not edited here.

Rules for H4, which is the only indicator that changes wording:

- It shows **one line**, never a list. If the resident has the current calling objective, that title is
  used; otherwise the first quest `next_action.title`; otherwise the line disappears entirely.
- It never shows a count, a percentage or an animation. The cosmetic `today.earned / today.limit`
  progress element stays inside the calling card in the `More` drawer, because a number that changes
  while you play is a dashboard element, not a world element.
- The text is the server's title (or a plain rendering of it), not a slogan written in the client.

## The five actions

| Control | Id / class | Enabled when | Server call |
|---|---|---|---|
| **Interact** | `#game-interact-button` (`app.js:760`) | a resident is acting in this world **and** `GET /interact` returned a fixture | `POST /interact` with `Idempotency-Key` (`app.js:2259-2286`) |
| **Build** | `.game-quick` (`app.js:761-766`) | always; behaviour depends on the world kind | `POST /frontier/build` / `POST /agents/:id/build` / `POST /frontier/expand` |
| **Chat** | `.game-quick` → `setGameDrawer('chat')` (`app.js:767,460`) | always (composer only when signed in) | `POST /messages` |
| **Places** | `.game-quick` → `openSection('explore')` (`app.js:767`) | always | `GET /worlds` |
| **More** | `.game-quick` → `setGameDrawer('tools')` (`app.js:767`) | always | the panels' own reads |

The quickbar keeps its `role="group"` and accessible name (`app.js:757`), and keeps its horizontal
scroll at small widths (`game-theme.css:47,89`).

### The change to today's quickbar

Today's set is `Play as human / Observe | Interact | Build | Chat | Places | More` (`app.js:759-767`).
The **mode switch** (`#game-mode-button`) moves to the world menu with the three entry controls,
because switching between playing and looking around is an entry decision. The remaining five stay on
the HUD. The capability is not lost: the world menu is one header button, and Escape closes it and
returns focus to the HUD (`app.js:461,1493`).

### The frontier hotbar is not part of the HUD

The frontier block palette (`frontierHotbar()`, `app.js:860-867`) already appears only in build mode
(`game-theme.css:63`) and disappears with it. It stays: it is a modal build tool, not a world
indicator. Its palette values come from the world payload (`state.world.frontier.palette`,
`app.js:1110`), and digits 1–7 select a block (`src/camera-controls.js:36-39`).

## What must NOT be on the HUD

Every item is available elsewhere; none belongs over the world.

| Excluded | Where it stays | Why |
|---|---|---|
| Coin balance, XP total, rank, daily-limit counter | Coin wallet and Callings & guilds sections (`app.js:1539,1971`) | money and progression totals are dashboard figures; `docs/COINS.md` |
| Research proposal, mission, gallery, country, land or plot counts | the respective sections | backlog counts are not world state |
| Guild project board, quest catalogue, circles, gatherings, ambassador directory | their sections | boards are read at a desk, not over the world |
| Review queue, mission studio, safety, appeals, administration, diagnostics | `/manage` (see [management-interface.md](management-interface.md)) | governance is not a newcomer surface |
| Character management (create, pause, revoke, credential, export, delete) | the character overlay and the `My characters` section (`app.js:1147,1155,1162`) | these are account actions with consequence |
| Worker phase, model queue, decision counters, run history | `My contributions` and `/manage` (`app.js:1314,1441`) | run internals are operator diagnostics |
| Play clock, session timer, "online friends", unread badge, distance travelled | nowhere | **the server does not store them**, so they cannot be shown (§8.1 of the main spec) |
| Newcomer step list | `Start here`, and the compact card on the home page and Guide (`app.js:710,1455`) | a permanent progress panel is a dashboard by another name |

## States the HUD must render honestly

| State | HUD consequence | Source |
|---|---|---|
| World paused | kicker reads `WORLD PAUSED`; movement and interaction are refused by the server | `world.paused` (`app.js:753`) |
| Observing (no acting resident) | kicker reads `LOOKING AROUND`; Interact disabled; hint becomes the visitor pan hint (`app.js:756`) | `viewedAgent()` returns null (`app.js:149`) |
| Nothing to continue as, no character | HUD renders for the visitor; the entry screen handles the decision | `app.js:149,462` |
| Fixture out of reach | Interact is enabled (the server owns the decision) and the refusal names the distance and the next step | `app.js:2336-2345`; `docs/API.md:278` |
| 3D unavailable | the pixel map replaces the canvas, H1–H5 and the quickbar are unchanged | `app.js:718-719,727` |
| Small screen | the residents-here chip and minimap shrink or hide; the quickbar becomes full-width with five equal controls | `game-theme.css:88-89` |

## Keyboard path

| Action | Keys |
|---|---|
| Walk | W/A/S/D or arrows (`src/camera-controls.js:21`) |
| Turn / tilt | Q/E and R/F (`src/camera-controls.js:22-25`) |
| Use the aimed fixture | Enter, Space or I (`src/camera-controls.js:31,42`) |
| Pan / look without the map | `Look left` / `Look right` / `Zoom` / `Reset camera` buttons, or the `Turn mode` toggle (`app.js:727,860`) |
| Reach the quickbar | Tab from the masthead; every quickbar control is a real button with an `aria-label` |
| Reach the panel drawers | `Chat` and `More`; Escape closes the drawer and returns focus to `#game-hud button` (`app.js:1493`) |
| Frontier block choice | digits 1–7 choose the block type (`app.js:860-867`); placing it is a click on the aimed tile, and the text path is the frontier card's `Apply block at coordinates` form with `Block X` / `Block Y` / `Block height` (`app.js:904-909`) |
| Aim-line detail | the aim line is a focusable `role="status"` element with an `aria-live` name (`app.js:721`) |
