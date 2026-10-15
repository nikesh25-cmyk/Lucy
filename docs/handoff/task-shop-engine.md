# Task: the shop engine (`src/shop.js`)

Status: **complete and green against its own tests**. Three files added, nothing else touched:

| File | What it is |
| --- | --- |
| `src/shop.js` | the frozen `SHOP_CATALOGUE`, its boot validation, the read projection and the atomic purchase |
| `tests/shop.test.js` | 10 tests, `node:assert/strict`, injectable Karma stub |
| `docs/handoff/task-shop-engine.md` | this handoff |

NemoWorld, Node 24 ESM, `node:http` + `node:sqlite`. Every command in this document ran with
`export PATH="$PWD/../node-bin:$PATH"` from the repository root.

---

## 1. The catalogue

`SHOP_CATALOGUE` is a deeply frozen array of 13 goods in three categories. Each entry is
`{ id, label, summary, category, price, per_account_limit_per_day, grant, note }`. Prices are whole
Karma Coins (8–40). `per_account_limit_per_day` is per **operator account**, not per resident, so a
second character cannot double a limit.

`grant` always names a **sealed id**, and `validateShopCatalogue()` resolves every one of them against
the sealed content bundle and the sealed build palettes at import time.

| good id | label | category | price | per day | sealed id behind the grant | where that id is defined |
| --- | --- | --- | --- | --- | --- | --- |
| `herbs` | Herb bundle | resource | 8 | 6 | crop `herbs` ×2 | `content/crops/herbs.json` via `content.crops()` |
| `fiber` | Fiber bundle | resource | 9 | 6 | crop `fiber` ×2 | `content/crops/fiber.json` |
| `wood` | Wood bundle | resource | 10 | 6 | crop `wood` ×2 | `content/crops/wood.json` |
| `herb_crate` | Herb crate | resource | 18 | 3 | crop `herbs` ×5 | as above, larger quantity |
| `cushion` | Cushion | object | 9 | 2 | furniture `cushion` | `content/furniture/cushion.json`, in the `house` palette |
| `lantern` | Garden lantern | object | 12 | 2 | furniture `lantern` | `content/furniture/lantern.json`, in the `garden` palette |
| `bench` | Garden bench | object | 15 | 2 | furniture `bench` | `content/furniture/bench.json`, `garden` |
| `bookshelf` | Bookshelf | object | 22 | 2 | furniture `bookshelf` | `content/furniture/bookshelf.json`, `house` |
| `fountain` | Fountain | object | 35 | 1 | furniture `fountain` | `content/furniture/fountain.json`, `garden` only |
| `flower_crown` | Flower crown keepsake | cosmetic | 20 | 1 | cosmetic `flower_crown` (craft) | `content/cosmetics/craft-flower_crown.json` |
| `herbal_wreath` | Herbal wreath keepsake | cosmetic | 24 | 1 | cosmetic `herbal_wreath` (craft) | `content/cosmetics/craft-herbal_wreath.json` |
| `woven_banner` | Woven banner keepsake | cosmetic | 28 | 1 | cosmetic `woven_banner` (craft) | `content/cosmetics/craft-woven_banner.json` |
| `festival_banner` | Festival banner keepsake | cosmetic | 40 | 1 | cosmetic `festival_banner` (craft) | `content/cosmetics/craft-festival_banner.json` |

How the three categories land:

- **resource** → `grantInventoryGood()` adds the crop kind to `journey_inventory`. The kinds are exactly
  `Object.keys(content.crops())` (`herbs`, `fiber`, `wood`), the same kinds `src/journey.js:363` credits
  on a harvest.
- **cosmetic** → the granted craft keepsake also goes to `journey_inventory`, one unit. That is
  deliberate: `src/journey.js:238` already offers every *held* craft output as a keepsake appearance
  (`profile_options.avatars`), and `updateProfile` (`src/journey.js:326`) accepts any avatar in that
  list. So the purchase makes the keepsake genuinely wearable through the shipped profile route, with no
  second writer to `journey_profiles`. `tests/shop.test.js` proves it by reading
  `platform.journey(...).profile_options.avatars` after the purchase.
