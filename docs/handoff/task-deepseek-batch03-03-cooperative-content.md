# Batch 03 · Task 3 — Cooperative mission content

Branch `task-deepseek-batch03-03-cooperative-content`, based on the integrated
`integration/nemoworld-completed` tip `46fb135ab147cc2b09c048809036303aec88b09e`.

Baseline at that tip: **840 tests, 0 failures**. After this task: **846 tests, 0 failures**;
`npm run check` green; the sealed-content check is untouched (no new asset).

## 1. What changed and why

Content and fixtures only — no new mechanic. Two authored quest chains and one authored guild plan,
each shipped in the existing `SEED_QUESTS` / guild-plan shape, plus the minimal per-slug, idempotent
seed update needed to install a new built-in chain into a world that already has others.

- **`src/quests.js`**
  - `shared-frontier-path` (`world_building`, practice, no beneficiary): four steps — a saved frontier
    marker, a saved path block, an opened neighbouring area and a saved home light. It advances only
    from server-saved facts and mints no coin.
  - `commons-trail` (`evidence_research`, real, beneficiary "A shared public map of verified
    sources"): a leased real-task claim, then an independent human acceptance. Only a saved review
    receipt from a different authorized operator can complete the second step.
  - `initQuests()` now installs each built-in chain whose **slug** is absent (one `INSERT` per missing
    chain) instead of skipping when any built-in chain already exists, so an older world receives the
    new chains exactly once. No progress, enrolment or receipt is rewritten.
- **`src/guilds.js`** — `SAMPLE_GUILD_PLANS` with one complete `commons-cartography` brief (guild,
  title, purpose, three workstreams with named outputs and an explicit review boundary). It is
  authored content: it grants no calling, role, land right or coin.

## 2. What was tested

**`tests/cooperative-content.test.js` — new, 6 tests**

1. *the shared-frontier-path chain is seeded once and advances only from saved frontier facts,
   spanning more than one day* — the chain appears in the public catalog as practice with no
   beneficiary; each of its four steps completes only from a real saved row (block, path, expansion
   record, home object); the ten-a-day cosmetic limit forces the last steps onto a new UTC day;
   `coin_rewards` stays 0; `verifyQuestReceipts` and `verifyQuestStructure` hold.
2. *the shared-frontier-path chain does not double-advance on replay, restart, or repeated join* —
   four receipts after the full path; repeated reads and an idempotent join write no new receipt; a
   database reopen keeps four receipts and complete progress.
3. *a database that already has the shipped quiet-harvest chain receives shared-frontier-path and
   commons-trail exactly once* — steps and chains are removed (guards permitting) to simulate an
   older world; `initQuests()` restores exactly the three built-in chains, leaves enrolments and
   receipts untouched, and a second run is a no-op.
4. *the commons-trail evidence chain ends only in an independent human acceptance and mints no quest
   coin* — the claim completes step one from a saved fact; self-approval is refused; only an
   independent reviewer's acceptance completes step two and issues exactly one coin receipt (balance
   10).
5. *the commons-cartography guild plan keeps verification independent, pledges uncounted, and coins
   out of the guild flow* — pledges are never completed outcomes; the contributor's operator, a
   sibling character and the creator's operator are all refused as verifiers; an independent operator
   verifies; the guild flow mints nothing and the later independent mission acceptance mints one coin.
6. *the new cooperative content survives backup, restore and validation* — quest receipts, quest
   structure and guild records verify before and after a real backup/restore round trip at schema 22.

Three existing content-count assertions were updated to the new shipped content (they asserted "one
built-in chain"): `tests/quests.test.js` (`SEED_QUESTS.length`, catalog length, and the catalog length
after archiving `quiet-harvest` now names the archived chain and counts the remaining two) and
`tests/quests-http.test.js` (catalog length 1 → 3, and 2 → 4 after publishing a user chain). These
assert the shipped content, which the task deliberately changes; no control was weakened.

## 3. Actual gate output

```
npm run check → all files syntax-clean
npm test      → # tests 846 / # pass 846 / # fail 0 / duration_ms 104877
node --test tests/cooperative-content.test.js → 6 pass / 0 fail
node --test tests/quests.test.js tests/quests-http.test.js → 15 pass / 0 fail (with the new file)
```

## 4. Residual risks and limits

- The chains are content. `shared-frontier-path` proves a saved-fact route; `commons-trail` proves a
  real chain still ends in independent human acceptance. Neither claims a beneficiary outcome outside
  NemoWorld, and the guild plan names no beneficiary.
- `initQuests()` seeds by slug; renaming a built-in slug would re-seed a new chain. Slugs are stable
  authored identities and are not expected to change.
- The seeding change is idempotent and additive; it does not touch progress, enrolments or receipts.

## 5. Migration / rollback

No schema change. The seed runs inside the existing init transaction and is a no-op on a database that
already has the three slugs. Rollback is a branch revert.
