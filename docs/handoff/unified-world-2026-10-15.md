# Unified NemoWorld integration — 15 October 2026

## Source and scope

Branch: `integration/nemoworld-unified-2026-10-15`. Installed starting point: `27063ae`.
The first reconciliation and product repairs are committed as `048a503`, `e87f3c4`, `38484cf`,
`630dcbf` and `4100cee`. Later completed candidates are listed below; ongoing work in their original
worktrees was not copied or modified.
This document is a release record for the local multiplayer prototype, not a claim that the full
public-launch or MMO vision is complete.

The integration preserves the installed Claude shop, vault, command surface, character art,
community seeding and visual upgrades, while adding all eight delivered DeepSeek framework waves
and the reviewed Antigravity work. The connected global map is now included. Branch ancestry was
checked, rather than inferring integration from the existence of patch files.

| Delivered source | Reviewed tip included |
| --- | --- |
| Antigravity review | `0add8b8` |
| Framework reconciliation | `1246bfe` |
| Framework write contract | `ef0bfcc` |
| Shared world and viewport | `a920705` |
| Resident lifecycle | `f8967d3` |
| Activity and evidence | `d1fb10d` |
| Economy | `d78dc0d` |
| Cooperative content | `53cbc40` |
| Reliability | `f9961ac` |
| Home and vault interface | `5623550`, merged as `35199cf` |
| Global map phase 2 | `2efce19`, applied as `79c38e0` with the bounded map reader retained |

## What the integration repairs

- The game shows one primary next action. Location/reason and people/progress remain available in
  optional native disclosures. Their open state, keyboard focus and dismiss/resume behavior survive
  guide refreshes; only server records complete a step.
- Home shows the selected resident's saved calling and purpose, garden and cottage access, and the
  server's actual privacy settings. Build waits for confirmed home travel and the correct palette.
  Opening a cottage first enters its garden and walks to its real doorway; it does not ask the
  server to bypass the physical entrance. Stale sessions and failed travel cannot arm a placement.
  A newer workspace section or game panel also survives a travel refresh finishing afterwards.
- The shop refreshes for the current account/resident and rejects stale asynchronous responses.
  Karma, independently reviewed NemoCoin and real-world money remain separate.
- Home metadata is cleared on logout and bound to its operator, session and panel revision. Late
  reads or mutations cannot repaint a different account. Home loading has two resident workers,
  making at most six metadata requests at once. Humans have independent garden/cottage visiting
  controls; private vault operations remain AI-only. Erasure wording acknowledges retained backups.
- Humans and scoped AI runtimes use the same saved positions across district seams. Local and
  global coordinates are kept distinct. Fixture interactions across a seam fail with useful next
  steps until supported, instead of subtracting incompatible local coordinates.
- The game now uses the bounded map reader, prioritizes the viewing resident under crowded caps,
  and retains the public calling/cosmetic metadata needed to draw neighbouring residents. Reading
  civic state no longer advances NPC patrols.
- All 23 outdoor regions now connect within the same fixed 288 × 208 extent. The original nine
  region origins and every stored local position are retained. Signposts and bounded journey legs
  reuse authoritative walking; interiors, homes and the frontier keep their existing entrances.
- Resident intents retain stable retry identities through refusal floods; malformed and applied
  receipts are distinguished. Evidence traces cannot attach an unrelated capture supplied by the
  caller, and requested source versions are respected.
- Diagnostics remove free-text narratives as well as credential-like fields.
- Richer connected terrain stays within the existing 3,600-instance renderer budget by reducing
  distant, unpicked ground/water decoration. Picked surfaces, fixtures and obstacles are unchanged.
  At dense junctions, compatible opaque terrain boxes share a material with exact per-instance
  colours, preserving every matrix and pick while leaving room in the 130-scene-batch budget for
  mixed resident appearances and night lighting. Transparent and emissive styles remain separate.
- The observer minimap resolves global clicks into the selected district's local coordinates;
  empty sea does not invent a destination. Player walking and indoor minimaps keep their behavior.
- Real-engine smoke tests use temporary loopback UDP ports and bounded process cleanup. An engine
  that has already exited cannot leave a harness waiting for its past exit event. Log overflow
  fails explicitly; diagnostic redaction does not alter the raw evidence used by security checks.

## Data compatibility

Current schema: **27**. Legacy schema-24/25/26 crop/block constraints are widened transactionally to
the sealed definitions. Existing rows, rowids, indexes, triggers, views and references are retained.
Unknown kinds and same-version schema drift are refused. An injected interruption after the first
table rebuild proves rollback rather than leaving a partly migrated world.

A rehearsal on a copy of the previously verified schema-24 installed backup preserved all **28,123
rows across 70 existing tables**, including four accounts, while migrating to 27. The current live
schema-26 world still requires a fresh stopped-server backup before installation.

## Verification

The complete integration gates below ran against `1108d9d`. Node **24.19.0** is used explicitly,
including for native SQLite support. The small subsequent frontend cleanup and its focused checks
are recorded separately, so those results are not attributed to an earlier tree.

