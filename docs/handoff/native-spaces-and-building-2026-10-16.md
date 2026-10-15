# Native lag, building and world access repair — 16 October 2026

Base: `8ea65b3`, branch `integration/nemoworld-unified-2026-10-15`.

## Confirmed findings

- A walking tile required twelve bounded world reads and reconciliation before releasing movement. It also zeroed horizontal velocity on every tile. This imposed stop-start motion even when the saved move succeeded.
- The live character stood on a protected public corridor with no chosen plot. The nearest available plot shown in its menu was outside immediate building range. Materials in inventory did not make that ground buildable, and the client did not guide the player there.
- The bridge explicitly rejected non-frontier worlds, and the renderer assumed 48×48 dimensions. Commons, districts, rooms and gardens could not be visited natively. Opaque native boundary walls made that limitation look like a closed arena.
- Concurrent builds saturated this Mac (observed load averages approximately 59 on ten cores). Other agents were left running as instructed. Only this checkout's regression-runner priority was lowered.

## Delivered

- One authorized world read per scene refresh, replacing twelve. Ordinary walking applies the existing small movement receipt immediately. It retains normal horizontal/vertical velocity, and unchanged terrain is omitted from subsequent scene responses.
- A bounded 37×37 block viewport merges into a native cache. Server rows remain authority; distant cached blocks refresh when revisited. Main API/scopes/database schema are unchanged.
- Guided walking after explicit free-plot choice, a return-to-plot button, a visible plot outline and camera direction toward a clear adjacent building cell. Each step is saved through the existing movement route; each build/removal still uses the existing land/grant/range/cooldown rules. No coins are minted.
- Inventory buttons **Build and plot** and **Travel and places**, plus `/nemo_build` and `/nemo_travel`. Entrances, owned gardens and frontier gates are sourced from the authorized world response. The guide walks to a door before calling the existing travel route. A movement key cancels. Closed frontier neighbors require the explicit existing expansion action at the gate.
- Commons (96×64), districts, rooms and gardens now render as authorized native spaces, one at a time. Terrain/objects use existing verified textures and schematic native geometry. Obsolete enclosure walls are removed. Static definitions are used only after an authorized world read succeeds; private access and paused/revoked actors remain refused.
- A real-engine failure under load exposed a guide queue bug: an HTTP 429 advanced the route index without a saved step. The queue now advances only after acceptance and retries that same step after a real-time delay, without loosening the backend limit. A deliberately injected 429 is part of the engine journey test.

## Evidence

- Red before the read change: new integration assertion expected one world read and observed twelve.
- Red before the speed fix: real-engine assertion `ordinary walking must not zero horizontal velocity on every saved tile`.
- Real API integration: choose land, plan a walk from the public crossroads, save every step, place a real block, refuse travel far from a doorway, enter Commons through its real portal, load full dimensions, visit the owned garden, return, refuse another operator's private home, mint no coins.
- Real engine: native account sign-in/return, saved placement/punch removal, guided walking from the crossroads onto the plot, a deliberately refused movement and retry, walking to the actual Commons doorway, full 96×64 Commons floor and absence of the obsolete 48-wide wall.
- Existing native arrival, world/gate/restart, mission and private-message probes also pass. These callback probes use a synthetic player; GUI evidence is recorded separately if completed.

## Limits

This is a tile-based local prototype, not an MMO or seamless rendering of all regions at once. Native models are schematic, not asset parity with the browser. Native block building is for frontier land; browser home furniture editing and some activity interactions are not exposed as native controls. Remote residents refresh on the existing five-second poll. The native bridge still supports one active local player connection. No deployment, purchase, main-branch merge or inferred institutional role is included.

## Verified gates

- `npm run check`: 132 files, zero failures.
- `npm test -- --test-concurrency=3`: 1,472 passed, zero failed/skipped; 544 seconds with concurrent machine load.
- `node --test native/*.test.mjs`: 16 passed, zero failed.
- Sealed-content check: 136 definitions, three support files, 42 notices/assets.
- Six pinned Luanti 5.17 probes passed: onboarding, controls, navigation (including injected 429), world/build/restart, missions and conversations.
- Actual desktop mouse/keyboard placement is not established by these synthetic-player probes; installation and a GUI check follow.