- **object** → **no table write at all**. The purchase returns a voucher-like entitlement:
  `{ category: 'object', type, world, world_id, palette, placement }`, where `world_id` is
  `home:<agent_id>` (garden, kind `home`) or `house:<agent_id>` (cottage, kind `house`). Those worlds
  already exist for every resident. `world_objects` is never touched — it has its own guards in
  `src/placement-policy.js` and the placement must go through `build()`.

### Boot validation

`validateShopCatalogue(catalogue)` is exported, called once on the frozen `SHOP_CATALOGUE` at module
load, and refuses, with a descriptive `Error`:

- a non-array/empty catalogue, a missing category, a good id that is not a lower-case identifier, a
  duplicate id, an empty `label`/`summary`/`note`;
- a price that is not a whole number in 8–40, or a daily allowance outside 1–10;
- a resource `grant` that is not exactly `{kind, quantity}`, a kind not in the sealed crops, or a
  quantity outside 1–99;
- an object `grant` that is not exactly `{type, world}`, a `world` other than `garden`/`house`, a `type`
  absent from **that world's** sealed palette (`GARDEN_PALETTE` / `HOUSE_PALETTE` from
  `src/placement-policy.js`; their union is the runtime's `BUILD_PALETTE`), or a `type` that is not a
  sealed `furniture` definition (this is what refuses selling a block like `path` as an object);
- a cosmetic `grant` that is not exactly `{cosmetic}`, an id that is not a sealed `craft` keepsake
  (this is what refuses selling the *gated* `explorer_banner` avatar), or an id whose sealed
  `rules.output` is not itself;
- a catalogue that stocks fewer than all three categories.

---

## 2. The public API

```js
import {
  SHOP_CATALOGUE,        // frozen array of 13 goods, deeply frozen
  SHOP_CATEGORIES,       // ['resource', 'object', 'cosmetic']
  SHOP_LIMITS,           // { price_min:8, price_max:40, per_day_min:1, per_day_max:10,
                         //   quantity_max:99, shelf_quantity_max:999, key_max:100 }
  SHOP_POLICY,           // frozen; the "in-world goods only" sentence and the no-value flags
  SHOP_SCHEMA,           // SQL text for shop_purchases + indexes + the append-only trigger
  validateShopCatalogue, // (catalogue) -> catalogue, or throws
  shopCatalogue,         // (platform, actor, input={agent_id}) -> projection
  shopPurchase,          // (platform, actor, input={good_id, agent_id}, key) -> purchase result
  shopMethods,           // { initShop, shopCatalogue(actor,input), shopPurchase(actor,input,key) }
} from './src/shop.js';
```

Standalone functions take `platform` first; `shopMethods` forwards to them with `this`, so both call
styles are one implementation each.

