# Task 19 — revocable plot collaboration permissions

Branch `task-19-plot-collaboration` (one commit, *Add revocable plot collaboration permissions*), stacked on the reviewed batch baseline `verify-batch02-wave-c` at
`4333636` (*Merge branch 'task-28-production-readiness'*). Baseline at that commit, re-measured in this
worktree before the change: **511 tests, 511 pass**, syntax gate green, e2e 15/15, schema **18**. After
the change: **527 tests, 527 pass** (16 new), the same three gates green, schema **19**.

A plot steward's **human operator** can now invite one specific operator — or one specific resident of
that operator — to build on that one plot for a **stated purpose**, a **stated duration** and a
deliberately **narrow scope**, with expiry, revocation and an append-only audit trail. Every build
re-reads the grant from storage, so a credential cached before a revocation or an expiry cannot outlive
it.

## 1. Changed files

| File | Change |
| --- | --- |
| `src/frontier.js` | `PLOT_GRANT_SCHEMA` (`plot_grants`, `plot_grant_events`, five guard triggers, one index), `GRANT_SCOPE_LIMITS`, `PLOT_GRANT_POLICY`, `grantScopeNarrow` / `grantScopeValue`, the live-grant helpers, the extended `LAND_BLOCK_GUARDS`, `frontierBuild`'s guest path and `grant_id`, `frontierView`'s `grants` payload, the blueprint guest refusal, `landRelease`'s revocation, `frontierExport`'s grants, and `plotGrantPreview` / `plotGrantCreate` / `plotGrantRevoke` / `plotGrants`. |
| `src/database.js` | Schema guard `> 19`; `PLOT_GRANT_SCHEMA` after the land tables; the additive `frontier_blocks.grant_id` column; `DROP TRIGGER frontier_blocks_plot_insert` then the extended `LAND_BLOCK_GUARDS`; `PRAGMA user_version=19`. |
| `src/recovery.js` | Accepted-version list plus 19; `RECOVERY_LIMITS.schema_version` 19; a `version >= 19` block that validates the tables, the columns, the triggers, the index, the extended guard, every stored grant (identity, narrow scope, ordered expiry inside 14 days, revocation consistency, live steward) and every guest block's authorship. |
| `server.js` | `POST /frontier/grant` (`plotGrantCreate`, no scope → a runtime is refused by the route), `POST /frontier/grant/revoke` (`plotGrantRevoke`), `GET /frontier/grants` (`plotGrants`). |
| `app.js` | `plotCollaborationCard`, `grantRows`, `grantReportView`, `grantCheckboxes`, `grantFormValues`; the panel is mounted in the frontier card, `state.grantPreview` is cleared on operator change. `app.js` still contains zero `innerHTML`. |
| `tests/plot-collaboration.test.js` | New — 15 module-level tests (model, preview, guest build, scope, cap, budget attribution, live revocation, expiry/suspension, release/removal, no onward grant, registry unchanged, append-only, atomicity, tampering, migration/backup). |
| `tests/plot-collaboration-http.test.js` | New — 1 HTTP test over the real server (world payload, preview, runtime/guest refusals, grant, guest build, revoke, live refusal, listings, invariants). |
| `scripts/ops-rehearsal.mjs` | Schema-version assertions 18 → 19 (9 lines) and the two drill labels. |
| `tests/*.test.js` (18 files) | Hard-coded schema-version assertions 18 → 19, plus the three pre-19 fixtures (`recovery.test.js` v1, `human-players.test.js` v9 and v10) which must now also drop the collaboration layer, because a schema-9/10/18 database has no `plot_grants`. |
| `docs/API.md`, `docs/LAND_WORLD.md` | The routes, the model, the scope definition and the budget decision. |

Not touched: `src/platform.js`, `src/placement-policy.js`, `src/spaces.js`, `src/footprints.js`,
`src/civic-engine.js`, `world.js`, `catalog/`, `package.json`, `scripts/browser-suite.mjs`,
`scripts/e2e-smoke.mjs`, `render.yaml`, `.github/`, `HANDOFF.md`, `docs/VERIFICATION.md`,
`outputs/Lucy`.

## 2. The grant model

`plot_grants(id, plot_id, steward_account_id, guest_account_id, guest_agent_id, purpose, scope,
expires_at, created_at, revoked_at, revoked_by, uses, last_used_at, status)` — one row per invitation,
plus `plot_grant_events(id, grant_id, plot_id, account_id, action, detail, created_at)` as its
append-only history (`create`, `revoke`).

