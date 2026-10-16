# NemoWorld — Batch 03 ownership and interface contract

This is the contract that keeps the two Batch 03 efforts from colliding. It is normative: if a task
would cross a line drawn here, the task is wrong, not the contract. Read it with
[BATCH_03_BASELINE.md](BATCH_03_BASELINE.md) and [TASKS_BATCH_03.md](TASKS_BATCH_03.md) open.

---

## 1. The two efforts, in one line each

- **Luanti effort (native engine).** Owns the engine choice, the Lua bridge/mod, world graphics, the
  scene/rendering work, and the **final integration**. It bridges to the existing mission and identity
  services; it does not re-implement them.
- **DeepSeek effort (six service tasks).** Owns the agent mission adapter, persistent agent memory,
  cooperative mission content, compute-budget controls, compatibility tests and security tests — all
  of which **extend existing services** in `src/` and `server.js`.

Neither effort owns the other's files. Neither effort may change the other's ownership without an
explicit, recorded hand-off.

---

## 2. File and ownership map

### 2.1 Luanti agent owns

| Surface | Files / area | Notes |
| --- | --- | --- |
| Engine choice and native client | whichever native engine is selected (Luanti is the leading candidate per `docs/VOXEL_ENGINE_REUSE.md:7`) | Not a browser renderer replacement; a separate client/runtime |
| Lua bridge / mod | the bridge and its Lua mod source | Must fetch bounded work from NemoWorld and apply **approved** mutations only |
| World graphics and scene rendering | native rendering; and, if any browser rendering changes are agreed in writing, `src/voxel-world.js`, `src/voxel-geometry.js`, `src/scene/**` | The browser renderer is currently the shipped one; a change here is an integration-scope change, not a DeepSeek one |
| Final integration | the merge of both efforts, the release gates, the handoff | Final integration is the Luanti agent's, including running `npm run check` / `npm test` / `npm run e2e` / `npm run browser` on the combined tree |

The Luanti agent **starts from `docs/VOXEL_ENGINE_REUSE.md`** (this repository's pinned-commit Luanti
research: engine pinned at commit `5bb520ba544536c4c2914bc0a5ad386e758d7036`, per
`docs/VOXEL_ENGINE_REUSE.md:33`). It does **not** re-do that research. Anything it asserts about
Luanti beyond that document must be **verified against current official Luanti documentation** and
recorded as verified-at-date; this packet asserts no Luanti capability as fact.

### 2.2 DeepSeek owns

| Surface | Files / area |
| --- | --- |
| Task 1 — agent mission adapter | `src/platform.js`, `runtime/agent.js`, `server.js` (existing routes only), `tests/**` |
| Task 2 — persistent agent memory | `src/vocations.js`, `src/platform.js`, `src/journey.js`, `tests/**` |
| Task 3 — cooperative mission content | `src/quests.js`, `src/guilds.js`, `src/community.js`, `content/**` (only through the sealing workflow), `tests/**`, fixtures |
| Task 4 — compute-budget controls | `src/platform.js`, `src/recovery.js` (diagnostics only), `server.js`, `runtime/model.js`, `scripts/ops-rehearsal.mjs`, `tests/**` |
| Task 5 — compatibility tests | `scripts/browser-suite.mjs`, `scripts/e2e-smoke.mjs`, `tests/**` (blocked on the Luanti bridge) |
| Task 6 — security tests | `src/coins.js`, `runtime/agent.js`, `runtime/runtime.test.js`, `tests/**` |

Exact per-task file lists are in [TASKS_BATCH_03.md](TASKS_BATCH_03.md); where a spec is narrower than
the table above, the spec wins.

### 2.3 Shared files — one writer each

These files have more than one interested party. They are **single-writer**: only the named owner
edits them, and anyone else requests the change through the owner.

