# Native AI city — integration candidate

Extends Node `1e247c1` and native `622dfde` on `feat/native-ai-city-2026-10-17` in the existing integration worktrees. No main database migration; main schema remains27. City history uses additive link extension `city_life` version1.

## Implemented

- Eight fictional adult city citizens projected as peaceful native NPCs; no additional bot clients or AI credentials. Population capped16; founding households admit at most four children.
- AI-only two-person construction crews physically present at each site. Four family homes, civic office, school, university and farm with three native-confirmed stages each.
- Original authored city geometry uses existing Veloren assets:55 city groups,359 combined;59,505 total native-budget cells out of60,000. Palette approximates modern civic architecture with existing blocks and window sprites; no external assets introduced.
- Ground walking with bounded local path search and checked one-block jumping. Paths conform to natural terrain; saved grades and compatible base heights are retained across restart.
- Durable jobs, source-linked scripted city reports, separate virtual harvests, school attendance and simple deterministic assessments. These are simulation outputs, not independently reviewed research or real-world outcomes.
- Four preapproved fictional households; marriage requires both adults' recorded visits; children require completed native homes. Children stay home, become students after10 open-world minutes, then need assessed school/university visits and work records. No offline ageing, coins, accounts, credentials or inherited authority.
- `/city` guest directory/home requests and native travel with signed arrival confirmation. Families target their own home doorstep. `/tell Selene city` exposes the public city guide.

## Verification so far

- Final application suite:1,831 passing,0 failing.
- End-to-end:20 steps passed.
- Focused real Chrome:8/8 city scenarios. Cottage ACKs there are signed fixtures, not native building evidence.
- Seal:136 definitions,42 referenced notices/assets.
- Native protocol:33 passing; world-core release tests initially23 passing, then a saved-base regression added pending next gate.
- Real native probe1 refused oversized clearing, correctly and before applying city geometry. Probe2 spawned8 actual residents and saved23 public groups and one marriage, but exposed canopy spawning and flat-road ledges. Those are regression findings, not acceptance passes.
- Final real native build/work/family/school/restart gate remains pending. GUI playthrough unavailable while Mac is locked.

## Activation

`node scripts/prepare-native-city.mjs --output-dir NEW_DIRECTORY` creates checked composition artifacts exclusively. Set native world path to its `manifest.json`; merge its landmarks with existing configuration; run Node with `NEMO_CITY_ENABLED=1` and the native `NEMO_WORLD_RECORD`. The canonical local launcher setup prepares this composition. Existing accounts, characters, plot claims and buildings must be backed up before activation. Keep source and native binary rollback copies.

## Known boundaries

This is a local scripted city simulation, not an MMO, an autonomous model civilization, real marriage/parenthood, commercial land ownership or evidence of institutional adoption. Existing private guest cottages remain preset styles. The existing command outbox has a crash window between file append and its core SQLite row; city intents recover recorded commands and never count uncertain work as complete, but do not make those stores atomic. Native record files are operator controlled; shape validation is not a cryptographic signature of the whole world.
