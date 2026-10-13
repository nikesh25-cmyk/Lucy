# NemoWorld — DeepSeek Batch 03 shared baseline

This is the single shared baseline that **both** efforts in this batch build against: the Luanti
(native engine) effort and the DeepSeek (six service tasks) effort. Every number here was measured in
this checkout, on the exact commit named below. Anything that could not be measured is marked
**unverified** rather than asserted.

Read this file first, then [the ownership and interface contract](OWNERSHIP_AND_INTERFACES.md), then
[the six task specifications](TASKS_BATCH_03.md).

---

## 1. The baseline commit

| Item | Value |
| --- | --- |
| Commit | `a41d26046bd346cfe49f358d976ff157178352bc` |
| Branch | `integration/nemoworld-completed` |
| Commit message | *Integrate completed game experience with batch two and harden observation* |
| Working tree | clean (`git status --porcelain` empty) |
| Parent commit | `1dd5b6620e6e6a25fc35779de5ef1d94ae7386ba` (Task 38 stage 1–2) |

**Correction to the briefing's description.** The briefing calls `a41d260` "the merge of the batch-02
line (tasks 15–28) with the game-experience line (tasks 29–38)". The *content* claim holds — both
lines are in its ancestry — but the commit is **not a Git merge**: `git log -1 --format=%P` reports a
single parent, and the actual two-branch merge of the batch-02 line into the game-experience line is
the earlier commit `09485ce` (*Integrate completed civic systems with game-first world*, which merged
`440e0ba` *Integrate DeepSeek batch 02 (tasks 15-28) and refresh the handoff state*). Cite the hash
`a41d260…`; do not describe it as a merge commit.

`a41d260` is the measured runtime baseline. The original packet branch is
`task-deepseek-batch03-specs`, worktree `work/t39`. New task branches should use the latest
`integration/nemoworld-completed` tip containing this reviewed packet, so these contract corrections
are present before work starts; the runtime code at that tip is unchanged from `a41d260`.

---

## 2. Schema version

**`user_version = 22`.** Verified in this checkout:

- `src/database.js:18` — the guard: `if (db.prepare('PRAGMA user_version').get().user_version > 22) { db.close(); throw new Error('Unsupported database schema version.'); }`
- `src/database.js:149` — the migration transaction ends with `PRAGMA user_version=22; COMMIT;`.
- `src/recovery.js:133` — the accepted set is exactly `1…22`
  (`if (![1,2,…,22].includes(version)) throw new Error('Unsupported database schema version.');`).

The additive steps that produced 22 (each re-checked in `src/recovery.js`):

| Version | Added | Owner task |
| --- | --- | --- |
| 19 | Revocable plot collaboration (`PLOT_GRANT_SCHEMA`, `frontier_blocks.grant_id`) | 19 |
| 20 | Resident-to-resident resource offers (`RESOURCE_OFFER_SCHEMA`) | 18 |
| 21 | Bounded private resident memory (`MEMORY_SCHEMA`, `resident_memory`) | 21 |
| 22 | Versioned evidence library (`evidence_sources`, `evidence_captures`, `evidence_events`, `submission_evidence`) | 25 |

Schema history 1–22 is described in `docs/ARCHITECTURE.md` on the integrated documentation branch.

---

## 3. Gate results on `a41d260` (measured in this checkout)

Run with `export PATH="$PWD/../node-bin:$PATH"` (Node v24.19.0), on 2026-10-13.

| Gate | Command | Result |
| --- | --- | --- |
| Syntax | `npm run check` | **pass** — every `node --check` in the chain parses; exit 0 |
| Unit tests | `npm test` | **774 tests, 774 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**, duration ≈ 87.5 s |
| HTTP acceptance | `npm run e2e` | **15 steps passed, 0 failed** — `result PASS — the shipped server serves this scenario end to end over its own HTTP API` |
| Content seal | `node scripts/seal-content.mjs --check` | **89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets** |

These match `docs/VERIFICATION.md:5` (which records the same current-source state: 774/774, 15/15,
35/35 browser scenarios, 89 definitions, schema 22). The browser gate (`npm run browser`, 35
scenarios) was not re-run in the packet worktree. It was subsequently run on unchanged `a41d260`
source and passed **35/35 in real Chrome**. This packet changes no runtime source.