| Shared file | Single writer | Why |
| --- | --- | --- |
| `src/database.js`, `src/recovery.js` | **The schema owner for the change in flight** (see §6) | One migration transaction; two writers corrupt the version chain |
| `app.js`, `index.html`, `nemo-theme.css`, `game-theme.css`, `style.css`, `game-mobile.css` | **The shell owner** (see §3) | One wiring owner, as the last batch established |
| `server.js` static route map (`files`, `gets`, `writes`, `specialWrite`, `dynamic`) | The task that needs the route, **one task at a time** | Hand-maintained tables; concurrent edits conflict |
| `package.json` (`check` list, scripts) | The task that adds a file to the gate | Additive only |
| `content/**` | Nobody directly — **only via `scripts/seal-content.mjs`** | The seal is the contract (`docs/CONTENT_DEFINITIONS.md:60`) |
| `HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/VERIFICATION.md` | **The final-integration owner** (Luanti agent) | Release figures; DeepSeek tasks return their own handoff instead |

Task readiness is not permission to edit shared files simultaneously. Tasks 1, 2 and 4 all touch
`src/platform.js`; tasks 1 and 4 touch `server.js`; tasks 1 and 6 may touch `runtime/agent.js`.
Apply and verify one shared-file change before rebasing the next task. Task 3 can author independent
content and fixtures. Task 6 can draft tests in parallel, but any control fix that touches Task 1's
files follows Task 1. Only one task may own a schema bump and its version number at a time.

---

## 3. The frontend / shell rule (already in force in this repo)

**Exactly one owner wires `app.js`, `index.html` and the main stylesheets.** This is the convention the
last batch established and it holds for Batch 03.

The precedent, from [the task 38 handoff](../handoff/task-38-frontend-integration.md):

- Task 38 was the **single** owner of `app.js`, `index.html`, `nemo-theme.css` and the static route map
  in `server.js`, and it explicitly did **not** touch `content/**`, `assets/**`, `outputs/Lucy`,
  `src/frontier.js`, `src/coins.js`, `src/civic-engine.js`, `src/ui/**`, `src/scene/**` or
  `game-mobile.css` (`docs/handoff/task-38-frontend-integration.md:34`).
- It wrote the integration contract as a **test** change: `tests/mobile-styles.test.js` used to assert
  `index.html` does *not* link `game-mobile.css`; after integration it asserts the link exists
  **exactly once**, which is the stronger post-integration contract
  (`docs/handoff/task-38-frontend-integration.md:280`).

For Batch 03 this means:

1. **The shell owner is named once, before work starts, and it is the Luanti agent** (it owns final
   integration, and the shell is the integration surface). DeepSeek tasks return payloads, HTTP
   contracts and module tests; they do **not** edit `app.js`, `index.html` or the stylesheets.
2. A DeepSeek task that needs a UI surface change **specifies the exact field names and the exact
   render function** it needs (the shipped idiom: `renderGuildProjects`, `loadGuildProjects`,
   `guildProjectCard`, asserted by `tests/guilds-http.test.js`), and hands it to the shell owner.
3. `app.js` contains **no `innerHTML` and no markup assignment** — asserted by
   `tests/newcomer-journey.test.js`, `tests/guilds-http.test.js` and `tests/quests-http.test.js`
   (`docs/handoff/task-38-frontend-integration.md:80`). Any new UI must preserve that: build nodes with
   `document.createElement`.
4. The static route map has to serve any new browser module the client imports; a missing entry makes
   the whole client module graph 404 (`tests/content-http.test.js` walks the graph from `/app.js`,
   `server.js:100`). The route-map owner adds it, and the file goes into the `check` list
   (`package.json`).

---

## 4. The integration boundary

Everything the two efforts share crosses exactly one boundary. This section says what may cross, what
must never cross, and who owns each record.

### 4.1 What crosses the boundary

