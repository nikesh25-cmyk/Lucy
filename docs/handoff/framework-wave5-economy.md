# The Wave 5 economy slice — social and economic consistency

Branch `framework-wave5-economy` (worktree `work/wave5`), base `0a41126` — the Karma/shop owner's
completed tip, which had already ported `src/karma.js`, `src/shop.js` and `src/ui/shop-panel.js` onto
schema 26. **Schema is unchanged at 26**: no table, column, view, trigger or version was added or
altered, and no migration exists. The slice integrates the Karma/shop work with the trade board, the
resource-offer layer, `journey_inventory`, the grants, NemoCoins and the account lifecycle.

Nothing was pushed, merged, deployed, tagged or installed, and no browser suite was run (the
integrator runs Chrome serially). The installed live product was never read, written, checked out or
started.

## What landed, by file

| File | Why |
|------|-----|
| `src/goods-policy.js` *(new)* | The single source of truth: every good family, its class, its reason, and the one enforcement call a transfer path makes. Also the readable classification surface and the export projection. |
| `src/economy-provenance.js` *(new)* | Resolves a reward to the saved contribution that earned it and to the reviewer where a review was required. Reads only; contains no write statement. |
| `src/trade-market.js` | One import, two guarded calls: `assertTransferable` before the escrow in `tradePost`, `assertReservationCovered` before the claim in `tradeClaim`. |
| `src/journey.js` | The same two guards in `offerCreate` and `offerAccept` — the other path that moves a shelf item between operators. |
| `src/shop.js` | One import and one spread in `shopCatalogue`: each good's class comes from the classification table instead of the shop deciding for itself. |
| `src/platform.js` | One import, one mix-in, one field in `exportAccount` (`goods`). The account lifecycle now carries the classification. |
| `server.js` | Two additive read routes: `GET /economy/goods`, `GET /economy/provenance`. |
| `tests/economy-goods-policy.test.js` | The classification and its enforcement, including the named refusal and a legacy escrow. |
| `tests/economy-invariants.test.js` | Conservation, atomicity (two real SIGKILL crashes), replay safety, deletion, restart. |
| `tests/economy-provenance.test.js` | Both halves of provenance: a genuine reward resolves, an untraceable one is flagged or refused. |
| `tests/economy-separation.test.js` | The four units of account as policy, no conversion/cash-out/sale path, and the counting half. |
| `tests/economy-abuse.test.js` | Collusion, self-service, replayed content under one key, concurrent purchases. |
| `tests/framework/known-gaps-economy.mjs` *(new)* | Four findings this slice must not fix, reproducible by hand and **not** discovered by the runner. |
| `scripts/economy-walkthrough.mjs` *(new)* | A human and an AI resident through a real exchange and a real server restart. |

Shared-file changes are surgical: `git diff --stat` for the five modules is **34 insertions and 3
deletions**. No behaviour of the Karma/shop owner's modules was altered — `src/karma.js` is untouched,
and `src/shop.js` gains one projected field.

## 1. What is transferable and what is account-bound

`src/goods-policy.js:59` `GOOD_FAMILIES` names every family once, with its class, where it may go, the
reason and the evidence:

| Family | Class | Kinds | Reason in one line |
|--------|-------|-------|--------------------|
| `grown_crop` | transferable | `herbs, fiber, wood, blossom, grain, resin` | The resident's own saved world labour in its own garden; the board's original concern. |
| `crafted_keepsake` | transferable | `flower_crown, woven_banner, garden_lantern, herbal_wreath, reed_whistle, festival_banner` | Made from ingredients the shelf already held; a craft debits them in the same transaction. |
| `shop_resource_bundle` | transferable | the same crop kinds | The shop hands over the same sealed kinds a harvest yields, in the same shelf row; a crop kind is fungible once held. |
| `shop_cosmetic` | **account-bound** | the sealed craft keepsakes | Bought with Karma Coins. Moving one carries Karma value out of the account, and the Karma Coin itself is not transferable. |
| `shop_object_grant` | **account-bound** | (none stocked) | An entitlement to place one object in the buyer's own world, never a loose item. |
| `karma_coin` | **account-bound** | — | Separate in-world unit: no gift, no transfer, no conversion. |
| `nemo_coin` | **account-bound** | — | Internal contribution credits, issued to one operator. |
| `compute_credit` | **account-bound** | — | Unimplemented concept with no balance or ledger at all. |
| `real_money` | **account-bound** | — | No payment, price, cash-out or token exists. |
| `carbon_credit` | **account-bound** | — | No balance, registry, transfer or conversion exists. |
| `calling_experience` | **account-bound** | — | Cosmetic measure of one resident's own activity. |
| `land_stewardship` | **account-bound** | — | A grant of responsibility with no price, sale or transfer route. |
| `role_authority` | **account-bound** | — | Review authority and moderation power must never be purchasable. |
| `runtime_scope` | **account-bound** | — | A bounded permission issued by an operator to its own credential. |