Because Batch 03's packet adds only Markdown files, both `npm run check` and `npm test` must and do
stay unchanged and green: the syntax gate is a fixed list of `.js`/`.mjs` files and `node --test`
discovers only `*.test.js`. Neither reads `docs/`.

---

## 4. Route inventory (measured, with one correction)

`server.js` keeps five hand-maintained tables: `files` (`server.js:33`, a `Map` of exact static
routes plus `for` loops that add icon/scene/UI entries), `writes` (`server.js:104`, a `Map` of
`route → [handler, scope]`), `gets` (`server.js:149`, a `Set` of GET routes), `specialWrite`
(`server.js:447`), and `dynamic` (`server.js:446`, the `/agents/:id/<action>` forms).

| Table | Measured size | How measured |
| --- | --- | --- |
| `writes` | **84 entries** (all 84 distinct) | counted from the map body between `const writes = new Map([` and its closing `]);` |
| `gets` | **46 entries** | counted from the single-line `Set` |
| `specialWrite` | **3 routes** — `/auth/register`, `/auth/login`, `/operations/backup` | `server.js:447` |
| `dynamic` | action map `{ travel, build, home, heartbeat, posture, look, climb }` | `server.js:446` |

**The briefing's "74 write routes" does not reproduce.** The measured value is **84**. The briefing's
"46 GET routes" is correct. Treat 84/46 as the baseline; if a later document quotes 74, it is wrong.
(The 84 paths are listed in full in the appendix of this file so the number is auditable.)

Scope resolution for a write is `dynamic?.scope || writes.get(route)?.[1]` (`server.js:497`); a
runtime credential is refused on any `POST` whose resolved scope is `null` (`server.js:501`).

---

## 5. Runtime action vocabulary and scopes (the contract agents must honour)

Agents, the managed resident worker, and any external bridge speak **exactly** this action vocabulary.
`parseAction` (`runtime/agent.js:61`) enforces the action name **and the exact key count**; an unknown
action, a wrong key count, a wrong type or an out-of-range value throws `Invalid model action.` and
the runtime declines it. `authorizeAction` (`runtime/agent.js:272`) is the advisory pre-filter and is
deliberately allowed to refuse an action the server would accept — **never** to approve one the server
refuses (`tests/runtime-policy.test.js` pins that direction).

| Action | Exact key count (including `action`) | Required scope (server re-checks) |
| --- | --- | --- |
| `wait` | 1 | — |
| `move` | 2 (`direction`) | `move` |
| `climb` | 2 (`direction`) | `move` |
| `walk_to` | 3 (`x`, `y`) | `move` |
| `look` | 3 (`yaw`, `pitch`) | `move` |
| `say` | 2 (`text` ≤ 500) | `chat` |
| `travel` | 2 (`world_id`) | `move` |
| `posture` | 2 (`posture` ∈ standing/sitting/meditating) | `move` |
| `build` | 4 (`type`, `x`, `y`) | `build` |
| `expand` | 2 (`direction`) | `build` |
| `remove_block` | 4 (`x`, `y`, `z`) | `build` |
| `build_block` | 5 (`type`, `x`, `y`, `z`) | `build` |
| `emote` | 2 (`emote`) | `move` |
| `circle` | 3 (`circle_id`, `intent` ∈ join/leave) | `contribute` |
| `pledge` | 3 (unpledge) or 4 (pledge + `commitment` ≤ 300) | `contribute` |
| `rsvp` | 3 (`event_id`, `intent` ∈ join/cancel) | `contribute` |
| `thanks` | 3 (`recipient_agent_id`, `reason` ≤ 200) | `contribute` |
| `garden` | 5 (plant + `kind`) or 4 (tend/harvest) | `build` |
| `craft` | 2 (`recipe_id`) | `build` |
| `remember` | 4 or 5 (`kind`, `attribute`, `value` ≤ 160 single line, optional `subject` ≤ 80) | `contribute` |

That is **20 actions** — the vocabulary quoted in the briefing, verified against `runtime/agent.js:61`
through `:115`.

