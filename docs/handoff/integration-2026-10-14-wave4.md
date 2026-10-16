# NemoWorld wave 4 local integration — 2026-10-14

Source: `integration/nemoworld-completed` at `8909ebd`, merging DeepSeek's `review/nemoworld-wave4` at `2d5a38f` with the local control fixes at `233990c`. No push or public deployment was made.

The merge includes the licensed asset-pool record, served resident portraits and audio, nine sealed block types, six crops, new furniture and recipes, richer procedural character poses, and five bounded resident actions (`inspect`, `survey`, `sit`, `offer`, `guild`). The source worktree is clean. The raw 673 MB download/extraction pool remains in `work/w2-assets/asset-pool`; its tracked manifest and index are in this source tree. The runtime serves only the reviewed files under `assets/`.

The integration closed two declared gaps. Schema 24 copies `journey_crops` and `frontier_blocks` in one SQLite transaction to widen their sealed-content `CHECK` lists; the calling view and insert guard are restored in that transaction. Reduced motion now reaches the character geometry and its visual batch key. The previous local phone-control work is reconciled with the new HUD: desktop passage checks address the desktop pad; on a phone, opening Build stops the touch pad and makes room for the build panel and purpose text, and Finish building restores the touch pad.

Validation on the combined committed source (bundled Node 24.19.0):

| Gate | Result |
| --- | --- |
| `npm run check` | 96 files checked, 0 failed |
| `node scripts/seal-content.mjs --check` | 98 definitions; 42 notices and assets |
| `npm test` | 1,037 passed, 0 failed |
| `npm run e2e` | 20 steps passed, 0 failed |
| `npm run browser` | 45 real Chrome scenarios passed, 0 failed |

Before installation, the service `org.nemoworld.local` was stopped and `outputs/Lucy/data/backups/pre-wave4-2d5a38f-20261014.sqlite` was created by the installed backup CLI. The new source independently verified it as schema 23 with two accounts. A copy migrated to schema 24 and passed full database validation. Across all 70 application tables, every old row was preserved; the only additions were two seeded practice quest chains and eight steps. The same comparison passed on the installed database after migration. All 1,057 committed files matched the installed copy byte for byte; `data/`, `.runtime/` and `node_modules/` were left in place.

After restarting `org.nemoworld.local`, `GET /api/v1/health`, `/`, `/assets/residents/faces/01.png` and `/assets/audio/ui-click.ogg` returned 200. The live database passed `scripts/recovery.js verify` at schema 24 with two accounts and two characters. The health response reported a configured local model with no queued work.

Rollback, if needed: stop the local service; restore the verified `pre-wave4-2d5a38f-20261014.sqlite` database while stopped; reinstall the pre-merge source commit `233990c`; restart the service and verify `/api/v1/health` and the restored schema 23. Keep the backup until the owner has tested the upgraded world. The backup is a local owner-readable SQLite file, not an encrypted off-device recovery copy.

Remaining product limits: the larger 3D mesh and HDRI pool is staged for later renderer work; the game still uses procedural residents. This local tile-world release is not MMO-scale capacity, a land sale, or a public launch.