- **Human-controlled.** `plotGrantCreate`, `plotGrantPreview` and `plotGrantRevoke` all open with the
  existing `landHuman` rule and then require that the caller is *this plot's* steward. A runtime
  credential never reaches the rule: both new POST routes carry no runtime scope, and `server.js`
  refuses a runtime on a scopeless POST before dispatch. A guest session and an agent operator are
  refused by the steward check. A grant cannot be created for the steward's own account, for an
  inactive operator, or for a deleted resident.
- **One live grant per plot, guest operator and resident** (partial unique index
  `one_active_plot_grant`). A second live grant is `409`; a grant that has already expired is closed on
  the record (with a `revoke` event) and replaced, never silently extended.
- **Bounded creation.** At most 8 grants per plot per UTC day, at least 1.5 s between collaboration
  changes (reusing the land action interval), duration 15 minutes to 14 days.
- **Immutable identity, closed by revocation.** `plot_grants_lifecycle` refuses any change to the
  identity, purpose, scope, expiry or creation time and allows only `uses`/`last_used_at` movement on a
  live row or a single `active → revoked` transition with a time and an actor. `plot_grants_no_delete`
  and the two `plot_grant_events` triggers make the record append-only. `land_stewardships_revoke_grants`
  fires when a stewardship row is deleted, so an account removal revokes the grants that plot's steward
  created instead of leaving them dangling; `landRelease` revokes them explicitly first, with its own
  event and audit entry.
- **Storage-level validation.** `plot_grants_validate_insert` re-checks, in SQL, the same facts the
  route checks: a different guest operator, a real unreserved plot with a current steward for that
  exact account, an active guest operator, a resident that belongs to that operator, a narrow scope, a
  24-character expiry inside fourteen days of creation, and the untouched lifecycle columns.

## 3. What "narrow scope" means, concretely

The scope is a stored object with four bounded fields, and the same definition is enforced in the
route, in the storage trigger and in recovery:

| Field | Bound | Enforced by |
| --- | --- | --- |
| the plot | exactly one — the grant's own `plot_id` | route, trigger, recovery |
| `block_types` | 1–4 of the seven sealed frontier types | route, trigger, recovery |
| `layers` | 1–2 of layers 0–7 | route, trigger, recovery |
| `actions` | `place`, optionally `remove` | route, trigger, recovery |
| `max_blocks` | 1–36 standing blocks written under this grant | route + live count, trigger + live count, recovery |

This is deliberately narrow: a grant can never cover a whole area, every block type, every layer or an
unbounded amount of construction. Anything wider is refused with `400` rather than trimmed. At the
point of use a guest build is refused `403` when the block type, the layer or the action is outside the
scope, or when the grant's standing blocks already reach `max_blocks` — the count is read live from
`frontier_blocks.grant_id`, the same count the storage trigger uses.

## 4. Budget attribution (the decision, stated and tested)

**A guest's build consumes the guest operator's own daily action budget and its own 200 ms interval.
The steward's daily action budget is untouched.**

Reason: `frontier_actions.account_id` is the account that made the write, and the ledger must stay
truthful — a steward's 500 daily actions are their own day, not something a guest can spend on their
behalf, and a guest cannot escape their own limit by building on somebody else's land. The grant's own
`max_blocks` ceiling is a second, independent bound on the same work. `tests/plot-collaboration.test.js`
asserts, after one guest build: guest actions today `1`, steward actions today `0`; the guest's own
interval refuses the next guest build at once while the steward builds in the same millisecond; a guest
at the 500-action daily limit is refused while the steward is not; and `plot_grants.uses` /
`last_used_at` record the use.

## 5. The live-revocation proof

`liveGrant()` reads the grant row on **every** build — status `active`, not revoked, `expires_at` in the
future, the steward still stewarding the plot, the steward's account still active, the guest account and
resident matching the actor — and nothing about it is cached on the credential or on the actor object.
The tests hold one actor object across each change:

- a runtime credential obtained before the revocation is refused on the next build, and again after the
  guest's own cleanup `remove` of the block they placed;
- the same credential is refused once the 60-minute grant passes its `expires_at` by itself, while the
  row still reads `status: 'active'` until it is closed;
- pausing the guest resident, suspending the guest operator, suspending the steward and releasing the
  plot each refuse the next build;
- the storage trigger re-checks the same facts, so a direct `INSERT INTO frontier_blocks` without a live
  grant, or with a grant that does not cover the tile, is refused even though the method was bypassed.

## 6. The preview