**The enforceable rule.** `journey_inventory` stores a kind and a quantity, never a provenance: a
flower crown a resident crafted and one it bought are one row. So the rule is a per-account
*reservation*, not a per-unit label — an account that bought N units of kind K never moves more than
`held(K over all its residents) − N` (`src/goods-policy.js:197`). It is exact in quantity (no unit is
lost or double-counted) and conservative in identity (the bought units are assumed retained), and it
refuses exactly the case the Karma/shop handoff named: a purchased-and-unused keepsake.

**Where it is enforced.** Escrow time (the move that actually takes the units):

- `src/trade-market.js:168` — a listing, after the replay branch so a retry is unaffected.
- `src/journey.js:645` — a resource offer.

Take time (closing a legacy escrow written before this rule existed, or by a database whose trigger
was stubbed):

- `src/trade-market.js:213` — a claim on another operator's listing.
- `src/journey.js:671` — an acceptance of another operator's offer.

Read time — the rule is data a player can read, not a hidden branch:

- `GET /economy/goods` → `goodsPolicyView` (`src/goods-policy.js:257`), the whole table plus this
  account's own reservations and surplus.
- `shopCatalogue` (`src/shop.js:269`) states each good's class.
- `exportAccount` (`src/platform.js:980`) carries `goods` — the account lifecycle's own copy.

**What a refusal says.** HTTP 409 with `reason_code: 'account_bound_good'` and a sentence naming the
reservation, for example:

> `flower_crown is account-bound: this operator bought 1 of it from the shop and holds 1, so 0 may
> leave the account and 1 were requested. A keepsake bought with Karma Coins is worn by the buying
> account's own resident and is never listed to another operator.`

`tests/economy-goods-policy.test.js` proves: the refusal on the board and on the offer path with the
named reason and no row written anywhere; that the keepsake stays holdable and wearable; that a
crafted keepsake still moves between operators; that only the surplus above the reservation moves
while the rest stays with the account that bought it; and that a legacy escrow is neither claimable
nor acceptable, returning to its own account instead.

## 2. The economic invariants, and how each is proved

| Invariant | Proof |
|-----------|-------|
| **Conservation** — nothing is created or destroyed by a trade, a purchase, a craft, an escrow return or a deletion | `tests/economy-invariants.test.js` counts every unit of every kind in all three places it can be (shelf, open-listing escrow, proposed-offer escrow) and asserts the change equals exactly the recorded grant, craft or deletion. A purchase, a craft and a trade; a cancel, an expire and a partial claim; and a deletion each get their own identity. The owner's own `tests/trade-board.test.js` and `tests/karma-integration.test.js` already prove the single-case halves; this file proves the identities across them at once. |
| **Atomic trades** — a half-completed trade cannot exist after a crash or a restart | `tests/economy-invariants.test.js` spawns two child processes that run a **complete** real claim and a **complete** real purchase inside a real transaction and then `SIGKILL` themselves before it commits. After each: no claim row, no taken units, no purchase row, no debit, no grant, the listing still open, the shelf unchanged, `verifyKarmaLedger` and `verifyTradeRecords` true, and the key free to use again. A hand-written half trade (a claim with no `trade_claim_units`) is refused by `validateDatabase` and by a fresh open of the same file (`openDatabase` refuses it, so a second process cannot serve it either). |
| **Replay safety** — the same submission twice yields one effect | `tests/economy-invariants.test.js` replays one purchase key, one listing key, one claim key and one settle pass **after a real restart**, asserting identical row counts, one debit, one grant and the same recorded row. `tests/economy-abuse.test.js` adds a key reused for different content on the board, on an offer and on a claim (refused with 409, nothing applied). |
| **Deleted-account behaviour** — what happens to holdings, and that no orphaned claim survives | `tests/economy-invariants.test.js`: an open listing is settled before the inventory goes, the remainder returns and is given up with the account, no listing of a deleted account stays publicly claimable, no claim of the deleted account survives, the world loses exactly the deleted account's units and nothing else, both ledgers keep their append-only records and still verify, the operator cannot authenticate or spend, and no surviving account gains anything. |
| **Restart persistence** — state identical after a real server restart | `tests/economy-invariants.test.js` closes and reopens the database and compares shelves, listings and terms, offers, karma receipts, debits, shop purchases, coin receipts and the audit chain byte for byte, plus the four projections (wallet, classification, shop allowance, board) — and then serves the classification over HTTP from the restarted state. `scripts/economy-walkthrough.mjs` does the same across two real **server processes** on one database file (five reads compared identical). |

