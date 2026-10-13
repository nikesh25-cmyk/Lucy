# chore/docs-consistency — documentation-consistency cleanup

Branch `chore/docs-consistency`, base `verify-batch02-wave-e` (`6fe4485`). Docs only.

Files changed: `README.md`, `docs/CONTENT_DEFINITIONS.md`, `docs/DEPLOYMENT.md`
(plus this handoff). No `.js`, no other doc, no `outputs/Lucy`.

## Verified baseline (measured, not assumed)

- **Schema 20** — `src/database.js:124` (`PRAGMA user_version=20`).
- **Content seal** — `node scripts/seal-content.mjs --check` →
  `Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.`
  `content/content-manifest.json` `kinds` and `entries.length` agree.
- **Tests** — `npm test` → **544 tests, 544 pass, 0 fail, 0 skipped, 0 todo** (exit 0, ~113 s).
- **Syntax** — `npm run check` → exit 0 (no source changed).

## Claims corrected

| # | File:line | Was | Now | Evidence |
| --- | --- | --- | --- | --- |
| 1 | `docs/CONTENT_DEFINITIONS.md:16` | `cosmetic \| 29` | `cosmetic \| 32` | seal output; `content/content-manifest.json` `kinds.cosmetic=32` |
| 2 | `docs/CONTENT_DEFINITIONS.md:18` | `**86** entries (7 + 27 + 3 + 20 + 29)` | `**89** entries (7 + 27 + 3 + 20 + 32)` | seal "89 definitions"; manifest `entries.length=89` |
| 3 | `docs/CONTENT_DEFINITIONS.md:80` | manifest example `"cosmetic": 29` | `"cosmetic": 32` | `content/content-manifest.json` |
| 4 | `docs/DEPLOYMENT.md:5` | "the **paid Starter instance**" | "a **paid instance (`1c-2g`)**" + "the plan and disk size are your decision" | `render.yaml:31 plan: 1c-2g`; task-28 `docs/PRODUCTION_READINESS.md` §4.1/§4.7 |
| 5 | `docs/DEPLOYMENT.md` config table | only `LUCY_MODEL_NAME` listed | added `LUCY_MODEL_URL` (loopback HTTP; non-loopback refused), `LUCY_MODEL_BACKEND`, `LUCY_MODEL_KEY` | `runtime/model.js:39-45`, `:86-88` |
| 6 | `docs/DEPLOYMENT.md` new §"Release control and shutdown" | absent | documents `autoDeployTrigger: 'off'`, `maxShutdownDelaySeconds: 60`, fail-closed `preDeployCommand` | `render.yaml:35,39,47`; `server.js:679-687` |
| 7 | `README.md:19` | "2,998 source-scoped research proposals" | "1,015 source-scoped research proposals" | measured `research_leads = 1,015` (baseline 748 + destination 87 + institutions 87 + interventions 87 + agriculture 6); task-24 `docs/handoff/task-24-proposal-generator.md` §Corpus |
| 8 | `README.md:29` | "The server binds to loopback." | "binds to loopback by default; a public deployment sets `LUCY_BIND_HOST` and a configured public origin." | `src/hosting.js:15-17` |
| 9 | `README.md:44` | "atomic recipes for crowns, banners, and lanterns" | "consented resident-to-resident offers of grown and crafted items, and atomic recipes for crowns, wreaths, banners, lanterns, and whistles" | 6 craft cosmetics (`content/cosmetics/craft-*.json`): flower_crown, herbal_wreath, woven_banner, festival_banner, garden_lantern, reed_whistle; `src/journey.js:35-50` (`RESOURCE_OFFER_POLICY`) |
| 10 | `README.md:94` | "The configured Starter instance …" | "The configured instance (`1c-2g`) …" | `render.yaml:31` |

## Left alone — checked and already correct (nothing changed)

- `docs/DEPLOYMENT.md:39` restore text already says "Recovery refuses an active server lock"; the lock is real
  (`src/recovery.js:275-280`, `restoreDatabase` → `acquireProcessLock`). Task-28 §4.7 flagged this line, but the
  current text is already accurate.
- `docs/CONTENT_DEFINITIONS.md` envelope, per-kind rule columns, provenance (LicenseRef-NemoWorld-Project-Authored
  vs CC0-1.0 with its pinned commit), support-file list, resolver/tooling and read route — intact; only the three
  counts were stale. The `find(id)` "only `wood` is both a frontier block and a crop" note is still true
  (manifest: `wood` = block + crop is the only shared id).
- README numbers re-verified, all still correct: 248 countries (`catalog/countries.json` entries=248); 20 districts
  (`src/civic.js` `REGIONS=20`); 768 × 768 m / 256 areas / 16,384 plots / 6 × 6 (`src/frontier.js:12` `LAND_WORLD`);
  Commons 96 × 64 (`world.js:225-226`); garden 32 × 24 (`world.js:557`); cottage 20 × 14 (`world.js` `makeInterior`
  uses `COLS/ROWS` = 20/14; `src/spaces.js:298`); five destinations (`world.js:149-153`); 200 avatars
  (`src/spaces.js:17`); 37 × 37 voxel viewport (`src/spaces.js:371`); 20 × 14 pixel viewport (`app.js:150`);
  expressions wave/bow/cheer/think/heart (`src/platform.js:235`); 7 block materials × 8 layers (all block `z_max=7`);
  "14 scoped task briefs" (`docs/deepseek/TASKS.md` holds tasks 01–14).
- README contains **no** schema-version, test-count or content-definition-count claim, so there is nothing of that
  kind to reconcile there.

## Out of scope — owned by other agents (reported, not fixed)

- `app.js:1696` still renders a "Generate 68 proposals" button, but the repaired generator
  (`docs/handoff/task-24-proposal-generator.md`) emits concern-based rows (23 per country; 20 for Senegal), not 68.
- `docs/COUNTRY_PROGRAMMES.md:15` still says "seventy-four proposals" for Nepal (now 29). Both files are outside this
  task's ownership; the `app.js` and other-docs agents own them.

## Not verified / not changed

- None. Every number written was measured from the repo or read from the catalog/code.