**Runtime scopes** (the closed set): **`read`, `move`, `chat`, `contribute`, `build`.**
- `src/platform.js:301` refuses any other scope name at `POST /runtime/start`.
- `runtime/agent.js:594` refuses a runtime status whose scope list is not a subset of those five.
- The managed-worker permission modes map onto it at `server.js:601`:
  `observe → ['read']`, `explore → ['read','move','chat']`, `creative → ['read','move','chat','contribute','build']`.
- Default scopes at `POST /runtime/start` are `['read','move','chat','contribute']`;
  **`build` is never implicit** (`src/platform.js:300`).

`POST /runtime/start` (`src/platform.js:292`) is the only way an external client obtains a credential.
It enforces: one active agent session per operator (`:297`, else **429**), 1–20 minutes and 1–500
charged calls (`:299`), the scope allow-list (`:301`), agent kind `agent` (`:295`), and agent status
`active` (`:296`). It returns `{token, agent_id, expires_at, max_calls, scopes}`. `GET /runtime/status`
(`src/platform.js:309`) returns `{agent_id, expires_at, remaining_calls, scopes, paused}` and does not
spend budget.

**Budget counters.** A session's API budget is `tokens.max_calls` minus `tokens.used_calls`
(`src/platform.js:311`, `:305`), decremented by the dispatcher as charged calls are spent. A managed
run's model-decision budget is `resident_runs.decision_budget`, and the remaining decisions are derived
as `decision_budget - model_calls` (`docs/RUNTIME.md:38`).

---

## 6. Reproducing the baseline

### 6.1 On a fresh checkout (no installed data)

```sh
cd work/Lucy-repo
export PATH="$PWD/../node-bin:$PATH"     # Node v24.19.0
npm run check
npm test
npm run e2e
node scripts/seal-content.mjs --check
```

Expected: `check` exit 0; `774/774`; `15 steps passed, 0 failed`; `89 definitions …`.

The unit and HTTP gates create their own **temporary** databases. They never open `data/`,
`outputs/Lucy` or an installed account. The browser suite additionally refuses any database resolving
inside `data/`, `outputs/`, `outputs/Lucy`, `Lucy-repo`, `backups/` or `assets/`
(`scripts/browser-suite.mjs`, `productionDatabaseRefusal`, unit-tested in `tests/browser-suite.test.js`).

### 6.2 Migrating an installed schema-21 database to 22 (stop → back up → migrate → verify)

An installed world must be **21 or lower** to need this. Never rehearse on the installed world
(`docs/OPERATIONS.md:10`).

```sh
# 1. Stop the world. Confirm the process is gone. (Ctrl-C / SIGTERM.)
# 2. Back up first — the backup is the rollback.
node scripts/recovery.js backup data/world.sqlite data/backups/pre-migration-$(date +%s).sqlite
node scripts/recovery.js verify data/backups/pre-migration-<stamp>.sqlite     # {"schema_version":21,"accounts":N}
# 3. Migrate: opening a Platform on the database runs the additive transaction and writes user_version=22.
node server.js        # or: node -e "new (await import('./src/platform.js')).Platform('data/world.sqlite')"
# 4. Verify the migrated world.
node scripts/recovery.js verify data/world.sqlite                             # {"schema_version":22,"accounts":N}
```

What to check after step 4 (all from `docs/OPERATIONS.md:118`):
- `verify` reports **22**.
- Account, agent, world-object, land, coin, quest, guild, memory and audit counts are unchanged from
  before the migration.
- The schema migration creates new tables without inventing user submissions, reviews, coin receipts
  or audit events. Opening `Platform` then seeds the evidence library from the retained catalog. On
  this build, `evidence_sources` and `evidence_captures` each contain **222** catalog records after
  startup; `evidence_events` and `submission_evidence` begin empty. Do not assert that every new
  table stays empty.
- `GET /operations` shows `integrity.quick_check: ok`, `integrity.audit_chain_valid: true`,
  `integrity.coin_ledger_valid: true`.

Rollback: stop the server, `node scripts/recovery.js restore <backup> data/world.sqlite`, start again.
The migration runs inside one `BEGIN IMMEDIATE … COMMIT` transaction (`src/database.js`), so an
interrupted migration leaves the old version in place rather than a half-migrated database.

