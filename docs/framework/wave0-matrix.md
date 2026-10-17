# NemoWorld Wave 0 Reconciliation Matrix

- **Provenance header.** Verified base: `feat/world-life` @ `27c0d72` (`27c0d7297f97c4cd6d2ee157cc80ff931bf35c89`), database schema 25 (`src/database.js:178` `PRAGMA user_version=25`).
- **How it was produced:** by reading the code, tests and handoff documents at that revision — every `path:line` below is resolved at `27c0d72`; nothing is inferred from a module name, a route name, a doc title or a roadmap item.
- **Coverage:** 113 capability rows across 7 areas (Area 1: 20, Area 2: 24, Area 3: 13, Area 4: 13, Area 5: 15, Area 6: 14, Area 7: 14).
- **STATUS vocabulary:** the source reports define **five** values, of which **three occur** in this file; the Wave 0 brief's "seven STATUS values" is not supported by the source reports and is recorded as a finding rather than invented here.
- `IMPLEMENTED+TESTED` — the behaviour exists at `27c0d72` and a named test exercises it (86 rows).
- `IMPLEMENTED-GAP` — the behaviour exists but carries a named defect, an untested path or an unowned seam (24 rows); `IN-CLAUDE-BRANCH` — it exists only on another agent's branch, not at `27c0d72` (3 rows).
- `NOT-IMPLEMENTED` — no such behaviour at `27c0d72`; `UNVERIFIED` — code, tests and handoffs could not settle it (neither value occurs in this matrix).

**Verified base:** `feat/world-life` @ `27c0d72` (`27c0d7297f97c4cd6d2ee157cc80ff931bf35c89`), database schema 25.
Every row below was produced by reading code, tests and handoff documents at that revision, so all `path:line` citations are relative to `27c0d72`.

Rows use the format `capability | STATUS | route(s) | storage owner (module + table) | test evidence | gap | owner conflict`. STATUS values are reproduced verbatim from the source reports: `IMPLEMENTED+TESTED`, `IMPLEMENTED-GAP`, `IN-CLAUDE-BRANCH`, `NOT-IMPLEMENTED`, `UNVERIFIED` (only the first three occur in this matrix). Where two reports covered one capability the rows are merged into a single row in the earlier area, the capability name carries the merge note, and both citation sets are preserved.

---

## Area 1 — Accounts, sessions, identity, permissions, ambassadors

