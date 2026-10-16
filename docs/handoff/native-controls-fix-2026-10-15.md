# Native walking and first-build repair — 15 October 2026

Base: `c0cb2a3`, branch `integration/nemoworld-unified-2026-10-15`.

## Confirmed causes

1. `set_anchor` computed native player origin as `max(2, saved_z + 2)`. Every confirmed step forced that origin, and periodic reconciliation treated gravity settling as drift. With terrain centred at native y=-1 (top=-0.5), this lifted the player into the air repeatedly. The live native log also recorded fall damage.
2. The pending-step clamp reset all three axes to that airborne anchor, and horizontal walking zeroed vertical velocity. A deliberate jump was also cancelled.
3. The live authoritative world contained no land stewardship and no saved blocks. Placement correctly refused unowned land, but first play did not surface this prerequisite. Failed clicks went only to chat; tools in the hotbar implied readiness to build.

## Fixes

- Standing height derives from the authoritative standing layer, terrain surface and the native player's actual collision-box minimum. Heartbeats preserve normal settling and short native jumps. Initial connection, changed support height and genuine position divergence still reconcile.
- A pending cardinal step is bounded horizontally to its single requested tile. Walking no longer snaps back to the old tile centre, changes vertical position, or zeroes vertical velocity while awaiting confirmation. The authoritative API remains the only source of saved movement.
- First connected play without an owned plot opens the creative menu automatically. A default editable `Creative workshop` purpose and **Use this free building plot** button reduce setup friction. Placement failures show the exact backend reason in the menu. Current tile and plot bounds appear in the HUD.
- No automatic land assignment, scope expansion, fabricated blocks, reward changes or schema migration.

## Reproduction and regression evidence

`native/luanti-controls-smoke.mjs` runs the pinned real engine against a disposable NemoWorld server/bridge/database. It invokes the actual join, movement, item-placement, punch and creative-form callbacks with a synthetic player.

- Red on original code: `paired feet must rest on terrain ... actual 2`.
- Separate red before the horizontal velocity fix: `walking confirmation must preserve the native jump velocity`.
- Green: native ground height, stable heartbeat, vertical velocity during walking, visible land refusal, explicit purpose/plot choice, reusable ground-click placement, saved punch removal and unchanged coin count. The final saved human moved one tile; the final block count is zero after removal; exactly the explicitly selected plot exists.
- Existing arrival/menu, build/travel/restart, mission and private-conversation engine probes also run.

These are real engine callbacks and HTTP/database checks, not a completed GUI playthrough. A disposable native GUI attempt was interrupted in the shared Luanti window before connection; no GUI placement or physical WASD pass is claimed. Its temporary server/database were cleaned up. The user's native account/password and live world data were not changed by the tests.

## Installation and use

Install source after verifying it matches the previous installed manifest, preserve the native world/auth cache, then restart only the identified native launcher. Its in-memory pairing expires on restart. Reconnect to the same native port and pair from `http://127.0.0.1:3999/`. The free-plot menu opens automatically; click **Use this free building plot**, select a material, return to the world and right-click nearby clear ground inside the shown plot. Punch a saved owned block to remove it. Existing land/grant/range/cooldown checks remain enforced.

## Final verification

- Existing native player has `interact` and `shout`; missing native interaction privilege is ruled out. No credentials or privileges were changed.
- `npm run check`: 132 files, 0 failed.
- Content seal: 136 definitions verified, 3 support files, 42 referenced notices/assets.
- `npm test -- --test-concurrency=3`: **1,468 passed, 0 failed, 0 skipped**, 304.4 seconds.
- Five real Luanti 5.17.0 probes pass: controls, onboarding/creative menu, saved world/travel/restart, mission and conversation. Final Lua velocity/menu edits were rechecked by the controls and onboarding probes during the Node regression run.