`POST /frontier/grant` with `"preview": true` (and `plotGrantPreview` at the module level) returns the
exact access about to be authorised — plot address and its stewarded purpose, guest name and operator,
purpose text, the resolved scope (`block_types`, `layers`, `actions`, `max_blocks`), the duration in
minutes, the absolute expiry, the permission sentence and `writes: 0` — and performs **no writes**. The
test snapshots every row of every table before and after a valid preview, six refused previews and the
panel's own preview call over HTTP, and asserts byte equality. The panel renders the report in a
`role="status"`, `aria-live="polite"`, focusable region written with `textContent` only, and states on
the page that the preview wrote nothing.

## 7. Verification (actual results)

The focused patch is `../task-19-plot-collaboration.patch` (one commit, 29 files, +1437/−83).

```
npm run check  → exit 0 (all 30 files parse, including src/frontier.js, src/recovery.js, src/database.js, server.js, app.js)
npm test       → tests 527, pass 527, fail 0, cancelled 0, skipped 0   (baseline 511 + 16 new)
npm run e2e    → SUMMARY 15 steps passed, 0 failed  ("PASS — the shipped server serves this scenario end to end over its own HTTP API")
```

`npm run browser` is **not performed here and no browser scenario was added**: a parallel agent
exclusively owns `scripts/browser-suite.mjs`, that dev dependency is not installed in this worktree, and
this task owns no browser scenario. The panel's own contract is therefore verified over real HTTP in
`tests/plot-collaboration-http.test.js` (the same routes, headers and JSON the panel sends) plus the
module tests. **No automated check renders this panel in a browser**, so the markup, focus order, live
region and small-screen layout are reasoned from the existing components, not measured.

| Acceptance item | Test |
| --- | --- |
| Human-controlled grant | `a collaboration grant names one plot, one guest, a stated purpose and a deliberately narrow scope` — runtime, other operator and signed-out visitor all refused for preview and create; the HTTP test asserts the route-level runtime refusal. |
| Paused/suspended/revoked parties lose access | `expiry ends a grant by itself, and a paused or suspended party loses access too` (guest resident paused, guest operator suspended, steward suspended) and the acceptance of `resident()`/`authorize` for revoked credentials. |
| A cached credential cannot bypass a revoked grant | `revocation is read live, so a credential cached before the revoke cannot build`; the HTTP test revokes over HTTP and re-uses the same runtime token. |
| Budget attribution documented and tested | `a guest build spends the guest’s own daily budget and interval, and never the steward’s`; `PLOT_GRANT_POLICY.budget`; API.md and LAND_WORLD.md. |
| Concurrent changes atomic | `racing grants, a revoke mid-build and a repeated revoke stay atomic` (a second create inside one interleaving, a revoke + build in one `BEGIN IMMEDIATE` transaction that rolls back entirely, a repeated revoke that writes nothing). |
| Stewardship and registry inventory unchanged | `a grant changes neither the stewardship record nor the finite land registry` — whole-table snapshots of `land_parcels`, `land_stewardships`, `frontier_sectors`, the full `landSummary()` and `coin_rewards` before/after. |
| Preview writes nothing | `a preview reports the exact access, writes nothing and refuses outside the stewarded plot` and the HTTP preview assertion, both against a whole-database snapshot. |
| Guest scope refusals | `a guest builds inside the granted scope while every existing rule still applies` (type, layer, plot, protected tile, build range, occupied cell) and `the granted maximum of standing blocks …`. |
| Escape rule for a guest | `a guest cannot close a second layer around a resident either` — one climbable layer is allowed, the second layer that would complete the enclosure is refused `409`, nothing is written, and the guest can still take their own wall down. |
| Guests cannot grant onward or acquire land | `guests cannot grant access onward, acquire land or sub-let`. |
| Audit trail | `grants and their history are append-only, and stored rows keep their meaning` — rewrite/delete refusals, eight malformed direct inserts refused by the trigger, `verifyAudit()` on every test. |
| Migration / backup / restore | `a pre-change database migrates to schema 19, backs up and restores with its grants intact`. |

## 8. Migration and rollback (schema 19)

**Forward.** Opening a schema-18 (or older) database runs the additive block in `src/database.js`:
`plot_grants` and `plot_grant_events` are created empty, `frontier_blocks.grant_id` is added, the
stewardship-only `frontier_blocks_plot_insert` is dropped and replaced by the extended guard, and
`user_version` becomes 19. No existing table, row or trigger of another layer is rewritten; the
migration-rehearsal drill in `scripts/ops-rehearsal.mjs` proves a schema-17 world lands on 19 with
`world_objects`, `land_stewardships`, `land_events`, `coin_rewards`, `quest_enrollments`, `accounts`,
`agents` and `audit` unchanged. A guest block whose parcel remains is preserved
(`frontier_blocks.plot_id` is untouched by the migration); a block that had a `grant_id` keeps it,
because its grant row is preserved too. `validateDatabase` accepts 1–19 and applies the schema-19
block to a 19 database; a backup/restore round-trip is re-checked in the task's own test.

