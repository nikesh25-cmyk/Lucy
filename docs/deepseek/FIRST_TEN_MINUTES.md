# DeepSeek brief: the first ten minutes of play

Use this brief without a task number. Existing Tasks 15–38 have delivered code and must not be recreated. Start from the current integrated `integration/nemoworld-completed` tip after the integrator supplies its final commit. Work in a separate branch and return a patch; never edit `outputs/Lucy`, its database, backups, `.runtime/`, credentials or model weights.

Build one coherent first-play journey through systems the game already has. A new adult human player should enter, understand where they are, meet a visible AI resident, choose a calling, find one nearby useful action, and cooperate with another human or AI resident on one saved restoration step. Show the effect in the scene and journal, then let the player leave and return to the same place, state and shared result. The path must make a real stored action feel meaningful within about ten minutes, without pretending that a demonstration task is real-world impact.

The shell already has Play / Observe / Continue, first-person and orbit cameras, a five-action HUD, character overlay, drawers, direct interactions, finite construction, sound controls and a separate `/manage` route. The backend already has quests, callings, a cooperative restoration event, reviews, independent coin awards and persistence. Reuse them. Put only the next local action and a short reason on screen; keep research, review, moderation and diagnostics in the workspace. Do not add a new reward currency or grant an AI authority to review itself.

Deliver these slices:

1. A clear, optional in-world guide for the first ten minutes: one task at a time, with a nearby target, accessible text, and a way to dismiss and resume it. Derive progress from server records; do not let local storage claim completion.
2. A visible AI resident encounter that states its calling and limitations honestly, offers a safe conversation or collaboration action, and cannot impersonate an institution or invent completed work.
3. A shared restoration scene where two distinct actors' saved actions produce a persistent visible change. The interface must explain which step each actor completed and what remains.
4. A return flow that restores location, selected character, camera choice and current purpose after reload or restart. Include a useful refusal and recovery path when the world is paused, private, or the resident is unavailable.
5. Keyboard, text and 390-pixel touch equivalents. A reduced-motion user must see the same confirmed outcomes. Keep the original art direction and verify licence/provenance before adding any asset.

Acceptance evidence: run `npm run check`, `npm test`, `npm run e2e`, the sealed-content check, and focused real Chrome scenarios on disposable accounts and a temporary database. Include a two-client browser walkthrough with one human and one AI runtime or two independent human operators, database assertions for each action and restart persistence, screenshots at desktop and phone size, and exact pass/fail counts. Test that anonymous observers cannot act, a revoked runtime cannot continue, self-review cannot mint coins, and a client-supplied completion cannot fake a saved step. Do not delete coverage or loosen limits to make a gate green.

Return the branch base and tip, changed files, one focused patch, source/asset rights, test commands with actual results, a short visual walkthrough, and residual limits. State plainly that this is a tile-based local multiplayer prototype, not World of Warcraft scale, commercial land ownership, institutional adoption or live production capacity.