`node scripts/ops-rehearsal.mjs --drill migration-rehearsal` rehearses this on a disposable copy.

---

## 7. What "preserve existing identities, records and progress" means, concretely

Both efforts must preserve pre-existing identities, ownership, history and progress through migration
and integration. Normal authorized lifecycle writes to claims, runs, quests and other records remain
allowed; a task must not delete history, reassign ownership, replay a reward or recreate an existing
record merely to make its new feature work.

| Record | Where it lives (source of truth) | What must not change |
| --- | --- | --- |
| Accounts and their role | `accounts` (`src/database.js:20`) | identity, role, `status`; deletion stays an `UPDATE status='deleted'` that keeps the row |
| Human avatar and AI characters | `agents` (`kind`, `operator_id`) | the immutable `kind`, the one-human-avatar unique index, the five-agent cap |
| Sessions and runtime credentials | `tokens` (hash only) | only the SHA-256 hash is ever stored; a token is never written to a record, receipt or prompt |
| Presence and elevation | `agents.world_id, x, y, z, grounded, yaw, pitch` | stored coordinates stay server-authoritative |
| Land registry | `land_parcels`, `land_stewardships`, `land_events` (`src/frontier.js`) | 16,384 gross slots, canonical addresses, one stewardship per account |
| Plot collaboration | `plot_grants` + append-only grant events | grants are immutable history; revocation/expiry re-read at the point of use |
| Frontier construction | `frontier_blocks` | `plot_id`/`grant_id` attribution, the per-area cap, the storage triggers |
| Gardens and cottages | `world_objects` (`src/spaces.js`) | `UNIQUE(world_id,x,y)`, the garden/cottage build guard |
| Journeys, crops, inventory, offers | `journey_*`, `resource_offers` (`src/journey.js`) | atomic debits, no negative stock, offers move grown/crafted items only |
| Quests | `quest_chains`, `quest_steps`, `quest_enrollments` (`src/quests.js:74`) | steps advance only from a saved server fact; `/quests/complete` is always refused |
| Guild projects | `guild_projects`, `guild_participants`, `guild_contributions` (`src/guilds.js`) | distinct-operator verification; the layer grants no role, land, calling or coin |
| Resident memory | `resident_memory` (schema 21, `src/vocations.js:360`) | typed facts, mandatory source, operator approval, the 24/8/8/160/80/120 bounds |
| Coin rewards | `coin_rewards` (append-only, hash-chained, `src/coins.js:2`, `:33`) | the fixed 10-coin policy, the 100/operator/day cap, no update/delete |
| Mission work | `missions`, `tasks`, `claims`, `submissions`, `reviews`, `adoptions` (`src/platform.js`) | one active claim per operator; a claim lease of 20 minutes; independent review only |
| Evidence library | `evidence_sources`, `evidence_captures`, `evidence_events`, `submission_evidence` (schema 22) | captures are immutable and append-only; a citation is pinned to one exact version |
| Community | `community_events`, `community_rsvps`, `community_circles`, `community_projects`, `restoration<site>` event | progress is derived from saved rows, never stored as a claim |
| Audit chain | `audit` (`previous_hash`, `Platform.audit`) | one hash-linked append per mutation; `verifyAudit()` must keep holding |
| Sessions/feeds | `GET /events` SSE subscriptions | re-authorized once a second; a revoked session loses its feed |

"Progress" means: a resident's calling experience, quest steps, crops, inventory, merits, memory facts
and coin receipts are all preserved and are **not** re-minted, duplicated or replayed by either
effort. A restart, a resume or a reconnection must not double-credit anything (the existing
`Idempotency-Key`, the append-only uniqueness constraints and the derived-progress reads are the
mechanisms; see `docs/RUNTIME.md:59`).

---

## 8. The rule: nobody re-creates a table or a route that already exists

This is a hard rule for both efforts:

1. **A table that already exists is never re-created, dropped or replaced.** New state is **additive**
   — a new table, a new column via `ALTER TABLE … ADD COLUMN`, or a new index — inside the one
   migration transaction in `src/database.js`, and it is re-checked in `src/recovery.js`.
   `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS` are
   the shipped idiom (`src/database.js:60`, `:99`).
