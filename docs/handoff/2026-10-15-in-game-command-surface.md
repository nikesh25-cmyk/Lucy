# In-game command surface — 2026-10-15 (UNFINISHED: usage limit reached)

Branch `feat/in-game-command-surface`, worktree `work/command-surface`, cut from `feat/visual-upgrade-slice-1` at `7eb15fb`.
UI only: no schema, route, memory or vault change (the only server.js edit is two static-file entries).

## Built
- `src/ui/command-deck.js`: one catalogue of all sections (label, group, purpose, what an agent does there), menu groups, search filter, dock/sheet rule.
- `app.js`: in the game presentation `state.tab` is always `world`; `setTab()` routes sections to `state.gamePanel`; `openSection` opens a panel (`openedGamePanel`), `renderView` leaves the WebGL scene alone when only the panel changed (`worldRenderKey`). World menu has a "Find a section" box; `M` opens the menu; Esc closes menu → drawer → panel; panel and chat/More drawer share one slot.
- `index.html` panel host, `game-panel.css` (dock ≥1280px: world narrows; sheet below: world shortens; compact HUD keeps aim/feedback/prompt as visually hidden live regions; no motion defined), `server.js` static entries.
- `scripts/command-surface-audit.mjs`: opens every section in real Chrome (desktop/phone/tablet); all 24+ sections passed at 1440, 390 and 1024, W-key walk works with a panel open.
- `tests/command-deck.test.js` (9 pass); four existing tests re-pointed at the catalogue (guilds-http, cooperative-http, newcomer-journey, quests-http) — those 5 files pass.
- Browser scenario `in-game-command-surface` added to `scripts/browser-suite.mjs`; docs updated (GAME_INTERFACE, CONTROLS, MOBILE_ACCESSIBILITY, GAME_EXPERIENCE). `visual-capture.mjs` gained menu/panel shots.

## Not done / not verified
- Full `npm test` was run once before the last test fixes: 1065/1069, the 4 failures were then fixed and re-run in isolation (pass); a final full run is still needed. `npm run check` passed (102 files).
- The new browser scenario was started but its result was not read; the other real-Chrome scenarios (signed-in-game-play, game-shell-entry-and-continue, first-ten-minutes, phone-conversation, game-hud-interaction-prompt-and-aim) were NOT run. Expected to need edits: `world-sound-controls` step 3 (opening Guide no longer stops the world sound) and any game scenario asserting a section replaces the world.
- Before/after screenshots were captured to /private/tmp/claude-501/final (before-* from 7eb15fb, after-* from this branch) but not copied into docs/handoff/ or converted to JPEG.
- Governance sections stay behind /manage in the menu (existing test); buttons elsewhere open them as panels.
