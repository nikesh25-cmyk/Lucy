# Task: the Karma Coin ledger (`src/karma.js`)

A second, entirely separate in-world currency. NemoCoins (`src/coins.js`) are earned by one
independently accepted contribution on a real task, pay a fixed 10, are capped at 100 per operator per
UTC day, and are untouched by this task. Karma Coins are earned by **doing service in the world** and
spent **in the shop**; this module owns the ledger and the debit and nothing else.

## 0. The three files

| File | Lines | What it is |
| --- | --- | --- |
| `src/karma.js` | 364 | The ledger: policy, catalogue, source registry, schema, verification, the mint and the debit. |
| `tests/karma-ledger.test.js` | 344 | Ten tests, one per rule below, on a temporary database and the real `Platform`. |
| `docs/handoff/task-karma-ledger.md` | this file | Handoff. |

No other file was created or edited. `git status` shows `src/karma.js` and
`tests/karma-ledger.test.js` as untracked additions and no tracked file modified by me. The shop
(`src/shop.js`), the UI panel (`src/ui/shop-panel.js`) and their tests appeared in this tree during the
same window from other agents; I read `src/shop.js` to match its calls and did not touch it.

## 1. The public API (exact signatures)

```js
export const KARMA_POLICY;                     // frozen policy: version, currency 'Karma Coins', unit,
                                               // daily_operator_limit 60, daily_service_limit 2, tiers
                                               // {world, service}, and the no-value boolean flags
export const KARMA_SERVICES;                   // frozen catalogue: 12 entries of
                                               // { id, label, tier, award, per_day,
                                               //   requires_other_operator, source_kind, note }
export const KARMA_SCHEMA;                     // SQL text: karma_receipts, karma_purchases, their
                                               // indexes, the two rule/event views and seven triggers
export function verifyKarmaLedger(db);         // boolean, whole-ledger check (read-only, safe on a
                                               // read-only DatabaseSync)
export function karmaReconcile(platform, agent); // number: how many receipts were minted for one resident
export const karmaMethods;                     // mixed into Platform:
                                               //   karmaWallet(actor, input)      -> the wallet payload
                                               //   karmaSpend(actor, input)       -> { ok, balance_after,
                                               //                                     purchase_id, reason,
                                               //                                     reason_code, repeated }
                                               //   karmaExport(actor)             -> the whole purse
// two extras, additive and documented:
karmaMethods.initKarma();                      // the schema seam, like initGuilds/initJourney
karmaMethods.karmaSettle(actor, input);        // session-only settle: { agent_id, minted, balance, today }
export function karmaReceiptHash(row);         // the receipt chain proof, for recovery validation
export function karmaPurchaseHash(row);        // the purchase chain proof, for recovery validation
```

`karmaWallet(actor, { agent_id })` is the whole read gate: an operator session reaches only its own
residents, a resident runtime credential only the exact character it runs, everyone else gets 404 and an
unauthenticated caller 401 — the `owned()` helper copied from `src/vocations.js:578`. It rejects any
input key other than `agent_id` (400), so no amount, reason, source or day can arrive from a request.
It also writes nothing: it is a projection, and the schema seam is the only thing it ever needs
installed.

## 2. Every rule, and where it is enforced

