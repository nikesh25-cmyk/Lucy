# Native AI City Implementation Plan

The owner explicitly requested completion of the in-game city and delegated decisions while AFK. Extend the approved `specs/2026-10-17-ai-city-design.md`; execute inline and in isolated file domains. Preserve existing Harr, human accounts and private plots.

## Shared integration contract

NemoWorld stores city life in its existing link-extension database. Veloren projects and moves city citizens as server NPCs, with no extra game clients or resident credentials. The existing signed command channel and acknowledgements connect them. This is scripted game AI, not a claim of autonomous model research.

**Command `city_actor`:** strict JSON arguments `{id,name,stage,target,activity,revision}`. `id` is `city-[a-z0-9-]{1,32}`; name 1–40 visible ASCII letters/spaces; stage `adult|child|student|apprentice`; activity `build|office|farm|school|home|social`; revision nonnegative safe u32. `target` must be one of the configured `city-*` landmarks below. No raw coordinates or item IDs. At most 16 simultaneous city NPCs. `player_uuid` is reserved city-service principal `00000000-0000-4000-8000-000000000001`, never a human account. Existing signature, expiry and at-most-once handling remains authoritative.

**Native meaning:** spawn/recover a peaceful resident; move along checked ground toward the named configured landmark; acknowledge applied only after actually reaching it (within 5 blocks) and spending at least 5 seconds there. Rejection/expiry is not progress. Revision guards reject old plans. The native system stores admitted actors beside the outbox so restart restores them; it does not own marriages, education or job history. Provide `NemoCityState::workers_near(x,y,radius)` from actual current positions for construction crews. Never add guest players to AI-only construction crew counts.

**Landmarks:** `city-arrival`, `city-homes`, `city-build`, `city-office`, `city-farm`, `city-school`, `city-university`, `city-park`, and `city-home-1` through `city-home-4`. They resolve through the existing configured site/plot/dx/dy mechanism. City layout is an additive district north of Harr: Plaza-relative centre `(0,220)`, about 140×100 blocks, connected by a protected walking route. Parent integration surveys actual generated terrain and checks overlap with existing native cottage pads and saved work footprints before enabling it. No expansion of the finite private land registry.

**Node exports:** `CITY_SCHEMA` (link extension schema version1), `NativeCityService(link,platform,{enabled=false,recordPath,clock=link.clock}={})`; methods `tick()`, `overview()`, `actorPlans()`. Own only new `city_*` tables. Existing rows/tables are read through published platform/link APIs; no second land/coin/claim ledger. Parent wires extension, timer and UI. Seed at most eight new adult citizens with new IDs and operator-preapproved fictional household preferences; do not rewrite old residents as children or invent past marriages. No process/credential automatically starts for births. Max16 simulation citizens.

**Progress:** schedule one pending command per actor. Persist job intent and issued command; use `link.commandStatus` to recognize arrival only. Actual construction completion additionally reads a new city manifest group from the native world record. Office work saves a labelled city report citing observed saved public-work/research facts; never substitutes for real mission submission or independent review. Farm output is an explicit virtual city harvest, separate from the legacy pantry's scripted stock and every currency. School attendance and deterministic source-backed exercise assessment are separate records; age alone grants no competence. All outputs idempotent across retries/restart.

**Family:** two distinct adults with preapproved participation must both complete a native social/home visit before marriage is recorded. Child admission requires married household, a completed city home, bounded allowance and at most one child per founding household. Record birth/adoption when admitted, with new ID; never backfill. New child becomes a student after 10 minutes of accumulated open simulation time, not wall-clock absence. Three assessed native school visits allow apprenticeship; adult career requires further assessed work. Family relationships convey no permission, shared secrets, money or compute authority. No coins for simulation milestones.

**Geometry files:** generator `tools/gen-native-ai-city.py` produces separate `content/veloren-ai-city.json` (world manifest groups), `content/veloren-ai-city-projects.json`, `content/veloren-ai-city-landmarks.json`. A pure composition step merges these with the existing Harr manifest/catalogue/config; never hand-edit existing generated content. Modern civic buildings using the existing pale-stone, coloured-panel and window-sprite palette (no new transparent glass or metal block types), wide public streets, office interior, school/university classrooms, residential homes, small farm/greenhouse and park. Every entrance and road must be traversable. Stage buildings with AI-only crews rather than make decorative work loops stand in for actual construction.

## Tasks and ownership

- [x] Persistent city life: `src/veloren-ext/city-life.js`, optional `city-life-*.js`, `tests/veloren-city-life.test.js`. No registry/server edits by its builder.
- [x] Native actor controller: Rust `server/src/sys/nemo_city.rs`, optional `nemo-link-proto/src/city.rs`; native module/resource wiring and minimal link landmark accessor. Do not edit world dressing or home modules. Tests use failing-first parsing/revision/arrival/restart cases; one compile owner only.
- [x] City geometry: generator, three new city content files and `tests/native-ai-city-content.test.js`. No existing generator/manifest edits. Geometry must pass existing validator and footprint tests.
- [ ] Parent integration: compose manifests, AI crew wiring in Rust world dressing, Node extension/timer/life overview, guide pages, private home construction staging where compatible, operational install/rollback.
- [ ] Test real native server with temporary world and command files; observe actors, work stages, school/social arrivals, persisted outputs and restart. Then compile/install safely, preserve existing world, inspect real game visuals. Report source counts and residual limits explicitly.

## Resource and release constraints

- Current local model stays off unless already enabled; no new API account or purchase.
- No broad process cleanup, no edits to `outputs/Lucy` or live data from builders.
- Only one Rust compilation at a time using the existing integration target cache.
- A native observation test is not a GUI playthrough; record each accurately.
- Existing human guest home claims stay owned and protected. New district residences belong to the simulated city, never invent private land deeds.

## Integration findings

Real native tests refused the original blanket clearing: clearing and foundation columns count toward native work budgets. Compact geometry now uses 59,505 of 60,000 cells across 359 combined groups, including 55 city groups. JavaScript now mirrors unique native cell accounting. No budget was raised.

Actual terrain climbs from 411 to 429 along the approach. Public paths project onto measured natural columns, bounded to ±12 and the existing vertical window; saved grade and saved compatible ground datums prevent restart drift and roof stacking. City construction counts actual native AI workers near the doorway datum, never guest/bridge Players. Native foliage cannot be a citizen's support floor.

Private guest cottages retain the existing validated fixed-style build path. This city release adds genuinely staged public family homes; it does not implement arbitrary AI-generated private home architecture. GUI verification is currently blocked by the locked Mac, separately from the real native server gate.
