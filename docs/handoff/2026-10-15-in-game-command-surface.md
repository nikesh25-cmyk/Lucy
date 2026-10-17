# In-game command surface — 2026-10-15

Branch `feat/in-game-command-surface`, worktree `work/command-surface`, cut from `feat/visual-upgrade-slice-1` at `7eb15fb`.
UI only: no schema, route, memory or vault change. The only `server.js` edit is two static-file entries (the new
module and stylesheet), and a new static entry is the one thing a merge with another branch that also edits that
table has to keep.

The owner asked that the entire interface be navigable in the game itself, so a person or an agent can work
without changing tabs or leaving the space. Until now Places and the World menu replaced the 3D view with a full
workspace section; only Chat and the More drawer stayed inside it.

## What it does

- **One catalogue** (`src/ui/command-deck.js`): every section, its label, group, purpose, what an agent does
  there, the menu groups, a search filter and the dock/sheet rule.
- **Every section opens as a panel over the live world** (`app.js`, `index.html`, `game-panel.css`). In the game
  presentation `state.tab` is always `world`; `setTab()` routes a section to `state.gamePanel`. `renderView` leaves
  the WebGL scene alone when only the panel changed, so the world keeps running and the avatar stays controllable
  (the audit walks with W while a panel is open). At 1280 px and wider the panel docks and the world narrows;
  below that it is a sheet and the world shortens. The panel has Focus world, Menu, Wider/Taller and Close.
- **Navigation**: the World menu has a "Find a section" search (Enter opens the single match, the count is
  announced); `M` opens the menu; Esc closes menu, then drawer, then panel. The panel and the chat/More drawer
  share one slot. On a compact HUD the aim line, move feedback and prompt stay as visually hidden live regions.
- Governance sections stay behind `/manage` in the menu (an existing test); buttons elsewhere still open them as
  panels.
- No motion is defined, so reduced motion has nothing to suppress.

## Verification

- `npm run check` — 102 files, 0 failed. `npm test` — 1,069 of 1,069 on the last full run. (The local-launcher test downloads a 50 MB Node runtime when a worktree has no `.runtime/`, because this machine's default Node is 22; it passes once `.runtime/` is present. Not a change here.)
- `scripts/command-surface-audit.mjs` opens every section in real Chrome at 1440, 390 and 1024 px: all pass.
- Real-Chrome acceptance suite (`npm run browser`): the new scenario `in-game-command-surface` and the other 45
  pass. Existing scenarios needed their locators moved, not their assertions (except the sound step below):
  - `first-ten-minutes`, `first-play-solo-ambassador`: the calling choices and the character form now open in
    `#game-panel-body` while playing, so those locators match `#view` or the panel body.
  - `createResidentThroughInterface`: the same.
  - `world-sound-controls`: its last step assumed opening Guide left the game. Guide is a panel now, so the step
    asserts that a panel keeps the world and its sound untouched, and that leaving for `/manage` removes the
    controls and returning requires an explicit enable again.
  - `openTab`: when the section list is not on screen it opens the World menu first, as a visitor would.
  - `tests/browser-suite.test.js` now expects 46 scenarios.
- Before/after screenshots: `docs/handoff/in-game-command-surface/` (JPEG, quality 80), desktop and 390 px, for
  the menu and the characters, countries, explore, missions and wallet panels.

## Known rough edges

- The Callings panel lays its cards in four narrow columns inside the docked panel; they read, but the layout is
  built for a wide page and wants a pass of its own.
- On a phone a nameplate can pass behind the place card (cosmetic).
- A parallel branch for one global map and a branch for visual slice 2 also touch `server.js`'s static table and
  `scripts/visual-capture.mjs`; expect a trivial conflict in each.
