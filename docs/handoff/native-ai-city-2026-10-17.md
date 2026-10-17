# Native AI city — integration candidate

Extends Node `1e247c1` and native `622dfde` on `feat/native-ai-city-2026-10-17` in the existing integration worktrees. No main database migration; main schema remains27. City history uses additive link extension `city_life` version1.

## Implemented

- Eight fictional adult city citizens projected as peaceful native NPCs; no additional bot clients or AI credentials. Population capped16; founding households admit at most four children.
- AI-only two-person construction crews physically present at each site. Four family homes, civic office, school, university and farm with three native-confirmed stages each.
- Original authored city geometry uses existing Veloren assets:55 city groups,359 combined;59,505 total native-budget cells out of60,000. Palette approximates modern civic architecture with existing blocks and window sprites; no external assets introduced.
- Ground walking with bounded local path search and checked one-block jumping. Paths conform to natural terrain; saved grades and compatible base heights are retained across restart.
- Durable jobs, source-linked scripted city reports, separate virtual harvests, school attendance and simple deterministic assessments. These are simulation outputs, not independently reviewed research or real-world outcomes.
- Four preapproved fictional households; marriage requires both adults' recorded visits; children require completed native homes. Children stay home, become students after10 open-world minutes, then need assessed school/university visits and work records. No offline ageing, coins, accounts, credentials or inherited authority.
- `/city` guest directory/home requests and native travel with signed arrival confirmation. Families target their own completed home interior; office, farm and classroom work also requires completed interiors. `/tell Selene city` exposes the public city guide.

## Verification so far

- Final application suite:1,837 passing,0 failing,0 skipped (160.6seconds).
- End-to-end:20 steps passed.
- Focused real Chrome:9/9 city scenarios, including saved city changes appearing without a page reload. Cottage ACKs there are signed fixtures, not native building evidence.
- Seal:136 definitions,42 referenced notices/assets.
- Native protocol:33 passing; world-core release tests24 passing; four targeted native movement helper regressions passed; server release check passed. Final CLI release build passed in8m11seconds.
- Real native probe1 refused oversized clearing, correctly and before applying city geometry. Probe2 spawned8 actual residents and saved23 public groups and one marriage, but exposed canopy spawning and flat-road ledges. Those are regression findings, not acceptance passes.
- Real native runs have observed completed homes/office/school/university, two fictional births,12 assessed classroom visits and both children becoming adult office workers. Native human city visit and return passed with observed arrival ACKs. A blocked builder was reproduced against a measured wooden corner, then fixed using actual capsule clearance and checked timber support. The final all-buildings/farm/restart gate remains pending. GUI playthrough unavailable while Mac is locked.

The launcher now uses the native save signal, recognizes both actual relative and absolute launch forms, canonicalizes the Node path, and refuses unrelated/reused PIDs. Four disposable launcher tests cover saving, relays, the wrapper and another stack's identical command. The installed source was byte-identical across1,651 tracked files before shutdown. An encrypted offline rollback archive passed authenticated decryption and byte equality; key material is kept separately.

## Activation

`node scripts/prepare-native-city.mjs --output-dir NEW_DIRECTORY` creates checked composition artifacts exclusively. Set native world path to its `manifest.json`; merge its landmarks with existing configuration; run Node with `NEMO_CITY_ENABLED=1` and the native `NEMO_WORLD_RECORD`. The canonical local launcher setup prepares this composition. Existing accounts, characters, plot claims and buildings must be backed up before activation. Keep source and native binary rollback copies.

## Known boundaries

This is a local scripted city simulation, not an MMO, an autonomous model civilization, real marriage/parenthood, commercial land ownership or evidence of institutional adoption. Existing private guest cottages remain preset styles. The existing command outbox has a crash window between file append and its core SQLite row; city intents recover recorded commands and never count uncertain work as complete, but do not make those stores atomic. Native record files are operator controlled; shape validation is not a cryptographic signature of the whole world.