## 3. The units stay distinct, and it is proved

`tests/economy-separation.test.js`:

- the four units of account as one readable policy (`UNIT_SEPARATION_POLICY`: four units, **zero**
  conversion paths, no cash-out, no token), only NemoCoins implemented with a ledger, and every unit
  family classified account-bound;
- no route, method or module converts, exchanges, redeems, mints, gifts or transfers one as another:
  the route table is read from `server.js` itself and checked, no route may name two units, and the
  two currency modules never name each other's tables (`src/karma.js` names no coin table,
  `src/coins.js` names no karma table);
- the two new read modules contain no write statement at all;
- a reward in one ledger is never counted as another: with ten NemoCoins and six Karma Coins on one
  account, each ledger's own sum is asserted, an eight-Karma purchase is refused for a short purse
  with the coins untouched, and the provenance report keeps them in separate fields;
- no path buys, sells or transfers land, a role, a scope or an experience point: the shop's
  `never_sells` list, the catalogue, eleven land-shaped and unit-shaped good ids refused with 400,
  `land_stewardships` having no price or buyer column, and no plot created by any purchase.

## 4. How a reward's provenance resolves

`GET /economy/provenance` (`src/economy-provenance.js:149`) reports the signed-in operator's own
rewards, from both ledgers, in their own fields and never summed.

A **Karma receipt** is resolved through the same source registry `src/karma.js` mints from
(`resolveKarmaSource`, `:56`): the source kind and id are parsed and looked up in the shipped
`journey_crops`, `world_objects`, `audit`, `frontier_blocks`, `journey_visits`, `community_thanks`,
`community_members`, `community_pledges`, `community_rsvps`, `guild_contributions` or
`guild_participants` row. The report shows the table, the row id, whether the world still holds it,
the row's own time, and its readable detail (the crop kind and tile, the object type, the audit event,
the verified contribution and its note). A module-load check asserts that every service's own `note`
in `src/karma.js` still names the table this module resolves, so the two lists cannot drift apart.
The **reviewer** half (`karmaReviewer`, `:126`) is `required: false` for a world-tier receipt — the
resident's own saved labour — and for a service-to-others receipt it names the counterparty operator
whose own record proves the act; a verified guild contribution names the operator that verified it,
its character and the verification time.

A **NemoCoin receipt** resolves to its task, its mission, the submission as the contribution, and the
independent review with the reviewer's account name, the decision and the reason.

Both halves of the deliverable are tested: `tests/economy-provenance.test.js` shows a genuine reward
resolving to its saved row and its reviewer (three service kinds plus a NemoCoin acceptance), and an
untraceable reward **flagged** with a named code (`contribution_not_held`) when the saved row the world
legitimately no longer holds. A receipt that names no contribution at all cannot pass the ledger's own
rule check, so the whole report is **refused** with 503 `ledger_invalid` — the same fail-closed
behaviour the wallet and a spend already have. A reward that is not the operator's own is refused with
404, a runtime credential with 403, and no request field can ask about an amount, a day or a source.

## 5. Abuse: what `tests/coin-abuse.test.js` already covered, and what is new

`tests/coin-abuse.test.js` already covers NemoCoin issuance and review independence: an operator,
their sibling character or an administrator accepting their own contribution; one wallet cap and one
duplicate-work rule across characters; replayed reviews, replayed submission keys and keys reused for
other work; suspension and revocation holding receipts; quarantine and independent appeal; the UTC
day and the hundred-coin cap across midnight and equal timestamps; simultaneous acceptances racing a
cap and one shared claim key creating one claim; a forged receipt crediting the wrong wallet; a
runtime credential that cannot review or adopt; and adoption needing a different person. **None of
that is repeated here.**

New ground (`tests/economy-abuse.test.js`), each with the refusal it expects and the database state
asserted afterwards:

- **Collusion on the shop and on account-bound goods.** Two operators cannot move a purchased
  keepsake between them through the board, an offer, or a second character of the same account, and
  neither can buy goods for the other's resident: every refusal leaves the same row counts, the same
  sheets and the same purses.