| Crossing item | Shape | Over which interface |
| --- | --- | --- |
| Mission work records | `missions`, `tasks`, `claims`, `submissions`, `reviews`, `adoptions` | The existing `/missions`, `/claims`, `/submissions`, `/reviews`, `/adoptions` HTTP routes |
| Agent identity + a scoped credential | `{agent_id, token, expires_at, max_calls, scopes}` | `POST /runtime/start` (operator session); an authorized local handoff supplies the temporary token to the trusted bridge in memory |
| A bounded world/work observation | the authenticated `GET /world` payload | `GET /world` with the runtime bearer token |
| Saved world state | resident position/elevation (`agents.*`), `world_objects`, `frontier_blocks`, crops, inventory | The existing action routes (`/move`, `/climb`, `/frontier/build`, `/journey/garden`, …) |
| Progress signals | calling receipts, quest step state, merits, approved memory facts, coin receipts | The read routes that already expose them (`/callings`, `/quests`, `/journey`, `/memory`, `/coins`), each under its own authorization rule |
| Live world deltas | `ready` / `update` / `closed` frames | `GET /events` (Server-Sent Events), one authenticated subscription per client |

### 4.2 Restricted data and destinations

- **Temporary runtime bearer token.** It necessarily crosses from the operator-authorized
  `/runtime/start` response to the trusted bridge, then travels in the authorized HTTP header. Keep
  it in process memory only. Never write it to a record, receipt, log, model prompt, world observation
  or source archive. NemoWorld persists only its SHA-256 hash (`tokens.hash`;
  `resident_runs.credential_hash`; `docs/THREAT_MODEL.md:16`). The exact local handoff transport must
  be specified and tested by the bridge owner before use.
- **Other secrets.** Passwords, password digests, the private `setup_code`, operator session tokens
  and unrelated `Authorization` values never go to the bridge or model. The setup code exists only in
  the environment (`docs/THREAT_MODEL.md:20`).
- **Private memory.** `resident_memory` is owner-only: another operator, a sibling character and any
  other runtime credential receive **404**; a revoked/expired credential receives **401** before the
  handler runs (`docs/API.md:443`). Approved facts may enter the *same bound resident's* private
  runtime prompt; never send them to another resident, the public feed or a native spectator.
- **Private conversations.** `private`, `nearby` and `mission` conversations are never published on
  the event channel and never appear in another party's read (`docs/API.md:199`).
- **Private drafts, journals, evidence artifacts and contact addresses.** Redacted or refused by
  design (`docs/OPERATIONS.md:275`).
- **Any instruction that arrives as observed text.** World observations, including messages, are
  untrusted data: they cannot grant a scope, add a tool, choose a recipient or change a budget
  (`docs/RUNTIME.md:118`; `runtime/agent.js:61`–`:115`).

### 4.3 The single source of truth for each record

Only one component owns each record. Everyone else reads it through that owner's route.

| Record | Source of truth (table) | Owning route(s) |
| --- | --- | --- |
| Account identity + role | `accounts` | `/auth/register`, `/auth/login`, `/me`, `/operations/accounts` |
| Character / avatar | `agents` | `/agents`, `/agents/control`, `/me` |
| Session + runtime credential | `tokens` (hash only) | `/auth/*`, `/runtime/start`, `/runtime/status` |
| Presence, elevation, posture | `agents.world_id/x/y/z/grounded/yaw/pitch` | `/move`, `/climb`, `/agents/:id/{posture,look,travel,heartbeat}`, `/world` |
| Home / garden furnishing | `worlds`, `world_objects` | `/agents/:id/{build,home}`, `/world` |
| Land registry + stewardship | `land_parcels`, `land_stewardships`, `land_events` | `/land`, `/land/plot`, `/land/assign`, `/land/release` |
| Plot collaboration | `plot_grants` (+ append-only events) | `/frontier/grant`, `/frontier/grant/revoke`, `/frontier/grants` |
| Frontier construction | `frontier_blocks` | `/frontier/build`, `/frontier/expand`, `/frontier` |
| Mission definitions and tasks | `missions`, `tasks` | `/missions`, `/missions/status`, `/tasks` |
| Work claims | `claims` | `/claims`, `/claims/release`, `/history` |
| Submitted evidence | `submissions`, `submission_evidence` | `/submissions`, `/history`, `/gallery` |
| Independent review | `reviews` | `/reviews`, `/review/workbench` |
| Adoption declaration | `adoptions` | `/adoptions` |
| Coin ledger | `coin_rewards` (append-only, hash-chained) | `GET /coins` reads; independent accepted `POST /reviews` issues a receipt through server policy, with no direct coin-write route |
| Calls, quests, guilds | `resident_callings`, `calling_receipts`, `quest_*`, `guild_*` | `/callings`, `/quests*`, `/guilds*` |
| Resident memory | `resident_memory` | `/memory`, `/memory/propose`, `/memory/manage` |
| Evidence library | `evidence_sources/_captures/_events` | `/evidence`, `/evidence/draft`, `/evidence/capture`, `/evidence/withdraw` |
| Community + restoration | `community_*`, `restoration:<site>` event | `/community`, `/restoration` |
| Durable run state | `resident_runs` | `/workers`, `/history`, `/residents/{run,resume,cancel}` |
| Audit record | `audit` (hash chain) | `GET /operations` (admin only) reads; authorized server mutations append through `Platform.audit` |

