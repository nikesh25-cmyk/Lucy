# Batch 03 · Task 4 — Compute-budget controls and unit separation

Branch `task-deepseek-batch03-04-compute-budgets`, stacked on the mission-adapter branch
`task-deepseek-batch03-01-mission-adapter` (`f1aae1c`); both touch `src/platform.js` and `server.js`.

Base: `46fb135ab147cc2b09c048809036303aec88b09e` (integration tip). Gates on the combined tree are
reported with the final review branch.

## 1. What changed and why

The world already bounds AI spending (the shared local-model queue, the runtime credential budget, the
durable `resident_runs` decision/API budgets). This task adds the one missing, explicit piece: a
**frozen unit-separation policy** so the four units of account are named and testable, and so no
implicit conversion can be added by accident.

- **`src/coins.js`** — new `CREDIT_UNITS` (a frozen list of four) and `UNIT_SEPARATION_POLICY` (frozen):
  - `nemocoin` — NemoCoin: `implemented: true`, `ledger: 'coin_rewards'`, `balance: true`;
  - `compute_credit` — `implemented: false`, no ledger, no balance;
  - `money` — `implemented: false`, no ledger, no balance;
  - `carbon_credit` — `implemented: false`, no ledger, no balance.
  Every unit carries `transferable: false`, `cash_value: false`, `convertible: false`. The policy
  states `conversion_paths: 0`, `cash_out: false`, `token: false`.
- **`src/platform.js`** — the administrator `operations()` payload now carries `credit_units` (the
  policy), so an operator can read the unit rule without a new route.

No money flow, no new table, no new route, no schema change.

## 2. What was tested

**`tests/unit-separation.test.js` — new, 4 tests**

1. *the four units of account are separate: one ledger, no conversion, no cash-out, no token* — the
   four ids and unit names are distinct; only NemoCoin is implemented, names the `coin_rewards` ledger
   and holds a balance; the other three name no ledger and hold no balance; nothing is transferable,
   has a cash value or is convertible; the policy is frozen.
2. *only the NemoCoin ledger exists in the database; the other three units have no table* — asserts a
   real `coin_rewards` table/view exists and that `compute_credits`, `carbon_credits`, `money`,
   `currency`, `credit_balances`, `credit_transfers`, `conversion_rates`, `cash_out` and
   `tokens_market` do **not** exist. The unimplemented units are concepts, not empty ledgers.
3. *the administrator diagnostics expose the unit-separation policy and a member cannot read it* —
   `GET /operations` (admin) returns four units and `conversion_paths: 0`; a member session is **403**.
4. *the shipped spending bounds are the shipped numbers, not raised to pass a test* — the bounded model
   queue rejects `maxWaiting: 21` with its own configuration error, and the recovery vocabulary stays
   at the shipped schema version or above.

## 3. Actual gate output

```
npm run check → all files syntax-clean
node --test tests/unit-separation.test.js → 4 pass / 0 fail
```

## 4. Open hypothesis (recorded, not implemented)

> "≈10% of donated computing credits to exploration / social / learning."

This is a **proposal in this packet only**, never an approved user policy or a measured quantity. It is
recorded here as an open hypothesis with the four things it must answer before any code:

- **Credit unit** — it names "computing credits", which is `compute_credit` in `CREDIT_UNITS`; that
  unit is **unimplemented**. It is not NemoCoin, not money and not a carbon credit, and it may not be
  converted from any of them.
- **Donor consent** — who donates compute, on what terms, revocably; the world has no compute-credit
  balance, so there is nothing to donate today.
- **Evaluation** — how "exploration / social / learning" success would be measured on the shipped
  records (discoveries, quests, callings, reviewed work).
- **Enforceability** — the shipped architecture bounds model runs per resident with durable budgets; it
  has no per-unit accounting of donated compute, so the figure cannot be enforced or audited as code
  stands.

Until all four are agreed, this stays unimplemented: no transfer, no conversion, no matching rule, no
balance.

## 5. Residual risks and limits

- The policy is declarative. It proves the units are separate **by construction and by test**; it is not
  a runtime guard against a future developer who deliberately adds a conversion. Any such addition must
  change this policy and its test, which is the intended friction.
- The "no table" test enumerates the plausible names; a conversion could in principle be stored under
  an unrelated table name. The design rule, not the enumeration, is the real control.
- This is a local prototype: the numbers are prototype bounds, not production capacity or a price.

## 6. Migration / rollback

None. Additive policy plus one diagnostics field; no schema, storage or route change. Rollback is a
branch revert.