2. **A route that already exists is extended, not replaced.** The endpoints named in the task list —
   `/missions`, `/claims`, `/submissions`, `/reviews`, `/adoptions`, `/workers`, `/runtime/start`,
   `/memory`, `/memory/propose`, `/memory/manage`, `/interact` — already exist and are already wired
   in `server.js` (`server.js:104`–`:149`). A Batch 03 task changes their *handler* (in
   `src/platform.js`, `src/vocations.js`, `src/community.js`, `server.js`) or adds a new **adjacent**
   route; it never adds a second route with the same meaning and it never removes the old one.
3. **A second store is never invented.** There is exactly one claim store, one coin ledger, one memory
   table and one subscription channel. Preserve each route's shipped replay contract: selected
   mission writes honor `Idempotency-Key`, while other mutations need their own read-before-retry or
   route-specific guard. A task that builds a parallel store has misread its scope.
4. **A route's authority is never widened to make a task work.** No new scope name, no new role, no
   raised cap, no shortened distance, no relaxed distance/dedup rule.

---

## 9. Who owns what (one paragraph, so no effort starts the other's work)

**The Luanti agent owns** the engine choice, the Lua bridge/mod, the world graphics and scene
rendering, and the **final integration** of the two efforts. It must bridge to the existing mission
and identity services rather than re-implementing them, and it starts from this repository's own
pinned-commit research in `docs/VOXEL_ENGINE_REUSE.md`, **not** from fresh research. Anything about
Luanti beyond that document is **for the Luanti agent to verify against current official
documentation** — this packet asserts no Luanti capability as fact.

**DeepSeek owns the six tasks in this batch** — the agent mission adapter, persistent agent memory,
cooperative mission content, compute-budget controls, compatibility tests and security tests — all of
which **extend existing services**. DeepSeek does not choose or change the engine, does not touch the
Lua bridge, does not own world graphics, and does not own the final integration.

See [OWNERSHIP_AND_INTERFACES.md](OWNERSHIP_AND_INTERFACES.md) for the file/ownership map and the
integration boundary.

---

## Appendix — the 84 write routes on `a41d260`

```
/callings/select /land/assign /land/release /frontier/expand /frontier/build
/frontier/grant /frontier/grant/revoke /operations/registration /drafts /drafts/resume
/drafts/archive /residents/run /residents/cancel /residents/resume /research/run
/research/cancel /mayors/talk /mayors/control /ambassadors/talk /ambassadors/control
/research/generate /research/activate /invites /agents /agents/control /runtime/start
/move /climb /messages /interact /missions /missions/status /tasks /tasks/follow-up
/claims /claims/release /submissions /reviews /adoptions /reports /moderation
/appeals /appeals/decide /operations/pause /operations/accounts /jobs /auth/logout
/emotes /circles /circles/membership /projects /projects/pledges /projects/milestones
/events /events/rsvp /thanks /community/manage /journey/profile /journey/journal
/journey/garden /journey/craft /journey/offers /journey/offers/accept
/journey/offers/decline /journey/offers/cancel /quests/author /quests/manage
/quests/join /quests/leave /quests/complete /guilds/projects /guilds/participation
/guilds/contributions /guilds/verify /guilds/manage /memory/propose /memory/manage
/restoration/open /restoration/join /restoration/leave /restoration/contribute
/restoration/place /evidence/capture /evidence/withdraw
```

The 46 GET routes:

```
/callings /callings/guilds /quests /quests/catalog /guilds /guilds/project /land /land/plot
/frontier /frontier/grants /coins /drafts /workers /countries /country-evidence /assembly
/content /research /mayors /mayors/triage /ambassadors /ambassador /health /bootstrap
/world /worlds /civic /missions /gallery /briefing /me /history /safety /operations
/export /runtime/status /community /journey /journey/offers /events /interact /memory
/restoration /evidence /evidence/draft /review/workbench
```

---

## Documentation drift found during packet review

The original packet found `docs/ARCHITECTURE.md` stopping at schema 18 and schema-18 examples in
`docs/OPERATIONS.md`. The integration review updated both to version 22. Source remains
`src/database.js` plus `src/recovery.js`; task authors should check those files again if a later
migration lands.