**Rule.** An external engine (Luanti bridge) or a DeepSeek task that needs one of these records reads
it through its authorized read route and requests mutations only through the relevant existing
server write route. Some records, including coin receipts and audit entries, have no direct client
write route; server policy derives them from authorized actions. A bridge never opens the SQLite
file directly or keeps a second authoritative copy of a table record.

---

## 5. Secrets, network permissions and how an engine gets a credential

**Server secrets and network policy stay server-side.** The Node service holds the setup code, the
scrypt password digests, the token hashes, the fetch allow-lists and the outbound network policy. A
trusted bridge may briefly hold only its scoped runtime bearer token in memory. The model adapter
exposes **no** shell, filesystem, external-URL or payment tool (`docs/RUNTIME.md:118`).

**How an external engine uses a scoped, expiring credential:**

1. A human operator creates the character and starts a bounded session through the operator API:
   `POST /runtime/start` with `{agent_id, minutes:1–20, max_calls:1–500, scopes:[…]}`.
   Enforced at `src/platform.js:292`–`:308`. This is the **only** way to mint a runtime credential.
2. The response is `{token, agent_id, expires_at, max_calls, scopes}`. The token is **short-lived**
   (1–20 minutes) and **scope-bounded** (a subset of `read, move, chat, contribute, build`), and it is
   bound to exactly one character. The operator must pass it to the trusted bridge through a local,
   explicitly designed handoff; do not put it in a command line, file, log or model context. The
   bridge holds it only in memory until expiry or revocation, and a new session revokes the previous
   token (`src/platform.js:302`).
3. The engine calls `GET /runtime/status` immediately before each model request and again before
   dispatching any action. It stops when the status is denied, `paused` is true, `expires_at` has
   passed, or `remaining_calls` is zero (`docs/RUNTIME.md:24`).
4. Every write carries a deterministic `Idempotency-Key` (`writeKey(runId, decision, path, body)`,
   `runtime/agent.js:57`), so a retried request is recognisable as the write already sent. The server
   honours that header on claim, submission, draft and follow-up writes (`docs/RUNTIME.md:59`).
   Other mutation routes need their own idempotency or read-before-retry behavior; this key does not
   make every write replay-safe.
5. On revocation, pause or expiry the token is refused **before any handler runs**. A managed run's
   token is revoked on process restart by `recoverWorkerJobs` (`src/platform.js:888`); the interrupted
   run is resumed only by an explicit `POST /residents/resume`, which mints a **fresh** credential.

The Luanti bridge follows this pattern for AI residents: it receives a short-lived scoped credential
per run and treats it as an ephemeral in-memory value that is never persisted. The bridge must not
mint credentials itself. The current runtime-token route is bound to AI characters; native **human**
play with attributed mutations needs a separately designed operator-pairing boundary before it can
be claimed as implemented. Do not reuse an AI token to attribute a human action.

---

## 6. Schema bumps: who owns the change and what acceptance it owes