account registration & policy | IMPLEMENTED+TESTED | POST /auth/register; GET /bootstrap; POST /operations/registration | platform.register/registrationPolicy (accounts,invites,settings) platform.js:146-186 | tests/initial-registration.test.js:8; tests/human-players.test.js:15,38; tests/hosting.test.js:54 | setup code required only when `first && this.publicMode` | none
human login + session cookie | IMPLEMENTED+TESTED | POST /auth/login | platform.loginToken (tokens kind=session) platform.js:195 | tests/http.test.js:44,52; tests/hosting.test.js:99 | fixed 7-day expiry, no rotation | none
logout | IMPLEMENTED+TESTED | POST /auth/logout | platform.logout (tokens.revoked) platform.js:1338 | tests/http.test.js:58; tests/realtime-channel.test.js:190 | revokes only the presented token | none
expired/revoked cookie recovery | IMPLEMENTED+TESTED | any | server.js:536-539 (X-Lucy-Session); browser-session.js | tests/browser-session.test.js:2,6; docs/SESSION_RECOVERY.md | scope 403 is not downgraded | none (owns browser-session.js)
account suspend / role change | IMPLEMENTED+TESTED | POST /operations/accounts | platform.accountControl (accounts,tokens) platform.js:953 | tests/platform.test.js:230,348; tests/expansion-http.test.js:174; tests/coin-abuse.test.js:122 | cannot change own status | none
runtime credential issuance | IMPLEMENTED+TESTED | POST /runtime/start | platform.runtime (tokens kind=runtime) platform.js:301 | tests/platform.test.js:24; tests/http.test.js:70 | one active runtime per operator platform.js:305 | none
runtime-vs-operator 403 gate | IMPLEMENTED+TESTED | all | server.js:541 | tests/http.test.js:77 | route list hardcoded | DUPLICATES role() platform.js:36
scope table (read/move/chat/contribute/build/vault) | IMPLEMENTED+TESTED | writes Map + dynamic | server.js:126-176,483,534; platform.runtime:309 | tests/runtime-policy.test.js:17; tests/agent-actions.test.js:63 | GET⇒'read'; /runtime/status scope=null | none
budget / expiry / charge | IMPLEMENTED+TESTED | all writes | platform.charge/authorize (tokens.used_calls) platform.js:210-228 | tests/http.test.js:70 (429); tests/platform.test.js:24 | 80% warning is audit-only | none
agent pause / revoke | IMPLEMENTED+TESTED | POST /agents/control | platform.agentControl (agents,tokens) platform.js:287 | tests/platform.test.js:202; tests/realtime-channel.test.js:183 | `suspended` only liftable by moderator | none
per-operator agent caps | IMPLEMENTED-GAP | POST /agents | platform.createAgent platform.js:255 | tests/human-players.test.js:49 | 5-agent / 1-human 429 has no dedicated assertion | none
resident identity ownership | IMPLEMENTED+TESTED | /agents/:id/*; /residents/* | platform.ownedAgent platform.js:272 | tests/http.test.js:70; tests/ambassadors.test.js:266 | runtime sees only its own agent | none
account export | IMPLEMENTED-GAP | GET /export | platform.exportAccount platform.js:969 | tests/platform.test.js:361; tests/http.test.js:141 | self-only; format still 'shared-world-account-v18' at schema 25 (platform.js:976) | COLLIDES with Claude karma/shop export keys (b95d218)
account deletion | IMPLEMENTED+TESTED | DELETE /me | platform.deleteAccount platform.js:978 | tests/platform.test.js:230,348; tests/ambassadors.test.js:194; tests/civic-engine.test.js:56 | irreversible redaction, no grace period | none
country ambassador directory | IMPLEMENTED+TESTED | GET /ambassadors; /ambassador | civic-engine.js:338,352 (npc_ambassadors) | tests/ambassadors.test.js:19,99 | paused rows withheld from public | none
ambassador conversation | IMPLEMENTED+TESTED | POST /ambassadors/talk | civic-engine.js:370 (ambassador_conversations) | tests/ambassadors.test.js:138; tests/ambassador-dialogue.test.js:22 | 1.5s limit; context non-overridable | none
ambassador control | IMPLEMENTED+TESTED | POST /ambassadors/control | civic-engine.js:406 (npc_ambassadors,npc_mayors) | tests/ambassadors.test.js:295 | admin/moderator; also pauses legacy guide | none
ambassadors hold no credential/identity | IMPLEMENTED+TESTED | n/a | server-side invariant | tests/ambassadors.test.js:266 | npc_ambassadors ∉ accounts/agents | invariant lives in src/recovery.js:207,211 (Claude-owned)
event subscription revoke reauth | IMPLEMENTED+TESTED | GET /events | server.js:231-353 hub; EVENT_LIMITS | tests/realtime-channel.test.js:183; tests/realtime-bounds.test.js:143 | 1s revalidate; 4 conn/account | none
country venue registers no land | IMPLEMENTED+TESTED | GET /world | civic-engine.js venue | tests/country-venues.test.js:231 | none | none

### HANDOFFS ALREADY COMPLETE
- docs/THREAT_MODEL.md — auth/sessions/runtime-credential/CSRF scope review (task 28).
- docs/SESSION_RECOVERY.md — cookie expiry/revoke recovery + client state-sweep semantics.
- docs/handoff/task-deepseek-security-privacy.md — browser-session sweep, origin checks, redaction (schema 22).
- docs/handoff/task-01-country-ambassadors.md — ambassador identity scheme + schema-15 migration.
- docs/handoff/public-launch-readiness.md — invitation-only pilot, setup code, scoped runtime worker.
- docs/handoff/task-27-operations.md; task-28-production-readiness.md — admin operations + account controls.
- Note: tests/access-statistics.test.js and country-plan/venues tests are evidence/content, not account-scope.

### UNSAFE OR DUPLICATED
- Two independent human-session guards: `role()` platform.js:36 vs `human()` civic-engine.js:112.
- server.js:541 re-lists human-only routes: `if (actor?.kind === 'runtime' && ((request.method === 'POST' && !scope) || dynamic?.action === 'home' || ['/drafts','/workers', '/me', '/export', '/operations', '/safety'].includes(route) || request.method === 'DELETE')) fail(403, 'A human operator session is required.');`
- `accountControl` audits and returns success even with no change: `this.audit(actor.account.id, 'account.updated', input.account_id); return { updated: true };` (platform.js:968).
- Legacy aliases duplicate talk/control paths: `mayorTalk`→`ambassadorTalk`, `mayorControl`→`ambassadorControl` (civic-engine.js:444,454).

### SAFE TO BUILD ON
- src/civic-engine.js, src/browser-session.js, src/ambassador-dialogue.js, src/hosting.js.
- Tests: ambassadors, browser-session, hosting, realtime-channel, realtime-bounds, runtime-policy.
- platform.js account/session/scope methods + server.js route table are unowned; `exportAccount` (platform.js:976) is the one collision point with Claude's karma/shop port. Avoid app.js, src/database.js, src/recovery.js per ownership.

---

## Area 2 — Physical world: movement, land, building, presence, spatial

Cardinal step movement | IMPLEMENTED+TESTED | POST /move, /agents/:id/climb | src/spaces.js:498 stepAgent → agents | elevation-http.test.js:61-71 | gate crossing at spaces.js:505 calls travel, untested directly | —
Travel / world entry | IMPLEMENTED+TESTED | POST /agents/:id/travel; /interact door | src/spaces.js:529 travel → agents | spaces-http.test.js:29,47; interaction-http.test.js:64 | — | —
Look | IMPLEMENTED+TESTED | POST /agents/:id/look | src/spaces.js:517 lookAgent → agents | elevation-http.test.js:76-87 | — | —
Posture | IMPLEMENTED+TESTED | POST /agents/:id/posture | src/spaces.js:640 → agents | spaces-http.test.js:33,59 | — | —
Heartbeat / presence | IMPLEMENTED-GAP | POST /agents/:id/heartbeat | src/spaces.js:634; presence derived world() spaces.js:462 | world-platform.test.js; realtime-channel.test.js:120 | heartbeat scope is `'read'` (server.js:483), so a read-only runtime refreshes `last_seen` | —
Garden/cottage build | IMPLEMENTED+TESTED | POST /agents/:id/build | src/spaces.js:561 build → world_objects; trigger src/placement-policy.js:24 | build-interface-http.test.js; world-platform.test.js | — | —
Private resident cottage / home visit settings (also reported in Area 4 as "Private resident cottage (per-resident home world, independent `house_visibility`)") | IMPLEMENTED+TESTED | PATCH /agents/:id/home (dynamic); `/worlds/:id/home` PATCH (dynamic), `build` scope | src/spaces.js:590 homeSettings → worlds; src/spaces.js:376-602 `worlds` kind `house` | world-platform.test.js; spaces-http.test.js:55; tests/agent-home.test.js; tests/world-platform.test.js (4 visitor tests) | Area 4: not a purchase; no cottage sale/transfer route exists | —
Frontier expand | IMPLEMENTED+TESTED | POST /frontier/expand | src/frontier.js:819 frontierExpand → frontier_sectors | frontier.test.js:84; frontier-runtime.test.js:3 | no HTTP-level test of /frontier/expand; only platform call | —
Frontier build/remove | IMPLEMENTED+TESTED | POST /frontier/build | src/frontier.js:837 → frontier_blocks; guard LAND_BLOCK_GUARDS:64 | land.test.js; frontier.test.js:110 | — | —
Blueprints | IMPLEMENTED+TESTED | POST /frontier/build {blueprint} | src/frontier.js:143,521 → frontier_blocks | blueprints-http.test.js; blueprints.test.js | — | —
Finite land registry (read) | IMPLEMENTED+TESTED | GET /land, /land/plot, /frontier | src/frontier.js:692 land/landPlot → land_parcels, land_stewardships | land.test.js; land-http.test.js | — | —
Land assign/release (also reported in Area 4 as "Land grants / stewardship") | IMPLEMENTED+TESTED | POST /land/assign, /land/release | src/frontier.js:711,729 → land_stewardships, land_events | land.test.js; land-http.test.js; also tests/frontier.test.js; tests/agent-actions-runtime.test.js (Area 4) | Area 4: `deleteAccount` mutates the event log in place: `UPDATE land_events SET purpose='[removed]'… WHERE account_id=?` (`platform.js:991`) | —
Plot grants (also reported in Area 4 as "Plot collaboration grants (delegated build, revocable/expiring)") | IMPLEMENTED+TESTED | POST /frontier/grant, /frontier/grant/revoke; GET /frontier/grants | src/frontier.js:757,775,789 → plot_grants, plot_grant_events | plot-collaboration.test.js; plot-collaboration-http.test.js; also tests/plot-collaboration.test.js (10), tests/plot-collaboration-http.test.js (Area 4) | Area 4: none; scope cannot widen a runtime credential (`frontier.js:51`) | —
Elevation collision | IMPLEMENTED+TESTED | internal (canStep/canOccupy/simulateStep) | src/elevation.js → frontier_blocks | elevation.test.js; elevation-connectivity.test.js | — | —
Footprint occupancy | IMPLEMENTED+TESTED | internal | src/footprints.js | footprints.test.js:25 | — | —
Pathfinding / escape | IMPLEMENTED-GAP | internal (planWalk, escapeColumns) | src/world-walk.js | world-walk.test.js; elevation-connectivity.test.js | nextPassageCue BFS (spaces.js:67) reimplements planWalk (world-walk.js:8) | —
Camera modes / client controls | IMPLEMENTED+TESTED | none (client) | src/camera-controls.js | camera-controls.test.js; game-input.test.js | — | app.js imports it (Claude owns app.js)
Game-input intents | IMPLEMENTED+TESTED | client → /move, /look, /interact, /frontier/build | src/game-input.js | game-input.test.js (14); game-input-capture.test.js | — | app.js wiring is Claude-owned
Presence interpolation | IMPLEMENTED+TESTED | none (client) | src/camera-controls.js createPresenceTracker | presence-interpolation.test.js | — | —
Interaction read/act | IMPLEMENTED+TESTED | GET+POST /interact | src/spaces.js:653 interactionView, :691 interact → frontier_sectors/world_objects | interaction-http.test.js; interaction-prompt-http.test.js | — | —
Nearby communication | IMPLEMENTED-GAP | POST /messages channel=nearby | src/platform.js:355 message → messages | platform.test.js:69; realtime-channel.test.js:137 | radius 3 (platform.js:391) and encounter ≤6 (:371) are inline literals, not shared constants | —
Viewport summary | IMPLEMENTED+TESTED | GET /world, /worlds | src/spaces.js:406 world() → agents | world-platform.test.js; spectator.test.js; performance-bounds.test.js | — | —
Movement queue (client) | IMPLEMENTED-GAP | none | src/movement-queue.js | movement-queue.test.js | unit-tested only; no HTTP/e2e | app.js imports it
Global map / voxel renderer | IN-CLAUDE-BRANCH | — | docs/GLOBAL_MAP.md @6868869; src/voxel-world.js | none | 6868869 is docs-only (339 lines, no code); no phase-1 movement in my files | Claude owns voxel-world.js; src/voxel-geometry.js is its consumed seam

### HANDOFFS ALREADY COMPLETE
- task-02-first-person.md — first-person physical world coherence.
- task-03-observation-pruning.md — whole-object pruning of AI observations.
- task-07-blueprints.md — safe building blueprints.
- task-16-realtime-presence.md — movement/presence deltas over the event channel.
- task-17-interaction.md — /interact fixture read and act.
- task-19-plot-collaboration.md — revocable plot collaboration grants.
- task-33-camera-controls.md — two camera modes and game-input intents.
- task-34-building-interface.md — build and inventory interface.
- task-35-world-interactions.md — contextual interaction component.
- task-deepseek-movement-feel.md — client-side travel feel.
- task-b-next-passage-hud.md — next_passage cue.
- task-b-hud-build-layering.md — build overlay layering defect.
- task-b-pin-selection-race.md — character-selection race fix.
- docs/LAND_WORLD.md, CONTROLS.md, BUILDING_INTERFACE.md, VOXEL_WORLD.md, GAME_INTERFACE.md.

### UNSAFE OR DUPLICATED
- Server imports a client module: `import { INTERACTION_DISTANCE } from './camera-controls.js';` (src/spaces.js:17).
- `wrapYaw`/`clampPitch` defined twice: src/spaces.js:40-41 and src/camera-controls.js (exported).
- Two escape checks: `trapsResident` (spaces.js:50) vs `keepsResidentsConnected` (frontier.js:432).
- Two placement validators kept in sync by hand: frontier.js:837 `frontierBuild` vs `world_objects_build_guard` (placement-policy.js:24); documented as intentional (route+trigger).
- Message visibility built inline in `world()` (spaces.js:449-475) duplicates `canReadMessage` (spaces.js:340).
- No write-before-persist found: `interact` sets the replay ledger after the result (spaces.js:770); `travel` audits after the UPDATE (spaces.js:551).

### SAFE TO BUILD ON
- Pure, single-owner, fully unit-tested: src/camera-controls.js, src/game-input.js, src/elevation.js, src/footprints.js, src/world-walk.js, src/placement-policy.js, src/voxel-geometry.js.
- Extendable but shared: src/spaces.js, src/frontier.js — a new route needs server.js route table + platform.js mixin; any schema bump collides with Claude's schema-26 database.js.
- Avoid: app.js, src/voxel-world.js, src/scene/* (Claude).

---

## Area 3 — Conversation and AI runtime

World/public chat + recipient-filtered message visibility | IMPLEMENTED+TESTED | GET `/world`, POST `/messages` (public/nearby/mission) | src/platform.js `message()` L355–401; `messages` table; read src/spaces.js:472 | tests/private-message-http.test.js; tests/realtime-channel.test.js:137; tests/platform.test.js | only `public` is pushed to subscribers (platform.js:400); nearby/mission have no reader test | src/spaces.js edited on Claude branches ad63562/cacd349/6868869
Private messages, reply-to-only threading, no free recipient | IMPLEMENTED+TESTED | POST `/messages` {channel:'private',reply_to} | src/platform.js:368–395; `messages`; `canReadMessage` src/spaces.js:340 | tests/private-reply.test.js:45–47; tests/private-message-http.test.js; native/bridge.integration.test.mjs:222 | `recipient_id` beside `reply_to` silently ignored (private-reply.test.js:38 "the named recipient is ignored") | none
Private incomplete drafts (evidence/decision-brief) | IMPLEMENTED+TESTED | GET/POST `/drafts`, `/drafts/resume`, `/drafts/archive` | src/drafts.js `DRAFT_SCHEMA` L3, `claim_drafts` table | tests/drafts.test.js (5 tests); tests/evidence-http.test.js | archival written from 3 places (see UNSAFE); `draftSave` returns success with no write when content unchanged (drafts.js:22) | src/drafts.js not owned elsewhere
Resident memory (schema 21) | IMPLEMENTED+TESTED | GET `/memory`; POST `/memory/propose`(contribute), `/memory/manage` | src/vocations.js:541 `resident_memory`; :684 memory, :697 propose, :715 manage, :774 export | tests/memory.test.js(9); tests/memory-runtime.test.js(6); tests/memory-http.test.js(3) | proposal source is server-derived only; no route lets a sibling read (owned() 404) | tests/memory.test.js + tests/vocations.test.js modified on all 4 Claude branches
Encrypted resident vault / secrets-at-rest (schema 25) (also reported in Area 4 as "Encrypted resident vault (AES-256-GCM notes; sealed + agent-held key models)") | IMPLEMENTED+TESTED | GET `/vault`,`/vault/notes`; POST `/vault/enroll`,`/vault/write`,`/vault/manage` | src/vault.js L179–300 (AES-256-GCM, `vault` scope); src/vault.js `resident_vault`,`resident_vault_keys` (schema 25) | tests/vault.test.js(231L), tests/vault-http.test.js, tests/vault-runtime.test.js; also tests/vault.test.js (13), tests/vault-http.test.js (2), tests/vault-runtime.test.js (4) (Area 4) | Area 3: sealed mode key is host-readable (`LUCY_VAULT_KEY_FILE`); no test of key-file loss. Area 4: operator read refused, can only erase (`vault.js:283-295`); no economic value in vault by design | Area 3: vault code & `vault` scope deleted on ad63562/cacd349/6868869 (runtime/agent.js, src/spaces.js). Area 4: none
Bounded agent runtime (decision loop, parseAction, authorizeAction) | IMPLEMENTED+TESTED | runtime ↔ /world,/runtime/status,/messages,/memory/propose,/vault/write,… | runtime/agent.js:74 parseAction, :402 authorizeAction, :771 runAgent | runtime/runtime.test.js (~42 tests); tests/agent-actions-runtime.test.js | hmm: `claim`/`submit` hard-refused (:888) so runtime cannot use mission writes | runtime/agent.js edited on Claude branches
Managed resident worker + crash-safe run state (also reported in Area 7 as "crash-recovery-interrupted-runs") | IMPLEMENTED+TESTED | POST `/residents/run`,`/residents/cancel`,`/residents/resume`; GET `/workers` | server.js:662–697; `resident_runs`+`jobs`; platform.js:1032 startResidentRun,:1064 residentRun; also src/recovery.js classifyResidentRun:135; tables `resident_runs`, `jobs`, `audit` | tests/resident-state.test.js(10); tests/resident-worker.test.js(5); tests/resident-crash.test.js(2) — also tests/resident-crash.test.js:48-136 (real SIGKILL child, `action_confirmed` / `model_call_in_flight`, no replay) | Area 3: `/workers` read is session-only (server.js:541); `jobs` row self-reported by runtime via POST `/jobs`. Area 7: child fixture only covers two of five classes (`no_action_yet`,`action_dispatched_unconfirmed`,`unknown` untested) | Area 3: src/recovery.js (classifyResidentRun) owned by Claude. Area 7: none
Research worker (approved-source retrieval) | IMPLEMENTED+TESTED | POST `/research/run`,`/research/cancel` | runtime/research-worker.js `runResearch`; runtime/statistics-source.js; `jobs` | tests/research-workflow.test.js; tests/research-failure.test.js; tests/local-ai.test.js | `POST /jobs` lets the worker also report its own completion (server.js:733) | Antigravity owns external-worker example
Model worker throughput (bounded queue + diagnostics) | IMPLEMENTED+TESTED | — (boundedModel beside server) | runtime/model.js:4 `boundedModel`; server.js:423,427–446 modelDiagnostics | tests/local-ai.test.js:46,60,68; tests/performance-bounds.test.js | queue bound `maxWaiting` only (8); saturation is counted, not delayed | server.js shared
Event channel (SSE) + public-message push | IMPLEMENTED+TESTED | GET `/events` (SSE); POST `/events` (community write) | server.js:246 EVENT_LIMITS, :258 createEventHub, :453 hub | tests/realtime-bounds.test.js(187L); tests/realtime-channel.test.js(9); tests/multiplayer-soak.test.js | none; re-auth every `revalidate_ms` 1000 | server.js shared (Claude/Antigravity both touch)
Statistics collection (World Bank WDI) | IMPLEMENTED+TESTED | no HTTP route (scripts/collect-statistics.mjs only) | runtime/statistics-collection.js:5 collectStatistics; runtime/statistics-source.js:5,15 | tests/statistics-collection.test.js:15–20; tests/access-statistics.test.js | curator-only; never exposed to a runtime credential or route | none
Credential/secret handling in runs & receipts | IMPLEMENTED+TESTED | all runtime writes | src/platform.js:1041 (hash-only `credential_hash`), :1023/:1091 revoke; :84 runView strips hash; :903 redactDiagnostics | tests/resident-state.test.js:124; tests/resident-worker.test.js:25; tests/ops-diagnostics.test.js | token never persisted — good; `/export` omits vault | src/recovery.js (redaction) owned by Claude
AI civic conversation (mayor/ambassador talk + recent-conversation memory) | IMPLEMENTED+TESTED | POST `/mayors/talk`,`/ambassadors/talk` | src/civic.js; `mayor_conversations`,`ambassador_conversations` (platform.js:993–994) | tests/local-ai.test.js:99,125; tests/civic-engine.test.js; tests/ambassador-dialogue.test.js | prose re-checked before persist but model-prose correctness not verified | Antigravity owns "conversation evaluation"

### HANDOFFS ALREADY COMPLETE
- `docs/handoff/task-21-resident-memory.md` — settled bounded resident memory + reflection, schema 20→21.
- `docs/handoff/task-16-realtime-presence.md` — settled the bounded SSE event channel and presence.
- `docs/handoff/task-04-crash-safe-jobs.md` — settled crash-safe resident run classification and resume.
- `docs/handoff/task-03-observation-pruning.md` — settled whole-object observation pruning in runtime/agent.js.
- `docs/handoff/task-agent-homes-vault.md` — settled private cottages + encrypted vault, schema 25.
- `docs/handoff/task-batch03-native-conversation.md` — settled native text conversation over the private-message records.
- `docs/handoff/task-deepseek-batch03-04-compute-budgets.md` — settled compute-budget controls and unit separation.
- `docs/handoff/task-deepseek-security-privacy.md` — settled redaction/origin/backup hardening (schema 22).
- `docs/THREAT_MODEL.md:200` — settled the private-conversation privacy rule.
- Also: `docs/DRAFTS.md`, `docs/RUNTIME.md`, `docs/RESEARCH_WORKER.md`, `docs/LOCAL_RESIDENTS.md`, `docs/STATISTICS_COLLECTION.md`, `docs/VAULT.md`.

### UNSAFE OR DUPLICATED
- Draft archival state written from three modules with no shared guard: src/drafts.js `draftResume` `"UPDATE claim_drafts SET archived=1 WHERE claim_id=?"` and `draftArchive`; src/platform.js:547 `"UPDATE claim_drafts SET archived=1 WHERE claim_id=?",claim.id`; src/platform.js:567 `"UPDATE claim_drafts SET archived=0 WHERE claim_id=?",submission.claim_id`.
- Reported success without a write: src/drafts.js:22 `if(row?.content===content)return {claim_id:claim.id,revision:row.revision,updated_at:row.updated_at};`.
- Duplicated private-recipient authorization: runtime/agent.js:409 comment "the server re-checks the same message before delivering the reply, so this advisory rule can never approve a recipient the server would refuse" duplicates src/platform.js:376.
- Self-attested job success: src/platform.js `job(actor,input)` writes `jobs` from any agent runtime with `contribute`, and `/jobs` is absent from the operator-only block at server.js:541 (`['/drafts','/workers',...]`), so a runtime can record its own `completed`.
- Deliberate re-authorization duplication: server.js `/events` GET authenticates + `platform.space()` (server.js:503–514), then the hub rechecks every `revalidate_ms`.

### SAFE TO BUILD ON
- `src/drafts.js`, `src/vault.js`, `runtime/model.js`, `runtime/research-worker.js`, `runtime/statistics-collection.js`, `runtime/statistics-source.js` — pure modules, not owned by Claude or Antigravity.
- `src/vocations.js` (memory methods L684–782) and `src/platform.js` `resident_*` run methods — extendable, but tests/memory.test.js + tests/vocations.test.js are edited on every Claude branch (coordinate).
- `runtime/agent.js` and `src/spaces.js` — safe content-wise but both are modified on ad63562/cacd349/6868869 (they strip the vault); rebase will conflict.
- The event hub is isolated in `server.js` (EVENT_LIMITS:246 / createEventHub:258) but `server.js` is shared with Claude and Antigravity, so a `framework-*` branch should add a pure module beside it rather than edit the handler.

---

## Area 4 — Economy and property (coins, trade, vault, grants)

NemoCoin ledger (append-only hash chain, 10/contribution, 100/operator/UTC-day) | IMPLEMENTED+TESTED | GET `/coins`; award internal only (`awardCoins` called from review, no route) | `src/coins.js` `coin_rewards`+3 triggers | `tests/coins.test.js` (6), `tests/coin-abuse.test.js` (14, incl. forged/wrong-wallet receipt, midnight cap) | balance only counts `available` receipts; `held` shown separately `coins.js:coinMethods.coins` | none; `src/recovery.js` verifier is Claude-owned
Coin abuse / self-review / replay / daily-farming refusals | IMPLEMENTED+TESTED | n/a | `src/coins.js` `eligible`+trigger `coins_validate_insert` | `tests/coin-abuse.test.js` all 14 tests | eligibility SQL duplicated: method `eligible` string and trigger body are two hand-maintained copies | none
Coin lifecycle on suspension/revocation/deletion | IMPLEMENTED+TESTED | n/a | `src/coins.js` (`coins_no_delete` blocks purge) | `tests/coin-abuse.test.js` "suspended or revoked identity earns nothing new and holds the receipts it already issued" | account deletion keeps receipts (by append-only trigger); no coin purge path, so a deleted account's coins persist | `deleteAccount` in `src/platform.js:978` is shared/Claude-adjacent
Trade board (bounded, coin-free item exchange; escrow/debit/credit from `journey_inventory`) | IMPLEMENTED+TESTED | GET `/trade/listings`; POST `/trade/listings`,`/trade/claim`,`/trade/cancel`; scope `contribute` | `src/trade-board.js` + `src/trade-market.js`; tables `trade_listings/trade_terms/trade_claims/trade_claim_units/trade_events` | `tests/trade-board.test.js` (6), `tests/trade-http.test.js` (3), `tests/trade-baseline.test.js` (5) | none material; no price/bid/coin by design (`server.js:155`) | none; `src/trade-board.js`/`trade-market.js` self-register
Trade board migration / restart / backup | IMPLEMENTED+TESTED | n/a | `src/trade-board.js` `verifyTradeRecords`; `src/recovery.js:334` | `tests/trade-migration.test.js` (5) incl. weakened-trigger backup refusal | schema 23 reserved/leased by its owner; ensureTradeMarket additive | `src/recovery.js` Claude-owned (verifier calls in)
Comtrade trade *evidence* (URL builder, draft import, CSV preview) — research surface, NOT item exchange | IMPLEMENTED+TESTED | static JS served `/src/trade.js|trade-import.js|trade-preview.js`; used client-side in `app.js:1773,1978` | `src/trade.js`,`src/trade-import.js`,`src/trade-preview.js` (no table) | `tests/trade-source.test.js` (3), `tests/trade-import.test.js` (2), `tests/trade-preview.test.js` (2) | canonical `tradeUrl` URL check duplicated in import + preview (both import from `trade.js`) | `app.js` Claude-owned
Land grants / stewardship (`land_parcels`,`land_stewardships`,`land_events`) (also reported in Area 2 as "Land assign/release") | IMPLEMENTED+TESTED | GET `/land`,`/land/plot`; POST `/land/assign`,`/land/release` (operator-only, no scope) | `src/frontier.js`; also src/frontier.js:711,729 → land_stewardships, land_events (Area 2) | `tests/frontier.test.js`, `tests/agent-actions-runtime.test.js`; also land.test.js; land-http.test.js (Area 2) | `deleteAccount` mutates the event log in place: `UPDATE land_events SET purpose='[removed]'… WHERE account_id=?` (`platform.js:991`) | none
Plot collaboration grants (delegated build, revocable/expiring) (also reported in Area 2 as "Plot grants") | IMPLEMENTED+TESTED | GET `/frontier/grants`; POST `/frontier/grant`,`/frontier/grant/revoke` | `src/frontier.js` `plot_grants`,`plot_grant_events` (schema 19); also src/frontier.js:757,775,789 (Area 2) | `tests/plot-collaboration.test.js` (10), `tests/plot-collaboration-http.test.js` | none; scope cannot widen a runtime credential (`frontier.js:51`) | none
Private resident cottage (per-resident home world, independent `house_visibility`) — already merged into Area 2 | IMPLEMENTED+TESTED | `/worlds/:id/home` PATCH (dynamic), `build` scope | `src/spaces.js:376-602` `worlds` kind `house` | `tests/agent-home.test.js`, `tests/world-platform.test.js` (4 visitor tests) | not a purchase; no cottage sale/transfer route exists | none
Encrypted resident vault (AES-256-GCM notes; sealed + agent-held key models) — already merged into Area 3 | IMPLEMENTED+TESTED | GET `/vault`,`/vault/notes`; POST `/vault/enroll`,`/vault/write`,`/vault/manage` | `src/vault.js` `resident_vault`,`resident_vault_keys` (schema 25) | `tests/vault.test.js` (13), `tests/vault-http.test.js` (2), `tests/vault-runtime.test.js` (4) | operator read refused, can only erase (`vault.js:283-295`); no economic value in vault by design | none
Encrypted at-rest backup of DB (covers coin/trade/land state via restore validation) (also reported in Area 7 as "encrypted-backup-restore") | IMPLEMENTED-GAP / IMPLEMENTED+TESTED | CLI `scripts/recovery.js` `backup-encrypted/verify-encrypted`; also `backup-encrypted`/`verify-encrypted`/`restore-encrypted` via `scripts/recovery.js:29-45` (Area 7) | `src/encrypted-backup.js` (`NEMOBK01`); validation `src/recovery.js`; also `src/encrypted-backup.js` (AES-256-GCM, `NEMOBK01`, no table) (Area 7) | `tests/encrypted-backup.test.js` (**1** test total); also tests/encrypted-backup.test.js:1-40 (key 0600, wrong key, tamper, lock, no-overwrite) (Area 7) | Area 4: single test; wrong-key + tamper only; not exercised through `recovery.js` economic verifiers in backup-suite depth. Area 7: none material | Area 4: `src/recovery.js` and `src/database.js` Claude-owned; `scripts/recovery.js` is the integration point. Area 7: none — CLI only, no HTTP surface
Karma Coin ledger (world/service awards, per-day) | IN-CLAUDE-BRANCH | `/karma`* on `feat/karma-shop-integration` | `src/karma.js` `karma_receipts`,`karma_purchases` | `tests/karma-ledger.test.js`,`tests/karma-integration.test.js`,`tests/karma-shop-http.test.js` | not in `27c0d72` | Claude; schema-26 port
Shop / purchased goods (catalogue purchase, Karma debit, goods→resident) | IN-CLAUDE-BRANCH | `/shop`* @ `b95d218` | `src/shop.js` `shop_purchases`; `src/ui/shop-panel.js`; calls `platform.karmaSpend`/`karmaWallet` | `tests/shop.test.js`,`tests/shop-panel.test.js` | moves no NemoCoin/money/land/role/scope/grant (`shop.js:43-45`); land/coin grants NOT part of shop | Claude; do not touch `src/shop.js`/`src/karma.js`

### HANDOFFS ALREADY COMPLETE
- `docs/handoff/task-08-coin-abuse-review.md` — ten coin/reward abuse surfaces, controls, refusal-test verdicts settled.
- `docs/handoff/task-agent-homes-vault.md` — schema 25 vault + private-cottage behaviour and routes settled.
- `docs/handoff/task-deepseek-trade-execution.md` — trade-board files, routes, limits, `verifyTradeRecords` settled.
- `docs/COINS.md`,`docs/VAULT.md`,`docs/LAND_WORLD.md`,`docs/TRADE.md`,`docs/TRADE_BASELINES.md` — per-area design/policy refs.
- `docs/KARMA.md`,`docs/handoff/task-karma-*.md`,`task-shop-engine.md`,`task-shop-panel.md` (b95d218) — Claude's karma/shop settled.

### UNSAFE OR DUPLICATED
- Coin eligibility duplicated across two strings: `const eligible = EXISTS(...)` in `coins.js` and the trigger body `coins_validate_insert ... SELECT CASE WHEN NOT EXISTS(...) THEN RAISE(ABORT,'Eligible coin receipt')`. Two hand-maintained copies of the same role/status/version predicate.
- Chain proof duplicated: `verifyCoinLedger` recomputes `receiptHash` per row, and `coins_validate_insert` independently re-checks `NEW.previous_hash!=COALESCE((SELECT hash FROM coin_rewards ORDER BY seq DESC LIMIT 1),'')`.
- Land event log mutated on account deletion — `land_events` is an append event table, yet `deleteAccount` runs `UPDATE land_events SET purpose='[removed]',description='' WHERE account_id=?` (`server.js` route is `POST`; mutation is post-hoc rewrite of history).
- Scope reported before persistence: coin/trade/land writes go through `platform.charge(actor)` **after** `platform[method](...)` in the write handler (`server.js:747-748`); the audit row is written inside each method, so a charge failure is not the guard.

### SAFE TO BUILD ON
- Own modules, no other-agent files: `src/coins.js`, `src/trade.js`, `src/trade-import.js`, `src/trade-preview.js`, `src/trade-board.js`, `src/trade-market.js`, `src/vault.js`, `src/encrypted-backup.js`.
- `src/frontier.js` land/grant slice (67KB shared; touch only `land*`/`plot_grant*` regions), `scripts/recovery.js` CLI.
- Tests to extend: `coin-abuse`, `coins`, `trade-board`, `trade-http`, `trade-migration`, `trade-baseline`, `trade-source`, `vault*`, `encrypted-backup`, `plot-collaboration*`, `frontier*`, `agent-home`.
- Integration points you must NOT rewrite: `server.js` route table/scope table, `src/platform.js` `Object.assign(Platform.prototype,…)` lines and `deleteAccount`, `src/recovery.js`, `src/database.js` — adding rows/calls is fine, editing ownership is not.

---

## Area 5 — Purposeful activity (callings, quests, guilds, civic, evidence, review)

Callings (8 seeded, select, rank, daily objectives, calling guilds) | IMPLEMENTED+TESTED | GET `/callings` (read scope); POST `/callings/select` (session-only, writes-map scope `null`); GET `/callings/guilds` (public) `server.js:556`,`:533` | `src/vocations.js:553-554` `resident_callings`,`calling_receipts` (+no-update trigger, 10/day CHECK `:562`) | `tests/vocations.test.js:20-124`, `tests/quests.test.js` | none found | tests/vocations.test.js is modified on Claude b95d218/ad63562/cacd349/6868869
Competence pathways | IMPLEMENTED+TESTED | carried inside GET `/callings` as `pathway:` `vocations.js:650` | `src/vocations.js:134` PATHWAYS; stores nothing | `tests/pathway-http.test.js:11-40` | — | none
Quest chains | IMPLEMENTED+TESTED | GET `/quests`,`/quests/catalog`(public); POST `/quests/author`,`/manage`,`/join`,`/leave`,`/complete`(deliberately refused) | `src/quests.js:63-65` `quest_chains`,`quest_steps`,`quest_enrollments`; step receipts reuse `calling_receipts` via `questObjectiveRules` `:52` | `tests/quests.test.js`(8), `quests-http`(5), `cooperative-content`(9) | — | Claude branches modify `tests/quests*.test.js`
Guild projects + verification | IMPLEMENTED+TESTED | GET `/guilds`,`/guilds/project`(public); POST `/guilds/projects`,`/participation`,`/contributions`,`/verify`,`/manage` | `src/guilds.js:89/101/110` `guild_projects`,`guild_participants`,`guild_contributions` | `tests/guilds.test.js:124`, `guilds-http`, `cooperative-content:296` | — | Claude branches modify `tests/guilds*.test.js`
Circles, community projects, gatherings, thanks | IMPLEMENTED+TESTED | GET `/community`; POST `/circles`,`/projects`,`/projects/pledges`,`/projects/milestones`,`/events`,`/events/rsvp`,`/thanks`,`/community/manage` `server.js:148-151` | `src/community.js:137-143` `community_circles/members/projects/pledges/events/rsvps/thanks` | `tests/cooperative-content.test.js`(9) | — | tests touched on all four Claude refs
Cooperative world restoration (Gathering Garden) | IMPLEMENTED+TESTED | GET `/restoration`(public); POST `/restoration/open`(session-only),`/join`,`/leave`,`/contribute`,`/place` `community.js:655,681` | `src/community.js` `community_events`+`community_rsvps`; placements proven by `audit` rows `restoration.placed` `:484`,`:562` | `tests/cooperative-events`(10), `cooperative-http`(1) | — | `tests/cooperative-*.test.js` on Claude refs
Civic/research missions + country evidence + guides | IMPLEMENTED+TESTED | GET `/countries`,`/research`,`/country-evidence`,`/mayors`,`/ambassadors`,`/civic`,`/assembly`; POST `/research/generate`,`/research/activate`,`/mayors/control` | `src/civic-engine.js:123/138/140` `research_leads`,`research_lead_versions`,`research_lead_consolidations`; `npc_mayors`/`npc_ambassadors`+`*_conversations` `:121`,`:136`; pure `src/mayor-evidence.js`,`src/civic.js` | `tests/civic-engine`(14), `research-generator`(13), `mayor-evidence`(6), `civic`(2), `statistics:35-37` | activation admin-gated (`civic-engine.test.js:21`); no gap | `tests/civic.test.js`,`mayor-evidence.test.js` touched on Claude refs
Evidence library | IMPLEMENTED+TESTED | GET `/evidence`,`/evidence/draft`; POST `/evidence/capture`(admin),`/evidence/withdraw`(reviewer/admin) `platform.js:1212,1220` | `src/platform.js` initEvidence/registerCapture; `database.js:142-145` `evidence_sources/captures/events/submission_evidence` | `tests/evidence-library`(14), `evidence-http`(4) | both writes session-only (`role(...)`) | `tests/evidence-library.test.js` on Claude refs
Decision briefs | IMPLEMENTED+TESTED | no dedicated route — POST `/submissions` `brief` field (`platform.js:526`) | `submissions.artifact` behind `BRIEF_MARKER` `decision-brief.js:175` | `tests/decision-brief.test.js`(4) | — | none
Delivery packets | IMPLEMENTED-GAP | GET `/briefing?submission=&format=html|json` — **unauthenticated** `server.js:533,605,628` | derived only, no table `delivery-packet.js:254` | `tests/delivery-packet.test.js`(3) | route passes no actor; exposure bounded only by `gallery()`'s accepted-status filter | none
Mission review, workbench, adoption, quality | IMPLEMENTED+TESTED | POST `/reviews`,`/adoptions`; GET `/review/workbench`,`/quality`,`/gallery` | `reviews`,`adoptions` `database.js:35-36`; workbench/quality pure `platform.js:672,763` | `review-states`(5), `review-workbench`(8), `review-assessment`(2), `mission-quality`(19), `mission-quality-http`(6) | — | `tests/review-states.test.js` on Claude refs
Mission directory | IMPLEMENTED+TESTED | GET `/missions`(public); embedded in runtime `/callings` `server.js:554` | `src/mission-directory.js`, reads `missions`/`tasks`/`claims` | `tests/mission-directory.test.js`(5) | — | none
Statistics collection | IMPLEMENTED-GAP | no route; `scripts/collect-statistics.mjs` → `runtime/statistics-collection.js`; read via GET `/country-evidence` | registry only `src/statistics.js` (no table); `catalog/agriculture-statistics.json` | `statistics`(6), `statistics-collection`(4), `access-statistics`(3) | the operator script `scripts/collect-statistics.mjs` has **no test** (grep hits only it and `docs/STATISTICS_COLLECTION.md`) | none
Journey (garden, craft, visits, offers) | IMPLEMENTED+TESTED | GET `/journey`,`/journey/offers`; POST `/journey/profile`,`/journal`,`/garden`,`/craft`,`/offers`,`/offers/accept`,`/decline`,`/cancel` | `src/journey.js:101-106,165,191` `journey_profiles/visits/journal/inventory/crops`,`resource_offers`,`resource_offer_events` | `journey`(8), `journey-http`(2), `journey-content`(7), `newcomer-journey`(11) | — | none
Research failure diagnostics | IMPLEMENTED-GAP | none — pure module, wired only into the research worker `server.js:723` | encoded into `jobs.detail` `research-failure.js:456` | `tests/research-failure.test.js`(7) | no HTTP/operator surface reads it | none

### HANDOFFS ALREADY COMPLETE
- `docs/handoff/task-05-quest-chains.md` — quest chain schema, saved-fact steps, receipt rules.
- `docs/handoff/task-06-guild-projects.md` — guild projects, participation, independent verification, no coin.
- `docs/handoff/task-23-cooperative-events.md` — the Gathering Garden restoration plan and windows.
- `docs/handoff/task-25-evidence-library.md` — versioned captures; superseded by `docs/EVIDENCE_REVIEW.md` rule.
- `docs/handoff/task-26-reviewer-workbench.md` — workbench, request-changes, adoption.
- `docs/handoff/task-24-proposal-generator.md` — concern model, dedupe by question, revision history.
- `docs/handoff/task-c-mission-quality.md` — advisory quality signals, decides nothing.
- `docs/handoff/task-firstplay-restoration-read.md` — bounded account-specific restoration read.

### UNSAFE OR DUPLICATED
- Distinct-operator independence rule implemented twice with divergent text: `guilds.js:322` `if([contributor.operator_id,project.creator_operator_id].includes(actor.account.id))fail(403,'A different operator must verify this contribution.')` vs `community.js:302` `if ([submitter.operator_id, project.creator_operator_id].includes(actor.account.id)) fail(403, 'An independent operator must review this contribution.')`.
- Unauthenticated write-adjacent read: `/briefing` sits in `publicRoute` (`server.js:533`) and `platform.deliveryPacket(input)` reads `input.submission` with no actor/role check (`platform.js:642`).
- Publish guard's message contradicts its check — `quests.js:358` `if(!steps.length)fail(409,'Author at least two ordered steps before publishing.')`; only `chainStructureValid`'s `steps.length<STEP_MIN` (`STEP_MIN=2`) makes the claim true.

### SAFE TO BUILD ON
- `src/vocations.js`, `src/quests.js`, `src/guilds.js`, `src/civic-engine.js`, `src/civic.js`, `src/mayor-evidence.js`, `src/mission-directory.js`, `src/decision-brief.js`, `src/delivery-packet.js`, `src/review-assessment.js`, `src/research-failure.js`, `src/statistics.js`, `src/journey.js`, `src/mission-quality.js` — untouched on all four Claude refs.
- Their test files (`vocations/quests/guilds/civic/cooperative/evidence/review-states/mayor-evidence`) *are* edited by Claude branches, so a `framework-*` branch must rebase or re-author expectations there.
- Blocked by ownership: `src/platform.js` mixin assembly and `src/database.js` schema ordering (Claude), and `src/community.js` restoration rows interact with nothing Antigravity owns.

---

## Area 6 — Server framework seams (request → auth → transaction → audit → observation)

HTTP write dispatch | IMPLEMENTED-GAP | all `/api/v1/*` POST/DELETE | server.js:126-178 `writes` Map, :179 `gets` Set, :729-746 dispatch | tests/http.test.js:101; quests-http.test.js:33 | existence/method checked only at :485-489; GET fallback `value=platform[route.slice(1)](actor)` (server.js:624) is name-coupled to method names — no assertion that every `gets` entry has a handler | server.js unowned
Scope authorization | IMPLEMENTED+TESTED | all | server.js:534,536; platform.js:208-221 `authorize` | platform.test.js:24-48; expansion-http.test.js:115 | none | none
CSRF/origin guard | IMPLEMENTED+TESTED | all | src/hosting.js:34-57; server.js:466 | hosting.test.js | `Authorization` header bypasses Origin entirely (intended, untested as bypass) | none
Transaction wrapper | IMPLEMENTED-GAP | every GET/POST txn | platform.js:100-109 (`BEGIN IMMEDIATE`) | coin-abuse.test.js:284; helpers.js:32 | no nested-txn guard; audit NOT inside wrapper (helpers call `this.audit()` separately) | none
Audit chain (also reported in Area 7 as "audit-trail") | IMPLEMENTED-GAP / IMPLEMENTED+TESTED | writes that call `audit()`; also `GET /operations` exposes `audit_valid`; every write calls `platform.audit` (Area 7) | platform.js:110-115 `audit`, :116-123 `verifyAudit`; table `audit` database.js:42 | verifyAudit in ~60 files (platform.test.js:21,49); also tests/ops-diagnostics.test.js, tests/startup-integrity.test.js:63-65 (`saved.verifyAudit()`), 50+ files assert chain (Area 7) | Area 6: not enforced: `message()` (platform.js:355) has no top-level audit; movement `stepAgent`/`moveAgent`/`climbAgent`/`lookAgent` (spaces.js:498-527), `posture` (:640), `heartbeat` (:634), `writeJournal` (journey.js:524) write with no audit row; `audit` has NO append-only trigger. Area 7: `/operations/backup` writes the file before the audited transaction (`server.js:652-654`) — a crash between them leaves an unattributed backup | none
Event publication | IMPLEMENTED-GAP | /agents/:id/*, /messages, /frontier/*, /restoration/* | server.js:243-386 hub, :454 `platform.events=hub`; publish sites server.js:747-759, spaces.js:512,557,587,645, platform.js:284,296,400 | realtime-channel.test.js:130,157; realtime-bounds.test.js | publication is manual per-helper, not a post-commit hook; garden/craft/trade/offer/coin writes never publish and no test fails | none
Idempotency keys | IMPLEMENTED-GAP | /claims,/submissions,/drafts/resume,/tasks/follow-up,/quests/join,/interact,/journey/offers(+accept),/trade/listings,/trade/claim | UNIQUEs database.js:32,34,114; trade-board.js:76,98; `replayLedger` spaces.js:320; :742 header | http.test.js:101,109; exchange-http.test.js:28; coin-abuse.test.js:240 | key forwarded ONLY for the hard-coded 10 routes at server.js:742; /guilds/projects,/projects,/events,/circles,/vault/write,/memory/propose unprotected; `interact` ledger is in-memory, lost on restart | Claude b95d218 adds `/shop/purchase` to :742 but not `/karma/settle`
Persistence before 2xx | IMPLEMENTED+TESTED | all writes | server.js:729-746 commit→:779 json | followups.test.js:8; drafts.test.js:17 | none | none
Native `/agents/:id/*` | IMPLEMENTED-GAP | POST travel/build/heartbeat/posture/look/climb, PATCH home | server.js:480-483; spaces.js:498-651 | agent-actions-runtime.test.js; realtime-channel.test.js:84-133 | heartbeat/posture/look/climb write with no audit; scope map (server.js:483) gives `heartbeat:'read'` so a read-only runtime can POST a write | none
Runtime→human-only guard | IMPLEMENTED-GAP | null-scope POST writes | server.js:541 | expansion-http.test.js:115 | string/route-name test, not derived from handler; drift silently blocks or permits runtimes | Klaus b95d218/cacd349/6868869 rewrite :541
Public unauth reads | IMPLEMENTED+TESTED | GET publicRoute | server.js:533 vs :179 | http.test.js; first-play-http.test.js | publicRoute hand-duplicates `gets`; drift untested | none
DELETE /me | IMPLEMENTED+TESTED | DELETE /me | server.js:642-645; platform.js:978-1006 | platform.test.js:8 | none | none
/operations/backup (also reported in Area 7 as "live-admin-backup") | IMPLEMENTED-GAP / IMPLEMENTED+TESTED | POST /operations/backup | server.js:650-655; also `src/recovery.js backupDatabase` → `backups/world-*.sqlite` + `audit` row (Area 7) | ops-rehearsal.test.js; also tests/ops-diagnostics.test.js:93-103; tests/expansion-http.test.js:191 (Area 7) | Area 6: file written to disk BEFORE audit txn (:654); crash between leaves unrecorded backup. Area 7: guard is `platform.operations(actor)` (role admin) *outside* the audit transaction; file persists if the `audit` INSERT fails | Area 6: docs/handoff/task-27-operations.md. Area 7: `src/recovery.js` is Claude-owned (b95d218 touches it)
202 worker starts | IMPLEMENTED-GAP | /residents/run,resume,/research/run | server.js:679-698,:715-727 | resident-worker.test.js; research-generator.test.js | job row+credential committed first, but later transitions written by callbacks (:690-696) whose failures are swallowed | none

### HANDOFFS ALREADY COMPLETE
- `docs/handoff/task-27-operations.md` — backup/restore, admin diagnostics dashboard, audit_valid gate.
- `docs/handoff/task-16-realtime-presence.md` — SSE channel, per-world re-auth, bounded deltas.
- `docs/handoff/task-04-crash-safe-jobs.md` — durable `resident_runs`, no auto-replay of actions.
- `docs/handoff/shared-world-integration.md` — offer escrow + idempotent settlement, acceptance key.
- `docs/handoff/task-17-interaction.md` — interaction fixture→route/scope table, idempotent `interact`.
- `docs/THREAT_MODEL.md` — CSRF/origin, runtime credential scope/budget.

### UNSAFE OR DUPLICATED
- Audit is a per-helper convention, not a seam: `transaction(action){this.db.exec('BEGIN IMMEDIATE'); try{const result=action(); this.db.exec('COMMIT')...}` (platform.js:100-109) contains no audit write, so `message()`'s `this.run('INSERT INTO messages(...)')` (platform.js:390) is committed with no audit row.
- `this.events?.publish(...)` inlined at spaces.js:512,557,587,645 and platform.js:284,296,400 plus server.js:747-759 — no single post-commit publisher.
- `gets` Set (server.js:179) and `publicRoute` list (server.js:533) hand-duplicate the same routes.
- Idempotency route set hard-coded at server.js:742; `/karma/settle` (Claude b95d218) writes with a null scope and passes no key.

### SAFE TO BUILD ON
- `server.js` (route table, hub, dispatch) and `src/platform.js` (only write-method merge point, `Object.assign(Platform.prototype,...)`) — unowned; and `src/hosting.js`.
- Extension modules with their own audit/idempotency: `src/trade-market.js`, `src/trade-board.js`, `src/journey.js`, `src/community.js`, `src/quests.js`, `src/guilds.js`, `src/vault.js`, `src/firstplay.js`.
- Avoid: `src/database.js` (Claude), `src/spaces.js` movement (`stepAgent`/`travel`, adjacent to Claude's global-map movement), `src/recovery.js`, `app.js`, `src/scene/*`.

---

## Area 7 — Operations and acceptance gates (backup, moderation, seal, Luanti, browser)

encrypted-backup-restore — already merged into Area 4 | IMPLEMENTED+TESTED | `backup-encrypted`/`verify-encrypted`/`restore-encrypted` via `scripts/recovery.js:29-45` | `src/encrypted-backup.js` (AES-256-GCM, `NEMOBK01`, no table) | tests/encrypted-backup.test.js:1-40 (key 0600, wrong key, tamper, lock, no-overwrite) | none material | none — CLI only, no HTTP surface
live-admin-backup — already merged into Area 6 | IMPLEMENTED+TESTED | `POST /operations/backup` server.js:650-655 | `src/recovery.js backupDatabase` → `backups/world-*.sqlite` + `audit` row | tests/ops-diagnostics.test.js:93-103; tests/expansion-http.test.js:191 | guard is `platform.operations(actor)` (role admin) *outside* the audit transaction; file persists if the `audit` INSERT fails | `src/recovery.js` is Claude-owned (b95d218 touches it)
backup-restore-validation | IMPLEMENTED+TESTED | `backup`/`restore`/`verify` CLI | `src/recovery.js:153-441` (`validateDatabase`, `restoreDatabase`, `acquireProcessLock`) | tests/recovery.test.js:18-180 (12 tests, v1/v2/v3 migrations, stale locks, corrupt restore) | accepted-version list duplicated 3×: `src/recovery.js:157`, `:461`, ops-rehearsal hardcodes 25 | Claude owns `src/recovery.js`; version arrays already drifted on b95d218
crash-recovery-interrupted-runs — already merged into Area 3 | IMPLEMENTED+TESTED | n/a (server startup) | `src/recovery.js classifyResidentRun:135`; tables `resident_runs`, `jobs`, `audit` | tests/resident-crash.test.js:48-136 (real SIGKILL child, `action_confirmed` / `model_call_in_flight`, no replay) | child fixture only covers two of five classes (`no_action_yet`,`action_dispatched_unconfirmed`,`unknown` untested) | none
moderation-safety | IMPLEMENTED+TESTED | `POST /moderation`, `POST /reports`, `POST /appeals`, `POST /appeals/decide`, `GET /safety` | `src/platform.js moderate:808, safety:829, appeal:843, decideAppeal:853`; tables `reports`, `appeals` | tests/platform.test.js:388-407 (bounds + member visibility); ops-rehearsal `safety-and-pause` drill | quarantine/suspend lift logic triplicated in `decideAppeal:858-866`; no HTTP test that `/moderation` refuses a runtime token (server.js:541 omits it; blocked only by `scope===null`) | `src/platform.js` schema work overlaps Claude's schema-26 karma port
audit-trail — already merged into Area 6 | IMPLEMENTED+TESTED | `GET /operations` exposes `audit_valid`; every write calls `platform.audit` | `src/platform.js audit:110 / verifyAudit:117`; table `audit(seq,actor,event,record_id,created_at,previous_hash,hash)` | tests/ops-diagnostics.test.js, tests/startup-integrity.test.js:63-65 (`saved.verifyAudit()`), 50+ files assert chain | `/operations/backup` writes the file before the audited transaction (`server.js:652-654`) — a crash between them leaves an unattributed backup | none
operational-drills | IMPLEMENTED+TESTED | n/a (`node scripts/ops-rehearsal.mjs`) | `scripts/ops-rehearsal.mjs` → 8 drills, writes disposable `world.sqlite` | tests/ops-rehearsal.test.js:27-120 re-reads each drill's DB separately | not wired into `npm test`/CI as a gate; hardcodes schema 25 (b95d218 bumps to 26); `.github/workflows/ci.yml` runs only `check`+`test`+`browser` | `src/recovery.js`+ops files touched by b95d218; Antigravity owns "fresh-install rehearsal"
content-sealing | IMPLEMENTED-GAP | n/a (`--check` mode) | `scripts/seal-content.mjs` → `content/content-manifest.json`, `notices.json`, `index.js` | tests/content.test.js:37-126 re-hashes every entry/asset/notice | `seal-content --check` is **not** in `npm test` or ci.yml; only RELEASE_CHECKLIST G5 runs it manually; G5's expected counts (89 defs) are stale vs manifest 98 (20/9/32/6/31) | none
asset-provenance | IMPLEMENTED+TESTED | n/a | per-entry `license{spdx,author,source,commit,notice_file,notice_sha256}` + `assets/residents/manifest.json` | tests/content.test.js:70-121 (CC0 commit pin, notice hash); tests/resident-art.test.js:1-40 (manifest hash, served routes, licences) | Luanti/Minetest media CC-BY-SA 3.0 provenance is documented only in docs/handoff/task-09 + docs/ASSET_LIBRARY.md; no runtime/backup field carries asset provenance | none
native-luanti-acceptance | IMPLEMENTED-GAP | `/native/*` bridge routes (native/bridge.mjs) | `native/bridge.mjs`, `native/nemoworld_game/mods/nemo/init.lua` | native/bridge.test.mjs + native/bridge.integration.test.mjs (both discovered by `node --test`) | real-engine path `native/luanti-smoke.mjs`, `luanti-mission-smoke.mjs`, `luanti-conversation-smoke.mjs` need `LUANTI_BIN`, are named `*.mjs` (not `*.test.mjs`), so neither `npm test` nor CI runs them; `scripts/check-syntax.mjs` patterns exclude `native/**` | none
browser-acceptance | IMPLEMENTED-GAP | drives shipped server over HTTP | `scripts/browser-suite.mjs` (45 scenarios) | tests/browser-suite.test.js:1-70 (registry, 45 count, DB-refusal, throttle) — unit only, no browser | the 45 scenarios are never executed by `npm test`; only the CI `browser-acceptance` job / `npm run browser` | Antigravity owns CI/rendering measurements; ad63562 adds rival `scripts/command-surface-audit.mjs`
e2e-acceptance | IMPLEMENTED-GAP | 20 HTTP steps incl. restart persistence, cleanup | `scripts/e2e-smoke.mjs` | none — `git grep e2e-smoke` matches only docs/ | no test or CI job runs `npm run e2e`; `npm test` cannot catch a broken acceptance path | none
capacity-load-harness | IMPLEMENTED-GAP | drives `server.js` over HTTP | `scripts/load-harness.mjs`, `scripts/capacity-experiment.mjs` | tests/performance-bounds.test.js (query bounds only) | measured evidence, never asserted: "deliberately not part of `npm test`" (load-harness.mjs:31); capacity figures in PERFORMANCE.md are from schema 22 | Antigravity owns rendering/performance measurement; task-d says capacity-experiment is DeepSeek's
startup-integrity | IMPLEMENTED+TESTED | n/a | `src/recovery.js validateDatabase` + `src/platform.js` open path | tests/startup-integrity.test.js:26-65 (corrupt/foreign/newer refused before listener, lock released) | none | none

### HANDOFFS ALREADY COMPLETE
- `docs/handoff/task-27-operations.md` — settled the runbook, `/operations` diagnostics, redaction.
- `docs/handoff/task-d-capacity-recovery.md` — settled measured capacity + plaintext-backup honesty; supersedes task-28 narrative.
- `docs/handoff/task-15-browser-acceptance.md` — settled the browser suite, its devDependency and CI job.
- `docs/handoff/task-09-asset-shortlist.md` + `task-30-asset-library.md` — settled licence evidence and the asset manifest.
- `docs/handoff/fix-browser-suite-flake.md` — settled movement-throttle flake; no product change.
- `docs/handoff/task-04-crash-safe-jobs.md` — settled `resident_runs` state model and no-replay policy.
- `docs/handoff/task-batch03-luanti-mission-smoke.md` — settled that the pinned engine exists and native smokes pass.

### UNSAFE OR DUPLICATED
- `server.js:650-655`: the backup file is written, then audited in a separate transaction — `backupDatabase(platform.db, join(backupDir, filename)); platform.transaction(() => platform.audit(...))`. A crash between them persists an unattributed backup. Attribution is not part of the file write.
- Accepted schema versions are hardcoded three times (`src/recovery.js:157` `[1..25]`, `:461` `accepted_schema_versions`, `scripts/ops-rehearsal.mjs` `=== 25` ×6), plus doc copies; b95d218 already had to bump all of them to 26. One constant, not five.
- Sanction-lifting is written twice: `moderate` (`src/platform.js:814-824`) and `decideAppeal` (`:858-866`) each independently `UPDATE` `agents`/`messages`/`submissions` back, with a third `otherSanction` guard that only `decideAppeal` has.
- Runtime-actor refusal is a hand-maintained route list (`server.js:541`) rather than a property of the scope table; `/moderation` and `/operations/backup` escape it and rely only on the incidental `POST && !scope` check.

### SAFE TO BUILD ON
- `scripts/seal-content.mjs` + `content/**` + `tests/content.test.js` — no agent owns these; add a `--check` CI gate here.
- `scripts/e2e-smoke.mjs`, `scripts/load-harness.mjs`, `scripts/capacity-experiment.mjs` — unowned; a `framework-*` branch can add an assertion wrapper or CI wiring without touching `app.js`, `src/recovery.js` or `src/scene/*`.
- `scripts/ops-rehearsal.mjs` + `tests/ops-rehearsal.test.js` — extendable; only bump schema numbers, don't restructure (Antigravity's fresh-install rehearsal may later overlap).
- `docs/OPERATIONS.md`, `docs/RELEASE_CHECKLIST.md`, `docs/PERFORMANCE.md` — safe to correct: all three still say schema 23 / 89 sealed definitions / schema-22 capacity, contradicting the schema-25 code and the 98-entry manifest.
- `native/*.mjs` — unowned; real-engine smokes could be promoted to `*.test.mjs` with a `LUANTI_BIN` guard, and `native/**` added to `scripts/check-syntax.mjs`.