| Gate | Independently executed result |
| --- | --- |
| `node scripts/check-syntax.mjs` | 132 files, zero failures; changed native files also checked separately |
| `node --test --test-concurrency=3 --test-reporter=tap` | **1,456 passed, zero failed, cancelled or skipped** |
| `node scripts/e2e-smoke.mjs` | **20/20** |
| `node scripts/ops-rehearsal.mjs` | **8/8** recovery/failure drills |
| `node scripts/seal-content.mjs --check` | **136 definitions**, 3 support files, 42 referenced notices/assets |
| `node scripts/browser-suite.mjs` | **49/49 real Chrome scenarios**, including the Home/vault UI and dense-map GPU check |
| Real Luanti 5.17 server callbacks | **3/3**: build/movement/restart reconciliation; mission retry/restart/revocation; recipient-isolated conversation |

The Chrome GPU fixture at global `(95,71)` actually selected the new colour-batching path with three
distinct character appearances. It rendered without shader errors, reducing 145 unbatched scene
batches to **41 by day / 45 at night**. The night capture was visually inspected; foliage, trunks,
water and character colours remained distinct. This is a rendering fixture, not a saved project
or a capacity benchmark.

### Final frontend polish

`98918ea`, `c78a4f4` and `5365702` shorten ordinary game hints, preserve exact blocked/refusal
messages, put detailed controls behind optional help, and leave six movement/look controls beside
the five-action phone HUD. Standalone touch components and the detailed workspace keep their
existing behavior. Camera selection remains accessible.

Chrome caught the pad measuring a detached HUD as zero height, and then a two-pixel overlap caused
by the HUD's bottom inset. The final geometry waits for a connected current map, ignores stale
session/resident callbacks, refuses zero-height measurements and includes the real bottom inset.
Strict hit testing was retained. The final phone check measures **11 distinct controls**, each at
least 44 px, all reachable and clear of the HUD; real taps save the expected tile and yaw.

Independent final-polish checks: **99/99 focused Node tests** and **10/10 affected Chrome scenarios**,
including the game shell, touch play, first person, interaction/refusal hints, building HUD, phone
chat, management panels and shared seam/restart/GPU journey. The complete 1,456-test and 49-scenario
runs above preceded this frontend-only cleanup; they are not presented as reruns of a later tree.
Backend, schema and sealed definitions are unchanged by this polish.

The first complete Chrome run reported 43/48. The failures were investigated: the shop drawer now
closes itself after Home travel; the living-world tick can independently seed a farm or post a
message; closed native disclosures have a different focus order; and the suite left old 3D scenes
running until later two-client setup exceeded its existing deadline. The repaired harness verifies
the exact causal records, tests disclosure activation, freezes reusable operator pages, unloads
finished one-off scenes, reactivates every participating client together, and retires failed contexts.
An attempted same-character shortcut was reverted because it failed to leave visitor mode, and the
restoration journey exposed the actual late-travel navigation race now covered by six asynchronous
tests. No permission, reward, rendering,
movement or timeout limit was raised. A focused run subsequently passed the shop/cottage loop,
observer refusals and shared-world seam/restart scenario, 3/3.

A later shared-machine run completed 26 Chrome scenarios before the browser disconnected; the
remaining scenarios in that run did not execute successfully. Three backend workers also exited
without a failing assertion. Their unchanged files passed 33/33 cases in isolation, and the final
complete backend rerun above passed 1,456/1,456. These interrupted runs are not counted as release
passes. Final gates are run one heavy job at a time on this task; other agents' processes are left
untouched. Neither test coverage nor permission, reward, rendering, movement or timeout limits were
relaxed.

## Limits and next evidence

- This is a tile-based local multiplayer prototype with a native Luanti bridge. It is not World of
  Warcraft scale, commercial land ownership, institutional adoption or demonstrated production capacity.
- Scripted community residents and connected model runtimes are distinct. A character's presence
  does not establish that an inference worker is active, and runtime credentials do not supply a model.
- Existing asset licensing/provenance is retained. Staged meshes and HDRIs are not all rendered.
- Native verification uses real Luanti server/mod callbacks; a native GUI playthrough was not automated.
- Public hosting, an independently stored encrypted recovery copy, operational staffing and a real
  beneficiary pilot still need evidence and decisions beyond a green local build. Earlier capacity
  measurements remain historical; this release does not claim a newly measured MMO capacity.
- Observers remain read-only; private messages/memory remain scoped; a resident cannot review itself
  or create independently reviewed rewards by claiming completion.

## Rollback

Keep the matching old source, installed-source manifest and validated **pre-upgrade** database
backup together. Stop the launchd job before backup, migration or restore, and preserve `data/`,
`.runtime/`, private configuration, credentials, model weights and any vault key. Restore the old
database and matching source together: old schema-26 code cannot open a schema-27 world.
See `docs/OPERATIONS.md` for the saved launchd job and recovery CLI procedure.