**Backward (rollback).** Reversing means removing the additive layer, in this order, on a stopped
server with a backup taken first: `DROP TRIGGER land_stewardships_revoke_grants; DROP TABLE
plot_grant_events; DROP TABLE plot_grants; DROP TRIGGER frontier_blocks_plot_insert;` then
`ALTER TABLE frontier_blocks DROP COLUMN grant_id;` then re-create the schema-18 guard (the literal is
in `tests/plot-collaboration.test.js` as `SCHEMA_18_GUARD`) and set `PRAGMA user_version=18`. An older
build then reads the world exactly as before, because nothing outside these objects changed. The order
matters: the `land_stewardships_revoke_grants` trigger references `plot_grants`, and dropping a land
table while it survives makes any later schema reload fail. Any row that named a grant is lost with the
layer, so take a backup; the guest's blocks themselves survive as ordinary parcel construction.

## 9. Deliberately not done

- **No blueprint through a grant.** `blueprintPlan` refuses a guest with a plain explanation; a guest
  places and removes single blocks inside the scope. A blueprint's mixed types and layers cannot fit a
  four-type, two-layer scope, and extending the scope to fit one structure would break the "narrow"
  promise.
- **No moderator revocation.** Only the plot's own steward may revoke, exactly as only the plot's own
  steward may release it. A moderator can still remove construction. A grant therefore has no third
  party who can end it early, which is why the duration is bounded at 14 days.
- **No browser scenario and no `scripts/browser-suite.mjs` change** (owned by a parallel agent).
- **No new dependency, no new route outside `server.js`, no change to `src/platform.js`,
  `src/spaces.js`, `src/footprints.js` or `world.js`.**
- **No coin, land, capacity or permission limit was raised.** The grant is deliberately narrower than
  the stewardship path it sits beside, and it writes nothing to `coin_rewards`.
- **The account export format label stays `shared-world-account-v18`.** `src/platform.js` is outside
  this task's file ownership, and the export's shape is unchanged — `frontierExport` gained only the
  operator's own `grants` and `grant_events`. A future task that owns `src/platform.js` can relabel it.

## 10. Residual risks

- **Concurrency is serialized, not parallel.** The platform is one synchronous SQLite connection with
  `BEGIN IMMEDIATE`, so "two grants racing" is tested as interleavings inside transactions, not as two
  live HTTP clients. Real parallel writers would still serialize on the writer lock; the partial unique
  index and the triggers are the backstop if they did not.
- **A revocation is not retroactive.** Blocks a guest already placed stay standing after the grant ends
  (they can only be removed by their builder or a human moderator). That is deliberate — the world does
  not delete work on a permission change — but it means a revoked guest's construction needs a human to
  clean up if it should go.
- **`expires_at` is compared as a 24-character UTC string.** That is the format this application writes
  everywhere (and recovery rejects anything else), and the trigger compares it against the block's own
  `created_at` so both sides come from the same clock. A database hand-edited with a differently
  formatted timestamp fails validation rather than being silently mis-ordered.
- **The trigger's stewardship-deletion path uses SQLite's wall clock** (`strftime('now')`) for
  `revoked_at`, because a trigger cannot see the injected test clock. In production the two clocks are
  the same; in a test that advances a fake clock far into the future the revocation timestamp can look
  earlier than the grant's creation. Recovery only requires it to be a well-formed timestamp.
- **The `max_blocks` ceiling counts standing blocks, not actions taken.** A guest who places and removes
  the same block repeatedly spends actions but not allowance; the daily action budget is what bounds
  that.
- **The panel is not browser-verified.** The manual walkthrough a human should run before presenting
  this UI: start a disposable server, steward a plot, open *Plot collaboration*, choose a nearby
  resident, set a purpose, duration, block types, layers and a block ceiling, press **Preview this
  grant** (expect the plot, guest, purpose, scope and expiry with no writes), press **Grant building
  access**, have the guest build inside the scope (accepted) and outside it (refused in plain text),
  press **Revoke this access**, and have the guest build again (refused).
- **A guest's identity is disclosed to the steward as a name and an agent id.** That is the point of
  naming a specific guest, and no email address, credential or contact detail is ever returned; the
  tests assert that no `@example.org` string appears in the payloads.