- `shopCatalogue(platform, actor, { agent_id })` — **session only** (403 for any runtime credential),
  resolves the agent through `platform.ownedAgent` (another operator's resident is a 404), then returns
  `{ agent_id, currency: 'Karma Coins', balance, policy, categories, goods[], server_time }`. Each good
  carries `id, label, summary, category, price, grant, note, daily_limit, bought_today, remaining_today,
  available_today, can_afford`. `balance` comes from `platform.karmaWallet(actor, { agent_id })` and is
  `null` when the wallet does not report a safe integer, in which case `can_afford` is also `null`
  rather than a guessed `false`.
- `shopPurchase(platform, actor, { good_id, agent_id }, key)` — **session only**, `platform.active()`
  must be true, the resident must be `active`, and the key is the existing `Idempotency-Key` convention
  (1–100 characters, required). Only `good_id` and `agent_id` are ever read from the request: the price,
  the quantity and the balance all come from the catalogue and the wallet. Returns
  `{ purchase_id, good_id, label, category, price, granted, world_id, agent_id, karma_receipt_id,
  balance_after, day, created_at, repeated }`.

Error statuses: `400` bad good / bad key / no resident, `403` runtime credential / paused resident /
paused account, `404` another operator's resident, `409` conflict (key reused for another good),
insufficient balance or a full shelf, `429` the per-day allowance, `503` the platform is paused or the
currency module is not wired in.

### The one grant writer

`grantInventoryGood(platform, agentId, kind, quantity)` is the **only** place the shop writes
`journey_inventory`. `src/journey.js` is that table's other writer and may not be edited, so the upsert
mirrors the shape already in the file (`src/journey.js:146`):

```sql
INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?)
ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity WHERE quantity+excluded.quantity<=?
```

It uses the same guarded-write-then-check-`changes` idiom as `debitInventory` (`src/journey.js:152-153`).
The guard is the shop's own `SHOP_LIMITS.shelf_quantity_max = 999`, because the sealed journey schema
bounds the shelf only at `quantity>=0`; the largest grant is 5, so ordinary play is never near it. A
refusal is `409` and, being inside the purchase transaction, rolls the Karma debit back with it.

---

## 3. How atomicity and idempotency are proven

The purchase never opens a nested transaction: `platform.karmaSpend` is called **inside** the caller's
transaction, exactly as the currency module requires. `shopPurchase` opens one itself only when
`platform.db.isTransaction === false` (node:sqlite reports it), so a caller that forgets the route's
wrapper still cannot commit a debit without the goods.

Order inside the transaction: replay lookup → resident/limit checks → `karmaSpend` → grant → purchase
row → audit. Any throw after the debit rolls the whole thing back.

Proven by `tests/shop.test.js` (test 8, "a grant that fails rolls the Karma debit back with it"), three
independent ways:

1. **Shelf guard refuses after the debit** — the shelf is pre-set to `shelf_quantity_max`, the purchase
   raises 409, and the assertions show `balance` still 100, **zero** ledger rows, the shelf unchanged and
   no purchase row.
2. **The shelf write itself aborts** — a `BEFORE INSERT` trigger (the same shape `tests/journey.test.js:105`
   uses) makes the grant throw; the debit is still rolled back.
3. **No route wrapper at all** — `platform.shopPurchase(...)` called directly opens its own transaction
   and the debit is still rolled back.

Idempotency (test 5) is two layers: the shop answers a replayed `(account_id, key)` from its own recorded
row **before** any limit or debit is attempted and returns the identical `purchase_id`/`balance_after`/
`granted` with `repeated: true`; and `platform.karmaSpend` is itself idempotent on `(account_id, key)`,
so a replay that did reach it would still write nothing. The same key naming a different good is a `409`.

The Karma stub in the test file is deliberately **not** an in-memory map: it writes its balance and its
ledger into the real SQLite file, inside the caller's transaction, which is what makes the rollback
assertions meaningful. It implements exactly `karmaWallet(actor,{agent_id})` and
`karmaSpend(actor,{amount,good_id,key})`, idempotent on `(account_id,key)`, refusing an overdraft, per
operator account.

Other coverage: the contract with the sealed content (tests 1–2), the projection and the runtime refusal
(test 3), debit-once/grant-once + ignoring price/quantity/balance from the request body (test 4),
insufficient balance debits and grants nothing (test 6), the per-account daily allowance counted per UTC
day, shared across residents, and returning on the next day (test 7), and no leakage — `coin_rewards`,
`worlds`, `world_objects`, all land/frontier tables, `resource_offers`, `journey_profiles` and `tokens`
have identical row counts, and the agent/account rows are byte-identical, before and after buying a
resource, an object and a cosmetic (test 9). Test 10 proves the shop fails closed (503) with no currency
module wired in and inside a paused world.

---

## 4. Commands run, with real output

```
$ node --check src/shop.js
node --check src/shop.js: OK

$ node --check tests/shop.test.js
node --check tests/shop.test.js: OK

$ node --test tests/shop.test.js
# (node:35308) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# Subtest: the frozen catalogue stocks eight or more goods in three categories, and every grant names a sealed id
ok 1 - the frozen catalogue stocks eight or more goods in three categories, and every grant names a sealed id
# Subtest: a catalogue that drifts from the sealed content is refused
ok 2 - a catalogue that drifts from the sealed content is refused
# Subtest: the projection shows the buyer their own allowance and policy, hides another operator, and refuses a runtime
ok 3 - the projection shows the buyer their own allowance and policy, hides another operator, and refuses a runtime
# Subtest: a purchase debits the wallet once, grants the good once and takes no value from the request
ok 4 - a purchase debits the wallet once, grants the good once and takes no value from the request
# Subtest: a replayed purchase key grants nothing twice and returns the recorded result
ok 5 - a replayed purchase key grants nothing twice and returns the recorded result
# Subtest: an insufficient balance debits nothing and grants nothing
ok 6 - an insufficient balance debits nothing and grants nothing
# Subtest: the per-account daily allowance is counted per UTC day and refused past its bound
ok 7 - the per-account daily allowance is counted per UTC day and refused past its bound
# Subtest: a grant that fails rolls the Karma debit back with it
ok 8 - a grant that fails rolls the Karma debit back with it
# Subtest: a purchase moves no NemoCoin, no land, no role and no world object
ok 9 - a purchase moves no NemoCoin, no land, no role and no world object
# Subtest: the shop fails closed without the currency module and inside a paused world
ok 10 - the shop fails closed without the currency module and inside a paused world
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4822.9115
```

No other test command was run (`npm test`, `npm run browser`, `npm run e2e` were deliberately not run —
five agents share this tree).

---

## 5. The seam the integrator must add

### 5.1 Schema and mixin

- `src/database.js`: import `SHOP_SCHEMA` and `db.exec(SHOP_SCHEMA)` inside the same open transaction
  that already execs the other module schemas (next to `JOURNEY_SCHEMA`, `COIN_SCHEMA`, …).
  The shop **also self-heals**: every entry point checks `sqlite_master` once and execs the schema if the
  table is missing, so a forgotten wiring order still works. `shopMethods.initShop()` is exported for the
  explicit constructor call (like `initJourney`), and is not required.
- `src/platform.js`: `Object.assign(Platform.prototype, shopMethods)` alongside the other mixins, and
  `Object.assign(Platform.prototype, karmaMethods)` plus `KARMA_SCHEMA` in `database.js` for the currency
  side (that module heals its own schema too).
- `src/recovery.js`: no change is required. `validateDatabase` checks that expected tables *exist* and
  never forbids extra ones. A stricter `version>=23` shop check would be a follow-up, and it lives in a
  file I must not touch.

### 5.2 Route table (`server.js`)

1. `writes` map — `['/shop', ['shopPurchase', null]]`. The `null` scope is the right one: the existing
   guard at `server.js:510` refuses a runtime actor on a POST with `null` scope ("A human operator
   session is required"), which is exactly the rule the shop enforces too. Note `shopPurchase` expects
   the trailing `key` argument, so:
2. the idempotency list at `server.js:680`
   (`['/claims','/submissions','/drafts/resume','/tasks/follow-up','/quests/join','/interact','/journey/offers','/journey/offers/accept']`)
   must gain `'/shop'`, otherwise the `Idempotency-Key` header never reaches the method and every
   purchase is a 400. This is the same pattern `/journey/offers` already uses.
3. `gets` set plus a read branch, next to the `/journey` branch (`server.js:542`):
   `else if (route === '/shop') value = platform.shopCatalogue(actor, Object.fromEntries(url.searchParams));`
4. The write route's existing `platform.transaction(...)` wrapper is what makes the debit and the grant
   atomic — do not move `/shop` out of it.

### 5.3 `platform.karmaSpend` / `platform.karmaWallet` availability

The shop reads only `{ ok, balance_after, purchase_id, reason }` from the debit, only `{ balance }` from
the wallet, and calls each with exactly the documented keys (`{ amount, good_id, key }`, `{ agent_id }`).
If either method is missing the shop fails closed with `503` rather than inventing a balance. The status
of a refusal is chosen from the returned `reason` text: paused/suspended → 403, "limit" → 429, anything
else (an overdraft, a refusal) → 409.

### 5.4 Placing an object entitlement

The purchase result (and the `shop_purchases` row) carries everything a placement needs. To list the
buyer's own object entitlements:

```sql
SELECT id, good_id, granted, world_id, created_at FROM shop_purchases
WHERE agent_id=? AND category='object' ORDER BY created_at, id;
```

The integrator then calls the shipped build path for the world the entitlement names, which is the only
path allowed to write `world_objects`: the resident must be standing in that world, and
`build(actor, agentId, { x, y, type })` validates tile, palette, clearance and route. **Caveat:** the
shipped `build()` does not require or consume a voucher — it places any palette item — so today the
entitlement is a recorded receipt that the integrator can surface (a `build` UI listing bought objects,
or an explicit consume step). Making the voucher *mandatory* would mean editing `src/spaces.js`, which is
outside this task; flagged below.

---

## 6. Not done / assumed

- **The tests ran against a stub, not the real currency module.** `src/karma.js` did not exist when this
  task started, and the brief said not to wait for it, so `tests/shop.test.js` injects a stub implementing
  exactly `karmaWallet` and `karmaSpend`. **The real integration has not been executed** — the integrator
  runs it. `src/karma.js` (350 lines) appeared in the tree during the work; I read it (I did not edit it)
  and checked my assumptions against it:
  - `karmaWallet(actor, { agent_id })` rejects any other key in its input and returns `balance` as a
    non-negative safe integer — my call and my read match it;
  - `karmaSpend(actor, { amount, good_id, key })` rejects any other key, opens no transaction of its own
    (it documents the same "call me inside your transaction" rule), is idempotent on
    `(account_id, idempotency_key)`, and returns `{ ok, balance_after, purchase_id, reason }` plus a
    `reason_code` I do not read;
  - its refusal texts map to the statuses my shop chooses: `account_paused`
    ("This operator account is paused …") → 403, `insufficient_balance` → 409;
  - `KARMA_POLICY.daily_operator_limit` is 60, and `karmaSpend` accepts a single amount up to that
    limit, so every catalogue price (8–40) is a legal debit. An operator earns 2 Karma per world service
    (2/day) and 6 per service to another operator (2/day), capped at 60/day, so the dearest goods are
    reachable in a few days of real service.
  - The wallet is per **operator account** (derived, not stored), which is the model my stub implements.
  If the integrator prefers the code-based mapping, `debitStatus()` is the one place to change.
- **The object entitlement has no consumer yet** (see 5.4). The purchase is recorded and returned, and
  the Karma is genuinely spent; nothing in the shipped world yet requires the voucher. Decide the
  consuming UI or route.
- **Account lifecycle follow-ups** (all in files I must not edit): `/export`
  (`platform.exportAccount`) does not include shop purchases, and `deleteAccount` does not purge
  `shop_purchases`. Deletion is a soft delete (accounts/agents rows are rewritten, never removed), so the
  foreign keys are safe; a privacy purge would be
  `DELETE FROM shop_purchases WHERE account_id=?`. I deliberately added **no** delete trigger for exactly
  that reason; there is a `shop_purchases_no_update` trigger, because nothing legitimately edits a
  purchase.
- **No gift or transfer of Karma** between accounts in version one, as the brief requires. `SHOP_POLICY`
  states it (`gift_or_transfer: false`) and no route can move a balance to another account.
- **`SHOP_LIMITS.shelf_quantity_max = 999` is the shop's own bound.** `journey_inventory` has no upper
  bound of its own (only `CHECK(quantity>=0)`), so the shop states one rather than writing unbounded
  shelves. If the integrator prefers the existing per-offer bound of 99 (`RESOURCE_OFFER_LIMITS.quantity_max`),
  it is one constant.
- **Not invented:** nothing in the catalogue, the projection or the transaction moves NemoCoins, money,
  land, a role, a scope or a grant, and no price, quantity or balance is ever read from a request body
  (test 4 exercises that with `{ price: 1, quantity: 99, balance: 99999, amount: 0 }` in the body).
- I did **not** touch `src/karma.js`, `src/coins.js`, `src/journey.js`, `src/spaces.js`,
  `src/frontier.js`, `src/platform.js`, `src/database.js`, `src/recovery.js`, `server.js`, `app.js`,
  `index.html`, `package.json`, `content/` or any existing test. `git status` shows my two source files
  as untracked additions only. Note that other agents added `src/ui/shop-panel.js`,
  `tests/shop-panel.test.js` and `src/karma.js` during this window; I have not read or run the UI panel
  and it is not wired to anything I wrote.
