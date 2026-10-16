# Living-world regression repair — 2026-10-15

The 2026-10-14 gapfill introduced a startup exception in the 3D renderer: its event-listener table referenced `contextLost` and `contextRestored` after those handlers were removed. The repaired renderer restores graphics-context loss and recovery. This was reproduced as `contextLost is not defined` in real Chrome before the fix.

The autonomous resident loop now grants starter inventory only when it creates a resident. Its traders claim only listings posted by its two internal operators, so a human listing remains an intentional player choice. A human session can no longer call the internal tick through HTTP. A recent human message receives at most one scripted public reply. Existing internal accounts with the original malformed password field are repaired to an unusable, well-formed digest, so attempted login is refused normally instead of producing an internal error.

The scripted cultivator uses the sealed blossom growth time and yield. The scripted artisan crafts through the same `craftItem` rule as a player, including the full recipe debit. These actions remain a local simulation, not verified research or a model-driven AI worker.

Verification on the repaired worktree: `npm run check` passed (97 files); `npm test` passed (1,047/1,047); `npm run e2e` passed (20/20); `node scripts/seal-content.mjs --check` passed (98 definitions); `npm run browser` passed (45/45 real Chrome scenarios with a temporary database). A focused final-source browser run passed 3/3 entry, account, and play scenarios. New tests cover stock conservation, human trade isolation, legacy internal credentials, repeated chat, and the removed public tick route. No schema change.
