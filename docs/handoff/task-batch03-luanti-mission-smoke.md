# Batch 03 evidence gap 1 — real Luanti server/mod callback on the native mission routes

Branch `task-batch03-luanti-mission-smoke`, based on the frozen review tree
`review/nemoworld-batch03` @ `30e36cf`.

## 1. The engine was found — it is not absent

`LUANTI_BIN` being unset did **not** mean the binary was missing. The verified engine used for the
earlier Mac smoke is present:

- Binary: `/Users/nikesh/Documents/Codex/2026-10-13/nemoworld-luanti/work/engine/unpacked/luanti.app/Contents/MacOS/luanti`
- `luanti --version` → **Luanti 5.17.0 (OSX)**, LuaJIT 2.1, Darwin/25.6.0 arm64, Release.
- Source archive: `/Users/nikesh/Documents/Codex/2026-10-13/nemoworld-luanti/work/engine/luanti-5.17.0-arm64.zip`
- SHA-256 `0ba118b537d3cc6fd07cd2268fef25e515fc6d87c27ad69b476144a8e28dba3c` — **matches the pin in
  `native/README.md` exactly**.
- A prior smoke log (`/private/tmp/nemoworld-luanti-final.log`) and the engine's own
  `~/Library/Application Support/minetest` state confirm earlier real-engine runs.

## 2. What was run (real engine, disposable database)

- `native/luanti-smoke.mjs` (pre-existing, re-confirmed on this tree) →
  **PASS**: real Luanti 5.17 callbacks → NemoWorld rows → web; movement and open-sector crossing
  saved; new sector cleared the stale projection; restart reconciled a removed node (1 placed, 1
  removed).
- `native/luanti-mission-smoke.mjs` (**new**) → **PASS**: real Luanti 5.17 server started with the
  `nemo` mod, a probe mod calling the new mission chat commands (`/nemo_missions`, `/nemo_claim`,
  `/nemo_submit`) through the bridge, four engine restarts.

Run with: `LUANTI_BIN=<binary> node native/luanti-mission-smoke.mjs`.

The new smoke asserts, against a disposable database:

- **Same ids**: the task id and the operator's active-claim id the native client reads equal the ones
  the browser directory (`GET /missions?limit=12`) returns while the claim is leased.
- **One claim row after a retry**: two `/nemo_claim` calls for the same task write exactly one
  `claims` row, owned by the paired human's operator account and bound to the paired human avatar.
- **One submission row after a retry**: two `/nemo_submit` calls write exactly one `submissions` row
  (`pending_review`); the active claim is read from NemoWorld, never typed in chat.
- **Restart persistence, no duplication**: after a Luanti restart the same claim id persists and
  there is still one claim and one submission row.
- **Revoked pairing refused**: revoking the operator session mid-run makes the next native call fail
  (`NEMO_MISSIONS_ERROR`) and the bridge route answer **401** deterministically.

Also `node --test native/bridge.test.mjs native/bridge.integration.test.mjs` → **7/7**.

## 3. What changed

- `native/nemoworld_game/mods/nemo/init.lua` — three bounded native chat commands
  (`/nemo_missions`, `/nemo_claim`, `/nemo_submit`) over the bridge's `/native/missions`,
  `/native/claim`, `/native/submit` routes. The recipient and claim are resolved by NemoWorld; no
  recipient is ever typed in chat, and no token is written to the world, a log or a prompt.
- `native/luanti-mission-smoke.mjs` — the new real-engine smoke.

## 4. Residual limits

- The smoke uses a synthetic probe player invoking the registered callbacks (not a GUI click or a
  physical WASD press), the same idiom as the existing smoke.
- Native **conversation** access is not part of this slice; it is slice 3 of this wave.
- Port `39335` is used for the Luanti server in this smoke (the older smoke uses `39334`), so the two
  can be run in parallel.

## 5. Migration / rollback

No schema or storage change. Rollback is a branch revert.
