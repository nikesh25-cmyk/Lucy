# Native creative building and terrain — 15 October 2026

Base: `a1e6968e981f51d1828bcb0b7ee2432319c4fbc8`, branch `integration/nemoworld-unified-2026-10-15`.

## Delivered

- Nine free, reusable native tools matching the sealed frontier palette, including the previously absent clay/slate. Canonical inventory reset removes duplicate creative-tool stacks on join and preserves other items.
- `/nemo_build` and right-click-air open a creative menu. Available plots are sorted by walking distance. The paired human explicitly supplies a public purpose; the existing `/land/assign` route decides stewardship. No account/resident override is accepted. Another-sector assignment is refused.
- Three existing blueprints exposed with an explicit preview-before-placement flow. Changing the footprint invalidates the confirmation. Server validation is repeated at placement. Retries reuse saved blocks.
- Actual server terrain now projects trees, shallow water, gate frames and direction/target labels. Decorative nodes cannot be mined, placed as inventory or counted as contributions; authoritative saved blocks take precedence. The HUD shows actual resident/block counts rather than pretending an empty sector is populated.
- Six verified CC0 ambientCG colour maps reused from the downloaded asset pool (7,578,749 bytes). Per-file hashes, publisher provenance and licences are in `native/assets-manifest.json` and `native/THIRD_PARTY.md`.
- Existing scoped AI runtimes can use the same saved construction; their accepted blocks appear on the native refresh. No AI was moved, granted a token or credited with construction by this change.

## Verification

- Creative integration test uses a real disposable NemoWorld HTTP service, bridge and database: all nine materials, missing ownership refusal, mod-key refusal, current-sector restriction, stewardship, clay/slate persistence, preview with zero saved blocks, 11-block blueprint application, duplicate retry, unchanged coin count and revoked session refusal.
- Asset test checks all six CC0 records, JPEG signatures, byte counts and SHA-256 values.
- Real Luanti onboarding probe checks inventory normalization and invokes the actual creative menu module with synthetic callbacks: explicit plot purpose, preview-before-apply and changed-footprint refusal. This is a module/callback probe, not GUI mouse automation.
- Real Luanti world smoke checks projected tree geometry, reusable tool registration, saved movement/build/removal, opened gate crossing, stale-cache clearing and restart reconciliation.
- Existing real-engine mission and conversation smokes also pass.
- Final syntax/seal/full-suite counts are recorded below after completion.

## Scope and operational limits

No schema migration, web UI change, reward-policy change, AI inference purchase or public deployment. Creative tools are unlimited reusable items; shared world capacity, one-plot stewardship, grants, distance, height and action budgets remain bounded. No reward coins are awarded by creative placement. Native rendering still covers one opened 48×48 frontier sector at a time; Commons, indoor fixtures and the whole third-party asset pool are not native content yet. The eight AI residents currently in Commons are not fabricated as frontier residents.

A native launcher restart loads the new Lua/media and invalidates in-memory pairing. Reconnect, sign in at `http://127.0.0.1:3999/`, obtain a fresh code and use `/nemo_connect`. Native auth/map cache and the authoritative web database are preserved. Use `/nemo_build`, steward an available plot, walk to it, select a tool and right-click ground. Punch saved blocks to request removal. Other operators need the existing collaboration grant; AI uses its scoped runtime.

## Final results

- `npm run check`: 132 files, 0 failed.
- `node scripts/seal-content.mjs --check`: 136 definitions verified; 3 support files and 42 referenced notices/assets.
- `npm test -- --test-concurrency=3` (Node 24.19.0): **1,468 passed, 0 failed, 0 skipped**, 252.7 seconds.
- All four pinned Luanti 5.17.0 engine probes pass: onboarding/creative UI, saved world, mission and conversation. The final Lua plot-distance ordering was rechecked by the onboarding/creative UI probe after the full Node suite started.
- No real GUI mouse/keyboard playthrough of this upgrade was performed; synthetic real-engine callbacks and authoritative HTTP/database checks are the evidence.