| Rule | Method | SQL |
| --- | --- | --- |
| The faucet only reads rows the server already wrote | `karmaReconcile` reads `karma_source_events` itself; no caller supplies a source | the view is generated from `KARMA_SERVICES` |
| One saved row, one receipt | `NOT EXISTS` on the candidate query; `UNIQUE(agent_id,source_kind,source_id)` | unique index + the trigger's source join |
| The source row must exist at mint time | — | `karma_receipts_validate_insert`: "Karma receipt needs a verified saved source" |
| The credited wallet owns the resident (and is active) | `karmaReconcile` re-reads the agent and account rows | trigger case "Karma receipt needs an owned resident" |
| Service to others must involve a *different operator* | not a method branch at all: the row is invisible to the faucet | each service-to-others fragment carries its own `operator_id !=` comparisons (several characters of one operator are one operator) |
| The award day is the server clock | `day(platform)` = `new Date(platform.clock()).toISOString().slice(0,10)` | trigger: `NEW.award_day != substr(NEW.created_at,1,10)` aborts |
| Per-service allowance (`per_day` = 2) | the mint loop counts today's receipts before inserting | trigger: "Daily karma service limit" |
| Operator total (60 per UTC day) | the same loop refuses to cross it | trigger: "Operator daily karma limit" |
| Receipts and purchases are append-only | never updated or deleted by this module | `karma_receipts_no_update`/`_no_delete`, `karma_purchases_no_update`/`_no_delete` |
| Hash-chain continuity | `karmaReceiptHash` / `karmaPurchaseHash` at insert | `previous_hash` must equal the last row's `hash` in both triggers |
| Balance is derived, never stored | `derivedBalance()` = `SUM(receipts) - SUM(purchases)` | the purchase trigger refuses any insert that would drive it below zero |
| A debit is idempotent | the replay branch returns the recorded purchase | `UNIQUE(account_id,idempotency_key)`; the same key on another good or amount is a 409 |
| The debit is session-only | first line of `karmaSpend` (403 for a runtime) | — |
| A paused account cannot spend | the account row is re-read, not taken from the actor snapshot → `{ ok:false, reason_code:'account_paused' }` | trigger case "Karma purchase needs an active operator" |
| A paused platform cannot spend or settle | `this.active()` → 503 | — |
| Minting is not a resident's own act | `karmaSettle` requires `actor.kind === 'session'` (403); `karmaReconcile` takes an already-resolved agent | — |
| Karma never becomes NemoCoin, money or carbon | no code path reads or writes `coin_rewards` | asserted: `KARMA_SCHEMA` does not contain `coin_rewards` |

`KARMA_POLICY` states the no-value rules as booleans (`separate_unit`, `transferable`,
`transferable_between_accounts`, `transferable_between_residents`, `cash_value`, `cash_out`, `token`,
`convertible`, `convertible_from_nemo_coins`, `convertible_to_nemo_coins`, `convertible_to_money`,
`convertible_to_carbon_credits`, `buys_land`, `buys_role`, `buys_experience`, `buys_review_authority`,
`buys_moderation_power`, `buys_runtime_scope`) and as three sentences: `earned`, `not_earned` (chatting,
posting, claiming, submitting, reviewing, adopting, logging in, or anything only the resident itself
declared) and `description`. `sentence` is an alias of the one-line shop-panel convention.

## 3. The catalogue and the numbers

Five **world** services (award 2, 2/day, `requires_other_operator: false`), over six saved-row kinds:
`garden_crop` (`crop_plant`), `garden_harvest` (`crop_harvest`), `home_furnishing` (`home_furnish`),
`crafted_keepsake` (`craft`, proved by the append-only `audit` row the craft wrote), `saved_block`
(`frontier_place`). Seven **service to others** services (award 6, 2/day): `shared_space_visit`
(`shared_visit`), `thanks_to_neighbor` (`thanks`), `neighbor_circle` (`circle_join`), `neighbor_pledge`
(`project_pledge`), `neighbor_gathering` (`event_rsvp`), `guild_contribution` (verified by a third
operator), `guild_participation`. That covers every table the brief named. `source_kind` reuses the
saved-fact vocabulary `src/vocations.js` already publishes (`SOURCE_LABELS`), so the same fact has one
name across modules.

- **2 and 6.** The brief's ceilings. Service to others is exactly three times solo labour, so the world
  pays a resident for its own saved work without inviting it to farm one action for the same reward.
- **2 per service per day.** "One saved row, one receipt" bounds a single act; two a day bounds a single
  *kind* of act, so repetition pays a little and variety pays.
- **60 per operator per UTC day.** Ten service receipts: a full day of service funds the dearest shop
  good (40) with 20 left over. With 5 world + 7 service services the per-service allowances could pay
  104 a day, so the 60 total is the binding rule — which is exactly what test 5 proves (a sixth kind of
  service with its whole allowance unspent is still refused).
- **The schedule cannot be reached solo.** 30 world receipts would be needed to reach 60 from your own
  labour alone, i.e. 14 kinds of saved act you cannot produce; the world tier is a drip, the service tier
  is the faucet.
- A farm tile is deliberately **not** a furnishing: it is the garden's own tool, and the crop planted on
  it is the credited act. Otherwise one act (prepare a tile, plant on it) would pay twice.

## 4. The wallet payload