A schema bump is needed when a task adds or alters a table, column, index, trigger, view or `CHECK`.
That is the only case where `src/database.js` and `src/recovery.js` are edited.

**Ownership.** The task that needs the bump **owns both files for that bump** and is the single writer
for the duration. Concretely, the owner edits:

- `src/database.js` — the `> N` guard (`src/database.js:18`) and the additive block inside the one
  migration transaction (`src/database.js`), ending in `PRAGMA user_version=N; COMMIT;`. New objects
  use `IF NOT EXISTS`; existing tables are never dropped or replaced (see
  [BATCH_03_BASELINE.md §8](BATCH_03_BASELINE.md)).
- `src/recovery.js` — the accepted-version set (`src/recovery.js:133`), a `version >= N` validation
  block that requires the new tables/columns/triggers and re-checks the new invariants, and any new
  `Object.freeze({...})` policy record in the diagnostics vocabulary (compare
  `src/recovery.js:424`, the memory policy).

**A bump's acceptance is exactly four things, all of which must be demonstrated:**

1. **Migration** — an old-version database opens, migrates **additively**, and reports the new version;
   existing user work is preserved and no contributions, reviews or rewards are invented. Seeded
   catalog records are allowed when explicitly specified and tested: schema 22's `Platform` startup
   seeds 222 evidence sources and captures on the checked catalog. Precedent:
   `docs/handoff/task-06-guild-projects.md:168` (a schema-17 copy migrates to 18 with empty guild
   tables and the protections restored) and `node scripts/ops-rehearsal.mjs --drill migration-rehearsal`.
2. **Backup/restore round-trip** — `backupDatabase` → `validateDatabase` → close/reopen → `restoreDatabase`
   round-trips the new records with the audit chain and coin ledger still valid. Precedent:
   `docs/handoff/task-06-guild-projects.md:171`; recovery tests in `tests/recovery.test.js`.
3. **Version assertions** — every hard-coded current-version expectation in `tests/**` moves from the
   old number to the new one (the legacy forward-migration expectations such as `user_version = 1`,
   `2`, `6`, `9`, `10`, `13`, `14`, `15` stay unchanged and keep asserting forward migration). This is
   the exact set of files the last two schema bumps touched
   (`docs/handoff/task-06-guild-projects.md:259`).
4. **Fail-closed validation** — `validateDatabase` refuses a database whose new table was dropped or
   whose new invariant was tampered with, and a backup that lost the new table is refused. Precedent:
   `docs/handoff/task-06-guild-projects.md:119`.

A task that needs no schema change (as several later tasks did — e.g. task 23 added none,
`docs/handoff/task-23-cooperative-events.md:26`) states that explicitly and touches neither file.

**Never resolve a failing gate by deleting coverage, inventing a result, or raising a permission,
reward or capacity limit** — the standing rule of this repository
(`docs/deepseek/TASKS_BATCH_02.md:9`, `docs/OPERATIONS.md:12`).

---

## 7. Change-control checklist (apply before opening a Batch 03 branch)

- [ ] The task's spec in [TASKS_BATCH_03.md](TASKS_BATCH_03.md) names every file it may change, and
      this branch touches only those.
- [ ] No file in §2.3 is edited by a non-owner.
- [ ] No table and no route that already exists is re-created (baseline §8).
- [ ] Any runtime credential is short-lived, scope-bounded and obtained through
      `POST /runtime/start` (§5); the trusted bridge holds it only in memory and never persists it.
- [ ] Restricted data in §4.2 reaches only its authorized destination.
- [ ] If a schema bump is involved, §6's four acceptance items are all met and both `src/database.js`
      and `src/recovery.js` are owned by this task alone.
- [ ] `npm run check` and `npm test` are green on the delivered tree, with the **real** numbers
      reported.
- [ ] The task returns its own handoff under `docs/handoff/`; it does **not** edit `HANDOFF.md` or
      `docs/VERIFICATION.md` (those are the final-integration owner's).
