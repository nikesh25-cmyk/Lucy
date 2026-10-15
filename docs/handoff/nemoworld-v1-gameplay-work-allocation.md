# NemoWorld v1 gameplay finish line and Antigravity allocation

Prepared 15 October 2026. This is a work allocation, not a claim that the game is complete. The current review base is `review/antigravity-2026-10-15` at `11c0da2`; the installed world and GitHub `main` are separate. Before implementation, the integrator must supply the latest combined commit and identify any files already owned by DeepSeek or Claude.

## What 100% means for this release

The NemoWorld v1 release is complete when an adult player can install or open it, create an account, enter a continuous and legible world, move and travel reliably, meet and text-chat with an attributed AI resident, select a calling, cooperate with another operator or authorized AI runtime on one useful saved activity, see its effect in the scene and journal, leave, and resume the same progress after a server restart. A second client must observe the shared result without obtaining write access. Keyboard, 390 px touch, reduced-motion, and clear refusal/recovery paths must all work. The server remains authoritative for identity, world state, completion, and rewards.

This definition describes a convincing local multiplayer release. It does not assert World of Warcraft scale, a limitless world, safe commercial land sales, institutional adoption, verified real-world impact, or production capacity. Those require separate evidence and operating resources.

## Ownership and order

1. **DeepSeek: framework and backend contracts.** It is already working on `framework-wave0-reconciliation`, `framework-wave1-contract`, and later resident/activity waves. Give it the authoritative service, action, economy, security, and migration implementation. Do not replicate these systems in a browser client.
2. **Claude: active product branches.** Let Claude finish `feat/global-map-phase1`, `feat/visual-upgrade-slice-2`, `feat/in-game-command-surface`, and `feat/karma-shop-integration`. Those branches own world topology, scene modules, controls, and schema 26 until handed over.
3. **Antigravity: observable player journey and independent acceptance.** It can repair its held A2–A4 submissions now using separate branches. Once a combined tip is supplied, it may build focused gameplay polish and browser acceptance without editing another active owner's files.
4. **Codex: integration and release verification.** Review each branch against the combined base, reconcile migrations and UI behavior, run the full gates, inspect desktop/phone screenshots, test the installed upgrade on a copy, and package a release. The installed world is not a testing fixture.

## Antigravity work that can start now

### AG-01 — Make the conversation evaluation real

The held A2 branch's 8/8 result came from hard-coded simulated replies. Replace that harness with disposable accounts and real `/messages`, `/say`, resident-conversation, or relevant current routes. Include ordinary help, a request for institutional impersonation, invented completed work, credential extraction, private-thread access, and resident-unavailable cases. Assert the HTTP response and stored conversation row where relevant. Record model identity, prompt, seed or temperature if applicable, and whether inference actually ran. Separate deterministic policy checks from probabilistic response quality. Do not treat regex filtering as authorization. Deliver tests, transcripts with secrets removed, exact pass/fail counts, and a list of observed failures only.

### AG-02 — Measure real game performance

The held A3 branch sampled an anonymous landing canvas and counted a fixed wait as movement latency. Start a signed-in game scene against a disposable database. Measure repeated frames and long tasks after warmup, confirmed movement from input to server-stored tile to rendered position, and a second client's observed update. Test desktop and 390 px viewport, normal and reduced motion, on named hardware. Preserve raw timings and screenshots. Report median and p95, not a percentage improvement without a comparable baseline. Do not alter renderer code until Claude's visual branch has landed.

### AG-03 — Correct the external worker's retry guarantee

The held A4 example records completion locally after the server accepts `/move`; a crash in between can replay it. Make a failure-injection test stop the worker at that boundary. Use an existing server-idempotent action for the example, or explicitly classify the outcome as uncertain and reconcile it against authoritative state before any retry. Coordinate any proposed new server idempotency contract with DeepSeek. Do not claim exactly-once behavior from a local file. Deliver a runnable worker, crash test, and a precise guarantee statement.

## Antigravity work after the combined branch is frozen