`karmaWallet` returns `{ agent_id, name, account_id, currency, unit, balance, earned, spent, policy,
policy_text, services, today, entries, counts, ledger_scope, has_more, verify, integrity_valid,
server_time }`:

- `balance` — the operator purse, derived on every read;
- `services[]` — the whole catalogue plus `tier_label`, `hint` (the note, in the shop panel's
  vocabulary), `used_today`, `remaining_today` and `minted`;
- `entries[]` — the newest 100 movements of the account, each `{ direction: 'earn'|'spend', id, amount,
  label, created_at, day }` plus the service or good and the resident that earned it. `earn` labels are
  the catalogue's own sentence, `spend` labels are `Spent on <good_id>`, because a purchase is never
  given a reason by its caller;
- `today` — `{ day, earned, spent, limit, remaining }`, the day being the server clock's;
- `counts` — receipts, receipts today, purchases, purchases today, earned, spent;
- `verify` — `{ ledger, chain, sources, balance_non_negative }`, all `true` because the read fails
  closed with 503 when the ledger does not verify (the `coins()` pattern);
- `ledger_scope: 'operator account'` — the purse is the operator's. The daily cap, the spend key and the
  debit are all measured per account, and the wallet names the resident it was asked about. **A resident
  runtime credential therefore sees its operator's whole purse, its siblings' receipts included**, and
  can change nothing: a runtime cannot spend or mint. If the integrator prefers a per-resident
  projection, filter `entries` by `agent_id`, but the balance must stay the account's or the debit and
  the cap stop agreeing.

## 5. Verification, and its one deliberate tolerance

`verifyKarmaLedger(db)` walks the whole ledger without writing and returns `false` on: a missing
karma table or view; a chain break or a row whose hash no longer matches its own columns; a service,
tier, award, allowance or `requires_other_operator` value the catalogue does not define; a day that is
not the row's own `created_at` day; a receipt whose resident is not owned by the credited account; a
per-service or per-day total above the stated limits; a purchase whose chain, hash, fingerprint, amount
or account is wrong; and any account whose derived balance would be negative. It re-checks **every
receipt against its source row whenever the world still holds that row**, and a row that is present and
mismatched is a finding.

