# NemoWorld integration — 14 October 2026

This integration starts from `integration/nemoworld-completed` at `5b2b147`, then merges DeepSeek's `review/nemoworld-combined2` at `78145fe` and `integration/deepseek-master-2026-10-14` at `d540f2e`. The first line delivers security/privacy, crop depth, five authored places, route coverage, render instance culling, movement feel, multiplayer soak evidence and the resource trade board. The second delivers latency instrumentation, stale-poll movement protection, doorway reachability, the next-passage HUD and a two-human/one-AI two-gate browser scenario. Both merge parents remain in Git history; no task branch was recreated.

## Integration corrections

- Schema 23 makes the trade board a required part of the database. Migration accepts schema-22 worlds both with and without an existing board, preserves a populated ledger, and rejects partial or altered board structures. Backup and restore validate the board. Account export includes bounded trade history; deletion settles open listings and redacts the account's authored trade fields. Board reads no longer scan all claim units for each listing, and the startup ledger check is linear in stored records.
- The workshop exposes posting, claiming and withdrawing saved resources. It shows the server's crop stage, care and expected harvest, and reports the actual gathered quantity. These exchanges move inventory only; they do not issue NemoCoins, money or land.
- The next-passage cue uses registered destinations and the same saved obstacle layers as movement. One bounded search serves the cue per own-world read. Making a garden private now publishes each relocated visitor's departure to the source world and arrival in the Commons; the former soak `todo` is an active regression test.
- `npm run check` now parses the trade modules. Current-version tests and runbooks name schema 23 while historical schema-22 migration fixtures remain at 22.

## Independent gates on the combined source

| Gate | Result |
| --- | --- |
| `npm run check` | Pass |
| `npm test` | 966 pass, 0 fail, 0 skipped, 0 TODO; required localhost permission because the sandbox refused test-server binds with `EPERM` |
| `npm run e2e` | 20 steps pass, 0 fail |
| `npm run browser` | 43 real Chrome scenarios pass, 0 fail; disposable database, shipped database untouched |
| `node scripts/seal-content.mjs --check` | 89 definitions and 42 notices/assets verified |
| `node scripts/ops-rehearsal.mjs` | 7/7 failure drills pass |
| Real Luanti 5.17 server smokes | Build/travel/restart, mission retry/revocation, and private/public text conversation pass |

The first full unit-suite attempt ran inside a sandbox that refused `127.0.0.1` listeners; its server-test failures are an environment result, not a product regression. The permission-enabled rerun above is the valid gate. All acceptance databases and engine worlds were temporary. No installed account, coin receipt, land plot, model weight or production backup was used as test data.

## Limits

This is a finite, tile-based shared world with an optional native Luanti projection. The Luanti bridge shares authoritative NemoWorld rows; it is not a standalone MMO backend. The five places are authored environments, with some services still represented mainly by scenery. The render change reduces some distant instances; it is not a proven frame-rate improvement. The trade ledger remains a single-process SQLite workload, and a long-lived installation still needs measured retention and capacity planning. No real-world pilot, institutional adoption, commercial land sale or live hosted release is implied by these gates.