- **A ring of two operators farming Karma.** Mutual thanking is bounded by the one-a-day-per-recipient
  rule and the two-a-day-per-service rule, with the row count asserted; self-service — one's own
  circle, one's own project, one's own membership and pledge — earns nothing; and peer confirmation
  of a contribution is refused (403) to both the contributor's own operator and the project's creator,
  leaving the milestone untouched.
- **Concurrent purchases.** One key twice over HTTP resolves to one purchase, one debit and one grant;
  two keys racing the last of a per-account daily allowance admit exactly one (200 and 429); two keys
  racing the last of the purse are both refused with the balance unmoved; a key reused for a different
  good is refused outright; and the final rows are asserted in key order.
- **Replayed content under one key.** A listing, an offer and a claim each replayed with *different*
  content under the same key is refused (409) rather than applied, and the recorded row and the shelf
  are asserted.

## Findings, ranked

**Confirmed defect** (reproducible, owned by another module, not fixed here)

1. **A forged Karma receipt whose source id never existed passes every ledger gate.** Drop
   `karma_receipts_validate_insert` in a copy, add a receipt citing `99:99:1` with a recomputed chain,
   and `verifyKarmaLedger` returns true while `validateDatabase` accepts the file: absence of a source
   row is (correctly) treated as legitimate forgetting, so neither check can tell a forgery from an
   honest receipt whose source is gone. Reproduction:
   `node tests/framework/known-gaps-economy.mjs` entry 1. Owner: the Karma/shop owner. The provenance
   surface flags such a reward rather than trusting it, which is the mitigation available without a
   schema change (a source digest recorded in the receipt would close it).

**Likely issue** — none found that this slice did not fix. The one candidate, an account-bound good
that could leave an account, is closed by this slice and proved by `tests/economy-goods-policy.test.js`.

**Design decisions** (stated, not changed)

2. **Goods bought with Karma remain transferable.** A resource bundle is the same sealed crop kind a
   harvest yields, so a Karma-funded resource can reach another operator as goods. The Karma Coin
   itself never moves, and the arithmetic bounds it: a purchase costs at least 8 of the 60 Karma Coins
   an account can earn a day, and the shop bounds each good per account per day, so at most about 60
   Karma of goods a day can take this route. Cosmetics — the 20–40 Karma family — are now
   account-bound, which removes the highest-value leg. Closing the rest needs per-unit provenance in
   the shop grant (a schema change). Owner: the Karma/shop owner and the integrator; reproduction in
   the known-gaps file, entry 2.
3. **A resident's runtime credential can read the operator's purse.** `GET /karma` is open to a
   read-scoped runtime credential, while the shop read and a purchase are session-only. This is the
   owner's own open question, recorded in their port handoff; the walkthrough shows the boundary
   honestly (the AI credential reads the wallet, and is refused the shop with 403). Reproduction:
   entry 3.

**Untested / externally dependent**

4. **The shop's account-bound object path has no shipped instance.** `SHOP_CATEGORIES` allows
   `object`, the classification names it account-bound, and the catalogue stocks none, so the object
   grant, its world id and its refusal have nothing to exercise them. Reproduction: entry 4.
5. The operator's walk-through of the shop on a real device, a load or soak run of the economy, and
   the full Chrome suite are all outside this slice and were not run here.

## The walkthrough: a human and an AI resident, a permitted exchange

`node scripts/economy-walkthrough.mjs` — run and passed. It signs up a human operator and the operator
of a managed AI resident, gives the AI resident its own runtime credential, earns Karma through real
saved service, buys a keepsake, records the named refusal, exchanges grown herbs, reads provenance,
and restarts the server. The interesting lines, verbatim:

