# Trade board — bounded, coin-free exchange between operators

Branch `task-deepseek-trade-execution`, base `codex/final-integration` at **70359d0**. Schema stays
**22**; no `user_version` bump, `src/database.js` and `src/recovery.js` untouched, schema 23 left
reserved for its own owner.

## Goal

A server-authoritative marketplace so a resident can publish a **bounded quantity** of a gathered or
crafted resource and **another operator's resident** can accept it, with the same atomicity,
idempotency and replay safety as the shipped resident-to-resident offer layer. No new currency, no
NemoCoin, no money, no carbon credit, no land sale, no unit conversion: the only things that move are
kinds a resident actually harvested or crafted, inside the existing finite economy.

`src/trade.js`, `src/trade-import.js` and `src/trade-preview.js` already exist on this branch and are
the unrelated external **Comtrade research** surface (read-only source URLs for human review). They are
not touched, and the in-world board lives in new files so the two names never collide.

## Changed files

| File | What changed |
| --- | --- |
| `src/trade-board.js` | **New.** The sealed table/trigger block (`TRADE_MARKET_SCHEMA`), the bounds (`TRADE_MARKET_LIMITS`), the policy text (`TRADE_MARKET_POLICY`), the pure helpers (kind set, item normalisation, guarded escrow debit/credit, listing/claim views) and `verifyTradeRecords` — the fail-closed pass over the stored ledger. |
| `src/trade-market.js` | **New.** The execution: `tradeBoard` / `tradePost` / `tradeClaim` / `tradeCancel` / `tradeExpire` as ordinary platform methods (`this.run`, `this.get`, `this.clock`, the shipped `journey_inventory` shelf and audit chain), `ensureTradeMarket` (additive DDL plus the startup ledger check), and the one `Object.assign(Platform.prototype, marketMethods)` line. |
| `server.js` | Three new write routes (`/trade/listings`, `/trade/claim`, `/trade/cancel`) and the new read route (`GET /trade/listings`), both trade routes added to the shipped idempotency-key list, one `ensureTradeMarket(platform)` call in `createApp`, and one `platform.tradeExpire()` line in the existing three-second tick. No existing route, scope or limit changed. |
| `tests/trade-board.test.js` | **New.** 6 tests at the platform level: conservation, atomic accept, refusals, schema guards, fail-closed verification, operator isolation and the deleted-poster release. |
| `tests/trade-http.test.js` | **New.** 3 tests over a real server and port: route/scope/idempotency/expiry coverage, runtime behaviour, and a full HTTP walkthrough (register → invite → garden → harvest → post → claim → restart). |
| `tests/trade-migration.test.js` | **New.** 3 tests: additive migration inside schema 22, close/reopen/backup/restore round trip with expiry, and a tampered ledger refusing the start. |
| `docs/API.md` | One new section, **The trade board** (the four routes, the bodies, the result shapes, the refusals). |
| `docs/TRADE.md` | **New.** The model, the state machine, the balance proof, the bounds, recipient isolation, a manual walkthrough, migration/rollback and residual limits. |

Nothing on the never-touch list was edited: `src/platform.js`, `runtime/agent.js`, `app.js`,
`game-theme.css`, `game-mobile.css`, `index.html`, `src/game-input.js`, `src/camera-controls.js`,
`src/movement-queue.js`, `src/world-walk.js`, `src/journey.js`, `src/browser-session.js`,
`src/hosting.js`, `src/recovery.js`, `src/voxel-*.js`, `src/scene/**`, `src/spaces.js`, `world.js`,
`native/**`, `src/community.js`, `src/quests.js` and `src/coins.js` are byte-identical to 70359d0.

## The model

```
(none) --post--> OPEN          the poster's units are escrowed off its shelf at once
OPEN --claim (part)--> OPEN    the claimed units are credited to the claimer's resident once
OPEN --claim (last)--> FILLED  settled once; nothing is owed
OPEN --cancel--> CANCELLED     the posting side withdraws it; only the untaken units return
OPEN --expire--> EXPIRED       its stated life elapsed (a board call or the three-second tick)
FILLED / CANCELLED / EXPIRED are final: the lifecycle trigger refuses any later status change
```

| Table | Rows it holds |
| --- | --- |
| `trade_listings` | One standing listing: poster resident and operator, the posted items as JSON, note, status, `post_key`, posted/expiry/settled stamps and the released `returned` amounts. `UNIQUE(poster_account_id,post_key)`. |
| `trade_terms` | Per kind: `offered` and `taken`, with `CHECK(taken BETWEEN 0 AND offered)` — the unit ledger the balance proof reads. |
| `trade_claims` | One claim: listing, claiming resident and operator, `claim_key`, time. `UNIQUE(listing_id,claimer_account_id)` and `UNIQUE(claimer_account_id,claim_key)`. |
| `trade_claim_units` | What a claim took, per kind (`CHECK(quantity>0)`). |
| `trade_events` | Append-only history: `posted`, `claimed`, `filled`, `cancelled`, `expired`, with `detail` carrying the units. |