An **absent** source row is not a finding, deliberately. The world legitimately forgets sources: a tile
is re-planted (the row keeps its key with a new `planted_at`), a circle is left, a furnishing is
removed, a guild is left, an operator deletes their journey record, a whole account is deleted. An
honest receipt must survive that, and refusing to verify would turn an ordinary withdrawal of data into
a permanent 503 for the wallet. The residual risk is stated plainly: a forger who can already write to
the database could name a source row of a revocable kind that no longer exists and pass the source
check — but such a writer can also recompute the chain, so the boundary is the same one
`docs/COINS.md` states for NemoCoins ("they do not defeat a compromised server, an administrator with
direct database access"). Closing it would need a durable source mirror or a trigger that refuses to
delete a credited source row, i.e. edits to other modules' tables. Not attempted.

## 6. Commands run, with real output

Exactly the three commands the brief allows (plus the mutation checks and two throwaway smoke scripts in
section 7; no other suite was run — `npm test`, `npm run browser` and `npm run e2e` were deliberately
not run, five agents share this tree).

```
$ node --check src/karma.js
exit=0
$ node --check tests/karma-ledger.test.js
exit=0
```

```
$ node --test tests/karma-ledger.test.js
# (node:36431) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# Subtest: a saved crop earns the world-tier award once, and the wallet is a private read-only projection
ok 1 - a saved crop earns the world-tier award once, and the wallet is a private read-only projection
# Subtest: service to others needs a different operator, and the wallet stays private to its owner
ok 2 - service to others needs a different operator, and the wallet stays private to its owner
# Subtest: one saved row earns one receipt, and a row the world does not hold is refused
ok 3 - one saved row earns one receipt, and a row the world does not hold is refused
# Subtest: a service pays twice a day and no more, in the method and in the trigger
ok 4 - a service pays twice a day and no more, in the method and in the trigger
# Subtest: the operator total stops at sixty Karma Coins a UTC day
ok 5 - the operator total stops at sixty Karma Coins a UTC day
# Subtest: the day is the server clock alone, and the allowance returns at the next UTC day
ok 6 - the day is the server clock alone, and the allowance returns at the next UTC day
# Subtest: a purchase debits once, stops at exactly zero and can never go below
ok 7 - a purchase debits once, stops at exactly zero and can never go below
# Subtest: a paused account, a resident credential and a paused platform cannot move Karma Coins
ok 8 - a paused account, a resident credential and a paused platform cannot move Karma Coins
# Subtest: guild service counts only another operator’s project and a different operator’s verification
ok 9 - guild service counts only another operator’s project and a different operator’s verification
# Subtest: an edited receipt, a broken chain or a forged wallet fails verification, and no Karma path moves NemoCoins
ok 10 - an edited receipt, a broken chain or a forged wallet fails verification, and no Karma path moves NemoCoins
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6289.609583
```

What each test proves, in order: the world tier from a real saved row (and that a wallet read writes
nothing, and that receipts cannot be edited or deleted); the service tier needs a different operator
while the same operator's thank-you is invisible to the faucet, with the 404/401 privacy gate; one row,
one receipt, a deleted row credited never, and the trigger's refusal of a source that does not exist;
the per-service allowance in the method **and** in the trigger (a hand-written row with a valid chain is
aborted); the 60-a-day operator total in both places; the controlled day boundary (`startAt`, then
`advance` across midnight) and the refusal of any request-supplied day; a purchase that debits once,
replays under the same key to the same `purchase_id`, lands on exactly zero, is refused when short, and
is refused by the trigger when written by hand; the paused platform, the suspended account, and a
resident credential that can read its own wallet but can never mint or spend; guild participation and a
guild contribution that only pays once a *third* operator has verified it; and finally three tampered
copies (an edited receipt, a broken chain, a forged receipt crediting the wrong wallet), the fail-closed
503 those cause, and the assertion that `coin_rewards` stays empty and no Karma route exists.

## 7. Evidence beyond the suite

- **Mutation checks** (the allowed test command run against `src/karma.js` with one control removed, then
  restored from a byte-identical backup, verified with `diff`):
  - remove the cross-operator condition from the thanks fragment → test 2 fails;
  - remove the operator cap from the receipt trigger → test 5 fails;
  - remove the balance check from the purchase trigger → test 7 fails;
  - remove the ownership check from the receipt trigger → test 10 fails.
  Run without the mutations, all ten pass.
- **The shop, end to end** (`node --input-type=module -e` against a throwaway temp database, both
  modules mixed in): two crops minted on day one and two more after the clock crossed a day boundary,
  `platform.shopCatalogue` read `balance: 8`, `platform.shopPurchase(actor, { agent_id, good_id:'herbs' }, 'shop-key-1')`
  returned `{"balance_after":0,"granted":{"category":"resource","kind":"herbs","quantity":2},"repeated":false}`,
  the same key replayed as `repeated: true` with no second debit, the shelf held `herbs 2`, the dearest
  good (`fountain`, 35) was refused `409 This purchase was refused: This purse holds 0 Karma Coins, so it
  cannot pay 35.`, and `verifyKarmaLedger` stayed true. So the debit and the grant really are one
  transaction, and `src/shop.js`'s assumptions about the refusal texts (`paused` → 403,
  `insufficient_balance` → 409) hold.
- **Self-healing**: on a platform that never called `initKarma`, `karmaWallet` reports
  `503 The Karma ledger is not installed on this platform; call initKarma first.`, `karmaReconcile`
  installs the schema and mints, and `initKarma` is idempotent (double call checked). `platform.verifyAudit()`
  stays true after minting and spending, because both write their `audit` rows through the existing chain.

## 8. The seam the integrator must add

1. `src/database.js`: `import {KARMA_SCHEMA} from './karma.js'` and `db.exec(KARMA_SCHEMA)` next to the
   other module schemas, inside the same `BEGIN IMMEDIATE` block. Additive only: two tables, two indexes,
   two derived views, seven triggers. `validateDatabase` accepts the unchanged `user_version` 22, and the
   module heals its own schema on the settle path if this is forgotten.
2. `src/platform.js`: `Object.assign(Platform.prototype, karmaMethods)` beside the other mixins, and
   `this.initKarma()` in the constructor beside `this.initGuilds()`. (`initKarma` is not required for
   correctness — the settle pass heals — but the wallet and a spend report a clear 503 without it.)
