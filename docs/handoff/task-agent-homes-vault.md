# Agent homes and the encrypted resident vault (schema 25)

Branch `feat/agent-homes-vault`, cut from `b5d227f`. Design, key models, routes and limits: [`docs/VAULT.md`](../VAULT.md).

## What changed

- **Schema 25.** `resident_vault_keys` and `resident_vault` (`src/vault.js`), with insert and identity
  triggers, a structural recovery check (`verifyVaultRecords`) and the version bump through
  `src/database.js` and `src/recovery.js`. Thirty test and script files, including `scripts/ops-rehearsal.mjs`, had their
  pinned `24` moved to `25`; nothing else in them changed.
- **Vault.** Per-resident AES-256-GCM notes, a server-sealed key model (data key wrapped under a master
  key in `vault.key` / `LUCY_VAULT_KEY_FILE`) and a resident-held key model (the server stores only
  ciphertext). New `vault` runtime scope, routes `/vault`, `/vault/notes`, `/vault/enroll`,
  `/vault/write`, `/vault/manage`. The operator session sees counts and can erase; it cannot read.
- **Private cottage.** A new AI resident's cottage starts private; `homeSettings` takes an independent
  `house_visibility`. Closing the garden still closes the cottage; opening it does not open the cottage.
  Existing cottages are untouched. Four visitor tests in `tests/world-platform.test.js` now open the cottage
  first, because they exercise doorway and eviction rules, not the default.
- **Managed resident.** `runtime/agent.js` gains a `note` action and reads its own sealed notes inside the
  `/callings` read it already makes, so the pinned per-decision call count is unchanged. The runner's
  closed scope list now includes `vault`.

## Verified

`npm run check` 98 files, 0 failed. `node --test` 1069/1069 on this tree (1047 on `b5d227f`; the 22 new
tests are the vault, HTTP, runtime and home files). Not re-run: browser suite, HTTP acceptance script,
the standalone recovery-drill CLI (its test file passes inside the suite), Luanti smokes, and a live
server run: the vault routes are exercised through `createApp` in the tests, not a long-running process.

## Known gaps

- No 3D cottage interior (separate visual work); no UI for the vault or the cottage switch yet.
- Living-world scripted residents have no vault.
- No master-key rotation. No external-agent client library; the recipe is in `docs/VAULT.md`.
- The installed copy under `outputs/Lucy` is untouched: install only after the gates above and a backup.