```
STEP 5 · The human buys the keepsake with a full day's Karma Coins
  purchase: {"good_id":"flower_crown","price":20,"granted":{"category":"cosmetic","cosmetic":"flower_crown","quantity":1,…},"balance_after":0}

STEP 6 · The human tries to give the keepsake to the AI resident: refused, with its named reason
  tradePost flower_crown: REFUSED (HTTP 409, reason account_bound_good) — flower_crown is account-bound: this operator bought 1 of it from the shop and holds 1, so 0 may leave the account and 1 were requested. A keepsake bought with Karma Coins is worn by the buying account's own resident and is never listed to another operator.
  offerCreate flower_crown: REFUSED (HTTP 409, reason account_bound_good) — … never offered to another operator.
  listings after the refusals: 0
  offers after the refusals: 0
  account-bound reservations: [{"kind":"flower_crown","reserved":1,"held":1,"transferable":0,"reason_code":"account_bound_good",…}]
  the resident wears it: flower_crown

STEP 7 · The permitted exchange: the human lists grown herbs and the AI resident claims them
  AI credential minted for the exchange: {"kind":"runtime","agent":"Orchard aide","scopes":["read","contribute"],"max_calls":200}
  listing: {"status":"open","items":{"herbs":4},"remaining":{"herbs":4},"posted_by":"Mira"}
  claim by the AI resident, on its runtime credential: {"items":{"herbs":4},"listing":"filled","remaining":{}}
  shelf of the AI resident: {"herbs":4}
  shelf of the human: {"flower_crown":1}
  the same claim replayed: {"repeated":true,"same_row":true,"shelf":{"herbs":4}}

STEP 8 · The human reads what its rewards were recognised for
  report: {"status":"ok","rewards":10,"flagged":0,"karma_balance":0,"coin_balance":0}
  karma reward: {"amount":2,"service":"garden_harvest","contribution":"journey_crops#9:3:1792051200000:harvest","held":true,"traceable":true,"reviewer_required":false}
  classification read: {"families":14,"item_kinds":12,"account_bound":[{"kind":"flower_crown",…}],"separate_units":["nemocoin","compute_credit","money","carbon_credit"]}

STEP 9 · A real server restart over the same database
  first process · GET /karma: {"balance":0,"receipts":10,"spent":20,"entries":11}
  the AI credential may read the wallet: {"status":200,"balance":0}
  the AI credential may not read the shop: {"status":403,"error":"The shop belongs to the signed-in operator; an agent runtime cannot read a Karma wallet."}
  identical after the restart · karma_wallet: true
  identical after the restart · trade_board: true
  identical after the restart · provenance: true
  identical after the restart · classification: true
  identical after the restart · shop_catalogue: true
```

## Gates (Node 24.15.0)

| Gate | Result |
|------|--------|
| `npm run check` | **104 files, 0 failed** (was 101 on the base: the three new non-test files) |
| `npm test` | **1171 tests, 1171 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** — 606 s (10.1 min), exit 0, run on the committed tree at load averages 11–78 on 10 cores. The base carried 1146 (its own handoff); the 25 new tests are 5 + 8 + 4 + 4 + 4. The known-gaps file is not discovered: the runner's output names neither it nor `tests/framework/`. |
| `npm run e2e` | **PASS — 20 steps passed, 0 failed** (30 s), including its own restart-persistence step, on this schema-26 base |
| Content seal (`node scripts/seal-content.mjs --check`) | **pass** — 98 definitions (20 appearance, 9 block, 32 cosmetic, 6 crop, 31 furniture), 3 support files, 42 referenced notices and assets |
| `node tests/framework/known-gaps-economy.mjs` | **exit 1, as designed** — 4 entries, 4 reproduced, 0 repaired. Not discovered by `node --test`, so `npm test` stays green. |
| `node scripts/economy-walkthrough.mjs` | **pass** — the exchange, the refusal and five identical reads across a real server restart |

Host load is reported with the test result: this slice ran under load averages of 13–72 on a 10-core
machine because other agents were running suites concurrently. One full-suite run on an earlier
working tree failed exactly two tests: my own concurrency test's row-order assumption (fixed — rows
that share a clock tick now read in key order) and `tests/startup-integrity.test.js`, whose 15-second
budget for a child server to print "NemoWorld is ready" was exceeded under the load. That test passes
standalone in 3.2 seconds, and a direct measurement of the tip's server startup on a fresh database is
3.4 / 1.0 / 1.2 seconds, so the timeout was environmental rather than a regression from this slice.

## What remains unimplemented, externally dependent or unverified

- **No conversion, cash-out, land sale, token or payment was added.** None exists in this build, and
  this slice adds none: the separation suite asserts that no route or module can.
- A resource bundle bought with Karma can still reach another operator as goods (finding 2). Closing
  it needs a schema change in the shop grant, which is outside this slice and the schema freeze.
- The account-bound object path has no shipped good (finding 4).
- The walkthrough is Node, not a browser: **no Chrome scenario was written or run** for the economy.
  The Karma/shop owner's `karma-closed-loop` scenario in `scripts/browser-suite.mjs` is unchanged and
  remains the browser-level proof; the account-bound refusal is not exercised in Chrome.
- The classification rule as enforced is quantity-exact but identity-conservative: an account that has
  ever bought a cosmetic keepsake keeps a standing reservation of that many units of that kind, so a
  crafted keepsake of the same kind is caught by the same rule until the surplus exists. That is the
  safe direction (refuse rather than leak) and it is stated in the module.
- Nobody has walked the shop and the board on a real device by hand in this slice, and no load or soak
  run of the economy was made.