3. `platform.js`'s `exportAccount` and `deleteAccount` are the integrator's to extend:
   `karmaExport(actor)` is ready to be added to the export payload. There is deliberately **no**
   `deleteKarma`: a purchase or receipt table with holes in its hash chain would not verify, so account
   deletion should keep the rows (they hold only ids) or the integrator must design the purge.
4. `src/recovery.js`: no change is required (it checks that expected tables exist and never forbids
   extra ones). A stricter check is a one-line follow-up the integrator may want:
   `if (version >= 23 && !verifyKarmaLedger(db)) throw new Error('Database karma ledger validation failed.')`.
5. `server.js` routes (none exist yet, so `GET/POST /api/v1/karma*` currently 404):
   - `GET /karma` → `platform.karmaWallet(actor, Object.fromEntries(url.searchParams))`;
   - `POST /karma/settle` → `platform.karmaSettle(actor, body)`;
   - spending already arrives through `POST /shop` (see `docs/handoff/task-shop-engine.md`);
   - the settle call must be inside the route's existing `platform.transaction(...)` so the credit and
     the action it pays for commit together.
6. **Someone must call the settle pass, or nothing is ever minted.** The recommended wiring is to call
   `karmaReconcile(this, agent)` at the end of each service action (plant/harvest/furnish/craft/build,
   visit, thank, join, pledge, RSVP, guild contribution/participation) inside that action's existing
   transaction, or once per resident on a settle route. `karmaWallet` mints nothing on purpose.

## 9. Limitations / not done

- **Not wired into the server.** No route exercises this module yet, no real HTTP request has reached
  `karmaWallet`, `karmaSpend` or `karmaSettle`, and no UI renders the payload. The tests install the
  mixin and schema themselves (`Object.assign(Platform.prototype, karmaMethods)` plus `initKarma()`,
  the same pattern `tests/land.test.js` and `tests/inventory-migration.test.js` use for their schema).
  The absence is asserted rather than hidden: test 10 checks that `/api/v1/karma`, `/api/v1/karma/settle`
  and `/api/v1/karma/spend` are **not** routes, so the assertion will need removing when they land.
- **The full suite was not run** (by the brief's instruction, five agents share this tree), so I cannot
  promise this module leaves the other suites green. It edits no shared file, and the only tables it
  adds are new, so the risk is confined to the wiring steps in section 8.
- **`karmaWallet` verifies the whole ledger on every read** (the `coins()` pattern). At this scale it is
  microseconds; at ten thousand receipts it is a full scan per wallet read. A cached or incremental
  check would need a stored head hash, which is a schema decision for the integrator.
- **Verify tolerance** (section 5): an absent, revocable source row is not a finding. Stated here and in
  the code so nobody reads more into `verify: { sources: true }` than it says.
- **The runtime view of the purse is account-wide** (section 4). Defensible for a currency held per
  operator, and a deliberate choice rather than an oversight; filter `entries` by `agent_id` if the
  integrator wants it narrower.
- **`shared_space_visit` needs a public world owned by another operator.** A visit to an ownerless
  public place (`commons`, `library`, `orchard`, `hall`) or to your own home earns nothing, because both
  cases are the world paying you for walking into your own or nobody's space.
- **Not credited, on purpose**: claiming, submitting, reviewing, adopting, chatting, posting, logging in,
  job status, profile edits, journal entries, resource offers, cosmetic changes — none of these has a
  service, and no other module's row can be minted from. A resident cannot mint at all:
  `karmaSettle` refuses a runtime credential (403) and `karmaReconcile` never reads a caller's amount.
- **Cross-module observations, in files I must not edit**: `platform.exportAccount` does not include
  Karma, `deleteAccount` does not purge the karma rows, and `recovery.js` does not validate them (all
  three are section 8 items). Separately, `src/shop.js` publishes `can_afford` in `shopCatalogue` while
  `src/ui/shop-panel.js` reads `good.affordable` from the shop payload — a shop-side naming mismatch in
  two files that are not mine; the karma payload carries both conventions for its own fields
  (`note`/`hint`, `policy`/`policy_text`) so it does not have the same problem.
- **`tier: 'service'` renders as "Service" in the shop panel**, whose tier vocabulary only knows
  `world`- and `resident`-style words; the wallet also sends `tier_label: 'Service to others'`. Cosmetic,
  and the panel is not mine to change.