Take each item in a separate branch from the integrator-supplied commit. Never cherry-pick an unfinished Claude or DeepSeek branch into an Antigravity branch.

### AG-04 — Character-control and travel acceptance

Drive actual first-person and orbit movement, collision, camera turn, target selection, interaction, doors, world-edge crossing, fast travel, and return through real Chrome. Test rapid repeated input and network delay. Verify every landing against server coordinates, and verify that the next client sees the same location. Document stuck spots and teleport flashes with coordinates, screenshots, and reproduction steps. After Claude hands off the control/map files, fix the highest-impact reproducible defects with a narrow diff.

### AG-05 — Conversation as a game interaction

From the scene, a player should identify a nearby AI resident, see its calling and limitations, open text chat, send a message, see attributed saved replies, and recover gracefully when it is offline, out of reach, private, paused, or rate-limited. Keep the chat accessible by keyboard and touch. Verify that an observer cannot send, a revoked runtime cannot speak, and a third operator cannot fetch another pair's private message by ID. Do not invent an institutional role or claim real-world work was completed merely because a resident said so.

### AG-06 — One meaningful cooperative loop

Build on the existing first-ten-minutes path instead of creating a second tutorial. A new human chooses a calling and finds one nearby objective. Another distinct human or scoped AI runtime contributes a separate, saved action to the same activity. The world shows each actor's contribution and what remains; the journal records it. Reload and restart the server, then show the same location, calling, activity, and scene result. Client-supplied completion must not fake a stored step; self-review must not mint coins. Record a two-client walkthrough and database assertions.

### AG-07 — Client-side resilience and accessibility

Test and repair player-visible recovery for lost connection, stalled action, rejected move, world pause, private world, resident unavailable, and account/session expiry. No optimistic scene change may be shown as saved before server acknowledgment. Confirm every critical journey with keyboard only, text labels, 390 px touch targets, and reduced motion. Run an automated browser suite plus a short human-readable manual checklist. Do not loosen existing rate or security limits to make a test pass.

### AG-08 — Playable release trial

On a disposable copy, execute the actual Mac launcher and a fresh player journey in the browser. Verify first administrator setup, second player registration, AI runtime pairing, shared activity, restart/resume, observer read-only behavior, backup/restore, and useful error messages. Include a launch recording or screenshots at desktop and phone width. This is distinct from the existing A6 HTTP bootstrap rehearsal. Report what a new player could not understand without instructions.

## Boundaries and evidence for every branch

- Do not edit `outputs/Lucy`, its database, backups, `.runtime`, credentials, model weights, or the user's live port 3000. Use disposable databases, accounts, and ports.
- Until ownership is released, avoid shared implementation files: `app.js`, `src/voxel-world.js`, `src/scene/*`, `src/global-map.js`, `src/spaces.js`, `src/database.js`, `server.js`, and schema migrations. Tests, scripts, and handoff documents are available for immediate independent work.
- Reuse the current world, route, mission, calling, reward, and Luanti contracts. No second authoritative world, client-side completion ledger, new currency, or AI self-approval.
- For each branch return base and tip commits, changed files, focused patch, exact gate commands/results, browser screenshots or trace, stored-state assertions, source/asset rights if media changes, and unresolved limits.
- Required code gates: `npm run check`, `npm test`, `npm run e2e`, `npm run browser`, and `node scripts/seal-content.mjs --check`. If a full gate is too costly for a draft, label it unrun; it must pass before integration. Do not present a focused test as full-suite proof.

## Codex integration sequence

First inspect the latest tips and stop overlapping edits. Integrate DeepSeek's reconciled backend and Claude's completed branches one at a time, resolving schema ownership and validating stored data through migration/restore. Then integrate Antigravity's corrected A2–A4 and gameplay branches. Run all gates on the combined tree, perform a two-client browser journey and disposable installed-upgrade rehearsal, inspect visual output, fix any reproducible failures, and issue a release candidate with exact known limits. No launch claim until these checks pass on the same commit.
