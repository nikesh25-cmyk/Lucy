# NemoWorld native engine source

`nemoworld-engine.patch` contains **all** native engine changes from the pinned upstream base through the integrated city release, including earlier Harr integration, peaceful gameplay, homes, shop, atlas, graphics and the city actors/recovery fixes. The complete source changes are stored here alongside the Node platform so they can be reviewed and rebuilt together.

The upstream engine and assets retain their existing licences and credits. See `source-lock.json` for exact source/tree/hash pins. This is source, not a downloadable precompiled game. Credentials, local saves, accounts and models are excluded.

## Reproduce

1. Clone `https://gitlab.com/veloren/veloren.git` and check out the exact `base_commit` in `source-lock.json`. Fetch its Git LFS assets using that upstream repository.
2. Verify the patch SHA-256 against the lock file.
3. In that clean checkout, run `git apply --check /absolute/path/nemoworld-engine.patch`, then `git apply --index /absolute/path/nemoworld-engine.patch`.
4. `git write-tree` must equal `expected_tree` in the lock file. This verifies the entire native source tree, not merely the city files.
5. Follow the upstream build prerequisites. Build the server/client and `nemo-bridge`, then use the Node repository's `ops/play-local.sh` and `docs/AI_CITY.md` for the existing local stack layout.

Do not publish your `play/data`, `play/secrets`, userdata or backup archives to GitHub.