## Atomicity, idempotency, replay safety and isolation — the proof

Every claim here is backed by a named test and a database assertion, not by a code comment.

1. **Atomic accept.** The route runs inside `platform.transaction`; the claim row, its unit rows, the
   guarded `UPDATE trade_terms SET taken=taken+? ... AND offered-taken>=?`, the credit and the event are
   one statement group. `tests/trade-http.test.js` ("the board routes enforce consent, scopes,
   idempotency and expiry end to end") asserts the shelf and the listing before and after each step;
   `tests/trade-board.test.js` proves the rollback by posting a two-kind bundle whose second kind is not
   held and asserting the first kind never left the shelf, with no listing, no term and no event row.
2. **A unit moves at most once.** `tests/trade-board.test.js` ("a listed exchange moves each unit
   once, conserves every unit and mints nothing") sums every shelf and every open escrow before, during
   and after a post, a partial claim and a final claim: the totals are identical throughout.
   `verifyTradeRecords` re-derives `taken` from `trade_claim_units` and refuses a database where the
   two disagree.
3. **Replay safety.** `tests/trade-http.test.js` replays the post and the claim with the same
   `Idempotency-Key` and asserts `repeated: true`, the same row id and an unchanged shelf;
   `tests/trade-board.test.js` does the same through the platform. A key reused for a *different*
   listing or claim is refused 409.
4. **Negative stock is refused, twice over.** The escrow debit is
   `UPDATE ... AND quantity>=?` and the shelf keeps its `CHECK(quantity>=0)`; the over-take guard is
   `AND offered-taken>=?` under `CHECK(taken<=offered)`. Tests assert: posting more than held is 409
   and leaves no row; claiming more than is left is 409 with the available number; claiming a kind the
   listing never held is 400; a raw `UPDATE journey_inventory SET quantity=-1` and a raw
   `UPDATE trade_terms SET taken=offered+1` both fail.
5. **A settled listing is final.** Tested three times: a second claim answers 409 `filled`, a withdrawn
   listing answers 409, and a raw `UPDATE trade_listings SET status='open'` is aborted by
   `trade_listings_lifecycle`. `tradeExpire` called twice settles one listing once and returns 0 the
   second time.
6. **Restart persistence.** `tests/trade-http.test.js` (the walkthrough) stops the server, opens the
   same database again, and reads the filled listing, its claim and the claimer's shelf back — then
   replays the claim key and asserts `repeated: true` with nothing credited. `tests/trade-migration.test.js`
   does the same through `backupDatabase` → `validateDatabase` (schema 22) → `restoreDatabase` →
   reopen, and asserts the restored board is immediately usable.
7. **Recipient isolation.** A resident of the poster's own operator is refused 403 before any write and
   again by `trade_claims_validate_insert`; a session claims only for a resident it owns, a runtime only
   for the agent its credential is bound to (404 otherwise); only the posting side can withdraw (403
   otherwise); the open board excludes the caller's own listings and never names another operator's
   claimers.
8. **Nothing mints a coin.** Every test asserts `SELECT COUNT(*) AS n FROM coin_rewards` is 0, and
   `tests/trade-board.test.js` asserts no `money`, `currency`, `credit_balances` or `conversion_rates`
   table exists (the shipped unit-separation test's own list stays true). `TRADE_MARKET_POLICY` reports
   `coins_awarded: 0`, `moves_coins/moves_money/moves_land: false`, `converts_units: false`,
   `prices: 0`, `bids: 0`.
9. **A stored ledger that cannot balance refuses the start.** `verifyTradeRecords` is run by
   `ensureTradeMarket` (called from `createApp` before the listener is up). The tests tamper with a
   claim unit that no term can account for and with a listing whose terms were deleted, and assert the
   start throws `Stored trade board records are invalid.` — the compensating control for `recovery.js`
   being another owner's file.

## The end-to-end step

`tests/trade-http.test.js` — "one harvest, posted and claimed over HTTP, survives a restart" — is a
full HTTP walkthrough on a disposable database with no direct platform call: two accounts register over
`POST /auth/register` (the first is the administrator, the second accepts the invitation from
`POST /invites`), each creates a resident, the grower travels home, places a `farm` tile, plants herbs,
is refused a harvest while the crop is still growing, harvests it after the crop's own twenty minutes
and holds exactly two herbs, lists them (the shelf empties into the escrow), the neighbour reads the
board, claims the listing, receives the two herbs and leaves it `filled`, and the process is then
stopped and restarted on the same database to prove the listing, the claim and the shelf survive
byte-for-byte. A manual walkthrough with the same steps as `curl` commands is in `docs/TRADE.md`.

## Migration and rollback

- **Forward.** Additive only, and **no schema version bump**: `ensureTradeMarket` runs
  `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS` once per process per database, so a shipped schema 22
  database gains the five tables on its next start with every account, agent, world, inventory row and
  coin receipt intact. `tests/trade-migration.test.js` asserts the tables are absent before and present
  after, that `PRAGMA user_version` stays 22, that `validateDatabase` still reports schema 22, and that
  no pre-existing row changed.
- **Integration path for a schema 23 owner.** Move `db.exec(TRADE_MARKET_SCHEMA)` into
  `src/database.js`'s migration block beside the other additive schemas, bump `user_version`, and add
  `verifyTradeRecords` to `validateDatabase`'s version checks; `ensureTradeMarket` then becomes a no-op
  for the DDL and keeps only the fail-closed check.
- **Rollback.** Stop the server, preserve the current database and restore a verified pre-change
  backup with its matching code. Do not simply drop the five tables: an open listing's escrow would
  strand. Cancel every open listing first (each poster's untaken units return to its shelf), or accept
  that the escrow is discarded with the tables.

## Gate evidence

Actual results on the frozen tree, node **v24.19.0** (`work/node-bin/node`), macOS:

- `npm run check` — exit **0**.
- `npm test` — **900 tests, 899 pass, 1 fail** (123 s). This branch adds **12** tests (888 → 900). The
  one failure is `tests/mobile-styles.test.js:137` ("no touch selector exists in the main stylesheets",
  which reads `game-theme.css` line 208); it is **pre-existing at base 70359d0** —
  `git show 70359d0:game-theme.css` already contains `body.game-world.game-chat-open .nm-touch{display:none}`
  and the test file is unchanged — and it lives in files this task may not touch
  (`game-theme.css` is on the never-touch list). It is not caused by, and cannot be fixed from, this
  slice. My own 12 tests: `node --test tests/trade-board.test.js tests/trade-http.test.js
  tests/trade-migration.test.js` → 12 tests, 12 pass, 0 fail.
- `npm run e2e` — **17 steps passed, 0 failed**, exit 0.
- `npm run browser` — the slice adds no browser surface, and `server.js` is shared, so the shipped
  39-scenario real-Chrome suite was run four times on the frozen tree: **39 passed, 0 failed**, then
  **38 passed, 1 failed**, then focused with `LUCY_BROWSER_ONLY=restoration-two-clients npm run browser`
  → **1 passed, 0 failed**, then the full suite again → **39 passed, 0 failed** (exit 0 every time a
  scenario set was green). The single failure was `restoration-two-clients` timing out on a
  `locator.click` for the interface's own "Open a restoration" summary (`app.js`, `src/community.js`
  and `game-theme.css`, none of them this slice's files); it passes alone and passes in the next full
  run, so it is a load-dependent flake in an unrelated scenario rather than a regression from these
  routes. Both results are reported here rather than only the green ones.

## Residual limits

- **No player-facing interface.** `app.js`, `index.html` and the stylesheets belong to other owners, so
  the board is API-only in this slice: four documented routes with HTTP evidence and a manual
  walkthrough, no button in the game shell.
- **Two one-line integrations left for `src/platform.js`'s owner.** (1) `exportAccount` carries no
  `trade` section, so an operator's listings and claims are not in `GET /export`. (2) `deleteAccount`
  withdraws open offers (`deleteOffers`) but not open listings. The board compensates from its own
  side — a release is never credited back to a deleted resident (no shelf row is written for an account
  that asked to be removed), and the pending escrow of a deleted poster settles on expiry — but a
  `deleteListings(actor)` call beside `deleteOffers(actor)` would settle them at once.
- **Recovery does not know these tables.** `src/recovery.js` validates schema 22's own structures; the
  board's balance is checked by `verifyTradeRecords` at start (fail-closed) instead. A backup is
  validated for everything schema 22 covers and the board is re-checked when the restored database is
  served.
- **Expiry is lazy plus ticked.** An abandoned listing holds its escrow until the next board call or
  the three-second tick; nothing is lost and an expired listing cannot be claimed, but a process that
  never ticks and is never asked leaves the units held.
- **`npm run check` does not syntax-check the two new files**, because the check script names its files
  individually and `package.json` is outside this task's file ownership. Both files are parsed by
  `node --test` in every gate run.
- **One posting side to many claimers and no further**: no bundles, no reservations, no offers in
  return, no matching, and no account-level trade history beyond the bounded reads.
- **Same-operator exchange is refused by design**, in the method and in the claim trigger; a reviewer
  who wants intra-operator gifting must relax both deliberately.

## Ambiguity I resolved and reported

The instruction forbids bumping the SQLite schema and reserves schema 23 for another owner, while a
marketplace with a standing, unnamed recipient genuinely needs its own tables (the shipped
`resource_offers` row requires a named recipient and forbids a self-offer, so it cannot carry a listing
without a hack). I did **not** stop the slice: I read the rule as forbidding a *version* change, and the
five tables are created additively **inside schema 22** from a file this task owns, with the exact
one-line move into `src/database.js` documented above for whoever takes version 23. No table is renamed,
recreated or dropped, and `recovery.js`/`database.js` are byte-identical to the base commit.
